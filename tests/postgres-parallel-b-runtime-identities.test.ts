import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installSignedRealmWorldFixture } from './helpers/realmworld-package-fixture.ts';
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from './helpers/session-proof.ts';
import { createInstalledRealmWorldInstantiationResolver } from '../modules/world-transfer/realmworld-runtime-content.ts';
import { mountRealmWorld } from '../modules/world-transfer/realmworld-loader.ts';
import { serializeRealmWorldManifestSigningPayload, type RealmWorldManifestV1 } from '../modules/world-transfer/realmworld-manifest.ts';
import { createPostgresLibraryService } from '../modules/application/library-service.ts';
import { createGoalContentBindingSource, bindGoalContentWitness } from '../modules/application/goal-content-binding-source.ts';
import type { GoalInstanceV2, RealmRuntimeSaveGoalsV2 } from '../modules/world-transfer/realm-runtime-goals-v2.ts';
import { POSTGRES_DEMO_IDS } from '../database/postgres/public.ts';
import { createPostgresRealmRuntimeSaveRestorer } from '../database/postgres/realm-runtime-save-repository.ts';
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData, type RealmRuntimeSaveRecordV1, type RealmRuntimeSaveGoalsV1, type RealmRuntimeSaveTopologyV1 } from '../modules/world-transfer/realm-runtime-save.ts';
import { withWorkspaceTransaction } from '../database/postgres/workspace-transaction.ts';

