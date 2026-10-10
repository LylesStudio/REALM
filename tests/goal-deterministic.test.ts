import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDeterministicGoal,
  type GoalDefinition,
  type GoalEvent,
  type GoalInstanceSnapshot,
} from "../modules/goals/public.ts";

const definition: GoalDefinition = {
  goalKey: "find-the-signal",
  policyVersion: "goal-v1",
  mode: "deterministic",
  visible: true,
  rubric: {
    kind: "event_count",
    eventKind: "clue.revealed",
    progressKey: "clues",
    threshold: 2,
  },
  outcome: {
    outcomeKey: "signal-found",
    summary: "The signal has been found.",
  },
};

const instance: GoalInstanceSnapshot = {
  goalInstanceId: "goal-instance-1",
  recordId: "record-1",
  state: "active",
  revision: 0,
  progress: {},
  outcome: null,
};

function event(
  eventId: string,
  recordVersion: number,
  ordinal: number,
  recordId = "record-1",
): GoalEvent {
  return {
    eventId,
    recordId,
    recordVersion,
    ordinal,
    kind: "clue.revealed",
    payload: { clueId: eventId },
  };
}

test("deterministic event-count goal produces a validated transition with evidence", () => {
  const result = evaluateDeterministicGoal({
    definition,
    instance,
    events: [event("event-1", 1, 0), event("event-2", 2, 1)],
  });

  assert.equal(result.kind, "transition");
  if (result.kind !== "transition") return;
  assert.deepEqual(result.transition, {
    from: "active",
    to: "completed",
    revision: 1,
    progress: { clues: 2 },
    outcome: definition.outcome,
    evidenceEventIds: ["event-1", "event-2"],
    evidenceHead: { recordVersion: 2, ordinal: 1 },
    evidenceSnapshotHash: result.transition.evidenceSnapshotHash,
    policyVersion: "goal-v1",
  });
  assert.match(result.transition.evidenceSnapshotHash, /^[a-f0-9]{64}$/);
});

test("deterministic goal stays active below threshold and ignores other records", () => {
  const result = evaluateDeterministicGoal({
    definition,
    instance,
    events: [
      event("event-1", 1, 0),
      event("other-record", 2, 1, "record-elsewhere"),
      { ...event("other-kind", 3, 2), kind: "noise" },
    ],
  });

  assert.deepEqual(result, {
    kind: "unchanged",
    progress: { clues: 1 },
    evidenceEventIds: ["event-1"],
    evidenceHead: { recordVersion: 1, ordinal: 0 },
    evidenceSnapshotHash: result.evidenceSnapshotHash,
  });
  assert.match(result.evidenceSnapshotHash, /^[a-f0-9]{64}$/);
});

test("completed goals are terminal and do not emit a second transition", () => {
  const result = evaluateDeterministicGoal({
    definition,
    instance: {
      ...instance,
      state: "completed",
      revision: 4,
      progress: { clues: 2 },
      outcome: definition.outcome,
    },
    events: [event("event-1", 1, 0), event("event-2", 2, 1)],
  });

  assert.equal(result.kind, "terminal");
  assert.deepEqual(result.progress, { clues: 2 });
});

test("semantic definitions and malformed thresholds fail closed", () => {
  assert.equal(
    evaluateDeterministicGoal({
      definition: { ...definition, mode: "semantic" },
      instance,
      events: [event("event-1", 1, 0), event("event-2", 2, 1)],
    }).kind,
    "unsupported",
  );
  assert.equal(
    evaluateDeterministicGoal({
      definition: {
        ...definition,
        mode: "deterministic",
        rubric: {
          kind: "event_count",
          eventKind: "clue.revealed",
          progressKey: "clues",
          threshold: 0,
        },
      },
      instance,
      events: [],
    }).kind,
    "invalid",
  );
});

test("evidence snapshot hashes are stable for the same ordered facts", () => {
  const first = evaluateDeterministicGoal({
    definition,
    instance,
    events: [event("event-1", 1, 0), event("event-2", 2, 1)],
  });
  const second = evaluateDeterministicGoal({
    definition,
    instance,
    events: [event("event-1", 1, 0), event("event-2", 2, 1)],
  });

  assert.equal(first.evidenceSnapshotHash, second.evidenceSnapshotHash);
});
