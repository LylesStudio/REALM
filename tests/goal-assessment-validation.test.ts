import assert from "node:assert/strict";
import test from "node:test";
import {
  goalEvidenceSnapshotHash,
  validateGoalAssessment,
  type GoalAssessmentCandidate,
  type GoalDefinition,
  type GoalEvent,
  type GoalInstanceSnapshot,
} from "../modules/goals/public.ts";

const definition: GoalDefinition = {
  goalKey: "understand-the-signal",
  policyVersion: "judge-v1",
  mode: "semantic",
  visible: true,
  rubric: {
    kind: "semantic",
    promptKey: "understand-signal",
  },
  outcome: {
    outcomeKey: "understood",
  },
};

const instance: GoalInstanceSnapshot = {
  goalInstanceId: "goal-instance-judge",
  recordId: "record-1",
  state: "active",
  revision: 2,
  progress: { clues: 2 },
  outcome: null,
};

const events: readonly GoalEvent[] = [
  {
    eventId: "event-1",
    recordId: "record-1",
    recordVersion: 1,
    ordinal: 0,
    kind: "narration.committed",
    payload: { content: "The signal resolves into a voice." },
  },
  {
    eventId: "event-future",
    recordId: "record-1",
    recordVersion: 3,
    ordinal: 2,
    kind: "narration.committed",
    payload: { content: "A later answer arrives." },
  },
];

const head = { recordVersion: 1, ordinal: 0 };
const evidenceEvents = [events[0]!];

function candidate(
  overrides: Partial<GoalAssessmentCandidate> = {},
): GoalAssessmentCandidate {
  return {
    decision: "complete",
    policyVersion: definition.policyVersion,
    evidenceEventIds: ["event-1"],
    evidenceSnapshotHash: goalEvidenceSnapshotHash({
      definition,
      instance,
      events: evidenceEvents,
      evidenceHead: head,
    }),
    progress: { clues: 2, understanding: 1 },
    outcome: { outcomeKey: "understood" },
    ...overrides,
  };
}

