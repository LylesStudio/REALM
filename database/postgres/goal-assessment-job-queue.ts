import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  gateRecordActive,
  gateWorldWrite,
  isWorldWriteGateError,
} from "./world-write-gate.ts";
import { withRecordCommittedNotify } from "./record-events.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import type {
  ClaimedGoalAssessmentJob,
  GoalAssessmentContext,
  GoalAssessmentDecision,
  GoalAssessmentJobRepository,
} from "../../modules/goals/assessment-worker.ts";
import type { GoalEvent, GoalScopeKind, GoalState } from "../../modules/goals/public.ts";
import type { JsonValue } from "../../modules/runtime/public.ts";

export interface GoalAssessmentEnqueueInput {
  jobId: string;
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
  goalInstanceId: string;
  goalKey?: string;
  sourceEventId: string;
  input?: Readonly<Record<string, JsonValue>>;
  availableAt?: string;
}

export interface PostgresGoalAssessmentJobQueueOptions {
  pool: Pool;
  workspaceId: string;
  leaseOwner: string;
  leaseDurationMs?: number;
  retryDelayMs?: number;
}

export interface PostgresGoalAssessmentJobQueue
  extends GoalAssessmentJobRepository {
  enqueue(input: GoalAssessmentEnqueueInput): Promise<"inserted" | "existing">;
}

export class GoalRuntimeRepositoryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "GoalRuntimeRepositoryError";
    this.code = code;
  }
}

interface JobRow extends QueryResultRow {
  id: string;
  workspace_id: string;
  world_id: string;
  world_version: string;
  worldline_id: string;
  record_id: string;
  goal_instance_id: string;
  source_event_id: string;
  state: string;
  attempt_count: string | number;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  goal_key: string;
}

interface GoalInstanceRow extends QueryResultRow {
  id: string;
  record_id: string;
  state: string;
  revision: string | number;
  progress: unknown;
  outcome: unknown;
  scope_kind: string;
  attempt: string | number;
  supersedes_instance_id: string | null;
}

interface SettleInstanceRow extends QueryResultRow {
  id: string;
  state: string;
  revision: string | number;
}

interface HeadRow extends QueryResultRow {
  record_version: string | number;
  next_record_ordinal: string | number;
}

interface EventRow extends QueryResultRow {
  id: string;
  record_id: string;
  record_version: string | number;
  record_ordinal: string | number;
  event_kind: string;
  payload: unknown;
}

interface EventContextRow extends EventRow {
  scene_id: string;
  visibility_policy_id: string;
  calendar_id: string;
  display_time: string;
  world_tick: string | number;
  world_ordinal: string | number;
}

interface WorldlineHeadRow extends QueryResultRow {
  head_tick: string | number;
  head_ordinal: string | number;
}

const JOB_COLUMNS = `
  SELECT job.id, job.workspace_id, job.world_id, job.worldline_id,
         job.record_id, job.goal_instance_id, job.source_event_id,
         job.state, job.attempt_count, job.lease_owner,
         job.lease_expires_at, world.world_version, goal.goal_key
  FROM goal_assessment_jobs AS job
  JOIN worlds AS world
    ON world.workspace_id = job.workspace_id
   AND world.id = job.world_id
  JOIN goal_instances AS goal
    ON goal.workspace_id = job.workspace_id
   AND goal.world_id = job.world_id
   AND goal.worldline_id = job.worldline_id
   AND goal.record_id = job.record_id
   AND goal.id = job.goal_instance_id`;

