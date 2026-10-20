import { createHash } from "node:crypto";
import { createGoalContentBindingSource, bindGoalContentWitness } from "../modules/application/goal-content-binding-source.ts";
import { computeRealmWorldContentHash } from "../modules/world-transfer/realmworld-loader.ts";
import { LOAD_GOAL_CONTENT_BINDING_SQL } from "../database/postgres/goal-content-binding-repository.ts";
import { GOAL_RESTORE_TARGET_CAPABILITY_SQL, INSERT_RESTORED_GOAL_V2_SQL } from "../database/postgres/runtime-goal-restore.ts";
import type { GoalInstanceV2, RealmRuntimeSaveGoalsV2 } from "../modules/world-transfer/realm-runtime-goals-v2.ts";
import type { GoalOwner } from "../modules/goals/content-binding.ts";
import { GOAL_TRANSPORT_CAPABILITY_SQL, LOAD_TRANSPORT_GOALS_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { evidenceHeaderSql } from "../database/postgres/runtime-evidence-resource-reader.ts";
// Exact A2 reader protocol; these inherited fixtures explicitly have no installed policy.

// Capability is explicit per fixture: source-bound positives negotiate V2; generic probes retain the pre-0083 lane.
// Empty Evidence families are modelled separately from all payload cursors.
function createLegacyEmptyReaderProbe(recordIds: readonly string[], schemaAvailable = false) {
  const cursors = new Set<string>();
  const normalize = (sql:string) => sql.replace(/\s+/g," ").trim();
  return Object.assign((raw:string, values:unknown[]): Record<string,unknown>[] | undefined => {
    const sql=normalize(raw);
    if(sql===normalize(GOAL_TRANSPORT_CAPABILITY_SQL)) {
      assert.deepEqual(values,[]); return [{available:schemaAvailable}];
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
import { createRecordGoalDefinition } from "../modules/goals/record-authoring.ts";
import { type JsonValue } from "../modules/runtime/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData,
  type RealmRuntimeSaveArchive, type RealmRuntimeSaveGoals } from "../modules/world-transfer/realm-runtime-save.ts";

type Row = Record<string, unknown>;
type Archive = RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>;

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
// This is a server-injected immutable mount fixture, not a signature/PG proof.
// Bind at fixture creation, before any reader call; never infer an old binding
// from the current catalog or turn an unbound historical row into authority.
const goalSourceBytes=JSON.stringify({format:"realmworld-goals",schemaVersion:1,
  goals:["old-goal","same-token","child-old","child-next","retry"].map(goalKey=>({goalKey,policyVersion:"content:v1",
    mode:"deterministic",visible:true,retryable:true,
    rubric:{kind:"event_count",eventKind:"narration.committed",progressKey:"count",threshold:1},outcome:{}}))});
const goalSourceHash=computeRealmWorldContentHash(new Map([["content/goals.json",Buffer.from(goalSourceBytes)]]));
const resolveGoalSource=createGoalContentBindingSource({mount:async identity=>{
  assert.deepEqual(identity,{worldId:scope.worldId,worldVersion:"1.2.0"});
  const files=new Map([["content/goals.json",Buffer.from(goalSourceBytes)]]);
  assert.equal(computeRealmWorldContentHash(files),goalSourceHash);
  return {manifest:{format:"realmworld",formatVersion:1,worldId:scope.worldId,worldVersion:"1.2.0",
    engineCompat:{schemaLatest:"",requiresMigrations:[],baseRange:"*"},contentHash:goalSourceHash,
    signature:{algorithm:"ed25519",keyId:"injected-server-fixture",value:""}},files};
}});
async function boundGoal(g:ReturnType<typeof goal>,recordId=scope.recordId):Promise<GoalInstanceV2> {
  const owner:GoalOwner={scopeKind:"record",worldId:scope.worldId,worldlineId:scope.worldlineId,recordId};
  const witness=await resolveGoalSource({worldId:scope.worldId,worldVersion:"1.2.0",goalKey:g.goalKey});
  const binding=bindGoalContentWitness(witness,scope.workspaceId,owner,g.id);
  return {ref:{owner,instanceId:g.id},goalKey:g.goalKey,definition:{kind:"content",binding},
    state:g.state as GoalInstanceV2["state"],revision:g.revision,progress:g.progress,outcome:g.outcome,
    policyVersion:g.policyVersion,attempt:g.attempt,predecessor:g.supersedesInstanceId===null?null:
      {kind:"retry",ref:{owner,instanceId:g.supersedesInstanceId}},resolutionKind:"natural",evidenceStart:{recordVersion:0,ordinal:0}};
}
function typedGoals(a:Archive):RealmRuntimeSaveGoalsV2 {
  assert.equal(a.goals.schemaVersion,2);return a.goals as RealmRuntimeSaveGoalsV2;
}
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
const staticSQL = new Set<string>([RESTORE_SCHEMA_PROBE, A2_MAP_SQL, A2_CAPABILITY_SQL,
  norm(LOAD_TRANSPORT_GOALS_SQL),norm(LOAD_GOAL_CONTENT_BINDING_SQL),norm(GOAL_RESTORE_TARGET_CAPABILITY_SQL),norm(INSERT_RESTORED_GOAL_V2_SQL),
  "SELECT record_goal_restore_group_prepare_v2($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission",
  "SELECT record_goal_restore_group_replay_v2($1,$2,$3,$4,$5,$6::jsonb) AS actor",
  "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission",
  "SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)"]);
for (const file of ["realm-runtime-save-repository.ts", "world-write-gate.ts"]) {
  for (const m of readFileSync(new URL(`../database/postgres/${file}`, import.meta.url), "utf8").matchAll(/`([^`]*?)`/g)) {
    if (!m[1].includes("${") && /^(SELECT|INSERT|UPDATE)/.test(m[1].trim())) staticSQL.add(norm(m[1]));
  }
}
// Production uses quoted strings for these two capability calls.
staticSQL.add("SELECT record_goal_restore_group_prepare($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission");
staticSQL.add("SELECT record_goal_restore_group_definitions($1,$2,$3,$4,$5,$6::jsonb)");
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
function protocol(lane: string, handler: (sql: string, values: unknown[]) => Row[] | undefined, schemaAvailable=false) {
  const readerProbe=createLegacyEmptyReaderProbe([scope.recordId],schemaAvailable);
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
    else if (term === "CASE WHEN $9='active' THEN NULL ELSE CURRENT_TIMESTAMP END") row[column]=values[8]==="active"?null:stamp;
    else throw new Error(`UNKNOWN_INSERT_TERM:${term}`);
  });
  return { table: m[1], row };
}
async function transport(events: Row[], goalRows: Row[], definitions: unknown[] = []) {
  const contentRows=goalRows.filter(g=>g.definition_source!=="record");
  const bound=await Promise.all(contentRows.map(g=>boundGoal({id:String(g.id),goalKey:String(g.goal_key),state:String(g.state),
    revision:Number(g.revision),progress:g.progress as Record<string,JsonValue>,outcome:null,policyVersion:String(g.policy_version),
    attempt:Number(g.attempt),supersedesInstanceId:null})));
  const cursors = new Map<string, { bytes: Buffer; offset: number }>();
  const empty = new Set(["goal_instances", "goal_assessments", "action_receipts", "character_effects", "observations", "memory_conclusions", "memory_snapshots", "relationship_states", "record_first_nights", "record_self_play_sessions", "record_goal_definitions", "project_story_links", "projects", "project_milestones", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups", "obligations", "obligation_settlements", "story_node_instances", "story_unlock_ledger", "committed_fact_commands", "performance_assessments", "member_relationship_revisions", "character_assets"]);
  const p = protocol("reader", (q, v) => {
    if(q===norm(LOAD_TRANSPORT_GOALS_SQL)) {
      assert.deepEqual(v,[scope.workspaceId,scope.worldId,scope.worldlineId,["story"],[scope.recordId]]);
      return goalRows.map(g=>({...g,scope_kind:"record",record_id:scope.recordId,story_id:null,definition_source:g.definition_source??"content",
        definition_id:g.definition_id??null,resolution_kind:g.resolution_kind??"natural",evidence_start_version:0,evidence_start_ordinal:0}));
    }
    if(q===norm(LOAD_GOAL_CONTENT_BINDING_SQL)) {
      assert.equal(v.length,2);assert.equal(v[0],scope.workspaceId);
      return bound.filter(g=>g.ref.instanceId===v[1]).map(g=>({binding:g.definition.kind==="content"?g.definition.binding:assert.fail()}));
    }
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
    if (q.includes("FROM record_goal_definitions")) return definitions.map(definition => ({ definition }));
    if (q.includes("FROM goal_instances")) return goalRows;
    if (q.includes("FROM participants AS participant")) return [];
    if (q.includes("FROM scenes")) return [{ scene_id: "scene", title: "Scene", status: "active", location: "", objective: "", tension: "", weather: "", display_time: "", start_tick: 0, start_ordinal: 0, end_tick: null, end_ordinal: null }];
    if (q.includes("FROM visibility_policies")) return [{ policy_id: "policy", policy_key: "public", policy_version: 1, policy_kind: "public", scene_id: null, restricted_domain_id: null, private_character_instance_id: null, audience_character_instance_ids: [] }];
    if (empty.has(/\bFROM (\w+)/.exec(q)?.[1] ?? "")) return [];
  },true);
  const archive = await createPostgresRealmRuntimeSaveReader(p.database as never,{goalsSchemaVersion:2,resolveGoalSource}).load({ workspaceId: scope.workspaceId, recordId: scope.recordId, principalId: "owner", purpose: "record-export" });
  assert.ok(archive); assert.equal(cursors.size, 0); assert.deepEqual(p.counts(), { acquired: 1, released: 1 });
  const bytes = buildRealmRuntimeSaveArchive(archive); assert.equal(Buffer.from(bytes).subarray(0, 2).toString(), "PK");
  return parseRealmRuntimeSaveArchive(bytes,{goalsSchemaVersion:2});
}
function restorer() {
  const rows: Record<string, Row[]> = {};
  const groups=new Map<string,{body:unknown;plan:Row}>();
  let activeGroup:{root:string;body:unknown;plan:Row}|null=null;
  const allowed = new Set(["worldlines", "stories", "records", "participants", "scenes", "visibility_policies", "events", "record_heads", "outbox", "goal_instances", "record_goal_definitions"]);
  const p = protocol("restore", (q, v) => {
    if (q === RESTORE_SCHEMA_PROBE) {
      assert.deepEqual(v, []);
      assert.equal(p.calls.filter(c => c.sql === RESTORE_SCHEMA_PROBE).length, 1);
      assert.equal(p.calls.filter(c => c.sql.startsWith("INSERT")).length, 0);
      return [];
    }
    if (tx.has(q)) {
      if(q==="COMMIT"&&activeGroup){groups.set(activeGroup.root,activeGroup);activeGroup=null;}
      if(q==="ROLLBACK")activeGroup=null;
      return [];
    }
    if(q===norm(GOAL_RESTORE_TARGET_CAPABILITY_SQL)){assert.deepEqual(v,[]);return [{available:true}];}
    if(q==="SELECT record_goal_restore_group_prepare_v2($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission") {
      assert.deepEqual(v.slice(0,3),[scope.workspaceId,"protocol-proof-not-verified-by-double",scope.worldId]);
      assert.equal(v.length,7);assert.equal(p.calls.some(c=>c.sql.startsWith("INSERT")),false);
      const plan=JSON.parse(String(v[6]));assert.equal(plan.bodyVersion,2);
      assert.equal(v[5],createHash("sha256").update("realm-runtime-restore-body:v2:").update(plan.sourceBody).digest("hex"));
      activeGroup={root:String(v[3]),body:v[5],plan};
      return [{admission:{actor:"owner",planCommitment:"a".repeat(64)}}];
    }
    if(q==="SELECT record_goal_restore_group_replay_v2($1,$2,$3,$4,$5,$6::jsonb) AS actor") {
      assert.deepEqual(v.slice(0,3),[scope.workspaceId,"protocol-proof-not-verified-by-double",scope.worldId]);
      const group=groups.get(String(v[3]));assert.ok(group);assert.equal(group.body,v[4]);
      assert.deepEqual(group.plan,JSON.parse(String(v[5])));return [{actor:"owner"}];
    }
    if(q==="SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission") {
      assert.deepEqual(v.slice(0,4),[scope.workspaceId,"protocol-proof-not-verified-by-double","restore-v2",activeGroup?.body]);
      const plan=JSON.parse(String(v[4]));assert.equal(plan.restoreGroupRoot,activeGroup?.root);
      assert.equal(plan.operation,"restore-v2");assert.equal(plan.worldId,scope.worldId);
      return [{admission:{actor:"owner",planCommitment:"b".repeat(64)}}];
    }
    if(q==="SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") {
      assert.deepEqual(v.slice(0,4),[scope.workspaceId,"protocol-proof-not-verified-by-double",activeGroup?.body,"b".repeat(64)]);
      for(const binding of JSON.parse(String(v[4]))) {
        assert.ok(rows.goal_instances.some(g=>g.id===binding.instanceId&&g.record_id===binding.owner.recordId));
        (rows.bindings??=[]).push({binding});
      }
      return [];
    }
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
  const service = createPostgresRealmRuntimeSaveRestorer(p.database as never, { goalsSchemaVersion:2,resolveGoalSource,validateWorldBinding: async () => {} });
  return { rows, calls: p.calls, restore: (archive: Archive, key = "transport-key") => service.restore({ workspaceId: scope.workspaceId, principalId: "owner", sessionProof: "protocol-proof-not-verified-by-double", targetWorldId: scope.worldId, archive, idempotencyKey: key }) };
}
const object = (v: unknown) => { assert.ok(v && typeof v === "object" && !Array.isArray(v)); return v as Record<string, JsonValue>; };

const goal = (id: string, state = "active") => ({ id, goalKey: id, state, revision: 1, progress: {}, outcome: null,
  policyVersion: "content:v1", attempt: 1, supersedesInstanceId: null as string|null });
const goalRow = (g: ReturnType<typeof goal>) => ({ id: g.id, goal_key: g.goalKey, state: g.state, revision: g.revision,
  progress: g.progress, outcome: g.outcome, policy_version: g.policyVersion, attempt: g.attempt, supersedes_instance_id: g.supersedesInstanceId });
function eventRow(id: string, ordinal: number, body: JsonValue, kind = "goal.transition.committed"): Row {
  return { id, record_version: 1, record_ordinal: ordinal, event_kind: kind, payload: body, content: "same-token", speaker_name: "",
    actor_participant_id: null, scene_id: "scene", visibility_policy_id: "policy", world_tick: 0, world_ordinal: ordinal, calendar_id: "calendar", display_time: "" };
}
// These are the exact declared payload fields produced by 0070/0072 SQL.
// Only the reader, ZIP, parser and restorer execute here; SQL writers do not.
const reviseBody = () => ({ operation: "revise", goalInstanceId: "old-goal", successorGoalInstanceId: "same-token",
  goalKey: "same-token", from: "active", to: "settled", revision: 2, resolutionKind: "superseded", actorPrincipalId: "same-token" });
const evolveBody = () => ({ operation: "evolve", goalInstanceId: "old-goal", successorGoalInstanceId: "same-token",
  predecessorGoalInstanceId: "old-goal", goalKey: "same-token", from: "active", to: "settled", revision: 2,
  resolutionKind: "superseded", definitionVersion: 2, reason: "same-token", basisEventIds: ["same-token", "basis-two"] });
async function saved(body: Record<string, JsonValue> = evolveBody(), wrapped = true) {
  return transport([eventRow("same-token", 1, {}, "narration.committed"), eventRow("basis-two", 2, {}, "narration.committed"),
    eventRow("transition", 3, wrapped ? { __realmRuntimePayload: body } : body)], [goalRow(goal("old-goal", "settled")), goalRow(goal("same-token"))]);
}
function bodyOf(a: Archive, child = false) {
  const record = child ? a.domain!.records![0].bundle!.record : a.record;
  const payload = object(object(record.events.at(-1)!.payload).eventPayload);
  return Object.hasOwn(payload, "__realmRuntimePayload") ? object(payload.__realmRuntimePayload) : payload;
}
function rowBody(row: Row) { const p = object(row.payload); return Object.hasOwn(p, "__realmRuntimePayload") ? object(p.__realmRuntimePayload) : p; }
const zip = (a: Archive) => parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ ...a,
  manifest: realmRuntimeSaveManifestFromData({ ...a, engineApi: "1.x", mode: "world-bound", world: { worldId: scope.worldId, worldVersion: "1.2.0" }, scope: { workspaceId: scope.workspaceId, worldlineId: scope.worldlineId, recordId: scope.recordId } }) }),{goalsSchemaVersion:2});
function writes(d: ReturnType<typeof restorer>) { return d.calls.filter(c => c.sql.startsWith("INSERT")).length; }
async function refused(a: Archive) { const d = restorer(); await assert.rejects(d.restore(zip(a)), { code: "RUNTIME_SAVE_INVALID" }); assert.equal(writes(d), 0); }

test("strict Goal SQL double rejects unknown text and unhandled known query", async () => {
  assert.throws(() => validate("SELECT f5b_unknown_critical_sql()"), /UNKNOWN_SQL_TEXT/);
  const p = protocol("unhandled", () => undefined), c = await p.database.connect();
  await assert.rejects(c.query("BEGIN"), /UNKNOWN_SQL_PROTOCOL/); c.release();
});
for (const field of ["successorGoalInstanceId", "predecessorGoalInstanceId", "basisEventIds"] as const) {
  test(`independent writer-shaped anchor maps: ${field}`, async () => {
    const body: Record<string, JsonValue> = { goalInstanceId: "old-goal", [field]: field === "basisEventIds" ? ["same-token"] : "same-token" };
    const a = await saved(body), before = structuredClone(a), d = restorer(); await d.restore(a);
    const b = rowBody(d.rows.events.at(-1)!);
    const target = field === "basisEventIds" ? [d.rows.events[0].id] : d.rows.goal_instances.find(g => g.goal_key === "same-token")!.id;
    assert.deepEqual(b[field], target); assert.deepEqual(a, before);
    assert.notEqual(d.rows.events[0].id, d.rows.goal_instances.find(g => g.goal_key === "same-token")!.id);
  });
}
for (const [name, body] of [["0070 revise", reviseBody()], ["0072 active evolution", evolveBody()],
  ["0072 natural terminal evolution", { ...evolveBody(), goalInstanceId: "same-token", from: null, to: "active", revision: 1, resolutionKind: null }]] as const) {
  test(`${name} reader → real ZIP → parser → restorer preserves all anchors and literals`, async () => {
    const literal = { successorGoalInstanceId: "same-token", predecessorGoalInstanceId: "old-goal", basisEventIds: ["same-token"] };
    const a = await saved({ ...body, metadata: literal, progress: literal, outcome: literal });
    const payload = object(object(a.record.events.at(-1)!.payload).eventPayload); payload.metadata = literal;
    const d = restorer(); await d.restore(zip(a)); const row = d.rows.events.at(-1)!, b = rowBody(row);
    const target = (key: string) => d.rows.goal_instances.find(g => g.goal_key === key)!.id;
    assert.equal(b.goalInstanceId, target(String(body.goalInstanceId))); assert.equal(b.successorGoalInstanceId, target("same-token"));
    if ("predecessorGoalInstanceId" in body) { assert.equal(b.predecessorGoalInstanceId, target("old-goal")); assert.deepEqual(b.basisEventIds, d.rows.events.slice(0, 2).map(e => e.id)); }
    for (const key of ["goalKey", "actorPrincipalId", "reason", "from", "to", "revision", "resolutionKind", "definitionVersion"])
      if (key in body) assert.deepEqual(b[key], (body as Record<string, JsonValue>)[key]);
    for (const key of ["metadata", "progress", "outcome"]) assert.deepEqual(b[key], literal);
    assert.deepEqual(object(row.payload).metadata, literal);
  });
}
for (const field of ["successorGoalInstanceId", "predecessorGoalInstanceId"] as const) {
  for (const value of [null, 1, true, [], {}, "", "foreign-goal", "basis-two"] as JsonValue[]) test(`invalid Goal anchor zero INSERT: ${field}=${JSON.stringify(value)}`, async () => {
    const a = await saved(); bodyOf(a)[field] = value; await refused(a);
  });
}
for (const value of [null, 1, true, "same-token", {}, [], [1], [null], [""], ["foreign-event"], ["old-goal"], ["same-token", "same-token"], Array.from({ length: 17 }, (_, i) => `basis-${i}`)] as JsonValue[]) {
  test(`basisEventIds validates local Event namespace, types, count and uniqueness: ${JSON.stringify(value)}`, async () => {
    const a = await saved(); bodyOf(a).basisEventIds = value; await refused(a);
  });
}
test("basis order is preserved rather than sorted", async () => {
  const a = await saved(); bodyOf(a).basisEventIds = ["basis-two", "same-token"]; const d = restorer(); await d.restore(zip(a));
  assert.deepEqual(rowBody(d.rows.events.at(-1)!).basisEventIds, [d.rows.events[1].id, d.rows.events[0].id]);
});
test("legacy aliases, flat payload, content policy and omitted new fields stay compatible", async () => {
  const body = { goalInstanceId: "old-goal", successorInstanceId: "same-token", supersedesInstanceId: "old-goal", policyVersion: "content:v1", metadata: { successorGoalInstanceId: "foreign", basisEventIds: [] } };
  const a = await saved(body, false), d = restorer(); await d.restore(zip(a)); const b = rowBody(d.rows.events.at(-1)!);
  assert.equal(b.successorInstanceId, d.rows.goal_instances[1].id); assert.equal(b.supersedesInstanceId, d.rows.goal_instances[0].id);
  assert.equal(b.policyVersion, body.policyVersion); assert.deepEqual(b.metadata, body.metadata);
  for (const field of ["successorGoalInstanceId", "predecessorGoalInstanceId", "basisEventIds"]) assert.equal(Object.hasOwn(b, field), false);
});
test("non-Goal known event payload keeps same-named fields as literals", async () => {
  const a = await saved(); const e = a.record.events.at(-1)!; e.kind = "narration.committed";
  const literal = { successorGoalInstanceId: "foreign", predecessorGoalInstanceId: null, basisEventIds: ["foreign"] };
  object(e.payload).eventPayload = { __realmRuntimePayload: literal }; const d = restorer(); await d.restore(zip(a)); assert.deepEqual(rowBody(d.rows.events.at(-1)!), literal);
});
test("same archive/key replay writes nothing; changed reason literal still conflicts", async () => {
  const a = await saved(), d = restorer(); await d.restore(a); const n = writes(d);
  assert.equal((await d.restore(a)).replayed, true); assert.equal(writes(d), n);
  const bad = structuredClone(a); bodyOf(bad).reason = "changed";
  await assert.rejects(d.restore(zip(bad)), { code: "RESTORE_CONFLICT" }); assert.equal(writes(d), n);
});
async function siblings() {
  const a = await saved(), child = structuredClone(a.record); child.scope.recordId = "child-record";
  const ids = new Map(child.events.map(e => [e.eventId, `child-${e.eventId}`]));
  child.events = child.events.map(e => ({ ...e, eventId: ids.get(e.eventId)!, payload: { ...object(e.payload), sceneId: "child-scene", visibilityPolicyId: "child-policy" } }));
  const b = object(object(child.events.at(-1)!.payload).eventPayload); b.__realmRuntimePayload = { ...evolveBody(), goalInstanceId: "child-old", predecessorGoalInstanceId: "child-old", successorGoalInstanceId: "child-next", basisEventIds: ["child-same-token", "child-basis-two"] };
  const topology = { ...a.topology!, scenes: a.topology!.scenes.map(s => ({ ...s, sourceSceneId: "child-scene" })), visibilityPolicies: a.topology!.visibilityPolicies.map(p => ({ ...p, sourceVisibilityPolicyId: "child-policy", policyKind: "dm_only" as const })) };
  const domain = { format: "realm-runtime-domain" as const, schemaVersion: 1 as const, source: { worldId: scope.worldId, worldlineId: scope.worldlineId, storyId: "story", recordId: scope.recordId }, stories: [{ id: "story", title: "Story", status: "active" as const, premise: "" }], storyDefinitions: [],
    records: [{ recordId: "child-record", storyId: "story", title: "Child", status: "active" as const, worldVersion: "1.2.0", startTick: 0, startOrdinal: 0, timelineKind: "branch" as const, linkedRecordId: scope.recordId, lastEventId: "child-transition", lastWorldTick: 0, lastWorldOrdinal: 3,
      bundle: { record: child, topology, goals: {format:"realm-runtime-goals" as const,schemaVersion:1 as const,instances:[],assessments:[]} } }], projects: [], milestones: [], projectStoryLinks: [], budgetAllocations: [], financeAccounts: [], ledgerEntries: [], financeCommandGroups: [], obligations: [], obligationSettlements: [], storyNodes: [], storyUnlockLedger: [], committedFactCommands: [], performanceAssessments: [], memberRelationshipRevisions: [], characterAssets: [] };
  const childInstances=await Promise.all([boundGoal(goal("child-old","settled"),"child-record"),boundGoal(goal("child-next"),"child-record")]);
  const result = { ...a, goals:{...typedGoals(a),roots:[...typedGoals(a).roots,{owner:childInstances[0].ref.owner,instances:childInstances}]}, domain }; result.manifest = realmRuntimeSaveManifestFromData({ ...result, engineApi: "1.x", mode: "world-bound", world: { worldId: scope.worldId, worldVersion: "1.2.0" }, scope: { workspaceId: scope.workspaceId, worldlineId: scope.worldlineId, recordId: scope.recordId } }); return zip(result);
}
test("root and carried sibling map their own Goal and Event anchors", async () => {
  const a = await siblings(), d = restorer(); await d.restore(a); assert.equal(d.rows.records.length, 2);
  for (const record of d.rows.records) {
    const events = d.rows.events.filter(e => e.record_id === record.id), goals = d.rows.goal_instances.filter(g => g.record_id === record.id), b = rowBody(events.at(-1)!);
    // SQL/ZIP enumeration is not a typed identity association.
    const admission=d.calls.find(c=>c.sql==="SELECT record_goal_restore_group_prepare_v2($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission")!;
    const plan=JSON.parse(String(admission.values[6]));
    const sourceRecordId=plan.records.find((r:Row)=>r.recordId===record.id)?.sourceRecordId;
    assert.ok(sourceRecordId===scope.recordId||sourceRecordId==="child-record");
    const key=sourceRecordId===scope.recordId?"old-goal":"child-old";
    const next=key==="old-goal"?"same-token":"child-next";
    assert.equal(b.predecessorGoalInstanceId, goals.find(g=>g.goal_key===key)!.id);
    assert.equal(b.successorGoalInstanceId, goals.find(g=>g.goal_key===next)!.id);
    assert.deepEqual(b.basisEventIds, events.slice(0, 2).map(e => e.id));
  }
});
for (const child of [false, true]) for (const field of ["successorGoalInstanceId", "predecessorGoalInstanceId", "basisEventIds"] as const) {
  test(`${child ? "child" : "root"} cannot borrow sibling ${field} from global maps`, async () => {
    const a = await siblings(); bodyOf(a, child)[field] = field === "basisEventIds" ? [child ? "same-token" : "child-same-token"] : child ? "same-token" : "child-next"; await refused(a);
  });
}
test("same Goal token in different bundles maps to distinct target instances", async () => {
  const a = await siblings(), goals = typedGoals(a);
  const root=goals.roots.find(r=>r.owner.scopeKind==="record"&&r.owner.recordId==="child-record")!;
  const replacement=await boundGoal(goal("same-token"),"child-record");
  a.goals={...goals,roots:goals.roots.map(r=>r===root?{...r,instances:[r.instances.find(g=>g.ref.instanceId==="child-old")!,replacement]}:r)};
  bodyOf(a, true).successorGoalInstanceId = "same-token";
  const d = restorer(); await d.restore(zip(a)); const mapped = d.rows.events.filter(e => e.event_kind === "goal.transition.committed").map(e => rowBody(e).successorGoalInstanceId);
  assert.equal(new Set(mapped).size, 2); for (const e of d.rows.events.filter(e => e.event_kind === "goal.transition.committed")) assert.ok(d.rows.goal_instances.some(g => g.id === rowBody(e).successorGoalInstanceId && g.record_id === e.record_id));
});
test("SQL writer shape audit records declared nonnull text anchors and 1..16 unique local basis", () => {
  const author = readFileSync(new URL("../database/postgres/migrations/0070_record_goal_authoring_capability.sql", import.meta.url), "utf8");
  const evolve = readFileSync(new URL("../database/postgres/migrations/0072_record_goal_evolution_capability.sql", import.meta.url), "utf8");
  assert.match(author, /'successorGoalInstanceId',v_goal_id/); assert.match(evolve, /'predecessorGoalInstanceId',g.id/);
  assert.match(evolve, /jsonb_array_length\(p_definition->'basisEventIds'\) NOT BETWEEN 1 AND 16/); assert.match(evolve, /count\(DISTINCT value\)/); assert.match(evolve, /event.record_id=j.record_id/);
});

test("authored definitionId/policyVersion mapping retains immutable draft and source scope", async () => {
  const definition = createRecordGoalDefinition({ scope, goalId: "authored", activationHead: { recordVersion: 0, ordinal: 0 }, draft: {
    title: "same-token", description: "Keep the original", changePolicy: "evolving", visible: true,
    successConditions: ["Deliver the original"], failureConditions: [], settlementConditions: [] } });
  const g = { ...goalRow(goal(definition.goalInstanceId)), goal_key: definition.goalKey, policy_version: definition.policyVersion,
    definition_source: "record", definition_id: definition.definitionId, resolution_kind: "natural", evidence_start_version: 0, evidence_start_ordinal: 0 };
  const source = { operation: "create", goalInstanceId: definition.goalInstanceId, definitionId: definition.definitionId,
    policyVersion: definition.policyVersion, goalKey: definition.goalKey, actorPrincipalId: "same-token" };
  const a = await transport([eventRow("create", 1, { __realmRuntimePayload: source })], [g], [definition]), d = restorer();
  await d.restore(a); const target = object(d.rows.record_goal_definitions[0].definition), b = rowBody(d.rows.events[0]);
  assert.equal(b.goalInstanceId, target.goalInstanceId); assert.equal(b.definitionId, target.definitionId); assert.equal(b.policyVersion, target.policyVersion);
  assert.notEqual(b.definitionId, definition.definitionId); assert.notEqual(b.policyVersion, definition.policyVersion);
  assert.deepEqual(target.draft, definition.draft); assert.equal(b.goalKey, definition.goalKey); assert.equal(b.actorPrincipalId, "same-token");
  assert.equal(object(target.scope).recordId, d.rows.records[0].id); assert.deepEqual(a.goals.definitions, [definition]);
});
test("basis accepts the 16-item boundary and preserves the complete order", async () => {
  const a = await saved(), first = a.record.events[0]; a.record.events = Array.from({ length: 16 }, (_, i) => ({ ...first, eventId: `basis-${i}`, ordinal: i + 1 }));
  const transition = { ...first, eventId: "last", ordinal: 17, kind: "goal.transition.committed", payload: { ...object(first.payload), eventPayload: { __realmRuntimePayload: { ...evolveBody(), basisEventIds: a.record.events.map(e => e.eventId) } } } };
  a.record.events = [...a.record.events, transition]; a.record.head.nextRecordOrdinal = 18; const d = restorer(); await d.restore(zip(a));
  assert.deepEqual(rowBody(d.rows.events.at(-1)!).basisEventIds, d.rows.events.slice(0, 16).map(e => e.id));
});
test("content Goal retry anchors preserve same-Record predecessor linkage", async () => {
  const a = await saved(), goals=typedGoals(a);
  const instances=await Promise.all([boundGoal({...goal("old-goal","failed"),goalKey:"retry"}),
    boundGoal({...goal("same-token"),goalKey:"retry",attempt:2,supersedesInstanceId:"old-goal"})]);
  a.goals={...goals,roots:[{owner:instances[0].ref.owner,instances}]};
  const d = restorer(); await d.restore(zip(a)); assert.equal(d.rows.goal_instances[1].supersedes_instance_id, d.rows.goal_instances[0].id);
  assert.equal(rowBody(d.rows.events.at(-1)!).successorGoalInstanceId, d.rows.goal_instances[1].id);
  const bad = structuredClone(a), badGoals=typedGoals(bad), root=badGoals.roots[0];
  bad.goals={...badGoals,roots:[{...root,instances:[root.instances[0],{...root.instances[1],predecessor:
    {kind:"retry",ref:{owner:root.owner,instanceId:"foreign"}}}]}]};
  // V2 detects a dangling predecessor during build, before target acquisition.
  assert.throws(()=>zip(bad),{code:"INVALID_SAVE"});
  const denied=restorer();await assert.rejects(denied.restore(bad),{code:"INVALID_SAVE"});assert.equal(writes(denied),0);assert.equal(denied.calls.length,0);
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
