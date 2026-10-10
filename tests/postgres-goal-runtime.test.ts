import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import test from "node:test";
import {
  createPostgresGoalAssessmentJobQueue,
  type GoalAssessmentEnqueueInput,
} from "../database/postgres/goal-assessment-job-queue.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { createGoalAssessmentWorkerRuntime } from "../modules/goals/assessment-worker-runtime.ts";
import {
  runGoalAssessmentOnce,
  type GoalAssessmentDecision,
} from "../modules/goals/assessment-worker.ts";
import type { GoalDefinition } from "../modules/goals/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";

function now(): string {
  return new Date().toISOString();
}

function goalDefinition(goalKey: string): GoalDefinition {
  return {
    goalKey,
    policyVersion: "v1",
    mode: "deterministic",
    visible: true,
    rubric: {
      kind: "event_count",
      eventKind: "narration.committed",
      progressKey: "narrations",
      threshold: 1,
    },
    outcome: { result: "opening acknowledged" },
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
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, '{}'::jsonb, NULL, 'v1')`,
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
  sourceEventId = POSTGRES_DEMO_IDS.openingEvent,
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
    input: { trigger: "test" },
    availableAt: now(),
  };
}

async function cleanup(ownerPool: pg.Pool, goalInstanceId: string): Promise<void> {
  await ownerPool.query(
    `DELETE FROM goal_instances
     WHERE workspace_id = $1 AND id = $2`,
    [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
  );
}

test(
  "Goal queue claims with a lease, loads committed evidence, and fences a second claim",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalInstanceId = `goal_${suffix}`;
    const jobId = `goal_job_${suffix}`;
    const goalKey = goalInstanceId;
    t.after(async () => {
      await cleanup(ownerPool, goalInstanceId);
      await runtimePool.end();
      await ownerPool.end();
    });

    await insertGoalInstance(ownerPool, goalInstanceId, goalKey);
    const queue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      leaseOwner: `test-worker-${suffix}`,
      leaseDurationMs: 30_000,
    });
    assert.equal(await queue.enqueue(enqueueInput(goalInstanceId, jobId)), "inserted");

    const claimed = await queue.claimNext({ now: now() });
    assert.ok(claimed);
    assert.equal(claimed.jobId, jobId);
    assert.equal(claimed.attemptCount, 1);
    assert.equal(await queue.claimNext({ now: now() }), null);

    const context = await queue.loadContext(claimed);
    assert.deepEqual(context.head, { recordVersion: 1, ordinal: 1 });
    assert.deepEqual(context.events.map((event) => event.eventId), [POSTGRES_DEMO_IDS.openingEvent]);
    assert.equal(context.events[0]?.kind, "narration.committed");

    await queue.fail({ job: claimed, code: "TEST_CLEANUP", now: now() });
  },
);

test(
  "Goal worker settles a deterministic transition as a formal event and immutable assessment",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalInstanceId = `goal_${suffix}`;
    const jobId = `goal_job_${suffix}`;
    const definition = goalDefinition(goalInstanceId);
    t.after(async () => {
      await cleanup(ownerPool, goalInstanceId);
      await runtimePool.end();
      await ownerPool.end();
    });

    await insertGoalInstance(ownerPool, goalInstanceId, definition.goalKey);
    const queue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      leaseOwner: `test-worker-${suffix}`,
      leaseDurationMs: 30_000,
    });
    assert.equal(await queue.enqueue(enqueueInput(goalInstanceId, jobId)), "inserted");

    const report = await runGoalAssessmentOnce({
      repository: queue,
      resolveDefinition: async () => definition,
      now: now(),
    });
    assert.deepEqual(report, { kind: "settled", status: "accepted" });

    const instance = await ownerPool.query<{ state: string; revision: string; progress: Record<string, number> }>(
      `SELECT state, revision, progress
       FROM goal_instances WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(instance.rows[0]?.state, "completed");
    assert.equal(Number(instance.rows[0]?.revision), 1);
    assert.equal(instance.rows[0]?.progress.narrations, 1);

    const transition = await ownerPool.query<{ event_kind: string; record_version: string; record_ordinal: string }>(
      `SELECT event_kind, record_version, record_ordinal
       FROM events
       WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, `goal-transition:${jobId}:1`],
    );
    assert.deepEqual(transition.rows[0], {
      event_kind: "goal.transition.committed",
      record_version: "2",
      record_ordinal: "2",
    });

    const assessment = await ownerPool.query<{ status: string; source: string; evidence_event_ids: string[] }>(
      `SELECT status, source, evidence_event_ids
       FROM goal_assessments WHERE workspace_id = $1 AND goal_instance_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(assessment.rows[0]?.status, "accepted");
    assert.equal(assessment.rows[0]?.source, "deterministic");
    assert.deepEqual(assessment.rows[0]?.evidence_event_ids, [POSTGRES_DEMO_IDS.openingEvent]);

    await assert.rejects(
      ownerPool.query(
        `UPDATE goal_assessments SET result = '{}'::jsonb
         WHERE workspace_id = $1 AND goal_instance_id = $2`,
        [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
      ),
      /immutable evidence/,
    );
  },
);

test(
  "a stale Goal lease cannot settle after another worker reclaims the job",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalInstanceId = `goal_${suffix}`;
    const jobId = `goal_job_${suffix}`;
    t.after(async () => {
      await cleanup(ownerPool, goalInstanceId);
      await runtimePool.end();
      await ownerPool.end();
    });

    await insertGoalInstance(ownerPool, goalInstanceId, goalInstanceId);
    const first = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      leaseOwner: `first-${suffix}`,
      leaseDurationMs: 1,
    });
    const second = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      leaseOwner: `second-${suffix}`,
      leaseDurationMs: 30_000,
    });
    assert.equal(await first.enqueue(enqueueInput(goalInstanceId, jobId)), "inserted");
    const firstClaim = await first.claimNext({ now: now() });
    assert.ok(firstClaim);
    const reclaimAt = new Date(Date.parse(firstClaim.leaseExpiresAt) + 10).toISOString();
    const secondClaim = await second.claimNext({ now: reclaimAt });
    assert.ok(secondClaim);
    assert.equal(secondClaim.attemptCount, 2);

    const decision: GoalAssessmentDecision = {
      status: "rejected",
      source: "fallback",
      policyVersion: "v1",
      observedHead: { recordVersion: 1, ordinal: 1 },
      code: "TEST_STALE_LEASE",
      evidence: {
        progress: {},
        evidenceEventIds: [],
        evidenceHead: null,
        evidenceSnapshotHash: "test-hash",
      },
      result: { kind: "test" },
    };
    await assert.rejects(
      first.settle({ job: firstClaim, decision, now: reclaimAt }),
      (error: unknown) => (error as { code?: string }).code === "GOAL_STALE_LEASE",
    );
    await assert.rejects(
      first.fail({ job: firstClaim, code: "TEST_STALE_LEASE", now: reclaimAt }),
      (error: unknown) => (error as { code?: string }).code === "GOAL_STALE_LEASE",
    );
    await second.fail({ job: secondClaim, code: "TEST_CLEANUP", now: reclaimAt });
  },
);

