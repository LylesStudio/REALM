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
import { createPostgresDeliveryProjectionRepository } from "../database/postgres/delivery-projection.ts";
import { mapLocalFormalEvent } from "../modules/application/local-record-service.ts";
import type { FormalEventPayload } from "../modules/application/local-record-turn-runtime.ts";
import { fallbackCompositeSemanticSegments } from "../modules/presentation/semantic-segments.ts";
import { createReleaseFingerprint } from "../modules/runtime/public.ts";
import { type JsonValue } from "../modules/runtime/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData,
  type RealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";

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
const tx = new Set(["BEGIN", "BEGIN READ ONLY", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK", "SELECT set_config('realm.workspace_id', $1, true)"]);
// A text allowlist is not a SQL evaluator. Each admitted statement also needs
// an explicit lane handler below; an unhandled query never returns empty rows.
const RESTORE_SCHEMA_PROBE = "SELECT restore_delivery_kind FROM public.outbox WHERE false";
const staticSQL = new Set<string>([RESTORE_SCHEMA_PROBE, A2_MAP_SQL, A2_CAPABILITY_SQL]);
for (const file of ["realm-runtime-save-repository.ts", "world-write-gate.ts", "runtime-repository.ts", "workspace-transaction.ts", "delivery-projection.ts"]) {
  for (const m of readFileSync(new URL(`../database/postgres/${file}`, import.meta.url), "utf8").matchAll(/`([^`]*?)`/g)) {
    if (!m[1].includes("${") && /^(SELECT|INSERT|UPDATE|WITH)/.test(m[1].trim())) staticSQL.add(norm(m[1]));
  }
}
// Production uses quoted strings for these two capability calls.
staticSQL.add("SELECT record_goal_restore_group_prepare($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission");
staticSQL.add("SELECT record_goal_restore_group_definitions($1,$2,$3,$4,$5,$6::jsonb)");
staticSQL.add("WITH record_committed_wakeup AS ( SELECT pg_notify($5, $6) ) UPDATE command_inbox SET state = 'completed', result_event_ids = $3::text[], completed_at = $4::timestamptz, updated_at = $4::timestamptz, last_error_code = NULL WHERE workspace_id = $1 AND id = $2 AND EXISTS (SELECT 1 FROM record_committed_wakeup)");
function validate(sql: string) {
  if (sql === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE" || sql === "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE") return;
  if (tx.has(sql) || staticSQL.has(sql)) return;
  if ((["participants","scenes","visibility"] as const).some(f=>sql===norm(topologyHeaderSql(f)))) return;
  if (/^\/\* runtime event headers \*\/ SELECT /.test(sql) && sql.includes("FROM events WHERE workspace_id=$1 AND record_id=$2") && sql.endsWith("LIMIT 1000")) return;
  if (sql.startsWith("/* runtime outbox headers; outbox preflight; outbox bounded envelope */ SELECT ") && sql.includes("FROM outbox WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4") && sql.endsWith("LIMIT 1000")) return;
  if (/^\/\* runtime (event|outbox) payload cursor \*\/ DECLARE realm_(event|outbox)_payload_[a-f0-9]+ NO SCROLL CURSOR FOR /.test(sql) && sql.includes("AS MATERIALIZED")) return;
  if (/^\/\* runtime (event|outbox)( payload)? chunk \*\/ FETCH FORWARD 1 FROM realm_(event|outbox)_payload_[a-f0-9]+$/.test(sql)) return;
  if (/^CLOSE realm_(event|outbox)_payload_[a-f0-9]+$/.test(sql)) return;
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
    else if (term.startsWith("CASE WHEN $7 =")) row[column] = values[6] === "active" ? null : stamp;
    else throw new Error(`UNKNOWN_INSERT_TERM:${term}`);
  });
  return { table: m[1], row };
}
async function transport(events: Row[], participantRows: Row[] = participants()) {
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
    if (q.includes("record.id AS record_id")) return [{ world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId, story_id: "story", world_version: "1.2.0", record_version: 1, next_record_ordinal: events.length + 1 }];
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
    if (q.startsWith("/* runtime outbox headers;")) return [];
    if (q.includes("payload cursor */ DECLARE")) {
      const name = /DECLARE (\w+)/.exec(q)![1];
      const row = events.find(r => r.record_ordinal === v[2])!;
      cursors.set(name, { bytes: Buffer.from(JSON.stringify(row.payload)), offset: 0 }); return [];
    }
    if (q.includes("FETCH FORWARD")) {
      const c = cursors.get(/FROM (\w+)$/.exec(q)![1])!; if (c.offset >= c.bytes.length) return [];
      const value = c.bytes.subarray(c.offset, c.offset + 65536); c.offset += value.length; return [{ value }];
    }
    if (q.startsWith("CLOSE ")) { assert.ok(cursors.delete(q.slice(6))); return []; }
    if (q.includes("FROM record_goal_definitions")) return [];
    if (q.includes("FROM goal_instances")) return [];
    if (q.includes("FROM participants AS participant")) return participantRows;
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
  const allowed = new Set(["worldlines", "stories", "records", "participants", "scenes", "visibility_policies", "events", "record_heads", "outbox", "goal_instances", "record_goal_definitions", "character_definitions", "character_continuities", "character_instances", "memory_cache_epochs"]);
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
    // Capability protocol only: no SQL permission/FK/RLS simulation.
    if (q.startsWith("SELECT record_goal_restore_group_prepare(")) return [{ admission: { actor: "owner", planCommitment: "protocol-only" } }];
    if (q.startsWith("SELECT record_goal_restore_group_definitions(")) { (rows.record_goal_definitions ??= []).push(...JSON.parse(String(v[5])).map((definition: unknown) => ({ definition }))); return [{}]; }
    if (q.startsWith("INSERT INTO ")) { const r = inserted(q, v); assert.ok(allowed.has(r.table), `UNKNOWN_INSERT_TABLE:${r.table}`); (rows[r.table] ??= []).push(r.row); return [r.row]; }
  });
  const service = createPostgresRealmRuntimeSaveRestorer(p.database as never, { validateWorldBinding: async () => {} });
  return { rows, calls: p.calls, restore: (archive: RealmRuntimeSaveArchive, key = "transport-key") => service.restore({ workspaceId: scope.workspaceId, principalId: "owner", sessionProof: "protocol-proof-not-verified-by-double", targetWorldId: scope.worldId, archive, idempotencyKey: key }) };
}
const object = (v: unknown) => { assert.ok(v && typeof v === "object" && !Array.isArray(v)); return v as Record<string, JsonValue>; };

// The application mapper writes both a runtime body and outer recipient metadata.
function participants(): Row[] {
  return [{ participant_id: "same-token", participant_kind: "character", participant_character_instance_id: "character", participant_principal_id: null,
    participant_controller_mode: "ai", participant_is_active: true, participant_speaking_order: 0, participant_shared_control_enabled: false,
    instance_id: "character", instance_continuity_id: "continuity", instance_predecessor_id: null, instance_controller_mode: "ai", instance_status: "present",
    instance_instantiated_tick: 0, instance_instantiated_ordinal: 0, instance_inheritance_cutoff_tick: 0, instance_inheritance_cutoff_ordinal: 0,
    instance_retired_tick: null, instance_retired_ordinal: null, instance_state: {}, continuity_key: "continuity", continuity_status: "active",
    continuity_born_tick: 0, continuity_born_ordinal: 0, continuity_ended_tick: null, continuity_ended_ordinal: null,
    definition_id: "definition", definition_display_name: "Character", definition_source_format: "native", definition_profile: { note: "same-token" } },
  { participant_id: "recipient", participant_kind: "narrator", participant_principal_id: "owner", participant_controller_mode: "human",
    participant_is_active: true, participant_speaking_order: 1, participant_shared_control_enabled: false, instance_id: null }];
}
async function writer(narrator = false) {
  let run: Row = { turnId: "turn", command: { recordId: scope.recordId, expectedRecordVersion: 0, idempotencyKey: "turn-key", actorId: null,
    commandType: "player.utterance", payload: { runtimeScope: { sceneId: "scene", publicPolicyId: "policy", observerCharacterInstanceIds: [] } } },
    state: "releasing", revision: 4, attempts: { planning: 1, drafting: 1, validating: 1, releasing: 1 }, transitions: [], failures: [], updatedAt: stamp };
  const events: Row[] = [];
  const p = protocol("application-writer", (q, v) => {
    if (tx.has(q)) return [];
    if (q.startsWith("SELECT run_checkpoint FROM turn_runs")) return [{ run_checkpoint: run }];
    if (q.startsWith("SELECT world_id FROM records")) return [{ world_id: scope.worldId }];
    if (q.startsWith("SELECT status FROM worlds") || q.startsWith("SELECT status FROM records")) return [{ status: "active" }];
    if (q.includes("FROM records AS record") && q.includes("calendar_id")) return [{ world_id: scope.worldId, worldline_id: scope.worldlineId, calendar_id: "calendar", display_time: "" }];
    if (q.startsWith("SELECT head_tick, head_ordinal FROM worldlines")) return [{ head_tick: 0, head_ordinal: 0 }];
    if (q.startsWith("SELECT record_version, next_record_ordinal FROM record_heads")) return [{ record_version: 0, next_record_ordinal: 1 }];
    if (q.startsWith("INSERT INTO events")) { const r = inserted(q, v); events.push(r.row); return [r.row]; }
    if (q.startsWith("UPDATE record_heads") || q.startsWith("UPDATE worldlines")) return [{}];
    if (q.startsWith("UPDATE turn_runs")) { run = JSON.parse(String(v[8])); return [{}]; }
    if (q.startsWith("WITH record_committed_wakeup AS")) return [{}];
  });
  const payload: FormalEventPayload = { schemaVersion: 1, role: narrator ? "narrator" : "character", participantId: narrator ? null : "same-token",
    ...(narrator ? {} : { recipientId: "recipient" }), speaker: "same-token", content: "same-token", segments: fallbackCompositeSemanticSegments("same-token", narrator ? "story" : "dialogue") };
  const bundle = { formalEvents: [{ eventId: "same-token", kind: narrator ? "narration.committed" : "utterance.committed", payload }], outbox: [] };
  const repo = createPostgresRuntimeRepository({ workspaceId: scope.workspaceId, pool: p.database as never, mapFormalEvent: mapLocalFormalEvent });
  const result = await repo.commitRelease({ turnId: "turn", expectedRevision: 4, releaseFingerprint: createReleaseFingerprint(bundle), bundle, now: stamp });
  assert.equal(result.state, "completed"); assert.deepEqual(p.counts(), { acquired: 1, released: 1 }); return events;
}
function metadata(a: RealmRuntimeSaveArchive, child = false) {
  const record = child ? a.domain!.records![0].bundle!.record : a.record;
  return object(object(record.events[0].payload).eventPayload);
}
function body(a: RealmRuntimeSaveArchive, child = false) { const m = metadata(a, child); return Object.hasOwn(m, "__realmRuntimePayload") ? object(m.__realmRuntimePayload) : m; }
function rowBody(row: Row) { const m = object(row.payload); return Object.hasOwn(m, "__realmRuntimePayload") ? object(m.__realmRuntimePayload) : m; }
const zip = (a: RealmRuntimeSaveArchive) => parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ ...a,
  manifest: realmRuntimeSaveManifestFromData({ ...a, engineApi: "1.x", mode: "world-bound", world: { worldId: scope.worldId, worldVersion: "1.2.0" }, scope: { workspaceId: scope.workspaceId, worldlineId: scope.worldlineId, recordId: scope.recordId } }) }));
async function saved(narrator = false) { return transport(await writer(narrator), narrator ? [] : participants()); }
function writes(d: ReturnType<typeof restorer>) { return d.calls.filter(c => c.sql.startsWith("INSERT")).length; }
async function refused(a: RealmRuntimeSaveArchive) { const d = restorer(); await assert.rejects(d.restore(zip(a)), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(writes(d), 0); }

const projectionSource = readFileSync(new URL("../database/postgres/delivery-projection.ts", import.meta.url), "utf8");
function sqlConstant(name: string) { const m = new RegExp("const " + name + " = `([\\s\\S]*?)`;").exec(projectionSource); assert.ok(m); return m[1]; }
const eventsSql = norm(sqlConstant("EVENTS_SQL").replace("${EVENTS_AUTH_FROM_WHERE}", sqlConstant("EVENTS_AUTH_FROM_WHERE")));
const recentSql = norm(sqlConstant("RECENT_EVENTS_SQL").replace("${EVENTS_AUTH_FROM_WHERE}", sqlConstant("EVENTS_AUTH_FROM_WHERE")));
staticSQL.add(eventsSql); staticSQL.add(recentSql);
async function delivery(d: ReturnType<typeof restorer>) {
  const record = d.rows.records[0], story = d.rows.stories[0];
  const p = protocol("delivery", (q, v) => {
    if (tx.has(q)) return [];
    if (q.startsWith("SELECT record.id, record.title AS record_title,")) { assert.equal(v[0], scope.workspaceId); assert.equal(v[1], record.id); return [{ id: record.id, record_title: "Record", record_status: "active", scene_title: "Scene", location: "", objective: "", world_tick: 0, world_ordinal: 1, initial_display_time: "", weather: "", tension: "", world_id: scope.worldId, world_name: "World", era: "", style: "modern", world_language: "zh-CN", world_summary: "", worldline_id: record.worldline_id, story_id: story.id, story_title: "Story", story_status: "active", premise: "", omniscient_player_character: true, can_view_dynamic_knowledge: true, membership_role: "owner", controlled_character_instance_ids: [] }]; }
    if (q.startsWith("SELECT participant.id AS participant_id,")) return d.rows.participants.filter(x => x.participant_kind === "character").map(x => ({ participant_id: x.id, character_instance_id: x.character_instance_id, definition_id: "literal", display_name: "Character", role: "", summary: "", status: "present", controller_mode: x.controller_mode, is_active: x.is_active }));
    if (q === eventsSql || q === recentSql) {
      assert.equal(v[0], scope.workspaceId); assert.equal(v[1], record.id);
      const rows = d.rows.events.filter(e => e.record_id === record.id);
      if (q === recentSql) return rows.map(e => ({ speaker_name: e.speaker_name, content: e.content, display_time: e.display_time, actor_participant_id: e.actor_participant_id, recipient_id: object(e.payload).recipientId ?? null, policy_kind: "public" })).reverse();
      return rows.map(e => { const a = d.rows.participants.find(p => p.id === e.actor_participant_id); return { ...e, participant_kind: a?.participant_kind ?? null, controller_mode: a?.controller_mode ?? null, policy_kind: "public", recorded_at: stamp }; });
    }
    if (q.startsWith("SELECT story.id, story.title,") || q.startsWith("SELECT record.id, record.title, CASE WHEN $5::boolean")) return [];
  });
  const repo = createPostgresDeliveryProjectionRepository(p.database as never), viewer = { workspaceId: scope.workspaceId, recordId: String(record.id), principalId: "owner" };
  const projection = await repo.loadDeliveryForPlayer(viewer), recent = await repo.loadRecentAuthorizedEvents(viewer, 3); assert.ok(projection);
  assert.deepEqual(p.counts(), { acquired: 2, released: 2 }); return { projection, recent };
}

test("strict SQL protocol refuses unknown text and unhandled known query", async () => {
  assert.throws(() => validate("SELECT f5c_unknown_critical_sql()"), /UNKNOWN_SQL_TEXT/);
  const p = protocol("unhandled", () => undefined), c = await p.database.connect(); await assert.rejects(c.query("BEGIN"), /UNKNOWN_SQL_PROTOCOL/); c.release();
});
const anchors = [["P1", "participantId", false], ["P2", "recipientId", false], ["P3", "recipientId", true]] as const;
for (const [id, field, outer] of anchors) test(`${id} actual application writer maps ${outer ? "outer" : "body"}.${field} in Participant namespace`, async () => {
  const a = await saved(), before = structuredClone(a), d = restorer(); await d.restore(a); const e = d.rows.events[0];
  const target = d.rows.participants[field === "participantId" ? 0 : 1].id;
  assert.equal(e.actor_participant_id, d.rows.participants[0].id); assert.notEqual(e.actor_participant_id, e.id); assert.notEqual(e.actor_participant_id, d.rows.records[0].id);
  assert.equal((outer ? object(e.payload) : rowBody(e))[field], target); assert.deepEqual(a, before);
});
for (const [i, [, field, outer]] of anchors.entries()) test(`P${i + 4} independent foreign ${outer ? "outer" : "body"}.${field} refuses before INSERT`, async () => {
  const a = await saved(); (outer ? metadata(a) : body(a))[field] = "foreign-participant"; await refused(a);
});
test("P7 actual narrator null participant and omitted recipient stay compatible", async () => {
  const a = await saved(true), d = restorer(); await d.restore(a); const e = d.rows.events[0]; assert.equal(e.actor_participant_id, null);
  assert.equal(rowBody(e).participantId, null); assert.equal(Object.hasOwn(rowBody(e), "recipientId"), false); assert.equal(Object.hasOwn(object(e.payload), "recipientId"), false);
});
test("P8 content/speaker, nested metadata, outer presentation and other anchors stay literal", async () => {
  const a = await saved(), literal = { participantId: "foreign", recipientId: "foreign" };
  body(a).metadata = literal; body(a).presence = { characterInstanceId: "foreign" }; body(a).profileUpdate = literal; body(a).actionTransaction = literal;
  metadata(a).metadata = literal; metadata(a).participantId = "foreign";
  const presentation = structuredClone(metadata(a).presentation), segments = structuredClone(body(a).segments), d = restorer(); await d.restore(zip(a));
  const e = d.rows.events[0], b = rowBody(e); assert.equal(b.content, "same-token"); assert.equal(b.speaker, "same-token"); assert.deepEqual(b.metadata, literal);
  assert.deepEqual(b.presence, { characterInstanceId: "foreign" }); assert.deepEqual(b.profileUpdate, literal); assert.deepEqual(b.actionTransaction, literal);
  assert.deepEqual(b.segments, segments); assert.deepEqual(object(e.payload).presentation, presentation); assert.deepEqual(object(e.payload).metadata, literal); assert.equal(object(e.payload).participantId, "foreign");
});
test("P9 production delivery and recent authorized adapter read target speaker and recipient", async () => {
  const d = restorer(); await d.restore(await saved()); const { projection, recent } = await delivery(d);
  for (const e of [projection.record.events[0], recent[0]]) { assert.equal(e.speakerParticipantId, d.rows.participants[0].id); assert.equal(e.recipientId, d.rows.participants[1].id); }
});
for (const kind of ["utterance.committed", "narration.committed"]) for (const [, field, outer] of anchors) for (const value of [0, false, [], {}, "", "foreign"] as JsonValue[]) test(`${kind} malformed ${outer ? "outer" : "body"}.${field}=${JSON.stringify(value)} fails closed`, async () => {
  const a = await saved(); a.record.events[0].kind = kind; (outer ? metadata(a) : body(a))[field] = value; await refused(a);
});
for (const field of ["participantId", "recipientId"]) test(`legacy flat foreign ${field} also fails before INSERT`, async () => {
  const a = await saved(); object(a.record.events[0].payload).eventPayload = structuredClone(body(a)); body(a)[field] = "foreign"; await refused(a);
});
for (const kind of ["utterance.committed", "narration.committed"]) for (const mode of ["omitted", "null", "flat", "empty", "metadata-only"] as const) test(`${kind} legacy ${mode} stays compatible`, async () => {
  const a = await saved(); a.record.events[0].kind = kind;
  if (mode === "omitted") { delete body(a).participantId; delete body(a).recipientId; delete metadata(a).recipientId; }
  if (mode === "null") { body(a).participantId = null; body(a).recipientId = null; metadata(a).recipientId = null; }
  if (mode === "flat") object(a.record.events[0].payload).eventPayload = structuredClone(body(a));
  if (mode === "empty") object(a.record.events[0].payload).eventPayload = {};
  if (mode === "metadata-only") object(a.record.events[0].payload).eventPayload = { schemaVersion: 1, note: "legacy metadata without body" };
  const original = structuredClone(metadataOrNull(a)), d = restorer(); await d.restore(zip(a));
  if (mode === "flat") { assert.equal(rowBody(d.rows.events[0]).participantId, d.rows.participants[0].id); assert.equal(rowBody(d.rows.events[0]).recipientId, d.rows.participants[1].id); }
  else assert.deepEqual(d.rows.events[0].payload, original);
});
function metadataOrNull(a: RealmRuntimeSaveArchive) { return object(a.record.events[0].payload).eventPayload; }
for (const value of [null, false, 1, "", []] as JsonValue[]) test(`own malformed wrapper ${JSON.stringify(value)} never falls back to outer`, async () => {
  const a = await saved(); metadata(a).__realmRuntimePayload = value; metadata(a).participantId = "same-token"; await refused(a);
});
test("wrapper body is one schema level; nested same-name wrapper stays literal", async () => {
  const a = await saved(); body(a).__realmRuntimePayload = { participantId: "foreign", recipientId: 123 }; const d = restorer(); await d.restore(zip(a));
  assert.deepEqual(rowBody(d.rows.events[0]).__realmRuntimePayload, { participantId: "foreign", recipientId: 123 });
});
test("historical independent actor/recipient claims are transported without a new consistency rule", async () => {
  const a = await saved(); body(a).participantId = "recipient"; body(a).recipientId = "same-token"; const d = restorer(); await d.restore(zip(a));
  assert.equal(d.rows.events[0].actor_participant_id, d.rows.participants[0].id); assert.equal(rowBody(d.rows.events[0]).participantId, d.rows.participants[1].id);
  assert.equal(rowBody(d.rows.events[0]).recipientId, d.rows.participants[0].id); assert.equal(object(d.rows.events[0].payload).recipientId, d.rows.participants[1].id);
});
for (const kind of ["goal.transition.committed", "action.transaction.committed"]) test(`${kind} same-named Participant literals are outside this schema`, async () => {
  const a = await saved(); a.record.events[0].kind = kind; const literal = { participantId: "foreign", recipientId: false, __realmRuntimePayload: { participantId: "foreign", recipientId: 1 } };
  object(a.record.events[0].payload).eventPayload = literal; const d = restorer(); await d.restore(zip(a)); assert.deepEqual(d.rows.events[0].payload, literal);
});
test("same key/body replay adds no INSERT; changed body and outer literals conflict", async () => {
  const a = await saved(), d = restorer(); await d.restore(a); const n = writes(d); assert.equal((await d.restore(a)).replayed, true); assert.equal(writes(d), n);
  for (const outer of [false, true]) { const bad = structuredClone(a); (outer ? metadata(bad) : body(bad)).note = "changed"; await assert.rejects(d.restore(zip(bad)), { code: "RESTORE_CONFLICT" }); assert.equal(writes(d), n); }
});
async function siblings() {
  const a = await saved(), child = structuredClone(a.record); child.scope.recordId = "child-record";
  child.events = child.events.map(e => ({ ...e, eventId: `child-${e.eventId}`, payload: { ...object(e.payload), actorParticipantId: "child-actor", sceneId: "child-scene", visibilityPolicyId: "child-policy" } }));
  const m = object(object(child.events[0].payload).eventPayload); m.recipientId = "child-recipient"; object(m.__realmRuntimePayload).participantId = "child-actor"; object(m.__realmRuntimePayload).recipientId = "child-recipient";
  const topology = { ...a.topology!, participants: a.topology!.participants.map((p, i) => ({ ...p, sourceParticipantId: i ? "child-recipient" : "child-actor", character: null, participantKind: "narrator" as const, sourcePrincipalId: "owner" })),
    scenes: a.topology!.scenes.map(s => ({ ...s, sourceSceneId: "child-scene" })), visibilityPolicies: a.topology!.visibilityPolicies.map(p => ({ ...p, sourceVisibilityPolicyId: "child-policy", policyKind: "dm_only" as const })) };
  const domain = { format: "realm-runtime-domain" as const, schemaVersion: 1 as const, source: { worldId: scope.worldId, worldlineId: scope.worldlineId, storyId: "story", recordId: scope.recordId }, stories: [{ id: "story", title: "Story", status: "active" as const, premise: "" }], storyDefinitions: [],
    records: [{ recordId: "child-record", storyId: "story", title: "Child", status: "active" as const, worldVersion: "1.2.0", startTick: 0, startOrdinal: 0, timelineKind: "branch" as const, linkedRecordId: scope.recordId, lastEventId: "child-same-token", lastWorldTick: 0, lastWorldOrdinal: 1, bundle: { record: child, topology, goals: { ...a.goals, instances: [] } } }],
    projects: [], milestones: [], projectStoryLinks: [], budgetAllocations: [], financeAccounts: [], ledgerEntries: [], financeCommandGroups: [], obligations: [], obligationSettlements: [], storyNodes: [], storyUnlockLedger: [], committedFactCommands: [], performanceAssessments: [], memberRelationshipRevisions: [], characterAssets: [] };
  return zip({ ...a, domain });
}
test("root and private carried sibling use their own Participant anchors", async () => {
  const d = restorer(); await d.restore(await siblings()); assert.equal(d.rows.records.length, 2);
  for (const record of d.rows.records) { const e = d.rows.events.find(e => e.record_id === record.id)!, ps = d.rows.participants.filter(p => p.record_id === record.id);
    assert.equal(rowBody(e).participantId, ps[0].id); assert.equal(rowBody(e).recipientId, ps[1].id); assert.equal(object(e.payload).recipientId, ps[1].id); }
});
for (const child of [false, true]) for (const [, field, outer] of anchors) test(`${child ? "child" : "root"} cannot borrow global sibling ${outer ? "outer" : "body"}.${field}`, async () => {
  const a = await siblings(); (outer ? metadata(a, child) : body(a, child))[field] = child ? "same-token" : "child-actor"; await refused(a);
});
test("duplicate Participant source token across Records retains global uniqueness rejection", async () => {
  const a = await siblings(); a.domain!.records![0].bundle!.topology!.participants[0].sourceParticipantId = "same-token";
  assert.throws(() => zip(a), { code: "INVALID_SAVE" });
  const d = restorer(); await assert.rejects(d.restore(a), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(writes(d), 0);
});
test("legacy projection still requires an eventPayload object", async () => {
  const a = await saved(); object(a.record.events[0].payload).eventPayload = null; await refused(a);
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
