import assert from "node:assert/strict";
import test from "node:test";
import * as authoring from "../modules/goals/record-authoring.ts";
import { projectGoal } from "../modules/goals/projection.ts";
import { goalInstanceIdFor } from "../modules/goals/public.ts";

const scope = { workspaceId: "workspace-test", worldId: "world-test", worldlineId: "line-test", recordId: "record-test" };
const draft = {
  title: "安全交接", description: "保管纸带，并让指定接头人收到它。",
  successConditions: ["纸带完整交到指定接头人手中"], failureConditions: ["纸带被夺走且无法取回"],
  settlementConditions: [], changePolicy: "fixed" as const, visible: true,
};

test("fixed definitions reject automatic evolution without mutating the original", () => {
  const definition = authoring.createRecordGoalDefinition({
    scope, goalId: "goal-test", draft, activationHead: { recordVersion: 2, ordinal: 4 },
  });
  const before = JSON.stringify(definition);
  assert.throws(() => authoring.planRecordGoalReplacement({
    previous: definition, scope, instance: {
      goalInstanceId: definition.goalInstanceId, recordId: scope.recordId,
      state: "active", revision: 1, progress: {}, outcome: null,
    },
    expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
    nextDraft: { ...draft, description: "前往新港口" }, reason: "码头关闭",
    evidenceEventIds: ["event-new"], events: [{
      eventId: "event-new", recordId: scope.recordId, recordVersion: 3,
      ordinal: 5, kind: "narration.committed", payload: { content: "码头关闭了" },
    }], observedHead: { recordVersion: 3, ordinal: 5 },
  }), { code: "GOAL_DEFINITION_FIXED" });
  assert.equal(JSON.stringify(definition), before);
});

function evolvingInput(): authoring.RecordGoalReplacementInput {
  const previous = authoring.createRecordGoalDefinition({
    scope, goalId: "goal-evolving", draft: { ...draft, changePolicy: "evolving" },
    activationHead: { recordVersion: 2, ordinal: 4 },
  });
  return {
    previous, scope, instance: {
      goalInstanceId: previous.goalInstanceId, recordId: scope.recordId, state: "active",
      revision: 3, progress: { summary: "抵达码头" }, outcome: null,
    }, expectedDefinitionVersion: 1, expectedInstanceRevision: 3,
    nextDraft: { ...draft, title: "改走北港", description: "码头已封闭，先到北港寻找新的交接点。", changePolicy: "evolving" },
    reason: "原码头已被正式封锁", evidenceEventIds: ["event-blockade"],
    events: [{ eventId: "event-blockade", recordId: scope.recordId, recordVersion: 3,
      ordinal: 5, kind: "narration.committed", payload: { content: "码头已经封锁。" } }],
    observedHead: { recordVersion: 3, ordinal: 5 },
  };
}

test("evolving replacement creates an immutable version and a new instance, not a retry", () => {
  const input = evolvingInput();
  const before = JSON.stringify(input.previous);
  const result = authoring.planRecordGoalReplacement(input);
  assert.equal(result.definition.definitionVersion, 2);
  assert.equal(result.definition.goalId, input.previous.goalId);
  assert.notEqual(result.definition.definitionId, input.previous.definitionId);
  assert.notEqual(result.definition.goalKey, input.previous.goalKey);
  assert.notEqual(result.definition.goalInstanceId, input.previous.goalInstanceId);
  assert.equal(result.definition.supersedesDefinitionId, input.previous.definitionId);
  assert.deepEqual(result.definition.basisEventIds, ["event-blockade"]);
  assert.equal(result.definition.changeReason, input.reason);
  assert.deepEqual(result.definition.activationHead, input.observedHead);
  assert.equal(result.previousTransition.resolutionKind, "superseded");
  assert.equal(result.previousTransition.to, "settled");
  assert.equal(result.previousTransition.revision, 4);
  assert.equal(result.instance.attempt, 1);
  assert.equal(result.instance.revision, 1);
  assert.equal(result.instance.state, "active");
  assert.deepEqual(result.instance.progress, {});
  assert.equal(result.instance.supersedesInstanceId, input.instance.goalInstanceId);
  assert.equal(JSON.stringify(input.previous), before);
  assert.ok(Object.isFrozen(result.definition.draft.successConditions));
  assert.ok(Object.isFrozen(result.definition));
});

