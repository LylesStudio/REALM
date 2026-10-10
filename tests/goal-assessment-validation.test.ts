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
