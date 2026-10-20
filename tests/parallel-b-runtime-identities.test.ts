import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordGoalDefinition, decodeRecordGoalDefinition } from '../modules/goals/record-authoring.ts';
import type { JsonValue } from '../modules/runtime/public.ts';
import { createPostgresRealmRuntimeSaveRestorer } from '../database/postgres/realm-runtime-save-repository.ts';
import { createHash } from 'node:crypto';
import { createGoalContentBindingSource, bindGoalContentWitness } from '../modules/application/goal-content-binding-source.ts';
import { computeRealmWorldContentHash } from '../modules/world-transfer/realmworld-loader.ts';
import { GOAL_RESTORE_TARGET_CAPABILITY_SQL, INSERT_RESTORED_GOAL_V2_SQL } from '../database/postgres/runtime-goal-restore.ts';
import type { GoalInstanceV2 } from '../modules/world-transfer/realm-runtime-goals-v2.ts';
import type { RealmRuntimeSaveGoals } from '../modules/world-transfer/realm-runtime-save.ts';
import { realmRuntimeSaveManifestFromData, type RealmRuntimeSaveTopologyV1, type RealmRuntimeSaveGoalsV1, type RealmRuntimeSaveRecordV1, type RealmRuntimeSaveOutboxV1 } from '../modules/world-transfer/realm-runtime-save.ts';

