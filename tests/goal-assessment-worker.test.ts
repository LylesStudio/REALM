import assert from "node:assert/strict";
import test from "node:test";
import {
  goalEvidenceSnapshotHash,
  type GoalAssessmentCandidate,
  type GoalDefinition,
  type GoalEvent,
  type GoalInstanceSnapshot,
} from "../modules/goals/public.ts";
import {
  runGoalAssessmentOnce,
  type ClaimedGoalAssessmentJob,
  type GoalAssessmentContext,
  type GoalAssessmentJobRepository,
} from "../modules/goals/assessment-worker.ts";

const deterministicDefinition: GoalDefinition = {
  goalKey: "collect-clues",
  policyVersion: "v1",
  mode: "deterministic",
  visible: true,
  rubric: {
    kind: "event_count",
    eventKind: "clue.found",
    progressKey: "clues",
    threshold: 2,
  },
  outcome: { reward: "unlock" },
};

const semanticDefinition: GoalDefinition = {
  goalKey: "make-a-choice",
  policyVersion: "semantic-v1",
  mode: "semantic",
  visible: true,
  rubric: { kind: "semantic", promptKey: "choice" },
  outcome: { reward: "resolution" },
};

const instance: GoalInstanceSnapshot = {
  goalInstanceId: "goal-1",
  recordId: "record-1",
  state: "active",
  revision: 3,
  progress: {},
  outcome: null,
};

const events: readonly GoalEvent[] = [
  {
    eventId: "event-1",
    recordId: "record-1",
    recordVersion: 1,
    ordinal: 0,
    kind: "clue.found",
    payload: { clue: "north" },
  },
  {
    eventId: "event-2",
    recordId: "record-1",
    recordVersion: 2,
    ordinal: 1,
    kind: "clue.found",
    payload: { clue: "east" },
  },
];

const head = { recordVersion: 2, ordinal: 1 };

function claimedJob(goalKey = deterministicDefinition.goalKey): ClaimedGoalAssessmentJob {
  return {
    jobId: "job-1",
    workspaceId: "workspace-1",
    worldId: "world-1",
    worldVersion: "1.2.0",
    worldlineId: "worldline-1",
    recordId: "record-1",
    goalInstanceId: "goal-1",
    goalKey,
    sourceEventId: "event-2",
    attemptCount: 1,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-10-05T00:01:00.000Z",
  };
}

function context(): GoalAssessmentContext {
  return { instance, events, head };
}

function repository(
  loaded: GoalAssessmentContext,
  job: ClaimedGoalAssessmentJob | null = claimedJob(),
): GoalAssessmentJobRepository & {
  settled: unknown[];
  failed: unknown[];
} {
  const calls = {
    settled: [] as unknown[],
    failed: [] as unknown[],
  };
  return {
    ...calls,
    async claimNext() {
      return job;
    },
    async loadContext() {
      return loaded;
    },
    async settle(input) {
      calls.settled.push(input);
      return "applied";
    },
    async fail(input) {
      calls.failed.push(input);
    },
  };
}

test('semantic continue is a validated active progress transition rather than rejected evidence', async () => {
  const repo=repository(context(),claimedJob(semanticDefinition.goalKey));
  const progress={summary:'The northern clue is verified',completedCriteria:[0]};
  const report=await runGoalAssessmentOnce({repository:repo,resolveDefinition:async()=>semanticDefinition,
    judge:{async assess(){return {decision:'continue',policyVersion:semanticDefinition.policyVersion,evidenceEventIds:['event-1'],
      evidenceSnapshotHash:goalEvidenceSnapshotHash({definition:semanticDefinition,instance,events:[events[0]!],evidenceHead:head}),progress,outcome:null};}},
    now:'2026-10-05T00:00:00.000Z'});
  assert.deepEqual(report,{kind:'settled',status:'accepted'});
  const entry=repo.settled[0] as {decision:{transition:{from:string;to:string;progress:unknown;outcome:unknown;revision:number}}};
  assert.equal(entry.decision.transition.from,'active');
  assert.equal(entry.decision.transition.to,'active');
  assert.equal(entry.decision.transition.revision,4);
  assert.deepEqual(entry.decision.transition.progress,progress);
  assert.equal(entry.decision.transition.outcome,null);
});

