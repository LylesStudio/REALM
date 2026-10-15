import assert from "node:assert/strict";
import test from "node:test";
import {
  StoryGraphError,
  evaluateUnlockRule,
  getEligibleStoryRecordNodes,
  normalizeStoryDefinition,
  storyDefinitionHashFor,
  storyNodeInstanceIdFor,
  storyRecordIdFor,
  storyUnlockLedgerIdFor,
  type StoryGraphFacts,
  type StoryNodeRuntimeSnapshot,
} from "../modules/story-graph/public.ts";

const definition = normalizeStoryDefinition({
  storyKey: "preset.story",
  title: "A story",
  premise: "A bounded production story.",
  policyVersion: "story-policy-v1",
  nodes: [
    {
      kind: "record",
      nodeKey: "start",
      recordKey: "start-record",
      title: "Start",
      sequence: 1,
      initial: true,
    },
    {
      kind: "record",
      nodeKey: "next",
      recordKey: "next-record",
      title: "Next",
      sequence: 2,
      unlock: {
        kind: "all",
        rules: [
          { kind: "node_state", nodeKey: "start", state: "completed" },
          { kind: "goal_state", goalKey: "prep", scope: "story", state: "completed" },
        ],
      },
    },
  ],
});

const facts = (overrides: Partial<StoryGraphFacts> = {}): StoryGraphFacts => ({
  storyStarted: true,
  events: [],
  goals: [],
  nodes: [],
  ...overrides,
});

const node = (
  nodeKey: string,
  state: StoryNodeRuntimeSnapshot["state"],
): StoryNodeRuntimeSnapshot => ({
  nodeKey,
  state,
  recordId: null,
  revision: 0,
});

test("normalizes a StoryDefinition and makes the initial node story-start gated", () => {
  assert.deepEqual(definition.nodes[0]!.unlock, { kind: "story_started" });
  assert.equal(Object.isFrozen(definition), true);
  assert.equal(Object.isFrozen(definition.nodes), true);
  assert.equal(definition.nodes[0]!.kind, "record");
});

test("rejects duplicate nodes, missing references, and multiple initial nodes", () => {
  assert.throws(
    () => normalizeStoryDefinition({
      ...definition,
      nodes: [definition.nodes[0]!, definition.nodes[0]!],
    }),
    (error: unknown) => error instanceof StoryGraphError && error.code === "STORY_DEFINITION_INVALID",
  );
  assert.throws(
    () => normalizeStoryDefinition({
      ...definition,
      nodes: [
        definition.nodes[0]!,
        {
          ...definition.nodes[1]!,
          unlock: { kind: "node_state", nodeKey: "missing", state: "completed" },
        },
      ],
    }),
    (error: unknown) => error instanceof StoryGraphError && error.code === "STORY_DEFINITION_INVALID",
  );
  assert.throws(
    () => normalizeStoryDefinition({
      ...definition,
      nodes: definition.nodes.map((item) => ({ ...item, initial: true })),
    }),
    (error: unknown) => error instanceof StoryGraphError && error.code === "STORY_DEFINITION_INVALID",
  );
});

test("unlock evaluation uses only formal story facts and returns auditable evidence", () => {
  const result = evaluateUnlockRule(
    definition.nodes[1]!.unlock!,
    facts({
      goals: [{ goalKey: "prep", scope: "story", state: "completed" }],
      nodes: [node("start", "completed")],
      events: [{ id: "evt-prep", kind: "goal.transition.committed", recordId: "record-start", ordinal: 4 }],
    }),
  );
  assert.deepEqual(result, {
    satisfied: true,
    evidence: {
      eventIds: ["evt-prep"],
      goalKeys: ["prep"],
      nodeKeys: ["start"],
    },
  });

  const freeTextAttempt = evaluateUnlockRule(
    { kind: "goal_state", goalKey: "prep", scope: "story", state: "completed" },
    facts({
      // Natural-language text is deliberately not a StoryGraphFacts field.
      events: [{ id: "evt-chat", kind: "utterance.committed", recordId: "record-start", ordinal: 5 }],
    }),
  );
  assert.equal(freeTextAttempt.satisfied, false);
  assert.deepEqual(freeTextAttempt.evidence, { eventIds: [], goalKeys: [], nodeKeys: [] });
});

test("eligible nodes are deterministic, sorted, and never unlock an active node twice", () => {
  const eligible = getEligibleStoryRecordNodes(
    definition,
    facts({
      goals: [{ goalKey: "prep", scope: "story", state: "completed" }],
      nodes: [node("start", "completed"), node("next", "active")],
    }),
  );
  assert.deepEqual(eligible, []);

  const withLockedNext = getEligibleStoryRecordNodes(
    definition,
    facts({
      goals: [{ goalKey: "prep", scope: "story", state: "completed" }],
      nodes: [node("start", "completed"), node("next", "locked")],
      events: [{ id: "evt-goal", kind: "goal.transition.committed", recordId: "record-start", ordinal: 4 }],
    }),
  );
  assert.equal(withLockedNext.length, 1);
  assert.equal(withLockedNext[0]!.node.nodeKey, "next");
  assert.deepEqual(withLockedNext[0]!.evidence.goalKeys, ["prep"]);
  assert.deepEqual(withLockedNext[0]!.evidence.nodeKeys, ["start"]);
});

test("story graph identities and definition hashes are stable and scope-separated", () => {
  const scope = {
    workspaceId: "ws",
    worldId: "world",
    worldlineId: "wl",
    storyId: "story",
  };
  assert.equal(storyNodeInstanceIdFor(scope, "start"), storyNodeInstanceIdFor(scope, "start"));
  assert.notEqual(storyNodeInstanceIdFor(scope, "start"), storyNodeInstanceIdFor(scope, "next"));
  assert.notEqual(
    storyRecordIdFor(scope, "start"),
    storyRecordIdFor({ ...scope, storyId: "other-story" }, "start"),
  );
  assert.equal(
    storyUnlockLedgerIdFor("node_a", "unlocked", "hash_a"),
    storyUnlockLedgerIdFor("node_a", "unlocked", "hash_a"),
  );
  assert.notEqual(
    storyDefinitionHashFor(definition),
    storyDefinitionHashFor({ ...definition, policyVersion: "story-policy-v2" }),
  );
});

test("unlock rules read committed milestone, obligation, and cash facts only", () => {
  const missing = evaluateUnlockRule(
    { kind: "milestone_status", milestoneId: "milestone_live", status: "completed" },
    facts(),
  );
  assert.equal(missing.satisfied, false);

  const ready = evaluateUnlockRule(
    {
      kind: "all",
      rules: [
        { kind: "milestone_status", milestoneId: "milestone_live", status: "completed" },
        { kind: "obligation_outstanding_at_most", obligationId: "loan_1", maximumMinor: 0 },
        { kind: "cash_at_least", minimumMinor: 1 },
        { kind: "event_count", eventKind: "project.milestone.confirmed", threshold: 1 },
      ],
    },
    facts({
      milestones: [{ id: "milestone_live", status: "completed" }],
      obligations: [{ id: "loan_1", outstandingMinor: 0 }],
      cashBalanceMinor: 500,
      events: [{ id: "evt_live", kind: "project.milestone.confirmed", recordId: "record_live", ordinal: 2 }],
    }),
  );
  assert.equal(ready.satisfied, true);
  assert.deepEqual(ready.evidence.milestoneIds, ["milestone_live"]);
  assert.deepEqual(ready.evidence.obligationIds, ["loan_1"]);
});
