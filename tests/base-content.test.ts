import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_BASE_GOAL_DEFINITIONS,
  createBaseGoalDefinitionResolver,
  resolveBaseGoalDefinition,
} from "../modules/world-transfer/base-content.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import type { GoalDefinition } from "../modules/goals/public.ts";

const customDefinition: GoalDefinition = {
  goalKey: "base.custom",
  policyVersion: "custom-v1",
  mode: "deterministic",
  visible: true,
  rubric: {
    kind: "event_count",
    eventKind: "custom.event",
    progressKey: "custom",
    threshold: 2,
  },
  outcome: { result: "custom" },
};

test("base content resolves built-in definitions only in the local sentinel mode", () => {
  assert.equal(BUILTIN_BASE_GOAL_DEFINITIONS.length, 1);
  assert.equal(resolveBaseGoalDefinition({
    worldId: "ignored-in-base-mode",
    worldVersion: LOCAL_WORLD_VERSION,
    goalKey: "base.first-narration",
  })?.goalKey, "base.first-narration");
  assert.equal(resolveBaseGoalDefinition({
    worldId: "world-harbor",
    worldVersion: "1.2.0",
    goalKey: "base.first-narration",
  }), null);
  assert.equal(resolveBaseGoalDefinition({
    worldId: "local-world",
    worldVersion: LOCAL_WORLD_VERSION,
    goalKey: "missing",
  }), null);
});

test("base content accepts an explicit engine-owned definition set and rejects duplicate keys", () => {
  const resolve = createBaseGoalDefinitionResolver([customDefinition]);
  assert.deepEqual(resolve({
    worldId: "local-world",
    worldVersion: LOCAL_WORLD_VERSION,
    goalKey: "base.custom",
  }), customDefinition);
  assert.throws(
    () => createBaseGoalDefinitionResolver([customDefinition, customDefinition]),
    /unique non-empty keys/,
  );
  assert.throws(
    () => createBaseGoalDefinitionResolver([{ ...customDefinition, goalKey: "   " }]),
    /unique non-empty keys/,
  );
});