const GOAL_WORKER_LOCK_SQL = `
  SELECT count(*)::int AS n FROM pg_locks
  WHERE locktype = 'advisory' AND granted
    AND classid = ((hashtext('realm_goal_assessment_worker')::bigint >> 32) & x'ffffffff'::bigint)::bigint
    AND objid = (hashtext('realm_goal_assessment_worker')::bigint & x'ffffffff'::bigint)::bigint`;

test(
  "Goal assessment worker runtime holds its advisory lock through the shared host and stops cleanly",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const installRoot = await mkdtemp(join(tmpdir(), "goal-worker-host-"));
    t.after(async () => {
      await ownerPool.end();
      await rm(installRoot, { recursive: true, force: true });
    });

    const logs: string[] = [];
    const runtime = createGoalAssessmentWorkerRuntime({
      connectionString: runtimeConnectionString!,
      installRoot,
      verifySignature: (() => false),
      workspaces: [POSTGRES_DEMO_IDS.workspace],
      idleMinMs: 10,
      idleMaxMs: 40,
      logger: (line) => logs.push(line),
    });
    let startError: unknown = null;
    const started = runtime.start().catch((error: unknown) => {
      startError = error;
    });
    t.after(async () => {
      await runtime.stop().catch(() => undefined);
    });

    const deadline = Date.now() + 30_000;
    while (!logs.includes("advisory lock acquired")) {
      if (Date.now() >= deadline) {
        throw new Error("timed out waiting for the Goal worker advisory lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const held = await ownerPool.query<{ n: number }>(GOAL_WORKER_LOCK_SQL);
    assert.equal(held.rows[0]?.n, 1, "the runtime must hold its advisory lock");

    // A competitor runtime is rejected by the same lock and releases its
    // resources instead of leaking them behind the failed start.
    const competitor = createGoalAssessmentWorkerRuntime({
      connectionString: runtimeConnectionString!,
      installRoot,
      verifySignature: (() => false),
      workspaces: [POSTGRES_DEMO_IDS.workspace],
      idleMinMs: 10,
      idleMaxMs: 40,
      logger: () => {},
    });
    await assert.rejects(
      competitor.start(),
      (error: unknown) => (error as { code?: string }).code === "GOAL_WORKER_ALREADY_RUNNING",
    );
    await competitor.stop();
    const stillHeld = await ownerPool.query<{ n: number }>(GOAL_WORKER_LOCK_SQL);
    assert.equal(stillHeld.rows[0]?.n, 1, "the first runtime keeps its lock");

    // stop() is idempotent, wakes the idle backoff and releases the lock.
    await Promise.all([runtime.stop(), runtime.stop()]);
    await started;
    assert.equal(startError, null, "the worker loop must exit without an error");
    const released = await ownerPool.query<{ n: number }>(GOAL_WORKER_LOCK_SQL);
    assert.equal(released.rows[0]?.n, 0, "stop must release the advisory lock");
    assert.equal(
      logs.some((line) => /postgres(?:ql)?:\/\//i.test(line)),
      false,
      "worker logs must not contain connection strings",
    );
  },
);