const record:RealmRuntimeSaveRecordV1={format:'realm-runtime-record',schemaVersion:1,scope:{worldId:'world-b',worldlineId:'line-b',recordId:'record-b'},head:{recordVersion:0,nextRecordOrdinal:0},events:[]};
const emptyGoals:RealmRuntimeSaveGoalsV1={format:'realm-runtime-goals',schemaVersion:1,instances:[],assessments:[]};
// New source-bound fixture drafts, not an upgrader for unproven V1 history.
// Server mount injection proves protocol composition, not a package signature.
const fixtureContent=JSON.stringify({format:'realmworld-goals',schemaVersion:1,goals:[
 {goalKey:'retry-goal',policyVersion:'content:v1',mode:'deterministic',visible:true,retryable:true,
  rubric:{kind:'event_count',eventKind:'narration.committed',progressKey:'count',threshold:1},outcome:{}}
]});
const fixtureHash=computeRealmWorldContentHash(new Map([['content/goals.json',Buffer.from(fixtureContent)]]));
const resolveGoalSource=createGoalContentBindingSource({mount:async identity=>{
 assert.deepEqual(identity,{worldId:'world-b',worldVersion:'1.2.0'});
 const files=new Map([['content/goals.json',Buffer.from(fixtureContent)]]);
 assert.equal(computeRealmWorldContentHash(files),fixtureHash);
 return {manifest:{format:'realmworld',formatVersion:1,worldId:'world-b',worldVersion:'1.2.0',
  engineCompat:{schemaLatest:'',requiresMigrations:[],baseRange:'*'},contentHash:fixtureHash,
  signature:{algorithm:'ed25519',keyId:'server-fixture',value:''}},files};
}});
async function sourceBoundDrafts(goals:RealmRuntimeSaveGoalsV1):Promise<RealmRuntimeSaveGoals> {
 const raw=goals.instances as Record<string,JsonValue>[];
 if(raw.every(g=>g.definitionSource==='record'))return goals;
 assert.equal(goals.assessments.length,0,'this fixture must explicitly model any new assessment');
 const owner={scopeKind:'record' as const,...record.scope};
 const definitions=(goals.definitions??[]).map(decodeRecordGoalDefinition);
 const instances:GoalInstanceV2[]=await Promise.all(raw.map(async g=>{
  const definition=definitions.find(d=>d.definitionId===g.definitionId);
  const ref={owner,instanceId:String(g.id)};
  const witness=g.definitionSource==='record'?null:await resolveGoalSource({worldId:'world-b',worldVersion:'1.2.0',goalKey:String(g.goalKey)});
  if(g.definitionSource==='record')assert.ok(definition);
  return {ref,goalKey:String(g.goalKey),policyVersion:String(g.policyVersion),state:g.state as GoalInstanceV2['state'],
   revision:Number(g.revision),progress:g.progress as Record<string,JsonValue>,outcome:g.outcome as Record<string,JsonValue>|null,
   attempt:Number(g.attempt),predecessor:g.supersedesInstanceId==null?null:
    {kind:g.definitionSource==='record'?'definition-revision' as const:'retry' as const,ref:{owner,instanceId:String(g.supersedesInstanceId)}},
   resolutionKind:(g.resolutionKind??'natural') as GoalInstanceV2['resolutionKind'],
   evidenceStart:g.definitionSource==='record'?definition!.activationHead:null,
   definition:witness?{kind:'content' as const,binding:bindGoalContentWitness(witness,'ws-b',owner,String(g.id))}:
    {kind:'record' as const,definitionId:definition!.definitionId,goalId:definition!.goalId,definitionVersion:definition!.definitionVersion}};
 }));
 return {format:'realm-runtime-goals',schemaVersion:2,workspaceId:'ws-b',
  roots:[{owner,instances}],definitions,assessments:[]};
}
function goalWrites(calls:{sql:string;values:unknown[]}[]) {
 return calls.filter(c=>c.sql.includes('INSERT INTO goal_instances')).map(c=>{
  assert.equal(c.sql,INSERT_RESTORED_GOAL_V2_SQL);
  const columns=/INSERT INTO goal_instances \(([\s\S]*?)\) VALUES/.exec(c.sql)![1].split(',').map(s=>s.trim());
  const result:Record<string,unknown>={};
  // The completion timestamp is a CASE expression and has no bound parameter.
  columns.filter(k=>k!=='completed_at').forEach((key,i)=>{result[key]=c.values[i];});
  assert.equal(c.values.length,20);return result;
 });
}
function participant(id:string, predecessor:string|null=null, continuity='continuity-b'):RealmRuntimeSaveTopologyV1['participants'][number] {
 return {sourceParticipantId:`p-${id}`,participantKind:'character',sourcePrincipalId:null,controllerMode:'ai',isActive:true,speakingOrder:0,sharedControlEnabled:false,character:{sourceCharacterInstanceId:id,sourceContinuityId:continuity,sourcePredecessorInstanceId:predecessor,sourceDefinitionId:'definition-b',definition:{displayName:'B',sourceFormat:'native',profile:{note:'same definition'}},continuity:{continuityKey:continuity,status:'active',bornTick:0,bornOrdinal:0,endedTick:null,endedOrdinal:null},instance:{controllerMode:'ai',status:'present',instantiatedTick:0,instantiatedOrdinal:0,inheritanceCutoffTick:0,inheritanceCutoffOrdinal:0,retiredTick:null,retiredOrdinal:null,state:{}}}};
}
// A SQL protocol spy only: no PostgreSQL connection, SQL parser, RLS or engine acceptance.
async function restore(participants:ReturnType<typeof participant>[]=[], goals=emptyGoals, event?:{kind:string;body:Record<string,JsonValue>}, outbox?:RealmRuntimeSaveOutboxV1, recordLinks:Record<string,string>={},legacyEmptySiblingTopology=false, bindContent=true) {
 const calls:{sql:string;values:unknown[]}[]=[];
 try {
 const archiveGoals=bindContent?await sourceBoundDrafts(goals):goals;
 const primary=participants.filter((p,i)=>i===0 || p.character!.sourceCharacterInstanceId===participants[0]!.character!.sourceCharacterInstanceId || p.character!.sourceContinuityId!==participants[0]!.character!.sourceContinuityId);
 const topology:RealmRuntimeSaveTopologyV1={format:'realm-runtime-topology',schemaVersion:1,participants:primary,scenes:[],visibilityPolicies:[]};
 const siblings=participants.filter(p=>!primary.includes(p));
 const domain=siblings.length ? {format:'realm-runtime-domain' as const,schemaVersion:1 as const,source:{worldId:'world-b',worldlineId:'line-b',storyId:'story-b',recordId:'record-b'},stories:[{id:'story-b',title:'B',status:'active' as const,premise:''}],storyDefinitions:[],records:siblings.map((p,i)=>({recordId:`sibling-${i}`,storyId:'story-b',title:'B sibling',status:'active' as const,worldVersion:'1.2.0',startTick:0,startOrdinal:0,timelineKind:'primary' as const,linkedRecordId:recordLinks[`sibling-${i}`]??null,lastEventId:null,lastWorldTick:null,lastWorldOrdinal:null,bundle:{record:{...record,scope:{...record.scope,recordId:`sibling-${i}`}},goals:emptyGoals,topology:{...topology,participants:[p],...(legacyEmptySiblingTopology?{}:{scenes:[{sourceSceneId:`scene-sibling-${i}`,title:'Sibling',status:'active' as const,location:'',objective:'',tension:'',weather:'',displayTime:'',startTick:0,startOrdinal:0,endTick:null,endOrdinal:null}],visibilityPolicies:[{sourceVisibilityPolicyId:`policy-sibling-${i}`,policyKey:`public-${i}`,policyVersion:1,policyKind:'public' as const,sourceSceneId:null,restrictedDomainId:null,sourcePrivateCharacterInstanceId:null,sourceAudienceCharacterInstanceIds:[]}]})}}})),projects:[],milestones:[],projectStoryLinks:[],budgetAllocations:[],financeAccounts:[],ledgerEntries:[],financeCommandGroups:[],obligations:[],obligationSettlements:[],storyNodes:[],storyUnlockLedger:[],committedFactCommands:[],performanceAssessments:[],memberRelationshipRevisions:[],characterAssets:[]} : undefined;
 const saved:RealmRuntimeSaveRecordV1=event?{...record,head:{recordVersion:1,nextRecordOrdinal:2},events:[{eventId:'event-b',recordVersion:1,ordinal:1,kind:event.kind,payload:{content:'literal',speakerName:'',actorParticipantId:null,sceneId:'scene-b',visibilityPolicyId:'policy-b',worldTick:1,worldOrdinal:0,calendarId:'calendar-b',displayTime:'',eventPayload:{__realmRuntimePayload:event.body}}}]}:record;
 const manifest=realmRuntimeSaveManifestFromData({engineApi:'1.x',mode:'world-bound',world:{worldId:'world-b',worldVersion:'1.2.0'},scope:{workspaceId:'ws-b',worldlineId:'line-b',recordId:'record-b'},record:saved,goals:archiveGoals,topology,...(domain?{domain}:{}),...(outbox?{outbox}:{})});
 const inserted=new Set<string>();
 let groupBody:unknown,groupRoot:unknown;
 const client={release(){},async query(sql:string, values:unknown[]=[]){
  calls.push({sql,values});
    if(sql === 'SELECT restore_delivery_kind FROM public.outbox WHERE false'){
      assert.deepEqual(values,[]);
      assert.equal(calls.filter(c=>c.sql === 'SELECT restore_delivery_kind FROM public.outbox WHERE false').length,1);
      assert.equal(calls.filter(c=>c.sql.includes('INSERT INTO')).length,0);
      return {rows:[],rowCount:0};
    }
  if(sql===GOAL_RESTORE_TARGET_CAPABILITY_SQL){assert.deepEqual(values,[]);return {rows:[{available:true}],rowCount:1};}
  if(sql==='SELECT record_goal_restore_group_prepare_v2($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission') {
   assert.deepEqual(values.slice(0,3),['ws-b','unit-session-proof','world-b']);assert.equal(values.length,7);
   assert.equal(calls.some(c=>c.sql.includes('INSERT INTO')),false);
   const plan=JSON.parse(String(values[6]));assert.equal(plan.bodyVersion,2);
   assert.equal(values[5],createHash('sha256').update('realm-runtime-restore-body:v2:').update(plan.sourceBody).digest('hex'));
   groupBody=values[5];groupRoot=values[3];return {rows:[{admission:{actor:'owner-b',planCommitment:'b'.repeat(64)}}],rowCount:1};
  }
  if(sql==='SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission') {
   assert.deepEqual(values.slice(0,4),['ws-b','unit-session-proof','restore-v2',groupBody]);
   assert.equal(JSON.parse(String(values[4])).restoreGroupRoot,groupRoot);
   return {rows:[{admission:{actor:'owner-b',planCommitment:'c'.repeat(64)}}],rowCount:1};
  }
  if(sql==='SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)') {
   assert.deepEqual(values.slice(0,4),['ws-b','unit-session-proof',groupBody,'c'.repeat(64)]);
   for(const b of JSON.parse(String(values[4])))assert.ok(inserted.has(b.instanceId));
   return {rows:[],rowCount:0};
  }
  if(sql.includes('record_goal_restore_group_prepare'))return {rows:[{admission:{actor:'owner-b',planCommitment:'b'.repeat(64)}}],rowCount:1};
  if(sql.includes('FROM worlds'))return {rows:[{world_version:'1.2.0',status:'active',settings:{}}],rowCount:1};
  if(sql.includes('FROM player_world_memberships'))return {rows:[{role:'owner'}],rowCount:1};
  if(sql.includes('INSERT INTO character_instances')){if(values[5]!==null)assert.ok(inserted.has(String(values[5])),'character immediate parent must already exist');inserted.add(String(values[6]));}
  if(sql.includes('INSERT INTO goal_instances')) {
   const parentIndex=sql===INSERT_RESTORED_GOAL_V2_SQL?19:17,idIndex=sql===INSERT_RESTORED_GOAL_V2_SQL?6:4;
   if(values[parentIndex]!==null)assert.ok(inserted.has(String(values[parentIndex])),'Goal immediate parent must already exist');
   inserted.add(String(values[idIndex]));
  }
  return {rows:[],rowCount:0};
 }};
 await createPostgresRealmRuntimeSaveRestorer({connect:async()=>client} as never,{goalsSchemaVersion:2,resolveGoalSource,validateWorldBinding:async()=>{}}).restore({workspaceId:'ws-b',principalId:'owner-b',targetWorldId:'world-b',idempotencyKey:'parallel-b',sessionProof:'unit-session-proof',archive:{manifest,record:saved,goals:archiveGoals,topology,...(domain?{domain}:{}),...(outbox?{outbox}:{})}});
 } catch(error) {
  if(error instanceof Error && 'code' in error && (error.code==='RUNTIME_SAVE_INVALID'||error.code==='INVALID_SAVE'||error.code==='GOAL_HISTORICAL_BINDING_UNRESOLVED')) assert.equal(calls.filter(call=>call.sql.includes('INSERT INTO')).length,0,'invalid predecessor/typed identity fails before target writes');
  throw error;
 }
 assert.equal(calls.filter(c=>c.sql === 'SELECT restore_delivery_kind FROM public.outbox WHERE false').length,1);
 return calls;
}
const contentGoal=(id:string,attempt:number,parent:string|null,state='failed')=>({id,goalKey:'retry-goal',state,revision:1,progress:{},outcome:null,policyVersion:'content:v1',attempt,supersedesInstanceId:parent});

