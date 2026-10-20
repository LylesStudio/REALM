/** Real receipt producer and restore/service code; strict SQL protocol double, never PG. */
import assert from "node:assert/strict";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";
import { evidenceHash } from "../modules/application/committed-fact-command.ts";
import { executePerformanceAssessmentCommand } from "../modules/application/performance-command-executor.ts";
import { PERFORMANCE_CAPTURE_SQL, PERFORMANCE_SNAPSHOT_READY_SQL } from "../database/postgres/performance-evidence-admission.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData, computeRealmRuntimeSaveContentHash, type RealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";

type Row = Record<string, unknown>;
const scope = { workspaceId: "f6-ws", worldId: "f6-world", worldlineId: "f6-source" };
const clone = structuredClone;
const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();
const STORY_SQL = norm(`SELECT story.id, binding.story_id IS NOT NULL AS bound,
  EXISTS ( SELECT 1 FROM story_node_instances AS node WHERE node.workspace_id = story.workspace_id AND node.story_id = story.id ) AS has_graph
  FROM stories AS story LEFT JOIN story_definition_bindings AS binding ON binding.workspace_id = story.workspace_id
  AND binding.world_id = story.world_id AND binding.worldline_id = story.worldline_id AND binding.story_id = story.id
  WHERE story.workspace_id = $1 AND story.world_id = $2 AND story.worldline_id = $3 AND story.status NOT IN ('archived', 'completed') ORDER BY story.id ASC`);
