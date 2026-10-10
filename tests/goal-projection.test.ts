import assert from "node:assert/strict";
import test from "node:test";
import { projectGoal } from "../modules/goals/projection.ts";
import type { GoalDefinition } from "../modules/goals/public.ts";
import type { GoalProjectionInstance } from "../modules/goals/projection.ts";

const definition: GoalDefinition = {
  goalKey: "harbor.signal",
  policyVersion: "policy-v1",
  mode: "deterministic",
  visible: true,
  rubric: {
    kind: "event_count",
    eventKind: "narration.committed",
    progressKey: "signals",
    threshold: 2,
  },
  outcome: { title: "Signal received", public: true },
};

function instance(overrides: Partial<GoalProjectionInstance> = {}): GoalProjectionInstance {
  return {
    goalKey: "harbor.signal",
    goalInstanceId: "goal-1",
    recordId: "record-1",
    state: "active",
    revision: 1,
    progress: { signals: 1 },
    outcome: null,
    ...overrides,
  };
}

test("visible active Goal projection exposes runtime state without terminal outcome", () => {
  assert.deepEqual(projectGoal({ definition, instance: instance() }), {
    goalKey: "harbor.signal",
    state: "active",
    progress: { signals: 1 },
    outcome: null,
  });
});

test("terminal Goal projection uses content outcome and ignores private runtime outcome", () => {
  assert.deepEqual(projectGoal({
    definition,
    instance: instance({
      state: "completed",
      progress: { signals: 2 },
      outcome: { privateJudgeTrace: "must-not-leak" },
    }),
  }), {
    goalKey: "harbor.signal",
    state: "completed",
    progress: { signals: 2 },
    outcome: { title: "Signal received", public: true },
  });
});

test("invisible and mismatched definitions fail closed", () => {
  assert.equal(projectGoal({
    definition: { ...definition, visible: false },
    instance: instance(),
  }), null);
  assert.equal(projectGoal({
    definition,
    instance: instance({ goalKey: "other.goal" }),
  }), null);
});