// Queued for the externally coordinated disposable PG runner. Never run by the pure lane.
test('parallel B actual immediate-FK shuffled cross-Record character chain and content attempts', {
 skip: !process.env.REALM_SCRATCH_POSTGRES_CONTAINER || !process.env.DATABASE_URL || !process.env.REALM_RUNTIME_DATABASE_URL, timeout:120_000,
}, async t=>{
 installTestSessionSecret();
 const pool=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL,max:1});
 const admin=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
 const resources:{directory?:string}={};
 t.after(async()=>{
  const closed=await Promise.allSettled([pool.end(),admin.end(),resources.directory?rm(resources.directory,{recursive:true,force:true}):Promise.resolve()]);
  const errors=closed.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
  if(errors.length)throw new AggregateError(errors.map(r=>r.reason),'B fixture cleanup failed');
 });
 const directory=await mkdtemp(join(tmpdir(),'b-pg-signed-'));resources.directory=directory;
 // Queue/default selectors are workspace-wide: isolate the signed genesis, not just its World ID.
 const workspaceId=`ws_b_${randomUUID().replaceAll('-','')}`;
 await admin.query("INSERT INTO workspaces(id,name) VALUES($1,'B isolated workspace')",[workspaceId]);
 await admin.query("INSERT INTO accounts(workspace_id,principal_id,display_name) VALUES($1,$2,'B owner')",[workspaceId,POSTGRES_DEMO_IDS.principal]);
 const worldId=`world_b_${randomUUID().replaceAll('-','')}`;const version='1.2.0';
 await seedCapabilitySessionKey(admin,workspaceId);
 const pair=generateKeyPairSync('ed25519');
 await installSignedRealmWorldFixture({installRoot:directory,worldId,version,recordTitle:'B signed fixture',keyId:'b-pg-fixture',
  keyPair:{privateKey:pair.privateKey,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString()},
  goals:[{goalKey:'content-retry',policyVersion:'content:v1',mode:'deterministic',visible:true,retryable:true,
   rubric:{kind:'event_count',eventKind:'narration.committed',progressKey:'count',threshold:1},outcome:{}}]});
 const verifier={installRoot:directory,verifySignature:({manifest}:{manifest:RealmWorldManifestV1})=>
  verify(null,Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)),pair.publicKey,Buffer.from(manifest.signature.value,'base64url'))};
 const resolveGoalSource=createGoalContentBindingSource({mount:identity=>mountRealmWorld({...verifier,...identity})});
 const plan=(await createInstalledRealmWorldInstantiationResolver({...verifier,locale:'en'})({kind:'world',worldId,worldVersion:version}))!;
 const sessionProof=sessionProofFor(POSTGRES_DEMO_IDS.principal);
 await createPostgresLibraryService(pool,undefined,{resolveGoalSource}).instantiateRealmWorld(
  {workspaceId:workspaceId,principalId:POSTGRES_DEMO_IDS.principal,sessionProof},plan,`b-genesis-${randomUUID()}`);
 // Pass the pool so the repository owns real BEGIN/COMMIT, not a savepoint without an outer transaction.
 const client=pool;
 {
  const record:RealmRuntimeSaveRecordV1={format:'realm-runtime-record',schemaVersion:1,scope:{worldId,worldlineId:'source-line-b',recordId:'source-record-b'},head:{recordVersion:1,nextRecordOrdinal:2},events:[{eventId:'event-b',recordVersion:1,ordinal:1,kind:'utterance.committed',payload:{content:'B fixture',speakerName:'',actorParticipantId:null,sceneId:'scene-b',visibilityPolicyId:'policy-b',worldTick:1,worldOrdinal:0,calendarId:'calendar-b',displayTime:'',eventPayload:{}}}]};
  const goal=(id:string,attempt:number,parent:string|null,state:string)=>({id,goalKey:'content-retry',state,revision:1,progress:{},outcome:null,policyVersion:'content:v1',attempt,supersedesInstanceId:parent});
  const legacyGoals:RealmRuntimeSaveGoalsV1={format:'realm-runtime-goals',schemaVersion:1,instances:[goal('child',2,'parent','active'),goal('parent',1,null,'failed')],assessments:[]};
  // Newly authored fixture witnesses from the actual signed install, not an upgrade of historical V1 authority.
  const owner={scopeKind:'record' as const,worldId,worldlineId:record.scope.worldlineId,recordId:record.scope.recordId};
  const witness=await resolveGoalSource({worldId,worldVersion:version,goalKey:'content-retry',policyVersion:'content:v1'});
  const bound=(id:string,attempt:number,parent:string|null,state:GoalInstanceV2['state']):GoalInstanceV2=>({
   ref:{owner,instanceId:id},goalKey:'content-retry',definition:{kind:'content',binding:bindGoalContentWitness(witness,workspaceId,owner,id)},
   state,revision:1,progress:{},outcome:null,policyVersion:'content:v1',attempt,predecessor:parent?{kind:'retry',ref:{owner,instanceId:parent}}:null,
   resolutionKind:'natural',evidenceStart:null});
  const goals:RealmRuntimeSaveGoalsV2={format:'realm-runtime-goals',schemaVersion:2,workspaceId:workspaceId,
   roots:[{owner,instances:[bound('child',2,'parent','active'),bound('parent',1,null,'failed')]}],definitions:[],assessments:[]};
  const emptyGoals:RealmRuntimeSaveGoalsV1={...legacyGoals,instances:[]};
  const topology=(id:string,parent:string|null):RealmRuntimeSaveTopologyV1=>({format:'realm-runtime-topology',schemaVersion:1,participants:[{sourceParticipantId:`p-${id}`,participantKind:'character',sourcePrincipalId:null,controllerMode:'ai',isActive:true,speakingOrder:0,sharedControlEnabled:false,character:{sourceCharacterInstanceId:id,sourceContinuityId:'continuity-b',sourcePredecessorInstanceId:parent,sourceDefinitionId:'definition-b',definition:{displayName:'B',sourceFormat:'native',profile:{}},continuity:{continuityKey:'continuity-b',status:'active',bornTick:0,bornOrdinal:0,endedTick:null,endedOrdinal:null},instance:{controllerMode:'ai',status:'present',instantiatedTick:0,instantiatedOrdinal:0,inheritanceCutoffTick:0,inheritanceCutoffOrdinal:0,retiredTick:null,retiredOrdinal:null,state:{}}}}],scenes:[],visibilityPolicies:[]});
  const primaryTopology=topology('aa-child','zz-parent');
  const domain={format:'realm-runtime-domain' as const,schemaVersion:1 as const,source:{worldId,worldlineId:'source-line-b',storyId:'story-b',recordId:'source-record-b'},stories:[{id:'story-b',title:'B',status:'active' as const,premise:''}],storyDefinitions:[],records:[{recordId:'sibling-b',storyId:'story-b',title:'B parent',status:'active' as const,worldVersion:version,startTick:0,startOrdinal:0,timelineKind:'primary' as const,linkedRecordId:null,lastEventId:null,lastWorldTick:null,lastWorldOrdinal:null,bundle:{record:{...record,scope:{...record.scope,recordId:'sibling-b'},head:{recordVersion:0,nextRecordOrdinal:0},events:[]},goals:emptyGoals,topology:topology('zz-parent',null)}}],projects:[],milestones:[],projectStoryLinks:[],budgetAllocations:[],financeAccounts:[],ledgerEntries:[],financeCommandGroups:[],obligations:[],obligationSettlements:[],storyNodes:[],storyUnlockLedger:[],committedFactCommands:[],performanceAssessments:[],memberRelationshipRevisions:[],characterAssets:[]};
  const outbox={format:'realm-runtime-outbox' as const,schemaVersion:1 as const,messages:[{sourceMessageId:'ob-b',dedupeKey:'ob-b',topic:'record.events.committed',envelope:{recordId:'source-record-b',eventIds:['event-b'],note:'event-b'},state:'pending' as const,deliveryAttempts:0,nextAttemptAt:'2026-10-18T00:00:00.000Z',sourceEventId:'event-b',leaseOwner:null,leaseExpiresAt:null,lastErrorCode:null,lastErrorMessage:null,lastErrorAt:null}]};
  const manifest=realmRuntimeSaveManifestFromData({engineApi:'1.x',mode:'world-bound',world:{worldId,worldVersion:version},scope:{workspaceId:workspaceId,worldlineId:'source-line-b',recordId:'source-record-b'},record,goals,topology:primaryTopology,domain,outbox});
  const archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({manifest,record,goals,topology:primaryTopology,domain,outbox}),{goalsSchemaVersion:2});
  const restorer=createPostgresRealmRuntimeSaveRestorer(client,{goalsSchemaVersion:2,resolveGoalSource,
   validateWorldBinding:async binding=>{await mountRealmWorld({...verifier,...binding});}});
  const input={workspaceId:workspaceId,principalId:POSTGRES_DEMO_IDS.principal,sessionProof,targetWorldId:worldId,idempotencyKey:`parallel-b-${randomUUID()}`,archive};
  const legacyDomain={...domain,records:domain.records.map(r=>({...r,bundle:{...r.bundle,goals:{...legacyGoals,instances:[]}}}))};
  const legacyData={...archive,goals:legacyGoals,domain:legacyDomain};
  const legacyArchive={...legacyData,manifest:realmRuntimeSaveManifestFromData({...legacyData,engineApi:'1.x',mode:'world-bound',
   world:{worldId,worldVersion:version},scope:manifest.scope})};
  const recordsBefore=await withWorkspaceTransaction(client,workspaceId,async scoped=>(await scoped.query(
   'SELECT id FROM records WHERE workspace_id=$1 AND world_id=$2 ORDER BY id',[workspaceId,worldId])).rows);
  await assert.rejects(restorer.restore({...input,archive:legacyArchive}),{code:'GOAL_HISTORICAL_BINDING_UNRESOLVED'});
  assert.deepEqual(await withWorkspaceTransaction(client,workspaceId,async scoped=>(await scoped.query(
   'SELECT id FROM records WHERE workspace_id=$1 AND world_id=$2 ORDER BY id',[workspaceId,worldId])).rows),recordsBefore);
  const restored=await restorer.restore(input);
  assert.equal(restored.importedGoalInstanceCount,2);assert.equal(restored.importedDomainRecordCount,1);
  await withWorkspaceTransaction(client,workspaceId,async scoped=>{
   const characters=await scoped.query('SELECT record_id,id,predecessor_instance_id FROM character_instances WHERE workspace_id=$1 AND worldline_id=$2',[workspaceId,restored.worldlineId]);
   assert.equal(characters.rows.length,2);const child=characters.rows.find(row=>row.record_id===restored.recordId)!;
   assert.ok(characters.rows.some(row=>row.id===child.predecessor_instance_id));
   const attempts=await scoped.query('SELECT id,attempt,supersedes_instance_id FROM goal_instances WHERE workspace_id=$1 AND record_id=$2 ORDER BY attempt',[workspaceId,restored.recordId]);
   assert.deepEqual(attempts.rows.map(row=>row.attempt),[1,2]);assert.equal(attempts.rows[1].supersedes_instance_id,attempts.rows[0].id);
   const delivery=(await scoped.query('SELECT record_id,event_id,payload FROM outbox WHERE workspace_id=$1 AND record_id=$2',[workspaceId,restored.recordId])).rows[0];
   assert.equal(delivery.payload.recordId,restored.recordId);assert.deepEqual(delivery.payload.eventIds,[delivery.event_id]);assert.equal(delivery.payload.note,'event-b');
  });
  assert.equal((await restorer.restore(input)).replayed,true);
 }
 // Immutable history belongs to the disposable cluster; no parent DELETE or trigger bypass.
});