test('B content Goal attempts retain distinct identities and parent-first retry history',async()=>{
 const calls=await restore([], {...emptyGoals,instances:[contentGoal('z-child',2,'a-parent','active'),contentGoal('a-parent',1,null)]});
 const rows=goalWrites(calls);
 assert.deepEqual(rows.map(row=>row.attempt),[1,2]);assert.equal(rows[1]!.supersedes_instance_id,rows[0]!.id);
});
test('B shuffled character chain inserts actual parents before children',async()=>{await restore([participant('aa-child','zz-parent'),participant('zz-parent')]);});
test('B repeated identical character references dedupe instance writes',async()=>{
 const a=participant('shared');const calls=await restore([a,{...a,sourceParticipantId:'another-participant'}]);
 assert.equal(calls.filter(call=>call.sql.includes('INSERT INTO character_instances')).length,1);
});
test('B conflicting repeated character representation refuses',async()=>{
 const a=participant('shared');await assert.rejects(restore([a,{...a,sourceParticipantId:'another-participant',character:{...a.character!,instance:{...a.character!.instance,state:{tampered:true}}}}]),/duplicated|conflict|unique/i);
});
test('B character cycles fail before first target write',async()=>{await assert.rejects(restore([participant('a','b'),participant('b','a')]),/cycl/i);});
test('B missing and foreign continuity predecessors refuse',async()=>{
 await assert.rejects(restore([participant('a','missing')]),/predecessor|continuity/i);
 await assert.rejects(restore([participant('a','b'),participant('b',null,'foreign')]),/predecessor|continuity/i);
});
test('B typed Goal references do not rewrite nested arbitrary JSON',async()=>{
 const calls=await restore([], {...emptyGoals,instances:[contentGoal('source-goal',1,null,'active')]},{kind:'goal.transition.committed',body:{goalInstanceId:'source-goal',evidenceEventIds:['event-b'],metadata:{goalInstanceId:'source-goal',evidenceEventIds:['event-b']}}});
 const event=calls.find(call=>call.sql.includes('INSERT INTO events'))!;const body=JSON.parse(String(event.values[13])).__realmRuntimePayload;
 assert.notEqual(body.goalInstanceId,'source-goal');assert.notEqual(body.evidenceEventIds[0],'event-b');assert.deepEqual(body.metadata,{goalInstanceId:'source-goal',evidenceEventIds:['event-b']});
});
test('B V1 attempt default survives with an authored source; unbound content stays refused',async()=>{
 const legacy={...emptyGoals,instances:[{id:'legacy',goalKey:'legacy',state:'active',revision:0,progress:{},outcome:null,policyVersion:'v1'}]};
 await assert.rejects(restore([],legacy,undefined,undefined,{},false,false),{code:'GOAL_HISTORICAL_BINDING_UNRESOLVED'});
 const definition=createRecordGoalDefinition({scope:{workspaceId:'ws-b',...record.scope},goalId:'legacy-default',activationHead:{recordVersion:0,ordinal:0},
  draft:{title:'Legacy default',description:'Keep omitted attempt default',successConditions:['done'],failureConditions:[],changePolicy:'fixed',visible:true}});
 const calls=await restore([],{...emptyGoals,definitions:[JSON.parse(JSON.stringify(definition))],instances:[{
  ...legacy.instances[0],id:definition.goalInstanceId,goalKey:definition.goalKey,policyVersion:definition.policyVersion,
  definitionSource:'record',definitionId:definition.definitionId,resolutionKind:'natural',evidenceStartVersion:0,evidenceStartOrdinal:0}]});
 assert.equal(calls.find(call=>call.sql.includes('INSERT INTO goal_instances'))!.values[16],1);
});