// Explicit immutable SQL capture fixture; never split loadPerformanceFacts or client score.
function capture() {
  const header = (id: string, ordinal: string) => ({ id, sceneId: "scene", visibilityPolicyId: "visibility", policyVersion: "1", policyKind: "public", recordVersion: "1", recordOrdinal: ordinal, worldTick: "1", worldOrdinal: ordinal });
  return { scope: { ...scope, recordId: "f6-record" }, admission: { principalId: "f6-owner", role: "owner", evidencePolicyId: "f6-fixture", evidenceMode: "engine-authoritative-v1" },
    binding: { storyId: "f6-story", worldVersion: "1.2.0" },
    head: { recordVersion: "1", nextRecordOrdinal: "3", lastEventId: "f6-alternate", lastWorldTick: "1", lastWorldOrdinal: "2", effectiveTick: "1", effectiveOrdinal: "2" },
    worldlineHead: { tick: "1", ordinal: "2" }, currentScene: { id: "scene", startTick: "0", startOrdinal: "0", status: "active" },
    headEvent: header("f6-alternate", "2"), evidence: [{ ...header("f6-event", "1"), sceneStartTick: "0", sceneStartOrdinal: "0" }],
    factors: { evidenceCount: 1, milestoneCompleted: false, score: 10 }, milestoneWitness: null };
}
function protocol(lane: "producer" | "restore") {
  const tables = new Map<string, Row[]>(), statements: string[] = [];
  let workspace: unknown = null, connects = 0;
  const rows = (name: string): Row[] => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)!; };
  const result = (items: Row[]) => ({ rows: items, rowCount: items.length });
  const allowed = new Set(["worldlines", "stories", "records", "participants", "scenes", "visibility_policies", "events", "record_heads", "committed_fact_commands", "performance_assessments", "performance_evidence_snapshots"]);
  const client = { release() {}, async query(raw: string, values: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim(); statements.push(sql);
    if (sql === "SELECT restore_delivery_kind FROM public.outbox WHERE false") {
      assert.equal(lane, "restore", "schema probe is forbidden in producer lane");
      assert.deepEqual(values, []);
      assert.equal(statements.filter(q => q === "SELECT restore_delivery_kind FROM public.outbox WHERE false").length, 1);
      assert.equal(statements.filter(q => q.startsWith("INSERT INTO ")).length, 0);
      return result([]);
    }
    if (/^(BEGIN(?: READ ONLY)?|COMMIT|ROLLBACK|SAVEPOINT realm_workspace_scope|RELEASE SAVEPOINT realm_workspace_scope|ROLLBACK TO SAVEPOINT realm_workspace_scope)$/.test(sql)) return result([]);
    if (sql === "SELECT current_setting('realm.workspace_id', true) AS workspace_id") return result([{ workspace_id: workspace }]);
    if (sql === "SELECT set_config('realm.workspace_id', $1, true)") { workspace = values[0]; return result([]); }
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation_level") return result([{ isolation_level: "read committed" }]);
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only, current_setting('realm.workspace_id', true) AS workspace_id") { assert.deepEqual(values, []); return result([{ isolation_level: "read committed", read_only: "off", workspace_id: workspace }]); }
    if (sql === "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR SHARE") { assert.equal(lane, "producer"); assert.deepEqual(values, [scope.workspaceId, scope.worldId]); return result([{ status: "active" }]); }
    if (sql === "SELECT public.bridge_command_membership_role($1, $2, $3) AS role") { assert.equal(lane, "producer"); assert.deepEqual(values, [scope.workspaceId, scope.worldId, "f6-owner"]); return result([{ role: "owner" }]); }
    if (sql === "SELECT status FROM records WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4 FOR NO KEY UPDATE") { assert.equal(lane, "producer"); assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId, "f6-record"]); return result([{ status: "active" }]); }
    if (sql === "SELECT status FROM worldlines WHERE workspace_id = $1 AND world_id = $2 AND id = $3 FOR UPDATE") { assert.equal(lane, "producer"); assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId]); return result([{ status: "active" }]); }
    if (sql === "SELECT record_version::text, next_record_ordinal::text, last_event_id, last_world_tick::text, last_world_ordinal::text FROM record_heads WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 FOR UPDATE") { assert.equal(lane, "producer"); assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId, "f6-record"]); return result([{ record_version: "1", next_record_ordinal: "3", last_event_id: "f6-alternate", last_world_tick: "1", last_world_ordinal: "2" }]); }
    if (sql === PERFORMANCE_SNAPSHOT_READY_SQL) { assert.equal(lane, "producer"); assert.deepEqual(values, []); return result([]); }
    if (sql === norm(PERFORMANCE_CAPTURE_SQL)) { assert.equal(lane, "producer"); assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId, "f6-record", ["f6-event"], "f6-owner", "owner", "f6-fixture", "engine-authoritative-v1"]); return result([{ error_code: null, capture_text: JSON.stringify(capture()) }]); }
    if (sql === STORY_SQL) { assert.equal(lane, "producer"); assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId]); return result([]); }
    if (sql === "SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only") { assert.deepEqual(values, []); return result([{ isolation_level: "read committed", read_only: "off" }]); }
    if (sql === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") return result([]);
    if (sql === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE") return result([{ world_version: "1.2.0", status: "active", settings: {} }]);
    if (sql === "SELECT role FROM player_world_memberships WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3") return result([{ role: "owner" }]);
    if (sql.startsWith("SELECT record.world_id, record.worldline_id, record.story_id, record.status, story.premise AS story_premise FROM records AS record JOIN stories AS story")) {
      const row = rows("records").find(r => r.workspace_id === values[0] && r.id === values[1]);
      return result(row ? [{ ...row, story_premise: rows("stories").find(s => s.id === row.story_id)!.premise }] : []);
    }
    if (sql.includes("FROM committed_fact_commands AS command LEFT JOIN committed_fact_commands AS anchor")) {
      assert.match(sql, /command.workspace_id = \$1 AND command.world_id = \$2 AND command.worldline_id = \$3/);
      const row = rows("committed_fact_commands").find(r => r.workspace_id === values[0] && r.world_id === values[1] && r.worldline_id === values[2] && r.idempotency_key === values[3]);
      const binding = (row?.result_manifest as Row | undefined)?.replayLineage as Row | undefined;
      return result(row ? [{ ...clone(row), receipt_oversized: false, anchor_row: clone(rows("committed_fact_commands").find(r => r.id === binding?.anchorCommandId) ?? null) }] : []);
    }
    if (sql === "SELECT id FROM events WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 AND id = ANY($5::text[])") return result(rows("events").filter(r => r.workspace_id === values[0] && r.world_id === values[1] && r.worldline_id === values[2] && r.record_id === values[3] && (values[4] as string[]).includes(String(r.id))).map(r => ({ id: r.id })));
    if (sql === "SELECT id FROM project_milestones WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND completion_record_id = $4 AND status = 'completed' LIMIT 1") return result([]);
    const match = /^INSERT INTO (\w+) \(([^)]+)\) VALUES \(([^)]+)\)$/.exec(sql);
    if (match) {
      assert.ok(allowed.has(match[1]), `UNKNOWN_INSERT_TABLE:${match[1]}`);
      const columns = match[2].split(",").map(s => s.trim()), terms = match[3].split(",").map(s => s.trim()); assert.equal(columns.length, terms.length);
      const row: Row = {};
      columns.forEach((column, i) => {
        const term = terms[i], parameter = /^\$(\d+)(?:::[a-z]+(?:\[\])?)?$/.exec(term);
        let value: unknown;
        if (parameter) { assert.ok(Number(parameter[1]) <= values.length); value = clone(values[Number(parameter[1]) - 1]); if (term.endsWith("::jsonb") && typeof value === "string") value = JSON.parse(value); }
        else if (term === "NULL") value = null;
        else if (term === "CURRENT_TIMESTAMP") value = "protocol-timestamp";
        else if (term === "true" || term === "false") value = term === "true";
        else if (/^'[^']*'$/.test(term)) value = term.slice(1, -1);
        else if (/^\d+$/.test(term)) value = Number(term);
        else throw Error(`UNKNOWN_INSERT_TERM:${term}`);
        row[column] = value;
      });
      assert.ok(!rows(match[1]).some(r => r.workspace_id === row.workspace_id && r.id && r.id === row.id), "duplicate INSERT"); rows(match[1]).push(row); return { rows: [], rowCount: 1 };
    }
    throw Error(`UNKNOWN_SQL:${sql}`);
  } };
  return { client, rows, statements, database: { async connect() { connects++; return client; } }, connects: () => connects, inserts: () => statements.filter(q => q.startsWith("INSERT INTO ")).length };
}
async function fixture(legacy = false, key = "f6-accepted") {
  const p = protocol("producer");
  p.rows("events").push(...["f6-event", "f6-alternate"].map(id => ({ workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, id, record_id: "f6-record" })));
  const intent = { scope, recordId: "f6-record", policyVersion: "structured-factors:v1" as const, evidenceEventIds: ["f6-event"], idempotencyKey: key };
  const { result: accepted } = await executePerformanceAssessmentCommand(p.database as never, {
    scope, principalId: "f6-owner", evidencePolicy: { mode: "engine-authoritative-v1", policyId: "f6-fixture" },
    enablement: { schema: true, durableTransport: true },
  }, intent);
  assert.equal(p.rows("performance_evidence_snapshots").length, 1);
  assert.equal(p.statements.filter(q => q === norm(PERFORMANCE_CAPTURE_SQL)).length, 1);
  assert.equal(p.statements.filter(q => q === "COMMIT").length, 1);
  // These controls intentionally exercise the supported unmarked/full legacy codec family.
  // Only archive projection omits the new private marker; the real producer receipt is retained.
  assert.equal(((p.rows("committed_fact_commands")[0].result_manifest as Row).performanceWitness as Row).version, 1);
  assert.equal(accepted.score, 10);
  const c = p.rows("committed_fact_commands")[0], a = p.rows("performance_assessments")[0], wire = c.result_manifest as Row;
  const event = (id: string, ordinal = 1) => ({ eventId: id, recordVersion: 1, ordinal, kind: "utterance.committed", payload: { content: "source private body", speakerName: "", actorParticipantId: null, sceneId: id === "f6-sibling-event" ? "sibling-scene" : "scene", visibilityPolicyId: id === "f6-sibling-event" ? "sibling-visibility" : "visibility", worldTick: 1, worldOrdinal: ordinal, calendarId: "calendar", displayTime: "", eventPayload: { assessmentFactors: { fabricatedBonus: 999999 } } } });
  const record = { format: "realm-runtime-record", schemaVersion: 1, scope: { worldId: scope.worldId, worldlineId: scope.worldlineId, recordId: "f6-record" }, head: { recordVersion: 1, nextRecordOrdinal: 3 }, events: [event("f6-event"), event("f6-alternate", 2)] };
  const goals = { format: "realm-runtime-goals", schemaVersion: 1, instances: [], assessments: [] };
  const domain = { format: "realm-runtime-domain", schemaVersion: 1, source: { ...record.scope, storyId: "f6-story" }, stories: [{ id: "f6-story", title: "Source", status: "active", premise: "" }], storyDefinitions: [], records: [{ recordId: "f6-sibling", storyId: "f6-story", title: "Sibling", status: "active", worldVersion: "1.2.0", startTick: 0, startOrdinal: 0, timelineKind: "primary", linkedRecordId: null, lastEventId: "f6-sibling-event", lastWorldTick: 1, lastWorldOrdinal: 1, bundle: { record: { ...clone(record), scope: { ...record.scope, recordId: "f6-sibling" }, head: { recordVersion: 1, nextRecordOrdinal: 2 }, events: [event("f6-sibling-event")] }, goals: clone(goals) } }], projects: [], milestones: [], projectStoryLinks: [], budgetAllocations: [], financeAccounts: [], ledgerEntries: [], financeCommandGroups: [], obligations: [], obligationSettlements: [], storyNodes: [], storyUnlockLedger: [], committedFactCommands: [{ id: String(c.id), idempotencyKey: String(c.idempotency_key), requestFingerprint: String(c.request_fingerprint), kind: "performance_assessed", provenance: legacy ? "legacy-result-v1" : "request-result-v1", request: legacy ? null : clone(wire.request) as Row, resultManifest: clone(wire.result) as Row }], performanceAssessments: [{ id: String(a.id), recordId: String(a.record_id), policyVersion: String(a.policy_version), score: Number(a.score), evidenceEventIds: clone(a.evidence_event_ids) as string[], evidenceSnapshotHash: String(a.evidence_snapshot_hash), commandId: String(a.command_id) }], memberRelationshipRevisions: [], characterAssets: [] };
  const data = { record, goals, domain } as unknown as RealmRuntimeSaveArchive;
  data.manifest = realmRuntimeSaveManifestFromData({ ...data, engineApi: "1.x", mode: "world-bound", world: { worldId: scope.worldId, worldVersion: "1.2.0" }, scope: { workspaceId: scope.workspaceId, worldlineId: scope.worldlineId, recordId: "f6-record" } });
  // Use real codec first, so independent refusal assertions cannot pass because
  // the scaffold was invalid. Direct mutations below reach restore preflight.
  const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(data));
  return { archive, intent };
}
type Mutation = (archive: RealmRuntimeSaveArchive) => void;
const commandOf = (a: RealmRuntimeSaveArchive) => a.domain!.committedFactCommands[0] as unknown as Row;
const assessmentOf = (a: RealmRuntimeSaveArchive) => a.domain!.performanceAssessments[0] as unknown as Row;
const resultOf = (a: RealmRuntimeSaveArchive) => commandOf(a).resultManifest as Row;
const requestOf = (a: RealmRuntimeSaveArchive) => commandOf(a).request as Row;
const attacks: [string, Mutation][] = [
  ["result score", a => { resultOf(a).score = 11; }],
  ["assessment score", a => { assessmentOf(a).score = 11; }],
  ["assessment policy", a => { assessmentOf(a).policyVersion = "unsupported:v9"; }],
  ["assessment evidence with valid different hash", a => { assessmentOf(a).evidenceEventIds = ["f6-alternate"]; assessmentOf(a).evidenceSnapshotHash = evidenceHash(["f6-alternate"]); }],
  ["assessment identity", a => { assessmentOf(a).id = "other:assessment"; }],
  ["assessment and result identity together", a => { assessmentOf(a).id = "other:assessment"; resultOf(a).assessmentId = "other:assessment"; }],
  ["assessment command link", a => { assessmentOf(a).commandId = "absent-command"; }],
  ["missing assessment", a => { (a.domain as unknown as Row).performanceAssessments = []; }],
  ["duplicate linked assessment", a => { (a.domain as unknown as Row).performanceAssessments = [clone(assessmentOf(a)), { ...clone(assessmentOf(a)), id: "duplicate:assessment" }]; }],
  ["result original hash", a => { resultOf(a).evidenceSnapshotHash = "0".repeat(64); }],
  ["result goal transition", a => { resultOf(a).goalTransition = { invented: true }; }],
  ["result assessment identity", a => { resultOf(a).assessmentId = "unlinked:assessment"; }],
  ["result status", a => { resultOf(a).status = "rejected"; }],
  ["result Record extra field", a => { resultOf(a).recordId = "f6-sibling"; }],
  ["result policy extra field", a => { resultOf(a).policyVersion = "structured-factors:v1"; }],
  ["result evidence extra field", a => { resultOf(a).evidenceEventIds = ["f6-event"]; }],
  ["explicit metadata with opaque result", a => { commandOf(a).resultManifest = { recordId: "f6-record", score: 10 }; }],
  ["wrong archive source workspace", a => { (a.manifest.scope as unknown as Row).workspaceId = "different-source"; }],
  ["original fingerprint", a => { commandOf(a).requestFingerprint = "0".repeat(64); }],
];
const requestAttacks: [string, (request: Row) => void][] = [
  ["score", r => { r.score = 11; }],
  ["policy", r => { r.policyVersion = "unsupported:v9"; }],
  ["Record", r => { r.recordId = "f6-sibling"; }],
  ["evidence", r => { r.evidenceEventIds = ["f6-alternate"]; }],
  ["kind/operation", r => { r.command = "inventory.granted"; }],
  ["extra key", r => { r.extra = true; }],
  ["empty evidence", r => { r.evidenceEventIds = []; }],
  ["duplicate evidence", r => { r.evidenceEventIds = ["f6-event", "f6-event"]; }],
  ["noncanonical evidence", r => { r.evidenceEventIds = ["f6-event", "f6-alternate"]; }],
  ["unknown typed evidence", r => { r.evidenceEventIds = ["f6-record"]; }],
  ["foreign typed evidence", r => { r.evidenceEventIds = ["f6-sibling-event"]; }],
];

