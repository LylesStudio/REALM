import { GOAL_TRANSPORT_CAPABILITY_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { evidenceHeaderSql } from "../database/postgres/runtime-evidence-resource-reader.ts";
// Exact A2 reader protocol; these inherited fixtures explicitly have no installed policy.

// Explicit pre-0083 schema lane, independent from the installed A2 policy map.
// Empty Evidence families are modelled separately from all payload cursors.
function createLegacyEmptyReaderProbe(recordIds: readonly string[]) {
  const cursors = new Set<string>();
  const normalize = (sql:string) => sql.replace(/\s+/g," ").trim();
  return Object.assign((raw:string, values:unknown[]): Record<string,unknown>[] | undefined => {
    const sql=normalize(raw);
    if(sql===normalize(GOAL_TRANSPORT_CAPABILITY_SQL)) {
      assert.deepEqual(values,[]); return [{available:false}];
    }
    const declaration=/^\/\* runtime evidence (action_receipts|character_effects|observations) headers \*\/ DECLARE (realm_evidence_[a-f0-9]+) /.exec(sql);
    if(declaration) {
      const family=declaration[1] as "action_receipts"|"character_effects"|"observations", name=declaration[2]!;
      assert.equal(sql,normalize(evidenceHeaderSql(family,name)));
      assert.equal(values.length,4);
      assert.deepEqual(values.slice(0,3),[scope.workspaceId,scope.worldId,scope.worldlineId]);
      assert.ok(recordIds.includes(String(values[3])),"Evidence must use an admitted Record");
      assert.ok(!cursors.has(name)); cursors.add(name); return [];
    }
    const page=/^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM (realm_evidence_[a-f0-9]+)$/.exec(sql);
    if(page) { assert.deepEqual(values,[]); assert.ok(cursors.has(page[1]!)); return []; }
    const close=/^CLOSE (realm_evidence_[a-f0-9]+)$/.exec(sql);
    if(close) { assert.deepEqual(values,[]); assert.ok(cursors.delete(close[1]!),"unknown Evidence cursor"); return []; }
    if(sql.includes("realm_evidence_") || sql.startsWith("/* runtime evidence ")) throw Error("UNKNOWN_EMPTY_EVIDENCE_SQL:"+sql);
    return undefined;
  },{assertClosed(){assert.equal(cursors.size,0,"all Evidence header cursors must close");}});
}
const A2_MAP_SQL = "SELECT schema_version, world_version, content_hash, policy_version, project_key, milestone_key, project_id, milestone_id, story_id, record_id, link_kind FROM realmworld_command_materializations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY project_key, milestone_key LIMIT 257";
const A2_CAPABILITY_SQL = "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available";
const inheritedCommandPolicyFixture = { schemaAvailable: true, rows: [] as Record<string, unknown>[] };
import {topologyHeaderSql} from "../database/postgres/runtime-topology-resource-reader.ts";
/** Production JS + strict SQL protocol doubles, never a PostgreSQL/worker run. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/runtime-repository.ts";
import { createReleaseFingerprint, type JsonValue } from "../modules/runtime/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData,
  type RealmRuntimeSaveArchive, type RealmRuntimeSaveOutboxMessageV1 } from "../modules/world-transfer/realm-runtime-save.ts";

type Row = Record<string, unknown>;

// Named topology header adaptation only; inherited fixture assertions stay intact.
function topologyFixtureHeaders(sql:string,rows:Record<string,unknown>[],values:unknown[]) {
 const family=(["participants","scenes","visibility"] as const).find(f=>sql===topologyHeaderSql(f).replace(/\s+/g," ").trim());
 if(!family)throw Error("UNKNOWN_TOPOLOGY_HEADER_SQL");
 const keys=family==='participants'?['participant_speaking_order','participant_id']:family==='scenes'?['start_tick','start_ordinal','scene_id']:['policy_key','policy_version','policy_id'];
 assert.equal(values.length,4+keys.length);
 const fields=[...sql.matchAll(/ AS (\w+)_bytes/g)].map(m=>m[1]!);
 return rows.filter(row=>values[4]===null||keys.some((k,i)=>keys.slice(0,i).every((prior,j)=>String(row[prior])===String(values[j+4]))&&String(row[k])>String(values[i+4]))).slice(0,1000).map((row,i)=>({
  ...row,locator:`(0,${i+1})`,source_count:String(rows.length),cursor_progress:true,
  ...Object.fromEntries(fields.flatMap(k=>{
   const json=['instance_state','definition_profile','audience_character_instance_ids'].includes(k);
   const value=json?JSON.stringify(row[k]??(k==='audience_character_instance_ids'?[]:{})):row[k]??null;
   if(value!==null&&typeof value!=='string')throw Error('INVALID_FIXTURE_TOPOLOGY_TEXT');
   const bytes=value===null?0:Buffer.byteLength(value);
   assert.ok(bytes<=256,'this inherited fixture must explicitly model any new body cursor');
   return [[k,value],[`${k}_is_null`,value===null],[`${k}_bytes`,bytes],[`${k}_chars`,value===null?0:[...value].length]];
  }))
 }));
}
const scope = { workspaceId: "transport-ws", worldId: "transport-world", worldlineId: "transport-line", recordId: "same-token" };
const stamp = "2026-10-18T00:00:00.000Z";
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const SCOPED_GOAL_EXPORT_REFUSAL_SQL = norm(`SELECT 1 AS unsupported_scoped_goal
     FROM goal_instances AS goal
     WHERE goal.workspace_id = $1 AND goal.world_id = $2 AND goal.worldline_id = $3
       AND goal.record_id IS NULL
       AND ((goal.scope_kind = 'worldline' AND goal.story_id IS NULL)
         OR (goal.scope_kind = 'story' AND ($4::text IS NULL OR goal.story_id = $4)
           AND EXISTS (SELECT 1 FROM stories AS owner_story
             WHERE owner_story.workspace_id = goal.workspace_id AND owner_story.world_id = goal.world_id
               AND owner_story.worldline_id = goal.worldline_id AND owner_story.id = goal.story_id)))
     LIMIT 1`);
const tx = new Set(["BEGIN", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK", "SELECT set_config('realm.workspace_id', $1, true)"]);
// A text allowlist is not a SQL evaluator. Each admitted statement also needs
// an explicit lane handler below; an unhandled query never returns empty rows.
const RESTORE_SCHEMA_PROBE = "SELECT restore_delivery_kind FROM public.outbox WHERE false";
const staticSQL = new Set<string>([RESTORE_SCHEMA_PROBE, A2_MAP_SQL, A2_CAPABILITY_SQL]);
for (const file of ["realm-runtime-save-repository.ts", "runtime-repository.ts", "world-write-gate.ts"]) {
  for (const m of readFileSync(new URL(`../database/postgres/${file}`, import.meta.url), "utf8").matchAll(/`([^`]*?)`/g)) {
    if (!m[1].includes("${") && /^(SELECT|INSERT|UPDATE)/.test(m[1].trim())) staticSQL.add(norm(m[1]));
  }
}
const outboxColumns = "id, turn_run_id, record_id, topic, dedupe_key, payload, state, revision, attempt_count, available_at, lease_owner, lease_expires_at, created_at, updated_at, published_at, last_error_code, last_error_message, last_error_at";
const lockedSQL = `SELECT ${outboxColumns} FROM outbox WHERE workspace_id = $1 AND id = $2 FOR UPDATE`;
const listSQL = `SELECT ${outboxColumns} FROM outbox WHERE workspace_id = $1 AND turn_run_id IS NOT NULL ORDER BY id`;
const claimSQL = `UPDATE outbox SET state = 'delivering', revision = revision + 1, attempt_count = attempt_count + 1, lease_owner = $3, lease_expires_at = $4::timestamptz, updated_at = $5::timestamptz WHERE workspace_id = $1 AND id = $2 RETURNING ${outboxColumns}`;
function validate(sql: string) {
  if (sql === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE" || sql === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE") return;
  if ([lockedSQL, listSQL, claimSQL].includes(sql)) return;
  if (tx.has(sql) || staticSQL.has(sql)) return;
  if ((["participants","scenes","visibility"] as const).some(f=>sql===norm(topologyHeaderSql(f)))) return;
  if (/^\/\* runtime event headers \*\/ SELECT /.test(sql) && sql.includes("FROM events WHERE workspace_id=$1 AND record_id=$2") && sql.endsWith("LIMIT 1000")) return;
  if (sql.startsWith("/* runtime outbox headers; outbox preflight; outbox bounded envelope */ SELECT ") && sql.includes("FROM outbox WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4") && sql.endsWith("LIMIT 1000")) return;
  if (/^\/\* runtime (event|outbox) payload cursor \*\/ DECLARE realm_(event|outbox)_payload_[a-f0-9]+ NO SCROLL CURSOR FOR /.test(sql) && sql.includes("AS MATERIALIZED")) return;
  if (/^\/\* runtime (event|outbox)( payload)? chunk \*\/ FETCH FORWARD 1 FROM realm_(event|outbox)_payload_[a-f0-9]+$/.test(sql)) return;
  if (/^CLOSE realm_(event|outbox)_payload_[a-f0-9]+$/.test(sql)) return;
  if (sql === "WITH record_committed_wakeup AS ( SELECT pg_notify($5, $6) ) UPDATE command_inbox SET state = 'completed', result_event_ids = $3::text[], completed_at = $4::timestamptz, updated_at = $4::timestamptz, last_error_code = NULL WHERE workspace_id = $1 AND id = $2 AND EXISTS (SELECT 1 FROM record_committed_wakeup)") return;
  throw new Error(`UNKNOWN_SQL_TEXT: ${sql}`);
}
function protocol(lane: string, handler: (sql: string, values: unknown[]) => Row[] | undefined) {
  const readerProbe=createLegacyEmptyReaderProbe([scope.recordId]);
  const calls: { sql: string; values: unknown[] }[] = [];
  let acquired = 0, released = 0;
  const client = { release() { if(lane==="reader")readerProbe.assertClosed(); released++; }, async query(sql: string, values: unknown[] = []) {
    const q = norm(sql);
    if(lane==="reader") { const probe=readerProbe(q,values); if(probe!==undefined) { calls.push({sql:q,values:structuredClone(values)}); return {rows:probe,rowCount:probe.length}; } }
    validate(q); calls.push({ sql: q, values: structuredClone(values) });
    if (q === RESTORE_SCHEMA_PROBE) {
      if (lane !== "restore") throw new Error(`UNKNOWN_SQL_PROTOCOL:${lane}:${q}`);
      assert.deepEqual(values, []);
    }
    if(q === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE" || q === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE") {
      assert.equal(lane,"restore"); assert.deepEqual(values,[scope.workspaceId,scope.worldId]);
    }
    let rows = handler(q, values);
    if(q.startsWith("/* runtime topology")&&rows!==undefined)rows=topologyFixtureHeaders(q,rows,values);
    if (rows === undefined) throw new Error(`UNKNOWN_SQL_PROTOCOL:${lane}:${q}`);
    return { rows, rowCount: rows.length };
  } };
  return { database: { async connect() { acquired++; return client; } }, calls, counts: () => ({ acquired, released }) };
}
// Interpret actual INSERT column/term bindings, including NULL and literals.
function inserted(sql: string, values: unknown[]) {
  const m = /^INSERT INTO (\w+) \((.*?)\) VALUES \((.*)\)$/.exec(sql); assert.ok(m);
  let depth = 0, start = 0; const terms: string[] = [];
  for (let i = 0; i < m[3].length; i++) {
    if (m[3][i] === "(") depth++; if (m[3][i] === ")") depth--;
    if (m[3][i] === "," && depth === 0) { terms.push(m[3].slice(start, i).trim()); start = i + 1; }
  }
  terms.push(m[3].slice(start).trim()); const columns = m[2].split(",").map(s => s.trim());
  assert.equal(columns.length, terms.length); const row: Row = {};
  columns.forEach((column, i) => {
    const term = terms[i], p = /^\$(\d+)(?:::\w+(?:\[\])?)?$/.exec(term);
    if (p) { row[column] = values[Number(p[1]) - 1]; if (term.endsWith("::jsonb") && row[column] !== null) row[column] = JSON.parse(String(row[column])); }
    else if (term === "NULL") row[column] = null;
    else if (term === "CURRENT_TIMESTAMP") row[column] = stamp; // simulated server time, asserted separately from old source time
    else if (term === "true" || term === "false") row[column] = term === "true";
    else if (/^'.*'$/.test(term)) row[column] = term.slice(1, -1);
    else if (/^\d+$/.test(term)) row[column] = Number(term);
    else throw new Error(`UNKNOWN_INSERT_TERM:${term}`);
  });
  return { table: m[1], row };
}
async function writer() {
  let run: Row = { turnId: "transport-turn", command: { recordId: scope.recordId, expectedRecordVersion: 0,
    idempotencyKey: "transport-command", actorId: null, commandType: "player.utterance", payload: {} }, state: "releasing", revision: 4,
    attempts: { planning: 1, drafting: 1, validating: 1, releasing: 1 }, transitions: [], failures: [], updatedAt: stamp };
  const rows: Record<string, Row[]> = { events: [], outbox: [] };
  const p = protocol("writer", (q, v) => {
    if (tx.has(q)) return [];
    if (q.startsWith("SELECT run_checkpoint FROM turn_runs")) return [{ run_checkpoint: run }];
    if (q.startsWith("SELECT world_id FROM records")) return [{ world_id: scope.worldId }];
    if (q.startsWith("SELECT status FROM worlds") || q.startsWith("SELECT status FROM records")) return [{ status: "active" }];
    if (q.includes("FROM records AS record") && q.includes("calendar_id")) return [{ world_id: scope.worldId, worldline_id: scope.worldlineId, calendar_id: "calendar", display_time: "" }];
    if (q.startsWith("SELECT head_tick, head_ordinal FROM worldlines")) return [{ head_tick: 0, head_ordinal: 0 }];
    if (q.startsWith("SELECT record_version, next_record_ordinal FROM record_heads")) return [{ record_version: 0, next_record_ordinal: 1 }];
    if (q.startsWith("INSERT INTO events") || q.startsWith("INSERT INTO outbox")) { const r = inserted(q, v); rows[r.table].push(r.row); return [r.row]; }
    if (q.startsWith("UPDATE record_heads") || q.startsWith("UPDATE worldlines")) return [{}];
    if (q.startsWith("UPDATE turn_runs")) { run = JSON.parse(String(v[8])); return [{}]; }
    if (q.startsWith("WITH record_committed_wakeup AS")) return [{}];
  });
  const bundle = { formalEvents: [{ eventId: scope.recordId, kind: "narration.committed", payload: { content: "same-token" } }],
    outbox: [{ messageId: "transport-message", topic: "record.events.committed", dedupeKey: "same-token", payload: { recordId: scope.recordId, eventIds: [scope.recordId] } }] };
  const result = await createPostgresRuntimeRepository({ pool: p.database as never, workspaceId: scope.workspaceId,
    mapFormalEvent: () => ({ sceneId: "scene", visibilityPolicyId: "policy", eventKind: "narration.committed", content: "same-token", actorParticipantId: null }),
  }).commitRelease({ turnId: "transport-turn", expectedRevision: 4, bundle, releaseFingerprint: createReleaseFingerprint(bundle), now: stamp });
  assert.equal(result.state, "completed");
  assert.deepEqual(rows.outbox[0].payload, { __realmRuntimePayload: bundle.outbox[0].payload });
  for (const row of rows.outbox) for (const key of ["event_id", "lease_owner", "lease_expires_at", "last_error_code", "last_error_message", "last_error_at"]) row[key] ??= null;
  assert.deepEqual(p.counts(), { acquired: 1, released: 1 }); return rows;
}
async function transport(events: Row[], outbox: Row[]) {
  const cursors = new Map<string, { bytes: Buffer; offset: number }>();
  const empty = new Set(["goal_instances", "goal_assessments", "action_receipts", "character_effects", "observations", "memory_conclusions", "memory_snapshots", "relationship_states", "record_first_nights", "record_self_play_sessions", "record_goal_definitions", "project_story_links", "projects", "project_milestones", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups", "obligations", "obligation_settlements", "story_node_instances", "story_unlock_ledger", "committed_fact_commands", "performance_assessments", "member_relationship_revisions", "character_assets"]);
  const p = protocol("reader", (q, v) => {
    if (q === A2_CAPABILITY_SQL) { assert.deepEqual(v, []); return [{ command_materializations_available: inheritedCommandPolicyFixture.schemaAvailable }]; }
    if (q === A2_MAP_SQL) { assert.deepEqual(v, [scope.workspaceId, scope.worldId, scope.worldlineId]); return inheritedCommandPolicyFixture.rows; }
    if (q === SCOPED_GOAL_EXPORT_REFUSAL_SQL) {
      assert.deepEqual(v, [scope.workspaceId, scope.worldId, scope.worldlineId, "story"]);
      return []; // This fixture persists Record Goal rows only; scoped rows are explicitly empty.
    }
    if (tx.has(q)) return [];
    if (q.includes("record.id AS record_id")) return [{ world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId, story_id: "story", world_version: "1.2.0", record_version: 1, next_record_ordinal: 2 }];
    if (q.startsWith("SELECT status FROM records")) return [{ status: "active" }];
    if (q.startsWith("SELECT role FROM player_world_memberships")) return [{ role: "owner" }];
    if (q.endsWith("AS mixed")) return [{ mixed: false }]; if (q.endsWith("AS bound")) return [{ bound: false }];
    if (q.startsWith("/* runtime event headers */")) return events.map(row => {
      const h: Row = { ...row, actor_is_null: row.actor_participant_id === null, payload_bytes: Buffer.byteLength(JSON.stringify(row.payload)) };
      for (const k of ["id", "event_kind", "speaker_name", "actor_participant_id", "scene_id", "visibility_policy_id", "calendar_id", "display_time", "content"]) {
        h[k + "_bytes"] = Buffer.byteLength(String(row[k] ?? "")); h[k + "_chars"] = String(row[k] ?? "").length;
      }
      if (Number(h.payload_bytes) > 256) h.payload = null; return h;
    });
    if (q.startsWith("/* runtime outbox headers;")) return outbox.map((row, i) => {
      const h: Row = { ...row, row_locator: `(0,${i + 1})` }; delete h.payload;
      for (const k of ["dedupe_key", "topic", "lease_owner", "last_error_code", "last_error_message"]) h[k + "_valid"] = true;
      for (const k of ["id", "event_id"]) { h[k + "_is_null"] = row[k] === null; h[k + "_chars"] = String(row[k] ?? "").length; h[k + "_bytes"] = Buffer.byteLength(String(row[k] ?? "")); }
      return h;
    });
    if (q.includes("payload cursor */ DECLARE")) {
      const name = /DECLARE (\w+)/.exec(q)![1];
      const row = q.includes("outbox payload") ? outbox[Number(/,(\d+)/.exec(String(v[4]))![1]) - 1] : events.find(r => r.record_ordinal === v[2])!;
      cursors.set(name, { bytes: Buffer.from(JSON.stringify(row.payload)), offset: 0 }); return [];
    }
    if (q.includes("FETCH FORWARD")) {
      const c = cursors.get(/FROM (\w+)$/.exec(q)![1])!; if (c.offset >= c.bytes.length) return [];
      const value = c.bytes.subarray(c.offset, c.offset + 65536); c.offset += value.length; return [{ value }];
    }
    if (q.startsWith("CLOSE ")) { assert.ok(cursors.delete(q.slice(6))); return []; }
    if (q.includes("FROM participants AS participant")) return [];
    if (q.includes("FROM scenes")) return [{ scene_id: "scene", title: "Scene", status: "active", location: "", objective: "", tension: "", weather: "", display_time: "", start_tick: 0, start_ordinal: 0, end_tick: null, end_ordinal: null }];
    if (q.includes("FROM visibility_policies")) return [{ policy_id: "policy", policy_key: "public", policy_version: 1, policy_kind: "public", scene_id: null, restricted_domain_id: null, private_character_instance_id: null, audience_character_instance_ids: [] }];
    if (empty.has(/\bFROM (\w+)/.exec(q)?.[1] ?? "")) return [];
  });
  const archive = await createPostgresRealmRuntimeSaveReader(p.database as never).load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose: "record-export" });
  assert.ok(archive); assert.equal(cursors.size, 0); assert.deepEqual(p.counts(), { acquired: 1, released: 1 });
  const bytes = buildRealmRuntimeSaveArchive(archive); assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), "PK");
  return parseRealmRuntimeSaveArchive(bytes);
}
function restorer() {
  const rows: Record<string, Row[]> = {};
  const allowed = new Set(["worldlines", "stories", "records", "participants", "scenes", "visibility_policies", "events", "record_heads", "outbox"]);
  const p = protocol("restore", (q, v) => {
    if (q === RESTORE_SCHEMA_PROBE) {
      assert.deepEqual(v, []);
      assert.equal(p.calls.filter(c => c.sql === RESTORE_SCHEMA_PROBE).length, 1);
      assert.equal(p.calls.filter(c => c.sql.startsWith("INSERT")).length, 0);
      return [];
    }
    if (tx.has(q)) return [];
    if (q.startsWith("SELECT world_version, status, settings FROM worlds")) return [{ world_version: "1.2.0", status: "active", settings: {} }];
    if (q.startsWith("SELECT role FROM player_world_memberships")) return [{ role: "owner" }];
    if (q.startsWith("SELECT record.world_id, record.worldline_id, record.story_id, record.status,")) {
      const r = rows.records?.find(r => r.id === v[1]); return r ? [{ world_id: r.world_id, worldline_id: r.worldline_id, story_id: r.story_id, status: r.status, story_premise: rows.stories.find(s => s.id === r.story_id)!.premise }] : [];
    }
    if (q.startsWith("INSERT INTO ")) { const r = inserted(q, v); assert.ok(allowed.has(r.table), `UNKNOWN_INSERT_TABLE:${r.table}`); (rows[r.table] ??= []).push(r.row); return [r.row]; }
  });
  const service = createPostgresRealmRuntimeSaveRestorer(p.database as never, { validateWorldBinding: async () => {} });
  return { rows, calls: p.calls, restore: (archive: RealmRuntimeSaveArchive, key = "transport-key") => service.restore({ workspaceId: scope.workspaceId, principalId: "owner", targetWorldId: scope.worldId, archive, idempotencyKey: key }) };
}
const object = (v: unknown) => { assert.ok(v && typeof v === "object" && !Array.isArray(v)); return v as Record<string, JsonValue>; };
async function saved() { const rows = await writer(); return transport(rows.events, rows.outbox); }
function message(a: RealmRuntimeSaveArchive): RealmRuntimeSaveOutboxMessageV1 { return a.outbox!.messages[0]; }
function replaceEnvelope(a: RealmRuntimeSaveArchive, envelope: Record<string, JsonValue>) {
  return { ...a, outbox: { ...a.outbox!, messages: [{ ...message(a), envelope }] } };
}
// This reaches the exact decoder used by the production worker, through its
// real claim method. SQL/state changes are simulated; no worker or PG is run.
function consumer(row: Row) {
  const p = protocol("decoder", (q, v) => {
    if (tx.has(q)) return [];
    if (q === listSQL) return row.turn_run_id === null ? [] : [row];
    const defaults = { lease_owner: null, lease_expires_at: null, published_at: null, last_error_code: null, last_error_message: null, last_error_at: null };
    if (q === lockedSQL) return [{ ...defaults, ...row }];
    if (q === claimSQL) return [{ ...defaults, ...row, state: "delivering", revision: Number(row.revision) + 1, attempt_count: Number(row.attempt_count) + 1, lease_owner: v[2], lease_expires_at: v[3], updated_at: v[4] }];
  });
  return createPostgresRuntimeRepository({ pool: p.database as never, workspaceId: scope.workspaceId,
    mapFormalEvent() { throw new Error("DECODER_CANNOT_WRITE_FORMAL_EVENTS"); } });
}
async function decode(row: Row) {
  return consumer(row).claimOutbox({ messageId: String(row.id), expectedRevision: Number(row.revision), leaseOwner: "decoder-probe", now: stamp, leaseExpiresAt: "2026-10-18T00:01:00.000Z" });
}

