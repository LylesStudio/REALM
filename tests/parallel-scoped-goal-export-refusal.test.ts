import { GOAL_TRANSPORT_CAPABILITY_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { createRecordGoalDefinition } from "../modules/goals/record-authoring.ts";
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
/** Strict SQL protocol controls. No PostgreSQL, RLS or SQL planner claim. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer, buildRealmRuntimeSaveBytes } from "../database/postgres/realm-runtime-save-repository.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";

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
const scope = {workspaceId:"s1-ws",worldId:"s1-world",worldlineId:"s1-line",recordId:"s1-record",storyId:"s1-story"};
const norm = (sql: string) => sql.replace(/\s+/g," ").trim();
const detectionSQL = norm(`SELECT 1 AS unsupported_scoped_goal
     FROM goal_instances AS goal
     WHERE goal.workspace_id = $1 AND goal.world_id = $2 AND goal.worldline_id = $3
       AND goal.record_id IS NULL
       AND ((goal.scope_kind = 'worldline' AND goal.story_id IS NULL)
         OR (goal.scope_kind = 'story' AND ($4::text IS NULL OR goal.story_id = $4)
           AND EXISTS (SELECT 1 FROM stories AS owner_story
             WHERE owner_story.workspace_id = goal.workspace_id AND owner_story.world_id = goal.world_id
               AND owner_story.worldline_id = goal.worldline_id AND owner_story.id = goal.story_id)))
     LIMIT 1`);
const refusalMessage = "Story/worldline Goal export is unsupported by runtime save V1.";
const actualSQL = new Set<string>([A2_MAP_SQL, A2_CAPABILITY_SQL]);
for (const file of ["realm-runtime-save-repository.ts", "../..//modules/application/library-service.ts", "goal-runtime-materialization.ts"]) {
  for (const m of readFileSync(new URL(`../database/postgres/${file}`,import.meta.url),"utf8").matchAll(/`([^`]*?)`/g)) {
    if (!m[1].includes("${") && /^(SELECT|INSERT|UPDATE|WITH)/.test(m[1].replace(/^\s*\/\*[\s\S]*?\*\//," ").trim())) actualSQL.add(norm(m[1]));
  }
}
actualSQL.add("SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version");
for(const family of ["participants","scenes","visibility"] as const)actualSQL.add(norm(topologyHeaderSql(family)));
const rootSQL = [...actualSQL].filter(q=>q.includes("record.id AS record_id")&&!q.includes("backup_membership"));
assert.equal(rootSQL.length,1);
actualSQL.add(rootSQL[0]+" AND EXISTS ( SELECT 1 FROM player_world_memberships AS backup_membership WHERE backup_membership.workspace_id = record.workspace_id AND backup_membership.world_id = record.world_id AND backup_membership.principal_id = $3 AND backup_membership.role = 'owner' )");
const tx = new Set(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY","BEGIN ISOLATION LEVEL REPEATABLE READ","COMMIT","ROLLBACK","SAVEPOINT realm_workspace_scope","RELEASE SAVEPOINT realm_workspace_scope","ROLLBACK TO SAVEPOINT realm_workspace_scope","SELECT current_setting('realm.workspace_id', true) AS workspace_id","SELECT set_config('realm.workspace_id', $1, true)","SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only"]);
function goal(kind: "record"|"story"|"worldline", extra: Row = {}): Row {
  return {workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId,
    id:`s1-${kind}-goal`,goal_key:"same-key",scope_kind:kind,record_id:kind==="record"?scope.recordId:null,story_id:kind==="story"?scope.storyId:null,
    state:"active",revision:1,progress:{scopeKind:"story",recordId:"private-record",literal:"worldline s1-story"},outcome:null,policy_version:"content:v1",definition_source:"content",definition_id:null,resolution_kind:"natural",evidence_start_version:0,evidence_start_ordinal:0,attempt:1,supersedes_instance_id:null,...extra};
}
function fixture(goals: Row[] = [], options: {role?: string|null; root?: boolean; branch?: boolean; legacyContent?:boolean; owners?: Row[]} = {}) {
  // Use the real authored-history producer for the V1 Record-only positive.
  // Unbound Story/worldline fixtures still exercise the original V1 refusal.
  const definition=createRecordGoalDefinition({scope,goalId:"s1-authored",activationHead:{recordVersion:0,ordinal:0},
    draft:{title:"Record Goal",description:"Keep ID-shaped prose",changePolicy:"fixed",visible:true,
      successConditions:["Complete"],failureConditions:[],settlementConditions:[]}});
  goals=goals.map(g=>g.scope_kind==="record"&&!options.legacyContent?{...g,id:definition.goalInstanceId,goal_key:definition.goalKey,
    policy_version:definition.policyVersion,definition_source:"record",definition_id:definition.definitionId}:g);
  const calls: {sql:string;values:unknown[]}[] = [], detections: Row[][] = [];
  let acquired=0,released=0,currentWorkspace:unknown=null;
  const owners=options.owners ?? [{workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId,id:scope.storyId}];
  const root={world_id:scope.worldId,worldline_id:scope.worldlineId,record_id:scope.recordId,story_id:scope.storyId,world_version:"1.2.0",record_version:0,next_record_ordinal:0};
  const emptyTables=new Set(["goal_assessments","record_goal_definitions","participants","action_receipts","character_effects","observations","memory_conclusions","memory_snapshots","relationship_states","record_first_nights","record_self_play_sessions","projects","project_milestones","project_story_links","budget_allocations","finance_accounts","ledger_entries","project_finance_command_groups","obligations","obligation_settlements","story_node_instances","story_unlock_ledger","committed_fact_commands","performance_assessments","member_relationship_revisions","character_assets","story_definition_bindings","worldlines"]);
  const readerProbe=createLegacyEmptyReaderProbe([scope.recordId]);
  const client={release(){readerProbe.assertClosed();released++;},async query(raw:string,values:unknown[]=[]){
    const sql=norm(raw);calls.push({sql,values:structuredClone(values)});
    const probe=readerProbe(sql,values); if(probe!==undefined)return {rows:probe,rowCount:probe.length};
    const result=(items:Row[])=>{const rows=sql.startsWith("/* runtime topology")?topologyFixtureHeaders(sql,items,values):items;return {rows,rowCount:rows.length};};
    // Named exact S1 query handler: model schema anchors/owner relations,
    // assert all parameters, preserve the original scope and return no IDs.
    if (sql === A2_CAPABILITY_SQL) { assert.deepEqual(values, []); return result([{ command_materializations_available: inheritedCommandPolicyFixture.schemaAvailable }]); }
    if (sql === A2_MAP_SQL) { assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId]); return result(inheritedCommandPolicyFixture.rows); }
    if(sql===detectionSQL){
      assert.deepEqual(values.slice(0,3),[scope.workspaceId,scope.worldId,scope.worldlineId]);
      assert.ok(values[3]===scope.storyId||values[3]===null);assert.equal(values.length,4);
      const rows=goals.filter(g=>g.workspace_id===values[0]&&g.world_id===values[1]&&g.worldline_id===values[2]&&g.record_id===null
        &&(g.scope_kind==="worldline"&&g.story_id===null||g.scope_kind==="story"&&(values[3]===null||g.story_id===values[3])
          &&owners.some(s=>s.workspace_id===g.workspace_id&&s.world_id===g.world_id&&s.worldline_id===g.worldline_id&&s.id===g.story_id)));
      detections.push(structuredClone(rows));return result(rows.length?[{unsupported_scoped_goal:1}]:[]);
    }
    if(tx.has(sql)){
      if(sql.startsWith("SELECT set_config"))currentWorkspace=values[0];
      if(sql.includes("AS workspace_id"))return result([{workspace_id:currentWorkspace}]);
      if(sql.includes("AS isolation_level"))return result([{isolation_level:"repeatable read",read_only:"off"}]);
      return result([]);
    }
    if(/^\/\* memory resource header (snapshots|conclusions|relationships) \*\/ SELECT keys,/.test(sql)) {
      assert.deepEqual(values.slice(0,3),[scope.workspaceId,scope.worldId,scope.worldlineId]);
      assert.match(sql,/LIMIT 1000\) memory_headers ORDER BY keys COLLATE "C"$/);
      return result([]); // explicitly no persisted Memory rows in this fixture
    }
    if(sql==="SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE")return result([{status:"active"}]);
    if(!actualSQL.has(sql)&&!sql.startsWith("/* runtime event headers */")&&!sql.startsWith("/* runtime outbox headers;"))throw Error(`UNKNOWN_SQL_TEXT:${sql}`);
    if(sql.includes("record.id AS record_id")){
      assert.deepEqual(values.slice(0,2),[scope.workspaceId,scope.recordId]);
      return result(options.root===false||sql.includes("backup_membership")&&options.role!==undefined&&options.role!=="owner"?[]:[root]);
    }
    if(sql.includes("FROM player_world_memberships"))return result(options.role===null?[]:[{role:options.role??"owner"}]);
    if(sql==="SELECT status FROM records WHERE workspace_id = $1 AND id = $2")return result([{status:"active"}]);
    if(sql.startsWith("SELECT world_id FROM records"))return result([{world_id:scope.worldId}]);
    if(sql.startsWith("SELECT id FROM worlds"))return result([{id:scope.worldId}]);
    if(sql.includes("FOR UPDATE OF record"))return result([{...root,record_title:"Root",record_status:"active",story_title:"Story",story_premise:"",start_tick:"0",start_ordinal:"0",observer:false,player_role:""}]);
    if(sql.includes("FROM record_heads")&&sql.endsWith("FOR UPDATE"))return result([{last_world_tick:null,last_world_ordinal:null}]);
    if(sql.includes("FROM goal_instances goal")&&sql.endsWith("FOR UPDATE"))return result([]);
    if(sql.endsWith("AS present"))return result([{present:true}]);
    if(sql.startsWith("SELECT id, worldline_id, story_id"))return result([]);
    if(sql.includes("AS mixed"))return result([{mixed:false}]);
    if(sql.includes("AS bound"))return result([{bound:false}]);
    if(sql.startsWith("/* runtime event headers */")||sql.startsWith("/* runtime outbox headers;"))return result([]);
    const nativeRoots=[...actualSQL].find(q=>q.startsWith("SELECT record.id FROM records record ")&&q.includes("goal.scope_kind='record' AND goal.definition_source='content'")&&q.endsWith("ORDER BY record.id LIMIT $4"));
    if(sql===nativeRoots) {
      assert.deepEqual(values,[scope.workspaceId,scope.worldId,scope.worldlineId,66]);
      return result(goals.some(g=>g.workspace_id===scope.workspaceId&&g.world_id===scope.worldId&&g.worldline_id===scope.worldlineId&&g.record_id===scope.recordId&&g.definition_source==="content")?[{id:scope.recordId}]:[]);
    }
    if(sql==="SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 ORDER BY goal_id,definition_version") {
      assert.deepEqual(values,[scope.workspaceId,scope.recordId]);
      return result(goals.some(g=>g.definition_source==="record")?[{definition}]:[]);
    }
    if(sql==="SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version") {
      assert.deepEqual(values,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId]);
      return result(goals.some(g=>g.definition_source==="record")?[{definition}]:[]);
    }
    if(sql.includes("FROM goal_instances")){
      if (/record_id = \$2/.test(sql)) {assert.deepEqual(values,[scope.workspaceId,scope.recordId]);return result(goals.filter(g=>g.workspace_id===values[0]&&g.record_id===values[1]));}
      assert.deepEqual(values,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId]);
      return result(goals.filter(g=>g.workspace_id===values[0]&&g.world_id===values[1]&&g.worldline_id===values[2]&&g.record_id===values[3]));
    }
    if(sql.includes("FROM scenes"))return result([{scene_id:"s1-scene",title:"Scene",status:"active",location:"s1-story worldline",objective:"",tension:"",weather:"",display_time:"",start_tick:0,start_ordinal:0,end_tick:null,end_ordinal:null}]);
    if(sql.includes("FROM visibility_policies"))return result([{policy_id:"s1-policy",policy_key:"public",policy_version:1,policy_kind:"public",scene_id:null,restricted_domain_id:null,private_character_instance_id:null,audience_character_instance_ids:[]}]);
    if(sql.includes("FROM stories"))return result(owners.filter(s=>s.workspace_id===values[0]&&s.world_id===values[1]&&s.worldline_id===values[2]&&(!sql.includes("AND id=$4")||s.id===values[3])).map(s=>({...s,title:"Story",status:"active",premise:"story worldline private-record"})));
    if(sql.includes("FROM records"))return result([]); // named root-link/native roots and sibling identity queries: fixture has no siblings
    const table=/\bFROM (\w+)/.exec(sql)?.[1];
    if(table&&emptyTables.has(table))return result([]); // each exact production statement was admitted above
    throw Error(`UNKNOWN_SQL_HANDLER:${sql}`);
  }};
  const database={async connect(){acquired++;return client;}};
  const load=(purpose:"record-export"|"native-record-branch"|"whole-closure-backup")=>createPostgresRealmRuntimeSaveReader(database as never).load({workspaceId:scope.workspaceId,recordId:scope.recordId,principalId:"s1-owner",purpose,...(purpose==="native-record-branch"?{sessionProof:"test-proof"}:{})});
  return {client,database,load,calls,detections,counts:()=>({acquired,released})};
}
async function restoreRecordOnly(archive: ReturnType<typeof parseRealmRuntimeSaveArchive>) {
  const calls:{sql:string;values:unknown[]}[]=[];
  const client={release(){},async query(raw:string,values:unknown[]=[]){
    const sql=norm(raw);calls.push({sql,values:structuredClone(values)});
    const result=(rows:Row[]=[])=>({rows,rowCount:rows.length});
    if(sql==="SELECT restore_delivery_kind FROM public.outbox WHERE false"){assert.deepEqual(values,[]);return result();}
    if(tx.has(sql)||sql==="BEGIN")return result();
    if(sql==="SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE" || sql==="SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE") {
      assert.deepEqual(values,["s1-target-ws",scope.worldId]);return result([{world_version:"1.2.0",status:"active",settings:{}}]);
    }
    if(sql==="SELECT role FROM player_world_memberships WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3")return result([{role:"owner"}]);
    if(actualSQL.has(sql)&&sql.startsWith("SELECT record.world_id, record.worldline_id, record.story_id, record.status, story.premise AS story_premise"))return result(); // fresh restore key has no target Record
    if(sql==="SELECT record_goal_restore_group_prepare($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission") {
      assert.deepEqual(values.slice(0,3),["s1-target-ws","test-proof",scope.worldId]);
      assert.equal(calls.some(c=>c.sql.startsWith("INSERT")),false);
      return result([{admission:{actor:"s1-owner",planCommitment:"protocol-only"}}]);
    }
    if(sql==="SELECT record_goal_restore_group_definitions($1,$2,$3,$4,$5,$6::jsonb)") {
      assert.deepEqual(values.slice(0,2),["s1-target-ws","test-proof"]);
      const definitions=JSON.parse(String(values[5]));assert.equal(definitions.length,1);
      assert.equal(definitions[0].scope.recordId,values[2]);return result();
    }
    const insert=/^INSERT INTO (\w+) /.exec(sql);
    if(insert&&actualSQL.has(sql)&&new Set(["worldlines","stories","records","participants","scenes","visibility_policies","record_heads","goal_instances"]).has(insert[1]))return result();
    throw Error(`UNKNOWN_RESTORE_SQL:${sql}`);
  }};
  const restored=await createPostgresRealmRuntimeSaveRestorer({connect:async()=>client} as never,{validateWorldBinding:async()=>{}}).restore({workspaceId:"s1-target-ws",principalId:"s1-owner",sessionProof:"test-proof",targetWorldId:scope.worldId,idempotencyKey:"s1-restore",archive});
  const goals=calls.filter(c=>c.sql.startsWith("INSERT INTO goal_instances"));assert.equal(goals.length,1);
  assert.equal(goals[0].values[3],restored.recordId);assert.notEqual(restored.recordId,scope.recordId);
  assert.deepEqual(JSON.parse(String(goals[0].values[8])),goal("record").progress);
}
async function whole<T>(fn:()=>Promise<T>){const old=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS="s1-owner";try{return await fn();}finally{if(old===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=old;}}
const refusal=(error:unknown)=>{assert.equal((error as {code:string}).code,"RUNTIME_SAVE_INVALID");assert.equal((error as Error).message,refusalMessage);return true;};
const purposes=["record-export","native-record-branch","whole-closure-backup"] as const;
for(const purpose of purposes)for(const kind of ["story","worldline"] as const)test(`${purpose} refuses persisted ${kind} before successful ZIP`,async()=>{
  const f=fixture([goal("record"),goal(kind)]),before=structuredClone(goal(kind));
  await whole(()=>assert.rejects(buildRealmRuntimeSaveBytes(createPostgresRealmRuntimeSaveReader(f.database as never),{workspaceId:scope.workspaceId,recordId:scope.recordId,principalId:"s1-owner",purpose,...(purpose==="native-record-branch"?{sessionProof:"test-proof"}:{})}),refusal));
  assert.equal(f.detections.length,1);assert.deepEqual(f.detections[0],[before]);
  assert.equal(f.calls.filter(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql)).length,0);
  assert.equal(f.calls.filter(c=>c.sql.includes("runtime event headers")).length,0);
  assert.equal(f.calls.at(-1)!.sql,"ROLLBACK");assert.deepEqual(f.counts(),{acquired:1,released:1});
});
for(const kind of ["story","worldline"] as const)test(`actual library snapshot branch refuses ${kind} before writes`,async()=>{
  const f=fixture([goal(kind)]);
  await assert.rejects(createPostgresLibraryService(f.database as never).branchRecord({workspaceId:scope.workspaceId,principalId:"s1-owner",sessionProof:"test-proof"},{sourceRecordId:scope.recordId,idempotencyKey:"branch-s1"}),refusal);
  assert.equal(f.detections.length,1);assert.equal(f.calls.filter(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql)).length,0);
  assert.ok(f.calls.some(c=>c.sql==="SAVEPOINT realm_workspace_scope"));
});
for(const purpose of purposes)test(`${purpose} no scoped facts preserves Record-only and ID-shaped prose`,async()=>{
  const f=fixture([goal("record")]),loaded=await whole(()=>f.load(purpose));assert.ok(loaded);
  const bytes=buildRealmRuntimeSaveArchive(loaded),parsed=parseRealmRuntimeSaveArchive(bytes);assert.equal(parsed.goals.instances.length,1);
  assert.deepEqual((parsed.goals.instances[0] as Row).progress,goal("record").progress);
  await restoreRecordOnly(parsed);
  assert.deepEqual(f.detections,[[]]);assert.deepEqual(f.counts(),{acquired:1,released:1});
});
for(const purpose of purposes)for(const foreign of ["workspace_id","world_id","worldline_id"] as const)test(`${purpose} foreign ${foreign} does not refuse authorized no-facts archive`,async()=>{
  const f=fixture([goal("story",{[foreign]:"foreign"}),goal("worldline",{[foreign]:"foreign"})]);
  const a=await whole(()=>f.load(purpose));assert.ok(a);parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a));assert.deepEqual(f.detections,[[]]);
});
for(const purpose of ["record-export","native-record-branch"] as const)test(`${purpose} private sibling Story never expands or leaks`,async()=>{
  const f=fixture([goal("story",{story_id:"private-story"})],{owners:[{workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId,id:scope.storyId},{workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId,id:"private-story"}]});
  const a=await f.load(purpose);assert.ok(a);assert.deepEqual(f.detections,[[]]);assert.ok(!JSON.stringify(a).includes("private-story"));assert.equal(a.domain?.records?.length??0,0);
});
test("whole sees actual owned sibling Story facts without reading private bodies",async()=>{
  const f=fixture([goal("story",{story_id:"private-story"})],{owners:[{workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId,id:"private-story"}]});
  await whole(()=>assert.rejects(f.load("whole-closure-backup"),refusal));assert.deepEqual(f.calls.find(c=>c.sql===detectionSQL)!.values,[scope.workspaceId,scope.worldId,scope.worldlineId,null]);
});
for(const purpose of purposes)test(`${purpose} unauthorized or foreign root never queries scoped facts`,async()=>{
  const f=fixture([goal("story")],{role:"observer"});
  if(purpose==="whole-closure-backup")assert.equal(await whole(()=>f.load(purpose)),null);
  else await assert.rejects(f.load(purpose),{code:"WORLD_READ_ONLY"});
  assert.deepEqual(f.detections,[]);
  const missing=fixture([goal("worldline")],{root:false});assert.equal(await whole(()=>missing.load(purpose)),null);assert.deepEqual(missing.detections,[]);
});
test("unbound historical Record content remains refused instead of borrowing a current definition",async()=>{
  const f=fixture([goal("record")],{legacyContent:true});
  await assert.rejects(f.load("record-export"),{code:"GOAL_HISTORICAL_BINDING_UNRESOLVED"});
  assert.equal(f.calls.some(c=>/^(INSERT|UPDATE|DELETE)/.test(c.sql)),false);
  assert.equal(f.calls.some(c=>c.sql.includes("FROM goal_content_instance_bindings")),false);
  assert.equal(f.calls.at(-1)!.sql,"ROLLBACK");assert.deepEqual(f.counts(),{acquired:1,released:1});
});
test("unknown SQL and unowned Story relation cannot manufacture a refusal witness",async()=>{
  const f=fixture([goal("story",{story_id:"unowned-story"})]);await assert.rejects(f.client.query("SELECT s1_unknown_query()"),/UNKNOWN_SQL/);
  const a=await whole(()=>f.load("whole-closure-backup"));assert.ok(a);assert.deepEqual(f.detections,[[]]);
});
