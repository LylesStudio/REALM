/** Focused source-side transport protocol. No PG or successful witness restore claim. */
import assert from "node:assert/strict";
import test from "node:test";
import { readPerformanceEvidenceSource, PERFORMANCE_EVIDENCE_SOURCE_SQL } from "../database/postgres/performance-evidence-transport-repository.ts";
import { committedFactRequestFingerprintFor, evidenceHash } from "../modules/application/committed-fact-command.ts";
import { performanceEvidenceSnapshotCanonical, performanceEvidenceSnapshotHash, type PerformanceEvidenceSnapshotV1 } from "../modules/application/performance-evidence-snapshot.ts";

function fixture() {
  const scope = { workspaceId: "source-workspace", worldId: "world", worldlineId: "line" };
  const request = { command: "performance.assessed", recordId: "record", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["event"] };
  const requestFingerprint = committedFactRequestFingerprintFor(scope, request);
  const header = { id: "event", sceneId: "scene", visibilityPolicyId: "policy", policyVersion: "1", policyKind: "private", recordVersion: "1", recordOrdinal: "1", worldTick: "2", worldOrdinal: "1" };
  const snapshot: PerformanceEvidenceSnapshotV1 = {
    version: 1, scope: { ...scope, recordId: "record" }, commandId: "command", assessmentId: "command:assessment", requestFingerprint,
    policyVersion: "structured-factors:v1", admission: { principalId: "historical-principal", role: "player", evidencePolicyId: "approved-fixture", evidenceMode: "engine-authoritative-v1" },
    binding: { storyId: "story", worldVersion: "1.0" },
    head: { recordVersion: "1", nextRecordOrdinal: "2", lastEventId: "event", lastWorldTick: "2", lastWorldOrdinal: "1", effectiveTick: "2", effectiveOrdinal: "1" },
    worldlineHead: { tick: "3", ordinal: "0" }, currentScene: { id: "scene", startTick: "0", startOrdinal: "0", status: "active" },
    headEvent: header, evidence: [{ ...header, sceneStartTick: "0", sceneStartOrdinal: "0" }],
    factors: { evidenceCount: 1, milestoneCompleted: false, score: 10 }, milestoneWitness: null,
  };
  const manifestHash = performanceEvidenceSnapshotHash(snapshot), hash = evidenceHash(request.evidenceEventIds);
  const result = { status: "committed", commandId: "command", assessmentId: "command:assessment", score: 10, evidenceSnapshotHash: hash, goalTransition: null };
  const row = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId,
    id: "command", request_fingerprint: requestFingerprint, kind: "performance_assessed" as const, receipt_oversized: false,
    result_manifest: { request, result, performanceWitness: { version: 1, manifestHash } } };
  const sidecar = { record_id: "record", assessment_id: "command:assessment", command_id: "command", version: 1,
    manifest_canonical: performanceEvidenceSnapshotCanonical(snapshot), manifest_hash: manifestHash,
    policy_version: "structured-factors:v1", score: 10, evidence_event_ids: ["event"], evidence_snapshot_hash: hash,
    assessment_record_id: "record", assessment_command_id: "command" };
  const calls: { sql: string; values: unknown[] }[] = [];
  let rows: (typeof sidecar)[] = [sidecar];
  const client = { async query(sql: string, values: unknown[]) {
    assert.equal(sql, PERFORMANCE_EVIDENCE_SOURCE_SQL, "unknown SQL remains forbidden");
    assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId, "record", "command", "command:assessment"]);
    calls.push({ sql, values }); return { rows: structuredClone(rows), rowCount: rows.length };
  } };
  return { scope, row, sidecar, snapshot, calls, client, setRows(value: typeof rows) { rows = value; } };
}

test("source SQL binds the complete tuple and caps canonical bytes before returning them", async () => {
  const f = fixture(), before = structuredClone(f.row);
  const source = await readPerformanceEvidenceSource(f.client as never, f.scope, f.row);
  assert.ok(source);
  assert.deepEqual(source.snapshot, f.snapshot);
  assert.deepEqual(source.receipt.request, f.row.result_manifest.request);
  assert.equal(source.receipt.witness.manifestCanonical, f.sidecar.manifest_canonical);
  assert.equal(source.snapshot.admission.principalId, "historical-principal");
  assert.equal(source.snapshot.admission.role, "player");
  assert.equal(source.snapshot.worldlineHead.tick, "3", "historical capture is retained, never replaced by a target head");
  assert.equal(f.calls.length, 1);
  assert.match(PERFORMANCE_EVIDENCE_SOURCE_SQL, /snapshot.record_id = \$4 AND snapshot.command_id = \$5 AND snapshot.assessment_id = \$6/);
  assert.match(PERFORMANCE_EVIDENCE_SOURCE_SQL, /octet_length\(snapshot.manifest_canonical\) <= 262144/);
  assert.deepEqual(f.row, before);
  f.row.result_manifest.request.evidenceEventIds[0] = "caller-change";
  assert.deepEqual(source.receipt.request.evidenceEventIds, ["event"], "returned source request is detached");
});