test("a naturally completed evolving stage can have a successor without rewriting its terminal state or evidence", () => {
  const input = evolvingInput();
  input.instance = { ...input.instance, state: "completed", resolutionKind: "natural", outcome: { summary: "Original delivery completed" }, revision: 4 };
  input.expectedInstanceRevision = 4;
  input.observedHead = { recordVersion: 4, ordinal: 6 };
  const before = JSON.stringify(input);
  assert.equal(typeof authoring.planRecordGoalSuccessor, "function");
  const result = authoring.planRecordGoalSuccessor(input);
  assert.equal(result.previousTransition, null);
  assert.equal(result.instance.state, "active");
  assert.equal(result.instance.supersedesInstanceId, input.instance.goalInstanceId);
  assert.equal(result.definition.definitionVersion, 2);
  assert.equal(JSON.stringify(input), before);
  for (const resolutionKind of ["withdrawn", "superseded"] as const) {
    assert.throws(() => authoring.planRecordGoalSuccessor({ ...input, instance: { ...input.instance, state: "settled", resolutionKind } }),
      { code: "GOAL_SUCCESSOR_REQUIRES_NATURAL_TERMINAL" });
  }
});

test("automatic evolution cannot expose a previously hidden definition", () => {
  const input = evolvingInput();
  input.previous = authoring.createRecordGoalDefinition({
    scope, goalId: input.previous.goalId,
    draft: { ...draft, changePolicy: "evolving", visible: false },
    activationHead: input.previous.activationHead,
  });
  assert.throws(() => authoring.planRecordGoalReplacement(input),
    { code: "GOAL_VISIBILITY_CHANGE_REQUIRES_AUTHORIZATION" });
});

test("explicit null condition lists are invalid, not silently converted to empty lists", () => {
  for (const field of ["failureConditions", "settlementConditions"]) {
    assert.throws(() => authoring.normalizeRecordGoalDraft({ ...draft, [field]: null }),
      { code: "GOAL_DRAFT_INVALID" });
  }
});

test("fixed goals may be withdrawn without claiming a narrative settlement outcome", () => {
  const previous = authoring.createRecordGoalDefinition({
    scope, goalId: "fixed-withdraw", draft, activationHead: { recordVersion: 0, ordinal: 0 },
  });
  const instance = {
    goalInstanceId: previous.goalInstanceId, goalKey: previous.goalKey, recordId: scope.recordId,
    state: "active" as const, revision: 1, progress: {}, outcome: null,
  };
  const transition = authoring.planRecordGoalWithdrawal({
    previous, scope, instance, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
    reason: "玩家主动撤回此目标",
  });
  assert.equal(transition.to, "settled");
  assert.equal(transition.resolutionKind, "withdrawn");
  assert.equal(transition.revision, 2);
  const projection = projectGoal({ definition: previous, instance: {
    ...instance, state: "settled", resolutionKind: transition.resolutionKind,
  } });
  assert.equal(projection?.outcome, null);
});

