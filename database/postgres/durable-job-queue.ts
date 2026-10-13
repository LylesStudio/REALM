import type { Pool, QueryResultRow } from "pg";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import {
  isDurableJobKind,
  type ClaimedDurableJob,
  type DurableJobEnqueueInput,
  type DurableJobEnqueueResult,
  type DurableJobQueue,
  type DurableJobSettleResult,
} from "../../modules/application/unified-durable-job-host.ts";

/**
 * Slice 3：统一 durable job 队列的 PostgreSQL 实现（realm_durable_jobs，
 * 迁移 0058）。语义与 goal_assessment_jobs 队列同源：
 *
 * - enqueue：确定性 id + ON CONFLICT DO NOTHING 去重；requeueTerminal 时
 *   terminal 行可被重置回 pending（懒重试/链式修复），active 行不重叠；
 * - claimNext：pending 到期行 + 租约过期的 claimed 行（stale recovery）
 *   FOR UPDATE SKIP LOCKED 认领，attempt_count+1 并写 lease fencing；
 * - complete/fail：WHERE state='claimed' AND attempt_count AND lease_owner
 *   fencing——幂等重放返回 "settled"，租约易手返回 "stale"，绝不抛错扩散。
 *
 * payload 有界性由迁移 0058 的 CHECK（object 且 ≤4KiB）兜底；此处先做
 * 应用层 fail-closed 校验，避免把约束违反当业务失败。
 */

const JOB_ID_LIMIT = 200;
const RECORD_ID_LIMIT = 200;
const PAYLOAD_OCTET_LIMIT = 4096;

export class DurableJobQueueError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DurableJobQueueError";
    this.code = code;
  }
}

export interface PostgresDurableJobQueueOptions {
  pool: Pool;
  workspaceId: string;
  leaseOwner: string;
  leaseDurationMs?: number;
}

interface JobRow extends QueryResultRow {
  id: string;
  job_kind: string;
  record_id: string;
  payload: unknown;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseTime(value: string, code: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new DurableJobQueueError(code, "Durable job timestamp is invalid.");
  }
  return time;
}

function iso(value: Date | string, code: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new DurableJobQueueError(code, "Durable job lease timestamp is invalid.");
  }
  return date.toISOString();
}

function mapJob(row: JobRow, workspaceId: string): ClaimedDurableJob {
  if (!isDurableJobKind(row.job_kind)) {
    throw new DurableJobQueueError(
      "DURABLE_JOB_KIND_INVALID",
      "Persisted durable job kind is invalid.",
    );
  }
  if (row.lease_owner === null || row.lease_expires_at === null) {
    throw new DurableJobQueueError(
      "DURABLE_JOB_LEASE_INVALID",
      "A claimed durable job must carry its lease fence.",
    );
  }
  return {
    jobId: row.id,
    workspaceId,
    kind: row.job_kind,
    recordId: row.record_id,
    payload: row.payload,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: iso(row.lease_expires_at, "DURABLE_JOB_LEASE_INVALID"),
  };
}