test('B identical lexical IDs in Goal instance and definition namespaces stay independent',async()=>{
 const definition=createRecordGoalDefinition({scope:{workspaceId:'ws-b',worldId:'world-b',worldlineId:'line-b',recordId:'record-b'},goalId:'native-b',activationHead:{recordVersion:0,ordinal:0},draft:{title:'Native',description:'Preserve native',successConditions:['done'],failureConditions:[],changePolicy:'fixed',visible:true}});
 const native={id:definition.goalInstanceId,goalKey:definition.goalKey,state:'active',revision:1,progress:{},outcome:null,policyVersion:definition.policyVersion,definitionSource:'record',definitionId:definition.definitionId,resolutionKind:'natural',evidenceStartVersion:0,evidenceStartOrdinal:0,attempt:1,supersedesInstanceId:null};
 const calls=await restore([], {...emptyGoals,definitions:[JSON.parse(JSON.stringify(definition))],instances:[contentGoal(definition.definitionId,1,null,'active'),native]}, {kind:'goal.transition.committed',body:{goalInstanceId:definition.definitionId,definitionId:definition.definitionId,policyVersion:definition.policyVersion}});
 const goalRows=goalWrites(calls);
 const payload=JSON.parse(String(calls.find(call=>call.sql.includes('INSERT INTO events'))!.values[13])).__realmRuntimePayload;
 assert.equal(payload.goalInstanceId,goalRows.find(g=>g.definition_source==='content')!.id);
 assert.equal(payload.definitionId,goalRows.find(g=>g.definition_source==='record')!.definition_id);assert.notEqual(payload.goalInstanceId,payload.definitionId);
});
test('B retry gaps, missing parent and foreign Goal references refuse',async()=>{
 for(const rows of [[contentGoal('retry',2,null)], [contentGoal('retry',2,'absent')], [contentGoal('retry',3,'parent'),contentGoal('parent',1,null)], [contentGoal('retry',2,'parent'),contentGoal('parent',1,null,'active')]]) await assert.rejects(restore([], {...emptyGoals,instances:rows}),{name:'RealmRuntimeGoalsV2Error',code:'INVALID_SAVE'});
});