test("authored projection exposes original text and capabilities, never private rubric or Judge fields", () => {
  const input = evolvingInput();
  const instance = { ...input.instance, goalKey: input.previous.goalKey,
    progress: { summary: "已经抵达码头", completedCriteria: [0], privateJudgeTrace: "SECRET", modelEndpoint: "SECRET" },
  };
  const projection = authoring.projectRecordAuthoredGoal({
    definition: input.previous, instance, managementAllowed: true,
  });
  assert.equal(projection?.title, draft.title);
  assert.equal(projection?.changePolicy, "evolving");
  assert.deepEqual(projection?.progress, { summary: "已经抵达码头", completedCriteria: [0] });
  assert.deepEqual(projection?.capabilities, { canRevise: true, canWithdraw: true });
  const serialized = JSON.stringify(projection);
  for (const forbidden of ["SECRET", "rubric", "basisEventIds", "policyVersion"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.deepEqual(authoring.projectRecordAuthoredGoal({
    definition: input.previous, instance, managementAllowed: false,
  })?.capabilities, { canRevise: false, canWithdraw: false });
  assert.equal(authoring.projectRecordAuthoredGoal({
    definition: { ...input.previous, visible: false }, instance, managementAllowed: true,
  }), null);
  assert.equal(authoring.projectRecordAuthoredGoal({
    definition: input.previous, instance: { ...instance, recordId: "record-other" }, managementAllowed: true,
  }), null);
  assert.equal(input.previous.goalInstanceId, goalInstanceIdFor(scope, input.previous.goalKey));
});

test("an authorized manual revision is distinct from fact-driven automatic evolution", () => {
  const input = evolvingInput();
  input.events = [];
  input.evidenceEventIds = [];
  input.observedHead = input.previous.activationHead;
  input.reason = "玩家明确修订交接条件";
  input.nextDraft = { ...draft, title: "保管纸带", changePolicy: "fixed" };
  const result = authoring.planRecordGoalRevision(input);
  assert.equal(result.definition.definitionVersion, 2);
  assert.equal(result.definition.changeKind, "manual");
  assert.equal(result.definition.draft.changePolicy, "fixed");
  assert.deepEqual(result.definition.basisEventIds, []);
  assert.equal(result.previousTransition.resolutionKind, "superseded");
  assert.throws(() => authoring.planRecordGoalReplacement(input), { code: "GOAL_CHANGE_POLICY_CONFLICT" });
});

test("fixed definitions reject manual revision as well as automatic evolution", () => {
  const input = evolvingInput();
  input.previous = authoring.createRecordGoalDefinition({ scope, goalId: "manual-fixed", draft,
    activationHead: input.previous.activationHead });
  input.instance = { ...input.instance, goalInstanceId: input.previous.goalInstanceId };
  input.events = [];
  input.evidenceEventIds = [];
  assert.throws(() => authoring.planRecordGoalRevision(input), { code: "GOAL_DEFINITION_FIXED" });
  assert.deepEqual(authoring.projectRecordAuthoredGoal({ definition: input.previous,
    instance: { ...input.instance, goalKey: input.previous.goalKey }, managementAllowed: true })?.capabilities,
    { canRevise: false, canWithdraw: true });
  assert.throws(() => authoring.planRecordGoalReplacement(input), { code: "GOAL_DEFINITION_FIXED" });
});

const fencedOperations: readonly [string, (input: authoring.RecordGoalReplacementInput) => void, string][] = [
  ["cross-workspace", (i) => { i.scope = { ...i.scope, workspaceId: "other" }; }, "GOAL_SCOPE_MISMATCH"],
  ["cross-world", (i) => { i.scope = { ...i.scope, worldId: "other" }; }, "GOAL_SCOPE_MISMATCH"],
  ["cross-worldline", (i) => { i.scope = { ...i.scope, worldlineId: "other" }; }, "GOAL_SCOPE_MISMATCH"],
  ["cross-record", (i) => { i.scope = { ...i.scope, recordId: "other" }; }, "GOAL_SCOPE_MISMATCH"],
  ["wrong instance", (i) => { i.instance = { ...i.instance, goalInstanceId: "other" }; }, "GOAL_SCOPE_MISMATCH"],
  ["wrong instance worldline", (i) => { i.instance = { ...i.instance, worldlineId: "other" }; }, "GOAL_SCOPE_MISMATCH"],
  ["stale definition", (i) => { i.expectedDefinitionVersion = 2; }, "GOAL_WRITE_CONFLICT"],
  ["stale instance", (i) => { i.expectedInstanceRevision = 2; }, "GOAL_WRITE_CONFLICT"],
  ["noninteger revision", (i) => { i.instance = { ...i.instance, revision: 1.5 }; i.expectedInstanceRevision = 1.5; }, "GOAL_WRITE_CONFLICT"],
  ["terminal instance", (i) => { i.instance = { ...i.instance, state: "completed" }; }, "GOAL_INSTANCE_TERMINAL"],
  ["invented evidence", (i) => { i.evidenceEventIds = ["invented"]; }, "GOAL_EVOLUTION_EVIDENCE_INVALID"],
  ["no evidence", (i) => { i.evidenceEventIds = []; }, "GOAL_EVOLUTION_EVIDENCE_INVALID"],
  ["duplicate evidence", (i) => { i.evidenceEventIds = ["event-blockade", "event-blockade"]; }, "GOAL_EVOLUTION_EVIDENCE_INVALID"],
  ["player wish", (i) => { i.events = i.events.map((event) => ({ ...event, kind: "utterance.committed" })); }, "GOAL_EVOLUTION_EVIDENCE_INVALID"],
  ["cross-record evidence", (i) => { i.events = i.events.map((event) => ({ ...event, recordId: "other" })); }, "GOAL_SCOPE_MISMATCH"],
  ["old evidence", (i) => { i.events = i.events.map((event) => ({ ...event, recordVersion: 2, ordinal: 4 })); }, "GOAL_EVOLUTION_EVIDENCE_INVALID"],
  ["future evidence", (i) => { i.observedHead = { recordVersion: 2, ordinal: 4 }; }, "GOAL_EVOLUTION_EVIDENCE_INVALID"],
];
for (const [name, mutate, code] of fencedOperations) {
  test(`replacement fences reject ${name}`, () => {
    const input = evolvingInput();
    mutate(input);
    assert.throws(() => authoring.planRecordGoalReplacement(input), { code });
  });
}

test("manual revision cannot move its activation cursor backwards", () => {
  const input = evolvingInput();
  input.events = [];
  input.evidenceEventIds = [];
  input.observedHead = { recordVersion: 1, ordinal: 2 };
  assert.throws(() => authoring.planRecordGoalRevision(input), { code: "GOAL_HEAD_INVALID" });
});

const invalidDrafts: readonly [string, Record<string, unknown>][] = [
  ["empty title", { title: "   " }],
  ["long title", { title: "x".repeat(161) }],
  ["no success criterion", { successConditions: [] }],
  ["blank criterion", { successConditions: [" "] }],
  ["duplicate criterion", { successConditions: ["same", "same"] }],
  ["too many criteria", { successConditions: Array.from({ length: 9 }, (_, i) => `criterion-${i}`) }],
  ["invalid policy", { changePolicy: "maybe" }],
  ["missing policy", { changePolicy: undefined }],
  ["invalid visibility", { visible: "true" }],
  ["client state", { state: "completed" }],
  ["client source", { source: "content" }],
  ["client score", { score: 100 }],
  ["client identity", { goalInstanceId: "forged" }],
  ["system override", { systemPrompt: "override" }],
];
for (const [name, patch] of invalidDrafts) {
  test(`draft admission rejects ${name}`, () => {
    assert.throws(() => authoring.normalizeRecordGoalDraft({ ...draft, ...patch }));
  });
}

test("definition identity is deterministic over normalized content and isolates all scope anchors", () => {
  const input = { scope, goalId: "identity-goal", draft, activationHead: { recordVersion: 0, ordinal: 0 } };
  const one = authoring.createRecordGoalDefinition(input);
  const replay = authoring.createRecordGoalDefinition({ ...input, scope: { ...scope, kind: "record" } });
  assert.deepEqual(replay, one);
  for (const field of ["workspaceId", "worldId", "worldlineId", "recordId"] as const) {
    const other = authoring.createRecordGoalDefinition({ ...input, scope: { ...scope, [field]: "other" } });
    assert.notEqual(other.definitionId, one.definitionId);
    assert.notEqual(other.goalInstanceId, one.goalInstanceId);
  }
  assert.equal(Object.isFrozen(draft), false, "normalization must not freeze the caller's draft");
});

test("stored definition decoder preserves canonical identity and rejects modified semantic content", () => {
  const input = evolvingInput();
  const versions = [input.previous, authoring.planRecordGoalReplacement(input).definition,
    authoring.planRecordGoalRevision({ ...input, events: [], evidenceEventIds: [] }).definition];
  for (const definition of versions) {
    const stored = JSON.parse(JSON.stringify(definition));
    assert.deepEqual(authoring.decodeRecordGoalDefinition(stored), definition);
    assert.throws(() => authoring.decodeRecordGoalDefinition({ ...stored,
      draft: { ...stored.draft, title: 'tampered' } }), { code: 'GOAL_DEFINITION_INVALID' });
    assert.throws(() => authoring.decodeRecordGoalDefinition({ ...stored,
      rubric: { kind: 'semantic', promptKey: 'untrusted' } }), { code: 'GOAL_DEFINITION_INVALID' });
    assert.throws(() => authoring.decodeRecordGoalDefinition({ ...stored, privateJudgeTrace: 'untrusted' }),
      { code: 'GOAL_DEFINITION_INVALID' });
  }
});