/** Tamper a valid production ZIP; only ZIP CRC/lengths and runtime content hash
 * are regenerated. Semantic invalid inputs never pass through the builder. */
function tamperedZip(valid: RealmRuntimeSaveArchive, mutate: Mutation): Uint8Array {
  const files = unzipSync(buildRealmRuntimeSaveArchive(valid));
  const archive = clone(valid); mutate(archive);
  files["runtime/domain.json"] = Buffer.from(JSON.stringify(archive.domain));
  const manifest = clone(archive.manifest);
  manifest.snapshot.runtimeHash = computeRealmRuntimeSaveContentHash(new Map(Object.entries(files).filter(([name]) => name !== "realm-save-manifest.json")));
  files["realm-save-manifest.json"] = Buffer.from(JSON.stringify(manifest));
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [bytes, { level: 6, mtime: new Date(1980, 0, 1) }]])));
}
const invalid = (error: unknown) => {
  const e = error as {code: string}; assert.ok(["INVALID_SAVE", "INVALID_DOMAIN_SAVE"].includes(e.code), String(error)); return true;
};
for (const legacy of [false, true]) {
  test(`public ${legacy ? "full legacy" : "modern"} producer positive`, async () => {
    const {archive} = await fixture(legacy), before = clone(archive);
    assert.deepEqual(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive)), before);
    // A mechanically regenerated unmodified ZIP is structurally accepted too.
    assert.deepEqual(parseRealmRuntimeSaveArchive(tamperedZip(archive, () => {})), before);
  });
  for (const [name, mutate] of attacks) for (const boundary of ["build", "parse"] as const) test(`public ${legacy ? "full legacy" : "modern"} ${boundary}: ${name}`, async () => {
    const {archive} = await fixture(legacy);
    const originalFingerprint = commandOf(archive).requestFingerprint;
    if (boundary === "parse") assert.throws(() => parseRealmRuntimeSaveArchive(tamperedZip(archive, mutate)), invalid);
    else {
      const bytes = tamperedZip(archive, mutate);
      mutate(archive);
      archive.manifest = JSON.parse(Buffer.from(unzipSync(bytes)["realm-save-manifest.json"]).toString());
      const before = clone(archive);
      assert.throws(() => buildRealmRuntimeSaveArchive(archive), invalid);
      assert.deepEqual(archive, before);
    }
    if (name.startsWith("result") || name.startsWith("assessment")) assert.equal(commandOf(archive).requestFingerprint, originalFingerprint);
  });
}
for (const [name, mutate] of requestAttacks) for (const boundary of ["build", "parse"] as const) test(`public modern ${boundary}: request ${name} retaining original fingerprint`, async () => {
  const {archive} = await fixture(); const attack: Mutation = a => mutate(requestOf(a));
  if (boundary === "parse") assert.throws(() => parseRealmRuntimeSaveArchive(tamperedZip(archive, attack)), invalid);
  else { const bytes = tamperedZip(archive, attack); attack(archive); archive.manifest = JSON.parse(Buffer.from(unzipSync(bytes)["realm-save-manifest.json"]).toString()); assert.throws(() => buildRealmRuntimeSaveArchive(archive), invalid); }
});
