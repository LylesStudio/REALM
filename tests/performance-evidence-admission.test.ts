/** Strict source-backed protocol model; no PostgreSQL, visibility or transport acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { performanceEvidenceSnapshotCanonical, performanceEvidenceSnapshotHash } from "../modules/application/performance-evidence-snapshot.ts";
import { executePerformanceAssessmentCommand, runAdmittedPerformanceCommand } from "../modules/application/performance-command-executor.ts";
import { PERFORMANCE_CAPTURE_SQL, PERFORMANCE_SNAPSHOT_READY_SQL, PerformanceAdmissionError } from "../database/postgres/performance-evidence-admission.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { createPostgresProjectFinanceCommandStore } from "../database/postgres/project-finance-command-repository.ts";
import { committedFactRequestFingerprintFor, evidenceHash, createCommittedFactCommandService } from "../modules/application/committed-fact-command.ts";
import { createProjectFinanceCommandService, PROJECT_FINANCE_COMMAND_POLICY_VERSION } from "../modules/application/project-finance-command.ts";

const scope = { workspaceId: "ws", worldId: "world", worldlineId: "line" };
const intent = { recordId: "record", policyVersion: "structured-factors:v1" as const, evidenceEventIds: ["event"], idempotencyKey: "key" };
const trust = { scope, principalId: "actor", evidencePolicy: { mode: "engine-authoritative-v1" as const, policyId: "approved-fixture" }, enablement: { schema: true, durableTransport: true } };
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
const RECEIPT_SQL = norm(`SELECT command.workspace_id, command.world_id, command.worldline_id, command.id,
  command.request_fingerprint, command.kind,
  CASE WHEN octet_length(command.result_manifest::text) <= $5 THEN command.result_manifest ELSE NULL END AS result_manifest,
  octet_length(command.result_manifest::text) > $5 AS receipt_oversized,
  CASE WHEN anchor.id IS NULL THEN NULL ELSE jsonb_build_object(
  'workspace_id', anchor.workspace_id, 'world_id', anchor.world_id, 'worldline_id', anchor.worldline_id,
  'id', anchor.id, 'request_fingerprint', anchor.request_fingerprint, 'kind', anchor.kind,
  'result_manifest', CASE WHEN octet_length(anchor.result_manifest::text) <= $5 THEN anchor.result_manifest ELSE NULL END,
  'receipt_oversized', octet_length(anchor.result_manifest::text) > $5) END AS anchor_row
  FROM committed_fact_commands AS command LEFT JOIN committed_fact_commands AS anchor
  ON anchor.workspace_id = command.workspace_id AND anchor.world_id = command.world_id AND anchor.worldline_id = command.worldline_id
  AND anchor.id = command.result_manifest #>> '{replayLineage,anchorCommandId}'
  WHERE command.workspace_id = $1 AND command.world_id = $2 AND command.worldline_id = $3 AND command.idempotency_key = $4`);
const STORY_SQL = norm(`SELECT story.id, binding.story_id IS NOT NULL AS bound,
  EXISTS ( SELECT 1 FROM story_node_instances AS node WHERE node.workspace_id = story.workspace_id AND node.story_id = story.id ) AS has_graph
  FROM stories AS story LEFT JOIN story_definition_bindings AS binding ON binding.workspace_id = story.workspace_id
  AND binding.world_id = story.world_id AND binding.worldline_id = story.worldline_id AND binding.story_id = story.id
  WHERE story.workspace_id = $1 AND story.world_id = $2 AND story.worldline_id = $3 AND story.status NOT IN ('archived', 'completed') ORDER BY story.id ASC`);
const SIDECAR_SQL = norm(`SELECT snapshot.record_id, snapshot.assessment_id, snapshot.command_id, snapshot.version,
  CASE WHEN octet_length(snapshot.manifest_canonical) <= 262144 THEN snapshot.manifest_canonical ELSE NULL END AS manifest_canonical,
  snapshot.manifest_hash, assessment.policy_version, assessment.score, assessment.evidence_event_ids, assessment.evidence_snapshot_hash,
  assessment.record_id AS assessment_record_id, assessment.command_id AS assessment_command_id
  FROM performance_evidence_snapshots AS snapshot JOIN performance_assessments AS assessment
  ON (assessment.workspace_id, assessment.world_id, assessment.worldline_id, assessment.id) = (snapshot.workspace_id, snapshot.world_id, snapshot.worldline_id, snapshot.assessment_id)
  WHERE snapshot.workspace_id = $1 AND snapshot.world_id = $2 AND snapshot.worldline_id = $3 AND snapshot.assessment_id = $4 AND snapshot.command_id = $5`);

function capture() {
  const e = { id: "event", sceneId: "scene", visibilityPolicyId: "policy", policyVersion: "1", policyKind: "dm_only", recordVersion: "1", recordOrdinal: "1", worldTick: "2", worldOrdinal: "1" };
  return { scope: { ...scope, recordId: "record" }, admission: { principalId: "actor", role: "owner", evidencePolicyId: "approved-fixture", evidenceMode: "engine-authoritative-v1" }, binding: { storyId: "story", worldVersion: "1.0" }, head: { recordVersion: "1", nextRecordOrdinal: "2", lastEventId: "event", lastWorldTick: "2", lastWorldOrdinal: "1", effectiveTick: "2", effectiveOrdinal: "1" }, worldlineHead: { tick: "2", ordinal: "1" }, currentScene: { id: "scene", startTick: "0", startOrdinal: "0", status: "active" }, headEvent: e, evidence: [{ ...e, sceneStartTick: "0", sceneStartOrdinal: "0" }], factors: { evidenceCount: 1, milestoneCompleted: false, score: 10 }, milestoneWitness: null };
}
type Row = Record<string, unknown>;
type FixtureReceipt = {
  request: Record<string, unknown>;
  result: { assessmentId: string; score: number };
  performanceWitness: { version: number; manifestHash: unknown };
};
// Only the known test-authored receipt shape is projected here; corruption tests mutate it deliberately.
const receipt = (row: Row): FixtureReceipt => row.result_manifest as FixtureReceipt;
function protocol(options: { role?: string | null; world?: string; line?: string; record?: string; isolation?: string; readOnly?: string; captureError?: string; noHead?: boolean; fail?: "sidecar" | "continuation" | "commit" | "probe"; omitSidecar?: boolean; onKey?: () => void } = {}) {
  const trace: string[] = [], command: Row[] = [], assessments: Row[] = [], sidecars: Row[] = [];
  let workspace = "", connects = 0, saved: [Row[], Row[], Row[]] | undefined;
  const result = (rows: Row[] = [], rowCount = rows.length) => ({ rows: structuredClone(rows), rowCount });
  const client = { release() {}, async query(raw: string, params: unknown[] = []) {
    const sql = norm(raw); trace.push(sql);
    if (sql === "BEGIN") { assert.deepEqual(params, []); saved = structuredClone([command, assessments, sidecars]); return result(); }
    if (sql === "COMMIT") { if (options.fail === "commit") throw Error("commit failed"); return result(); }
    if (sql === "ROLLBACK") { if (saved) { command.splice(0, command.length, ...saved[0]); assessments.splice(0, assessments.length, ...saved[1]); sidecars.splice(0, sidecars.length, ...saved[2]); } return result(); }
    if (["SAVEPOINT realm_workspace_scope", "RELEASE SAVEPOINT realm_workspace_scope", "ROLLBACK TO SAVEPOINT realm_workspace_scope"].includes(sql)) { assert.deepEqual(params, []); return result(); }
    if (sql === "SELECT set_config('realm.workspace_id', $1, true)") { assert.equal(params.length, 1); workspace = params[0] as string; return result(); }
    if (sql === "SELECT current_setting('realm.workspace_id', true) AS workspace_id") { assert.deepEqual(params, []); return result([{ workspace_id: workspace }]); }
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only, current_setting('realm.workspace_id', true) AS workspace_id") { assert.deepEqual(params, []); return result([{ isolation_level: options.isolation ?? "read committed", read_only: options.readOnly ?? "off", workspace_id: workspace }]); }
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation_level") { assert.deepEqual(params, []); return result([{ isolation_level: options.isolation ?? "read committed" }]); }
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only") { assert.deepEqual(params, []); return result([{ isolation_level: options.isolation ?? "read committed", read_only: options.readOnly ?? "off" }]); }
    if (sql === "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR SHARE") { assert.deepEqual(params, ["ws", "world"]); return result([{ status: options.world ?? "active" }]); }
    if (sql === "SELECT public.bridge_command_membership_role($1, $2, $3) AS role") { assert.deepEqual(params, ["ws", "world", "actor"]); return result([{ role: options.role === undefined ? "owner" : options.role }]); }
    if (sql === "SELECT status FROM records WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4 FOR NO KEY UPDATE") { assert.deepEqual(params, ["ws", "world", "line", "record"]); return result([{ status: options.record ?? "active" }]); }
    if (sql === "SELECT status FROM worldlines WHERE workspace_id = $1 AND world_id = $2 AND id = $3 FOR UPDATE") { assert.deepEqual(params, ["ws", "world", "line"]); return result([{ status: options.line ?? "active" }]); }
    if (sql === "SELECT record_version::text, next_record_ordinal::text, last_event_id, last_world_tick::text, last_world_ordinal::text FROM record_heads WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 FOR UPDATE") { assert.deepEqual(params, ["ws", "world", "line", "record"]); return result(options.noHead ? [] : [{ record_version: "1", next_record_ordinal: "2", last_event_id: "event", last_world_tick: "2", last_world_ordinal: "1" }]); }
    if (sql === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") { assert.deepEqual(JSON.parse(params[0] as string), ["realm-command-key:v1", "fact", "ws", "world", "line", "key"]); options.onKey?.(); return result(); }
    if (sql === RECEIPT_SQL) { assert.deepEqual(params.slice(0, 4), ["ws", "world", "line", "key"]); assert.equal(params.length, 5); assert.equal(typeof params[4], "number"); return result(command); }
    if (sql === PERFORMANCE_SNAPSHOT_READY_SQL) { assert.deepEqual(params, []); assert.equal(trace.filter(s => s === sql).length, 1); if (options.fail === "probe") throw Object.assign(Error("no table"), { code: "42P01" }); return result(); }
    if (sql === norm(PERFORMANCE_CAPTURE_SQL)) { assert.deepEqual(params, ["ws", "world", "line", "record", ["event"], "actor", "owner", "approved-fixture", "engine-authoritative-v1"]); return result([{ error_code: options.captureError ?? null, capture_text: options.captureError ? null : JSON.stringify(capture()) }]); }
    if (sql === "INSERT INTO committed_fact_commands ( workspace_id, world_id, worldline_id, id, idempotency_key, request_fingerprint, kind, result_manifest ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)") {
      assert.equal(params.length, 8); assert.deepEqual(params.slice(0, 3), ["ws", "world", "line"]); assert.equal(params[4], "key"); assert.equal(params[6], "performance_assessed");
      command.push({ workspace_id: params[0], world_id: params[1], worldline_id: params[2], id: params[3], idempotency_key: params[4], request_fingerprint: params[5], kind: params[6], result_manifest: JSON.parse(params[7] as string), receipt_oversized: false, anchor_row: null }); return result([], 1);
    }
    if (sql === "INSERT INTO performance_assessments ( workspace_id, world_id, worldline_id, record_id, id, policy_version, score, evidence_event_ids, evidence_snapshot_hash, command_id ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10)") {
      assert.equal(params.length, 10); assert.deepEqual(params.slice(0, 4), ["ws", "world", "line", "record"]);
      assessments.push({ record_id: params[3], assessment_id: params[4], policy_version: params[5], score: params[6], evidence_event_ids: params[7], evidence_snapshot_hash: params[8], assessment_command_id: params[9], assessment_record_id: params[3] }); return result([], 1);
    }
    if (sql === "INSERT INTO performance_evidence_snapshots (workspace_id, world_id, worldline_id, record_id, assessment_id, command_id, version, manifest_canonical, manifest_hash) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)") {
      assert.equal(params.length, 8); assert.deepEqual(params.slice(0, 4), ["ws", "world", "line", "record"]); if (options.fail === "sidecar") throw Error("sidecar failed");
      if (!options.omitSidecar) sidecars.push({ ...assessments[0], record_id: params[3], assessment_id: params[4], command_id: params[5], version: 1, manifest_canonical: params[6], manifest_hash: params[7] }); return result([], options.omitSidecar ? 0 : 1);
    }
    if (sql === SIDECAR_SQL) { assert.deepEqual(params, ["ws", "world", "line", receipt(command[0]).result.assessmentId, command[0].id]); return result(sidecars); }
    if (sql === STORY_SQL) { assert.deepEqual(params, ["ws", "world", "line"]); if (options.fail === "continuation") throw Error("continuation failed"); return result(); }
    throw Error(`UNKNOWN_SQL:${sql}`);
  } };
  return { client, pool: { async connect() { connects++; return client; } }, trace, command, assessments, sidecars, options, connects: () => connects };
}

test("ordered admission → one capture → marker/assessment/sidecar → continuation, one outer commit", async () => {
  const p = protocol();
  const executed = await executePerformanceAssessmentCommand(p.pool as never, trust, intent);
  assert.equal(executed.result.score, 10); assert.equal(executed.continuation.status, "applied");
  assert.equal(p.connects(), 1); assert.equal(p.trace.filter(x => x === "BEGIN").length, 1); assert.equal(p.trace.filter(x => x === "COMMIT").length, 1);
  const indexes = ["FOR SHARE", "bridge_command_membership_role", "FOR NO KEY UPDATE", "FROM worldlines", "FROM record_heads", "pg_advisory_xact_lock", "FROM committed_fact_commands AS command", "WITH h AS MATERIALIZED", "INSERT INTO committed_fact_commands", "INSERT INTO performance_assessments", "INSERT INTO performance_evidence_snapshots", "FROM stories AS story"].map(part => p.trace.findIndex(s => s.includes(part)));
  assert.ok(indexes.every((x, i) => x >= 0 && (i === 0 || x > indexes[i - 1])));
  assert.equal(p.trace.filter(s => s === norm(PERFORMANCE_CAPTURE_SQL)).length, 1);
  assert.equal(Object.hasOwn(executed.result, "performanceWitness"), false);
  assert.equal(receipt(p.command[0]).performanceWitness.version, 1);
  const before = p.trace.length;
  const replay = await executePerformanceAssessmentCommand(p.pool as never, { ...trust, evidencePolicy: null, enablement: undefined }, intent);
  assert.deepEqual(replay.result, { ...executed.result, status: "replayed" });
  assert.equal(p.trace.slice(before).some(s => s === norm(PERFORMANCE_CAPTURE_SQL) || s === PERFORMANCE_SNAPSHOT_READY_SQL || s.startsWith("INSERT INTO")), false);
});

test("NEW policy/schema/transport gates and unknown SQL fail closed", async () => {
  for (const [t, code] of [
    [{ ...trust, evidencePolicy: null }, "PERFORMANCE_EVIDENCE_POLICY_UNRESOLVED"],
    [{ ...trust, evidencePolicy: { mode: "viewer-limited-v1", policyId: "fixture-viewer" } }, "PERFORMANCE_EVIDENCE_POLICY_UNRESOLVED"],
    [{ ...trust, enablement: undefined }, "PERFORMANCE_SCHEMA_UNAVAILABLE"],
    [{ ...trust, enablement: { schema: true, durableTransport: false } }, "PERFORMANCE_TRANSPORT_UNAVAILABLE"],
  ] as const) {
    const p = protocol(); await assert.rejects(executePerformanceAssessmentCommand(p.pool as never, t as never, intent), { code });
    assert.equal(p.command.length, 0); assert.equal(p.trace.includes(PERFORMANCE_SNAPSHOT_READY_SQL), false); assert.equal(p.trace.includes(norm(PERFORMANCE_CAPTURE_SQL)), false);
  }
  const p = protocol(); await assert.rejects(p.client.query("SELECT arbitrary"), /UNKNOWN_SQL/);
  const missing = protocol({ fail: "probe" }); await assert.rejects(executePerformanceAssessmentCommand(missing.pool as never, trust, intent), { code: "PERFORMANCE_SCHEMA_UNAVAILABLE" });
  assert.equal(missing.command.length, 0);
});

test("unproven client, READ ONLY, RR/serializable and bad scopes never capture", async () => {
  const p = protocol(); await assert.rejects(executePerformanceAssessmentCommand(p.client as never, trust, intent), { code: "PERFORMANCE_TRANSACTION_UNPROVEN" }); assert.equal(p.trace.length, 0);
  for (const options of [{ readOnly: "on" }, { isolation: "repeatable read" }, { isolation: "serializable" }, { role: "observer" }, { role: null }, { world: "archived" }, { record: "archived" }, { line: "frozen" }, { noHead: true }]) {
    const p = protocol(options); await assert.rejects(executePerformanceAssessmentCommand(p.pool as never, trust, intent), PerformanceAdmissionError); assert.equal(p.trace.includes(norm(PERFORMANCE_CAPTURE_SQL)), false); assert.equal(p.command.length, 0);
  }
});

test("capture EVENT_NOT_FOUND uses the admission-owned safe 404 error", async () => {
  const p = protocol({ captureError: "EVENT_NOT_FOUND" });
  await assert.rejects(executePerformanceAssessmentCommand(p.pool as never, trust, intent), (error: unknown) => {
    assert.ok(error instanceof PerformanceAdmissionError);
    assert.equal(error.code, "EVENT_NOT_FOUND");
    assert.equal(error.status, 404);
    assert.equal(error.message, "Performance assessment is unavailable.");
    return true;
  });
  assert.equal(p.command.length, 0);
  assert.equal(p.assessments.length, 0);
  assert.equal(p.sidecars.length, 0);
  assert.ok(p.trace.includes("ROLLBACK"));
});

test("direct request mismatch uses admission-owned 409 before command SQL", async () => {
  const p = protocol();
  const request = { command: "performance.assessed", recordId: "record", policyVersion: intent.policyVersion, score: 10, evidenceEventIds: ["event"] };
  await assert.rejects(createPostgresCommittedFactCommandStore(p.client as never).recordPerformanceAssessment({
    scope, commandId: "command", idempotencyKey: "key", request,
    requestFingerprint: committedFactRequestFingerprintFor(scope, request),
    recordId: "record", policyVersion: intent.policyVersion, score: 20,
    evidenceEventIds: ["event"], evidenceSnapshotHash: evidenceHash(["event"]),
  }), (error: unknown) => {
    assert.ok(error instanceof PerformanceAdmissionError);
    assert.equal(error.code, "IDEMPOTENCY_KEY_REUSE");
    assert.equal(error.status, 409);
    assert.equal(error.message, "Performance assessment is unavailable.");
    return true;
  });
  // Workspace composition may inspect its existing context, but refusal must
  // happen before the command key lock or receipt/domain SQL.
  assert.equal(p.trace.some(sql => sql.includes("pg_advisory_xact_lock") || sql.includes("committed_fact_commands") || sql.startsWith("INSERT INTO")), false);
  assert.equal(p.command.length, 0);
  assert.equal(p.assessments.length, 0);
  assert.equal(p.sidecars.length, 0);
});

test("admitted caller-owned client shares executor and never adds a second pool connection", async () => {
  const p = protocol();
  const result = await runAdmittedPerformanceCommand(p.pool as never, trust, intent, client => executePerformanceAssessmentCommand(client, trust, intent));
  assert.equal(result.result.score, 10); assert.equal(p.connects(), 1); assert.equal(p.trace.filter(s => s === "COMMIT").length, 1);
  await assert.rejects(executePerformanceAssessmentCommand(p.client as never, trust, intent), { code: "PERFORMANCE_TRANSACTION_UNPROVEN" });
});

test("legacy unmarked receipt replays without new table, factors, or policy", async () => {
  const p = protocol(); const request = { command: "performance.assessed", recordId: "record", policyVersion: intent.policyVersion, score: 30, evidenceEventIds: ["event"] };
  const result = { status: "committed", commandId: "old", assessmentId: "old:assessment", score: 30, evidenceSnapshotHash: evidenceHash(["event"]), goalTransition: null };
  p.command.push({ ...scope, workspace_id: "ws", world_id: "world", worldline_id: "line", id: "old", request_fingerprint: committedFactRequestFingerprintFor(scope, request), kind: "performance_assessed", result_manifest: { request, result }, receipt_oversized: false, anchor_row: null });
  const replay = await executePerformanceAssessmentCommand(p.pool as never, { ...trust, evidencePolicy: null, enablement: undefined }, intent);
  assert.equal(replay.result.score, 30); assert.equal(replay.result.status, "replayed"); assert.equal(p.trace.some(s => s.includes("performance_evidence_snapshots")), false);
});

test("a winner receipt becoming visible at the command lock is read fresh and never recaptured", async () => {
  const p = protocol();
  p.options.onKey = () => {
    const request = { command: "performance.assessed", recordId: "record", policyVersion: intent.policyVersion, score: 30, evidenceEventIds: ["event"] };
    p.command.push({ workspace_id: "ws", world_id: "world", worldline_id: "line", id: "winner", request_fingerprint: committedFactRequestFingerprintFor(scope, request), kind: "performance_assessed", result_manifest: { request, result: { status: "committed", commandId: "winner", assessmentId: "winner:assessment", score: 30, evidenceSnapshotHash: evidenceHash(["event"]), goalTransition: null } }, receipt_oversized: false, anchor_row: null });
  };
  const result = await executePerformanceAssessmentCommand(p.pool as never, { ...trust, evidencePolicy: null, enablement: undefined }, intent);
  assert.equal(result.result.score, 30); assert.equal(result.result.status, "replayed");
  assert.equal(p.trace.filter(s => s === RECEIPT_SQL).length, 1);
  assert.ok(p.trace.findIndex(s => s.includes("pg_advisory_xact_lock")) < p.trace.indexOf(RECEIPT_SQL));
  assert.equal(p.trace.some(s => s === PERFORMANCE_SNAPSHOT_READY_SQL || s === norm(PERFORMANCE_CAPTURE_SQL) || s.startsWith("INSERT INTO")), false);
});

test("direct-store changed score cannot hide behind either old or recomputed fingerprint", async () => {
  const p = protocol(); await executePerformanceAssessmentCommand(p.pool as never, trust, intent);
  const c = p.command[0], old = receipt(c).request;
  for (const changeRequest of [false, true]) {
    const request = { ...old, ...(changeRequest ? { score: 20 } : {}) };
    await assert.rejects(createPostgresCommittedFactCommandStore(p.client as never).recordPerformanceAssessment({ scope, commandId: c.id as string, idempotencyKey: "key", requestFingerprint: changeRequest ? committedFactRequestFingerprintFor(scope, request) : c.request_fingerprint as string, recordId: "record", policyVersion: intent.policyVersion, score: 20, evidenceEventIds: ["event"], evidenceSnapshotHash: evidenceHash(["event"]), request }), { code: "IDEMPOTENCY_KEY_REUSE" });
  }
  assert.equal(p.assessments.length, 1);
});

test("marker/sidecar tuple corruption is refused, no silent legacy downgrade", async () => {
  for (const mutate of [
    (p: ReturnType<typeof protocol>) => { p.sidecars.length = 0; },
    (p: ReturnType<typeof protocol>) => { p.sidecars[0].manifest_hash = "0".repeat(64); },
    (p: ReturnType<typeof protocol>) => { p.sidecars[0].score = 99; },
    (p: ReturnType<typeof protocol>) => { p.sidecars[0].evidence_event_ids = ["other"]; },
    (p: ReturnType<typeof protocol>) => { receipt(p.command[0]).performanceWitness.version = 2; },
    (p: ReturnType<typeof protocol>) => { receipt(p.command[0]).result.score = 99; },
  ]) {
    const p = protocol(); await executePerformanceAssessmentCommand(p.pool as never, trust, intent); mutate(p);
    await assert.rejects(executePerformanceAssessmentCommand(p.pool as never, trust, intent), { code: "IDEMPOTENCY_KEY_REUSE" });
  }
});

test("rehashing an internally contradictory historical header cannot authorize receipt replay", async () => {
  const p = protocol();
  await executePerformanceAssessmentCommand(p.pool as never, trust, intent);
  const snapshot = JSON.parse(p.sidecars[0].manifest_canonical as string);
  // Same immutable event, but evidence and head now disagree on its policy.
  // Keep all four outer facts and request fingerprints otherwise intact.
  snapshot.evidence[0].policyVersion = "2";
  const canonical = JSON.stringify(snapshot);
  const hash = createHash("sha256").update("performance-evidence-snapshot:v1\0").update(canonical).digest("hex");
  p.sidecars[0].manifest_canonical = canonical;
  p.sidecars[0].manifest_hash = hash;
  receipt(p.command[0]).performanceWitness.manifestHash = hash;
  const captures = p.trace.filter(s => s === norm(PERFORMANCE_CAPTURE_SQL)).length;
  await assert.rejects(executePerformanceAssessmentCommand(p.pool as never, trust, intent), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.equal(p.trace.filter(s => s === norm(PERFORMANCE_CAPTURE_SQL)).length, captures);
  assert.equal(p.command.length, 1);
});

test("the actual witness receipt reader rejects a rehashed request whose operation disagrees with its fact kind", async () => {
  const p = protocol();
  await executePerformanceAssessmentCommand(p.pool as never, trust, intent);
  const command = p.command[0];
  receipt(command).request.command = "inventory.granted";
  command.request_fingerprint = committedFactRequestFingerprintFor(scope, receipt(command).request);
  const snapshot = JSON.parse(p.sidecars[0].manifest_canonical as string);
  snapshot.requestFingerprint = command.request_fingerprint;
  p.sidecars[0].manifest_canonical = performanceEvidenceSnapshotCanonical(snapshot);
  p.sidecars[0].manifest_hash = performanceEvidenceSnapshotHash(snapshot);
  receipt(command).performanceWitness.manifestHash = p.sidecars[0].manifest_hash;
  await assert.rejects(createPostgresCommittedFactCommandStore(p.client as never).loadCommand(scope, "key"), { code: "IDEMPOTENCY_KEY_REUSE" });
});

test("capture refusal, sidecar failure/omission, Story failure and commit failure never report committed", async () => {
  for (const options of [{ captureError: "EVENT_NOT_FOUND" }, { fail: "sidecar" as const }, { omitSidecar: true }, { fail: "continuation" as const }, { fail: "commit" as const }]) {
    const p = protocol(options); await assert.rejects(executePerformanceAssessmentCommand(p.pool as never, trust, intent)); assert.equal(p.command.length, 0); assert.equal(p.assessments.length, 0); assert.equal(p.sidecars.length, 0); assert.ok(p.trace.includes("ROLLBACK"));
  }
  const p = protocol(); await executePerformanceAssessmentCommand(p.pool as never, trust, intent); p.options.fail = "continuation";
  const replay = await executePerformanceAssessmentCommand(p.pool as never, { ...trust, evidencePolicy: null }, intent);
  assert.equal(replay.result.status, "replayed"); assert.equal(replay.continuation.status, "blocked"); assert.equal(p.command.length, 1);
});

test("legacy adapter refuses NEW intent without loading split factors", async () => {
  let reads = 0;
  const service = createCommittedFactCommandService({ store: { async loadCommand() { return null; }, async loadPerformanceFacts() { reads++; throw Error("split read forbidden"); } } as never });
  await assert.rejects(service.recordPerformanceAssessment({ scope, ...intent }), { code: "COMMAND_INVALID" }); assert.equal(reads, 0);
});

test("all seven finance mutator key sites have World/worldline prelude and post-replay active gate", () => {
  const source = readFileSync(new URL("../database/postgres/project-finance-command-repository.ts", import.meta.url), "utf8");
  assert.equal((source.match(/const lockedScope = await lockFinanceScopePrelude\(client, input.scope\);\s+await lockWorkspaceCommandKey\(client, "finance"/g) ?? []).length, 7);
  assert.equal((source.match(/requireWritableFinanceScope\(lockedScope\)/g) ?? []).length, 7);
  assert.ok(source.indexOf("SELECT status FROM worlds") < source.lastIndexOf("SELECT status FROM worldlines"));
  assert.equal(typeof createPostgresProjectFinanceCommandStore, "function");
  assert.ok(!PERFORMANCE_CAPTURE_SQL.includes("payload")); assert.ok(!PERFORMANCE_CAPTURE_SQL.includes("audience_character"));
});

test("every finance factory mutator takes scoped prelude before key, preserves archived historical replay, rejects archived NEW", async () => {
  const financeReceiptSQL = norm(`SELECT command.workspace_id, command.world_id, command.worldline_id, command.id,
    command.request_fingerprint, command.state, command.policy_version,
    CASE WHEN octet_length(command.result_manifest::text) <= $5 THEN command.result_manifest ELSE NULL END AS result_manifest,
    octet_length(command.result_manifest::text) > $5 AS receipt_oversized,
    CASE WHEN anchor.id IS NULL THEN NULL ELSE jsonb_build_object(
    'workspace_id', anchor.workspace_id, 'world_id', anchor.world_id, 'worldline_id', anchor.worldline_id,
    'id', anchor.id, 'request_fingerprint', anchor.request_fingerprint, 'state', anchor.state, 'policy_version', anchor.policy_version,
    'result_manifest', CASE WHEN octet_length(anchor.result_manifest::text) <= $5 THEN anchor.result_manifest ELSE NULL END,
    'receipt_oversized', octet_length(anchor.result_manifest::text) > $5) END AS anchor_row
    FROM project_finance_command_groups AS command LEFT JOIN project_finance_command_groups AS anchor
    ON anchor.workspace_id = command.workspace_id AND anchor.world_id = command.world_id AND anchor.worldline_id = command.worldline_id
    AND anchor.id = command.result_manifest #>> '{replayLineage,anchorCommandId}'
    WHERE command.workspace_id = $1 AND command.world_id = $2 AND command.worldline_id = $3 AND command.idempotency_key = $4`);
  const evidence = { recordId: "record", sceneId: "scene", visibility: "public", expectedWorldCursor: { worldTick: 0, worldOrdinal: 1 } };
  const ledger = { accountId: "account", amountMinor: 100, category: "props", memo: "supplies", occurredAt: "2026-10-16T00:00:00.000Z", expectedBalanceMinor: 1000, evidence };
  const cases: [string, Row][] = [
    ["recordExpense", ledger], ["recordIncome", ledger], ["recordAdjustment", { ...ledger, direction: "income" }],
    ["confirmMilestone", { projectId: "project", milestoneId: "milestone", expectedProjectVersion: 1, evidence, semanticEventKey: "show.completed" }],
    ["allocateBudget", { projectId: "project", category: "props", amountMinor: 100, expectedVersion: 0 }],
    ["changeStage", { projectId: "project", stage: "production", expectedProjectVersion: 1, evidence }],
    ["applyRecordProjectFinance", { evidence, actions: [{ command: "confirm_milestone", projectId: "project", milestoneId: "milestone", expectedProjectVersion: 1, semanticEventKey: "show.completed" }] }],
    ["createObligation", { projectId: "project", kind: "loan", principalMinor: 100 }],
    ["settleObligation", { obligationId: "obligation", amountMinor: 10, expectedOutstandingMinor: 100, expectedBalanceMinor: 1000, accountId: "account", category: "props", memo: "repayment", occurredAt: ledger.occurredAt, settlementKind: "repayment" }],
  ];
  for (const [method, body] of cases) {
    let accepted: Row | undefined, repositoryMethod = "";
    const memory = new Proxy({}, { get(_t, name) {
      if (name === "loadCommand") return async () => null;
      if (name === "loadAccount" || name === "loadDefaultAccount") return async () => ({ ...scope, id: "account", currency: "JPY", status: "active", openingBalanceMinor: 1000 });
      if (name === "loadLedger") return async () => [];
      return async (input: Row) => { accepted = input; repositoryMethod = String(name); return { status: "committed", commandGroupId: input.commandGroupId }; };
    } });
    const service = createProjectFinanceCommandService({ store: memory as never }) as unknown as Record<string, (x: Row) => Promise<Row>>;
    const original = await service[method]({ scope, ...body, idempotencyKey: "finance-key" }); assert.ok(accepted);
    let hasReceipt = true;
    const trace: string[] = [];
    const client = { release() {}, async query(raw: string, params: unknown[] = []) {
      const sql = norm(raw); trace.push(sql); const rows = (items: Row[] = []) => ({ rows: structuredClone(items), rowCount: items.length });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) { assert.deepEqual(params, []); return rows(); }
      if (sql === "SELECT set_config('realm.workspace_id', $1, true)") { assert.deepEqual(params, ["ws"]); return rows(); }
      if (sql === "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR SHARE") { assert.deepEqual(params, ["ws", "world"]); return rows([{ status: "archived" }]); }
      if (sql === "SELECT status FROM worldlines WHERE workspace_id = $1 AND world_id = $2 AND id = $3 FOR UPDATE") { assert.deepEqual(params, ["ws", "world", "line"]); return rows([{ status: "frozen" }]); }
      if (sql === "SELECT current_setting('transaction_isolation') AS isolation_level") { assert.deepEqual(params, []); return rows([{ isolation_level: "read committed" }]); }
      if (sql === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") { assert.deepEqual(JSON.parse(params[0] as string), ["realm-command-key:v1", "finance", "ws", "world", "line", "finance-key"]); return rows(); }
      if (sql === financeReceiptSQL) { assert.deepEqual(params.slice(0, 4), ["ws", "world", "line", "finance-key"]); assert.equal(params.length, 5); return rows(hasReceipt ? [{ workspace_id: "ws", world_id: "world", worldline_id: "line", id: accepted!.commandGroupId, request_fingerprint: accepted!.requestFingerprint, state: "committed", policy_version: PROJECT_FINANCE_COMMAND_POLICY_VERSION, result_manifest: { request: accepted!.request, result: original }, receipt_oversized: false, anchor_row: null }] : []); }
      throw Error(`UNKNOWN_FINANCE_SQL:${sql}`);
    } };
    const store = createPostgresProjectFinanceCommandStore({ async connect() { return client; } } as never) as unknown as Record<string, (x: Row) => Promise<Row>>;
    assert.deepEqual(await store[repositoryMethod](accepted!), { ...original, status: "replayed" }, method);
    assert.ok(trace.findIndex(s => s.includes("FROM worlds")) < trace.findIndex(s => s.includes("FROM worldlines")), method);
    assert.ok(trace.findIndex(s => s.includes("FROM worldlines")) < trace.findIndex(s => s.includes("pg_advisory_xact_lock")), method);
    hasReceipt = false;
    await assert.rejects(store[repositoryMethod](accepted!), { code: "BUSINESS_PRECONDITION_FAILED" });
  }
});
