import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import test from "node:test";
import {
  createPostgresGoalAssessmentJobQueue,
  type GoalAssessmentEnqueueInput,
  type PostgresGoalAssessmentJobQueue,
} from "../database/postgres/goal-assessment-job-queue.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { runGoalAssessmentWorkerCycle } from "../modules/goals/assessment-worker-runtime.ts";
import type { ClaimedGoalAssessmentJob } from "../modules/goals/assessment-worker.ts";
import { createModelGoalJudge } from "../modules/goals/model-judge.ts";
import {
  goalEvidenceSnapshotHash,
  type GoalDefinition,
  type GoalEvent,
} from "../modules/goals/public.ts";
import {
  ModelProviderError,
  type ModelChatRequest,
  type ModelGateway,
} from "../modules/inference/public.ts";
import type { JsonValue } from "../modules/runtime/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";

function now(): string {
  return new Date().toISOString();
}

function semanticDefinition(goalKey: string): GoalDefinition {
  return {
    goalKey,
    policyVersion: "semantic-v1",
    mode: "semantic",
    visible: true,
    rubric: { kind: "semantic", promptKey: "semantic-e2e" },
    outcome: { result: "definition fallback outcome" },
  };
}

async function insertGoalInstance(
  ownerPool: pg.Pool,
  goalInstanceId: string,
  goalKey: string,
): Promise<void> {
  await ownerPool.query(
    `INSERT INTO goal_instances (
       workspace_id, world_id, worldline_id, record_id, id, goal_key,
       state, revision, progress, outcome, policy_version
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, '{}'::jsonb, NULL, 'semantic-v1')`,
    [
      POSTGRES_DEMO_IDS.workspace,
      POSTGRES_DEMO_IDS.world,
      POSTGRES_DEMO_IDS.worldline,
      POSTGRES_DEMO_IDS.record,
      goalInstanceId,
      goalKey,
    ],
  );
}

function enqueueInput(
  goalInstanceId: string,
  jobId: string,
  sourceEventId: string,
): GoalAssessmentEnqueueInput {
  return {
    jobId,
    workspaceId: POSTGRES_DEMO_IDS.workspace,
    worldId: POSTGRES_DEMO_IDS.world,
    worldlineId: POSTGRES_DEMO_IDS.worldline,
    recordId: POSTGRES_DEMO_IDS.record,
    goalInstanceId,
    goalKey: goalInstanceId,
    sourceEventId,
    input: { trigger: "semantic-e2e" },
    availableAt: now(),
  };
}

interface CommittedEventRow extends pg.QueryResultRow {
  id: string;
  record_id: string;
  record_version: string | number;
  record_ordinal: string | number;
  event_kind: string;
  payload: unknown;
}

/** Independent readback mapping mirroring the repository's committed-event shape. */
function toGoalEvent(row: CommittedEventRow): GoalEvent {
  const payload = row.payload;
  const unwrapped = payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && "__realmRuntimePayload" in payload
    ? (payload as Record<string, unknown>).__realmRuntimePayload as JsonValue
    : payload as JsonValue;
  return {
    eventId: row.id,
    recordId: row.record_id,
    recordVersion: Number(row.record_version),
    ordinal: Number(row.record_ordinal),
    kind: row.event_kind,
    payload: unwrapped,
  };
}

async function readCommittedEvents(ownerPool: pg.Pool): Promise<GoalEvent[]> {
  const result = await ownerPool.query<CommittedEventRow>(
    `SELECT id, record_id, record_version, record_ordinal, event_kind, payload
     FROM events
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4
     ORDER BY record_ordinal, id`,
    [
      POSTGRES_DEMO_IDS.workspace,
      POSTGRES_DEMO_IDS.world,
      POSTGRES_DEMO_IDS.worldline,
      POSTGRES_DEMO_IDS.record,
    ],
  );
  return result.rows.map(toGoalEvent);
}

async function readRecordHead(
  ownerPool: pg.Pool,
): Promise<{ recordVersion: number; ordinal: number }> {
  const result = await ownerPool.query<{
    record_version: string | number;
    next_record_ordinal: string | number;
  } & pg.QueryResultRow>(
    `SELECT record_version, next_record_ordinal
     FROM record_heads
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4`,
    [
      POSTGRES_DEMO_IDS.workspace,
      POSTGRES_DEMO_IDS.world,
      POSTGRES_DEMO_IDS.worldline,
      POSTGRES_DEMO_IDS.record,
    ],
  );
  assert.equal(result.rowCount, 1, "the demo Record head must exist");
  return {
    recordVersion: Number(result.rows[0]!.record_version),
    ordinal: Math.max(0, Number(result.rows[0]!.next_record_ordinal) - 1),
  };
}