test("deterministic Goal jobs evaluate committed evidence and settle an accepted transition", async () => {
  const repo = repository(context());
  const report = await runGoalAssessmentOnce({
    repository: repo,
    resolveDefinition: async () => deterministicDefinition,
    now: "2026-10-05T00:00:00.000Z",
  });

  assert.equal(report.kind, "settled");
  assert.equal(repo.failed.length, 0);
  assert.equal(repo.settled.length, 1);
  const settlement = repo.settled[0] as {
    decision: { status: string; transition?: { revision: number; evidenceEventIds: readonly string[] } };
  };
  assert.equal(settlement.decision.status, "accepted");
  assert.equal(settlement.decision.transition?.revision, 4);
  assert.deepEqual(settlement.decision.transition?.evidenceEventIds, ["event-1", "event-2"]);
});

test("deterministic Goal jobs settle a failed transition when the failure condition is met", async () => {
  const failable: GoalDefinition = {
    ...deterministicDefinition,
    rubric: {
      kind: "event_count",
      eventKind: "clue.found",
      progressKey: "clues",
      threshold: 2,
      failure: { eventKind: "clue.destroyed", progressKey: "losses", threshold: 1 },
    },
  };
  const destroyed: GoalEvent = {
    eventId: "event-lost",
    recordId: "record-1",
    recordVersion: 3,
    ordinal: 2,
    kind: "clue.destroyed",
    payload: { clue: "south" },
  };
  const repo = repository({ ...context(), events: [...events, destroyed] });
  const report = await runGoalAssessmentOnce({
    repository: repo,
    resolveDefinition: async () => failable,
    now: "2026-10-05T00:00:00.000Z",
  });

  assert.equal(report.kind, "settled");
  assert.equal(repo.failed.length, 0);
  const settlement = repo.settled[0] as {
    decision: {
      status: string;
      result: { decision?: string };
      transition?: { to: string; evidenceEventIds: readonly string[] };
    };
  };
  assert.equal(settlement.decision.status, "accepted");
  assert.equal(settlement.decision.result.decision, "fail");
  assert.equal(settlement.decision.transition?.to, "failed");
  assert.deepEqual(settlement.decision.transition?.evidenceEventIds, ["event-lost"]);
});

test("semantic Goal jobs settle fail and settle decisions through the same evidence validation", async () => {
  for (const [decision, target] of [["fail", "failed"], ["settle", "settled"]] as const) {
    const judgeCandidate: GoalAssessmentCandidate = {
      decision,
      policyVersion: semanticDefinition.policyVersion,
      evidenceEventIds: ["event-1", "event-2"],
      evidenceSnapshotHash: goalEvidenceSnapshotHash({
        definition: semanticDefinition,
        instance,
        events: [...events],
        evidenceHead: head,
      }),
      progress: { chosen: true },
      outcome: null,
    };
    const repo = repository(context(), claimedJob(semanticDefinition.goalKey));
    const report = await runGoalAssessmentOnce({
      repository: repo,
      resolveDefinition: async () => semanticDefinition,
      judge: { async assess() { return judgeCandidate; } },
      now: "2026-10-05T00:00:00.000Z",
    });

    assert.equal(report.kind, "settled");
    const settlement = repo.settled[0] as {
      decision: {
        status: string;
        result: { decision?: string };
        transition?: { to: string; outcome: unknown };
      };
    };
    assert.equal(settlement.decision.status, "accepted");
    assert.equal(settlement.decision.result.decision, decision);
    assert.equal(settlement.decision.transition?.to, target);
    assert.deepEqual(settlement.decision.transition?.outcome, semanticDefinition.outcome);
  }
});

test("semantic Goal jobs reject a candidate whose evidence hash was built from an old head", async () => {
  const semanticContext = context();
  const staleCandidate: GoalAssessmentCandidate = {
    decision: "complete",
    policyVersion: semanticDefinition.policyVersion,
    evidenceEventIds: ["event-1"],
    evidenceSnapshotHash: goalEvidenceSnapshotHash({
      definition: semanticDefinition,
      instance,
      events: [events[0]!],
      evidenceHead: { recordVersion: 1, ordinal: 0 },
    }),
    progress: { chosen: true },
    outcome: null,
  };
  const repo = repository(semanticContext, claimedJob(semanticDefinition.goalKey));
  const report = await runGoalAssessmentOnce({
    repository: repo,
    resolveDefinition: async () => semanticDefinition,
    judge: { async assess() { return staleCandidate; } },
    now: "2026-10-05T00:00:00.000Z",
  });

  assert.equal(report.kind, "settled");
  assert.equal(repo.failed.length, 0);
  const settlement = repo.settled[0] as { decision: { status: string; code?: string } };
  assert.equal(settlement.decision.status, "rejected");
  assert.equal(settlement.decision.code, "GOAL_EVIDENCE_HASH_MISMATCH");
});