function outboxFixture(topic='record.events.committed',recordId='record-b',eventIds=['event-b']):RealmRuntimeSaveOutboxV1 {
 return {format:'realm-runtime-outbox',schemaVersion:1,messages:[{sourceMessageId:'ob-b',dedupeKey:'ob-dedupe',topic,envelope:{recordId,eventIds,note:'record-b',metadata:{recordId:'record-b',eventIds:['event-b']}},state:'pending',deliveryAttempts:0,nextAttemptAt:'2026-10-18T00:00:00.000Z',sourceEventId:'event-b',leaseOwner:null,leaseExpiresAt:null,lastErrorCode:null,lastErrorMessage:null,lastErrorAt:null}]};
}
test('B engine Outbox envelope maps its declared Record and Event anchors only',async()=>{
 const calls=await restore([],emptyGoals,{kind:'utterance.committed',body:{}},outboxFixture());
 const outbox=calls.find(call=>call.sql.includes('INSERT INTO outbox'))!.values;
 const payload=JSON.parse(String(outbox[8]));assert.equal(payload.recordId,outbox[3]);assert.equal(payload.eventIds[0],outbox[4]);assert.equal(payload.note,'record-b');assert.deepEqual(payload.metadata,{recordId:'record-b',eventIds:['event-b']});
});
test('B custom Outbox envelopes remain arbitrary JSON',async()=>{
 const calls=await restore([],emptyGoals,{kind:'utterance.committed',body:{}},outboxFixture('custom.topic'));
 assert.deepEqual(JSON.parse(String(calls.find(call=>call.sql.includes('INSERT INTO outbox'))!.values[8])),outboxFixture('custom.topic').messages[0]!.envelope);
});
test('B engine Outbox cannot carry foreign Record or unknown Event anchors',async()=>{
 for(const archive of [outboxFixture('record.events.committed','foreign'),outboxFixture('record.events.committed','record-b',['missing'])]) await assert.rejects(restore([],emptyGoals,{kind:'utterance.committed',body:{}},archive),/outbox|outside|unknown/i);
});

