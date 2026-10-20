import { GOAL_TRANSPORT_CAPABILITY_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { evidenceHeaderSql } from "../database/postgres/runtime-evidence-resource-reader.ts";
import {topologyHeaderSql} from "../database/postgres/runtime-topology-resource-reader.ts";

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
/** Production reader -> real ZIP -> parser -> unchanged restorer; explicit SQL protocol doubles, NOT PG. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive,
  serializeRealmRuntimeSaveTopologyV1, type RealmRuntimeSaveArchive, type RealmRuntimeSaveTopologyV1 } from "../modules/world-transfer/realm-runtime-save.ts";
const SCOPED_GOAL_EXPORT_REFUSAL_SQL = `SELECT 1 AS unsupported_scoped_goal
     FROM goal_instances AS goal
     WHERE goal.workspace_id = $1 AND goal.world_id = $2 AND goal.worldline_id = $3
       AND goal.record_id IS NULL
       AND ((goal.scope_kind = 'worldline' AND goal.story_id IS NULL)
         OR (goal.scope_kind = 'story' AND ($4::text IS NULL OR goal.story_id = $4)
           AND EXISTS (SELECT 1 FROM stories AS owner_story
             WHERE owner_story.workspace_id = goal.workspace_id AND owner_story.world_id = goal.world_id
               AND owner_story.worldline_id = goal.worldline_id AND owner_story.id = goal.story_id)))
     LIMIT 1`.replace(/\s+/g,' ').trim();

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
const scope={workspaceId:'ws-f4c',worldId:'world-f4c',worldlineId:'line-f4c',recordId:'record-f4c'};
type Participant = RealmRuntimeSaveTopologyV1["participants"][number];
type Entry = { id: string; people: Participant[] };
type Call = { sql: string; values: unknown[] };
function participant(id: string,parent: string | null=null,continuity='continuity-f4c'): Participant{
 return {sourceParticipantId:`participant-${id}`,participantKind:'character',sourcePrincipalId:null,controllerMode:'ai',isActive:true,speakingOrder:0,sharedControlEnabled:false,
  character:{sourceCharacterInstanceId:id,sourceContinuityId:continuity,sourcePredecessorInstanceId:parent,sourceDefinitionId:'definition-f4c',
   definition:{displayName:'角色前驱对照',sourceFormat:'native',profile:{literal:'leave parent IDs in prose unchanged'}},
   continuity:{continuityKey:continuity,status:'active',bornTick:0,bornOrdinal:0,endedTick:null,endedOrdinal:null},
   instance:{controllerMode:'ai',status:'present',instantiatedTick:0,instantiatedOrdinal:0,inheritanceCutoffTick:0,inheritanceCutoffOrdinal:0,retiredTick:null,retiredOrdinal:null,state:{literalParent:parent}}}};
}
function topology(p: Participant,id: string): RealmRuntimeSaveTopologyV1{return {format:'realm-runtime-topology',schemaVersion:1,participants:[p],scenes:[{sourceSceneId:`scene-${id}`,title:'Scene',status:'active',location:'',objective:'',tension:'',weather:'',displayTime:'',startTick:0,startOrdinal:0,endTick:null,endOrdinal:null}],visibilityPolicies:[{sourceVisibilityPolicyId:`policy-${id}`,policyKey:`public-${id}`,policyVersion:1,policyKind:'public',sourceSceneId:null,restrictedDomainId:null,sourcePrivateCharacterInstanceId:null,sourceAudienceCharacterInstanceIds:[]}]};}
function topologyRow(p: Participant){const c=p.character!;return {
 participant_id:p.sourceParticipantId,participant_kind:'character',participant_principal_id:null,participant_controller_mode:'ai',participant_is_active:true,participant_speaking_order:0,participant_shared_control_enabled:false,
 instance_id:c.sourceCharacterInstanceId,instance_continuity_id:c.sourceContinuityId,instance_predecessor_id:c.sourcePredecessorInstanceId,instance_controller_mode:'ai',instance_status:'present',instance_instantiated_tick:0,instance_instantiated_ordinal:0,instance_inheritance_cutoff_tick:0,instance_inheritance_cutoff_ordinal:0,instance_retired_tick:null,instance_retired_ordinal:null,instance_state:c.instance.state,
 continuity_key:c.continuity.continuityKey,continuity_status:'active',continuity_born_tick:0,continuity_born_ordinal:0,continuity_ended_tick:null,continuity_ended_ordinal:null,
 definition_id:c.sourceDefinitionId,definition_display_name:c.definition.displayName,definition_source_format:'native',definition_profile:c.definition.profile};}
function reader(entries: Entry[], options: { role?: string; ownerOverride?: {id:string; record_id:string; continuity_id:string; workspace_id:string; world_id:string; worldline_id:string}[] } = {}) {
  const calls: Call[]=[]; let acquired=0,released=0,active=false;
  const owners=options.ownerOverride??entries.flatMap(entry=>entry.people.flatMap(p=>p.character?[{id:p.character.sourceCharacterInstanceId,
    record_id:entry.id,continuity_id:p.character.sourceContinuityId,workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId}]:[]));
  const commandMapCapabilitySQL = "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available";
  const commandMapReadSQL = "SELECT schema_version, world_version, content_hash, policy_version, project_key, milestone_key, project_id, milestone_id, story_id, record_id, link_kind FROM realmworld_command_materializations WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 ORDER BY project_key, milestone_key LIMIT 257";
  const emptyTables=new Set(['events','goal_instances','goal_assessments','record_goal_definitions','action_receipts','character_effects','observations',
    'memory_conclusions','memory_snapshots','relationship_states','outbox','record_first_nights','record_self_play_sessions','projects','project_milestones',
    'project_story_links','budget_allocations','finance_accounts','ledger_entries','project_finance_command_groups','obligations','obligation_settlements',
    'story_node_instances','story_unlock_ledger','committed_fact_commands','performance_assessments','member_relationship_revisions','character_assets',
    'story_definition_bindings','record_archives','worldlines','records']);
  const readerProbe=createLegacyEmptyReaderProbe(entries.map(e=>e.id));
  const client={release(){readerProbe.assertClosed();released++;},async query(sql:string,values:unknown[]=[]){
    assert.equal(active,false,'same client sequential SQL');active=true;calls.push({sql,values});
    try {
      const probe=readerProbe(sql,values); if(probe!==undefined)return {rows:probe,rowCount:probe.length};
      let rows: unknown[]=[];
      // Installed schema, explicitly no persisted policy map in this Character-only fixture.
      if (sql.replace(/\s+/g, ' ').trim() === commandMapCapabilitySQL) {
        assert.deepEqual(values, []);
        rows = [{ command_materializations_available: true }];
      } else if (sql.replace(/\s+/g, ' ').trim() === commandMapReadSQL) {
        assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId]);
        rows = [];
      } else if (sql.includes('realmworld_command_materializations') || sql.includes('command_materializations_available')) {
        throw new Error('UNKNOWN_COMMAND_MATERIALIZATION_SQL');
      } else if(sql.replace(/\s+/g,' ').trim()===SCOPED_GOAL_EXPORT_REFUSAL_SQL) {
        assert.deepEqual(values.slice(0,3),[scope.workspaceId,scope.worldId,scope.worldlineId]);
        assert.equal(values.length,4);assert.ok(values[3]==='story-f4c'||values[3]===null);
        rows=[]; // Explicitly no persisted Story/worldline Goal facts in this Character fixture.
      }
      else if(sql.includes('record.id AS record_id')) rows=sql.includes('backup_membership')&&options.role!==undefined&&options.role!=='owner'?[]:[{world_id:scope.worldId,worldline_id:scope.worldlineId,record_id:scope.recordId,story_id:'story-f4c',world_version:'1.2.0',record_version:0,next_record_ordinal:0}];
      else if(sql.includes('FROM player_world_memberships')) rows=[{role:options.role??'owner'}];
      else if(sql.includes('AS mixed')) rows=[{mixed:false}];
      else if(sql.includes('AS bound')) rows=[{bound:false}];
      else if(sql.includes('FROM participants AS participant')) rows=(entries.find(e=>e.id===values[3])?.people??[]).toSorted((a,b)=>a.speakingOrder-b.speakingOrder||a.sourceParticipantId.localeCompare(b.sourceParticipantId)).map(topologyRow);
      else if(sql.includes('FROM scenes')) rows=[{scene_id:`scene-${values[3]}`,title:'Scene',status:'active',location:'',objective:'',tension:'',weather:'',display_time:'',start_tick:0,start_ordinal:0,end_tick:null,end_ordinal:null}];
      else if(sql.includes('FROM visibility_policies')) rows=[{policy_id:`policy-${values[3]}`,policy_key:`public-${values[3]}`,policy_version:1,policy_kind:'public',scene_id:null,restricted_domain_id:null,private_character_instance_id:null,audience_character_instance_ids:[]}];
      else if(sql.includes('FROM stories')) rows=[{id:'story-f4c',title:'F4c',status:'active',premise:''}];
      else if(sql.includes('memory resource epoch header')) rows=(values[3] as string[]).map(id=>({observer_continuity_id:id,epoch:0}));
      else if(sql.includes('SELECT record.id, record.story_id, record.title')) rows=entries.filter(e=>(values[3] as string[]).includes(e.id)).map(e=>({id:e.id,story_id:'story-f4c',title:'Sibling',status:'active',world_version:'1.2.0',start_tick:0,start_ordinal:0,timeline_kind:'primary',linked_record_id:null,record_version:0,next_record_ordinal:0,last_event_id:null,last_world_tick:null,last_world_ordinal:null}));
      else if(sql.includes('/* export character predecessor owners */')) {
        assert.match(sql,/workspace_id=\$1 AND world_id=\$2 AND worldline_id=\$3/);
        assert.match(sql,/id=ANY\(\$4::text\[\]\)/); assert.match(sql,/LIMIT 1000/);
        assert.ok((values[3] as string[]).length<=1000);
        rows=owners.filter(o=>o.workspace_id===values[0]&&o.world_id===values[1]&&o.worldline_id===values[2]&&(values[3] as string[]).includes(o.id));
      } else if(/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT|SELECT set_config|SELECT current_setting)/.test(sql)) { /* Explicit transaction protocol: no returned domain rows. */ }
      else {
        const table=[...sql.matchAll(/\bFROM\s+(\w+)/ig)].at(-1)?.[1];
        if(!table||!emptyTables.has(table)) throw new Error(`UNEXPECTED_READER_SQL: ${sql}`);
        // Any new Character query must be explicitly modeled above.
        assert.doesNotMatch(sql,/FROM character_instances/);
      }
      if(sql.startsWith("/* runtime topology"))rows=topologyFixtureHeaders(sql.replace(/\s+/g," ").trim(),rows as Record<string,unknown>[],values);
      return {rows,rowCount:rows.length};
    } finally {active=false;}
  }};
  const database={async connect(){acquired++;return client;}};
  async function load(purpose:'record-export'|'native-record-branch'|'whole-closure-backup'='record-export'){
    return createPostgresRealmRuntimeSaveReader(database as never).load({workspaceId:scope.workspaceId,recordId:scope.recordId,principalId:'owner-f4c',purpose,...(purpose==='native-record-branch'?{sessionProof:'protocol-proof'}:{})});
  }
  return {load,calls,counts:()=>({acquired,released})};
}
function restoring(){
  const calls:Call[]=[],records=new Set<string>(),continuities=new Set<string>(),instances=new Map<string,{scope:unknown[];recordId:string;parent:unknown}>();let released=0;
  const client={release(){released++;},async query(sql:string,values:unknown[]=[]){
    calls.push({sql,values});
    if(sql === 'SELECT restore_delivery_kind FROM public.outbox WHERE false'){
      assert.deepEqual(values,[]);
      assert.equal(calls.filter(c=>c.sql === 'SELECT restore_delivery_kind FROM public.outbox WHERE false').length,1);
      assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO')).length,0);
      return {rows:[],rowCount:0};
    }
    if(sql.includes('record_goal_restore_group_prepare'))return {rows:[{admission:{actor:'owner-f4c',planCommitment:'c'.repeat(64)}}],rowCount:1};
    if(sql.includes('FROM worlds'))return {rows:[{world_version:'1.2.0',status:'active',settings:{}}],rowCount:1};
    if(sql.includes('FROM player_world_memberships'))return {rows:[{role:'owner'}],rowCount:1};
    if(sql.includes('INSERT INTO records')){assert.ok(!records.has(String(values[4])));records.add(String(values[4]));}
    if(sql.includes('INSERT INTO character_continuities'))continuities.add(String(values[4]));
    if(sql.includes('INSERT INTO character_instances')){
      const [ws,world,line,rec,continuity,parent,id]=values;assert.ok(records.has(String(rec)));assert.ok(continuities.has(String(continuity)));
      if(parent!==null){const prior=instances.get(String(parent));assert.ok(prior,'immediate parent must already exist');assert.deepEqual(prior.scope,[ws,world,line,continuity]);}
      assert.ok(!instances.has(String(id)));instances.set(String(id),{scope:[ws,world,line,continuity],recordId:String(rec),parent});
    }
    if(sql.includes('INSERT INTO participants')&&values[5]==='character')assert.equal(instances.get(String(values[6]))?.recordId,values[3]);
    return {rows:[],rowCount:0};
  }};
  return {calls,records,instances,released:()=>released,restore:(archive:RealmRuntimeSaveArchive)=>createPostgresRealmRuntimeSaveRestorer({connect:async()=>client} as never,{validateWorldBinding:async()=>{}}).restore({workspaceId:scope.workspaceId,principalId:'owner-f4c',targetWorldId:scope.worldId,idempotencyKey:'f4c-new-probe',sessionProof:'protocol-proof',archive})};
}
function roundtrip(a: NonNullable<Awaited<ReturnType<ReturnType<typeof reader>['load']>>>) {
  const bytes=buildRealmRuntimeSaveArchive(a);assert.equal(Buffer.from(bytes).subarray(0,2).toString(),'PK');return {bytes,parsed:parseRealmRuntimeSaveArchive(bytes)};
}
const invalid=(e:unknown): e is Error & {code:"RUNTIME_SAVE_INVALID"}=>e instanceof Error&&'code' in e&&e.code==='RUNTIME_SAVE_INVALID';
test('ordinary root Character reader -> true ZIP -> parse -> restore stays valid',async()=>{
  const f=reader([{id:scope.recordId,people:[participant('root')]}]),a=roundtrip((await f.load())!),r=restoring();await r.restore(a.parsed);
  assert.equal(r.instances.size,1);assert.deepEqual(f.counts(),{acquired:1,released:1});
  assert.equal(r.calls.filter(c=>c.sql === 'SELECT restore_delivery_kind FROM public.outbox WHERE false').length,1);
});
test('inherited codec/schema forbid distinct same-continuity ancestors in one Record (scope report, not a positive)',async()=>{
  const f=reader([{id:scope.recordId,people:[participant('child','parent'),participant('parent')]}]);
  await assert.rejects(f.load(),invalid);
});
test('ordinary export refuses dangling private predecessor before success and without owner lookup',async()=>{
  const f=reader([{id:scope.recordId,people:[participant('child','private-parent')]},{id:'private-record',people:[participant('private-parent')]}]);
  await assert.rejects(f.load(),e=>invalid(e)&&!e.message.includes('private-parent')&&!e.message.includes('private-record'));
  assert.equal(f.calls.filter(c=>c.sql.includes('export character predecessor owners')).length,0);
  assert.equal(f.calls.at(-1)!.sql,'ROLLBACK');
});
test('native proof alone refuses cross-Record ancestry without importing private siblings',async()=>{
  const f=reader([{id:scope.recordId,people:[participant('child','private-parent')]},{id:'private-record',people:[participant('private-parent')]}]);
  await assert.rejects(f.load('native-record-branch'),e=>invalid(e)&&!e.message.includes('private-parent')&&!e.message.includes('private-record'));
  assert.equal(f.calls.filter(c=>c.sql.includes('export character predecessor owners')).length,0);
});
test('native root positive still reads real ZIP and restores',async()=>{
  const f=reader([{id:scope.recordId,people:[participant('root')]}]),r=restoring();await r.restore(roundtrip((await f.load('native-record-branch'))!).parsed);assert.equal(r.instances.size,1);
});
async function whole(f:ReturnType<typeof reader>){
  const old=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS='owner-f4c';
  try{return await f.load('whole-closure-backup');}finally{if(old===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=old;}
}
function ancestry(count=2): Entry[]{return [{id:scope.recordId,people:[participant('aa-child',count?'middle-1':null)]},...Array.from({length:count},(_,i)=>({id:`owner-${String(i+1).padStart(3,'0')}`,people:[participant(`middle-${i+1}`,i+1===count?null:`middle-${i+2}`)]}))];}
test('whole actual reader -> true ZIP -> parse -> restore carries three-Record reverse Character ancestry',async()=>{
  const entries=ancestry(),f=reader([entries[0]!,entries[2]!,entries[1]!]),a=roundtrip((await whole(f))!),r=restoring();
  // This success assertion is separate from narrow refusal and has no sentinel.
  await r.restore(a.parsed);assert.equal(r.instances.size,3);assert.equal(a.parsed.domain!.records!.length,2);
  assert.deepEqual(a.parsed.domain!.records!.map(row=>row.recordId),['owner-001','owner-002']);
  const rows=r.calls.filter(c=>c.sql.includes('INSERT INTO character_instances')).map(c=>c.values);
  assert.equal(rows[0]![5],null);assert.equal(rows[1]![5],rows[0]![6]);assert.equal(rows[2]![5],rows[1]![6]);
  assert.equal(JSON.parse(String(rows[2]![15])).literalParent,'middle-1');
  assert.equal(f.calls.filter(c=>c.sql.includes('export character predecessor owners')).length,2);
  assert.equal(f.calls.at(-1)!.sql,'COMMIT');assert.deepEqual(f.counts(),{acquired:1,released:1});
});
for(const kind of ['missing','self-cycle','cross-record-cycle','foreign-continuity','foreign-workspace','foreign-world','foreign-worldline','missing-anchor','conflicting-representation'] as const){
 test(`whole closure rejects ${kind} before successful archive`,async()=>{
  const entries=ancestry();let override: Parameters<typeof reader>[1];
  if(kind==='missing')entries.pop();
  if(kind==='self-cycle')entries[0]!.people=[participant('aa-child','aa-child')];
  if(kind==='cross-record-cycle')entries[2]!.people=[participant('middle-2','aa-child')];
  if(kind==='foreign-continuity')entries[1]!.people=[participant('middle-1','middle-2','foreign-continuity')];
  if(kind.startsWith('foreign-')&&kind!=='foreign-continuity'){
   override={ownerOverride:[{id:'middle-1',record_id:'owner-001',continuity_id:'continuity-f4c',workspace_id:kind==='foreign-workspace'?'foreign':scope.workspaceId,world_id:kind==='foreign-world'?'foreign':scope.worldId,worldline_id:kind==='foreign-worldline'?'foreign':scope.worldlineId}]};
  }
  if(kind==='missing-anchor'){
   entries[1]!.people=[];override={ownerOverride:[{id:'middle-1',record_id:'owner-001',continuity_id:'continuity-f4c',workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId}]};
  }
  if(kind==='conflicting-representation'){
   const p=participant('aa-child','middle-1');p.sourceParticipantId='participant-conflict';p.character!.instance.state={different:true};entries[0]!.people.push(p);
  }
  const f=reader(entries,override);await assert.rejects(whole(f),invalid);
  assert.equal(f.calls.filter(c=>/\b(?:INSERT|UPDATE|DELETE)\b/.test(c.sql)).length,0);
  assert.equal(f.calls.at(-1)!.sql,'ROLLBACK');
 });
}
for(const count of [64,65])test(`whole owner fixed point ${count} non-root capacity`,async()=>{
 const f=reader([...ancestry(count),{id:'unrelated-private',people:[participant('unrelated',null,'other-continuity')]}]);
 if(count===65){await assert.rejects(whole(f),invalid);assert.equal(f.calls.at(-1)!.sql,'ROLLBACK');}
 else {const a=roundtrip((await whole(f))!),r=restoring();await r.restore(a.parsed);assert.equal(a.parsed.domain!.records!.length,64);assert.equal(r.instances.size,65);}
 const batches=f.calls.filter(c=>c.sql.includes('SELECT record.id, record.story_id, record.title')).flatMap(c=>c.values[3] as string[]);
 assert.ok(!batches.includes('unrelated-private'));assert.ok(batches.length<=64);
});
test('whole operator plus owner boundary remains mandatory; native proof cannot replace it',async()=>{
 const f=reader(ancestry());const old=process.env.REALM_OPERATOR_PRINCIPALS;delete process.env.REALM_OPERATOR_PRINCIPALS;
 try{await assert.rejects(f.load('whole-closure-backup'),e=>e instanceof Error&&'code' in e&&e.code==='BACKUP_FORBIDDEN');assert.equal(f.calls.length,0);}
 finally{if(old!==undefined)process.env.REALM_OPERATOR_PRINCIPALS=old;}
 const observer=reader(ancestry(),{role:'observer'});assert.equal(await whole(observer),null);assert.equal(observer.calls.filter(c=>c.sql.includes('export character predecessor owners')).length,0);
});
test('root topology bytes/hash, source ordering and literal state remain unchanged through restore',async()=>{
 const p=participant('root');p.character!.instance.state={literalParent:'outside-parent',nested:{id:'aa-child'}};
 const f=reader([{id:scope.recordId,people:[p]}]),a=(await f.load())!;
 const expected=serializeRealmRuntimeSaveTopologyV1(topology(p,scope.recordId)),actual=serializeRealmRuntimeSaveTopologyV1(a.topology!);
 assert.equal(actual,expected);const sha=createHash('sha256').update(actual).digest('hex');console.log(JSON.stringify({topologyBytes:Buffer.byteLength(actual),topologySha256:sha}));
 const r=restoring();await r.restore(roundtrip(a).parsed);const row=r.calls.find(c=>c.sql.includes('INSERT INTO character_instances'))!;
 assert.deepEqual(JSON.parse(String(row.values[15])),p.character!.instance.state);
 const q=participant('a',null,'other-continuity'),z=participant('z',null,'z-continuity');
 const sorted=(await reader([{id:scope.recordId,people:[z,q]}]).load())!;assert.deepEqual(sorted.topology!.participants.map(x=>x.sourceParticipantId),['participant-a','participant-z']);
});
test('whole repeated export/ZIP consumption stays complete in independent restore protocol states',async()=>{
 const f=reader(ancestry());for(let run=0;run<2;run++){const a=roundtrip((await whole(f))!),r=restoring();await r.restore(a.parsed);assert.equal(r.records.size,3);assert.equal(r.instances.size,3);assert.equal(r.released(),1);}
});
for(const kind of ['missing','cycle','foreign-continuity'] as const)test(`unchanged restorer rejects ${kind} complete-input corruption before first business write`,async()=>{
 const a=roundtrip((await whole(reader(ancestry())))!).parsed;
 const p=a.topology!.participants[0]!;
 const root={...p,character:{...p.character!,sourcePredecessorInstanceId:kind==='missing'?'missing':kind==='cycle'?'aa-child':'middle-1',...(kind==='foreign-continuity'?{sourceContinuityId:'foreign-continuity',continuity:{...p.character!.continuity,continuityKey:'foreign-continuity'}}:{})}};
 const corrupted={...a,topology:{...a.topology!,participants:[root]}},r=restoring();await assert.rejects(r.restore(corrupted),invalid);
 assert.equal(r.calls.filter(c=>/\b(?:INSERT|UPDATE|DELETE)\b/.test(c.sql)).length,0);
});
