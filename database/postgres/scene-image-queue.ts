/**
 * 场景图自动请求队列（server-only repository，migration 0050）。
 * 语义（docs/development/IMAGE-GENERATION-AUTO-MODE.md §2/§3）：
 * - enqueue 幂等：(workspace_id, trigger_kind, source_event_id) 唯一，
 *   重复/回放/重试返回既有行（enqueued=false），不重复排队；
 * - 入队前门禁：world/record 必须非归档（archived 拒绝）；
 * - claim：queued → leased（lease 由服务端时钟计算）；同一 Record 的请求
 *   按 created_at 串行消费（per-record 聚簇，active 生成不吞意图）；
 * - complete/fail：leased → completed（绑 generation）/ failed（安全码）；
 * - 临时失败 retry：failed→queued 由 worker 按 attempts 决定（retry() 递增）；
 * - stale 恢复：lease 过期的 leased 行回 queued。
 * realm_runtime 无 DELETE。
 */
import { randomBytes } from "node:crypto";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export type SceneImageRequestTrigger = "scene_change" | "every_turn";
export type SceneImageRequestStatus = "queued" | "leased" | "completed" | "failed";

export interface SceneImageRequest {
  id: string;
  worldId: string;
  recordId: string;
  sceneId: string;
  principalId: string;
  triggerKind: SceneImageRequestTrigger;
  sourceEventId: string;
  status: SceneImageRequestStatus;
  generationId: string | null;
  attempts: number;
}

export class SceneImageQueueError extends Error {
  readonly code: "ARCHIVED_SCOPE";

  constructor(code: "ARCHIVED_SCOPE", message: string) {
    super(message);
    this.name = "SceneImageQueueError";
    this.code = code;
  }
}