function fakeGateway(
  responder: (request: ModelChatRequest, callIndex: number) => Promise<{ content: string }>,
): ModelGateway & { requests: ModelChatRequest[] } {
  const requests: ModelChatRequest[] = [];
  return {
    requests,
    providerId: "lmstudio",
    async discoverModels() {
      return [];
    },
    async chat(request) {
      requests.push(request);
      const response = await responder(request, requests.length - 1);
      return {
        model: "fake-judge-model",
        content: response.content,
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

function messageContents(request: ModelChatRequest): { system: string; user: string } {
  const system = request.messages.find((message) => message.role === "system");
  const user = request.messages.find((message) => message.role === "user");
  assert.ok(system && user, "the Judge request must carry a system policy and a user context");
  return { system: system.content, user: user.content };
}

function assertNoLeakedSecrets(content: string, leaseOwner: string): void {
  assert.ok(!content.includes(leaseOwner), "lease owner must never reach the prompt");
  assert.doesNotMatch(content, /postgres(?:ql)?:\/\//i, "no database URL in the prompt");
  assert.doesNotMatch(content, /\btoken\b/i, "no token material in the prompt");
  assert.doesNotMatch(content, /credential/i, "no credential material in the prompt");
  assert.doesNotMatch(content, /endpoint/i, "no provider endpoint in the prompt");
  assert.doesNotMatch(content, /secret/i, "no secret material in the prompt");
  assert.doesNotMatch(content, /api[_-]?key/i, "no API key material in the prompt");
  for (const url of [adminConnectionString, runtimeConnectionString]) {
    if (url) assert.ok(!content.includes(url), "connection strings must never reach the prompt");
  }
}

async function cleanup(ownerPool: pg.Pool, goalInstanceIds: readonly string[]): Promise<void> {
  for (const goalInstanceId of goalInstanceIds) {
    await ownerPool.query(
      `DELETE FROM goal_instances WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
  }
}

test(
  "semantic Goal e2e: durable claim → ModelGateway Judge adapter → settle writes exactly one verified transition",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalInstanceId = `goal_sem_${suffix}`;
    const jobId = `goal_job_sem_${suffix}`;
    const leaseOwner = `test-semantic-worker-${suffix}`;
    const definition = semanticDefinition(goalInstanceId);
    t.after(async () => {
      await cleanup(ownerPool, [goalInstanceId]);
      await runtimePool.end();
      await ownerPool.end();
    });

    await insertGoalInstance(ownerPool, goalInstanceId, definition.goalKey);

    // Real committed events/head from the disposable cluster — never assumed
    // constants, because sibling suites legitimately advance this record.
    const committedEvents = await readCommittedEvents(ownerPool);
    assert.ok(committedEvents.length > 0, "the demo Record must have committed events");
    const head = await readRecordHead(ownerPool);
    const evidenceEvent = committedEvents[0]!;
    const sourceEventId = committedEvents[committedEvents.length - 1]!.eventId;

    const queue: PostgresGoalAssessmentJobQueue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      leaseOwner,
      leaseDurationMs: 30_000,
    });
    assert.equal(
      await queue.enqueue(enqueueInput(goalInstanceId, jobId, sourceEventId)),
      "inserted",
    );

    const modelOutput = {
      decision: "complete",
      evidenceEventIds: [evidenceEvent.eventId],
      progress: { verdict: "satisfied" },
      outcome: { result: "semantic resolution" },
    };
    const gateway = fakeGateway(async () => ({ content: JSON.stringify(modelOutput) }));
    // The production ModelGateway adapter is the only Judge in this test —
    // the fake gateway is purely the provider transport.
    const judge = createModelGoalJudge({ getGateway: async () => gateway });

    let claimedJob: ClaimedGoalAssessmentJob | null = null;
    const reports = await runGoalAssessmentWorkerCycle({
      slots: [{ workspaceId: POSTGRES_DEMO_IDS.workspace, repository: queue }],
      resolveDefinition: async (job) => {
        claimedJob = job;
        return definition;
      },
      judge,
      now: now(),
    });
    assert.deepEqual(reports.get(POSTGRES_DEMO_IDS.workspace), {
      kind: "settled",
      status: "accepted",
    });
    assert.ok(claimedJob, "the worker cycle must claim the durable job");
    const job: ClaimedGoalAssessmentJob = claimedJob;
    assert.equal(job.jobId, jobId);
    assert.equal(job.sourceEventId, sourceEventId);
    assert.equal(job.attemptCount, 1);
    assert.equal(job.leaseOwner, leaseOwner);
    assert.equal(job.goalKey, definition.goalKey);

    // The Judge went through the real ModelGateway adapter exactly once.
    assert.equal(gateway.requests.length, 1);
    const request = gateway.requests[0]!;
    assert.equal(request.responseFormat, "json_object");
    assert.equal(request.temperature, 0);
    assert.ok(request.maxTokens !== undefined && request.maxTokens > 0);
    assert.ok(request.timeoutMs !== undefined && request.timeoutMs > 0);

    // Scope safety: the structured request carries the claimed job's trusted
    // identity (workspace stays internal; world/worldVersion/worldline/record/
    // goal/sourceEvent are visible), and never worker or provider internals.
    const { system, user } = messageContents(request);
    assert.match(user, /Assessment job scope/);
    for (const value of [
      job.worldId,
      job.worldVersion,
      job.worldlineId,
      job.recordId,
      job.goalInstanceId,
      job.sourceEventId,
    ]) {
      assert.ok(user.includes(value), `prompt must include job scope value ${value}`);
    }
    assert.ok(!user.includes(job.workspaceId), "workspace id stays internal to the worker");
    assert.ok(!user.includes(job.leaseExpiresAt), "lease expiry must never reach the prompt");
    assertNoLeakedSecrets(system, leaseOwner);
    assertNoLeakedSecrets(user, leaseOwner);

    // Independent readback proof of the settled Goal instance.
    const instance = await ownerPool.query<{
      state: string;
      revision: string | number;
      progress: Record<string, JsonValue>;
      outcome: Record<string, JsonValue> | null;
      completed_at: string | null;
    } & pg.QueryResultRow>(
      `SELECT state, revision, progress, outcome, completed_at
       FROM goal_instances WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(instance.rows[0]?.state, "completed");
    assert.equal(Number(instance.rows[0]?.revision), 1);
    assert.deepEqual(instance.rows[0]?.progress, { verdict: "satisfied" });
    assert.deepEqual(instance.rows[0]?.outcome, { result: "semantic resolution" });
    assert.ok(instance.rows[0]?.completed_at !== null);

    // The durable job row is settled: lease cleared, no error residue.
    const jobRow = await ownerPool.query<{
      state: string;
      attempt_count: string | number;
      lease_owner: string | null;
      lease_expires_at: string | null;
      last_error_code: string | null;
      last_error_message: string | null;
      completed_at: string | null;
    } & pg.QueryResultRow>(
      `SELECT state, attempt_count, lease_owner, lease_expires_at,
              last_error_code, last_error_message, completed_at
       FROM goal_assessment_jobs WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, jobId],
    );
    assert.equal(jobRow.rows[0]?.state, "completed");
    assert.equal(Number(jobRow.rows[0]?.attempt_count), 1);
    assert.equal(jobRow.rows[0]?.lease_owner, null);
    assert.equal(jobRow.rows[0]?.lease_expires_at, null);
    assert.equal(jobRow.rows[0]?.last_error_code, null);
    assert.equal(jobRow.rows[0]?.last_error_message, null);
    assert.ok(jobRow.rows[0]?.completed_at !== null);

    // Exactly one verified goal.transition.committed event, appended after the
    // previously committed head.
    const transitionEventId = `goal-transition:${jobId}:1`;
    const transition = await ownerPool.query<{
      event_kind: string;
      record_version: string | number;
      record_ordinal: string | number;
      payload: { __realmRuntimePayload?: Record<string, JsonValue> };
    } & pg.QueryResultRow>(
      `SELECT event_kind, record_version, record_ordinal, payload
       FROM events WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, transitionEventId],
    );
    assert.equal(transition.rowCount, 1);
    assert.equal(transition.rows[0]!.event_kind, "goal.transition.committed");
    assert.equal(Number(transition.rows[0]!.record_version), head.recordVersion + 1);
    assert.equal(Number(transition.rows[0]!.record_ordinal), head.ordinal + 1);
    const transitionPayload = transition.rows[0]!.payload.__realmRuntimePayload;
    assert.ok(transitionPayload, "transition payload must use the runtime envelope");
    assert.equal(transitionPayload.goalInstanceId, goalInstanceId);
    assert.equal(transitionPayload.goalKey, definition.goalKey);
    assert.equal(transitionPayload.from, "active");
    assert.equal(transitionPayload.to, "completed");
    assert.equal(Number(transitionPayload.revision), 1);
    assert.deepEqual(transitionPayload.progress, { verdict: "satisfied" });
    assert.deepEqual(transitionPayload.outcome, { result: "semantic resolution" });
    assert.deepEqual(transitionPayload.evidenceEventIds, [evidenceEvent.eventId]);
    assert.deepEqual(transitionPayload.evidenceHead, head);
    assert.equal(transitionPayload.policyVersion, definition.policyVersion);

    // The assessment ledger row is immutable judge evidence chained to the
    // real committed source event and the observed head.
    const expectedHash = goalEvidenceSnapshotHash({
      definition,
      instance: {
        goalInstanceId,
        recordId: POSTGRES_DEMO_IDS.record,
        state: "active",
        revision: 0,
        progress: {},
        outcome: null,
      },
      events: [evidenceEvent],
      evidenceHead: head,
    });
    assert.equal(transitionPayload.evidenceSnapshotHash, expectedHash);
    const assessment = await ownerPool.query<{
      id: string;
      assessment_job_id: string | null;
      source_event_id: string;
      source: string;
      status: string;
      result: Record<string, JsonValue>;
      evidence_event_ids: string[];
      evidence_head_version: string | number | null;
      evidence_head_ordinal: string | number | null;
      evidence_snapshot_hash: string;
      policy_version: string;
    } & pg.QueryResultRow>(
      `SELECT id, assessment_job_id, source_event_id, source, status, result,
              evidence_event_ids, evidence_head_version, evidence_head_ordinal,
              evidence_snapshot_hash, policy_version
       FROM goal_assessments WHERE workspace_id = $1 AND goal_instance_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(assessment.rowCount, 1);
    const assessmentRow = assessment.rows[0]!;
    assert.equal(assessmentRow.id, `goal-assessment:${jobId}:1`);
    assert.equal(assessmentRow.assessment_job_id, jobId);
    assert.equal(assessmentRow.source, "judge");
    assert.equal(assessmentRow.status, "accepted");
    assert.deepEqual(assessmentRow.result, { kind: "accepted", decision: "complete" });
    // sourceEventId chains to the real committed event, not a fabricated id.
    assert.equal(assessmentRow.source_event_id, sourceEventId);
    assert.ok(
      committedEvents.some((event) => event.eventId === assessmentRow.source_event_id),
      "assessment source_event_id must be a real committed event",
    );
    assert.deepEqual(assessmentRow.evidence_event_ids, [evidenceEvent.eventId]);
    assert.equal(Number(assessmentRow.evidence_head_version), head.recordVersion);
    assert.equal(Number(assessmentRow.evidence_head_ordinal), head.ordinal);
    assert.equal(assessmentRow.evidence_snapshot_hash, expectedHash);
    assert.equal(assessmentRow.policy_version, definition.policyVersion);

    await assert.rejects(
      ownerPool.query(
        `UPDATE goal_assessments SET result = '{}'::jsonb
         WHERE workspace_id = $1 AND goal_instance_id = $2`,
        [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
      ),
      /immutable evidence/,
    );

    // The record head advanced by exactly the committed transition.
    const advancedHead = await readRecordHead(ownerPool);
    assert.deepEqual(advancedHead, {
      recordVersion: head.recordVersion + 1,
      ordinal: head.ordinal + 1,
    });

    // Re-running the production cycle neither re-claims the settled job nor
    // duplicates the transition/ledger rows.
    const idleReports = await runGoalAssessmentWorkerCycle({
      slots: [{ workspaceId: POSTGRES_DEMO_IDS.workspace, repository: queue }],
      resolveDefinition: async () => definition,
      judge,
      now: now(),
    });
    assert.deepEqual(idleReports.get(POSTGRES_DEMO_IDS.workspace), { kind: "idle" });
    assert.equal(gateway.requests.length, 1, "no second model call for a settled job");
    const transitionCount = await ownerPool.query<{ n: number } & pg.QueryResultRow>(
      `SELECT count(*)::int AS n FROM events
       WHERE workspace_id = $1 AND event_kind = 'goal.transition.committed'
         AND payload -> '__realmRuntimePayload' ->> 'goalInstanceId' = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(transitionCount.rows[0]?.n, 1);
    const assessmentCount = await ownerPool.query<{ n: number } & pg.QueryResultRow>(
      `SELECT count(*)::int AS n FROM goal_assessments
       WHERE workspace_id = $1 AND goal_instance_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(assessmentCount.rows[0]?.n, 1);
    // The durable dedupe key (workspace, goal instance, source event) holds.
    assert.equal(
      await queue.enqueue(enqueueInput(goalInstanceId, `goal_job_sem_dup_${suffix}`, sourceEventId)),
      "existing",
    );
  },
);

test(
  "semantic Goal e2e: provider failure fails closed with GOAL_JUDGE_FAILED and writes no Goal fact",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalInstanceId = `goal_sem_fail_${suffix}`;
    const jobId = `goal_job_sem_fail_${suffix}`;
    const leaseOwner = `test-semantic-worker-${suffix}`;
    const definition = semanticDefinition(goalInstanceId);
    const providerSecret = `synthetic-provider-secret-${suffix}`;
    const providerEndpoint = `https://synthetic.invalid/model/${suffix}`;
    t.after(async () => {
      await cleanup(ownerPool, [goalInstanceId]);
      await runtimePool.end();
      await ownerPool.end();
    });

    await insertGoalInstance(ownerPool, goalInstanceId, definition.goalKey);
    const committedEvents = await readCommittedEvents(ownerPool);
    assert.ok(committedEvents.length > 0);
    const headBefore = await readRecordHead(ownerPool);
    const sourceEventId = committedEvents[committedEvents.length - 1]!.eventId;

    const queue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      leaseOwner,
      leaseDurationMs: 30_000,
    });
    assert.equal(
      await queue.enqueue(enqueueInput(goalInstanceId, jobId, sourceEventId)),
      "inserted",
    );

    // Provider transport failure whose raw error carries endpoint + token
    // material: none of it may survive into durable state.
    const gateway = fakeGateway(async () => {
      throw new ModelProviderError(
        "MODEL_REQUEST_FAILED",
        `provider ${providerEndpoint} rejected token ${providerSecret}`,
      );
    });
    const judge = createModelGoalJudge({ getGateway: async () => gateway });

    const reports = await runGoalAssessmentWorkerCycle({
      slots: [{ workspaceId: POSTGRES_DEMO_IDS.workspace, repository: queue }],
      resolveDefinition: async () => definition,
      judge,
      now: now(),
    });
    assert.deepEqual(reports.get(POSTGRES_DEMO_IDS.workspace), {
      kind: "failed",
      code: "GOAL_JUDGE_FAILED",
    });
    assert.equal(gateway.requests.length, 1, "no repair attempt after a provider failure");

    // The job row records only the stable safe classification — no provider
    // endpoint, token, or raw error text.
    const jobRow = await ownerPool.query<{
      state: string;
      lease_owner: string | null;
      lease_expires_at: string | null;
      last_error_code: string | null;
      last_error_message: string | null;
      completed_at: string | null;
    } & pg.QueryResultRow>(
      `SELECT state, lease_owner, lease_expires_at,
              last_error_code, last_error_message, completed_at
       FROM goal_assessment_jobs WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, jobId],
    );
    assert.equal(jobRow.rows[0]?.state, "failed");
    assert.equal(jobRow.rows[0]?.lease_owner, null);
    assert.equal(jobRow.rows[0]?.lease_expires_at, null);
    assert.equal(jobRow.rows[0]?.last_error_code, "GOAL_JUDGE_FAILED");
    assert.equal(jobRow.rows[0]?.last_error_message, "GOAL_JUDGE_FAILED");
    assert.ok(jobRow.rows[0]?.completed_at !== null);
    for (const leaked of [providerSecret, providerEndpoint, "MODEL_REQUEST_FAILED"]) {
      assert.ok(
        !String(jobRow.rows[0]?.last_error_message).includes(leaked),
        `job error must not leak ${leaked}`,
      );
    }

    // Fail-closed: the Goal instance, assessment ledger, transition plane and
    // record head are untouched.
    const instance = await ownerPool.query<{
      state: string;
      revision: string | number;
      progress: Record<string, JsonValue>;
      outcome: Record<string, JsonValue> | null;
      completed_at: string | null;
    } & pg.QueryResultRow>(
      `SELECT state, revision, progress, outcome, completed_at
       FROM goal_instances WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(instance.rows[0]?.state, "active");
    assert.equal(Number(instance.rows[0]?.revision), 0);
    assert.deepEqual(instance.rows[0]?.progress, {});
    assert.equal(instance.rows[0]?.outcome, null);
    assert.equal(instance.rows[0]?.completed_at, null);

    const assessmentCount = await ownerPool.query<{ n: number } & pg.QueryResultRow>(
      `SELECT count(*)::int AS n FROM goal_assessments
       WHERE workspace_id = $1 AND goal_instance_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(assessmentCount.rows[0]?.n, 0, "fail path must not write assessment evidence");
    const transitionCount = await ownerPool.query<{ n: number } & pg.QueryResultRow>(
      `SELECT count(*)::int AS n FROM events
       WHERE workspace_id = $1 AND event_kind = 'goal.transition.committed'
         AND payload -> '__realmRuntimePayload' ->> 'goalInstanceId' = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(transitionCount.rows[0]?.n, 0, "fail path must not commit a transition");
    assert.deepEqual(await readRecordHead(ownerPool), headBefore, "record head must not advance");
  },
);

test(
  "semantic Goal e2e: unparseable model output (initial + repair) fails closed without leaking raw model text",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalInstanceId = `goal_sem_bad_${suffix}`;
    const jobId = `goal_job_sem_bad_${suffix}`;
    const leaseOwner = `test-semantic-worker-${suffix}`;
    const definition = semanticDefinition(goalInstanceId);
    const rawModelGarbage = `not json at all <<<raw-model-secret-${suffix}>>>`;
    t.after(async () => {
      await cleanup(ownerPool, [goalInstanceId]);
      await runtimePool.end();
      await ownerPool.end();
    });

    await insertGoalInstance(ownerPool, goalInstanceId, definition.goalKey);
    const committedEvents = await readCommittedEvents(ownerPool);
    assert.ok(committedEvents.length > 0);
    const headBefore = await readRecordHead(ownerPool);
    const sourceEventId = committedEvents[committedEvents.length - 1]!.eventId;

    const queue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      leaseOwner,
      leaseDurationMs: 30_000,
    });
    assert.equal(
      await queue.enqueue(enqueueInput(goalInstanceId, jobId, sourceEventId)),
      "inserted",
    );

    // Both the initial structured call and the single repair return garbage.
    const gateway = fakeGateway(async () => ({ content: rawModelGarbage }));
    const judge = createModelGoalJudge({ getGateway: async () => gateway });

    const reports = await runGoalAssessmentWorkerCycle({
      slots: [{ workspaceId: POSTGRES_DEMO_IDS.workspace, repository: queue }],
      resolveDefinition: async () => definition,
      judge,
      now: now(),
    });
    assert.deepEqual(reports.get(POSTGRES_DEMO_IDS.workspace), {
      kind: "failed",
      code: "GOAL_JUDGE_FAILED",
    });
    assert.equal(
      gateway.requests.length,
      2,
      "the production repair ladder makes exactly one repair attempt",
    );

    const jobRow = await ownerPool.query<{
      state: string;
      last_error_code: string | null;
      last_error_message: string | null;
    } & pg.QueryResultRow>(
      `SELECT state, last_error_code, last_error_message
       FROM goal_assessment_jobs WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, jobId],
    );
    assert.equal(jobRow.rows[0]?.state, "failed");
    assert.equal(jobRow.rows[0]?.last_error_code, "GOAL_JUDGE_FAILED");
    assert.equal(jobRow.rows[0]?.last_error_message, "GOAL_JUDGE_FAILED");
    assert.ok(
      !String(jobRow.rows[0]?.last_error_message).includes(rawModelGarbage),
      "raw model text must never reach the durable job row",
    );

    const instance = await ownerPool.query<{
      state: string;
      revision: string | number;
    } & pg.QueryResultRow>(
      `SELECT state, revision FROM goal_instances
       WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(instance.rows[0]?.state, "active");
    assert.equal(Number(instance.rows[0]?.revision), 0);
    const assessmentCount = await ownerPool.query<{ n: number } & pg.QueryResultRow>(
      `SELECT count(*)::int AS n FROM goal_assessments
       WHERE workspace_id = $1 AND goal_instance_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(assessmentCount.rows[0]?.n, 0);
    const transitionCount = await ownerPool.query<{ n: number } & pg.QueryResultRow>(
      `SELECT count(*)::int AS n FROM events
       WHERE workspace_id = $1 AND event_kind = 'goal.transition.committed'
         AND payload -> '__realmRuntimePayload' ->> 'goalInstanceId' = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(transitionCount.rows[0]?.n, 0);
    assert.deepEqual(await readRecordHead(ownerPool), headBefore);
  },
);
