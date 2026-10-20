/** Source consistency only: never source authenticity, database, or viewer authorization. */
import assert from "node:assert/strict";
import test from "node:test";
import { committedFactRequestFingerprintFor, evidenceHash } from "../modules/application/committed-fact-command.ts";
import { validatePerformanceEvidenceReceipt } from "../modules/application/performance-evidence-receipt.ts";
import { performanceEvidenceSnapshotCanonical, performanceEvidenceSnapshotHash, type PerformanceEvidenceSnapshotV1 } from "../modules/application/performance-evidence-snapshot.ts";

function sourceFixture() {
  const scope = { workspaceId: "ws", worldId: "world", worldlineId: "line" };
  const header = { id: "event", sceneId: "scene", visibilityPolicyId: "policy", policyVersion: "1", policyKind: "private", recordVersion: "9007199254740993", recordOrdinal: "1", worldTick: "2", worldOrdinal: "1" };
  const request = { command: "performance.assessed", recordId: "record", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["event"] };
  const fingerprint = committedFactRequestFingerprintFor(scope, request);
  const snapshot: PerformanceEvidenceSnapshotV1 = {
    version: 1, scope: { ...scope, recordId: "record" }, commandId: "command", assessmentId: "assessment", requestFingerprint: fingerprint,
    policyVersion: "structured-factors:v1", admission: { principalId: "historical-actor", role: "owner", evidencePolicyId: "approved-fixture", evidenceMode: "engine-authoritative-v1" },
    binding: { storyId: "story", worldVersion: "1.0" },
    head: { recordVersion: header.recordVersion, nextRecordOrdinal: "2", lastEventId: "event", lastWorldTick: "2", lastWorldOrdinal: "1", effectiveTick: "2", effectiveOrdinal: "1" },
    worldlineHead: { tick: "3", ordinal: "0" }, currentScene: { id: "scene", startTick: "0", startOrdinal: "0", status: "active" },
    headEvent: { ...header }, evidence: [{ ...header, sceneStartTick: "0", sceneStartOrdinal: "0" }],
    factors: { evidenceCount: 1, milestoneCompleted: false, score: 10 }, milestoneWitness: null,
  };
  const manifestHash = performanceEvidenceSnapshotHash(snapshot), evidenceSnapshotHash = evidenceHash(["event"]);
  return {
    scope, commandId: snapshot.commandId, requestFingerprint: fingerprint, request,
    result: { status: "committed", commandId: snapshot.commandId, assessmentId: snapshot.assessmentId, score: 10, evidenceSnapshotHash, goalTransition: null },
    marker: { version: 1, manifestHash },
    witness: { recordId: "record", assessmentId: snapshot.assessmentId, commandId: snapshot.commandId, version: 1, manifestCanonical: performanceEvidenceSnapshotCanonical(snapshot), manifestHash },
    assessment: { id: snapshot.assessmentId, recordId: "record", commandId: snapshot.commandId, policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["event"], evidenceSnapshotHash },
  };
}

test("valid source fact preserves exact historical bigint/admission data without sharing mutable input", () => {
  const input = sourceFixture(), source = JSON.parse(input.witness.manifestCanonical);
  const snapshot = validatePerformanceEvidenceReceipt(input);
  assert.deepEqual(snapshot, source);
  assert.equal(snapshot.head.recordVersion, "9007199254740993");
  assert.equal(snapshot.admission.principalId, "historical-actor");
  input.request.evidenceEventIds[0] = "changed";
  assert.equal(snapshot.evidence[0].id, "event");
  assert.equal(performanceEvidenceSnapshotCanonical(snapshot), input.witness.manifestCanonical);
});

test("every source tuple is checked before a caller can substitute target identities or recompute hashes", () => {
  const mutations: Array<(input: ReturnType<typeof sourceFixture>) => void> = [
    x => { x.scope.workspaceId = "foreign"; },
    x => { x.scope.worldId = "foreign"; },
    x => { x.scope.worldlineId = "foreign"; },
    x => { x.commandId = "foreign"; },
    x => { x.requestFingerprint = "0".repeat(64); },
    x => { x.request.command = "inventory.granted"; },
    x => { x.request.recordId = "foreign"; },
    x => { x.request.score = 99; },
    x => { x.request.evidenceEventIds = ["foreign"]; },
    x => { x.result.assessmentId = "foreign"; },
    x => { x.result.commandId = "foreign"; },
    x => { x.result.score = 99; },
    x => { x.result.evidenceSnapshotHash = "0".repeat(64); },
    x => { x.marker.version = 2; },
    x => { x.marker.manifestHash = "0".repeat(64); },
    x => { x.witness.recordId = "foreign"; },
    x => { x.witness.assessmentId = "foreign"; },
    x => { x.witness.commandId = "foreign"; },
    x => { x.witness.version = 2; },
    x => { x.witness.manifestCanonical = " " + x.witness.manifestCanonical; },
    x => { x.assessment.id = "foreign"; },
    x => { x.assessment.recordId = "foreign"; },
    x => { x.assessment.commandId = "foreign"; },
    x => { x.assessment.policyVersion = "other"; },
    x => { x.assessment.score = 99; },
    x => { x.assessment.evidenceEventIds = ["foreign"]; },
    x => { x.assessment.evidenceSnapshotHash = "0".repeat(64); },
    x => { Object.assign(x.request, { clientAuthority: true }); },
    x => { Object.assign(x.result, { privateSnapshot: x.witness.manifestCanonical }); },
  ];
  for (const mutate of mutations) {
    const input = sourceFixture(); mutate(input);
    assert.throws(() => validatePerformanceEvidenceReceipt(input), { code: "PERFORMANCE_WITNESS_INVALID" });
  }
});

test("exact data shape rejects accessors, sparse evidence, hidden fields and legacy without reading getters", () => {
  let calls = 0;
  const input = sourceFixture();
  Object.defineProperty(input.request, "score", { enumerable: true, get() { calls++; return 10; } });
  assert.throws(() => validatePerformanceEvidenceReceipt(input), { code: "PERFORMANCE_WITNESS_INVALID" });
  assert.equal(calls, 0);
  const sparse = sourceFixture(); sparse.request.evidenceEventIds = new Array(1);
  assert.throws(() => validatePerformanceEvidenceReceipt(sparse), { code: "PERFORMANCE_WITNESS_INVALID" });
  const hidden = sourceFixture(); Object.defineProperty(hidden.marker, "secret", { value: "not-transportable" });
  assert.throws(() => validatePerformanceEvidenceReceipt(hidden), { code: "PERFORMANCE_WITNESS_INVALID" });
  assert.throws(() => validatePerformanceEvidenceReceipt({ result: sourceFixture().result }), { code: "PERFORMANCE_WITNESS_INVALID" });
});