test('B missing typed Goal event anchors refuse before writes',async()=>{await assert.rejects(restore([],emptyGoals,{kind:'goal.transition.committed',body:{goalInstanceId:'missing-goal'}}),/unknown identity/i);});
test('B cyclic Record links refuse before any target write',async()=>{
 await assert.rejects(restore([participant('a','b'),participant('b','c'),participant('c')],emptyGoals,undefined,undefined,{'sibling-0':'sibling-1','sibling-1':'sibling-0'}),/cyclic/i);
});

test('B empty sibling topology allocates separate legacy fallback anchors',async()=>{await restore([participant('parent'),participant('child','parent')],emptyGoals,undefined,undefined,{},true);});

// Independent Iris witness: the inherited implementation accepts this immediate
// Record FK self-reference. It is not an external parent-order dependency.
test('Iris B Record self-link remains accepted and maps to its own target identity',async()=>{
 const calls=await restore([participant('first'),participant('second')],emptyGoals,undefined,undefined,{'sibling-0':'sibling-0'});
 const records=calls.filter(call=>call.sql.includes('INSERT INTO records'));
 assert.equal(records.length,2);
 assert.equal(records[0]!.values[11],null);
 assert.equal(records[1]!.values[11],records[1]!.values[4],'self linked_record_id must remain the target Record ID');
 assert.notEqual(records[1]!.values[11],'sibling-0','the source ID must be remapped');
});
test('Iris B Record self-link exception does not exempt Character or Goal self-cycles',async()=>{
 await assert.rejects(restore([participant('self','self')]),/cycl|predecessor/i);
 await assert.rejects(restore([],{...emptyGoals,instances:[contentGoal('self-goal',1,'self-goal')]}),{name:'RealmRuntimeGoalsV2Error',code:'INVALID_SAVE'});
});
