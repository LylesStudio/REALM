import assert from "node:assert/strict";
import test from "node:test";
import { goalDefinitionHash } from "../modules/goals/content-binding.ts";
import { createRecordGoalDefinition, planRecordGoalSuccessor, rebaseRecordGoalDefinitions, type RecordGoalDefinitionVersion } from "../modules/goals/record-authoring.ts";
import { goalEvidenceSnapshotHash } from "../modules/goals/public.ts";
import { decodeRealmRuntimeSaveGoalsV2, serializeRealmRuntimeSaveGoalsV2, parseRealmRuntimeSaveGoalsV2,
  goalInstancesParentFirst, remapRealmRuntimeSaveGoalsV2, type GoalInstanceV2, type RealmRuntimeSaveGoalsV2,
  type GoalIdentityMapping } from "../modules/world-transfer/realm-runtime-goals-v2.ts";

// Source-independent fixtures only; no archive, transport, PG or package verification claimed.
const definition = { goalKey: "arrival", policyVersion: "p1", mode: "deterministic" as const, visible: true,
  rubric: { kind: "event_count" as const, eventKind: "arrived", progressKey: "count", threshold: 1 }, outcome: {} };
const record = { scopeKind: "record" as const, worldId: "world", worldlineId: "line", recordId: "record" };
function instance(id = "g1", owner: GoalInstanceV2["ref"]["owner"] = record): GoalInstanceV2 {
  return { ref: { owner, instanceId: id }, goalKey: "arrival", policyVersion: "p1", state: "active", revision: 0,
    progress: { prose: "g1" }, outcome: null, attempt: 1, predecessor: null, resolutionKind: "natural", evidenceStart: null,
    definition: { kind: "content", binding: { bindingVersion: 1, workspaceId: "workspace", owner, instanceId: id,
      goalKey: "arrival", policyVersion: "p1", definitionHash: goalDefinitionHash(definition), normalization: "goal-definition-c14n-v1",
      source: { sourceKind: "installed", sourceWorldId: "world", sourceWorldVersion: "1.0.0", packageContentHash: "a".repeat(64), baseRevision: null, baseContentHash: null } } } };
}
function document(): RealmRuntimeSaveGoalsV2 {
  return { format: "realm-runtime-goals", schemaVersion: 2, workspaceId: "workspace", roots: [{ owner: record, instances: [instance()] }], definitions: [], assessments: [] };
}
test("actual V2 decoder/serializer detach input, preserve metadata and enforce exact keys/version/bounds", () => {
  const source = document(); const normalized = decodeRealmRuntimeSaveGoalsV2(source);
  (source.roots[0].instances[0].progress as Record<string, string>).prose = "mutated";
  assert.equal(normalized.roots[0].instances[0].progress.prose, "g1");
  const bytes = serializeRealmRuntimeSaveGoalsV2(normalized);
  assert.deepEqual(parseRealmRuntimeSaveGoalsV2(bytes), normalized);
  assert.throws(() => parseRealmRuntimeSaveGoalsV2(new Uint8Array([0xff])));
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...source, extra: true }));
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...source, schemaVersion: 1 }));
  assert.throws(() => serializeRealmRuntimeSaveGoalsV2(source, 10));
});
test("same key in different typed owners is valid, duplicate roots/families/active state reject", () => {
  const d = document(); const story = { scopeKind: "story" as const, worldId: "world", worldlineId: "line", storyId: "story" };
  const line = { scopeKind: "worldline" as const, worldId: "world", worldlineId: "line" };
  assert.equal(decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [...d.roots, { owner: story, instances: [instance("g2", story)] }, { owner: line, instances: [instance("g3", line)] }] }).roots.length, 3);
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [...d.roots, d.roots[0]] }));
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner: record, instances: [instance(), instance("g2")] }] }));
});
test("global graph handles reversed input, rejects dangling/cross-owner/cycle and illegal terminals", () => {
  const first = { ...instance(), state: "completed" as const };
  const second = { ...instance("g2"), attempt: 2, predecessor: { kind: "retry" as const, ref: first.ref } };
  const d = { ...document(), roots: [{ owner: record, instances: [second, first] }] };
  assert.deepEqual(goalInstancesParentFirst(d).map(x => x.ref.instanceId), ["g1", "g2"]);
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner: record, instances: [second] }] }));
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner: record, instances: [second, { ...first, resolutionKind: "withdrawn" }] }] }));
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner: record, instances: [second, { ...first, state: "active" }] }] }));
  const other = { ...record, recordId: "other" }; const foreign = instance("g3", other);
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner: record, instances: [{ ...second, predecessor: { kind: "retry", ref: foreign.ref } }] }, { owner: other, instances: [foreign] }] }));
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner: record, instances: [{ ...first, predecessor: { kind: "retry", ref: second.ref } }, second] }] }));
});
test("assessment rejects scoped owners and validates the full event tuple before remapping", () => {
  const d = document(); const event = { worldId: "world", worldlineId: "line", recordId: "record", eventId: "event" };
  const assessment = { id: "assessment", goal: d.roots[0].instances[0].ref, sourceEvent: event, source: "deterministic", status: "accepted", result: {}, evidenceEvents: [event], evidenceHead: null, evidenceSnapshotHash: "a".repeat(64), policyVersion: "p1" };
  assert.equal(decodeRealmRuntimeSaveGoalsV2({ ...d, assessments: [assessment] }).assessments.length, 1);
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, assessments: [{ ...assessment, sourceEvent: { ...event, worldlineId: "foreign" } }] }));
  const owner = { scopeKind: "story" as const, worldId: "world", worldlineId: "line", storyId: "story" }; const g = instance("g2", owner);
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner, instances: [g] }], assessments: [{ ...assessment, goal: g.ref }] }), { code: "GOAL_SCOPED_ASSESSMENT_UNSUPPORTED" });
});
test("explicit typed remap is reverse-order independent and rejects missing/colliding mappings", () => {
  const d = document(); const target = { ...record, worldlineId: "target-line", recordId: "target-record" };
  const mappings: GoalIdentityMapping[] = [
    { entityKind: "instance", source: { workspaceId: "workspace", owner: record, id: "g1" }, target: { workspaceId: "target", owner: target, id: "target-g" } },
    { entityKind: "record", source: { workspaceId: "workspace", owner: record, id: "record" }, target: { workspaceId: "target", owner: target, id: "target-record" } },
    { entityKind: "worldline", source: { workspaceId: "workspace", owner: { scopeKind: "worldline", worldId: "world", worldlineId: "line" }, id: "line" }, target: { workspaceId: "target", owner: { scopeKind: "worldline", worldId: "world", worldlineId: "target-line" }, id: "target-line" } },
  ];
  const remapped = remapRealmRuntimeSaveGoalsV2(d, { workspaceId: "target", mappings });
  assert.equal(remapped.roots[0].instances[0].ref.instanceId, "target-g");
  assert.deepEqual(remapped.roots[0].instances[0].progress, { prose: "g1" });
  assert.deepEqual(remapped, remapRealmRuntimeSaveGoalsV2(d, { workspaceId: "target", mappings: [...mappings].reverse() }));
  const sourceBinding = d.roots[0].instances[0].definition; const targetBinding = remapped.roots[0].instances[0].definition;
  if (sourceBinding.kind === "content" && targetBinding.kind === "content") assert.deepEqual(sourceBinding.binding.source, targetBinding.binding.source);
  assert.throws(() => remapRealmRuntimeSaveGoalsV2(d, { workspaceId: "target", mappings: mappings.slice(1) }));
  assert.throws(() => remapRealmRuntimeSaveGoalsV2(d, { workspaceId: "target", mappings: [...mappings, mappings[0]] }));
});

