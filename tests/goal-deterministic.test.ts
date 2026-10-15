import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateDeterministicGoal,
  goalEvidenceSnapshotHash,
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

const failableDefinition: GoalDefinition = {
  ...definition,
  rubric: {
    kind: "event_count",
    eventKind: "clue.revealed",
    progressKey: "clues",
    threshold: 2,
    failure: {
      eventKind: "signal.lost",
      progressKey: "losses",
      threshold: 1,
    },
  },
};

function failureEvent(
  eventId: string,
  recordVersion: number,
  ordinal: number,
): GoalEvent {
  return {
    eventId,
    recordId: "record-1",
    recordVersion,
    ordinal,
    kind: "signal.lost",
    payload: { reason: eventId },
  };
}

test("deterministic failure condition transitions the Goal to failed with failure evidence", () => {
  const result = evaluateDeterministicGoal({
    definition: failableDefinition,
    instance,
    events: [event("event-1", 1, 0), failureEvent("event-2", 2, 1)],
  });

  assert.equal(result.kind, "transition");
  if (result.kind !== "transition") return;
  assert.equal(result.transition.from, "active");
  assert.equal(result.transition.to, "failed");
  assert.equal(result.transition.revision, 1);
  assert.deepEqual(result.transition.evidenceEventIds, ["event-2"]);
  assert.deepEqual(result.transition.evidenceHead, { recordVersion: 2, ordinal: 1 });
  assert.deepEqual(result.transition.progress, { clues: 1, losses: 1 });
  assert.equal(result.transition.outcome, failableDefinition.outcome);
  // 失败证据 hash 由失败事件集确定性派生（与完成事件集无关）。
  assert.equal(
    result.transition.evidenceSnapshotHash,
    goalEvidenceSnapshotHash({
      definition: failableDefinition,
      instance,
      events: [failureEvent("event-2", 2, 1)],
      evidenceHead: { recordVersion: 2, ordinal: 1 },
    }),
  );
});

test("failure below its threshold keeps the Goal active and still reports failure progress", () => {
  const belowFailure = evaluateDeterministicGoal({
    definition: {
      ...failableDefinition,
      rubric: {
        kind: "event_count",
        eventKind: "clue.revealed",
        progressKey: "clues",
        threshold: 2,
        failure: { eventKind: "signal.lost", progressKey: "losses", threshold: 2 },
      },
    },
    instance,
    events: [failureEvent("event-9", 1, 0)],
  });
  assert.equal(belowFailure.kind, "unchanged");
  assert.deepEqual(belowFailure.progress, { clues: 0, losses: 1 });

  // 完成条件先满足时仍走 completed（失败条件未达阈值）。
  const completedFirst = evaluateDeterministicGoal({
    definition: {
      ...failableDefinition,
      rubric: {
        kind: "event_count",
        eventKind: "clue.revealed",
        progressKey: "clues",
        threshold: 2,
        failure: { eventKind: "signal.lost", progressKey: "losses", threshold: 3 },
      },
    },
    instance,
    events: [event("event-1", 1, 0), event("event-2", 2, 1), failureEvent("event-3", 3, 2)],
  });
  assert.equal(completedFirst.kind, "transition");
  if (completedFirst.kind !== "transition") return;
  assert.equal(completedFirst.transition.to, "completed");
});

test("terminals allow-list gates deterministic terminals fail-closed", () => {
  // 内容声明失败条件但不允许 failed 终态 → invalid，绝不静默改终态。
  const failureDisallowed = evaluateDeterministicGoal({
    definition: { ...failableDefinition, terminals: ["completed", "settled"] },
    instance,
    events: [failureEvent("event-2", 2, 1)],
  });
  assert.equal(failureDisallowed.kind, "invalid");

  // 完成条件满足但 completed 不在允许终态内 → invalid。
  const completionDisallowed = evaluateDeterministicGoal({
    definition: { ...definition, terminals: ["failed", "settled"] },
    instance,
    events: [event("event-1", 1, 0), event("event-2", 2, 1)],
  });
  assert.equal(completionDisallowed.kind, "invalid");

  // 非法 terminals 声明本身即 invalid。
  const malformed = evaluateDeterministicGoal({
    definition: { ...definition, terminals: [] },
    instance,
    events: [event("event-1", 1, 0), event("event-2", 2, 1)],
  });
  assert.equal(malformed.kind, "invalid");
});

test("malformed failure rubric shapes fail closed", () => {
  const malformedThreshold = evaluateDeterministicGoal({
    definition: {
      ...definition,
      rubric: {
        kind: "event_count",
        eventKind: "clue.revealed",
        progressKey: "clues",
        threshold: 2,
        failure: { eventKind: "signal.lost", progressKey: "losses", threshold: 0 },
      },
    },
    instance,
    events: [failureEvent("event-2", 2, 1)],
  });
  assert.equal(malformedThreshold.kind, "invalid");

  const sameKind = evaluateDeterministicGoal({
    definition: {
      ...definition,
      rubric: {
        kind: "event_count",
        eventKind: "clue.revealed",
        progressKey: "clues",
        threshold: 2,
        failure: { eventKind: "clue.revealed", progressKey: "losses", threshold: 1 },
      },
    },
    instance,
    events: [event("event-1", 1, 0), event("event-2", 2, 1)],
  });
  assert.equal(sameKind.kind, "invalid");
});
