import type { Pool } from "pg";
import type {
  ClaimedPropagationJob,
  PropagationJob,
  PropagationJobInput,
  PropagationJobQueue,
  PropagationJobStatus,
} from "../../modules/propagation/worker.ts";
import {
  PropagationStaleLeaseError,
  PropagationWorldArchivedError,
} from "../../modules/propagation/worker.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateWorldWrite, isWorldWriteGateError } from "./world-write-gate.ts";

/**
 * 批次 T11-B：claimNext 只按 workspace 入参、领取即返回 job 真实
 * world/worldline 作用域（修正 workspace-only 串世界缺陷）；可领取条件含
 * attempts 指数退避（finished_at + LEAST(2^attempts, 60)s，上限 60s，
 * attempts 持久化故重试间隔稳定）。completeRun 单事务幂等。
 *
 * v37 §D.0 lease 贯穿契约（PropagationLease = { jobId, attempts }）：
 * - claimNext 铸新 token（attempts+1，RETURNING lease）；claim 时发现
 *   归档世界 → 同事务 failed('WORLD_ARCHIVED') 并继续领下一个（控制面，
 *   幂等）；
 * - completeRun：两拍模式（无锁读 job 行取 worldId → gateWorldWrite
 *   worlds FOR KEY SHARE active 断言 → jobs FOR UPDATE 双分量断言）→
 *   内容写 → done；stale lease → STALE_LEASE 不写内容；
 * - markFailed：lease 双分量断言，stale → stale_ignored；archived 允许
 *   收尾（幂等）；
 * - recoverStale：仅 started_at 超 5 分钟的 running job；completeRun 持
 *   job 行锁期间行锁串行无穿插；
 * - retry：failed→pending 状态条件 UPDATE（不返 lease；下次 claim 铸新
 *   token，旧 token 全失效）。
 */
