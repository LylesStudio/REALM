import assert from "node:assert/strict";
import test from "node:test";
import { canonicalGoalJson, goalDefinitionHash, normalizeGoalDefinition, baseGoalDefinitionsHash,
  decodeGoalContentBinding, qualifyGoalContentBinding } from "../modules/goals/content-binding.ts";

// Explicit pure-model fixtures: these are not installed-package or database proofs.
export const definition = { goalKey: "arrival", policyVersion: "p1", mode: "deterministic" as const,
  visible: true, rubric: { kind: "event_count" as const, eventKind: "arrived", progressKey: "count", threshold: 1 }, outcome: { title: "抵达" } };
export const owner = { scopeKind: "record" as const, worldId: "world", worldlineId: "line", recordId: "record" };
export function binding(instanceId = "g1") {
  return { bindingVersion: 1 as const, workspaceId: "workspace", owner, instanceId, goalKey: definition.goalKey,
    policyVersion: definition.policyVersion, definitionHash: goalDefinitionHash(definition),
    normalization: "goal-definition-c14n-v1" as const, source: { sourceKind: "installed" as const,
      sourceWorldId: "world", sourceWorldVersion: "1.0.0", packageContentHash: "a".repeat(64), baseRevision: null, baseContentHash: null } };
}

test("canonical UTF-8 counting precedes allocation and rejects non-JSON/surrogates", () => {
  assert.equal(canonicalGoalJson({ z: "中😀", a: [2, 1] }), '{"a":[2,1],"z":"中😀"}');
  assert.equal(canonicalGoalJson("中", 5), '"中"');
  assert.throws(() => canonicalGoalJson("中", 4));
  for (const v of ["\ud800", "\udfff", { x: Infinity }, { x: undefined }, new Date(), { get x() { throw Error("getter called"); } }]) {
    assert.throws(() => canonicalGoalJson(v));
  }
  const cycle: unknown[] = []; cycle.push(cycle); assert.throws(() => canonicalGoalJson(cycle));
});
test("definition normalization uses production decoding and distinguishes rubric, policy and omission", () => {
  assert.deepEqual(normalizeGoalDefinition(definition), definition);
  const explicit = { ...definition, terminals: ["settled", "completed"], retryable: false };
  assert.deepEqual(normalizeGoalDefinition(explicit), explicit);
  assert.equal(canonicalGoalJson(normalizeGoalDefinition(explicit)), canonicalGoalJson(explicit));
  assert.notEqual(goalDefinitionHash(definition), goalDefinitionHash({ ...definition, policyVersion: "p2" }));
  assert.notEqual(goalDefinitionHash(definition), goalDefinitionHash({ ...definition, rubric: { ...definition.rubric, threshold: 2 } }));
  assert.notEqual(goalDefinitionHash(definition), goalDefinitionHash({ ...definition, retryable: false }));
  assert.notEqual(goalDefinitionHash({ ...definition, terminals: ["completed", "failed"] }), goalDefinitionHash({ ...definition, terminals: ["failed", "completed"] }));
  assert.throws(() => normalizeGoalDefinition({ ...definition, extra: true }));
  assert.throws(() => normalizeGoalDefinition({ ...definition, goalKey: " arrival " }));
  assert.throws(() => normalizeGoalDefinition({ ...definition, terminals: ["completed", "completed"] }));
  assert.throws(() => baseGoalDefinitionsHash([definition, definition]));
  assert.equal(baseGoalDefinitionsHash([definition, { ...definition, goalKey: "z" }]), baseGoalDefinitionsHash([{ ...definition, goalKey: "z" }, definition]));
});
test("binding invariants and explicit trusted evidence do not turn digest equality into trust", () => {
  const b = binding(); assert.deepEqual(decodeGoalContentBinding(b), b);
  assert.throws(() => decodeGoalContentBinding({ ...b, source: { ...b.source, sourceWorldId: "other" } }));
  assert.throws(() => decodeGoalContentBinding({ ...b, owner: { ...owner, storyId: "story" } }));
  assert.throws(() => decodeGoalContentBinding({ ...b, policyVersion: "other" }, definition));
  assert.deepEqual(qualifyGoalContentBinding(b), { kind: "UNRESOLVED_LEGACY", code: "GOAL_HISTORICAL_BINDING_UNRESOLVED" });
  assert.throws(() => qualifyGoalContentBinding(b, { kind: "legacy", binding: b, definition,
    proof: { algorithm: "fixture", immutableSourceId: "created", sourceSha256: "a".repeat(64) } }));
  const result = qualifyGoalContentBinding(b, { kind: "legacy", binding: b, definition,
    creation: { workspaceId: "workspace", owner, instanceId: "g1" },
    proof: { algorithm: "fixture-independent-proof", immutableSourceId: "creation-1", sourceSha256: "b".repeat(64) } });
  assert.equal(result.kind, "LEGACY_PROVABLE");
  const fresh = qualifyGoalContentBinding(b, { kind: "new", binding: b, definition });
  assert.equal(fresh.kind, "NEW_BOUND");
  b.source.packageContentHash = "c".repeat(64);
  if (fresh.kind === "NEW_BOUND") assert.equal(fresh.binding.source.packageContentHash, "a".repeat(64));
});
