import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  evaluateDeterministicGoal,
  goalEvidenceSnapshotHash,
  goalInstanceIdFor,
  goalScopeAnchorId,
  goalScopeKind,
  validateGoalAssessment,
  type GoalDefinition,
  type GoalEvent,
  type GoalRuntimeScope,
  type GoalStoryScope,
  type GoalWorldlineScope,
} from "../modules/goals/public.ts";

const recordScope: GoalRuntimeScope = {
  workspaceId: "workspace-1",
  worldId: "world-1",
  worldlineId: "worldline-1",
  recordId: "record-1",
};

const storyScope: GoalStoryScope = {
  kind: "story",
  workspaceId: "workspace-1",
  worldId: "world-1",
  worldlineId: "worldline-1",
  storyId: "story-1",
};

const worldlineScope: GoalWorldlineScope = {
  kind: "worldline",
  workspaceId: "workspace-1",
  worldId: "world-1",
  worldlineId: "worldline-1",
};

test("record scope keeps the legacy deterministic instance id byte-for-byte", () => {
  const legacyDigest = createHash("sha256")
    .update([
      "goal-instance:v1",
      recordScope.workspaceId,
      recordScope.worldId,
      recordScope.worldlineId,
      recordScope.recordId,
      "goal.key",
    ].join("\0"))
    .digest("hex");
  const legacyId = `goal_${legacyDigest.slice(0, 24)}`;

  // 缺省 kind 的历史 Record-shaped scope 与显式 kind:"record" 同身份。
  assert.equal(goalInstanceIdFor(recordScope, "goal.key"), legacyId);
  assert.equal(
    goalInstanceIdFor({ ...recordScope, kind: "record" }, "goal.key"),
    legacyId,
  );
  assert.equal(goalInstanceIdFor(recordScope, "goal.key", 1), legacyId);
});

test("scope kinds are domain-separated: story/worldline never collide with record identity", () => {
  const recordId = goalInstanceIdFor(recordScope, "goal.key");
  const storyId = goalInstanceIdFor(storyScope, "goal.key");
  const worldlineId = goalInstanceIdFor(worldlineScope, "goal.key");

  assert.notEqual(storyId, recordId);
  assert.notEqual(worldlineId, recordId);
  assert.notEqual(storyId, worldlineId);
  // 确定性：同输入永远同 id。
  assert.equal(goalInstanceIdFor(storyScope, "goal.key"), storyId);
  assert.equal(goalInstanceIdFor(worldlineScope, "goal.key"), worldlineId);
  // story 锚变化 → 身份变化。
  assert.notEqual(
    goalInstanceIdFor({ ...storyScope, storyId: "story-2" }, "goal.key"),
    storyId,
  );
});

test("retry attempts derive new deterministic ids; invalid attempts fail closed", () => {
  const first = goalInstanceIdFor(recordScope, "goal.key", 1);
  const second = goalInstanceIdFor(recordScope, "goal.key", 2);
  const third = goalInstanceIdFor(recordScope, "goal.key", 3);

  assert.notEqual(first, second);
  assert.notEqual(second, third);
  // attempt>1 的 id 不含 legacy digest（域分隔 v2）。
  assert.equal(second, goalInstanceIdFor({ ...recordScope }, "goal.key", 2));
  assert.notEqual(
    second,
    goalInstanceIdFor({ ...storyScope }, "goal.key", 2),
  );

  assert.throws(() => goalInstanceIdFor(recordScope, "goal.key", 0), /attempt/);
  assert.throws(() => goalInstanceIdFor(recordScope, "goal.key", -1), /attempt/);
  assert.throws(() => goalInstanceIdFor(recordScope, "goal.key", 1.5), /attempt/);
});

test("scope helpers normalize the discriminated union", () => {
  assert.equal(goalScopeKind(recordScope), "record");
  assert.equal(goalScopeKind({ ...recordScope, kind: "record" }), "record");
  assert.equal(goalScopeKind(storyScope), "story");
  assert.equal(goalScopeKind(worldlineScope), "worldline");
  assert.equal(goalScopeAnchorId(recordScope), "record-1");
  assert.equal(goalScopeAnchorId(storyScope), "story-1");
  assert.equal(goalScopeAnchorId(worldlineScope), "");
});

const deterministicDefinition: GoalDefinition = {
  goalKey: "scope.boundary",
  policyVersion: "v1",
  mode: "deterministic",
  visible: true,
  rubric: {
    kind: "event_count",
    eventKind: "narration.committed",
    progressKey: "events",
    threshold: 1,
  },
  outcome: { ok: true },
};

const semanticDefinition: GoalDefinition = {
  goalKey: "scope.semantic",
  policyVersion: "v1",
  mode: "semantic",
  visible: true,
  rubric: { kind: "semantic", promptKey: "scope" },
  outcome: { ok: true },
};

test("deterministic evaluation fails closed for non-record scopes in B1", () => {
  const result = evaluateDeterministicGoal({
    definition: deterministicDefinition,
    instance: {
      goalInstanceId: "goal_story",
      recordId: "",
      state: "active",
      revision: 0,
      progress: {},
      outcome: null,
      scopeKind: "story",
    },
    events: [],
  });
  assert.equal(result.kind, "unsupported");
});

test("semantic validation fails closed for non-record scopes in B1", () => {
  const result = validateGoalAssessment({
    definition: semanticDefinition,
    instance: {
      goalInstanceId: "goal_worldline",
      recordId: "",
      state: "active",
      revision: 0,
      progress: {},
      outcome: null,
      scopeKind: "worldline",
    },
    candidate: {
      decision: "complete",
      policyVersion: "v1",
      evidenceEventIds: ["event-1"],
      evidenceSnapshotHash: "irrelevant",
      progress: {},
      outcome: null,
    },
    events: [],
    head: { recordVersion: 1, ordinal: 0 },
  });
  assert.deepEqual(result, { kind: "rejected", code: "GOAL_SCOPE_UNSUPPORTED" });
});

test("non-record evidence hashes are domain-separated by scope anchor", () => {
  const event: GoalEvent = {
    eventId: "event-1",
    recordId: "record-member-1",
    recordVersion: 1,
    ordinal: 0,
    kind: "narration.committed",
    payload: { text: "evidence" },
  };
  const base = {
    goalInstanceId: "goal-scope",
    state: "active" as const,
    revision: 0,
    progress: {},
    outcome: null,
  };
  const storyOne = goalEvidenceSnapshotHash({
    definition: deterministicDefinition,
    instance: {
      ...base,
      scopeKind: "story",
      storyId: "story-1",
      worldlineId: "worldline-1",
    },
    events: [event],
    evidenceHead: { recordVersion: 1, ordinal: 0 },
  });
  const storyTwo = goalEvidenceSnapshotHash({
    definition: deterministicDefinition,
    instance: {
      ...base,
      scopeKind: "story",
      storyId: "story-2",
      worldlineId: "worldline-1",
    },
    events: [event],
    evidenceHead: { recordVersion: 1, ordinal: 0 },
  });
  const otherWorldline = goalEvidenceSnapshotHash({
    definition: deterministicDefinition,
    instance: {
      ...base,
      scopeKind: "worldline",
      worldlineId: "worldline-2",
    },
    events: [event],
    evidenceHead: { recordVersion: 1, ordinal: 0 },
  });
  assert.notEqual(storyOne, storyTwo);
  assert.notEqual(storyOne, otherWorldline);
  assert.notEqual(storyTwo, otherWorldline);
});
