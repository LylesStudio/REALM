/** Explicit opt-in acceptance. Real gateway responses are never fabricated, rewritten or logged. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash,generateKeyPairSync} from 'node:crypto';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {POSTGRES_DEMO_IDS as ids} from '../database/postgres/public.ts';
import {withWorkspaceTransaction} from '../database/postgres/workspace-transaction.ts';
import {createPostgresGoalAssessmentJobQueue} from '../database/postgres/goal-assessment-job-queue.ts';
import {createRecordGoalDefinitionResolver} from '../modules/application/record-goal-definition.ts';
import {createProjectionDefinitionResolver} from '../modules/application/record-goal-content.ts';
import {createModelGoalJudge} from '../modules/goals/model-judge.ts';
import {createModelGoalEvolutionPlanner} from '../modules/goals/model-evolution.ts';
import {runGoalAssessmentOnce} from '../modules/goals/assessment-worker.ts';
import {createLocalModelSettingsStore} from '../modules/inference/local-settings.ts';
import {createModelGateway,type ModelGateway,type ModelProviderId} from '../modules/inference/public.ts';
import {sessionProofFor} from './helpers/session-proof.ts';
import {installSignedRealmWorldFixture} from './helpers/realmworld-package-fixture.ts';

const exec=promisify(execFile);
type Scope={workspaceId:string;worldId:string;worldlineId:string;recordId:string};
const draft={title:'Deliver the sealed letter to Mira',description:'The handover site is Harbor Alpha. The already specified correspondence direction is to deliver the intact sealed letter to Mira, then return the official receipt to the sender once the receipt exists. The current milestone is the delivery; the receipt return is the explicit next direction, not assumed travel, spending or player agreement.',
  successConditions:['Mira has physically received the intact sealed letter.'],failureConditions:['The sealed letter is destroyed before Mira receives it.'],settlementConditions:[],visible:true};

async function settingsHashes(){
  const root=process.env.REALM_DATA_HOME?.trim()||resolve(process.cwd(),'.local');
  return Promise.all([resolve('.env.local'),resolve(root,'settings/model-providers.json'),resolve(root,'settings/model-provider.json')].map(async path=>{
    try{return {path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')};}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {path,sha256:null};throw error;}
  }));
}

async function assertDisposableTarget(){
  assert.equal(process.env.REALM_ENABLE_RECORD_GOAL_REAL_PROVIDER,'1','explicit real-provider opt-in required');
  const name=process.env.REALM_SCRATCH_POSTGRES_CONTAINER??'';
  assert.match(name,/^realm-v37-scratch-runtime-[a-z0-9]+$/,'must be launched by the disposable PostgreSQL runner');
  const adminUrl=new URL(process.env.DATABASE_URL!);const runtimeUrl=new URL(process.env.REALM_RUNTIME_DATABASE_URL!);
  assert.equal(adminUrl.hostname,'127.0.0.1');assert.equal(adminUrl.pathname,'/realm_dev');
  assert.equal(runtimeUrl.hostname,adminUrl.hostname);assert.equal(runtimeUrl.port,adminUrl.port);assert.equal(runtimeUrl.pathname,adminUrl.pathname);
  const inspection=await exec('docker',['inspect','--format','{{json .Config.Cmd}}',name]);
  const command=JSON.parse(inspection.stdout) as string[];
  assert.ok(command.includes(`port=${adminUrl.port}`),'the database port must be owned by this exact disposable container');
  return name;
}

async function appendControlledEvidence(admin:pg.Pool,scope:Scope,content:string){
  return withWorkspaceTransaction(admin,scope.workspaceId,async client=>{
    await client.query('SELECT id FROM records WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[scope.workspaceId,scope.recordId]);
    const line=(await client.query('SELECT head_tick,head_ordinal FROM worldlines WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[scope.workspaceId,scope.worldlineId])).rows[0];
    const head=(await client.query('SELECT record_version,next_record_ordinal FROM record_heads WHERE workspace_id=$1 AND record_id=$2 FOR UPDATE',[scope.workspaceId,scope.recordId])).rows[0];
    const version=Number(head.record_version)+1,ordinal=Number(head.next_record_ordinal),worldOrdinal=Number(line.head_ordinal)+1;
    const id=`real-evidence-${randomUUID()}`;
    const inserted=await client.query(`INSERT INTO events SELECT (jsonb_populate_record(NULL::events,to_jsonb(source)||$1::jsonb)).*
      FROM events source WHERE workspace_id=$2 AND record_id=$3 ORDER BY record_ordinal DESC LIMIT 1`,
      [JSON.stringify({id,event_kind:'narration.committed',record_version:version,record_ordinal:ordinal,world_tick:Number(line.head_tick),world_ordinal:worldOrdinal,
        actor_participant_id:null,speaker_name:'Controlled acceptance fixture',content,
        payload:{__realmRuntimePayload:{schemaVersion:1,role:'narrator',content}}}),scope.workspaceId,scope.recordId]);
    assert.equal(inserted.rowCount,1,'controlled world facts require a real persisted narrator event');
    await client.query(`UPDATE record_heads SET record_version=$3,next_record_ordinal=$4,last_event_id=$5,last_world_tick=$6,last_world_ordinal=$7
      WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,scope.recordId,version,ordinal+1,id,Number(line.head_tick),worldOrdinal]);
    await client.query('UPDATE worldlines SET head_ordinal=$3 WHERE workspace_id=$1 AND id=$2',[scope.workspaceId,scope.worldlineId,worldOrdinal]);
    return id;
  });
}

async function fixture(admin:pg.Pool):Promise<Scope>{
  const scope={workspaceId:ids.workspace,worldId:`world_${randomUUID()}`,worldlineId:`worldline_${randomUUID()}`,recordId:`record_${randomUUID()}`};
  const storyId=`story_${randomUUID()}`;
  await withWorkspaceTransaction(admin,scope.workspaceId,async client=>{
    const clone=async(table:string,predicate:string,sourceId:string,patch:object)=>{
      const inserted=await client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`,[JSON.stringify(patch),scope.workspaceId,sourceId]);
      assert.equal(inserted.rowCount,1,`isolated fixture ${table}`);
    };
    await clone('worlds','id',ids.world,{id:scope.worldId,name:'Real provider Goal acceptance fixture'});
    const bound={workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId,record_id:scope.recordId};
    await clone('worldlines','id',ids.worldline,{id:scope.worldlineId,world_id:scope.worldId,head_tick:0,head_ordinal:0});
    await clone('stories','id',ids.story,{...bound,id:storyId,start_tick:0,start_ordinal:0});
    await clone('records','id',ids.record,{...bound,id:scope.recordId,story_id:storyId,status:'active',start_tick:0,start_ordinal:0});
    await clone('scenes','record_id',ids.record,{...bound,id:`scene_${randomUUID()}`,start_tick:0,start_ordinal:0});
    await clone('visibility_policies',"policy_kind='public' AND record_id",ids.record,{...bound,id:`policy_${randomUUID()}`});
    await client.query(`INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')`,[scope.workspaceId,scope.worldId,ids.principal]);
    await client.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,principal_id,controller_mode)
      VALUES($1,$2,$3,$4,$5,'narrator',$6,'human')`,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,`participant_${randomUUID()}`,ids.principal]);
    await clone('record_heads','record_id',ids.record,{...bound,record_version:0,next_record_ordinal:1,last_event_id:null,last_world_tick:0,last_world_ordinal:0});
  });
  return scope;
}

test('real provider: native fixed/evolving and installed signed RealmWorld Goals survive real turns, restore and branch',{timeout:600_000},async t=>{
  const container=await assertDisposableTarget();
  const beforeSettings=await settingsHashes();
  const document=await createLocalModelSettingsStore().loadSnapshot();
  const profileId=(process.env.REALM_TEST_PROVIDER_PROFILE??document.activeProviderId) as ModelProviderId;
  const profile=document.providers[profileId];assert.ok(profile,'the explicit saved provider profile must exist');
  const selectedModel=process.env.REALM_TEST_PROVIDER_MODEL??profile.selectedModel;
  const gateway=createModelGateway({...profile,selectedModel});
  const discovery=await gateway.discoverModels();assert.ok(discovery.some(model=>model.id===selectedModel),'selected acceptance model must be advertised by the provider');
  let phase='goal-assessment';
  const observations:{phase:string;model:string;usage:unknown;responseHash:string;responseShape:unknown}[]=[];
  const observed:ModelGateway={providerId:gateway.providerId,discoverModels:()=>gateway.discoverModels(),async chat(request){
    for(const message of request.messages.filter(message=>message.role==='system'))assert.equal(message.content.includes(draft.successConditions[0]),false,'criteria are untrusted data, never system instructions');
    let result;
    try{result=await gateway.chat(request);}catch(error){t.diagnostic(JSON.stringify({stage:'gateway-failure',code:(error as {code?:string}).code??'UNKNOWN'}));throw error;}
    t.diagnostic(JSON.stringify({stage:'gateway-response',requestedModel:selectedModel,returnedModel:result.model}));
    // OpenRouter can omit its billing/routing suffix in the response. Preserve
    // both exact identifiers; this is not permission to choose another model.
    assert.ok(result.model===selectedModel||(profileId==='openrouter'&&selectedModel.endsWith(':free')&&result.model===selectedModel.slice(0,-5)),
      'only an exact model identity or the explicit OpenRouter free-routing alias is accepted');
    let responseShape:unknown={json:false};
    try{const body=JSON.parse(result.content) as Record<string,unknown>;
      const type=(value:unknown)=>value===null?'null':Array.isArray(value)?'array':typeof value;
      responseShape={json:true,knownKeys:Object.keys(body).filter(key=>['decision','evidenceEventIds','progress','outcome','action','draft','reason','basisEventIds'].includes(key)),
        extraKeyCount:Object.keys(body).filter(key=>!['decision','evidenceEventIds','progress','outcome','action','draft','reason','basisEventIds'].includes(key)).length,
        decision:['continue','complete','reject','fail','settle'].includes(String(body.decision))?body.decision:null,
        evolutionDecision:['keep','evolve'].includes(String(body.decision))?body.decision:null,
        draftType:type(body.draft),reasonType:type(body.reason),basisCount:Array.isArray(body.basisEventIds)?body.basisEventIds.length:null,
        evidenceCount:Array.isArray(body.evidenceEventIds)?body.evidenceEventIds.length:null,progressType:type(body.progress),outcomeType:type(body.outcome)};
    }catch{/* Only schema metadata is recorded; raw model text is never logged. */}
    observations.push({phase,model:result.model,usage:result.usage,responseHash:createHash('sha256').update(result.content).digest('hex'),responseShape});
    t.diagnostic(JSON.stringify({stage:'response-shape',responseShape}));return result;
  }};
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  const {endSharedRuntimePools}=await import('../app/api/world-scope.ts');
  try {
    const commands=await import('../app/api/record/goals/commands/route.ts');
    const cookie=`realm_session=${sessionProofFor(ids.principal)}`;
    const scope=await fixture(admin);
    const snapshot=async(recordId:string)=>{
      const response=await commands.GET(new Request(`http://localhost/api/record/goals/commands?recordId=${recordId}`,{headers:{cookie}}));
      assert.equal(response.status,200,'owner management read must succeed');return (await response.json()).data;
    };
    const created=[];
    for(const changePolicy of ['fixed','evolving'] as const){
      const current=await snapshot(scope.recordId);
      const response=await commands.POST(new Request('http://localhost/api/record/goals/commands',{method:'POST',headers:{cookie,origin:'http://localhost','content-type':'application/json','idempotency-key':`real-create-${changePolicy}-${randomUUID()}`},
        body:JSON.stringify({recordId:scope.recordId,operation:'create',expectedHead:current.head,draft:{...draft,changePolicy}})}));
      assert.equal(response.status,201,'native creation must use the runtime-role proof-bound HTTP path');created.push((await response.json()).data);
    }
    const fixedId=created[0].goalInstanceId,evolvingId=created[1].goalInstanceId;
    const fixedDefinition=(await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 AND definition->>\'goalInstanceId\'=$3',[scope.workspaceId,scope.recordId,fixedId])).rows;
    assert.equal(fixedDefinition.length,1);
    const queue=createPostgresGoalAssessmentJobQueue({pool:runtime,workspaceId:scope.workspaceId,leaseOwner:`real-goals-${randomUUID()}`,leaseDurationMs:250000,
      retryJudgeFailures:true,retryDelayMs:1000});
    const realJudge=createModelGoalJudge({getGateway:async()=>observed,timeoutMs:60000,maxTokens:1600});
    const judge={async assess(input:Parameters<typeof realJudge.assess>[0]){
      try{return await realJudge.assess(input);}catch(error){t.diagnostic(JSON.stringify({stage:'judge-failure',code:(error as {code?:string}).code??'UNKNOWN'}));throw error;}
    }};
    const evolutionPlanner=createModelGoalEvolutionPlanner({getGateway:async()=>observed,timeoutMs:60000,maxTokens:2048});
    const reports:unknown[]=[];
    const resolveContentDefinition=async(binding:{worldId:string;worldVersion:string;goalKey:string})=>{
      const resolver=await createProjectionDefinitionResolver();assert.ok(resolver,'installed content must use the real signed resolver');return resolver(binding);
    };
    const recoveries:{jobId:string;code:string;attempt:number}[]=[];
    const settle=async(jobIds:string[])=>{
      for(let tick=0;tick<jobIds.length*3;tick++){
        const pending=(await admin.query(`SELECT id,state,available_at,attempt_count,last_error_code FROM goal_assessment_jobs
          WHERE workspace_id=$1 AND id=ANY($2::text[]) AND state<>'completed' ORDER BY available_at,id`,[scope.workspaceId,jobIds])).rows;
        if(!pending.length)return;
        const delay=new Date(pending[0].available_at).getTime()-Date.now();
        if(delay>0)await new Promise(resolve=>setTimeout(resolve,delay+10));
        const result=await runGoalAssessmentOnce({repository:queue,resolveDefinition:createRecordGoalDefinitionResolver(runtime,{resolveContentDefinition}),judge,evolutionPlanner,now:new Date().toISOString()});
        if(result.kind==='failed'&&['GOAL_JUDGE_FAILED','GOAL_EVOLUTION_FAILED'].includes(result.code)){
          const retried=(await admin.query(`SELECT id,state,attempt_count,last_error_code FROM goal_assessment_jobs
            WHERE workspace_id=$1 AND id=ANY($2::text[]) AND state='retryable' AND last_error_code=$3`,[scope.workspaceId,jobIds,result.code])).rows;
          assert.ok(retried.length>0,'a model failure must be durably requeued, not silently rerun');
          for(const row of retried){
            assert.equal((await admin.query('SELECT count(*)::int AS count FROM goal_assessments WHERE workspace_id=$1 AND assessment_job_id=$2',[scope.workspaceId,row.id])).rows[0].count,0,
              'a failed model attempt cannot publish a partial assessment');
            recoveries.push({jobId:row.id,code:row.last_error_code,attempt:row.attempt_count});
          }
        }else assert.deepEqual(result,{kind:'settled',status:'accepted'},'do not hide concurrency or scope failures by rerunning the model');
      }
      assert.equal((await admin.query(`SELECT count(*)::int AS count FROM goal_assessment_jobs WHERE workspace_id=$1 AND id=ANY($2::text[]) AND state<>'completed'`,[scope.workspaceId,jobIds])).rows[0].count,0,
        'real model jobs must finish within three actual persisted attempts each');
    };
    const assess=async(target:Scope,goalId:string,eventId:string)=>{
      const jobId=`real-goal-job-${randomUUID()}`;
      assert.equal(await queue.enqueue({...target,jobId,goalInstanceId:goalId,sourceEventId:eventId}),'inserted');
      await settle([jobId]);
      const ledger=(await admin.query(`SELECT source,status,source_event_id,evidence_event_ids,policy_version,result FROM goal_assessments
        WHERE workspace_id=$1 AND assessment_job_id=$2`,[target.workspaceId,jobId])).rows;
      assert.equal(ledger.length,1);assert.equal(ledger[0].source,'judge');assert.equal(ledger[0].status,'accepted');
      assert.equal(ledger[0].source_event_id,eventId,'the assessment remains bound to the actual committed trigger');
      for(const cited of ledger[0].evidence_event_ids){
        assert.equal((await admin.query(`SELECT count(*)::int AS count FROM events cited JOIN events trigger
          ON trigger.workspace_id=cited.workspace_id AND trigger.record_id=cited.record_id
          WHERE cited.workspace_id=$1 AND cited.world_id=$2 AND cited.worldline_id=$3 AND cited.record_id=$4
            AND cited.id=$5 AND trigger.id=$6 AND cited.record_ordinal<=trigger.record_ordinal`,
          [target.workspaceId,target.worldId,target.worldlineId,target.recordId,cited,eventId])).rows[0].count,1,
          'Judge evidence may select earlier supplied facts, but never foreign or future events');
      }
      reports.push({recordId:target.recordId,jobId,...ledger[0]});
    };
    const first=await appendControlledEvidence(admin,scope,'The sealed letter remains intact and undelivered in the office. Mira has not received it. Harbor Alpha remains the authorized handover site and remains open.');
    await assess(scope,fixedId,first);await assess(scope,evolvingId,first);
    assert.equal((await snapshot(scope.recordId)).goals.filter((goal:{state:string})=>goal.state==='active').length,2,'neither Goal is complete merely because delivery is planned');
    const changed=await appendControlledEvidence(admin,scope,'Mira has now physically received the intact sealed letter at Harbor Alpha. An official signed delivery receipt now exists at the handover counter, and the sender is awaiting its return under the already specified correspondence direction. The receipt has not been returned and no player possession, travel, spending or new agreement is established.');
    await assess(scope,fixedId,changed);await assess(scope,evolvingId,changed);
    const after=await snapshot(scope.recordId);
    const successors=after.goals.filter((goal:{definitionVersion:number;state:string;draft:{changePolicy:string}})=>goal.definitionVersion===2&&goal.state==='active'&&goal.draft.changePolicy==='evolving');
    assert.equal(successors.length,1,'the actual real-model evolution must materialize an evidence-backed successor');
    assert.deepEqual((await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 AND definition->>\'goalInstanceId\'=$3',[scope.workspaceId,scope.recordId,fixedId])).rows,fixedDefinition,'fixed definition is immutable even when its milestone completes');
    const successor=(await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 AND definition_version=2',[scope.workspaceId,scope.recordId])).rows[0].definition;
    assert.ok(successor.basisEventIds.includes(changed));assert.ok(successor.changeReason);assert.equal(successor.draft.changePolicy,'evolving');
    const sourceHead=(await admin.query('SELECT record_version FROM record_heads WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,scope.recordId])).rows;
    const sourceDefinitions=(await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 ORDER BY id',[scope.workspaceId,scope.recordId])).rows;
    const save=await import('../app/api/record/save/route.ts');const restore=await import('../app/api/record/restore/route.ts');
    const exported=await save.POST(new Request('http://localhost/api/record/save',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({recordId:scope.recordId})}));
    assert.equal(exported.status,200);const bytes=new Uint8Array(await exported.arrayBuffer());
    const restored=await restore.POST(new Request('http://localhost/api/record/restore',{method:'POST',headers:{cookie,'content-type':'application/vnd.realm.save+zip','x-realm-target-world':scope.worldId,'idempotency-key':`real-restore-${randomUUID()}`},body:bytes}));
    assert.equal(restored.status,201,'the real-model history must survive actual archive restoration');const restoreTarget=await restored.json();
    const branch=await import('../app/api/record/branch/route.ts');
    const branched=await branch.POST(new Request('http://localhost/api/record/branch',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({recordId:scope.recordId,idempotencyKey:`real-branch-${randomUUID()}`})}));
    assert.equal(branched.status,201);const branchTarget=await branched.json();
    for(const target of [restoreTarget,branchTarget]){
      const targetScope={...scope,recordId:target.recordId,worldlineId:target.worldlineId};
      const inherited=await snapshot(targetScope.recordId);
      const active=inherited.goals.find((goal:{definitionVersion:number;state:string;draft:{changePolicy:string}})=>goal.definitionVersion===2&&goal.state==='active'&&goal.draft.changePolicy==='evolving');
      assert.ok(active,'restored/branched scope retains the real evolved definition');
      const evidence=await appendControlledEvidence(admin,targetScope,'Mira has received the letter. The official delivery receipt remains at the Harbor Alpha counter and has not been returned to the sender. No player possession, travel, agreement or spending is established.');
      await assess(targetScope,active.goalInstanceId,evidence);
      assert.equal((await snapshot(targetScope.recordId)).goals.find((goal:{goalInstanceId:string})=>goal.goalInstanceId===active.goalInstanceId)?.state,'active');
    }
    const {createPostgresRuntimeRepository,createPostgresDeliveryProjectionRepository,createPostgresRecordRuntimeScopeRepository}=await import('../database/postgres/public.ts');
    const {createLocalRecordService,mapLocalFormalEvent}=await import('../modules/application/local-record-service.ts');
    const {createModelPoweredM2TurnOrchestrator}=await import('../modules/orchestration/model-powered.ts');
    const {createRecordGoalContextScopeRepository}=await import('../modules/application/record-goal-projection.ts');
    const {reconcileGoalAssessmentJobsForCommittedEvents}=await import('../database/postgres/goal-runtime-materialization.ts');
    const realTurn=async(recordId:string,content:string)=>{
    const committed:string[]=[];
    const service=createLocalRecordService({workspaceId:scope.workspaceId,
      repository:createPostgresRuntimeRepository({pool:runtime,workspaceId:scope.workspaceId,mapFormalEvent:mapLocalFormalEvent,
        onFormalEventsCommitted:async(client,events)=>{assert.equal(events.recordId,recordId);committed.push(...events.eventIds);await reconcileGoalAssessmentJobsForCommittedEvents(client,events);}}),
      projection:createPostgresDeliveryProjectionRepository(runtime),
      runtimeScopeProvider:createRecordGoalContextScopeRepository(runtime,createPostgresRecordRuntimeScopeRepository(runtime),{resolveContentDefinition}),
      orchestratorFactory:current=>createModelPoweredM2TurnOrchestrator({characters:[],brief:current.brief,getGateway:async()=>observed})});
    const envelope=await service.loadRecord(recordId);
    const command={recordId,content,
      idempotencyKey:`real-narrator-${randomUUID()}`,writeToken:envelope.writeToken};
    phase='formal-turn';const beforeTurn=observations.length;
    let submitted;
    try{submitted=await service.submitMessage(command);}catch(error){
      const shapes=(await admin.query(`SELECT jsonb_build_object('turnIdLength',length(id),'recordIdLength',length(record_id),
        'worldIdLength',length(world_id),'worldlineIdLength',length(worldline_id),
        'turnIdInvalidCharacters',regexp_replace(id,'[A-Za-z0-9._:-]','','g')) AS shape
        FROM turn_runs WHERE workspace_id=$1 AND record_id=$2 ORDER BY created_at DESC LIMIT 1`,[scope.workspaceId,recordId])).rows;
      t.diagnostic(JSON.stringify({stage:'formal-turn-failure',code:(error as {code?:string}).code,shapes}));throw error;
    }
    assert.equal(submitted.disposition,'committed','the real model-powered turn must formally commit');
    assert.ok(observations.length>beforeTurn,'the formal turn must actually call the real gateway');
    const afterTurn=observations.length;
    assert.equal((await service.submitMessage(command)).disposition,'duplicate');assert.equal(observations.length,afterTurn,'replay cannot regenerate a model turn');
    phase='goal-assessment';
    const narratorEvents=(await admin.query(`SELECT id FROM events WHERE workspace_id=$1 AND record_id=$2 AND id=ANY($3::text[]) AND event_kind='narration.committed'`,
      [scope.workspaceId,recordId,committed])).rows;
    assert.ok(narratorEvents.length>0,'read back the real Narrator output as a formal event');
    const automaticJobs=(await admin.query(`SELECT id FROM goal_assessment_jobs WHERE workspace_id=$1 AND record_id=$2 AND source_event_id=ANY($3::text[])`,
      [scope.workspaceId,recordId,committed])).rows;
    assert.ok(automaticJobs.length>0,'production commit hooks must schedule real assessment work');
    await settle(automaticJobs.map(job=>job.id));
    for(const job of automaticJobs){
      const result=(await admin.query('SELECT status,source,source_event_id,result FROM goal_assessments WHERE workspace_id=$1 AND assessment_job_id=$2',[scope.workspaceId,job.id])).rows;
      assert.equal(result.length,1);assert.equal(result[0].status,'accepted');assert.equal(result[0].source,'judge');
      assert.ok(committed.includes(result[0].source_event_id));reports.push({recordId,jobId:job.id,...result[0]});
    }
    return {recordId,eventIds:committed,jobIds:automaticJobs.map(job=>job.id)};
    };
    const nativeTurn=await realTurn(branchTarget.recordId,'I inspect the handover counter without taking or returning the receipt, agreeing to anything, travelling or spending resources.');
    const finalBranch=await snapshot(branchTarget.recordId);
    assert.ok(finalBranch.goals.some((goal:{state:string;draft:{changePolicy:string}})=>goal.state==='active'&&goal.draft.changePolicy==='evolving'),
      'inspection cannot be converted into an invented completed receipt return');
    assert.deepEqual((await admin.query('SELECT record_version FROM record_heads WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,scope.recordId])).rows,sourceHead);
    assert.deepEqual((await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 ORDER BY id',[scope.workspaceId,scope.recordId])).rows,sourceDefinitions);
    // Controlled signed content, not an existing player World. Installation,
    // signature checks, model responses, save/restore and forks are real.
    const packageHome=await mkdtemp(resolve(process.env.TMPDIR??tmpdir(),'realm-real-goals-package-'));
    const installRoot=resolve(packageHome,'installed'),trustStore=resolve(packageHome,'trust-store.json');
    const priorEnvironment=new Map(['REALM_REALMWORLD_INSTALL_ROOT','REALM_GOAL_WORKER_INSTALL_ROOT','REALM_REALMWORLD_TRUST_STORE'].map(key=>[key,process.env[key]]));
    t.after(async()=>{for(const [key,value] of priorEnvironment){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(packageHome,{recursive:true,force:true});});
    await mkdir(installRoot,{recursive:true});
    const pair=generateKeyPairSync('ed25519');const keyPair={privateKey:pair.privateKey,publicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString()};
    const packageWorld=`world_real_package_${randomUUID()}`,packageVersion='1.0.0',packageGoal='courier.delivery';
    const packageDefinition={goalKey:packageGoal,policyVersion:'courier-v1',mode:'semantic' as const,visible:true,
      rubric:{kind:'semantic' as const,promptKey:'courier.delivery',criteria:{objective:'Deliver an intact sealed letter to the named recipient.',
        successConditions:['A formal event explicitly establishes that the named recipient physically received the intact sealed letter.'],failureConditions:[],settlementConditions:[]}},outcome:{result:'delivery complete'}};
    await installSignedRealmWorldFixture({installRoot,worldId:packageWorld,version:packageVersion,recordTitle:'Signed courier acceptance',goals:[packageDefinition],keyId:'real-goals-acceptance',keyPair});
    await writeFile(trustStore,JSON.stringify({format:'realmworld-trust-store',version:1,keys:[{keyId:'real-goals-acceptance',publicKey:keyPair.publicKeyPem,status:'active',
      notBefore:new Date(Date.now()-86400000).toISOString(),notAfter:new Date(Date.now()+86400000).toISOString()}]}),{mode:0o600});
    process.env.REALM_REALMWORLD_INSTALL_ROOT=installRoot;process.env.REALM_GOAL_WORKER_INSTALL_ROOT=installRoot;process.env.REALM_REALMWORLD_TRUST_STORE=trustStore;
    const instantiate=await import('../app/api/realmworld/instantiate/route.ts');
    const instantiated=await instantiate.POST(new Request('http://localhost/api/realmworld/instantiate',{method:'POST',headers:{cookie,origin:'http://localhost','content-type':'application/json','idempotency-key':`real-package-${randomUUID()}`},
      body:JSON.stringify({worldId:packageWorld,worldVersion:packageVersion,locale:'en'})}));
    assert.equal(instantiated.status,201,JSON.stringify(await instantiated.clone().json()));
    const packageTarget=await instantiated.json();
    const packageGoals=async(recordId:string)=>(await admin.query(`SELECT goal_key,state,definition_source,policy_version,progress FROM goal_instances
      WHERE workspace_id=$1 AND record_id=$2 ORDER BY goal_key`,[scope.workspaceId,recordId])).rows;
    const initialPackageGoals=await packageGoals(packageTarget.recordId);
    assert.equal(initialPackageGoals.length,1);assert.equal(initialPackageGoals[0].goal_key,packageGoal);assert.equal(initialPackageGoals[0].state,'active');
    const packageTurns=[await realTurn(packageTarget.recordId,'I inspect my current surroundings. I do not deliver a letter, enter an agreement, travel or spend resources.')];
    assert.equal((await packageGoals(packageTarget.recordId))[0].state,'active','inspection is not a delivery');
    const packageHead=(await admin.query('SELECT record_version FROM record_heads WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,packageTarget.recordId])).rows;
    const packageExport=await save.POST(new Request('http://localhost/api/record/save',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({recordId:packageTarget.recordId})}));
    assert.equal(packageExport.status,200);const packageBytes=new Uint8Array(await packageExport.arrayBuffer());
    const {parseRealmRuntimeSaveArchive}=await import('../modules/world-transfer/realm-runtime-save.ts');
    assert.deepEqual(parseRealmRuntimeSaveArchive(packageBytes).manifest.world,{worldId:packageWorld,worldVersion:packageVersion});
    const packageRestore=await restore.POST(new Request('http://localhost/api/record/restore',{method:'POST',headers:{cookie,'content-type':'application/vnd.realm.save+zip','x-realm-target-world':packageWorld,'idempotency-key':`real-package-restore-${randomUUID()}`},body:packageBytes}));
    assert.equal(packageRestore.status,201,JSON.stringify(await packageRestore.clone().json()));const packageRestored=await packageRestore.json();
    const packageBranch=await branch.POST(new Request('http://localhost/api/record/branch',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({recordId:packageTarget.recordId,idempotencyKey:`real-package-branch-${randomUUID()}`})}));
    assert.equal(packageBranch.status,201,JSON.stringify(await packageBranch.clone().json()));const packageBranched=await packageBranch.json();
    for(const target of [packageRestored,packageBranched]){
      assert.equal((await packageGoals(target.recordId))[0].state,'active');
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM goal_assessment_jobs WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,target.recordId])).rows[0].count,0,'old operational jobs are never copied');
      assert.equal((await admin.query('SELECT world_version FROM records WHERE workspace_id=$1 AND id=$2',[scope.workspaceId,target.recordId])).rows[0].world_version,packageVersion);
      packageTurns.push(await realTurn(target.recordId,'I look around without delivering any letter, travelling, agreeing to anything or spending resources.'));
      assert.equal((await packageGoals(target.recordId))[0].state,'active');
    }
    assert.deepEqual((await admin.query('SELECT record_version FROM record_heads WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,packageTarget.recordId])).rows,packageHead,'destination continuation cannot modify the source package Record');
    assert.deepEqual(await settingsHashes(),beforeSettings,'real acceptance must never persist model or credential changes');
    const receipt={container,provider:profileId,model:selectedModel,observations,reports,recoveries,sourceRecordId:scope.recordId,
      restoredRecordId:restoreTarget.recordId,branchRecordId:branchTarget.recordId,sourceUnchanged:true,settingsUnchanged:true,
      controlledWorldFacts:true,realJudgeAndEvolution:true,realNarratorFormalTurn:true,realTurnAutomaticAssessmentJobs:nativeTurn.jobIds.length,
      signedRealmWorld:{worldId:packageWorld,worldVersion:packageVersion,goalKey:packageGoal,controlledSampleContent:true,realInstallInstantiate:true,realTurns:packageTurns}};
    const receiptPath=process.env.REALM_GOAL_REAL_PROVIDER_RECEIPT;
    if(receiptPath){const path=resolve(receiptPath);assert.ok(path.startsWith(resolve(process.env.TMPDIR??tmpdir())+sep));await writeFile(path,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});}
    t.diagnostic(JSON.stringify({provider:profileId,model:selectedModel,realCalls:observations.length,acceptedAssessments:reports.length,
      automaticEvolution:true,restoredAndBranched:true,sourceUnchanged:true,settingsUnchanged:true}));
  } finally {await endSharedRuntimePools();await runtime.end();await admin.end();}
});
