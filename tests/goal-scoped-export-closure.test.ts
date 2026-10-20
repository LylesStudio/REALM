import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { unzipSync } from "fflate";
import { goalDefinitionHash } from "../modules/goals/content-binding.ts";
import { goalEvidenceSnapshotHash } from "../modules/goals/public.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData,
  type RealmRuntimeSaveRecordV1 } from "../modules/world-transfer/realm-runtime-save.ts";
import type { RealmRuntimeSaveGoalsV2 } from "../modules/world-transfer/realm-runtime-goals-v2.ts";
import { createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import type { PoolClient } from "pg";
import pg from "pg";
import { installTestSessionSecret, sessionProofFor } from "./helpers/session-proof.ts";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { POST as restoreRoute } from "../app/api/record/restore/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { readFileSync } from "node:fs";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { GOAL_TRANSPORT_CAPABILITY_SQL, LOAD_TRANSPORT_GOALS_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { LOAD_GOAL_CONTENT_BINDING_SQL } from "../database/postgres/goal-content-binding-repository.ts";
import { bindGoalContentWitness, createGoalContentBindingSource } from "../modules/application/goal-content-binding-source.ts";
import { topologyHeaderSql } from "../database/postgres/runtime-topology-resource-reader.ts";
import { evidenceHeaderSql } from "../database/postgres/runtime-evidence-resource-reader.ts";
import { createRecordGoalDefinition } from "../modules/goals/record-authoring.ts";
import { MEMORY_RUNTIME_FILE_BYTES } from "../modules/world-transfer/realm-runtime-save.ts";
import { canonicalGoalJson } from "../modules/goals/content-binding.ts";
import { GOAL_RESTORE_TARGET_CAPABILITY_SQL, INSERT_RESTORED_GOAL_V2_SQL } from "../database/postgres/runtime-goal-restore.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import type { GoalContentSourceResolver } from "../modules/application/goal-content-binding-source.ts";
import type { RealmRuntimeSaveArchive, RealmRuntimeSaveGoals } from "../modules/world-transfer/realm-runtime-save.ts";

const record: RealmRuntimeSaveRecordV1 = { format: "realm-runtime-record", schemaVersion: 1,
  scope: { worldId: "world", worldlineId: "line", recordId: "record" }, head: { recordVersion: 1, nextRecordOrdinal: 2 },
  events: [{ eventId: "event", recordVersion: 1, ordinal: 1, kind: "utterance.committed", payload: { content: "中文😀" } }] };
function archive(goals: RealmRuntimeSaveGoalsV2) {
  const manifest = realmRuntimeSaveManifestFromData({ engineApi: "1.x", mode: "base", world: null,
    scope: { workspaceId: "workspace", worldlineId: "line", recordId: "record" }, record, goals });
  return { manifest, record, goals };
}
function globals(): RealmRuntimeSaveGoalsV2 {
  const definition = { goalKey: "arrival", policyVersion: "p1", mode: "deterministic" as const, visible: true,
    rubric: { kind: "event_count" as const, eventKind: "arrived", progressKey: "count", threshold: 1 }, outcome: {} };
  const owner = { scopeKind: "worldline" as const, worldId: "world", worldlineId: "line" };
  return { format: "realm-runtime-goals", schemaVersion: 2, workspaceId: "workspace", definitions: [], assessments: [],
    roots: [{ owner, instances: [{ ref: { owner, instanceId: "g1" }, goalKey: "arrival", policyVersion: "p1", state: "active", revision: 0,
      progress: { text: "g1 record line" }, outcome: null, attempt: 1, predecessor: null, resolutionKind: "natural", evidenceStart: null,
      definition: { kind: "content", binding: { bindingVersion: 1, workspaceId: "workspace", owner, instanceId: "g1",
        goalKey: "arrival", policyVersion: "p1", normalization: "goal-definition-c14n-v1", definitionHash: goalDefinitionHash(definition),
        source: { sourceKind: "base", sourceWorldId: "", sourceWorldVersion: "0.0.0-local", packageContentHash: null,
          baseRevision: "1.0.0", baseContentHash: "a".repeat(64) } } } }] }] };
}

// Stateful SQL protocol only; it cannot prove PostgreSQL grants, FK or locks.
function consumerProtocol(context: { resolve?: GoalContentSourceResolver; worldVersion?: string; workspaceId?: string; proof?: string; principalId?: string } = {}) {
  const workspaceId=context.workspaceId ?? "workspace"; const proof=context.proof ?? "proof"; const principalId=context.principalId ?? "owner";
  type Row = Record<string, unknown>;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const exact = new Set<string>();
  for (const file of ["realm-runtime-save-repository.ts", "runtime-goal-restore.ts", "../../modules/application/library-service.ts", "goal-runtime-materialization.ts"]) {
    for (const match of readFileSync(new URL(`../database/postgres/${file}`, import.meta.url), "utf8").matchAll(/`([^`]+)`/g)) {
      if (!match[1].includes("${") && /^(SELECT|INSERT|UPDATE|\/\* memory resource head)/.test(match[1].trim())) exact.add(norm(match[1]));
    }
  }
  for (const q of ["SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE",
    "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
    "SELECT restore_delivery_kind FROM public.outbox WHERE false",
    "SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version"]) exact.add(q);
  const rootProbe=[...exact].find(q=>q.includes("record.id AS record_id"));assert.ok(rootProbe);
  exact.add(rootProbe+" AND EXISTS ( SELECT 1 FROM player_world_memberships AS backup_membership WHERE backup_membership.workspace_id = record.workspace_id AND backup_membership.world_id = record.world_id AND backup_membership.principal_id = $3 AND backup_membership.role = 'owner' )");
  let rows: Record<string, Row[]> = {};
  let saved: Record<string, Row[]> = {};
  let group: Row | null = null;
  const groups = new Map<string, Row>();
  const savepoints: Record<string, Row[]>[]=[];
  const calls: { sql: string; values: unknown[] }[] = [];
  const state = { supported: true, revoke: false, failBind: false, failGoal: false, role: "owner" };
  const source = context.resolve ?? createGoalContentBindingSource();
  const resolve = async (...args: Parameters<typeof source>) => {
    if (state.revoke) throw new Error("source-revoked");
    return source(...args);
  };
  const client = { release() {}, async query(sql: string, values: unknown[] = []) {
    const q = norm(sql); calls.push({ sql: q, values: structuredClone(values) });
    const result = (r: Row[]) => ({ rows: r, rowCount: r.length });
    if (q === "BEGIN ISOLATION LEVEL REPEATABLE READ" || q === "BEGIN" || q === "BEGIN READ ONLY" || q === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") { assert.deepEqual(values, []); saved = structuredClone(rows); return result([]); }
    if (q === "COMMIT") { assert.deepEqual(values, []); if (group) groups.set(String(group.root),structuredClone(group)); group=null; return result([]); }
    if (q === "ROLLBACK") { assert.deepEqual(values, []); rows=saved; group=null; return result([]); }
    if(q === "SAVEPOINT realm_workspace_scope") { savepoints.push(structuredClone(rows)); return result([]); }
    if(q === "ROLLBACK TO SAVEPOINT realm_workspace_scope") { rows=structuredClone(savepoints.at(-1)!); return result([]); }
    if(q === "RELEASE SAVEPOINT realm_workspace_scope") { savepoints.pop(); return result([]); }
    if(q === "SELECT current_setting('realm.workspace_id', true) AS workspace_id") return result([{workspace_id:workspaceId}]);
    if(q === "SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only") return result([{isolation_level:"repeatable read",read_only:"off"}]);
    if (q === "SELECT set_config('realm.workspace_id', $1, true)") { assert.deepEqual(values,[workspaceId]); return result([]); }
    if (q === norm(GOAL_RESTORE_TARGET_CAPABILITY_SQL)) { assert.deepEqual(values,[]); return result([{ available:state.supported }]); }
    if (q === norm(GOAL_TRANSPORT_CAPABILITY_SQL)) { assert.deepEqual(values,[]); return result([{ available:true }]); }
    if (q === "SELECT record_goal_restore_group_prepare_v2($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission") {
      assert.equal(values.length,7); assert.deepEqual(values.slice(0,3),[workspaceId,proof,"world"]);
      const plan=JSON.parse(String(values[6])); const body=JSON.parse(plan.sourceBody);
      assert.equal(plan.bodyVersion,2); assert.equal(body.goals.schemaVersion,2);
      assert.equal(values[5],createHash("sha256").update("realm-runtime-restore-body:v2:").update(plan.sourceBody).digest("hex"));
      assert.equal(calls.filter(c=>c.sql.startsWith("INSERT")).length,0);
      group={root:values[3],body:values[5],plan};
      return result([{admission:{actor:principalId,planCommitment:"a".repeat(64)}}]);
    }
    if(q === "SELECT record_goal_restore_group_replay_v2($1,$2,$3,$4,$5,$6::jsonb) AS actor") {
      assert.deepEqual(values.slice(0,3),[workspaceId,proof,"world"]); const previous=groups.get(String(values[3])); assert.ok(previous);
      assert.equal(previous.body,values[4]); assert.deepEqual(previous.plan,JSON.parse(String(values[5]))); return result([{actor:principalId}]);
    }
    if(q === "SELECT record_goal_restore_group_definitions($1,$2,$3,$4,$5,$6::jsonb)") {
      assert.deepEqual(values.slice(0,2),[workspaceId,proof]); assert.equal(values[3],group?.body); assert.equal(values[4],"a".repeat(64));
      const definitions=JSON.parse(String(values[5])); const plan=(group!.plan as Row).records as Row[];
      assert.deepEqual(definitions,plan.find(r=>r.recordId===values[2])!.definitions);
      assert.ok(Array.isArray(definitions));
      (rows.record_goal_definitions ??= []).push(...definitions.map((definition:unknown)=>({definition}))); return result([]);
    }
    if(q === "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission") {
      assert.deepEqual(values.slice(0,3),[workspaceId,proof,"restore-v2"]); assert.equal(values[3],group?.body);
      const plan=JSON.parse(String(values[4])); assert.equal(plan.restoreGroupRoot,group?.root); return result([{admission:{actor:principalId,planCommitment:"b".repeat(64)}}]);
    }
    if(q === "SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") {
      assert.deepEqual(values.slice(0,4),[workspaceId,proof,group?.body,"b".repeat(64)]);
      if(state.failBind) throw new Error("bind-failure");
      rows.bindings ??= []; for(const binding of JSON.parse(String(values[4]))) {
        assert.ok(rows.goal_instances.some(g=>g.id===binding.instanceId)); rows.bindings.push({binding});
      }
      return result([]);
    }
    if(q === norm(LOAD_GOAL_CONTENT_BINDING_SQL)) {
      assert.equal(values[0],workspaceId); return result((rows.bindings ?? []).filter(r=>(r.binding as Row).instanceId===values[1]));
    }
    if(q === norm(LOAD_TRANSPORT_GOALS_SQL)) {
      assert.equal(values.length,5); assert.deepEqual(values.slice(0,2),[workspaceId,"world"]);
      return result((rows.goal_instances ?? []).filter(r=>r.worldline_id===values[2] &&
        (r.scope_kind==="worldline" || (r.scope_kind==="story" && (values[3] as string[]).includes(String(r.story_id)))
          || (r.scope_kind==="record" && (values[4] as string[]).includes(String(r.record_id))))));
    }
    for(const family of ["participants","scenes","visibility"] as const) if(q===norm(topologyHeaderSql(family))) {
      assert.equal(values.length,family==="participants"?6:7);
      assert.deepEqual(values.slice(0,2),[workspaceId,"world"]);
      if(values[4]!==null) return result([]);
      const table=family==="visibility"?"visibility_policies":family;
      const scopedRows=(rows[table] ?? []).filter(r=>r.record_id===values[3]);
      const data=scopedRows.map((r,i)=>{
        const h:Row={...r,locator:`(0,${i+1})`,source_count:String(scopedRows.length),cursor_progress:true,
          participant_id:r.id,participant_kind:r.participant_kind,participant_character_instance_id:null,
          participant_principal_id:r.principal_id,participant_controller_mode:r.controller_mode,
          participant_is_active:r.is_active,participant_speaking_order:r.speaking_order,participant_shared_control_enabled:r.shared_control_enabled};
        if(family==="scenes") h.scene_id=r.id;
        if(family==="visibility") h.policy_id=r.id;
        for(const m of q.matchAll(/ AS (\w+)_bytes/g)) {
          const k=m[1]; const v=k==="audience_character_instance_ids"?JSON.stringify(h[k] ?? []):h[k] ?? null; h[k]=v; h[k+"_is_null"]=v===null;
          h[k+"_bytes"]=v===null?0:Buffer.byteLength(String(v)); h[k+"_chars"]=v===null?0:[...String(v)].length;
        }
        return h;
      });
      return result(data);
    }
    for(const family of ["action_receipts","character_effects","observations"] as const) {
      const m=/DECLARE (realm_evidence_[a-f0-9]+) NO SCROLL/.exec(q);
      if(m && q===norm(evidenceHeaderSql(family,m[1]))) { assert.equal(values.length,4); return result([]); }
    }
    if(/^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM realm_evidence_[a-f0-9]+$/.test(q)
      || /^CLOSE realm_evidence_[a-f0-9]+$/.test(q)) { assert.deepEqual(values,[]); return result([]); }
    if(q.startsWith("/* runtime event headers */ SELECT ") && q.endsWith("ORDER BY record_ordinal ASC, id ASC LIMIT 1000")
      && q.includes("FROM events WHERE workspace_id=$1 AND record_id=$2")) { assert.deepEqual(values.slice(2),[null,null]); return result([]); }
    if(q.startsWith("/* runtime outbox headers; outbox preflight; outbox bounded envelope */ SELECT ")
      && q.includes("FROM outbox WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4")
      && q.endsWith("ORDER BY created_at ASC, id ASC LIMIT 1000")) return result([]);
    if(/^\/\* memory resource header (conclusions|snapshots|relationships) \*\/ SELECT /.test(q)
      && q.endsWith('memory_headers ORDER BY keys COLLATE "C"') && q.includes("workspace_id=$1 AND world_id=$2 AND worldline_id=$3")) {
      assert.equal(values[0],workspaceId);assert.equal(values[1],"world");return result([]);
    }
    if(!exact.has(q)) throw new Error(`UNKNOWN_SQL_TEXT:${q}`);
    if(q==="SELECT world_version FROM worlds WHERE workspace_id = $1 AND id = $2") { assert.deepEqual(values,[workspaceId,"world"]); return result([{world_version:context.worldVersion ?? "0.0.0-local"}]); }
    if(q.startsWith("SELECT world_version, status, settings FROM worlds")) { assert.deepEqual(values,[workspaceId,"world"]); return result([{world_version:context.worldVersion ?? "0.0.0-local",status:"active",settings:{}}]); }
    if(q.startsWith("SELECT role FROM player_world_memberships")) { assert.deepEqual(values,[workspaceId,"world",principalId]); return result([{role:state.role}]); }
    if(q.startsWith("SELECT record.world_id, record.worldline_id, record.story_id, record.status,")) {
      const r=(rows.records ?? []).find(r=>r.id===values[1]); return result(r?[{...r,story_premise:rows.stories.find(s=>s.id===r.story_id)!.premise}]:[]);
    }
    if(q.includes("record.id AS record_id")) {
      assert.equal(values[0],workspaceId); const r=(rows.records ?? []).find(r=>r.id===values[1]);
      return result(r?[{world_id:r.world_id,worldline_id:r.worldline_id,record_id:r.id,story_id:r.story_id,world_version:r.world_version,record_version:0,next_record_ordinal:0}]:[]);
    }
    if(q.startsWith("SELECT status FROM records")) return result([{status:"active"}]);
    if(q.startsWith("SELECT id, goal_key, state, revision")) return result((rows.goal_instances ?? []).filter(r=>r.record_id===values.at(-1)));
    if(q.endsWith("AS mixed") || q.endsWith("AS bound")) return result([{mixed:false,bound:false}]);
    if(q.startsWith("SELECT id, title, status, premise FROM stories")) return result(rows.stories.filter(r=>r.worldline_id===values[2]));
    if(q.startsWith("SELECT id,title,status,premise FROM stories")) return result(rows.stories.filter(r=>r.worldline_id===values[2]));
    if(q.startsWith("SELECT record.id FROM records record")) return result(rows.records.filter(r=>r.worldline_id===values[2]
      && rows.goal_instances.some(g=>g.record_id===r.id && g.definition_source==="content")).map(r=>({id:r.id})));
    if(q.startsWith("SELECT record.id, record.story_id, record.title")) return result((values[3] as string[]).map(id=>{
      const r=rows.records.find(r=>r.id===id)!;const head=rows.record_heads.find(h=>h.record_id===id)!;return {...r,...head,id:r.id};
    }));
    if(q.startsWith("SELECT linked_record_id FROM records")) return result(rows.records.filter(r=>r.id===values[1]).map(r=>({linked_record_id:r.linked_record_id})));
    if(q.startsWith("/* memory resource head */")) return result([{head_tick:0,head_ordinal:0}]);
    if(q.startsWith("SELECT definition FROM record_goal_definitions")) return result((rows.record_goal_definitions ?? []).filter(r=>(r.definition as {scope:{recordId:string}}).scope.recordId===values.at(-1)));
    if(q.startsWith("SELECT world_id FROM records")) return result((rows.records ?? []).filter(r=>r.id===values[1]).map(r=>({world_id:r.world_id})));
    if(q === "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE") return result([{status:"active"}]);
    if(q === "SELECT id FROM worlds WHERE workspace_id = $1 AND id = $2") { assert.deepEqual(values,[workspaceId,"world"]); return result([{id:"world"}]); }
    if(q.startsWith("SELECT record.worldline_id,")) {
      const r=rows.records.find(r=>r.id===values[1])!;const story=rows.stories.find(s=>s.id===r.story_id)!;
      return result([{worldline_id:r.worldline_id,story_id:r.story_id,world_version:r.world_version,record_title:r.title,record_status:r.status,
        story_title:story.title,story_premise:story.premise,start_tick:String(r.start_tick),start_ordinal:String(r.start_ordinal),observer:true,player_role:""}]);
    }
    if(q.startsWith("SELECT last_world_tick::text")) return result((rows.record_heads ?? []).filter(r=>r.record_id===values[1]).map(r=>({...r,last_world_tick:"0",last_world_ordinal:"0"})));
    if(q.startsWith("SELECT id, goal_key, state, revision::text")) return result((rows.goal_instances ?? []).filter(r=>r.record_id===values[1]).map(r=>({...r,revision:String(r.revision),completed_at:null})));
    if(q.startsWith("SELECT EXISTS(SELECT 1 FROM events")) return result([{present:false}]);
    if(q.startsWith("SELECT id, worldline_id, story_id,")) return result((rows.records ?? []).filter(r=>r.id===values[1]).map(r=>({...r,start_tick:String(r.start_tick),start_ordinal:String(r.start_ordinal)})));
    const empty=new Set(["record_goal_definitions","goal_assessments","record_first_nights","record_self_play_sessions","memory_conclusions","memory_snapshots","relationship_states","memory_cache_epochs",
      "project_story_links","projects","project_milestones","budget_allocations","finance_accounts","ledger_entries","project_finance_command_groups","obligations","obligation_settlements",
      "story_node_instances","story_unlock_ledger","committed_fact_commands","performance_assessments","member_relationship_revisions","character_assets","story_definition_bindings"]);
    if(empty.has(/\bFROM (\w+)/.exec(q)?.[1] ?? "")) return result([]);
    if(q==="SELECT restore_delivery_kind FROM public.outbox WHERE false") { assert.deepEqual(values,[]); return result([]); }
    if(q.startsWith("INSERT INTO ")) {
      const m=/^INSERT INTO (\w+) \((.*?)\) VALUES \((.*)\)$/.exec(q); assert.ok(m,q);
      const allowed=new Set(["worldlines","stories","records","participants","scenes","visibility_policies","events","record_heads","goal_instances","goal_assessments"]); assert.ok(allowed.has(m[1]),m[1]);
      const row:Row={};
      const expressions=m[3].split(/,\s*(?![^()]*\))/);
      m[2].split(/,\s*/).map(c=>c.trim()).forEach((column,i)=>{
        const expression=expressions[i]; assert.ok(expression,column);
        const match=/^\$(\d+)(?:::\w+(?:\[\])?)?$/.exec(expression);
        row[column]=match?values[Number(match[1])-1]:expression==="NULL"?null:expression==="true"?true:expression==="false"?false:
          /^'[^']*'$/.test(expression)?expression.slice(1,-1):/^\d+$/.test(expression)?Number(expression):expression==="CURRENT_TIMESTAMP"?"protocol-timestamp":expression.startsWith("CASE WHEN")?null:assert.fail(expression);
        if(match && expression.endsWith("::jsonb") && row[column]!==null) row[column]=JSON.parse(String(row[column]));
      });
      if(m[1]==="goal_instances") {
        assert.equal(q,norm(INSERT_RESTORED_GOAL_V2_SQL)); assert.equal(values.length,20);
        if(state.failGoal) throw new Error("goal-insert-failure");
        if(row.supersedes_instance_id!==null) assert.ok(rows.goal_instances.some(g=>g.id===row.supersedes_instance_id),"parent first");
      }
      (rows[m[1]] ??= []).push(row); return result([]);
    }
    throw new Error(`UNKNOWN_SQL_PROTOCOL:${q}`);
  } };
  const database={async connect(){return client;}};
  const restorer=createPostgresRealmRuntimeSaveRestorer(database as never,{goalsSchemaVersion:2,resolveGoalSource:resolve,validateWorldBinding:async()=>{}});
  return {state,calls,client,database,resolve,get rows(){return rows;},query:client.query.bind(client),
    restore:(archive:RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>,key="consumer")=>restorer.restore({workspaceId:workspaceId,principalId:principalId,sessionProof:proof,targetWorldId:"world",archive,idempotencyKey:key}),
    export:async(recordId:string,whole=false)=>createPostgresRealmRuntimeSaveReader(database as never,{goalsSchemaVersion:2,resolveGoalSource:resolve}).load({workspaceId:workspaceId,principalId:principalId,recordId,purpose:whole?"whole-closure-backup":"record-export"})};
}

test("real export/ZIP/parser/direct writer/reexport/second writer preserve three owners and opaque state", async()=>{
  const source=await productionReaderFixture(); const exported=await source.load(); assert.ok(exported);
  const parsed=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(exported),{goalsSchemaVersion:2});
  const target=consumerProtocol(); const restored=await target.restore(parsed);
  assert.equal(restored.importedGoalInstanceCount,3); assert.equal(restored.replayed,false);
  assert.equal(target.rows.goal_instances.length,3);
  for(const g of target.rows.goal_instances) {assert.equal(g.outcome,null); assert.deepEqual(g.progress,{literal:"instance-0 record sibling"});}
  const before=structuredClone(target.rows); target.calls.length=0;
  assert.equal((await target.restore(parsed)).replayed,true); assert.deepEqual(target.rows,before);
  assert.equal(target.calls.some(c=>c.sql.startsWith("INSERT")),false);
  const saved=await target.export(restored.recordId); assert.ok(saved); assert.equal(saved.goals.schemaVersion,2);
  if(saved.goals.schemaVersion!==2) assert.fail();
  assert.deepEqual(saved.goals.roots.map(r=>r.owner.scopeKind).sort(),["record","story","worldline"]);
  const second=consumerProtocol(); assert.equal((await second.restore(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(saved),{goalsSchemaVersion:2}),"second")).importedGoalInstanceCount,3);
  target.state.revoke=true; target.calls.length=0;
  await assert.rejects(target.restore(parsed),/source-revoked/); assert.equal(target.calls.length,0); assert.deepEqual(target.rows,before);
});

test("direct V2 refuses incomplete target before projections and rolls the complete group back on write/bind failures",async()=>{
  const source=await productionReaderFixture(); const archive=await source.load(); assert.ok(archive);
  for(const failure of ["supported","failGoal","failBind"] as const) {
    const target=consumerProtocol(); target.state[failure]=failure!=="supported";
    await assert.rejects(target.restore(archive),failure==="supported"?{code:"GOAL_TRANSPORT_TARGET_UNSUPPORTED"}:failure==="failGoal"?/goal-insert-failure/:/bind-failure/);
    assert.deepEqual(target.rows,{}); assert.equal(target.calls.at(-1)!.sql,"ROLLBACK");
    if(failure==="supported") assert.equal(target.calls.some(c=>c.sql.startsWith("INSERT")||c.sql.includes("FROM goal_content_instance_bindings")),false);
  }
  const target=consumerProtocol(); await assert.rejects(target.query("SELECT unknown_sql()"),/UNKNOWN_SQL_TEXT/);
  const malformed=structuredClone(archive); if(malformed.goals.schemaVersion!==2)assert.fail();
  const g=malformed.goals.roots[0].instances[0]; g.attempt=2;
  target.calls.length=0; await assert.rejects(target.restore(malformed)); assert.equal(target.calls.length,0);
});

test("actual Library snapshot consumes mixed authored/content V2 on one outer transaction and keeps native global refusal",async()=>{
  const source=await productionReaderFixture(); const exported=await source.load(); assert.ok(exported);if(exported.goals.schemaVersion!==2)assert.fail();
  const recordRoot=exported.goals.roots.find(r=>r.owner.scopeKind==="record")!;
  const definition=createRecordGoalDefinition({scope:{workspaceId:"workspace",worldId:"world",worldlineId:"line",recordId:"record"},goalId:"authored",
    activationHead:{recordVersion:0,ordinal:0},draft:{title:"原文",description:"record literal",successConditions:["完成"],failureConditions:[],settlementConditions:[],changePolicy:"fixed",visible:true}});
  const authored={...recordRoot.instances[0],ref:{owner:recordRoot.owner,instanceId:definition.goalInstanceId},goalKey:definition.goalKey,policyVersion:definition.policyVersion,
    definition:{kind:"record" as const,definitionId:definition.definitionId,goalId:definition.goalId,definitionVersion:1},evidenceStart:definition.activationHead};
  const mixed={...exported,goals:{...exported.goals,definitions:[definition],roots:[{...recordRoot,instances:[authored,...recordRoot.instances]}]}};
  const target=consumerProtocol();const initial=await target.restore(mixed);target.calls.length=0;
  const service=createPostgresLibraryService(target.database as never,undefined,{resolveGoalSource:target.resolve});
  const branch=await service.branchRecord({workspaceId:"workspace",principalId:"owner",sessionProof:"proof"},{sourceRecordId:initial.recordId,idempotencyKey:"snapshot-v2"});
  assert.equal(branch.replayed,false);
  assert.equal(target.calls.filter(c=>c.sql==="BEGIN ISOLATION LEVEL REPEATABLE READ").length,1);
  assert.equal(target.calls.filter(c=>c.sql==="COMMIT").length,1);
  const group=target.calls.find(c=>c.sql.startsWith("SELECT record_goal_restore_group_prepare_v2"))!;
  assert.ok(group);const plan=JSON.parse(String(group.values[6]));assert.equal(plan.operation,"branch");assert.deepEqual(plan.source,{recordId:initial.recordId,recordVersion:0,nextRecordOrdinal:0});
  assert.equal(target.rows.goal_instances.filter(r=>r.record_id===branch.recordId).length,2);
  assert.equal(target.rows.record_goal_definitions.length,2);
  const denied=consumerProtocol();const all=await denied.restore(exported);denied.calls.length=0;
  // A narrative source asks the actual snapshot branch to include all owner facts.
  const previous=denied.client.query.bind(denied.client);
  denied.client.query=async(sql,values=[])=>sql.replace(/\s+/g," ").trim().startsWith("SELECT EXISTS(SELECT 1 FROM events")
    ? {rows:[{present:true}],rowCount:1}:previous(sql,values);
  await assert.rejects(createPostgresLibraryService(denied.database as never,undefined,{resolveGoalSource:denied.resolve}).branchRecord({workspaceId:"workspace",principalId:"owner",sessionProof:"proof"},
    {sourceRecordId:all.recordId,idempotencyKey:"global-refusal"}),{code:"BRANCH_GOAL_STATE_UNAVAILABLE"});
  assert.equal(denied.calls.some(c=>c.sql.startsWith("INSERT")),false);
});

test("real public restore POST explicitly consumes V2 and maps unsupported target with auth and no-store",async t=>{
  const previous=process.env.REALM_RUNTIME_DATABASE_URL;const secret=process.env.REALM_SESSION_SECRET;
  process.env.REALM_RUNTIME_DATABASE_URL="postgresql://fixture@127.0.0.1:1/goal_protocol_only";
  installTestSessionSecret();const proof=sessionProofFor(LOCAL_RECORD_SCOPE.principalId);
  const fixture=consumerProtocol({workspaceId:LOCAL_RECORD_SCOPE.workspaceId,principalId:LOCAL_RECORD_SCOPE.principalId,proof});
  t.mock.method(pg.Pool.prototype,"connect",async()=>fixture.client as never);
  try {
    const source=await productionReaderFixture();const saved=await source.load();assert.ok(saved);
    const bytes=buildRealmRuntimeSaveArchive(saved);
    const request=(authenticated=true)=>new Request("http://localhost/api/record/restore",{method:"POST",headers:{
      "content-type":"application/vnd.realm.save+zip","idempotency-key":"route-v2","x-realm-target-world":"world",
      ...(authenticated?{cookie:`realm_session=${proof}`}:{})},body:Buffer.from(bytes)});
    assert.equal((await restoreRoute(request(false))).status,401);assert.equal(fixture.calls.length,0);
    const created=await restoreRoute(request());assert.equal(created.status,201,await created.clone().text());assert.equal(created.headers.get("cache-control"),"no-store");
    assert.equal((await created.json()).importedGoalInstanceCount,3);
    assert.equal((await restoreRoute(request())).status,200);
    fixture.state.supported=false;fixture.calls.length=0;
    const unsupported=await restoreRoute(request());assert.equal(unsupported.status,422);assert.equal(unsupported.headers.get("cache-control"),"no-store");
    assert.deepEqual(await unsupported.json(),{ok:false,error:{code:"GOAL_TRANSPORT_TARGET_UNSUPPORTED"}});
    assert.equal(fixture.calls.some(c=>c.sql.startsWith("INSERT")),false);
  } finally {
    await endSharedRuntimePools();t.mock.restoreAll();
    if(previous===undefined)delete process.env.REALM_RUNTIME_DATABASE_URL;else process.env.REALM_RUNTIME_DATABASE_URL=previous;
    if(secret===undefined)delete process.env.REALM_SESSION_SECRET;else process.env.REALM_SESSION_SECRET=secret;
  }
});

test("actual direct installed-source restore preserves shuffled complete retry chains parent-first and rechecks policy before replay",async()=>{
  const definition={goalKey:"arrival",policyVersion:"p1",mode:"deterministic" as const,visible:true,retryable:true,
    rubric:{kind:"event_count" as const,eventKind:"arrived",progressKey:"count",threshold:1},outcome:{title:"抵达"}};
  let revoked=false;
  const resolve=createGoalContentBindingSource({mount:async()=>({manifest:{format:"realmworld",formatVersion:1,worldId:"world",worldVersion:"1.0.0",
    engineCompat:{schemaLatest:"",requiresMigrations:[],baseRange:"*"},contentHash:"a".repeat(64),signature:{algorithm:"ed25519",keyId:"fixture",value:""}},
    files:new Map([["content/goals.json",Buffer.from(JSON.stringify({format:"realmworld-goals",schemaVersion:1,goals:[revoked?{...definition,retryable:false}:definition]}))]])})});
  const witness=await resolve({worldId:"world",worldVersion:"1.0.0",goalKey:"arrival"});
  const fixture=await productionReaderFixture();const saved=await fixture.load();assert.ok(saved);if(saved.goals.schemaVersion!==2)assert.fail();
  const goals={...saved.goals,roots:saved.goals.roots.map((r,i)=>{
    const first={...r.instances[0],goalKey:"arrival",policyVersion:"p1",state:"completed" as const,revision:1,
      definition:{kind:"content" as const,binding:bindGoalContentWitness(witness,"workspace",r.owner,`original-${i}`)},
      ref:{owner:r.owner,instanceId:`original-${i}`},progress:{literal:"original retry 中文"},outcome:{literal:"original"}};
    const next={...first,ref:{owner:r.owner,instanceId:`retry-${i}`},state:"active" as const,outcome:null,attempt:2,
      definition:{kind:"content" as const,binding:bindGoalContentWitness(witness,"workspace",r.owner,`retry-${i}`)},
      predecessor:{kind:"retry" as const,ref:first.ref}};
    return {...r,instances:[next,first]};
  }).reverse()};
  const data={...saved,...saved.manifest,mode:"world-bound" as const,world:{worldId:"world",worldVersion:"1.0.0"},goals};
  const archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({...saved,goals,manifest:realmRuntimeSaveManifestFromData(data)}),{goalsSchemaVersion:2});
  const target=consumerProtocol({resolve,worldVersion:"1.0.0"});assert.equal((await target.restore(archive)).importedGoalInstanceCount,6);
  const inserts=target.calls.filter(c=>c.sql.replace(/\s+/g," ").trim()===INSERT_RESTORED_GOAL_V2_SQL.replace(/\s+/g," ").trim());assert.equal(inserts.length,6);
  const done=new Set<string>();for(const call of inserts){if(call.values[19]!==null)assert.ok(done.has(String(call.values[19])));done.add(String(call.values[6]));}
  target.calls.length=0;const shuffled=structuredClone(archive);if(shuffled.goals.schemaVersion!==2)assert.fail();
  shuffled.goals={...shuffled.goals,roots:[...shuffled.goals.roots].reverse().map(r=>({...r,instances:[...r.instances].reverse()}))};
  assert.equal((await target.restore(shuffled)).replayed,true);assert.equal(target.calls.some(c=>c.sql.startsWith("INSERT")),false);
  revoked=true;target.calls.length=0;await assert.rejects(target.restore(archive));assert.equal(target.calls.length,0);
});

test("actual direct assessment validates original source tuple/hash before target SQL, then writes the rebased tuple",async()=>{
  const resolve=createGoalContentBindingSource();const witness=await resolve({worldId:"world",worldVersion:"0.0.0-local",goalKey:"base.first-narration"});
  const owner={scopeKind:"record" as const,...record.scope};
  const g={...globals().roots[0].instances[0],goalKey:witness.definition.goalKey,policyVersion:witness.definition.policyVersion,
    ref:{owner,instanceId:"source-goal"},definition:{kind:"content" as const,binding:bindGoalContentWitness(witness,"workspace",owner,"source-goal")}};
  const event={eventId:"event",recordId:"record",recordVersion:1,ordinal:1,kind:record.events[0].kind,payload:{literal:"source-goal event"}};
  const savedRecord={...record,events:[{...record.events[0],payload:{content:"中文😀",speakerName:"",actorParticipantId:null,
    sceneId:"scene",visibilityPolicyId:"policy",worldTick:0,worldOrdinal:1,calendarId:"calendar",displayTime:"",eventPayload:event.payload}}]};
  const head={recordVersion:1,ordinal:1};const hash=goalEvidenceSnapshotHash({definition:witness.definition,
    instance:{...g,goalInstanceId:"source-goal",recordId:"record"},events:[event],evidenceHead:head});
  const ref={...record.scope,eventId:"event"};
  const goals:RealmRuntimeSaveGoalsV2={format:"realm-runtime-goals",schemaVersion:2,workspaceId:"workspace",roots:[{owner,instances:[g]}],definitions:[],assessments:[{
    id:"source-assessment",goal:g.ref,sourceEvent:ref,source:"deterministic",status:"accepted",result:{evidenceSnapshotHash:hash,evidenceEventIds:["event"],literal:"source-goal event"},
    evidenceEvents:[ref],evidenceHead:head,evidenceSnapshotHash:hash,policyVersion:g.policyVersion}]};
  const source={record:savedRecord,goals,manifest:realmRuntimeSaveManifestFromData({...archive(goals).manifest,record:savedRecord,goals})};
  const invalid=structuredClone(source);invalid.goals.assessments[0].evidenceSnapshotHash="f".repeat(64);
  const target=consumerProtocol();await assert.rejects(target.restore(invalid));assert.equal(target.calls.length,0);
  const restored=await target.restore(source);assert.equal(restored.importedAssessmentCount,1);
  const assessment=target.rows.goal_assessments[0];assert.notEqual(assessment.evidence_snapshot_hash,hash);
  assert.equal((assessment.result as Record<string,unknown>).literal,"source-goal event");
  assert.equal(assessment.source_event_id,target.rows.events[0].id);assert.equal(assessment.goal_instance_id,target.rows.goal_instances[0].id);
});
test("real manifest/ZIP/parse dispatch carries a single archive-global GoalsV2 section", () => {
  const source = globals(); const bytes = buildRealmRuntimeSaveArchive(archive(source));
  const files = unzipSync(bytes);
  assert.equal(JSON.parse(Buffer.from(files["realm-save-manifest.json"]).toString()).formatVersion, 2);
  assert.equal(Object.keys(files).filter(k => k.endsWith("goals.json")).length, 1);
  const parsed = parseRealmRuntimeSaveArchive(bytes, { goalsSchemaVersion: 2 });
  assert.equal(parsed.goals.schemaVersion, 2);
  if (parsed.goals.schemaVersion !== 2) assert.fail("missing global section");
  assert.equal(parsed.goals.roots[0].instances[0].progress.text, "g1 record line");
  assert.throws(() => parseRealmRuntimeSaveArchive(bytes), { code: "INVALID_SAVE" });
});
test("global roots cannot claim absent owners or a different workspace", () => {
  const source = globals();
  assert.throws(() => buildRealmRuntimeSaveArchive(archive({ ...source, workspaceId: "other" })));
  const owner = { ...source.roots[0].owner, worldlineId: "absent" };
  const g = source.roots[0].instances[0];
  const binding = g.definition.kind === "content" ? g.definition.binding : assert.fail();
  const changed = { ...source, roots: [{ owner, instances: [{ ...g, ref: { ...g.ref, owner }, definition: { kind: "content" as const, binding: { ...binding, owner } } }] }] };
  assert.throws(() => buildRealmRuntimeSaveArchive(archive(changed)));
});
test("V1 ZIP/hash golden comes from the frozen original production module", () => {
  // Captured before editing realm-runtime-save.ts; original module and complete
  // section strings are retained in the task evidence, not a second serializer.
  const cases = [
    { instances: [], hash: "e3cdac163bd726c574080cc61f3b66a6b5632aa0bf034c6a5a5fe00f8cf9a1f5", zip: "fa407d5f7f5ceb391016031e7fd5e35c1d991fd79517991b90bcc62686af7801" },
    { instances: [{ id: "g1", goalKey: "arrival", state: "active", revision: 0, progress: { prose: "g1 record" }, policyVersion: "p1", attempt: 1, supersedesInstanceId: null }],
      hash: "33d2728ad1bdb52ef2b1e2f53ef96e65a2ca8d327153d8ec4b5812c773aa867c", zip: "737146092b0077f2e94f94f976d442c531efcaa85979425a21397e52eb227d4d" },
    { instances: [{ id: "g2", goalKey: "arrival", state: "active", revision: 0, policyVersion: "p1", attempt: 2, supersedesInstanceId: "g1" },
      { id: "g1", goalKey: "arrival", state: "completed", revision: 1, policyVersion: "p1", attempt: 1, supersedesInstanceId: null }],
      hash: "e2a6149da601396c5d9ae8b91f5f114c2aa088326afdebfa788da835a182df3f", zip: "ec5a0cc3b7a1f637e355b337268cdedf7772ea6b4211b9ddb6587a28c76211d4" },
  ];
  for (const item of cases) {
    const goals = { format: "realm-runtime-goals" as const, schemaVersion: 1 as const, instances: item.instances, assessments: [] };
    const manifest = realmRuntimeSaveManifestFromData({ engineApi: "1.x", mode: "base", world: null,
      scope: { workspaceId: "workspace", worldlineId: "line", recordId: "record" }, record, goals });
    assert.equal(manifest.snapshot.runtimeHash, item.hash);
    assert.equal(createHash("sha256").update(buildRealmRuntimeSaveArchive({ manifest, record, goals })).digest("hex"), item.zip);
  }
});
test("direct playable V1 content restore fails on absent historical proof before asynchronous IO or SQL", async () => {
  const goals = { format: "realm-runtime-goals" as const, schemaVersion: 1 as const,
    instances: [{ id: "g1", goalKey: "arrival", state: "active", revision: 0, policyVersion: "p1", attempt: 1, supersedesInstanceId: null }], assessments: [] };
  const manifest = realmRuntimeSaveManifestFromData({ engineApi: "1.x", mode: "base", world: null,
    scope: { workspaceId: "workspace", worldlineId: "line", recordId: "record" }, record, goals });
  let queries = 0; let sourceCalls = 0;
  const client = { query: async () => { queries++; throw new Error("unexpected SQL"); }, release() {} } as unknown as PoolClient;
  const restorer = createPostgresRealmRuntimeSaveRestorer(client, { validateWorldBinding: async () => { sourceCalls++; } });
  const source = { manifest, record, goals };
  const original = structuredClone(source);
  await assert.rejects(restorer.restore({ workspaceId: "workspace", principalId: "owner", sessionProof: "proof",
    archive: source, targetWorldId: "target", idempotencyKey: "key" }), { code: "GOAL_HISTORICAL_BINDING_UNRESOLVED" });
  assert.deepEqual(source, original); assert.equal(queries, 0); assert.equal(sourceCalls, 0);
});

// Driver protocol only. SQL text and semantic lanes are both closed; this does
// not simulate PostgreSQL ACLs, deferred constraints or concurrent row locks.
async function productionReaderFixture(options: { schema?: boolean; missingBinding?: boolean; revoke?: boolean;
  whole?: boolean; role?: string; negotiate?: boolean; sqlFailure?: boolean; chained?: boolean;
  noGoals?: boolean; authored?: boolean } = {}) {
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
  const sourceText = readFileSync(new URL("../database/postgres/realm-runtime-save-repository.ts", import.meta.url), "utf8");
  const staticSql = new Set([...sourceText.matchAll(/`([^`]+)`/g)]
    .filter(m => !m[1].includes("${") && /^(SELECT|\/\* memory resource head)/.test(m[1].trim())).map(m => normalize(m[1])));
  const recordProbe = [...staticSql].find(q => q.includes("record.id AS record_id")); assert.ok(recordProbe);
  staticSql.add(recordProbe + " AND EXISTS ( SELECT 1 FROM player_world_memberships AS backup_membership WHERE backup_membership.workspace_id = record.workspace_id AND backup_membership.world_id = record.world_id AND backup_membership.principal_id = $3 AND backup_membership.role = 'owner' )");
  staticSql.add("SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version");
  const calls: { sql: string; values: unknown[] }[] = [];
  const resolve = createGoalContentBindingSource();
  const witness = await resolve({ worldId: "world", worldVersion: "0.0.0-local", goalKey: "base.first-narration" });
  const owners = [
    { scopeKind: "record" as const, worldId: "world", worldlineId: "line", recordId: "record" },
    { scopeKind: "story" as const, worldId: "world", worldlineId: "line", storyId: "story" },
    { scopeKind: "worldline" as const, worldId: "world", worldlineId: "line" },
    ...(options.whole ? [{ scopeKind: "record" as const, worldId: "world", worldlineId: "line", recordId: "sibling" }] : []),
  ];
  const bindings = owners.map((owner, i) => bindGoalContentWitness(witness, "workspace", owner, `instance-${i}`));
  let rows: Record<string, unknown>[] = bindings.map(b => ({ id: b.instanceId, scope_kind: b.owner.scopeKind,
    record_id: b.owner.scopeKind === "record" ? b.owner.recordId : null,
    story_id: b.owner.scopeKind === "story" ? b.owner.storyId : null,
    goal_key: b.goalKey, policy_version: b.policyVersion, definition_source: "content", definition_id: null,
    state: "active", revision: "0", progress: { literal: "instance-0 record sibling" }, outcome: null,
    resolution_kind: "natural", evidence_start_version: 0, evidence_start_ordinal: 0,
    attempt: 1, supersedes_instance_id: null }));
  const authored = options.authored ? createRecordGoalDefinition({ scope: { workspaceId: "workspace", ...record.scope },
    goalId: "authored", activationHead: { recordVersion: 0, ordinal: 0 }, draft: {
      title: "Keep the letter", description: "Keep the original", changePolicy: "fixed", visible: true,
      successConditions: ["Deliver the original"], failureConditions: [], settlementConditions: [],
    } }) : null;
  if (options.noGoals) rows = [];
  if (authored) rows = [{ ...rows[0], id: authored.goalInstanceId, goal_key: authored.goalKey,
    policy_version: authored.policyVersion, definition_source: "record", definition_id: authored.definitionId }];
  const emptyTables = new Set(["goal_assessments", "record_goal_definitions", "memory_conclusions", "memory_snapshots",
    "relationship_states", "record_first_nights", "record_self_play_sessions", "project_story_links", "projects",
    "project_milestones", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups",
    "obligations", "obligation_settlements", "story_node_instances", "story_unlock_ledger", "committed_fact_commands",
    "performance_assessments", "member_relationship_revisions", "character_assets", "story_definition_bindings"]);
  const cursors = new Set<string>(); let acquired = 0, released = 0;
  const client = { release() { released++; }, async query(sql: string, values: unknown[] = []) {
    const q = normalize(sql); calls.push({ sql: q, values: structuredClone(values) });
    const result = (data: unknown[]) => ({ rows: data, rowCount: data.length });
    if (["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "COMMIT", "ROLLBACK"].includes(q)) return result([]);
    if (q === "SELECT set_config('realm.workspace_id', $1, true)") { assert.deepEqual(values, ["workspace"]); return result([]); }
    if (q === normalize(GOAL_TRANSPORT_CAPABILITY_SQL)) { assert.deepEqual(values, []); return result([{ available: options.schema !== false }]); }
    if (q === normalize(LOAD_TRANSPORT_GOALS_SQL)) {
      if (options.sqlFailure) throw new Error("actual-projection-failure");
      assert.ok(calls.some(c => c.sql === normalize(GOAL_TRANSPORT_CAPABILITY_SQL)));
      assert.deepEqual(values, ["workspace", "world", "line", ["story"], options.whole ? options.chained ? ["record", "sibling", "tail"] : ["record", "sibling"] : ["record"]]);
      return result(rows);
    }
    if (q === normalize(LOAD_GOAL_CONTENT_BINDING_SQL)) {
      assert.equal(values[0], "workspace");
      return result(options.missingBinding ? [] : bindings.filter(b => b.instanceId === values[1]).map(binding => ({ binding })));
    }
    for (const family of ["action_receipts", "character_effects", "observations"] as const) {
      const match = /DECLARE (realm_evidence_[a-f0-9]+) NO SCROLL/.exec(q);
      if (match && q === normalize(evidenceHeaderSql(family, match[1]))) { cursors.add(match[1]); return result([]); }
    }
    const fetch = /^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM (realm_evidence_[a-f0-9]+)$/.exec(q);
    if (fetch) { assert.ok(cursors.has(fetch[1])); return result([]); }
    const close = /^CLOSE (realm_evidence_[a-f0-9]+)$/.exec(q);
    if (close) { assert.ok(cursors.delete(close[1])); return result([]); }
    if ((["participants", "scenes", "visibility"] as const).some(f => q === normalize(topologyHeaderSql(f)))) return result([]);
    // These maintained resource grammars are exercised only with empty data;
    // scope and cursor parameters are still checked, and no write is admitted.
    if (q.startsWith("/* runtime event headers */ SELECT ") && q.endsWith("ORDER BY record_ordinal ASC, id ASC LIMIT 1000")
      && q.includes("FROM events WHERE workspace_id=$1 AND record_id=$2")) {
      assert.deepEqual(values, ["workspace", values[1], null, null]); return result([]);
    }
    if (q.startsWith("/* runtime outbox headers; outbox preflight; outbox bounded envelope */ SELECT ")
      && q.includes("FROM outbox WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4")
      && q.endsWith("ORDER BY created_at ASC, id ASC LIMIT 1000")) return result([]);
    if (options.whole && /^\/\* memory resource header (conclusions|snapshots|relationships) \*\/ SELECT /.test(q)
      && q.endsWith('memory_headers ORDER BY keys COLLATE "C"') && q.includes("workspace_id=$1 AND world_id=$2 AND worldline_id=$3")) {
      assert.deepEqual(values.slice(0, 3), ["workspace", "world", "line"]); return result([]);
    }
    if (!staticSql.has(q)) throw new Error(`UNKNOWN_SQL_TEXT:${q}`);
    if (q.includes("record.id AS record_id")) {
      if (options.whole && options.role === "player") return result([]);
      return result([{ world_id: "world", worldline_id: "line", record_id: "record", story_id: "story",
        world_version: "0.0.0-local", record_version: 0, next_record_ordinal: 0 }]);
    }
    if (q.startsWith("SELECT status FROM records")) return result([{ status: "active" }]);
    if (q.startsWith("SELECT role FROM player_world_memberships")) return result([{ role: options.role ?? "owner" }]);
    if (q.startsWith("SELECT 1 AS unsupported_scoped_goal")) return result(options.noGoals || options.authored ? [] : [{ unsupported_scoped_goal: 1 }]);
    if (q.startsWith("SELECT id, goal_key, state, revision")) return result(rows.filter(row => row.record_id === values.at(-1)));
    if (q.endsWith("AS mixed")) return result([{ mixed: false }]);
    if (q.endsWith("AS bound")) return result([{ bound: false }]);
    if (q.startsWith("SELECT id,title,status,premise FROM stories") || q.startsWith("SELECT id, title, status, premise FROM stories"))
      return result([{ id: "story", title: "Story", status: "active", premise: "" }]);
    if (q.startsWith("SELECT record.id FROM records record")) {
      assert.ok(q.includes("goal.definition_source='content'")); return result([{ id: "record" }, { id: "sibling" }]);
    }
    if (q.startsWith("SELECT record.id, record.story_id, record.title")) return result((values[3] as string[]).map(id => ({
      id, story_id: "story", title: "Sibling", status: "active", world_version: "0.0.0-local",
      start_tick: 0, start_ordinal: 0, timeline_kind: "primary", linked_record_id: options.chained && id === "sibling" ? "tail" : null,
      record_version: 0, next_record_ordinal: 0, last_event_id: null, last_world_tick: null, last_world_ordinal: null,
    })));
    if (q.startsWith("SELECT linked_record_id FROM records")) return result([{ linked_record_id: null }]);
    if (q.startsWith("/* memory resource head */")) return result([{ head_tick: 0, head_ordinal: 0 }]);
    if (q.startsWith("SELECT definition FROM record_goal_definitions")) return result(authored ? [{ definition: authored }] : []);
    if (emptyTables.has(/\bFROM (\w+)/.exec(q)?.[1] ?? "")) return result([]);
    throw new Error(`UNKNOWN_SQL_PROTOCOL:${q}`);
  } };
  const database = { async connect() { acquired++; return client; } };
  const resolver = async (...args: Parameters<typeof resolve>) => { if (options.revoke) throw new Error("revoked-source"); return resolve(...args); };
  const reader = options.negotiate === false
    ? createPostgresRealmRuntimeSaveReader(database as never, { resolveGoalSource: resolver })
    : createPostgresRealmRuntimeSaveReader(database as never, { goalsSchemaVersion: 2, resolveGoalSource: resolver });
  const load = () => reader.load({ workspaceId: "workspace", recordId: "record", principalId: "owner",
    purpose: options.whole ? "whole-closure-backup" : "record-export" });
  return { load, calls, counts: () => ({ acquired, released, cursors: cursors.size }) };
}

test("actual authorized reader → ZIP → explicit parser carries three typed Goal owners with exact source", async () => {
  const fixture = await productionReaderFixture(); const saved = await fixture.load(); assert.ok(saved);
  const parsed = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(saved), { goalsSchemaVersion: 2 });
  if (parsed.goals.schemaVersion !== 2) assert.fail("missing V2");
  assert.deepEqual(parsed.goals.roots.map(r => r.owner.scopeKind).sort(), ["record", "story", "worldline"]);
  for (const root of parsed.goals.roots) assert.equal(root.instances[0].progress.literal, "instance-0 record sibling");
  assert.equal(fixture.calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(fixture.calls.at(-1)!.sql, "COMMIT"); assert.deepEqual(fixture.counts(), { acquired: 1, released: 1, cursors: 0 });
});

test("reader schema absence, missing binding, revoked source, SQL failure and absent negotiation fail closed", async () => {
  for (const [options, expected] of [
    [{ schema: false }, { code: "RUNTIME_SAVE_INVALID" }],
    [{ missingBinding: true }, { code: "GOAL_HISTORICAL_BINDING_UNRESOLVED" }],
    [{ revoke: true }, /revoked-source/], [{ sqlFailure: true }, /actual-projection-failure/],
    [{ negotiate: false }, { code: "GOAL_TRANSPORT_VERSION_UNSUPPORTED" }],
  ] as const) {
    const fixture = await productionReaderFixture(options); await assert.rejects(fixture.load(), expected);
    assert.equal(fixture.calls.some(c => /^(INSERT|UPDATE|DELETE)\b/.test(c.sql)), false);
    if ('schema' in options) assert.equal(fixture.calls.some(c => c.sql.includes("FROM goal_content_instance_bindings")), false);
  }
});

test("whole reader seeds a content-only sibling into the existing fixed point and emits global-only GoalsV2", async () => {
  const previous = process.env.REALM_OPERATOR_PRINCIPALS; process.env.REALM_OPERATOR_PRINCIPALS = "owner";
  try {
    const fixture = await productionReaderFixture({ whole: true, chained: true }); const saved = await fixture.load(); assert.ok(saved);
    const parsed = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(saved), { goalsSchemaVersion: 2 });
    if (parsed.goals.schemaVersion !== 2) assert.fail("missing V2");
    assert.equal(parsed.goals.roots.length, 4); assert.equal(parsed.domain?.records?.length, 2);
    assert.deepEqual(parsed.domain!.records![0].bundle.goals.instances, []);
    assert.equal(fixture.calls.filter(c => c.sql.startsWith("SELECT record.id, record.story_id, record.title")).length, 2);
    assert.deepEqual(fixture.counts(), { acquired: 1, released: 1, cursors: 0 });
    const target=consumerProtocol();const first=await target.restore(parsed);assert.equal(first.importedGoalInstanceCount,4);assert.equal(first.importedDomainRecordCount,2);
    const exported=await target.export(first.recordId,true);assert.ok(exported);
    const second=consumerProtocol();const again=await second.restore(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(exported),{goalsSchemaVersion:2}),"whole-second");
    assert.equal(again.importedGoalInstanceCount,4);assert.equal(again.importedDomainRecordCount,2);
    const denied = await productionReaderFixture({ whole: true, role: "player" }); assert.equal(await denied.load(), null);
    assert.equal(denied.calls.some(c => c.sql === GOAL_TRANSPORT_CAPABILITY_SQL.replace(/\s+/g, " ").trim()), false);
  } finally { if (previous === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = previous; }
});

test("actual authored and no-Goal readers preserve V1 on installed and uninstalled binding schemas", async () => {
  for (const kind of ["authored", "noGoals"] as const) {
    const results = [];
    for (const schema of [false, true]) {
      const fixture = await productionReaderFixture({ [kind]: true, schema, negotiate: false });
      const saved = await fixture.load(); assert.ok(saved); assert.equal(saved.goals.schemaVersion, 1);
      results.push(Buffer.from(buildRealmRuntimeSaveArchive(saved)));
      assert.equal(fixture.calls.some(c => c.sql.includes("FROM goal_content_instance_bindings")), false);
    }
    assert.deepEqual(results[0], results[1]);
  }
});

test("real V2 archive and direct writer use the inherited 64 MiB document budget beyond the definition codec's 16 MiB cap", async () => {
  assert.equal(MEMORY_RUNTIME_FILE_BYTES, 64 * 1024 * 1024);
  // High-entropy content respects the inherited ZIP expansion-ratio guard.
  const literal = randomBytes(12 * 1024 * 1024 + 1).toString("base64");
  const fixture=await productionReaderFixture();const saved=await fixture.load();assert.ok(saved);if(saved.goals.schemaVersion!==2)assert.fail();
  const source = saved.goals; source.roots[0].instances[0].progress = { literal };
  assert.throws(() => canonicalGoalJson(source));
  const bytes = buildRealmRuntimeSaveArchive({...saved,goals:source,manifest:realmRuntimeSaveManifestFromData({...saved,...saved.manifest,goals:source})});
  const parsed = parseRealmRuntimeSaveArchive(bytes, { goalsSchemaVersion: 2 });
  if (parsed.goals.schemaVersion !== 2) assert.fail("missing V2");
  assert.equal(parsed.goals.roots[0].instances[0].progress.literal, literal);
  const target=consumerProtocol();assert.equal((await target.restore(parsed)).importedGoalInstanceCount,3);
  assert.equal((target.rows.goal_instances.find(g=>(g.progress as Record<string,unknown>).literal===literal)!.progress as Record<string,unknown>).literal,literal);
});