test("trusted definition checks enforce retryability and natural terminal allowlists", () => {
  const first = { ...instance(), state: "completed" as const };
  const second = { ...instance("g2"), attempt: 2, predecessor: { kind: "retry" as const, ref: first.ref } };
  const d = { ...document(), roots: [{ owner: record, instances: [second, first] }] };
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2(d, { contentDefinition: () => definition }));
  const retryable = { ...definition, retryable: true, terminals: ["completed" as const] };
  const bind = (g: GoalInstanceV2): GoalInstanceV2 => ({ ...g, definition: { kind: "content", binding: { ...(g.definition as Extract<GoalInstanceV2["definition"], {kind: "content"}>).binding, definitionHash: goalDefinitionHash(retryable) } } });
  const allowed = { ...document(), roots: [{ owner: record, instances: [bind(second), bind(first)] }] };
  assert.equal(decodeRealmRuntimeSaveGoalsV2(allowed, { contentDefinition: () => retryable }).roots[0].instances.length, 2);
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...allowed, roots: [{ owner: record, instances: [bind(second), { ...bind(first), state: "failed" }] }] }, { contentDefinition: () => retryable }));
});

test("real authored definitions preserve revision versus attempt and rebase through production API", () => {
  const scope = { workspaceId: "workspace", worldId: "world", worldlineId: "line", recordId: "record" };
  const draft = { title: "交接", description: "完成交接", successConditions: ["找到接头人"], failureConditions: [], settlementConditions: [], changePolicy: "evolving", visible: true };
  const first = createRecordGoalDefinition({ scope, goalId: "authored", draft, activationHead: { recordVersion: 1, ordinal: 1 } });
  const event = { eventId: "event", recordId: "record", recordVersion: 2, ordinal: 2, kind: "narration.committed", payload: { text: "交接成功" } };
  const next = planRecordGoalSuccessor({ previous: first, scope, instance: { goalInstanceId: first.goalInstanceId, recordId: "record", state: "completed", resolutionKind: "natural", revision: 1, progress: {}, outcome: {} }, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
    nextDraft: { ...draft, title: "新阶段" }, reason: "阶段完成", evidenceEventIds: ["event"], events: [event], observedHead: { recordVersion: 2, ordinal: 2 } }).definition;
  function authored(d: RecordGoalDefinitionVersion): GoalInstanceV2 { return { ...instance(d.goalInstanceId), goalKey: d.goalKey, policyVersion: d.policyVersion, evidenceStart: d.activationHead,
    definition: { kind: "record", definitionId: d.definitionId, goalId: d.goalId, definitionVersion: d.definitionVersion } }; }
  const a = { ...authored(first), state: "completed" as const }; const b = { ...authored(next), predecessor: { kind: "definition-revision" as const, ref: a.ref } };
  const d = { ...document(), definitions: [next, first], roots: [{ owner: record, instances: [b, a] }] };
  assert.deepEqual(goalInstancesParentFirst(d).map(g => g.ref.instanceId), [a.ref.instanceId, b.ref.instanceId]);
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner: record, instances: [{ ...b, attempt: 2 }, a] }] }));
  assert.throws(() => decodeRealmRuntimeSaveGoalsV2({ ...d, roots: [{ owner: record, instances: [{ ...b, predecessor: { kind: "retry", ref: a.ref } }, a] }] }));
  const target = { ...scope, workspaceId: "target", worldlineId: "target-line", recordId: "target-record" };
  const targetOwner = { ...record, worldlineId: target.worldlineId, recordId: target.recordId };
  const rebased = rebaseRecordGoalDefinitions({ definitions: [next, first], scope: target, eventIds: new Map([["event", "target-event"]]) });
  const mappings: GoalIdentityMapping[] = [
    { entityKind: "worldline", source: { workspaceId: "workspace", owner: { scopeKind: "worldline", worldId: "world", worldlineId: "line" }, id: "line" }, target: { workspaceId: "target", owner: { scopeKind: "worldline", worldId: "world", worldlineId: "target-line" }, id: "target-line" } },
    { entityKind: "record", source: { workspaceId: "workspace", owner: record, id: "record" }, target: { workspaceId: "target", owner: targetOwner, id: "target-record" } },
    { entityKind: "event", source: { workspaceId: "workspace", owner: record, id: "event" }, target: { workspaceId: "target", owner: targetOwner, id: "target-event" } },
  ];
  for (const source of [first, next]) {
    const t = rebased.find(d => d.definitionVersion === source.definitionVersion)!;
    mappings.push({ entityKind: "definition", source: { workspaceId: "workspace", owner: record, id: source.definitionId }, target: { workspaceId: "target", owner: targetOwner, id: t.definitionId } },
      { entityKind: "instance", source: { workspaceId: "workspace", owner: record, id: source.goalInstanceId }, target: { workspaceId: "target", owner: targetOwner, id: t.goalInstanceId } });
  }
  const result = remapRealmRuntimeSaveGoalsV2(d, { workspaceId: "target", mappings: [...mappings].reverse() });
  assert.deepEqual(result.definitions.map(d => d.definitionId).sort(), rebased.map(d => d.definitionId).sort());
  assert.deepEqual(result.roots[0].instances[0].progress, { prose: "g1" });
});

