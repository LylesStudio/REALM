import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {POSTGRES_DEMO_IDS,createPostgresRuntimeRepository,createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository} from '../database/postgres/public.ts';
import {createLocalRecordService,mapLocalFormalEvent} from '../modules/application/local-record-service.ts';
import type {LocalRuntimeRepository} from '../modules/application/local-record-turn-runtime.ts';
import {createLocalM2TurnOrchestrator} from '../modules/orchestration/public.ts';
import {withWorkspaceTransaction} from '../database/postgres/workspace-transaction.ts';
import {emptyNarrativeState,planNarrativeConsequence} from '../modules/application/narrative-situation.ts';
import {applyCommittedNarrativeState,loadRecordNarrativeState,rebuildRecordNarrativeState} from '../database/postgres/narrative-situation-repository.ts';

const options={skip:!process.env.DATABASE_URL || !process.env.REALM_RUNTIME_DATABASE_URL?'requires scratch PostgreSQL':false,timeout:120_000};
test('narrative state is an event-bound, scoped, replayable projection with atomic rollback',options,async()=>{
  const owner=new pg.Pool({connectionString:process.env.DATABASE_URL!,max:1});
  const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL!,max:1});
  const scope={workspaceId:`narrative_workspace_${randomUUID()}`,worldId:`narrative_world_${randomUUID()}`,
    worldlineId:`narrative_line_${randomUUID()}`,recordId:`narrative_${randomUUID()}`};
  const storyId=`narrative_story_${randomUUID()}`;
  const identity={workspace_id:scope.workspaceId,world_id:scope.worldId,worldline_id:scope.worldlineId,record_id:scope.recordId};
  const sourceEventId=`narration_${randomUUID()}`;
  const state=planNarrativeConsequence({scope,previous:emptyNarrativeState(),expectedRevision:0,sourceEventId,
    observedHead:{recordVersion:0,ordinal:0},sourceRole:'narrator',turnKind:'player',committedEventIds:[],timeAdvanceAuthorized:false,
    proposal:{changes:[{situationId:null,status:'active',fact:'A patrol blocks the pier.',obstacle:'Searchlight',unknowns:[],
      exitConditions:['The patrol leaves'],basisEventIds:[],playerActions:[]}],elapsedMinutes:0}})!;
  try {
    await withWorkspaceTransaction(owner,scope.workspaceId,async client=>{
      await client.query(`INSERT INTO workspaces(id,name) VALUES($1,'Narrative isolated fixture')`,[scope.workspaceId]);
      await client.query(`INSERT INTO accounts(workspace_id,principal_id,display_name)
        SELECT $1,principal_id,display_name FROM accounts WHERE workspace_id=$2 AND principal_id=$3`,
        [scope.workspaceId,POSTGRES_DEMO_IDS.workspace,POSTGRES_DEMO_IDS.principal]);
      await client.query(`INSERT INTO worlds SELECT (jsonb_populate_record(NULL::worlds,to_jsonb(source)||$1::jsonb)).*
        FROM worlds source WHERE workspace_id=$2 AND id=$3`,[JSON.stringify({id:scope.worldId,workspace_id:scope.workspaceId}),POSTGRES_DEMO_IDS.workspace,POSTGRES_DEMO_IDS.world]);
      await client.query(`INSERT INTO worldlines SELECT (jsonb_populate_record(NULL::worldlines,to_jsonb(source)||$1::jsonb)).*
        FROM worldlines source WHERE workspace_id=$2 AND id=$3`,[JSON.stringify({id:scope.worldlineId,workspace_id:scope.workspaceId,world_id:scope.worldId,head_tick:0,head_ordinal:0}),POSTGRES_DEMO_IDS.workspace,POSTGRES_DEMO_IDS.worldline]);
      await client.query(`INSERT INTO stories SELECT (jsonb_populate_record(NULL::stories,to_jsonb(source)||$1::jsonb)).*
        FROM stories source WHERE workspace_id=$2 AND id=$3`,[JSON.stringify({...identity,id:storyId}),POSTGRES_DEMO_IDS.workspace,POSTGRES_DEMO_IDS.story]);
      await client.query(`INSERT INTO records SELECT (jsonb_populate_record(NULL::records,to_jsonb(source)||$1::jsonb)).*
        FROM records source WHERE workspace_id=$2 AND id=$3`,[JSON.stringify({...identity,id:scope.recordId,story_id:storyId}),POSTGRES_DEMO_IDS.workspace,POSTGRES_DEMO_IDS.record]);
      await client.query(`INSERT INTO scenes SELECT (jsonb_populate_record(NULL::scenes,to_jsonb(source)||$1::jsonb)).*
        FROM scenes source WHERE workspace_id=$2 AND record_id=$3 ORDER BY start_tick,start_ordinal LIMIT 1`,
        [JSON.stringify({...identity,id:`scene_${randomUUID()}`,start_tick:0,start_ordinal:0}),POSTGRES_DEMO_IDS.workspace,POSTGRES_DEMO_IDS.record]);
      await client.query(`INSERT INTO visibility_policies SELECT (jsonb_populate_record(NULL::visibility_policies,to_jsonb(source)||$1::jsonb)).*
        FROM visibility_policies source WHERE workspace_id=$2 AND record_id=$3 AND policy_kind='public' LIMIT 1`,
        [JSON.stringify({...identity,id:`policy_${randomUUID()}`}),POSTGRES_DEMO_IDS.workspace,POSTGRES_DEMO_IDS.record]);
      await client.query(`INSERT INTO events (workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,
        actor_participant_id,speaker_name,content,payload,visibility_policy_id,world_tick,world_ordinal,calendar_id,display_time)
        SELECT $1,$2,$3,$4,scene.id,$5,1,1,0,'narration.committed',NULL,'', 'A patrol blocks the pier.',$6::jsonb,policy.id,
        line.head_tick,line.head_ordinal+1,world.calendar_id,'' FROM worlds world JOIN worldlines line ON line.workspace_id=world.workspace_id AND line.world_id=world.id
        JOIN scenes scene ON scene.workspace_id=world.workspace_id AND scene.record_id=$4
        JOIN visibility_policies policy ON policy.workspace_id=world.workspace_id AND policy.record_id=$4 AND policy.policy_kind='public'
        WHERE world.workspace_id=$1 AND world.id=$2 AND line.id=$3 LIMIT 1`,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,sourceEventId,
        JSON.stringify({__realmRuntimePayload:{schemaVersion:1,role:'narrator',content:'A patrol blocks the pier.',narrativeState:state}})]);
      await client.query(`UPDATE worldlines SET head_ordinal=head_ordinal+1 WHERE workspace_id=$1 AND id=$2`,[scope.workspaceId,scope.worldlineId]);
    });
    await withWorkspaceTransaction(runtime,scope.workspaceId,async client=>{
      assert.equal(await applyCommittedNarrativeState(client,{scope,sourceEventId,expectedRevision:0}),'applied');
      assert.equal(await applyCommittedNarrativeState(client,{scope,sourceEventId,expectedRevision:0}),'replayed');
      assert.deepEqual(await loadRecordNarrativeState(client,scope),state);
    });
    await assert.rejects(withWorkspaceTransaction(runtime,scope.workspaceId,client=>client.query(`UPDATE record_narrative_state
      SET document=jsonb_set(document,'{situations,0,fact}','"invented"'::jsonb) WHERE workspace_id=$1 AND record_id=$2`,
      [scope.workspaceId,scope.recordId])),/NARRATIVE_SOURCE_INVALID/);
    const isolated=await withWorkspaceTransaction(runtime,'another_workspace',client=>client.query(`SELECT * FROM record_narrative_state WHERE record_id=$1`,[scope.recordId]));
    assert.equal(isolated.rowCount,0);
    await withWorkspaceTransaction(owner,scope.workspaceId,client=>client.query(`DELETE FROM record_narrative_state WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,scope.recordId]));
    await withWorkspaceTransaction(runtime,scope.workspaceId,async client=>{
      assert.deepEqual(await loadRecordNarrativeState(client,scope),state,'read-only event replay survives cache loss');
      assert.deepEqual(await rebuildRecordNarrativeState(client,scope),state);
    });
    await assert.rejects(withWorkspaceTransaction(runtime,scope.workspaceId,async client=>{
      await client.query(`UPDATE record_narrative_state SET updated_at=CURRENT_TIMESTAMP WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,scope.recordId]);
      throw new Error('injected-late-failure');
    }),/injected-late-failure/);
    const check=await withWorkspaceTransaction(runtime,scope.workspaceId,client=>loadRecordNarrativeState(client,scope));
    assert.deepEqual(check,state);
    const catalog=(await owner.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='record_narrative_state'::regclass`)).rows[0];
    assert.deepEqual(catalog,{relrowsecurity:true,relforcerowsecurity:true});
    // Production tracer: authorized service -> real release -> event/cache -> fresh scope.
    // Narrator is explicitly deterministic fixture output, not a real provider claim.
    await withWorkspaceTransaction(owner,scope.workspaceId,async client=>{
      await client.query(`INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')`,
        [scope.workspaceId,scope.worldId,POSTGRES_DEMO_IDS.principal]);
      await client.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,principal_id,controller_mode)
        VALUES($1,$2,$3,$4,$5,'narrator',$6,'human')`,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,`narrator_${randomUUID()}`,POSTGRES_DEMO_IDS.principal]);
      await client.query(`INSERT INTO record_heads SELECT (jsonb_populate_record(NULL::record_heads,to_jsonb(source)||$1::jsonb)).*
        FROM record_heads source WHERE workspace_id=$2 AND record_id=$3`,[JSON.stringify({...identity,record_version:1,next_record_ordinal:2,last_event_id:sourceEventId,
        last_world_tick:0,last_world_ordinal:1}),POSTGRES_DEMO_IDS.workspace,POSTGRES_DEMO_IDS.record]);
    });
    const scopeProvider=createPostgresRecordRuntimeScopeRepository(runtime);
    const initialScope=await scopeProvider.resolve({...scope,principalId:POSTGRES_DEMO_IDS.principal});
    const readState=(brief:unknown)=>JSON.parse((brief as {narrativeState?:string}).narrativeState??'null');
    assert.deepEqual(readState(initialScope?.brief),state,'production scope must carry event-bound state, not only opening prose');
    const repository:LocalRuntimeRepository=createPostgresRuntimeRepository({pool:runtime,workspaceId:scope.workspaceId,mapFormalEvent:mapLocalFormalEvent});
    const briefs:unknown[]=[];
    let publishGate=false;
    let narratorCalls=0;
    const service=createLocalRecordService({repository,workspaceId:scope.workspaceId,
      projection:createPostgresDeliveryProjectionRepository(runtime),runtimeScopeProvider:scopeProvider,
      orchestratorFactory:current=>{
        const snapshot=readState(current.brief);briefs.push(snapshot);
        return createLocalM2TurnOrchestrator({characters:[],narrator:{async narrate(){
          narratorCalls++;
          const fact=publishGate?'A gate closes across the channel.':'The searchlight has moved away; the pier is clear.';
          return {speaker:'Narrator',participantId:null,characterInstanceId:null,content:fact,
            segments:[{id:'environment-1',kind:'environment',content:fact,speechMode:'none'}],
            ...(publishGate || snapshot?.situations[0]?.status==='active'?{narrativeConsequence:{changes:[{
              situationId:publishGate?null:state.situations[0]!.id,status:publishGate?'active':'resolved',fact,obstacle:null,unknowns:[],exitConditions:[],
              basisEventIds:publishGate?[]:[sourceEventId],playerActions:[]}],elapsedMinutes:0}}:{})};
        }}});
      }});
    const first=await service.loadRecord(scope.recordId);
    const request={recordId:scope.recordId,content:'I check whether the searchlight is gone.',idempotencyKey:`narrative-${randomUUID()}`,writeToken:first.writeToken};
    const committed=await service.submitMessage(request);
    assert.equal(committed.disposition,'committed');
    const after=await withWorkspaceTransaction(runtime,scope.workspaceId,client=>loadRecordNarrativeState(client,scope));
    assert.equal(after.revision,2,'release must atomically advance the actual projection');
    assert.equal(after.situations[0]!.status,'resolved');
    const raw=(await owner.query(`SELECT payload->'__realmRuntimePayload'->'narrativeState' AS state FROM events
      WHERE workspace_id=$1 AND record_id=$2 AND event_kind='narration.committed' ORDER BY record_ordinal DESC LIMIT 1`,[scope.workspaceId,scope.recordId])).rows[0].state;
    assert.deepEqual(raw,after,'the cache must exactly match the accepted formal Narrator event');
    assert.equal((await service.submitMessage(request)).disposition,'duplicate');
    for(const altered of [{...request,content:'Different player intent.'},
      {...request,actionSelection:{affordanceId:'fixture_new_selection'}}]) {
      await assert.rejects(service.submitMessage(altered),(error:unknown)=>(error as {code?:string}).code==='IDEMPOTENCY_CONFLICT');
    }
    const second=await service.loadRecord(scope.recordId);
    await service.submitMessage({...request,content:'I look down the clear channel.',idempotencyKey:`narrative-${randomUUID()}`,writeToken:second.writeToken});
    assert.ok(briefs.some(value=>(value as typeof state).revision===2 && (value as typeof state).situations[0]!.status==='resolved'),
      'the next production orchestration must consume the resolved state');
    const counters=async()=>(await owner.query(`SELECT head.record_version,head.next_record_ordinal,head.last_event_id,
      line.head_tick,line.head_ordinal,(SELECT count(*) FROM events WHERE workspace_id=$1 AND record_id=$2) AS events,
      (SELECT count(*) FROM outbox WHERE workspace_id=$1 AND record_id=$2) AS outbox
      FROM record_heads head JOIN worldlines line ON line.workspace_id=head.workspace_id AND line.id=head.worldline_id
      WHERE head.workspace_id=$1 AND head.record_id=$2`,[scope.workspaceId,scope.recordId])).rows[0];
    const baseline=await counters();
    const fault=`narrative_outbox_fault_${randomUUID().replaceAll('-','')}`;
    await owner.query(`CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF NEW.record_id=TG_ARGV[0] THEN RAISE EXCEPTION 'injected-narrative-late-outbox-failure' USING ERRCODE='40001'; END IF; RETURN NEW; END $body$`);
    await owner.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION ${fault}('${scope.recordId}')`);
    publishGate=true;
    const third=await service.loadRecord(scope.recordId);
    const faultRequest={...request,content:'I check the channel gate.',idempotencyKey:`narrative-${randomUUID()}`,writeToken:third.writeToken};
    const callsBefore=narratorCalls;
    try {
      await assert.rejects(service.submitMessage(faultRequest));
      assert.deepEqual(await counters(),baseline,'late outbox failure rolls back events, both heads and outbox');
      assert.deepEqual(await withWorkspaceTransaction(runtime,scope.workspaceId,client=>loadRecordNarrativeState(client,scope)),after,
        'the narrative projection must roll back with the exact same release');
    } finally {
      await owner.query(`DROP TRIGGER ${fault} ON outbox`);
      await owner.query(`DROP FUNCTION ${fault}()`);
    }
    assert.equal((await service.submitMessage(faultRequest)).disposition,'committed','same request resumes after storage recovery');
    assert.equal(narratorCalls,callsBefore+1,'release retry reuses the durable candidate instead of inventing another consequence');
    const recovered=await withWorkspaceTransaction(runtime,scope.workspaceId,client=>loadRecordNarrativeState(client,scope));
    assert.equal(recovered.revision,3);
    assert.equal(recovered.situations[0]!.status,'resolved');
    assert.equal(recovered.situations[1]!.status,'active');
    assert.deepEqual(await withWorkspaceTransaction(runtime,scope.workspaceId,client=>rebuildRecordNarrativeState(client,scope)),recovered);
  } finally {await runtime.end();await owner.end();}
});