export function createPostgresSceneImageQueue(database: WorkspaceDatabase) {
  return {
    /** 幂等入队：同来源返回既有行（enqueued=false）。归档世界/记录拒绝。 */
    async enqueue(input: {
      workspaceId: string;
      worldId: string;
      recordId: string;
      sceneId: string;
      principalId: string;
      triggerKind: SceneImageRequestTrigger;
      sourceEventId: string;
    }): Promise<{ request: SceneImageRequest; enqueued: boolean }> {
      return withWorkspaceTransaction(
        database,
        input.workspaceId,
        async (client) => {
          // 归档门禁：世界/记录任一归档拒绝入队（不处理死数据）。
          const gate = await client.query(
            `SELECT world.status AS world_status, record.status AS record_status
             FROM worlds AS world, records AS record
             WHERE world.workspace_id = $1 AND world.id = $2
               AND record.workspace_id = $1 AND record.id = $3`,
            [input.workspaceId, input.worldId, input.recordId],
          );
          const row = gate.rows[0];
          if (
            !row
            || row.world_status === "archived"
            || row.record_status === "archived"
          ) {
            throw new SceneImageQueueError(
              "ARCHIVED_SCOPE",
              "Scene image requests require an active world and record.",
            );
          }
          const id = `sceneimgreq_${randomBytes(12).toString("hex")}`;
          const inserted = await client.query(
            `INSERT INTO scene_image_requests
               (workspace_id, id, world_id, record_id, scene_id, principal_id,
                trigger_kind, source_event_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (workspace_id, trigger_kind, source_event_id) DO NOTHING
             RETURNING id, world_id, record_id, scene_id, principal_id,
                       trigger_kind, source_event_id, status, generation_id, attempts`,
            [
              input.workspaceId, id, input.worldId, input.recordId, input.sceneId,
              input.principalId, input.triggerKind, input.sourceEventId,
            ],
          );
          if (inserted.rows[0]) {
            return { request: toRequest(inserted.rows[0]), enqueued: true };
          }
          const existing = await client.query(
            `SELECT id, world_id, record_id, scene_id, principal_id,
                    trigger_kind, source_event_id, status, generation_id, attempts
             FROM scene_image_requests
             WHERE workspace_id = $1 AND trigger_kind = $2 AND source_event_id = $3`,
            [input.workspaceId, input.triggerKind, input.sourceEventId],
          );
          return { request: toRequest(existing.rows[0]), enqueued: false };
        },
      );
    },

    /**
     * 领取下一条 queued（lease；服务端时钟）。同一 Record 串行：若该 Record
     * 有更早的 queued/leased 行则跳过本行（聚簇顺序保证）。
     */
    async claim(
      scope: { workspaceId: string },
      options: { leaseMs: number },
    ): Promise<SceneImageRequest | null> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const candidate = await client.query(
            `SELECT id, world_id, record_id, scene_id, principal_id,
                    trigger_kind, source_event_id, status, generation_id, attempts
             FROM scene_image_requests AS request
             WHERE workspace_id = $1 AND status = 'queued'
               AND NOT EXISTS (
                 SELECT 1 FROM scene_image_requests AS earlier
                 WHERE earlier.workspace_id = request.workspace_id
                   AND earlier.record_id = request.record_id
                   AND earlier.status IN ('queued', 'leased')
                   AND (earlier.created_at, earlier.id)
                       < (request.created_at, request.id)
               )
             ORDER BY created_at ASC, id ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED`,
            [scope.workspaceId],
          );
          const row = candidate.rows[0];
          if (!row) return null;
          const claimed = await client.query(
            `UPDATE scene_image_requests
             SET status = 'leased',
                 leased_at = CURRENT_TIMESTAMP,
                 lease_expires_at = CURRENT_TIMESTAMP + ($2::text || ' milliseconds')::interval,
                 updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $3 AND status = 'queued'
             RETURNING id`,
            [scope.workspaceId, String(options.leaseMs), row.id],
          );
          if ((claimed.rowCount ?? 0) === 0) return null;
          return toRequest({ ...row, status: "leased" });
        },
      );
    },

    async complete(
      scope: { workspaceId: string; id: string },
      generationId: string,
    ): Promise<void> {
      await withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          await client.query(
            `UPDATE scene_image_requests
             SET status = 'completed', generation_id = $3,
                 leased_at = NULL, lease_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND status = 'leased'`,
            [scope.workspaceId, scope.id, generationId],
          );
        },
      );
    },

    /** 终态失败（永久错误；last_error 只写安全分类码）。 */
    async fail(
      scope: { workspaceId: string; id: string },
      errorCode: string,
    ): Promise<void> {
      await withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          await client.query(
            `UPDATE scene_image_requests
             SET status = 'failed', last_error = $3,
                 leased_at = NULL, lease_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND status = 'leased'`,
            [scope.workspaceId, scope.id, errorCode.slice(0, 64)],
          );
        },
      );
    },

    /** 临时失败重试：leased → queued，attempts+1（退避由 worker 计算）。 */
    async retry(scope: { workspaceId: string; id: string }): Promise<void> {
      await withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          await client.query(
            `UPDATE scene_image_requests
             SET status = 'queued', attempts = attempts + 1,
                 leased_at = NULL, lease_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND status = 'leased'`,
            [scope.workspaceId, scope.id],
          );
        },
      );
    },

    /** stale 恢复：lease 过期的 leased 行回 queued。返回恢复条数。 */
    async recoverStale(scope: { workspaceId: string }): Promise<number> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const result = await client.query(
            `UPDATE scene_image_requests
             SET status = 'queued', leased_at = NULL, lease_expires_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND status = 'leased'
               AND lease_expires_at <= CURRENT_TIMESTAMP`,
            [scope.workspaceId],
          );
          return result.rowCount ?? 0;
        },
      );
    },

    /** envelope 状态：当前 Record 最新一条请求/活跃生成的安全摘要。 */
    async findLatestForRecord(
      scope: { workspaceId: string; recordId: string },
    ): Promise<SceneImageRequest | null> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const result = await client.query(
            `SELECT id, world_id, record_id, scene_id, principal_id,
                    trigger_kind, source_event_id, status, generation_id, attempts
             FROM scene_image_requests
             WHERE workspace_id = $1 AND record_id = $2
             ORDER BY created_at DESC, id DESC
             LIMIT 1`,
            [scope.workspaceId, scope.recordId],
          );
          return result.rows[0] ? toRequest(result.rows[0]) : null;
        },
        { readOnly: true },
      );
    },
  };
}

function toRequest(row: Record<string, unknown>): SceneImageRequest {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    recordId: String(row.record_id),
    sceneId: String(row.scene_id),
    principalId: String(row.principal_id),
    triggerKind: String(row.trigger_kind) as SceneImageRequestTrigger,
    sourceEventId: String(row.source_event_id),
    status: String(row.status) as SceneImageRequestStatus,
    generationId: row.generation_id === null ? null : String(row.generation_id),
    attempts: Number(row.attempts),
  };
}

export type SceneImageQueue = ReturnType<typeof createPostgresSceneImageQueue>;