export function createPostgresPropagationJobQueue(pool: Pool): PropagationJobQueue {
  return {
    async enqueue(scope, job) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        await client.query(
          `INSERT INTO propagation_jobs (
             workspace_id, world_id, worldline_id, id, campaign_id, input
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            job.id,
            job.campaignId,
            JSON.stringify(job.input),
          ],
        );
      });
    },

    async claimNext(workspaceId) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        for (;;) {
          const result = await client.query(
            `UPDATE propagation_jobs
             SET status = 'running', started_at = CURRENT_TIMESTAMP,
                 attempts = attempts + 1
             WHERE id = (
               SELECT id FROM propagation_jobs
               WHERE workspace_id = $1 AND status = 'pending'
                 AND (
                   finished_at IS NULL
                   OR finished_at
                      + LEAST(POWER(2, attempts), 60) * INTERVAL '1 second'
                      <= CURRENT_TIMESTAMP
                 )
               ORDER BY created_at, id
               LIMIT 1
               FOR UPDATE SKIP LOCKED
             )
             RETURNING *`,
            [workspaceId],
          );
          const row = result.rows[0];
          if (!row) return null;
          // v37：claim 时发现归档（读 job.world_id 后判）→ 同事务置
          // failed('WORLD_ARCHIVED')，继续领下一个（控制面收尾，幂等）。
          const world = await client.query<{ status: string }>(
            `SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, row.world_id as string],
          );
          if (world.rows[0] && world.rows[0].status !== "active") {
            await client.query(
              `UPDATE propagation_jobs
               SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
                   last_error = 'WORLD_ARCHIVED'
               WHERE workspace_id = $1 AND id = $2 AND status = 'running'`,
              [workspaceId, row.id as string],
            );
            continue;
          }
          const claimed: ClaimedPropagationJob = {
            scope: {
              workspaceId,
              worldId: row.world_id as string,
              worldlineId: row.worldline_id as string,
            },
            job: mapJob(row),
            lease: {
              jobId: row.id as string,
              attempts: Number(row.attempts),
            },
          };
          return claimed;
        }
      });
    },

    async completeRun(scope, lease, run) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // 两拍模式（v37 §D.0）：① 无锁只读 job 行取 worldId →
        // ② gateWorldWrite（worlds KEY SHARE + active）→ ③ jobs FOR
        // UPDATE 双分量 CAS 断言。
        const initial = await client.query<{
          world_id: string;
          worldline_id: string;
        }>(
          `SELECT world_id, worldline_id FROM propagation_jobs
           WHERE workspace_id = $1 AND id = $2`,
          [scope.workspaceId, lease.jobId],
        );
        const initialRow = initial.rows[0];
        if (!initialRow) {
          throw new PropagationStaleLeaseError(lease.jobId);
        }
        try {
          await gateWorldWrite(client, {
            workspaceId: scope.workspaceId,
            worldId: initialRow.world_id,
          });
        } catch (error) {
          if (isWorldWriteGateError(error) && error.code === "WORLD_ARCHIVED") {
            throw new PropagationWorldArchivedError(initialRow.world_id);
          }
          if (isWorldWriteGateError(error) && error.code === "WORLD_NOT_FOUND") {
            throw new PropagationWorldArchivedError(initialRow.world_id);
          }
          throw error;
        }
        const locked = await client.query<{
          status: string;
          attempts: string;
          world_id: string;
          worldline_id: string;
        }>(
          `SELECT status, attempts, world_id, worldline_id
           FROM propagation_jobs
           WHERE workspace_id = $1 AND id = $2
           FOR UPDATE`,
          [scope.workspaceId, lease.jobId],
        );
        const jobRow = locked.rows[0];
        if (
          !jobRow
          || jobRow.status !== "running"
          || Number(jobRow.attempts) !== lease.attempts
        ) {
          throw new PropagationStaleLeaseError(lease.jobId);
        }
        const jobScope = {
          workspaceId: scope.workspaceId,
          worldId: jobRow.world_id,
          worldlineId: jobRow.worldline_id,
        };
        // 幂等写入（重放安全）：Campaign/Packet/Exposure 全部冲突即无操作。
        await client.query(
          `INSERT INTO information_campaigns (
             workspace_id, world_id, worldline_id, id, root_claim_ids,
             effective_tick, salience, complexity, security_class,
             algorithm_version
           ) VALUES ($1, $2, $3, $4, ARRAY[]::text[], $5, $6, $7, $8, $9)
           ON CONFLICT (workspace_id, id) DO NOTHING`,
          [
            jobScope.workspaceId,
            jobScope.worldId,
            jobScope.worldlineId,
            run.campaign.id,
            run.campaign.effectiveTick,
            run.campaign.salience,
            run.campaign.complexity,
            run.campaign.securityClass,
            run.algorithmVersion,
          ],
        );
        for (const packet of run.packets) {
          await client.query(
            `INSERT INTO information_packets (
               workspace_id, world_id, worldline_id, id, campaign_id,
               parent_packet_id, channel, claim_ids, framing,
               omitted_claim_ids, semantic_fidelity_to_parent, content_hash
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10::text[], $11, $12)
             ON CONFLICT (workspace_id, id) DO NOTHING`,
            [
              jobScope.workspaceId,
              jobScope.worldId,
              jobScope.worldlineId,
              packet.id,
              packet.campaignId,
              packet.parentPacketId,
              packet.channel,
              [...packet.claimIds],
              packet.framing,
              [...packet.omittedClaimIds],
              packet.semanticFidelityToParent,
              packet.contentHash,
            ],
          );
        }
        for (const exposure of run.exposures) {
          await client.query(
            `INSERT INTO propagation_exposures (
               workspace_id, world_id, worldline_id, id, campaign_id,
               packet_id, node_key, channel, arrival_tick, fidelity,
               algorithm_version
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (workspace_id, campaign_id, node_key, packet_id) DO NOTHING`,
            [
              jobScope.workspaceId,
              jobScope.worldId,
              jobScope.worldlineId,
              // 批次 T11-B：Exposure id 含 Campaign 命名空间——不同 Campaign
              // 同节点同 packet 形态不再撞主键（workspace 级 PK）。
              `exposure_${run.campaign.id}_${exposure.nodeKey}_${exposure.packetId}`,
              run.campaign.id,
              exposure.packetId,
              exposure.nodeKey,
              exposure.channel,
              exposure.arrivalTick,
              exposure.fidelity,
              run.algorithmVersion,
            ],
          );
        }
        await client.query(
          `UPDATE propagation_jobs
           SET status = 'done', finished_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND id = $2 AND status = 'running'`,
          [scope.workspaceId, lease.jobId],
        );
      });
    },

    async markFailed(scope, lease, error) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37：lease 双分量断言——stale worker 的 markFailed 命中 0 行 →
        // stale_ignored（新 attempt 不受影响）；archived 允许收尾（幂等）。
        const result = await client.query(
          `UPDATE propagation_jobs
           SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
               last_error = $3
           WHERE workspace_id = $1 AND id = $2 AND status = 'running'
             AND attempts = $4`,
          [scope.workspaceId, lease.jobId, error.slice(0, 500), lease.attempts],
        );
        return { staleIgnored: (result.rowCount ?? 0) === 0 };
      });
    },

    async recoverStale(workspaceId) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        // v37 §D.0：仅 started_at 超 5 分钟的 running job 视为遗留
        //（completeRun 持 job 行锁期间行锁串行，无 running→pending 穿插）。
        const result = await client.query(
          `UPDATE propagation_jobs
           SET status = 'pending', started_at = NULL
           WHERE workspace_id = $1 AND status = 'running'
             AND started_at < CURRENT_TIMESTAMP - interval '5 minutes'`,
          [workspaceId],
        );
        return result.rowCount ?? 0;
      });
    },

    async retry(scope, jobId) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        await client.query(
          `UPDATE propagation_jobs
           SET status = 'pending', started_at = NULL, finished_at = NULL,
               last_error = NULL
           WHERE workspace_id = $1 AND id = $2 AND status = 'failed'`,
          [scope.workspaceId, jobId],
        );
      });
    },

    async stats(workspaceId) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        const result = await client.query(
          `SELECT status, count(*)::int AS count
           FROM propagation_jobs
           WHERE workspace_id = $1
           GROUP BY status`,
          [workspaceId],
        );
        const counts: Record<PropagationJobStatus, number> = {
          pending: 0,
          running: 0,
          done: 0,
          failed: 0,
        };
        for (const row of result.rows) {
          counts[row.status as PropagationJobStatus] = row.count;
        }
        return counts;
      });
    },
  };
}

function mapJob(row: Record<string, unknown>): PropagationJob {
  return {
    id: row.id as string,
    campaignId: row.campaign_id as string,
    input: row.input as PropagationJobInput,
    status: row.status as PropagationJobStatus,
    attempts: Number(row.attempts),
    lastError: (row.last_error as string | null) ?? null,
  };
}