test("semantic Goal jobs mark a candidate that reaches beyond the loaded head as stale", async () => {
  const semanticContext = context();
  const aheadEvent: GoalEvent = {
    eventId: "event-3",
    recordId: "record-1",
    recordVersion: 3,
    ordinal: 2,
    kind: "choice.made",
    payload: { choice: "north" },
  };
  const repo = repository({
    ...semanticContext,
    events: [...events, aheadEvent],
  }, claimedJob(semanticDefinition.goalKey));
  const report = await runGoalAssessmentOnce({
    repository: repo,
    resolveDefinition: async () => semanticDefinition,
    judge: {
      async assess() {
        return {
          decision: "complete",
          policyVersion: semanticDefinition.policyVersion,
          evidenceEventIds: [aheadEvent.eventId],
          evidenceSnapshotHash: "candidate-hash",
          progress: { chosen: true },
          outcome: null,
        };
      },
    },
    now: "2026-10-05T00:00:00.000Z",
  });

  assert.equal(report.kind, "settled");
  const settlement = repo.settled[0] as { decision: { status: string; code?: string } };
  assert.equal(settlement.decision.status, "stale");
  assert.equal(settlement.decision.code, "GOAL_EVIDENCE_AHEAD_OF_HEAD");
});

test("Judge failures become bounded job failures without persisting provider details", async () => {
  const repo = repository(context(), claimedJob(semanticDefinition.goalKey));
  const report = await runGoalAssessmentOnce({
    repository: repo,
    resolveDefinition: async () => semanticDefinition,
    judge: {
      async assess() {
        throw new Error("provider secret and prompt must not be persisted");
      },
    },
    now: "2026-10-05T00:00:00.000Z",
  });

  assert.equal(report.kind, "failed");
  assert.equal(repo.settled.length, 0);
  assert.deepEqual(repo.failed[0], {
    job: claimedJob(semanticDefinition.goalKey),
    code: "GOAL_JUDGE_FAILED",
    now: "2026-10-05T00:00:00.000Z",
  });
});

test("definition loader failures become bounded job failures", async () => {
  const repo = repository(context());
  const report = await runGoalAssessmentOnce({
    repository: repo,
    resolveDefinition: async () => {
      throw new Error("private loader failure");
    },
    now: "2026-10-05T00:00:00.000Z",
  });

  assert.deepEqual(report, { kind: "failed", code: "GOAL_DEFINITION_LOAD_FAILED" });
  assert.deepEqual(repo.failed[0], {
    job: claimedJob(),
    code: "GOAL_DEFINITION_LOAD_FAILED",
    now: "2026-10-05T00:00:00.000Z",
  });
});

test("a Goal definition from another key is rejected before context loading", async () => {
  const repo = repository(context());
  const report = await runGoalAssessmentOnce({
    repository: repo,
    resolveDefinition: async () => ({ ...deterministicDefinition, goalKey: "other-goal" }),
    now: "2026-10-05T00:00:00.000Z",
  });

  assert.deepEqual(report, { kind: "failed", code: "GOAL_DEFINITION_SCOPE_MISMATCH" });
  assert.deepEqual(repo.failed[0], {
    job: claimedJob(),
    code: "GOAL_DEFINITION_SCOPE_MISMATCH",
    now: "2026-10-05T00:00:00.000Z",
  });
});

test("an empty Goal queue performs no definition lookup or write", async () => {
  const repo = repository(context(), null);
  const report = await runGoalAssessmentOnce({
    repository: repo,
    resolveDefinition: async () => {
      throw new Error("must not resolve an idle job");
    },
    now: "2026-10-05T00:00:00.000Z",
  });

  assert.deepEqual(report, { kind: "idle" });
  assert.equal(repo.settled.length, 0);
  assert.equal(repo.failed.length, 0);
});