test("assessment remap validates source hash before rehashing and preserves ID-shaped custom data", () => {
  const d = document(); const g = d.roots[0].instances[0];
  const event = { eventId: "event", recordId: "record", recordVersion: 1, ordinal: 1, kind: "arrived", payload: { prose: "g1" } };
  const hash = goalEvidenceSnapshotHash({ definition, instance: { ...g, goalInstanceId: "g1", recordId: "record" }, events: [event], evidenceHead: { recordVersion: 1, ordinal: 1 } });
  const e = { worldId: "world", worldlineId: "line", recordId: "record", eventId: "event" };
  const a = { id: "assessment", goal: g.ref, sourceEvent: e, source: "deterministic" as const, status: "accepted" as const, result: { policyVersion: "p1", evidenceSnapshotHash: hash, evidenceEventIds: ["event"], custom: { goalInstanceId: "g1" } }, evidenceEvents: [e], evidenceHead: { recordVersion: 1, ordinal: 1 }, evidenceSnapshotHash: hash, policyVersion: "p1" };
  const withAssessment = { ...d, assessments: [a] }; const target = { ...record, worldlineId: "target-line", recordId: "target-record" };
  const mappings: GoalIdentityMapping[] = [
    { entityKind: "worldline", source: { workspaceId: "workspace", owner: { scopeKind: "worldline", worldId: "world", worldlineId: "line" }, id: "line" }, target: { workspaceId: "target", owner: { scopeKind: "worldline", worldId: "world", worldlineId: "target-line" }, id: "target-line" } },
    { entityKind: "record", source: { workspaceId: "workspace", owner: record, id: "record" }, target: { workspaceId: "target", owner: target, id: "target-record" } },
    ...(["instance", "event", "assessment"] as const).map((kind, i) => ({ entityKind: kind, source: { workspaceId: "workspace", owner: record, id: ["g1", "event", "assessment"][i] }, target: { workspaceId: "target", owner: target, id: ["target-g", "target-event", "target-assessment"][i] } })),
  ];
  assert.throws(() => remapRealmRuntimeSaveGoalsV2(withAssessment, { workspaceId: "target", mappings }), { code: "GOAL_HISTORICAL_BINDING_UNRESOLVED" });
  const input = { workspaceId: "target", mappings, assessmentEvidence: () => ({ definition, events: [event] }) };
  const result = remapRealmRuntimeSaveGoalsV2(withAssessment, input);
  assert.notEqual(result.assessments[0].evidenceSnapshotHash, hash);
  assert.equal(result.assessments[0].evidenceSnapshotHash, result.assessments[0].result.evidenceSnapshotHash);
  assert.deepEqual(result.assessments[0].result.custom, { goalInstanceId: "g1" });
  assert.throws(() => remapRealmRuntimeSaveGoalsV2({ ...withAssessment, assessments: [{ ...a, evidenceSnapshotHash: "b".repeat(64) }] }, input));
  assert.throws(() => remapRealmRuntimeSaveGoalsV2(withAssessment, { ...input, assessmentEvidence: () => ({ definition, events: [{ ...event, payload: { prose: "tampered" } }] }) }));
  assert.throws(() => remapRealmRuntimeSaveGoalsV2(withAssessment, { ...input, mappings: [...mappings, { ...mappings[2], source: { ...mappings[2].source, id: "other-g" } }] }));
});