test("each raw request/result/assessment/witness must agree before transport can retain the source", async () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => { f.row.result_manifest.request.score = 11; },
    f => { f.row.result_manifest.result.score = 11; },
    f => { f.sidecar.score = 11; },
    f => { f.sidecar.manifest_canonical = f.sidecar.manifest_canonical.replace('historical-principal', 'other-principal'); },
    f => { f.sidecar.assessment_record_id = "other-record"; },
    f => { f.sidecar.assessment_command_id = "other-command"; },
    f => { f.sidecar.record_id = "other-record"; },
    f => { f.sidecar.command_id = "other-command"; },
    f => { f.sidecar.version = 2; },
    f => { f.sidecar.evidence_snapshot_hash = "0".repeat(64); },
    f => { f.row.request_fingerprint = "0".repeat(64); },
  ];
  for (const change of changes) {
    const f = fixture(); change(f);
    await assert.rejects(readPerformanceEvidenceSource(f.client as never, f.scope, f.row), { code: "PERFORMANCE_WITNESS_INVALID" });
  }
});

test("missing, duplicate or oversized sidecar fails closed; no marker keeps the old path with no query", async () => {
  for (const count of [0, 2]) {
    const f = fixture(); f.setRows(Array.from({ length: count }, () => f.sidecar));
    await assert.rejects(readPerformanceEvidenceSource(f.client as never, f.scope, f.row), { code: "PERFORMANCE_WITNESS_INVALID" });
  }
  const oversized = fixture(); Object.assign(oversized.sidecar, { manifest_canonical: null });
  await assert.rejects(readPerformanceEvidenceSource(oversized.client as never, oversized.scope, oversized.row), { code: "PERFORMANCE_WITNESS_INVALID" });
  const legacy = fixture(); const envelope: Record<string, unknown> = { ...legacy.row.result_manifest };
  delete envelope.performanceWitness;
  assert.equal(await readPerformanceEvidenceSource(legacy.client as never, legacy.scope, { ...legacy.row, result_manifest: envelope }), null);
  assert.equal(legacy.calls.length, 0);
});

test("unknown marker versions and foreign scopes are rejected before SQL and private getters are not invoked", async () => {
  for (const version of [0, 2, 99]) {
    const f = fixture(); f.row.result_manifest.performanceWitness.version = version;
    await assert.rejects(readPerformanceEvidenceSource(f.client as never, f.scope, f.row), { code: "PERFORMANCE_WITNESS_INVALID" });
    assert.equal(f.calls.length, 0);
  }
  const foreign = fixture(); foreign.row.workspace_id = "foreign";
  await assert.rejects(readPerformanceEvidenceSource(foreign.client as never, foreign.scope, foreign.row), { code: "PERFORMANCE_WITNESS_INVALID" });
  assert.equal(foreign.calls.length, 0);
  const accessor = fixture(); let invoked = 0;
  Object.defineProperty(accessor.row.result_manifest, "request", { enumerable: true, get() { invoked++; throw Error("private getter"); } });
  await assert.rejects(readPerformanceEvidenceSource(accessor.client as never, accessor.scope, accessor.row), { code: "PERFORMANCE_WITNESS_INVALID" });
  assert.equal(invoked, 0); assert.equal(accessor.calls.length, 0);
});

test("source inputs are detached before awaiting the supplied transaction client", async () => {
  const f = fixture();
  const client = { async query(sql: string, values: unknown[]) {
    f.row.result_manifest.request.score = 999;
    f.row.result_manifest.result.score = 999;
    f.row.result_manifest.performanceWitness.manifestHash = "0".repeat(64);
    return f.client.query(sql, values);
  } };
  const source = await readPerformanceEvidenceSource(client as never, f.scope, f.row);
  assert.ok(source);
  assert.equal(source.receipt.request.score, 10);
  assert.equal(source.receipt.result.score, 10);
  assert.equal(source.snapshot.admission.principalId, "historical-principal");
});