test("transport double refuses unknown SQL text and unhandled known SQL", async () => {
  assert.throws(() => validate("SELECT transport_unknown_critical_sql()"), /UNKNOWN_SQL_TEXT/);
  const p = protocol("unhandled", () => undefined); const c = await p.database.connect();
  await assert.rejects(c.query("BEGIN"), /UNKNOWN_SQL_PROTOCOL/); c.release();
});
test("actual writer → reader → ZIP → parse → restorer preserves wrapper, local typed IDs and fresh SQL", async () => {
  const a = await saved(), d = restorer(), r = await d.restore(a), row = d.rows.outbox[0];
  const body = object(object(row.payload).__realmRuntimePayload);
  assert.equal(body.recordId, r.recordId); assert.deepEqual(body.eventIds, [d.rows.events[0].id]); assert.notEqual(body.recordId, (body.eventIds as string[])[0]);
  assert.equal(row.record_id, r.recordId); assert.equal(row.event_id, null); assert.equal(row.turn_run_id, null);
  assert.equal(row.state, "pending"); assert.equal(row.revision, 0); assert.equal(row.attempt_count, 0);
  assert.equal(row.available_at, stamp); assert.match(d.calls.find(c => c.sql.startsWith("INSERT INTO outbox"))!.sql, /0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP/);
  for (const key of ["lease_owner", "lease_expires_at", "last_error_code", "last_error_message", "last_error_at"]) assert.equal(Object.hasOwn(row, key), false);
  assert.ok(String(row.dedupe_key).startsWith("restore:") && String(row.dedupe_key).endsWith(":same-token"));
  const decoded = await decode(row); assert.deepEqual(decoded.payload, body);
  console.log(JSON.stringify({ evidence: "PRODUCTION_JS_SQL_PROTOCOL_DOUBLE_NOT_PG", sourceEnvelope: message(a).envelope, restoredRow: row, decodedPayload: decoded.payload, PG: "NOT_RUN", automaticWorkerDiscovery: "EXCLUDED_BY_FROZEN_NULL_TURN_FILTER" }));
  assert.deepEqual(await consumer(row).listOutboxMessages(), [], "frozen production worker discovery excludes restored NULL turn_run_id");
});
test("wrapper body only: outer and nested metadata, ID-looking literals and duplicate anchors stay literal", async () => {
  const a = await saved(), body = { recordId: scope.recordId, eventIds: [scope.recordId], note: scope.recordId,
    metadata: { recordId: scope.recordId, eventIds: [scope.recordId] }, nested: { __realmRuntimePayload: { recordId: "foreign", eventIds: ["foreign"] } } };
  const outer = { recordId: "outer-literal", eventIds: ["foreign"], metadata: { recordId: scope.recordId }, __realmRuntimePayload: body };
  const archive = replaceEnvelope(a, outer), before = structuredClone(archive), d = restorer(), r = await d.restore(archive);
  const result = object(d.rows.outbox[0].payload), mapped = object(result.__realmRuntimePayload);
  assert.deepEqual(archive, before); assert.equal(result.recordId, "outer-literal"); assert.deepEqual(result.eventIds, ["foreign"]); assert.deepEqual(result.metadata, outer.metadata);
  assert.equal(mapped.recordId, r.recordId); assert.deepEqual(mapped.eventIds, [d.rows.events[0].id]);
  assert.equal(mapped.note, body.note); assert.deepEqual(mapped.metadata, body.metadata); assert.deepEqual(mapped.nested, body.nested);
  assert.deepEqual((await decode(d.rows.outbox[0])).payload, mapped);
});
for (const state of ["delivering", "retryable", "failed"] as const) test(`transport drops ${state} delivery history; same replay adds no INSERT and changed literal conflicts`, async () => {
  const a = await saved(), old = message(a); const archive = { ...a, outbox: { ...a.outbox!, messages: [{ ...old, state, deliveryAttempts: 9, nextAttemptAt: "2000-01-01T00:00:00.000Z", leaseOwner: state === "delivering" ? "old-worker" : null, leaseExpiresAt: state === "delivering" ? "2000-01-01T00:01:00.000Z" : null, lastErrorCode: "OLD", lastErrorMessage: "same-token", lastErrorAt: "2000-01-01T00:00:00.000Z", sourceEventId: scope.recordId }] } };
  const d = restorer(); await d.restore(archive); const row = d.rows.outbox[0];
  assert.equal(row.event_id, d.rows.events[0].id); assert.equal(row.available_at, stamp); assert.equal(row.attempt_count, 0); assert.equal(row.revision, 0); assert.equal(row.turn_run_id, null); assert.equal(row.state, "pending");
  for (const key of ["lease_owner", "lease_expires_at", "last_error_code", "last_error_message", "last_error_at"]) assert.equal(Object.hasOwn(row, key), false);
  const inserts = d.calls.filter(c => c.sql.startsWith("INSERT")).length;
  assert.equal((await d.restore(archive)).replayed, true); assert.equal(d.calls.filter(c => c.sql.startsWith("INSERT")).length, inserts);
  await assert.rejects(d.restore(replaceEnvelope(archive, { ...old.envelope, literal: "changed" })), { code: "RESTORE_CONFLICT" });
  assert.equal(d.calls.filter(c => c.sql.startsWith("INSERT")).length, inserts);
});
for (const body of [null, [], "same-token", 1, true, {}, { recordId: scope.recordId }, { eventIds: [scope.recordId] }, { recordId: 3, eventIds: [scope.recordId] }, { recordId: "foreign", eventIds: [scope.recordId] }, { recordId: scope.recordId, eventIds: "same-token" }, { recordId: scope.recordId, eventIds: [1] }, { recordId: scope.recordId, eventIds: ["foreign"] }] as JsonValue[]) {
  test(`malformed wrapper/anchors never fall back to valid outer body: ${JSON.stringify(body)}`, async () => {
    const a = replaceEnvelope(await saved(), { recordId: scope.recordId, eventIds: [scope.recordId], __realmRuntimePayload: body }), d = restorer();
    await assert.rejects(d.restore(a), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(d.calls.filter(c => c.sql.startsWith("INSERT")).length, 0);
  });
}
test("sourceEventId must belong to the same bundle before the first INSERT", async () => {
  const a = await saved(); const archive = { ...a, outbox: { ...a.outbox!, messages: [{ ...message(a), sourceEventId: "foreign" }] } }, d = restorer();
  await assert.rejects(d.restore(archive), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(d.calls.filter(c => c.sql.startsWith("INSERT")).length, 0);
});
for (const envelope of [{ __realmRuntimePayload: null, recordId: "foreign", eventIds: [1] }, { __realmRuntimePayload: { recordId: "foreign", eventIds: ["foreign"] }, recordId: scope.recordId }] as Record<string, JsonValue>[]) test(`custom topics retain arbitrary JSON: ${JSON.stringify(envelope)}`, async () => {
  const a = await saved(), d = restorer(); const archive = { ...a, outbox: { ...a.outbox!, messages: [{ ...message(a), topic: "custom.unknown.topic", envelope }] } };
  await d.restore(archive); assert.deepEqual(d.rows.outbox[0].payload, envelope);
});
test("historical flat acceptance preserves frozen transport semantics but runtime decoder rejects it", async () => {
  const a = replaceEnvelope(await saved(), { recordId: scope.recordId, eventIds: [scope.recordId], metadata: { recordId: scope.recordId } }), d = restorer();
  const r = await d.restore(a), payload = object(d.rows.outbox[0].payload); assert.equal(payload.recordId, r.recordId); assert.deepEqual(payload.eventIds, [d.rows.events[0].id]);
  assert.deepEqual(payload.metadata, { recordId: scope.recordId }); assert.equal(Object.hasOwn(payload, "__realmRuntimePayload"), false);
  await assert.rejects(decode(d.rows.outbox[0]), { code: "POSTGRES_RUNTIME_PAYLOAD_INVALID" });
});
test("root and child Outbox cannot borrow sibling anchors from the global typed map", async () => {
  const a = await saved();
  const childRecord = { ...a.record, scope: { ...a.record.scope, recordId: "child-record" }, events: a.record.events.map(e => ({ ...e, eventId: "child-event", payload: { ...object(e.payload), sceneId: "child-scene", visibilityPolicyId: "child-policy" } })) };
  const childTopology = { ...a.topology!, scenes: a.topology!.scenes.map(s => ({ ...s, sourceSceneId: "child-scene" })), visibilityPolicies: a.topology!.visibilityPolicies.map(p => ({ ...p, sourceVisibilityPolicyId: "child-policy" })) };
  const domain = { format: "realm-runtime-domain" as const, schemaVersion: 1 as const, source: { worldId: scope.worldId, worldlineId: scope.worldlineId, storyId: "story", recordId: scope.recordId }, stories: [{ id: "story", title: "Story", status: "active" as const, premise: "" }], storyDefinitions: [], records: [{ recordId: "child-record", storyId: "story", title: "Child", status: "active" as const, worldVersion: "1.2.0", startTick: 0, startOrdinal: 0, timelineKind: "branch" as const, linkedRecordId: scope.recordId, lastEventId: "child-event", lastWorldTick: 0, lastWorldOrdinal: 1, bundle: { record: childRecord, topology: childTopology, goals: a.goals, outbox: { ...a.outbox!, messages: [{ ...message(a), sourceMessageId: "child-message", sourceEventId: "child-event", envelope: { __realmRuntimePayload: { recordId: "child-record", eventIds: ["child-event"] } } }] } } }], projects: [], milestones: [], projectStoryLinks: [], budgetAllocations: [], financeAccounts: [], ledgerEntries: [], financeCommandGroups: [], obligations: [], obligationSettlements: [], storyNodes: [], storyUnlockLedger: [], committedFactCommands: [], performanceAssessments: [], memberRelationshipRevisions: [], characterAssets: [] };
  const original = { ...a, domain }; const archive = { ...original, manifest: realmRuntimeSaveManifestFromData({ ...original.manifest, ...original, engineApi: "1.x", mode: "world-bound", world: { worldId: scope.worldId, worldVersion: "1.2.0" }, scope: { workspaceId: scope.workspaceId, worldlineId: scope.worldlineId, recordId: scope.recordId } }) };
  const parsed = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive)), good = restorer(); await good.restore(parsed);
  assert.equal(good.rows.outbox.length, 2); assert.equal(good.rows.records.length, 2);
  for (const row of good.rows.outbox) { const b = object(object(row.payload).__realmRuntimePayload); assert.equal(b.recordId, row.record_id); assert.ok(good.rows.events.some(e => e.record_id === row.record_id && e.id === (b.eventIds as string[])[0])); }
  for (const side of ["root-body-event", "root-body-record", "root-source-event", "child-body-event", "child-body-record", "child-source-event"] as const) {
    const bad = structuredClone(parsed); const child = bad.domain!.records![0];
    const m = side.startsWith("root") ? message(bad) : child.bundle!.outbox!.messages[0];
    if (side.endsWith("source-event")) m.sourceEventId = side.startsWith("root") ? "child-event" : scope.recordId;
    else { const b = object(m.envelope.__realmRuntimePayload); if (side.endsWith("body-record")) b.recordId = side.startsWith("root") ? "child-record" : scope.recordId; else b.eventIds = [side.startsWith("root") ? "child-event" : scope.recordId]; }
    const d = restorer(); await assert.rejects(d.restore(bad), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(d.calls.filter(c => c.sql.startsWith("INSERT")).length, 0);
  }
});

// SCHEMA_PROBE_PROTOCOL: an admitted text still requires its restore lane.
test("schema probe is restore-only and runs once before the first target write", async () => {
  for (const lane of ["producer", "consumer", "unhandled", "reader", "writer", "decoder", "application-writer", "delivery"]) {
    const p = protocol(lane, () => undefined), c = await p.database.connect();
    await assert.rejects(c.query(RESTORE_SCHEMA_PROBE, []), /UNKNOWN_SQL_PROTOCOL/); c.release();
  }
  const p = protocol("restore", (q, v) => {
    if (q === RESTORE_SCHEMA_PROBE) { assert.deepEqual(v, []); return []; }
  }), c = await p.database.connect();
  assert.deepEqual(await c.query(RESTORE_SCHEMA_PROBE, []), { rows: [], rowCount: 0 });
  await assert.rejects(c.query(RESTORE_SCHEMA_PROBE, ["wrong"])); c.release();
});

test("A2 exact map and catalog texts still require explicit lane handlers", async () => {
  for (const lane of ["reader", "restore", "writer", "unhandled"]) {
    const p = protocol(lane, () => undefined), c = await p.database.connect();
    await assert.rejects(c.query(A2_MAP_SQL, [scope.workspaceId, scope.worldId, scope.worldlineId]), /UNKNOWN_SQL_PROTOCOL/);
    await assert.rejects(c.query(A2_CAPABILITY_SQL, []), /UNKNOWN_SQL_PROTOCOL/);
    c.release();
  }
});