test("valid Judge assessment becomes a transition only after evidence validation", () => {
  const result = validateGoalAssessment({
    definition,
    instance,
    candidate: candidate(),
    events,
    head,
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.transition, {
    from: "active",
    to: "completed",
    revision: 3,
    progress: { clues: 2, understanding: 1 },
    outcome: { outcomeKey: "understood" },
    evidenceEventIds: ["event-1"],
    evidenceHead: head,
    evidenceSnapshotHash: candidate().evidenceSnapshotHash,
    policyVersion: "judge-v1",
  });
});

test("unknown evidence cannot become a Goal fact", () => {
  const result = validateGoalAssessment({
    definition,
    instance,
    candidate: candidate({ evidenceEventIds: ["not-an-event"] }),
    events,
    head,
  });

  assert.deepEqual(result, {
    kind: "rejected",
    code: "GOAL_EVIDENCE_EVENT_NOT_FOUND",
  });
});

test("evidence after the captured head is stale, even when the event exists", () => {
  const futureHead = { recordVersion: 3, ordinal: 2 };
  const result = validateGoalAssessment({
    definition,
    instance,
    candidate: candidate({
      evidenceEventIds: ["event-future"],
      evidenceSnapshotHash: goalEvidenceSnapshotHash({
        definition,
        instance,
        events: [events[1]!],
        evidenceHead: futureHead,
      }),
    }),
    events,
    head,
  });

  assert.deepEqual(result, {
    kind: "stale",
    code: "GOAL_EVIDENCE_AHEAD_OF_HEAD",
  });
});

test("a mismatched evidence hash rejects the Judge output without persistence", () => {
  const result = validateGoalAssessment({
    definition,
    instance,
    candidate: candidate({ evidenceSnapshotHash: "0".repeat(64) }),
    events,
    head,
  });

  assert.deepEqual(result, {
    kind: "rejected",
    code: "GOAL_EVIDENCE_HASH_MISMATCH",
  });
});

test("policy mismatch and duplicate evidence fail closed", () => {
  assert.deepEqual(
    validateGoalAssessment({
      definition,
      instance,
      candidate: candidate({ policyVersion: "judge-v2" }),
      events,
      head,
    }),
    { kind: "rejected", code: "GOAL_POLICY_VERSION_MISMATCH" },
  );
  assert.deepEqual(
    validateGoalAssessment({
      definition,
      instance,
      candidate: candidate({ evidenceEventIds: ["event-1", "event-1"] }),
      events,
      head,
    }),
    { kind: "rejected", code: "GOAL_EVIDENCE_DUPLICATE" },
  );
});

test("fail and settle candidates become validated transitions with the same evidence guarantees", () => {
  for (const [decision, target] of [["fail", "failed"], ["settle", "settled"]] as const) {
    const result = validateGoalAssessment({
      definition,
      instance,
      candidate: candidate({ decision }),
      events,
      head,
    });

    assert.equal(result.kind, "accepted");
    if (result.kind !== "accepted") continue;
    assert.equal(result.transition.from, "active");
    assert.equal(result.transition.to, target);
    assert.equal(result.transition.revision, 3);
    // 与 complete 相同的证据校验：ids/head/hash/policy 全部复验。
    assert.deepEqual(result.transition.evidenceEventIds, ["event-1"]);
    assert.deepEqual(result.transition.evidenceHead, head);
    assert.equal(
      result.transition.evidenceSnapshotHash,
      candidate({ decision }).evidenceSnapshotHash,
    );
    assert.equal(result.transition.policyVersion, "judge-v1");
    assert.deepEqual(result.transition.outcome, { outcomeKey: "understood" });
  }
});

test("fail/settle candidates keep the full evidence and policy validation burden", () => {
  assert.deepEqual(
    validateGoalAssessment({
      definition,
      instance,
      candidate: candidate({ decision: "fail", evidenceEventIds: ["not-an-event"] }),
      events,
      head,
    }),
    { kind: "rejected", code: "GOAL_EVIDENCE_EVENT_NOT_FOUND" },
  );
  assert.deepEqual(
    validateGoalAssessment({
      definition,
      instance,
      candidate: candidate({ decision: "settle", evidenceSnapshotHash: "forged" }),
      events,
      head,
    }),
    { kind: "rejected", code: "GOAL_EVIDENCE_HASH_MISMATCH" },
  );
  assert.deepEqual(
    validateGoalAssessment({
      definition,
      instance,
      candidate: candidate({ decision: "fail", policyVersion: "judge-v2" }),
      events,
      head,
    }),
    { kind: "rejected", code: "GOAL_POLICY_VERSION_MISMATCH" },
  );
});

test("content-declared terminal allow-list rejects disallowed terminals", () => {
  // R6+ 内容可声明 terminals 不含 failed；校验器必须拒绝。
  const noFail = validateGoalAssessment({
    definition: { ...definition, terminals: ["completed", "settled"] },
    instance,
    candidate: candidate({ decision: "fail" }),
    events,
    head,
  });
  assert.deepEqual(noFail, { kind: "rejected", code: "GOAL_TERMINAL_NOT_ALLOWED" });

  const noSettle = validateGoalAssessment({
    definition: { ...definition, terminals: ["completed"] },
    instance,
    candidate: candidate({ decision: "settle" }),
    events,
    head,
  });
  assert.deepEqual(noSettle, { kind: "rejected", code: "GOAL_TERMINAL_NOT_ALLOWED" });

  const noComplete = validateGoalAssessment({
    definition: { ...definition, terminals: ["failed"] },
    instance,
    candidate: candidate({ decision: "complete" }),
    events,
    head,
  });
  assert.deepEqual(noComplete, { kind: "rejected", code: "GOAL_TERMINAL_NOT_ALLOWED" });

  // 允许时正常接受。
  const allowed = validateGoalAssessment({
    definition: { ...definition, terminals: ["failed", "settled"] },
    instance,
    candidate: candidate({ decision: "fail" }),
    events,
    head,
  });
  assert.equal(allowed.kind, "accepted");
});

test("terminal instances reject every decision without flipping state", () => {
  for (const decision of ["complete", "fail", "settle"] as const) {
    const result = validateGoalAssessment({
      definition,
      instance: { ...instance, state: "failed" },
      candidate: candidate({ decision }),
      events,
      head,
    });
    assert.deepEqual(result, { kind: "terminal", code: "GOAL_ALREADY_TERMINAL" });
  }
});
