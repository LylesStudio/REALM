import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { evidenceHash } from "../modules/application/committed-fact-command.ts";
import { normalizePerformanceEvidenceSnapshot, performanceEvidenceSnapshotCanonical, performanceEvidenceSnapshotHash } from "../modules/application/performance-evidence-snapshot.ts";

// Explicit pure model fixture; no database visibility or transport attestation.
export function snapshotFixture() {
  const header = { id: "event", sceneId: "scene", visibilityPolicyId: "policy", policyVersion: "1", policyKind: "private", recordVersion: "9007199254740993", recordOrdinal: "1", worldTick: "2", worldOrdinal: "1" };
  return { version: 1, scope: { workspaceId: "ws", worldId: "world", worldlineId: "line", recordId: "record" }, commandId: "command", assessmentId: "command:assessment", requestFingerprint: "a".repeat(64), policyVersion: "structured-factors:v1", admission: { principalId: "actor", role: "owner", evidencePolicyId: "approved-fixture", evidenceMode: "engine-authoritative-v1" }, binding: { storyId: "story", worldVersion: "1.0" }, head: { recordVersion: "9007199254740993", nextRecordOrdinal: "2", lastEventId: "event", lastWorldTick: "2", lastWorldOrdinal: "1", effectiveTick: "2", effectiveOrdinal: "1" }, worldlineHead: { tick: "3", ordinal: "0" }, currentScene: { id: "scene", startTick: "0", startOrdinal: "0", status: "active" }, headEvent: { ...header }, evidence: [{ ...header, sceneStartTick: "0", sceneStartOrdinal: "0" }], factors: { evidenceCount: 1, milestoneCompleted: false, score: 10 }, milestoneWitness: null };
}

test("strict snapshot preserves bigint decimal strings and isolates mutation", () => {
  const input = snapshotFixture();
  const snapshot = normalizePerformanceEvidenceSnapshot(input);
  assert.equal(snapshot.head.recordVersion, "9007199254740993");
  assert.deepEqual(JSON.parse(performanceEvidenceSnapshotCanonical(snapshot)), snapshot);
  input.evidence[0].id = "changed";
  assert.equal(snapshot.evidence[0].id, "event");
  assert.match(performanceEvidenceSnapshotHash(snapshot), /^[0-9a-f]{64}$/);
  assert.equal(performanceEvidenceSnapshotHash(snapshot), createHash("sha256").update("performance-evidence-snapshot:v1\0").update(performanceEvidenceSnapshotCanonical(snapshot)).digest("hex"));
});

test("exact shape, bounds, decimal and source text refusal", () => {
  for (const mutate of [
    (x: ReturnType<typeof snapshotFixture>) => { Reflect.set(x, "sourceText", "secret"); },
    (x: ReturnType<typeof snapshotFixture>) => { x.evidence = []; },
    (x: ReturnType<typeof snapshotFixture>) => { x.evidence = Array(33).fill(x.evidence[0]); },
    (x: ReturnType<typeof snapshotFixture>) => { x.head.recordVersion = "01"; },
    (x: ReturnType<typeof snapshotFixture>) => { Reflect.set(x.head, "recordVersion", Number("9007199254740993")); },
    (x: ReturnType<typeof snapshotFixture>) => { x.binding.storyId = "界".repeat(342); },
    (x: ReturnType<typeof snapshotFixture>) => { x.binding.storyId = "\ud800"; },
    (x: ReturnType<typeof snapshotFixture>) => { x.factors.score = 99; },
    (x: ReturnType<typeof snapshotFixture>) => { x.evidence[0].worldTick = "4"; },
    (x: ReturnType<typeof snapshotFixture>) => { Reflect.set(x, "currentScene", undefined); },
  ]) {
    const x = snapshotFixture(); mutate(x);
    assert.throws(() => normalizePerformanceEvidenceSnapshot(x));
  }
});

test("all captured historical bindings affect the new digest", () => {
  const base = snapshotFixture(), hash = performanceEvidenceSnapshotHash(base);
  for (const mutate of [
    (x: ReturnType<typeof snapshotFixture>) => { x.binding.worldVersion = "2.0"; },
    (x: ReturnType<typeof snapshotFixture>) => { x.admission.principalId = "other"; },
    (x: ReturnType<typeof snapshotFixture>) => { x.admission.role = "player"; },
    (x: ReturnType<typeof snapshotFixture>) => { x.worldlineHead.tick = "4"; },
    (x: ReturnType<typeof snapshotFixture>) => { x.currentScene.id = "another"; },
    // One Event/policy repeated in multiple roles must change consistently.
    (x: ReturnType<typeof snapshotFixture>) => { x.evidence[0].policyVersion = "2"; x.headEvent.policyVersion = "2"; },
    (x: ReturnType<typeof snapshotFixture>) => { x.head.recordVersion = "9007199254740994"; x.headEvent.recordVersion = "9007199254740994"; x.evidence[0].recordVersion = "9007199254740994"; },
    (x: ReturnType<typeof snapshotFixture>) => { x.factors = { evidenceCount: 1, milestoneCompleted: true, score: 30 }; Reflect.set(x, "milestoneWitness", { id: "milestone", projectId: "project", completionRecordId: "record", completionEventId: "event", completionHeader: { ...x.evidence[0] } }); },
  ]) { const x = structuredClone(base); mutate(x); assert.notEqual(performanceEvidenceSnapshotHash(x), hash); assert.equal(evidenceHash(x.evidence.map(e => e.id)), evidenceHash(base.evidence.map(e => e.id))); }
});

test("32 evidence boundary, identity UTF-8 boundary and canonical escaping budget", () => {
  const x = snapshotFixture();
  x.evidence = Array.from({ length: 32 }, (_, i) => ({ ...x.evidence[0], id: `event${String(i).padStart(2, "0")}` }));
  x.factors.evidenceCount = 32; x.factors.score = 320;
  x.binding.storyId = "界".repeat(341) + "a";
  assert.equal(Buffer.byteLength(x.binding.storyId, "utf8"), 1024);
  assert.equal(normalizePerformanceEvidenceSnapshot(x).evidence.length, 32);
  const duplicate = structuredClone(x); duplicate.evidence[1].id = duplicate.evidence[0].id;
  assert.throws(() => normalizePerformanceEvidenceSnapshot(duplicate));
  for (const e of x.evidence) { e.sceneId = "\u0001".repeat(1024); e.visibilityPolicyId = "\u0002".repeat(1024); }
  assert.throws(() => normalizePerformanceEvidenceSnapshot(x), /snapshot is invalid/);
});