export function createPostgresGoalAssessmentJobQueue(
  options: PostgresGoalAssessmentJobQueueOptions,
): PostgresGoalAssessmentJobQueue {
  const workspaceId = options.workspaceId.trim();
  const leaseOwner = options.leaseOwner.trim();
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  if (!workspaceId) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_WORKSPACE_INVALID",
      "Goal repositories require a Workspace identifier.",
    );
  }
  if (!leaseOwner) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_LEASE_OWNER_INVALID",
      "Goal workers require a lease owner.",
    );
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_LEASE_DURATION_INVALID",
      "Goal lease duration must be a positive integer.",
    );
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs <= 0) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_RETRY_DELAY_INVALID",
      "Goal retry delay must be a positive integer.",
    );
  }

  return {
    async enqueue(input) {
      assertScope(input, workspaceId);
      const jobId = requireId(input.jobId, "GOAL_JOB_ID_INVALID");
      const availableAt = input.availableAt ?? new Date().toISOString();
      parseTime(availableAt, "GOAL_AVAILABLE_TIME_INVALID");
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO goal_assessment_jobs (
             workspace_id, world_id, worldline_id, record_id,
             id, goal_instance_id, source_event_id, input, available_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz)
           ON CONFLICT (workspace_id, goal_instance_id, source_event_id) DO NOTHING
           RETURNING id`,
          [
            workspaceId,
            input.worldId,
            input.worldlineId,
            input.recordId,
            jobId,
            input.goalInstanceId,
            input.sourceEventId,
            json(input.input ?? {}),
            availableAt,
          ],
        );
        return inserted.rowCount === 1 ? "inserted" : "existing";
      });
    },

    async claimNext(input) {
      const nowEpoch = parseTime(input.now, "GOAL_NOW_INVALID");
      const leaseExpiresAt = new Date(nowEpoch + leaseDurationMs).toISOString();
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query<JobRow>(
          `WITH candidate AS (
             SELECT workspace_id, id
             FROM goal_assessment_jobs
             WHERE workspace_id = $1
               AND (
                 (state IN ('pending', 'retryable')
                   AND available_at <= $2::timestamptz)
                 OR
                 (state = 'running'
                   AND lease_expires_at IS NOT NULL
                   AND lease_expires_at <= $2::timestamptz)
               )
             ORDER BY available_at, created_at, id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE goal_assessment_jobs AS job
           SET state = 'running',
               attempt_count = job.attempt_count + 1,
               lease_owner = $3,
               lease_expires_at = $4::timestamptz,
               updated_at = $2::timestamptz,
               last_error_code = NULL,
               last_error_message = NULL,
               last_error_at = NULL
           FROM candidate
           WHERE job.workspace_id = candidate.workspace_id
             AND job.id = candidate.id
           RETURNING job.id, job.workspace_id, job.world_id, job.worldline_id,
                     job.record_id, job.goal_instance_id, job.source_event_id,
                     job.state, job.attempt_count, job.lease_owner,
                     job.lease_expires_at`,
          [workspaceId, input.now, leaseOwner, leaseExpiresAt],
        );
        const row = result.rows[0];
        if (!row) return null;
        const goal = await client.query<{ goal_key: string }>(
          `SELECT goal_key FROM goal_instances
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = $5`,
          [workspaceId, row.world_id, row.worldline_id, row.record_id, row.goal_instance_id],
        );
        if (goal.rowCount !== 1) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_INSTANCE_NOT_FOUND",
            "The Goal instance for a queued assessment no longer exists.",
          );
        }
        // Phase 4D：definition resolver 以 Record 的精确 binding 为准
        //（records.world_version），不读 worlds 的创建默认版本。
        const world = await client.query<{ world_version: string }>(
          `SELECT record.world_version
           FROM records AS record
           WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, row.record_id],
        );
        if (world.rowCount !== 1) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_WORLD_NOT_FOUND",
            "The World for a queued assessment no longer exists.",
          );
        }
        return mapJob({
          ...row,
          world_version: world.rows[0]!.world_version,
          goal_key: goal.rows[0]!.goal_key,
        });
      });
    },

    async loadContext(job) {
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        await assertLease(client, job, Date.now());
        const instanceResult = await client.query<GoalInstanceRow>(
          `SELECT id, record_id, state, revision, progress, outcome,
                  scope_kind, attempt, supersedes_instance_id
           FROM goal_instances
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = $5`,
          [workspaceId, job.worldId, job.worldlineId, job.recordId, job.goalInstanceId],
        );
        if (instanceResult.rowCount !== 1) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_INSTANCE_NOT_FOUND",
            "The Goal instance no longer exists.",
          );
        }
        const headResult = await client.query<HeadRow>(
          `SELECT record_version, next_record_ordinal
           FROM record_heads
           WHERE workspace_id = $1 AND world_id = $2
             AND worldline_id = $3 AND record_id = $4`,
          [workspaceId, job.worldId, job.worldlineId, job.recordId],
        );
        if (headResult.rowCount !== 1) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_RECORD_HEAD_NOT_FOUND",
            "The Goal Record head no longer exists.",
          );
        }
        const eventsResult = await client.query<EventRow>(
          `SELECT id, record_id, record_version, record_ordinal,
                  event_kind, payload
           FROM events
           WHERE workspace_id = $1 AND world_id = $2
             AND worldline_id = $3 AND record_id = $4
           ORDER BY record_ordinal, id`,
          [workspaceId, job.worldId, job.worldlineId, job.recordId],
        );
        const events = eventsResult.rows.map(toGoalEvent);
        const headRow = headResult.rows[0]!;
        const recordVersion = safeInteger(headRow.record_version, "GOAL_RECORD_VERSION_INVALID");
        const nextOrdinal = safeInteger(headRow.next_record_ordinal, "GOAL_RECORD_ORDINAL_INVALID");
        return {
          instance: {
            goalInstanceId: instanceResult.rows[0]!.id,
            recordId: instanceResult.rows[0]!.record_id,
            state: normalizeGoalState(instanceResult.rows[0]!.state),
            revision: safeInteger(instanceResult.rows[0]!.revision, "GOAL_REVISION_INVALID"),
            progress: jsonObject(instanceResult.rows[0]!.progress, "GOAL_PROGRESS_INVALID"),
            outcome: nullableJsonObject(instanceResult.rows[0]!.outcome, "GOAL_OUTCOME_INVALID"),
            scopeKind: normalizeGoalScopeKind(instanceResult.rows[0]!.scope_kind),
            attempt: Math.max(1, safeInteger(instanceResult.rows[0]!.attempt, "GOAL_ATTEMPT_INVALID")),
            supersedesInstanceId: instanceResult.rows[0]!.supersedes_instance_id,
          },
          events,
          head: { recordVersion, ordinal: Math.max(0, nextOrdinal - 1) },
        } satisfies GoalAssessmentContext;
      });
    },

    async settle(input) {
      const nowEpoch = parseTime(input.now, "GOAL_NOW_INVALID");
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const job = await lockedJob(client, input.job);
        if (!leaseMatches(job, input.job, nowEpoch)) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_STALE_LEASE",
            "The Goal assessment lease is no longer current.",
          );
        }

        if (input.decision.status !== "accepted") {
          await insertAssessment(client, input.job, input.decision);
          await updateJobState(
            client,
            input.job,
            input.decision.status === "stale" ? "retryable" : "completed",
            input.now,
            input.decision.status === "stale" ? "GOAL_ASSESSMENT_STALE" : null,
            input.decision.status === "stale" ? new Date(nowEpoch + retryDelayMs).toISOString() : null,
          );
          return "applied";
        }

        try {
          await gateWorldWrite(client, {
            workspaceId,
            worldId: input.job.worldId,
          });
          await gateRecordActive(client, {
            workspaceId,
            recordId: input.job.recordId,
          });
        } catch (error) {
          if (isWorldWriteGateError(error)) {
            throw new GoalRuntimeRepositoryError(error.code, error.message);
          }
          throw error;
        }

        // Slice 5 统一锁序：worldlines(FOR UPDATE) → record_heads(FOR
        // UPDATE) → 领域聚合 goal_instances(FOR UPDATE)。与分支克隆路径
        // （records→record_heads→goal_instances）由共享 records(FOR
        // UPDATE) gate 串行化，无 AB-BA 窗口。
        const worldlineResult = await client.query<WorldlineHeadRow>(
          `SELECT head_tick, head_ordinal FROM worldlines
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3
           FOR UPDATE`,
          [workspaceId, input.job.worldId, input.job.worldlineId],
        );
        const headResult = await client.query<HeadRow>(
          `SELECT record_version, next_record_ordinal
           FROM record_heads
           WHERE workspace_id = $1 AND world_id = $2
             AND worldline_id = $3 AND record_id = $4
           FOR UPDATE`,
          [workspaceId, input.job.worldId, input.job.worldlineId, input.job.recordId],
        );
        const instanceResult = await client.query<SettleInstanceRow>(
          `SELECT id, state, revision
           FROM goal_instances
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = $5
           FOR UPDATE`,
          [workspaceId, input.job.worldId, input.job.worldlineId, input.job.recordId, input.job.goalInstanceId],
        );
        if (instanceResult.rowCount !== 1 || headResult.rowCount !== 1 || worldlineResult.rowCount !== 1) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_RUNTIME_SCOPE_NOT_FOUND",
            "The Goal runtime scope no longer exists.",
          );
        }
        const instance = instanceResult.rows[0]!;
        const head = headResult.rows[0]!;
        const currentRevision = safeInteger(instance.revision, "GOAL_REVISION_INVALID");
        if (instance.state !== "active") {
          // 终态不可翻转（B1）：同一逻辑 transition 的幂等 replay
          // （同目标终态 + 同 revision）直接收口完成 job；其余迟到/重复
          // 的 complete/fail/settle 结果记录 rejected 证据并稳定拒绝，
          // 绝不 requeue 翻转终态。
          const isReplay = instance.state === input.decision.transition.to
            && currentRevision === input.decision.transition.revision;
          if (isReplay) {
            await insertAssessment(client, input.job, input.decision, { replay: true });
            await updateJobState(client, input.job, "completed", input.now, null, null);
          } else {
            await insertAssessment(client, input.job, {
              status: "rejected",
              source: input.decision.source,
              policyVersion: input.decision.policyVersion,
              observedHead: input.decision.observedHead,
              code: "GOAL_ALREADY_TERMINAL",
              evidence: input.decision.evidence,
              result: { kind: "terminal", code: "GOAL_ALREADY_TERMINAL" },
            });
            await updateJobState(
              client,
              input.job,
              "completed",
              input.now,
              "GOAL_ALREADY_TERMINAL",
              null,
            );
          }
          return "applied";
        }
        const currentVersion = safeInteger(head.record_version, "GOAL_RECORD_VERSION_INVALID");
        const nextOrdinal = safeInteger(head.next_record_ordinal, "GOAL_RECORD_ORDINAL_INVALID");
        const currentHead = {
          recordVersion: currentVersion,
          ordinal: Math.max(0, nextOrdinal - 1),
        };
        if (!sameCursor(currentHead, input.decision.observedHead)) {
          await requeueForConflict(client, input.job, input.now, "GOAL_HEAD_CHANGED", retryDelayMs);
          return "retryable";
        }
        if (input.decision.transition.revision !== currentRevision + 1) {
          await requeueForConflict(client, input.job, input.now, "GOAL_INSTANCE_CHANGED", retryDelayMs);
          return "retryable";
        }
        const previousEvent = await client.query<EventContextRow>(
          `SELECT scene_id, visibility_policy_id, calendar_id, display_time,
                  world_tick, world_ordinal
           FROM events
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4
           ORDER BY record_ordinal DESC, id DESC
           LIMIT 1`,
          [workspaceId, input.job.worldId, input.job.worldlineId, input.job.recordId],
        );
        if (previousEvent.rowCount !== 1) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_PREVIOUS_EVENT_NOT_FOUND",
            "A Goal transition requires an existing Record event context.",
          );
        }
        const previous = previousEvent.rows[0]!;
        const worldline = worldlineResult.rows[0]!;
        const worldTick = safeInteger(worldline.head_tick, "GOAL_WORLD_CURSOR_INVALID");
        const worldOrdinal = safeInteger(worldline.head_ordinal, "GOAL_WORLD_CURSOR_INVALID") + 1;
        const eventId = `goal-transition:${input.job.jobId}:${input.job.attemptCount}`;
        const committedAt = input.now;
        await client.query(
          `INSERT INTO events (
             workspace_id, world_id, worldline_id, record_id, scene_id, id,
             record_version, record_ordinal, batch_index, event_kind,
            actor_participant_id, speaker_name, content, payload,
            visibility_policy_id, world_tick, world_ordinal, calendar_id,
            display_time, causation_command_id, turn_run_id, recorded_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, 0, 'goal.transition.committed',
            NULL, '', $9, $10::jsonb,
            $11, $12, $13, $14, $15, NULL, NULL, $16::timestamptz
          )`,
          [
            workspaceId,
            input.job.worldId,
            input.job.worldlineId,
            input.job.recordId,
            previous.scene_id,
            eventId,
            currentVersion + 1,
            nextOrdinal,
            `Goal ${input.job.goalKey} ${input.decision.transition.to}`,
            json({
              __realmRuntimePayload: {
                goalInstanceId: input.job.goalInstanceId,
                goalKey: input.job.goalKey,
                from: input.decision.transition.from,
                to: input.decision.transition.to,
                revision: input.decision.transition.revision,
                progress: input.decision.transition.progress,
                outcome: input.decision.transition.outcome,
                evidenceEventIds: input.decision.transition.evidenceEventIds,
                evidenceHead: input.decision.transition.evidenceHead,
                evidenceSnapshotHash: input.decision.transition.evidenceSnapshotHash,
                policyVersion: input.decision.transition.policyVersion,
              },
            }),
            previous.visibility_policy_id,
            worldTick,
            worldOrdinal,
            previous.calendar_id,
            previous.display_time,
            committedAt,
          ],
        );
        await client.query(
          `UPDATE record_heads
           SET record_version = $5, next_record_ordinal = $6,
               last_event_id = $7, last_world_tick = $8,
               last_world_ordinal = $9, updated_at = $10::timestamptz
           WHERE workspace_id = $1 AND world_id = $2
             AND worldline_id = $3 AND record_id = $4`,
          [
            workspaceId,
            input.job.worldId,
            input.job.worldlineId,
            input.job.recordId,
            currentVersion + 1,
            nextOrdinal + 1,
            eventId,
            worldTick,
            worldOrdinal,
            committedAt,
          ],
        );
        await client.query(
          `UPDATE worldlines
           SET head_tick = $4, head_ordinal = $5, updated_at = $6::timestamptz
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
          [workspaceId, input.job.worldId, input.job.worldlineId, worldTick, worldOrdinal, committedAt],
        );
        await client.query(
          `UPDATE goal_instances
           SET state = $10, revision = $6, progress = $7::jsonb,
               outcome = $8::jsonb, updated_at = $9::timestamptz,
               completed_at = $9::timestamptz
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = $5`,
          [
            workspaceId,
            input.job.worldId,
            input.job.worldlineId,
            input.job.recordId,
            input.job.goalInstanceId,
            input.decision.transition.revision,
            json(input.decision.transition.progress),
            json(input.decision.transition.outcome),
            committedAt,
            input.decision.transition.to,
          ],
        );
        await insertAssessment(client, input.job, input.decision);
        const completion = withRecordCommittedNotify(
          {
            update: `UPDATE goal_assessment_jobs
                     SET state = 'completed', lease_owner = NULL,
                         lease_expires_at = NULL, completed_at = $5::timestamptz,
                         updated_at = $5::timestamptz,
                         last_error_code = NULL, last_error_message = NULL,
                         last_error_at = NULL`,
            where: `workspace_id = $1 AND id = $2 AND state = 'running'
                    AND attempt_count = $3 AND lease_owner = $4`,
            values: [workspaceId, input.job.jobId, input.job.attemptCount, input.job.leaseOwner, committedAt],
          },
          {
            workspaceId,
            recordId: input.job.recordId,
            nextOrdinal: nextOrdinal + 1,
          },
        );
        await client.query(completion.text, completion.values);
        return "applied";
      });
    },

    async fail(input) {
      const nowEpoch = parseTime(input.now, "GOAL_NOW_INVALID");
      await withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const job = await lockedJob(client, input.job);
        if (!leaseMatches(job, input.job, nowEpoch)) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_STALE_LEASE",
            "The Goal assessment lease is no longer current.",
          );
        }
        const result = await client.query(
          `UPDATE goal_assessment_jobs
           SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
               completed_at = $5::timestamptz, updated_at = $5::timestamptz,
               last_error_code = $3, last_error_message = $3,
               last_error_at = $5::timestamptz
           WHERE workspace_id = $1 AND id = $2 AND state = 'running'
             AND attempt_count = $4 AND lease_owner = $6`,
          [workspaceId, input.job.jobId, input.code.slice(0, 120), input.job.attemptCount, input.now, input.job.leaseOwner],
        );
        if (result.rowCount !== 1) {
          throw new GoalRuntimeRepositoryError(
            "GOAL_STALE_LEASE",
            "The Goal assessment lease is no longer current.",
          );
        }
      });
    },
  };
}

function assertScope(input: GoalAssessmentEnqueueInput, workspaceId: string): void {
  if (input.workspaceId !== workspaceId) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_SCOPE_MISMATCH",
      "Goal job scope does not match the repository workspace.",
    );
  }
}

function mapJob(row: JobRow): ClaimedGoalAssessmentJob {
  return {
    jobId: row.id,
    workspaceId: row.workspace_id,
    worldId: row.world_id,
    worldVersion: row.world_version,
    worldlineId: row.worldline_id,
    recordId: row.record_id,
    goalInstanceId: row.goal_instance_id,
    goalKey: row.goal_key,
    sourceEventId: row.source_event_id,
    attemptCount: safeInteger(row.attempt_count, "GOAL_ATTEMPT_INVALID"),
    leaseOwner: row.lease_owner ?? "",
    leaseExpiresAt: iso(row.lease_expires_at, "GOAL_LEASE_TIME_INVALID"),
  };
}

async function lockedJob(
  client: PoolClient,
  job: ClaimedGoalAssessmentJob,
): Promise<JobRow> {
  const result = await client.query<JobRow>(
    `${JOB_COLUMNS}
     WHERE job.workspace_id = $1 AND job.id = $2
     FOR UPDATE`,
    [job.workspaceId, job.jobId],
  );
  if (result.rowCount !== 1) {
    throw new GoalRuntimeRepositoryError("GOAL_JOB_NOT_FOUND", "Goal assessment job not found.");
  }
  return result.rows[0]!;
}

async function assertLease(
  client: PoolClient,
  job: ClaimedGoalAssessmentJob,
  nowEpoch: number,
): Promise<void> {
  const row = await lockedJob(client, job);
  if (!leaseMatches(row, job, nowEpoch)) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_STALE_LEASE",
      "The Goal assessment lease is no longer current.",
    );
  }
}

function leaseMatches(
  row: JobRow,
  job: ClaimedGoalAssessmentJob,
  nowEpoch: number,
): boolean {
  return row.state === "running"
    && row.attempt_count !== undefined
    && safeInteger(row.attempt_count, "GOAL_ATTEMPT_INVALID") === job.attemptCount
    && row.lease_owner === job.leaseOwner
    && row.lease_expires_at !== null
    && parseTime(iso(row.lease_expires_at, "GOAL_LEASE_TIME_INVALID"), "GOAL_LEASE_TIME_INVALID") > nowEpoch;
}

async function insertAssessment(
  client: PoolClient,
  job: ClaimedGoalAssessmentJob,
  decision: GoalAssessmentDecision,
  options?: { replay?: boolean },
): Promise<void> {
  const evidenceHead = decision.evidence.evidenceHead;
  const assessmentId = `goal-assessment:${job.jobId}:${job.attemptCount}`;
  await client.query(
    `INSERT INTO goal_assessments (
       workspace_id, world_id, worldline_id, record_id, id,
       goal_instance_id, assessment_job_id, source_event_id, source, status,
       result, evidence_event_ids, evidence_head_version, evidence_head_ordinal,
       evidence_snapshot_hash, policy_version
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10,
       $11::jsonb, $12::text[], $13, $14,
       $15, $16
     )${options?.replay ? " ON CONFLICT (workspace_id, id) DO NOTHING" : ""}`,
    [
      job.workspaceId,
      job.worldId,
      job.worldlineId,
      job.recordId,
      assessmentId,
      job.goalInstanceId,
      job.jobId,
      job.sourceEventId,
      decision.source,
      decision.status,
      json(decision.result),
      [...decision.evidence.evidenceEventIds],
      evidenceHead?.recordVersion ?? null,
      evidenceHead?.ordinal ?? null,
      decision.evidence.evidenceSnapshotHash,
      decision.policyVersion,
    ],
  );
}

async function updateJobState(
  client: PoolClient,
  job: ClaimedGoalAssessmentJob,
  state: "retryable" | "completed",
  now: string,
  errorCode: string | null,
  retryAt: string | null,
): Promise<void> {
  const result = await client.query(
    `UPDATE goal_assessment_jobs
     SET state = $3, available_at = COALESCE($4::timestamptz, available_at),
         lease_owner = NULL, lease_expires_at = NULL,
         completed_at = CASE WHEN $3 = 'completed' THEN $5::timestamptz ELSE NULL END,
         updated_at = $5::timestamptz,
         last_error_code = $6::text, last_error_message = $6::text,
         last_error_at = CASE WHEN $6::text IS NULL THEN NULL ELSE $5::timestamptz END
     WHERE workspace_id = $1 AND id = $2 AND state = 'running'
       AND attempt_count = $7 AND lease_owner = $8`,
    [job.workspaceId, job.jobId, state, retryAt, now, errorCode, job.attemptCount, job.leaseOwner],
  );
  if (result.rowCount !== 1) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_STALE_LEASE",
      "The Goal assessment lease is no longer current.",
    );
  }
}

async function requeueForConflict(
  client: PoolClient,
  job: ClaimedGoalAssessmentJob,
  now: string,
  code: string,
  retryDelayMs: number,
): Promise<void> {
  await updateJobState(
    client,
    job,
    "retryable",
    now,
    code,
    new Date(parseTime(now, "GOAL_NOW_INVALID") + retryDelayMs).toISOString(),
  );
}

function toGoalEvent(row: EventRow): GoalEvent {
  return {
    eventId: row.id,
    recordId: row.record_id,
    recordVersion: safeInteger(row.record_version, "GOAL_RECORD_VERSION_INVALID"),
    ordinal: safeInteger(row.record_ordinal, "GOAL_RECORD_ORDINAL_INVALID"),
    kind: row.event_kind,
    payload: runtimePayload(row.payload),
  };
}

function runtimePayload(value: unknown): JsonValue {
  if (!isRecord(value) || !("__realmRuntimePayload" in value)) {
    return value as JsonValue;
  }
  return value.__realmRuntimePayload as JsonValue;
}

function normalizeGoalState(value: string): GoalState {
  if (["active", "completed", "failed", "settled"].includes(value)) {
    return value as GoalState;
  }
  throw new GoalRuntimeRepositoryError("GOAL_STATE_INVALID", "Persisted Goal state is invalid.");
}

function normalizeGoalScopeKind(value: string): GoalScopeKind {
  if (["record", "story", "worldline"].includes(value)) {
    return value as GoalScopeKind;
  }
  throw new GoalRuntimeRepositoryError("GOAL_SCOPE_KIND_INVALID", "Persisted Goal scope kind is invalid.");
}

function jsonObject(value: unknown, code: string): Readonly<Record<string, JsonValue>> {
  if (!isRecord(value)) throw new GoalRuntimeRepositoryError(code, "Persisted Goal JSON is invalid.");
  return value as Readonly<Record<string, JsonValue>>;
}

function nullableJsonObject(
  value: unknown,
  code: string,
): Readonly<Record<string, JsonValue>> | null {
  if (value === null) return null;
  return jsonObject(value, code);
}

function requireId(value: string, code: string): string {
  if (!value.trim()) throw new GoalRuntimeRepositoryError(code, "Goal identifier is required.");
  return value;
}

function safeInteger(value: string | number, code: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new GoalRuntimeRepositoryError(code, "Persisted Goal integer is invalid.");
  }
  return number;
}

function parseTime(value: string, code: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new GoalRuntimeRepositoryError(code, "Goal timestamp is invalid.");
  }
  return time;
}


function iso(value: Date | string | null, code: string): string {
  if (value === null) throw new GoalRuntimeRepositoryError(code, "Goal lease timestamp is missing.");
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new GoalRuntimeRepositoryError(code, "Goal timestamp is invalid.");
  }
  return date.toISOString();
}

function sameCursor(
  left: { recordVersion: number; ordinal: number },
  right: { recordVersion: number; ordinal: number },
): boolean {
  return left.recordVersion === right.recordVersion && left.ordinal === right.ordinal;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