export function createPostgresDurableJobQueue(
  options: PostgresDurableJobQueueOptions,
): DurableJobQueue {
  const workspaceId = options.workspaceId.trim();
  const leaseOwner = options.leaseOwner.trim();
  const leaseDurationMs = options.leaseDurationMs ?? 300_000;
  if (!workspaceId) {
    throw new DurableJobQueueError(
      "DURABLE_JOB_WORKSPACE_INVALID",
      "Durable job queues require a Workspace identifier.",
    );
  }
  if (!leaseOwner) {
    throw new DurableJobQueueError(
      "DURABLE_JOB_LEASE_OWNER_INVALID",
      "Durable job workers require a lease owner.",
    );
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new DurableJobQueueError(
      "DURABLE_JOB_LEASE_DURATION_INVALID",
      "Durable job lease duration must be a positive integer.",
    );
  }

  function validateEnqueue(input: DurableJobEnqueueInput): string {
    if (!isDurableJobKind(input.kind)) {
      throw new DurableJobQueueError(
        "DURABLE_JOB_KIND_INVALID",
        "Durable job kind is invalid.",
      );
    }
    const jobId = input.jobId.trim();
    if (!jobId || jobId.length > JOB_ID_LIMIT) {
      throw new DurableJobQueueError(
        "DURABLE_JOB_ID_INVALID",
        "Durable job id is invalid.",
      );
    }
    const recordId = input.recordId.trim();
    if (!recordId || recordId.length > RECORD_ID_LIMIT) {
      throw new DurableJobQueueError(
        "DURABLE_JOB_RECORD_INVALID",
        "Durable job record scope is invalid.",
      );
    }
    if (!isRecord(input.payload)) {
      throw new DurableJobQueueError(
        "DURABLE_JOB_PAYLOAD_INVALID",
        "Durable job payload must be a JSON object.",
      );
    }
    const serialized = JSON.stringify(input.payload);
    if (Buffer.byteLength(serialized, "utf8") > PAYLOAD_OCTET_LIMIT) {
      throw new DurableJobQueueError(
        "DURABLE_JOB_PAYLOAD_INVALID",
        "Durable job payload exceeds the bounded size.",
      );
    }
    const availableAt = input.availableAt ?? new Date().toISOString();
    parseTime(availableAt, "DURABLE_JOB_TIME_INVALID");
    return availableAt;
  }

  return {
    async enqueue(input): Promise<DurableJobEnqueueResult> {
      const availableAt = validateEnqueue(input);
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO realm_durable_jobs (
             workspace_id, id, job_kind, record_id, payload, available_at
           ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)
           ON CONFLICT (workspace_id, id) DO NOTHING
           RETURNING id`,
          [
            workspaceId,
            input.jobId.trim(),
            input.kind,
            input.recordId.trim(),
            JSON.stringify(input.payload),
            availableAt,
          ],
        );
        if (inserted.rowCount === 1) return "inserted";
        if (!input.requeueTerminal) return "existing";
        const requeued = await client.query<{ id: string }>(
          `UPDATE realm_durable_jobs
           SET state = 'pending', payload = $4::jsonb,
               available_at = $5::timestamptz,
               lease_owner = NULL, lease_expires_at = NULL,
               last_error_code = NULL, completed_at = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND id = $2 AND job_kind = $3
             AND state IN ('completed', 'failed')
           RETURNING id`,
          [
            workspaceId,
            input.jobId.trim(),
            input.kind,
            JSON.stringify(input.payload),
            availableAt,
          ],
        );
        return requeued.rowCount === 1 ? "requeued" : "existing";
      });
    },

    async claimNext(input): Promise<ClaimedDurableJob | null> {
      const nowEpoch = parseTime(input.now, "DURABLE_JOB_TIME_INVALID");
      const leaseExpiresAt = new Date(nowEpoch + leaseDurationMs).toISOString();
      const kinds = input.kinds.filter(isDurableJobKind);
      if (kinds.length === 0) return null;
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query<JobRow>(
          `WITH candidate AS (
             SELECT workspace_id, id
             FROM realm_durable_jobs
             WHERE workspace_id = $1
               AND job_kind = ANY($2::text[])
               AND (
                 (state = 'pending' AND available_at <= $3::timestamptz)
                 OR
                 (state = 'claimed'
                   AND lease_expires_at IS NOT NULL
                   AND lease_expires_at <= $3::timestamptz)
               )
             ORDER BY available_at, created_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE realm_durable_jobs AS job
           SET state = 'claimed',
               attempt_count = job.attempt_count + 1,
               lease_owner = $4,
               lease_expires_at = $5::timestamptz,
               updated_at = $3::timestamptz,
               last_error_code = NULL
           FROM candidate
           WHERE job.workspace_id = candidate.workspace_id
             AND job.id = candidate.id
           RETURNING job.id, job.job_kind, job.record_id, job.payload,
                     job.attempt_count, job.lease_owner, job.lease_expires_at`,
          [workspaceId, kinds, input.now, leaseOwner, leaseExpiresAt],
        );
        const row = result.rows[0];
        return row ? mapJob(row, workspaceId) : null;
      });
    },

    async complete(job, now): Promise<DurableJobSettleResult> {
      parseTime(now, "DURABLE_JOB_TIME_INVALID");
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query(
          `UPDATE realm_durable_jobs
           SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
               completed_at = $4::timestamptz, updated_at = $4::timestamptz,
               last_error_code = NULL
           WHERE workspace_id = $1 AND id = $2 AND state = 'claimed'
             AND attempt_count = $3 AND lease_owner = $5`,
          [workspaceId, job.jobId, job.attemptCount, now, job.leaseOwner],
        );
        if (result.rowCount === 1) return "applied";
        const current = await client.query<{ state: string }>(
          `SELECT state FROM realm_durable_jobs
           WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, job.jobId],
        );
        return current.rows[0]?.state === "completed" ? "settled" : "stale";
      });
    },

    async fail(job, code, now): Promise<DurableJobSettleResult> {
      parseTime(now, "DURABLE_JOB_TIME_INVALID");
      const boundedCode = code.trim().slice(0, 120) || "unknown";
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query(
          `UPDATE realm_durable_jobs
           SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
               completed_at = $4::timestamptz, updated_at = $4::timestamptz,
               last_error_code = $5
           WHERE workspace_id = $1 AND id = $2 AND state = 'claimed'
             AND attempt_count = $3 AND lease_owner = $6`,
          [workspaceId, job.jobId, job.attemptCount, now, boundedCode, job.leaseOwner],
        );
        if (result.rowCount === 1) return "applied";
        const current = await client.query<{ state: string }>(
          `SELECT state FROM realm_durable_jobs
           WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, job.jobId],
        );
        return current.rows[0]?.state === "failed" ? "settled" : "stale";
      });
    },
  };
}
