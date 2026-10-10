import assert from "node:assert/strict";
import test from "node:test";
import {
  runGoalAssessmentWorkerCycle,
  createGoalAssessmentWorkerRuntime,
} from "../modules/goals/assessment-worker-runtime.ts";
import type {
  ClaimedGoalAssessmentJob,
  GoalAssessmentContext,
  GoalAssessmentJobRepository,
} from "../modules/goals/assessment-worker.ts";
import type { GoalDefinition } from "../modules/goals/public.ts";

const definition: GoalDefinition = {
  goalKey: "collect-clues",
  policyVersion: "v1",
  mode: "deterministic",
  visible: true,
  rubric: { kind: "event_count", eventKind: "clue.found", progressKey: "clues", threshold: 1 },
  outcome: { ending: "open" },
};

const job: ClaimedGoalAssessmentJob = {
  jobId: "job-1",
  workspaceId: "workspace-1",
  worldId: "world-1",
  worldVersion: "1.2.0",
  worldlineId: "worldline-1",
  recordId: "record-1",
  goalInstanceId: "goal-1",
  goalKey: definition.goalKey,
  sourceEventId: "event-1",
  attemptCount: 1,
  leaseOwner: "worker-1",
  leaseExpiresAt: "2026-10-05T00:01:00.000Z",
};

const context: GoalAssessmentContext = {
  instance: {
    goalInstanceId: job.goalInstanceId,
    recordId: job.recordId,
    state: "active",
    revision: 0,
    progress: {},
    outcome: null,
  },
  events: [{
    eventId: "event-1",
    recordId: job.recordId,
    recordVersion: 1,
    ordinal: 0,
    kind: "clue.found",
    payload: { clue: "north" },
  }],
  head: { recordVersion: 1, ordinal: 0 },
};

function fakeRepository(): GoalAssessmentJobRepository & { settled: unknown[] } {
  const settled: unknown[] = [];
  return {
    settled,
    async claimNext() { return job; },
    async loadContext() { return context; },
    async settle(input) {
      settled.push(input);
      return "applied";
    },
    async fail() {},
  };
}

test("Goal worker cycle drives the durable assessment worker once per workspace", async () => {
  const repository = fakeRepository();
  let resolvedWorldVersion = "";
  const reports = await runGoalAssessmentWorkerCycle({
    slots: [{ workspaceId: job.workspaceId, repository }],
    resolveDefinition: async (claimed) => {
      resolvedWorldVersion = claimed.worldVersion;
      return definition;
    },
    now: "2026-10-05T00:00:00.000Z",
  });
  assert.equal(reports.get(job.workspaceId)?.kind, "settled");
  assert.equal(resolvedWorldVersion, "1.2.0");
  assert.equal(repository.settled.length, 1);
});

test("Goal worker runtime rejects unsafe configuration before opening a pool", () => {
  assert.throws(
    () => createGoalAssessmentWorkerRuntime({
      connectionString: "",
      installRoot: "/var/lib/realm/worlds",
      verifySignature: (() => true) as never,
      workspaces: ["workspace-1"],
    }),
    (error: unknown) => (error as { code?: string }).code === "GOAL_WORKER_DATABASE_URL_INVALID",
  );
  assert.throws(
    () => createGoalAssessmentWorkerRuntime({
      connectionString: "postgresql://127.0.0.1/realm_runtime",
      installRoot: "/var/lib/realm/worlds",
      verifySignature: undefined as never,
      workspaces: ["workspace-1"],
    }),
    (error: unknown) => (error as { code?: string }).code === "GOAL_WORKER_SIGNATURE_VERIFIER_INVALID",
  );
});
