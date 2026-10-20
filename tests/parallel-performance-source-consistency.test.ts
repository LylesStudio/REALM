/** Real receipt producer and restore/service code; strict SQL protocol double, never PG. */
import assert from "node:assert/strict";
import test from "node:test";
import { createCommittedFactCommandService, committedFactCommandIdFor, committedFactRequestFingerprintFor, evidenceHash } from "../modules/application/committed-fact-command.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData, type RealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";

type Row = Record<string, unknown>;
const scope = { workspaceId: "f6-ws", worldId: "f6-world", worldlineId: "f6-source" };
const clone = structuredClone;
function protocol(lane: "producer" | "restore") {
  const tables = new Map<string, Row[]>(), statements: string[] = [];
  let workspace: unknown = null, connects = 0;
  const rows = (name: string): Row[] => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)!; };
  const result = (items: Row[]) => ({ rows: items, rowCount: items.length });
  const allowed = new Set(["worldlines", "stories", "records", "participants", "scenes", "visibility_policies", "events", "record_heads", "committed_fact_commands", "performance_assessments"]);
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
    if (sql.includes("current_setting('transaction_read_only') AS read_only")) return result([{ isolation_level: "read committed", read_only: "off" }]);
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
      assert.ok(!rows(match[1]).some(r => r.workspace_id === row.workspace_id && r.id && r.id === row.id), "duplicate INSERT"); rows(match[1]).push(row); return result([]);
    }
    throw Error(`UNKNOWN_SQL:${sql}`);
  } };
  return { client, rows, statements, database: { async connect() { connects++; return client; } }, connects: () => connects, inserts: () => statements.filter(q => q.startsWith("INSERT INTO ")).length };
}
async function fixture(legacy = false, key = "f6-accepted") {
  const p = protocol("producer");
  p.rows("events").push(...["f6-event", "f6-alternate"].map(id => ({ workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, id, record_id: "f6-record" })));
  const intent = { scope, recordId: "f6-record", policyVersion: "structured-factors:v1", evidenceEventIds: ["f6-event"], idempotencyKey: key };
  // Frozen native-v0 category: explicit historical receipt, never a fresh production write without admission.
  // Real production fingerprint/ID functions retain the original accepted byte oracle.
  const request = { command: "performance.assessed", recordId: intent.recordId, policyVersion: intent.policyVersion, score: 10, evidenceEventIds: intent.evidenceEventIds };
  const requestFingerprint = committedFactRequestFingerprintFor(scope, request);
  const commandId = committedFactCommandIdFor(scope, key, requestFingerprint);
  const accepted = { status: "committed", commandId, assessmentId: `${commandId}:assessment`, score: 10, evidenceSnapshotHash: evidenceHash(intent.evidenceEventIds), goalTransition: null };
  p.rows("committed_fact_commands").push({ workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, id: commandId, idempotency_key: key, request_fingerprint: requestFingerprint, kind: "performance_assessed", result_manifest: { request, result: accepted } });
  p.rows("performance_assessments").push({ workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: intent.recordId, id: accepted.assessmentId, policy_version: intent.policyVersion, score: accepted.score, evidence_event_ids: intent.evidenceEventIds, evidence_snapshot_hash: accepted.evidenceSnapshotHash, command_id: commandId });
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
function target() {
  const p = protocol("restore");
  const restorer = createPostgresRealmRuntimeSaveRestorer(p.database as never, { validateWorldBinding: async () => {} });
  return { p, restorer };
}
function input(archive: RealmRuntimeSaveArchive, key = "restore-key") { return { archive, workspaceId: "f6-target-ws", principalId: "owner", targetWorldId: scope.worldId, idempotencyKey: key }; }

test("source request evidence changed with original fingerprint rejects before connect", async () => {
  const { archive } = await fixture(), t = target();
  const c = archive.domain!.committedFactCommands[0];
  (c.request as Row).evidenceEventIds = ["f6-alternate"];
  assert.notEqual(c.requestFingerprint, committedFactRequestFingerprintFor(scope, c.request!));
  const before = clone(archive);
  await assert.rejects(t.restorer.restore(input(archive)), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0); assert.deepEqual(archive, before);
});

test("producer modern neighboring positive transports and service replays without INSERT", async () => {
  const { archive } = await fixture(), t = target(), before = clone(archive);
  const restored = await t.restorer.restore(input(archive));
  const count = t.p.inserts(), c = t.p.rows("committed_fact_commands")[0], a = t.p.rows("performance_assessments")[0];
  const replay = await createCommittedFactCommandService({ store: createPostgresCommittedFactCommandStore(t.p.client as never) }).recordPerformanceAssessment({ scope: { workspaceId: String(c.workspace_id), worldId: String(c.world_id), worldlineId: String(c.worldline_id) }, recordId: restored.recordId, policyVersion: "structured-factors:v1", evidenceEventIds: a.evidence_event_ids as string[], idempotencyKey: String(c.idempotency_key) });
  assert.equal(replay.status, "replayed"); assert.equal(replay.score, 10); assert.equal(t.p.inserts(), count); assert.deepEqual(archive, before);
});

test("result-only score inconsistency rejects before connect", async () => {
  const { archive } = await fixture(), t = target();
  (archive.domain!.committedFactCommands[0].resultManifest as Row).score = 11;
  await assert.rejects(t.restorer.restore(input(archive)), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0);
});

test("assessment own valid sibling tuple cannot replace the request's Record", async () => {
  const { archive } = await fixture(), t = target();
  const a = archive.domain!.performanceAssessments[0] as unknown as Row;
  a.recordId = "f6-sibling"; a.evidenceEventIds = ["f6-sibling-event"]; a.evidenceSnapshotHash = evidenceHash(["f6-sibling-event"]);
  await assert.rejects(t.restorer.restore(input(archive)), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0);
});

test("assessment original evidence hash must match source IDs", async () => {
  const { archive } = await fixture(), t = target();
  (archive.domain!.performanceAssessments[0] as unknown as Row).evidenceSnapshotHash = "0".repeat(64);
  await assert.rejects(t.restorer.restore(input(archive)), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0);
});

test("result commandId and self-consistent suffix must still link to the actual command", async () => {
  const { archive } = await fixture(), t = target(), r = archive.domain!.committedFactCommands[0].resultManifest as Row;
  r.commandId = "different-command"; r.assessmentId = "different-command:assessment";
  await assert.rejects(t.restorer.restore(input(archive)), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0);
});

test("full legacy unknown original fingerprint rejects before connect", async () => {
  const { archive } = await fixture(true), t = target();
  (archive.domain!.committedFactCommands[0] as unknown as Row).requestFingerprint = "0".repeat(64);
  await assert.rejects(t.restorer.restore(input(archive)), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0);
});

test("assessment cannot attach to a valid relationship command kind", async () => {
  const { archive } = await fixture(), t = target(), c = archive.domain!.committedFactCommands[0] as unknown as Row;
  c.kind = "relationship_revised";
  c.request = { command: "relationship.revised", subjectEntityKey: "one", objectEntityKey: "two", relationKind: "knows", sourceEventId: "f6-event" };
  c.requestFingerprint = committedFactRequestFingerprintFor(scope, c.request as Row);
  c.resultManifest = { status: "committed", commandId: c.id, relationKind: "knows", revisionOrdinal: 1, occurred: { worldTick: 1, worldOrdinal: 1 } };
  await assert.rejects(t.restorer.restore(input(archive)), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0);
});

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
for (const legacy of [false, true]) for (const [name, mutate] of attacks) test(`${legacy ? "full legacy" : "modern"} independent connect=0: ${name}`, async () => {
  const { archive } = await fixture(legacy), t = target(); mutate(archive); const before = clone(archive);
  await assert.rejects(t.restorer.restore(input(archive)), (error: unknown) => {
    const e = error as { code: string; message: string }; assert.equal(e.code, "RUNTIME_SAVE_INVALID"); assert.ok(!e.message.includes("source private body")); return true;
  });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0); assert.deepEqual(archive, before);
});
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
for (const [name, mutate] of requestAttacks) test(`modern request ${name}, even with recomputed source fingerprint`, async () => {
  const { archive } = await fixture(), t = target(); mutate(requestOf(archive));
  commandOf(archive).requestFingerprint = committedFactRequestFingerprintFor(scope, requestOf(archive));
  await assert.rejects(t.restorer.restore(input(archive)), { code: "RUNTIME_SAVE_INVALID" });
  assert.equal(t.p.connects(), 0); assert.equal(t.p.inserts(), 0);
});
for (const legacy of [false, true]) test(`${legacy ? "full legacy" : "modern"} accepted historical score and immutable source, restore replay and body conflict`, async () => {
  const { archive } = await fixture(legacy), t = target();
  // A historically accepted score is not recalculated from today's milestones.
  // Here the full original fingerprint proves a different accepted score.
  const score = 30, a = assessmentOf(archive), c = commandOf(archive);
  a.score = score; resultOf(archive).score = score;
  const candidate = { command: "performance.assessed", recordId: a.recordId, policyVersion: a.policyVersion, score, evidenceEventIds: a.evidenceEventIds };
  if (!legacy) c.request = candidate;
  c.requestFingerprint = committedFactRequestFingerprintFor(scope, candidate);
  const before = clone(archive), restored = await t.restorer.restore(input(archive)), inserts = t.p.inserts();
  assert.equal((await t.restorer.restore(input(archive))).replayed, true); assert.equal(t.p.inserts(), inserts);
  const row = t.p.rows("committed_fact_commands")[0], saved = t.p.rows("performance_assessments")[0];
  const store = createPostgresCommittedFactCommandStore(t.p.client as never);
  const targetScope = { workspaceId: String(row.workspace_id), worldId: String(row.world_id), worldlineId: String(row.worldline_id) };
  const decoded = await store.loadCommand(targetScope, String(row.idempotency_key)); assert.ok(decoded);
  if (legacy) { assert.equal(decoded.request, null); assert.equal(decoded.requestFingerprint, c.requestFingerprint); assert.ok(decoded.replayProof); }
  const intent = { scope: targetScope, recordId: restored.recordId, policyVersion: "structured-factors:v1", evidenceEventIds: saved.evidence_event_ids as string[], idempotencyKey: String(row.idempotency_key) };
  const replay = await createCommittedFactCommandService({ store }).recordPerformanceAssessment(intent);
  assert.equal(replay.status, "replayed"); assert.equal(replay.score, score); assert.equal(t.p.inserts(), inserts);
  await assert.rejects(createCommittedFactCommandService({ store }).recordPerformanceAssessment({ ...intent, evidenceEventIds: ["different-event"] }), { code: "IDEMPOTENCY_KEY_REUSE" });
  await assert.rejects(store.recordPerformanceAssessment({ ...intent, commandId: String(row.id), requestFingerprint: committedFactRequestFingerprintFor(targetScope, { ...candidate, recordId: restored.recordId, evidenceEventIds: intent.evidenceEventIds, score: 31 }), score: 31, evidenceSnapshotHash: String(saved.evidence_snapshot_hash), request: { ...candidate, recordId: restored.recordId, evidenceEventIds: intent.evidenceEventIds, score: 31 } }), { code: "IDEMPOTENCY_KEY_REUSE" });
  const changed = clone(archive); (changed.domain!.stories![0] as unknown as Row).title = "different body";
  await assert.rejects(t.restorer.restore(input(changed)), { code: "RESTORE_CONFLICT" }); assert.equal(t.p.inserts(), inserts); assert.deepEqual(archive, before);
  const invalidReplay = clone(archive); resultOf(invalidReplay).score = 999;
  const connections = t.p.connects(); await assert.rejects(t.restorer.restore(input(invalidReplay)), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(t.p.connects(), connections); assert.equal(t.p.inserts(), inserts);
});

/** Explicit projection from actual captured INSERTs and production decoder.
 * This is not a public reader test; the PG fixture covers the full reader. */
async function projectTransported(f: Awaited<ReturnType<typeof fixture>>, t: ReturnType<typeof target>, restored: { recordId: string }) {
  const archive = clone(f.archive), domain = archive.domain!, row = t.p.rows("committed_fact_commands")[0];
  const targetScope = { workspaceId: String(row.workspace_id), worldId: String(row.world_id), worldlineId: String(row.worldline_id) };
  const decoded = await createPostgresCommittedFactCommandStore(t.p.client as never).loadCommand(targetScope, String(row.idempotency_key)); assert.ok(decoded);
  const bundles = [archive.record, ...domain.records!.map(r => r.bundle.record)];
  const records = t.p.rows("records"); assert.equal(records.length, bundles.length);
  // Explicit typed bijections, never SQL row positions. The root identity is
  // returned by the production restorer. Siblings use unique fixture titles
  // in the same target scope; ambiguous titles must fail, not pick a row.
  const recordMap = new Map<string, string>([[archive.record.scope.recordId, restored.recordId]]);
  assert.equal(records.filter(r => r.id === restored.recordId && r.workspace_id === targetScope.workspaceId && r.world_id === targetScope.worldId && r.worldline_id === targetScope.worldlineId).length, 1);
  for (const snapshot of domain.records!) {
    const candidates = records.filter(r => r.workspace_id === targetScope.workspaceId && r.world_id === targetScope.worldId && r.worldline_id === targetScope.worldlineId && r.id !== restored.recordId && r.title === snapshot.title);
    assert.equal(candidates.length, 1, "sibling fixture title must identify exactly one scoped target Record");
    recordMap.set(snapshot.recordId, String(candidates[0].id));
  }
  assert.equal(recordMap.size, bundles.length); assert.equal(new Set(recordMap.values()).size, bundles.length);
  const eventMap = new Map<string, Row>();
  for (const bundle of bundles) {
    const recordId = recordMap.get(bundle.scope.recordId); assert.ok(recordId);
    const targetEvents = t.p.rows("events").filter(e => e.workspace_id === targetScope.workspaceId && e.world_id === targetScope.worldId && e.worldline_id === targetScope.worldlineId && e.record_id === recordId);
    assert.equal(targetEvents.length, bundle.events.length);
    for (const event of bundle.events) {
      const candidates = targetEvents.filter(e => e.record_version === event.recordVersion && e.record_ordinal === event.ordinal && e.event_kind === event.kind);
      assert.equal(candidates.length, 1, "source Event coordinate must identify exactly one scoped target Event");
      assert.ok(!eventMap.has(event.eventId)); eventMap.set(event.eventId, candidates[0]);
    }
  }
  assert.equal(new Set([...eventMap.values()].map(e => String(e.id))).size, eventMap.size);
  for (const b of bundles) {
    const recordId = recordMap.get(b.scope.recordId)!; (b as unknown as Row).scope = { worldId: targetScope.worldId, worldlineId: targetScope.worldlineId, recordId };
    for (const event of b.events) { const r = eventMap.get(event.eventId); assert.ok(r); (event as unknown as Row).eventId = r.id; Object.assign(event.payload as Row, { sceneId: r.scene_id, visibilityPolicyId: r.visibility_policy_id }); }
  }
  for (const r of domain.records!) { (r as unknown as Row).recordId = recordMap.get(r.recordId)!; (r as unknown as Row).lastEventId = r.bundle.record.events.at(-1)!.eventId; }
  Object.assign(domain.source as unknown as Row, { worldId: targetScope.worldId, worldlineId: targetScope.worldlineId, recordId: archive.record.scope.recordId });
  const a = t.p.rows("performance_assessments")[0];
  (domain as unknown as Row).performanceAssessments = [{ id: a.id, recordId: a.record_id, policyVersion: a.policy_version, score: a.score, evidenceEventIds: a.evidence_event_ids, evidenceSnapshotHash: a.evidence_snapshot_hash, commandId: a.command_id }];
  (domain as unknown as Row).committedFactCommands = [{ id: row.id, idempotencyKey: row.idempotency_key, requestFingerprint: decoded.requestFingerprint, kind: decoded.kind, provenance: decoded.provenance, request: decoded.request, resultManifest: decoded.result, ...(decoded.replayProof ? { replayLineage: decoded.replayProof.binding } : {}) }];
  if (decoded.replayProof) (domain as unknown as Row).commandReplayContexts = [decoded.replayProof.context];
  (archive.manifest as unknown as Row).scope = { workspaceId: targetScope.workspaceId, worldlineId: targetScope.worldlineId, recordId: archive.record.scope.recordId };
  archive.manifest = realmRuntimeSaveManifestFromData({ ...archive, ...archive.manifest });
  return parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive));
}
for (const legacy of [false, true]) test(`${legacy ? "full legacy typed origin" : "modern"} second transport validates original source facts and replays`, async () => {
  const f = await fixture(legacy), first = target(); const firstRestore = await first.restorer.restore(input(f.archive));
  const source = await projectTransported(f, first, firstRestore), before = clone(source), second = target();
  const restored = await second.restorer.restore(input(source, "second-generation"));
  const row = second.p.rows("committed_fact_commands")[0], a = second.p.rows("performance_assessments")[0];
  const store = createPostgresCommittedFactCommandStore(second.p.client as never), replayScope = { workspaceId: String(row.workspace_id), worldId: String(row.world_id), worldlineId: String(row.worldline_id) };
  const count = second.p.inserts();
  const rr = await createCommittedFactCommandService({ store }).recordPerformanceAssessment({ scope: replayScope, recordId: restored.recordId, evidenceEventIds: a.evidence_event_ids as string[], policyVersion: "structured-factors:v1", idempotencyKey: String(row.idempotency_key) });
  assert.equal(rr.status, "replayed"); assert.equal(rr.score, 10); assert.equal(second.p.inserts(), count); assert.deepEqual(source, before);
  if (legacy) {
    const c = source.domain!.committedFactCommands[0]; assert.equal(c.request, null); assert.equal(c.requestFingerprint, f.archive.domain!.committedFactCommands[0].requestFingerprint);
    // A valid context digest with wrong typed origin mapping must not prove a
    // candidate merely because all global tokens still exist.
    const bad = clone(source), context = bad.domain!.commandReplayContexts![0];
    const { createReplayContext } = await import("../modules/application/command-replay-lineage.ts");
    const evidence = clone(context.identities.event); const i = evidence.findIndex(pair => pair[1] === "f6-event"), j = evidence.findIndex(pair => pair[1] === "f6-alternate");
    const changed = evidence.map((pair, k) => [pair[0], k === i ? evidence[j][1] : k === j ? evidence[i][1] : pair[1]]);
    const wrong = createReplayContext({ format: context.format, version: context.version, family: context.family, originScope: context.originScope, currentScope: context.currentScope, identities: { ...context.identities, event: changed } });
    (bad.domain as unknown as Row).commandReplayContexts = [wrong]; (commandOf(bad).replayLineage as Row).contextId = wrong.id;
    const reject = target(); await assert.rejects(reject.restorer.restore(input(bad)), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(reject.p.connects(), 0); assert.equal(reject.p.inserts(), 0);
  }
});

for (const legacy of [false, true]) test(`${legacy ? "full legacy" : "modern"} checks every receipt in a multi-command archive`, async () => {
  const first = await fixture(legacy), second = await fixture(legacy, "second-accepted"), archive = first.archive;
  (archive.domain as unknown as Row).committedFactCommands = [...archive.domain!.committedFactCommands, ...second.archive.domain!.committedFactCommands];
  (archive.domain as unknown as Row).performanceAssessments = [...archive.domain!.performanceAssessments, ...second.archive.domain!.performanceAssessments];
  const t = target(); await t.restorer.restore(input(archive)); assert.equal(t.p.rows("committed_fact_commands").length, 2); assert.equal(t.p.rows("performance_assessments").length, 2);
  const bad = clone(archive); (bad.domain!.committedFactCommands[1].resultManifest as Row).score = 11;
  const rejected = target(); await assert.rejects(rejected.restorer.restore(input(bad)), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(rejected.p.connects(), 0); assert.equal(rejected.p.inserts(), 0);
});

for (const legacy of [false, true]) test(`Iris projection is independent of SQL row order: ${legacy ? "legacy" : "modern"}`, async () => {
  const f = await fixture(legacy), first = target();
  const firstRestore = await first.restorer.restore(input(f.archive));
  first.p.rows("records").reverse(); first.p.rows("events").reverse();
  const source = await projectTransported(f, first, firstRestore);
  for (const bundle of [source.record, ...source.domain!.records!.map(r => r.bundle.record)]) {
    for (const event of bundle.events) {
      const actual = first.p.rows("events").filter(r => r.workspace_id === source.manifest.scope.workspaceId && r.record_id === bundle.scope.recordId && r.record_version === event.recordVersion && r.record_ordinal === event.ordinal && r.event_kind === event.kind);
      assert.equal(actual.length, 1); assert.equal(actual[0].id, event.eventId);
    }
  }
  const second = target(), restored = await second.restorer.restore(input(source, "iris-order-independent"));
  const c = second.p.rows("committed_fact_commands")[0], a = second.p.rows("performance_assessments")[0], before = second.p.inserts();
  const replay = await createCommittedFactCommandService({ store: createPostgresCommittedFactCommandStore(second.p.client as never) }).recordPerformanceAssessment({ scope: { workspaceId: String(c.workspace_id), worldId: String(c.world_id), worldlineId: String(c.worldline_id) }, recordId: restored.recordId, policyVersion: "structured-factors:v1", evidenceEventIds: a.evidence_event_ids as string[], idempotencyKey: String(c.idempotency_key) });
  assert.equal(replay.status, "replayed"); assert.equal(replay.score, 10); assert.equal(second.p.inserts(), before);
});

test("F6a schema probe rejects producer lane and unknown SQL remains closed", async () => {
  const producer = protocol("producer"), target = protocol("restore");
  await assert.rejects(producer.client.query("SELECT restore_delivery_kind FROM public.outbox WHERE false", []), /forbidden in producer/);
  await assert.rejects(target.client.query("SELECT unknown_restore_probe()", []), /UNKNOWN_SQL/);
  await assert.rejects(protocol("restore").client.query("SELECT restore_delivery_kind FROM public.outbox WHERE false", [1]));
});
