import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { sessionProofFor } from "./helpers/session-proof.ts";

const enabled = !!process.env.DATABASE_URL && !!process.env.REALM_RUNTIME_DATABASE_URL;
const options = { skip: enabled ? false : "requires isolated scratch runner", timeout: 120_000 };
const draft = { title: "Deliver the letter", description: "Protect it until delivery.",
  successConditions: ["The named recipient receives the intact letter"], failureConditions: [],
  settlementConditions: [], changePolicy: "evolving", visible: true };

async function fixture(admin: pg.Pool) {
  const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: `world_${randomUUID()}`,
    worldlineId: `worldline_${randomUUID()}`, recordId: `record_${randomUUID()}` };
  const storyId = `story_${randomUUID()}`;
  const sceneId = `scene_${randomUUID()}`;
  await withWorkspaceTransaction(admin, scope.workspaceId, async (client) => {
    const clone = async (table: string, predicate: string, sourceId: string, patch: object) => {
      // All identifiers/predicates are test-owned literals; values stay bound.
      const inserted = await client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table}, to_jsonb(source) || $1::jsonb)).*
        FROM ${table} AS source WHERE workspace_id = $2 AND ${predicate} = $3 LIMIT 1`,
      [JSON.stringify(patch), scope.workspaceId, sourceId]);
      assert.equal(inserted.rowCount, 1, `fixture ${table}`);
    };
    await clone('worlds', 'id', POSTGRES_DEMO_IDS.world, { id: scope.worldId, name: 'Goal command isolation' });
    const scoped = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId };
    await clone('worldlines', 'id', POSTGRES_DEMO_IDS.worldline, { id: scope.worldlineId, world_id: scope.worldId, head_tick: 0, head_ordinal: 0 });
    await clone('stories', 'id', POSTGRES_DEMO_IDS.story, { ...scoped, id: storyId, start_tick:0,start_ordinal:0 });
    await clone('records', 'id', POSTGRES_DEMO_IDS.record, { ...scoped, id: scope.recordId, story_id: storyId, status: 'active',start_tick:0,start_ordinal:0 });
    await clone('scenes', 'record_id', POSTGRES_DEMO_IDS.record, { ...scoped, id: sceneId,start_tick:0,start_ordinal:0 });
    await clone('visibility_policies', "policy_kind = 'public' AND record_id", POSTGRES_DEMO_IDS.record,
      { ...scoped, id: `policy_${randomUUID()}` });
    await client.query(`INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
      VALUES ($1,$2,$3,'owner')`, [scope.workspaceId, scope.worldId, POSTGRES_DEMO_IDS.principal]);
    await client.query(`INSERT INTO participants (workspace_id,world_id,worldline_id,record_id,id,
      participant_kind,principal_id,controller_mode) VALUES ($1,$2,$3,$4,$5,'narrator',$6,'human')`,
      [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,`participant_${randomUUID()}`,POSTGRES_DEMO_IDS.principal]);
    await clone('record_heads', 'record_id', POSTGRES_DEMO_IDS.record,
      { ...scoped, record_version: 0, next_record_ordinal: 1, last_event_id: null, last_world_tick: 0, last_world_ordinal: 0 });
  });
  return scope;
}

test('owner Goal editor reads exact public definitions and assessment waits for real post-activation evidence', options, async t => {
  const admin = new pg.Pool({connectionString:process.env.DATABASE_URL});
  t.after(()=>admin.end());
  const scope = await fixture(admin);
  await withWorkspaceTransaction(admin,scope.workspaceId,client=>client.query(`UPDATE record_heads SET next_record_ordinal=0
    WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,scope.recordId]));
  const handlers = await import('../app/api/record/goals/commands/route.ts');
  assert.equal(typeof handlers.GET,'function');
  const request = (principal:string=POSTGRES_DEMO_IDS.principal) => new Request(`http://localhost/api/record/goals/commands?recordId=${scope.recordId}`,
    {headers:{cookie:`realm_session=${sessionProofFor(principal)}`}});
  const initial = await handlers.GET(request());
  assert.equal(initial.status,200);
  const before = (await initial.json()).data;
  assert.equal(before.canCreate,true);
  assert.deepEqual(before.head,{recordVersion:0,ordinal:0});
  const created = await handlers.POST(commandRequest(scope.recordId,{operation:'create',recordId:scope.recordId,expectedHead:before.head,draft},'editor.goal'));
  assert.equal(created.status,201,await created.clone().text());
  const after = (await (await handlers.GET(request())).json()).data;
  assert.deepEqual(after.head,{recordVersion:1,ordinal:1});
  const {decodeGoalManagement}=await import('../modules/goals/management-contract.ts');
  assert.deepEqual(decodeGoalManagement(after,scope.recordId),after);
  assert.deepEqual(after.goals[0].draft,draft);
  assert.equal(after.goals[0].canRevise,true);
  const {requestRecordGoalAssessment}=await import('../modules/application/record-goal-management.ts');
  const runtime = new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  t.after(()=>runtime.end());
  assert.equal(await requestRecordGoalAssessment(runtime,{scope,principalId:POSTGRES_DEMO_IDS.principal,
    goalInstanceId:after.goals[0].goalInstanceId,expectedHead:after.head}),'waiting');
  const hidden = await handlers.POST(commandRequest(scope.recordId,{operation:'create',recordId:scope.recordId,expectedHead:after.head,
    draft:{...draft,title:'Private criterion must never appear',visible:false}},'editor.hidden'));
  assert.equal(hidden.status,201);
  const publicOnly = await handlers.GET(request());
  const body = await publicOnly.text();
  assert.equal(body.includes('Private criterion must never appear'),false);
  assert.equal((await handlers.GET(request('principal_outsider'))).status,404);
  await withWorkspaceTransaction(admin,scope.workspaceId,client=>client.query(`UPDATE player_world_memberships SET role='player'
    WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`,[scope.workspaceId,scope.worldId,POSTGRES_DEMO_IDS.principal]));
  assert.equal((await handlers.GET(request())).status,403);
});

test('standalone native Goal worker boots with runtime authority only and releases its lock on shutdown', options, async () => {
  const {spawn}=await import('node:child_process');
  const environment={...process.env};
  for(const key of ['DATABASE_URL','REALM_TRANSFER_DATABASE_URL','REALM_SESSION_SECRET','REALM_GOAL_WORKER_INSTALL_ROOT','REALM_REALMWORLD_TRUST_STORE']) delete environment[key];
  const child=spawn(process.execPath,['--experimental-strip-types','scripts/goal-assessment-worker.mjs'],
    {env:environment,stdio:['ignore','pipe','pipe']});
  let output='';
  let readyResolve:()=>void=()=>{};
  const ready=new Promise<void>(resolve=>{readyResolve=resolve;});
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('[goal-worker] ready'))readyResolve();});
  child.stderr.on('data',()=>{});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([ready,exited.then(()=>{throw new Error('Native worker exited before ready.');}),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Native worker readiness deadline exceeded.')),15000);})]);
  } finally {
    clearTimeout(timeout);
    child.kill('SIGTERM');
    let stopTimer:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([exited,new Promise<void>(resolve=>{stopTimer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);})]);
    clearTimeout(stopTimer);
    await exited;
  }
  assert.equal(child.exitCode,0);
  const client=new pg.Client({connectionString:process.env.REALM_RUNTIME_DATABASE_URL!});
  try {
    await client.connect();
    const lock=(await client.query(`SELECT pg_try_advisory_lock(hashtext('realm_goal_assessment_worker')) AS locked`)).rows[0];
    assert.equal(lock.locked,true);
  } finally {await client.end();}
});

test('evolving Goals automatically adopt an evidence-backed successor while fixed definitions remain unchanged', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const { createPostgresGoalAssessmentJobQueue } = await import('../database/postgres/goal-assessment-job-queue.ts');
  const { createRecordGoalDefinitionResolver } = await import('../modules/application/record-goal-definition.ts');
  const { runGoalAssessmentOnce } = await import('../modules/goals/assessment-worker.ts');
  const { createModelGoalJudge } = await import('../modules/goals/model-judge.ts');
  const { createModelGoalEvolutionPlanner } = await import('../modules/goals/model-evolution.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL!, max: 2 });
  try {
    for (const [changePolicy, verdict] of [['evolving','continue'], ['fixed','continue'], ['evolving','complete']] as const) {
      const scope = await fixture(admin);
      const created = await (await POST(commandRequest(scope.recordId, { draft: { ...draft, changePolicy } }, `auto-${randomUUID()}`))).json();
      const sourceEventId = `world-result-${randomUUID()}`;
      const worldResult = verdict === 'complete'
        ? 'The named recipient received the intact letter. The harbor is now closed; a safe route home is available through the northern refuge.'
        : 'The original harbor has permanently closed; the northern refuge remains available.';
      await withWorkspaceTransaction(admin, scope.workspaceId, async client => {
        await client.query(`INSERT INTO events SELECT (jsonb_populate_record(NULL::events,to_jsonb(source)||$1::jsonb)).*
          FROM events source WHERE workspace_id=$2 AND record_id=$3 AND id=$4`, [JSON.stringify({ id: sourceEventId,
          record_version: 2, record_ordinal: 2, world_ordinal: 2, event_kind: 'narration.committed',
          content: worldResult, payload: { __realmRuntimePayload: { role: 'narrator', text: worldResult } } }),
          scope.workspaceId, scope.recordId, created.data.eventId]);
        await client.query(`UPDATE record_heads SET record_version=2,next_record_ordinal=3,last_event_id=$3,last_world_ordinal=2 WHERE workspace_id=$1 AND record_id=$2`, [scope.workspaceId,scope.recordId,sourceEventId]);
        await client.query(`UPDATE worldlines SET head_ordinal=2 WHERE workspace_id=$1 AND id=$2`, [scope.workspaceId,scope.worldlineId]);
        const privatePolicy = `private-policy-${randomUUID()}`;
        const privateEvent = `private-event-${randomUUID()}`;
        await client.query(`INSERT INTO visibility_policies SELECT (jsonb_populate_record(NULL::visibility_policies,to_jsonb(source)||$1::jsonb)).*
          FROM visibility_policies source WHERE workspace_id=$2 AND record_id=$3 LIMIT 1`,
          [JSON.stringify({ id: privatePolicy, policy_key: privatePolicy, policy_kind: 'dm_only' }),scope.workspaceId,scope.recordId]);
        await client.query(`INSERT INTO events SELECT (jsonb_populate_record(NULL::events,to_jsonb(source)||$1::jsonb)).*
          FROM events source WHERE workspace_id=$2 AND id=$3`, [JSON.stringify({ id: privateEvent, record_version: 3, record_ordinal: 3,
          world_ordinal: 3, visibility_policy_id: privatePolicy, content: 'PRIVATE_EVOLUTION_CONTEXT',
          payload: { __realmRuntimePayload: { role: 'narrator', text: 'PRIVATE_EVOLUTION_CONTEXT' } } }),scope.workspaceId,sourceEventId]);
        await client.query(`UPDATE record_heads SET record_version=3,next_record_ordinal=4,last_event_id=$3,last_world_ordinal=3 WHERE workspace_id=$1 AND record_id=$2`, [scope.workspaceId,scope.recordId,privateEvent]);
        await client.query(`UPDATE worldlines SET head_ordinal=3 WHERE workspace_id=$1 AND id=$2`, [scope.workspaceId,scope.worldlineId]);
      });
      let evolutionCalls = 0;
      const getGateway = async () => ({ async discoverModels() { return []; }, async chat(request: import('../modules/inference/public.ts').ModelChatRequest) {
        assert.equal(JSON.stringify(request).includes('PRIVATE_EVOLUTION_CONTEXT'),false,'A public Goal must not be assessed or evolved using hidden event contents');
        const isEvolution = request.messages[0]!.content.includes('Goal evolution planner');
        if (isEvolution) evolutionCalls++;
        return { model: 'deterministic-auto-evolution-fixture', content: JSON.stringify(isEvolution
          ? { decision: 'evolve', draft: { title: 'Find a safe route home', description: 'The harbor is closed; the northern refuge offers a safe route home.',
              successConditions: ['Reach the northern refuge safely'], failureConditions: [], settlementConditions: [] }, reason: 'The original harbor was formally closed', basisEventIds: [sourceEventId] }
          : { decision: verdict, evidenceEventIds: [sourceEventId], progress: { summary: worldResult, completedCriteria: verdict === 'complete' ? [0] : [] },
              outcome: verdict === 'complete' ? { summary: 'Letter delivered' } : null }),
          toolCalls: [], finishReason: 'stop', usage: null };
      } });
      const queue = createPostgresGoalAssessmentJobQueue({ pool: runtime, workspaceId: scope.workspaceId, leaseOwner: `auto-${randomUUID()}` });
      await queue.enqueue({ ...scope, jobId: `job-${randomUUID()}`, goalInstanceId: created.data.goalInstanceId, sourceEventId });
      const report = await runGoalAssessmentOnce({ repository: queue, resolveDefinition: createRecordGoalDefinitionResolver(runtime),
        judge: createModelGoalJudge({ getGateway }), evolutionPlanner: createModelGoalEvolutionPlanner({ getGateway }), now: new Date().toISOString() });
      assert.deepEqual(report, { kind: 'settled', status: 'accepted' });
      const goals = (await admin.query(`SELECT state,resolution_kind,revision::text,supersedes_instance_id,outcome FROM goal_instances WHERE record_id=$1 ORDER BY state`, [scope.recordId])).rows;
      assert.equal(goals.length, changePolicy === 'evolving' ? 2 : 1);
      assert.equal(evolutionCalls, changePolicy === 'evolving' ? 1 : 0);
      if (changePolicy === 'evolving') {
        assert.equal(goals[0].state, 'active');
        assert.equal(goals[0].supersedes_instance_id, created.data.goalInstanceId);
        assert.equal(goals[1].resolution_kind, verdict === 'complete' ? 'natural' : 'superseded');
        assert.equal(goals[1].state, verdict === 'complete' ? 'completed' : 'settled');
        if (verdict === 'complete') {
          assert.deepEqual(goals[1].outcome, { summary: 'Letter delivered' });
          const publication = await admin.query(`SELECT policy.policy_kind FROM events event JOIN visibility_policies policy
            ON policy.workspace_id=event.workspace_id AND policy.id=event.visibility_policy_id
            WHERE event.record_id=$1 AND event.payload#>>'{__realmRuntimePayload,to}'='completed'`, [scope.recordId]);
          assert.deepEqual(publication.rows,[{policy_kind:'public'}],'A public Goal completion must not inherit the unrelated last hidden event visibility');
        }
        const versions = (await admin.query(`SELECT definition_version,definition->>'changeKind' AS kind,definition->'basisEventIds' AS basis FROM record_goal_definitions WHERE record_id=$1 ORDER BY definition_version`, [scope.recordId])).rows;
        assert.deepEqual(versions.map(row => row.definition_version), [1,2]);
        assert.equal(versions[1].kind, 'automatic');
        assert.deepEqual(versions[1].basis, [sourceEventId]);
      } else assert.equal(goals[0].state, 'active');
      assert.equal((await runGoalAssessmentOnce({ repository: queue, resolveDefinition: createRecordGoalDefinitionResolver(runtime), now: new Date().toISOString() })).kind, 'idle');
    }
  } finally { await endSharedRuntimePools(); await runtime.end(); await admin.end(); }
});

test('semantic continue persists active progress through the native resolver, real queue and model adapter', options, async () => {
  const { POST }=await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools }=await import('../app/api/world-scope.ts');
  const { createPostgresGoalAssessmentJobQueue }=await import('../database/postgres/goal-assessment-job-queue.ts');
  const { createRecordGoalDefinitionResolver }=await import('../modules/application/record-goal-definition.ts');
  const { runGoalAssessmentOnce }=await import('../modules/goals/assessment-worker.ts');
  const { createModelGoalJudge }=await import('../modules/goals/model-judge.ts');
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL!,max:1});
  const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL!,max:2});
  try {
    const scope=await fixture(admin);
    const initial=await POST(commandRequest(scope.recordId,{},`progress-${randomUUID()}`));
    assert.equal(initial.status,201);
    const created=await initial.json();
    const sourceEventId=`narration-${randomUUID()}`;
    await withWorkspaceTransaction(admin,scope.workspaceId,async client=>{
      await client.query(`INSERT INTO events SELECT (jsonb_populate_record(NULL::events,to_jsonb(source)||$1::jsonb)).*
        FROM events source WHERE workspace_id=$2 AND record_id=$3 AND id=$4`,[JSON.stringify({id:sourceEventId,
        record_version:2,record_ordinal:2,world_ordinal:2,event_kind:'narration.committed',content:'The original seal is verified intact.',
        payload:{__realmRuntimePayload:{text:'The original seal is verified intact.'}}}),scope.workspaceId,scope.recordId,created.data.eventId]);
      await client.query(`UPDATE record_heads SET record_version=2,next_record_ordinal=3,last_event_id=$3,last_world_ordinal=2 WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,scope.recordId,sourceEventId]);
      await client.query(`UPDATE worldlines SET head_ordinal=2 WHERE workspace_id=$1 AND id=$2`,[scope.workspaceId,scope.worldlineId]);
    });
    const queue=createPostgresGoalAssessmentJobQueue({pool:runtime,workspaceId:scope.workspaceId,leaseOwner:`progress-${randomUUID()}`});
    await queue.enqueue({...scope,jobId:`job-${randomUUID()}`,goalInstanceId:created.data.goalInstanceId,sourceEventId});
    let providerCalls=0;
    let judgedSource=sourceEventId;
    const progress={summary:'The original seal is intact'};
    const judge=createModelGoalJudge({getGateway:async()=>({providerId:'lmstudio',async discoverModels(){return[];},async chat(request){
      providerCalls++;
      assert.ok(request.messages.some(m=>m.role==='user' && m.content.includes(draft.successConditions[0]!)));
      return {model:'deterministic-test-fixture',content:JSON.stringify({decision:'continue',evidenceEventIds:[judgedSource],progress,outcome:null}),
        toolCalls:[],finishReason:'stop',usage:null};
    }})});
    const report=await runGoalAssessmentOnce({repository:queue,resolveDefinition:createRecordGoalDefinitionResolver(runtime),judge,now:new Date().toISOString()});
    assert.deepEqual(report,{kind:'settled',status:'accepted'});
    assert.equal(providerCalls,1);
    const row=(await admin.query(`SELECT state,revision::text,progress,outcome,completed_at FROM goal_instances WHERE id=$1`,[created.data.goalInstanceId])).rows[0];
    assert.deepEqual(row,{state:'active',revision:'2',progress,outcome:null,completed_at:null});
    const head=(await admin.query(`SELECT record_version::text FROM record_heads WHERE record_id=$1`,[scope.recordId])).rows[0];
    assert.equal(head.record_version,'3');
    const contextModule = await import('../modules/application/record-goal-projection.ts');
    assert.equal(typeof contextModule.loadRecordGoalNarrativeContext, 'function', 'Goal progress must have a player-safe turn-context reader');
    const context = await contextModule.loadRecordGoalNarrativeContext(runtime, { scope });
    const document = JSON.parse(context.document);
    assert.equal(context.headOrdinal, 3);
    assert.equal(document.schemaVersion, 1);
    assert.equal(document.omittedGoals, 0);
    assert.equal(document.goals.length, 1);
    assert.equal(document.goals[0].title, draft.title);
    assert.equal(document.goals[0].description, draft.description);
    assert.equal(document.goals[0].changePolicy, 'evolving');
    assert.equal(document.goals[0].state, 'active');
    assert.deepEqual(document.goals[0].progress, progress);
    assert.equal('outcome' in document.goals[0], false, 'Raw runtime/Judge outcome must not enter turn context');
    assert.equal('capabilities' in document.goals[0], false, 'Model context must not carry management authority');
    assert.equal('successConditions' in document.goals[0], false, 'Context reuses the public projection, not hidden Judge criteria');
    const { createPostgresRecordRuntimeScopeRepository } = await import('../database/postgres/record-scope.ts');
    assert.equal(typeof contextModule.createRecordGoalContextScopeRepository, 'function', 'Production scope enrichment must be usable without a mock-only path');
    const provider = contextModule.createRecordGoalContextScopeRepository(runtime, createPostgresRecordRuntimeScopeRepository(runtime));
    const enriched = await provider.resolve({ workspaceId: scope.workspaceId, principalId: POSTGRES_DEMO_IDS.principal, recordId: scope.recordId });
    assert.ok(enriched);
    assert.equal(enriched.brief.recordGoals, context.document);
    assert.equal(await provider.resolve({ workspaceId: scope.workspaceId, principalId: 'non-member-goal-context', recordId: scope.recordId }), null,
      'Runtime scope resolution is not membership authorization');
    const secondSource=`narration-${randomUUID()}`;
    await withWorkspaceTransaction(admin,scope.workspaceId,async client=>{
      await client.query(`INSERT INTO events SELECT (jsonb_populate_record(NULL::events,to_jsonb(source)||$1::jsonb)).*
        FROM events source WHERE workspace_id=$2 AND record_id=$3 AND id=$4`,[JSON.stringify({id:secondSource,
        record_version:4,record_ordinal:4,world_ordinal:4,content:'A later observation confirms the seal is still intact.'}),
        scope.workspaceId,scope.recordId,sourceEventId]);
      await client.query(`UPDATE record_heads SET record_version=4,next_record_ordinal=5,last_event_id=$3,last_world_ordinal=4 WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,scope.recordId,secondSource]);
      await client.query(`UPDATE worldlines SET head_ordinal=4 WHERE workspace_id=$1 AND id=$2`,[scope.workspaceId,scope.worldlineId]);
    });
    judgedSource=secondSource;
    await queue.enqueue({...scope,jobId:`job-${randomUUID()}`,goalInstanceId:created.data.goalInstanceId,sourceEventId:secondSource});
    assert.deepEqual(await runGoalAssessmentOnce({repository:queue,resolveDefinition:createRecordGoalDefinitionResolver(runtime),judge,now:new Date().toISOString()}),
      {kind:'settled',status:'accepted'});
    assert.equal(providerCalls,2);
    assert.equal((await admin.query(`SELECT revision::text FROM goal_instances WHERE id=$1`,[created.data.goalInstanceId])).rows[0].revision,'2');
    assert.equal((await admin.query(`SELECT record_version::text FROM record_heads WHERE record_id=$1`,[scope.recordId])).rows[0].record_version,'4');
    assert.equal((await admin.query(`SELECT count(*)::text AS count FROM goal_assessments WHERE goal_instance_id=$1`,[created.data.goalInstanceId])).rows[0].count,'2');
  } finally {await endSharedRuntimePools();await runtime.end();await admin.end();}
});

function commandRequest(recordId: string, body: object, key: string, principal: string = POSTGRES_DEMO_IDS.principal) {
  return new Request('http://localhost/api/record/goals/commands', { method: 'POST', headers: {
    origin: 'http://localhost', 'content-type': 'application/json', 'idempotency-key': key,
    cookie: `realm_session=${sessionProofFor(principal)}`,
  }, body: JSON.stringify({ recordId, operation: 'create', expectedHead: { recordVersion: 0, ordinal: 0 }, draft, ...body }) });
}

test('native create commits one authored definition, instance, formal event and idempotent receipt', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const key = `create-${randomUUID()}`;
    const response = await POST(commandRequest(scope.recordId, {}, key));
    if (response.status === 503) {
      const { executeRecordGoalCommand } = await import('../modules/application/record-goal-command.ts');
      const { getSharedRuntimePool } = await import('../app/api/world-scope.ts');
      try {
        await executeRecordGoalCommand(getSharedRuntimePool(process.env.REALM_RUNTIME_DATABASE_URL!), {
          scope, principalId: POSTGRES_DEMO_IDS.principal, sessionProof: sessionProofFor(POSTGRES_DEMO_IDS.principal),
          idempotencyKey: key, command: { operation: 'create', recordId: scope.recordId, expectedHead: { recordVersion: 0, ordinal: 0 }, draft },
        });
      } catch (cause) {
        // Keep SQL/proof parameters out of test diagnostics; report only the database error name.
        assert.fail(cause instanceof Error ? cause.message : 'Goal create failed');
      }
    }
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const body = await response.json();
    assert.equal(body.data.status, 'committed');
    const replay = await POST(commandRequest(scope.recordId, {}, key));
    assert.equal(replay.status, 200);
    const replayBody = await replay.json();
    assert.equal(replayBody.data.status, 'replayed');
    assert.equal(replayBody.data.goalInstanceId, body.data.goalInstanceId);
    const rows = await admin.query(`SELECT
      (SELECT count(*)::int FROM record_goal_definitions WHERE record_id = $1) AS definitions,
      (SELECT count(*)::int FROM goal_instances WHERE record_id = $1) AS instances,
      (SELECT count(*)::int FROM record_goal_commands WHERE record_id = $1) AS commands,
      (SELECT count(*)::int FROM events WHERE record_id = $1 AND event_kind = 'goal.transition.committed') AS events,
      (SELECT record_version::text FROM record_heads WHERE record_id = $1) AS version`, [scope.recordId]);
    assert.deepEqual(rows.rows, [{ definitions: 1, instances: 1, commands: 1, events: 1, version: '1' }]);
  } finally { await endSharedRuntimePools(); await admin.end(); }
});

test('authoring capability has no PUBLIC execute, no runtime table append and no role inheritance', options, async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL!, max: 1 });
  try {
    const result = await admin.query(`SELECT
      has_table_privilege('realm_runtime','record_goal_definitions','INSERT') AS definition_insert,
      has_table_privilege('realm_runtime','record_goal_commands','INSERT') AS command_insert,
      has_function_privilege('realm_runtime','record_goal_manage(text,text,text,text,jsonb,jsonb)','EXECUTE') AS capability,
      pg_has_role('realm_runtime','realm_goal_authoring','MEMBER') AS member,
      p.prosecdef, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_exec
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='record_goal_manage(text,text,text,text,jsonb,jsonb)'::regprocedure`);
    assert.deepEqual(result.rows, [{ definition_insert: false, command_insert: false, capability: true, member: false,
      prosecdef: true, rolcanlogin: false, rolsuper: false, rolbypassrls: false, public_exec: false }]);
    for (const table of ['record_goal_definitions','record_goal_commands']) {
      await assert.rejects(withWorkspaceTransaction(runtime, POSTGRES_DEMO_IDS.workspace,
        client => client.query(`INSERT INTO ${table} DEFAULT VALUES`)), { code: '42501' });
    }
    await assert.rejects(runtime.query('SET ROLE realm_goal_authoring'), { code: '42501' });
  } finally { await runtime.end(); await admin.end(); }
});

test('create rejects changed idempotent input and a stale head without leaving partial writes', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const key = `cas-${randomUUID()}`;
    assert.equal((await POST(commandRequest(scope.recordId, {}, key))).status, 201);
    const changed = await POST(commandRequest(scope.recordId, { draft: { ...draft, title: 'Changed intent' } }, key));
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error.code, 'GOAL_IDEMPOTENCY_KEY_REUSED');
    const stale = await POST(commandRequest(scope.recordId, {}, `stale-${randomUUID()}`));
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'GOAL_WRITE_CONFLICT');
    const count = await admin.query(`SELECT
      (SELECT count(*)::int FROM record_goal_commands WHERE record_id=$1) AS commands,
      (SELECT count(*)::int FROM events WHERE record_id=$1) AS events,
      (SELECT count(*)::int FROM goal_instances WHERE record_id=$1) AS instances`, [scope.recordId]);
    assert.deepEqual(count.rows, [{ commands: 1, events: 1, instances: 1 }]);
  } finally { await endSharedRuntimePools(); await admin.end(); }
});

test('create rejects authority fields, cross-origin writes and non-owner sessions', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const { principalIdForDisplayName } = await import('../modules/identity/auth.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    for (const field of ['principalId','scope','state','progress','assessment','source','evidenceEventIds','managementAllowed','systemPrompt']) {
      const response = await POST(commandRequest(scope.recordId, { [field]: true }, `field-${field}`));
      assert.equal(response.status, 400, field);
    }
    const foreign = commandRequest(scope.recordId, {}, `origin-${randomUUID()}`);
    foreign.headers.set('origin','https://untrusted.example');
    assert.equal((await POST(foreign)).status, 403);
    const anonymous = commandRequest(scope.recordId, {}, `anon-${randomUUID()}`);
    anonymous.headers.delete('cookie');
    assert.equal((await POST(anonymous)).status, 401);
    const stranger = principalIdForDisplayName(`stranger-${randomUUID()}`);
    assert.equal((await POST(commandRequest(scope.recordId, {}, `stranger-${randomUUID()}`, stranger))).status, 404);
    for (const role of ['player','observer']) {
      await admin.query(`UPDATE player_world_memberships SET role=$3 WHERE workspace_id=$1 AND world_id=$2`,
        [scope.workspaceId, scope.worldId, role]);
      assert.equal((await POST(commandRequest(scope.recordId, {}, `role-${role}`))).status, 403);
    }
    const count = await admin.query(`SELECT count(*)::int AS n FROM record_goal_commands WHERE record_id=$1`, [scope.recordId]);
    assert.equal(count.rows[0].n, 0);
  } finally { await endSharedRuntimePools(); await admin.end(); }
});

test('native revise creates a successor and settles the predecessor without natural completion', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const created = await (await POST(commandRequest(scope.recordId, {}, `initial-${randomUUID()}`))).json();
    const key = `revise-${randomUUID()}`;
    const body = { operation: 'revise', expectedHead: { recordVersion: 1, ordinal: 1 },
      goalInstanceId: created.data.goalInstanceId, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
      reason: 'The author explicitly chooses another recipient', draft: { ...draft, title: 'Find the new recipient' } };
    const response = await POST(commandRequest(scope.recordId, body, key));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const revised = await response.json();
    assert.equal(revised.data.definitionVersion, 2);
    assert.notEqual(revised.data.goalInstanceId, created.data.goalInstanceId);
    const replay = await POST(commandRequest(scope.recordId, body, key));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).data.status, 'replayed');
    const rows = await admin.query(`SELECT state, revision::text, resolution_kind, outcome, supersedes_instance_id
      FROM goal_instances WHERE record_id=$1 ORDER BY state`, [scope.recordId]);
    assert.deepEqual(rows.rows, [
      { state: 'active', revision: '1', resolution_kind: 'natural', outcome: null, supersedes_instance_id: created.data.goalInstanceId },
      { state: 'settled', revision: '2', resolution_kind: 'superseded', outcome: null, supersedes_instance_id: null },
    ]);
    const { loadRecordGoalProjection } = await import('../modules/application/record-goal-projection.ts');
    const projection = await loadRecordGoalProjection(admin, { scope });
    assert.equal(projection.goals.find(goal => goal.state === 'active')!.supersedesInstanceId, created.data.goalInstanceId,
      'The projection must retain a predecessor link when both versions are public');
  } finally { await endSharedRuntimePools(); await admin.end(); }
});

test('native withdraw settles a fixed Goal as withdrawn and never reports natural success', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const created = await (await POST(commandRequest(scope.recordId, { draft: { ...draft, changePolicy: 'fixed' } }, `fixed-${randomUUID()}`))).json();
    const request = commandRequest(scope.recordId, { operation: 'withdraw', expectedHead: { recordVersion: 1, ordinal: 1 },
      goalInstanceId: created.data.goalInstanceId, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
      reason: 'The author explicitly withdraws the direction' }, `withdraw-${randomUUID()}`);
    const raw = await request.json();
    delete raw.draft;
    const response = await POST(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(raw) }));
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const rows = await admin.query(`SELECT state,revision::text,resolution_kind,outcome FROM goal_instances WHERE record_id=$1`, [scope.recordId]);
    assert.deepEqual(rows.rows, [{ state: 'settled', revision: '2', resolution_kind: 'withdrawn', outcome: null }]);
    const defs = await admin.query(`SELECT count(*)::int AS n FROM record_goal_definitions WHERE record_id=$1`, [scope.recordId]);
    assert.equal(defs.rows[0].n, 1);
  } finally { await endSharedRuntimePools(); await admin.end(); }
});

test('fixed Goal revision is rejected as a conflict rather than a provider outage', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const created = await (await POST(commandRequest(scope.recordId, { draft: { ...draft, changePolicy: 'fixed' } }, `fixed-${randomUUID()}`))).json();
    const response = await POST(commandRequest(scope.recordId, { operation: 'revise', expectedHead: { recordVersion: 1, ordinal: 1 },
      goalInstanceId: created.data.goalInstanceId, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
      reason: 'Attempted edit of a fixed definition', draft: { ...draft, title: 'A different standard' } }, `blocked-${randomUUID()}`));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'GOAL_DEFINITION_FIXED');
    const rows = await admin.query(`SELECT state,revision::text FROM goal_instances WHERE record_id=$1`, [scope.recordId]);
    assert.deepEqual(rows.rows, [{ state: 'active', revision: '1' }]);
  } finally { await endSharedRuntimePools(); await admin.end(); }
});

test('the database rejects absent, forged and non-owner proofs independently of the HTTP gate', options, async () => {
  const { createRecordGoalDefinition } = await import('../modules/goals/record-authoring.ts');
  const { principalIdForDisplayName } = await import('../modules/identity/auth.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const command = { operation: 'create', recordId: scope.recordId, expectedHead: { recordVersion: 0, ordinal: 0 }, draft };
    const definition = createRecordGoalDefinition({ scope, goalId: `probe-${randomUUID()}`, draft, activationHead: command.expectedHead });
    const stranger = principalIdForDisplayName(`proof-${randomUUID()}`);
    for (const proof of [null, 'not-a-proof', sessionProofFor(stranger)]) {
      await assert.rejects(withWorkspaceTransaction(runtime, scope.workspaceId, client => client.query(
        `SELECT record_goal_manage($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [proof,scope.workspaceId,scope.recordId,`proof-${randomUUID()}`,JSON.stringify(command),JSON.stringify(definition)])),
      /CAPABILITY_SESSION_PROOF_REQUIRED|CAPABILITY_SESSION_PROOF_INVALID|GOAL_FORBIDDEN/);
    }
    await assert.rejects(withWorkspaceTransaction(runtime, 'foreign-workspace', client => client.query(
      `SELECT record_goal_manage($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
      [sessionProofFor(POSTGRES_DEMO_IDS.principal),scope.workspaceId,scope.recordId,`scope-${randomUUID()}`,JSON.stringify(command),JSON.stringify(definition)])), /GOAL_SCOPE_MISMATCH/);
    const count = await admin.query(`SELECT count(*)::int AS n FROM record_goal_commands WHERE record_id=$1`, [scope.recordId]);
    assert.equal(count.rows[0].n, 0);
  } finally { await runtime.end(); await admin.end(); }
});

test('a late command-receipt failure rolls back hidden policy, Goal rows, event and both heads', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  const probe = `test_goal_rollback_${randomUUID().replaceAll('-','')}`;
  try {
    const scope = await fixture(admin);
    assert.match(scope.recordId, /^record_[a-f0-9-]+$/);
    await admin.query(`CREATE FUNCTION ${probe}() RETURNS trigger LANGUAGE plpgsql AS $probe$
      BEGIN RAISE EXCEPTION 'TEST_INJECTED_GOAL_ROLLBACK'; END; $probe$;
      CREATE TRIGGER ${probe} BEFORE INSERT ON record_goal_commands FOR EACH ROW
      WHEN (NEW.record_id='${scope.recordId}') EXECUTE FUNCTION ${probe}()`);
    const response = await POST(commandRequest(scope.recordId, { draft: { ...draft, visible: false } }, `rollback-${randomUUID()}`));
    assert.equal(response.status, 503);
    const rows = await admin.query(`SELECT
      (SELECT count(*)::int FROM record_goal_definitions WHERE record_id=$1) AS definitions,
      (SELECT count(*)::int FROM goal_instances WHERE record_id=$1) AS instances,
      (SELECT count(*)::int FROM events WHERE record_id=$1) AS events,
      (SELECT count(*)::int FROM record_goal_commands WHERE record_id=$1) AS commands,
      (SELECT count(*)::int FROM visibility_policies WHERE record_id=$1 AND policy_kind='dm_only') AS hidden_policies,
      (SELECT record_version::text FROM record_heads WHERE record_id=$1) AS version,
      (SELECT head_ordinal::text FROM worldlines WHERE id=$2) AS world_ordinal`, [scope.recordId,scope.worldlineId]);
    assert.deepEqual(rows.rows, [{ definitions: 0, instances: 0, events: 0, commands: 0, hidden_policies: 0, version: '0', world_ordinal: '0' }]);
  } finally {
    try { await admin.query(`DROP TRIGGER IF EXISTS ${probe} ON record_goal_commands; DROP FUNCTION IF EXISTS ${probe}()`); }
    finally { await endSharedRuntimePools(); await admin.end(); }
  }
});

test('concurrent identical create requests commit once and return the same durable identity', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const key = `parallel-${randomUUID()}`;
    const responses = await Promise.all([POST(commandRequest(scope.recordId, {}, key)), POST(commandRequest(scope.recordId, {}, key))]);
    assert.deepEqual(responses.map(r=>r.status).sort(), [200,201]);
    const [a,b] = await Promise.all(responses.map(r=>r.json()));
    assert.equal(a.data.goalInstanceId,b.data.goalInstanceId);
    const count = await admin.query(`SELECT count(*)::int AS n FROM events WHERE record_id=$1`, [scope.recordId]);
    assert.equal(count.rows[0].n, 1);
  } finally { await endSharedRuntimePools(); await admin.end(); }
});

test('revealing a successor does not publish a hidden predecessor identity in the management event', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const first = await POST(commandRequest(scope.recordId, { draft: { ...draft, visible: false } }, `hidden-${randomUUID()}`));
    assert.equal(first.status, 201);
    const { loadRecordGoalNarrativeContext } = await import('../modules/application/record-goal-projection.ts');
    const hiddenContext = await loadRecordGoalNarrativeContext(admin, { scope, principalId: POSTGRES_DEMO_IDS.principal });
    assert.deepEqual(JSON.parse(hiddenContext.document).goals, [], 'Hidden definitions must stay absent from the shared turn context');
    const created = await first.json();
    const next = await POST(commandRequest(scope.recordId, { operation: 'revise', expectedHead: { recordVersion: 1, ordinal: 1 },
      goalInstanceId: created.data.goalInstanceId, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
      reason: 'Explicitly reveal the new direction', draft: { ...draft, title: 'A publicly known successor', visible: true } }, `reveal-${randomUUID()}`));
    assert.equal(next.status, 200);
    const result = await next.json();
    const policy = await admin.query(`SELECT policy.policy_kind FROM events event JOIN visibility_policies policy
      ON policy.workspace_id=event.workspace_id AND policy.id=event.visibility_policy_id WHERE event.id=$1`, [result.data.eventId]);
    assert.deepEqual(policy.rows, [{ policy_kind: 'dm_only' }]);
    const publicContext = await loadRecordGoalNarrativeContext(admin, { scope, principalId: POSTGRES_DEMO_IDS.principal });
    assert.equal(JSON.parse(publicContext.document).goals.length, 1);
    assert.equal(JSON.parse(publicContext.document).goals[0].title, 'A publicly known successor');
    assert.equal(publicContext.document.includes(created.data.goalInstanceId), false, 'A public successor must not reveal a hidden predecessor identity');
    const { loadRecordGoalProjection } = await import('../modules/application/record-goal-projection.ts');
    const projection = await loadRecordGoalProjection(admin, { scope });
    assert.equal(projection.goals[0]!.supersedesInstanceId, null, 'GET/SSE must not disclose the hidden predecessor through a public successor link');
  } finally { await endSharedRuntimePools(); await admin.end(); }
});

test('worker definition resolution loads the immutable Record binding without a content package or fallback', options, async () => {
  const { POST } = await import('../app/api/record/goals/commands/route.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const { createRecordGoalDefinitionResolver } = await import('../modules/application/record-goal-definition.ts');
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 1 });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL!, max: 1 });
  try {
    const scope = await fixture(admin);
    const response = await POST(commandRequest(scope.recordId, {}, `resolve-${randomUUID()}`));
    assert.equal(response.status,201);
    const created = await response.json();
    const row = (await admin.query(`SELECT goal_key,policy_version FROM goal_instances WHERE id=$1`,[created.data.goalInstanceId])).rows[0];
    let contentCalls = 0;
    const resolve = createRecordGoalDefinitionResolver(runtime, { resolveContentDefinition: async () => { contentCalls++; return null; } });
    const job = { ...scope, worldVersion: '0.0.0-local', goalInstanceId: created.data.goalInstanceId,
      goalKey: row.goal_key, jobId: `job-${randomUUID()}`, sourceEventId: created.data.eventId,
      attemptCount: 1, leaseOwner: 'resolver-probe', leaseExpiresAt: new Date(Date.now()+30_000).toISOString() };
    const original = await resolve(job);
    assert.equal(original?.policyVersion,row.policy_version);
    assert.deepEqual((original as unknown as {draft:unknown}).draft,draft);
    const revised = await POST(commandRequest(scope.recordId, { operation: 'revise', expectedHead: { recordVersion:1,ordinal:1 },
      goalInstanceId:job.goalInstanceId,expectedDefinitionVersion:1,expectedInstanceRevision:1,reason:'A new direction',
      draft:{...draft,title:'The next direction'} }, `next-${randomUUID()}`));
    assert.equal(revised.status,200);
    assert.deepEqual(await resolve(job),original,'a queued predecessor never resolves to its successor definition');
    for (const field of ['workspaceId','worldId','worldlineId','recordId','goalInstanceId','goalKey','worldVersion'] as const) {
      await assert.rejects(resolve({...job,[field]:'different'}), /Goal|Record/);
    }
    assert.equal(contentCalls,0,'missing/mismatched authored bindings must not fall back to package content');
  } finally { await endSharedRuntimePools(); await runtime.end(); await admin.end(); }
});

test('native Goal export API writes a real archive and restore API retains definitions, history and authority in a new scope',options,async()=>{
  const commands=await import('../app/api/record/goals/commands/route.ts');
  const save=await import('../app/api/record/save/route.ts');
  const restore=await import('../app/api/record/restore/route.ts');
  const {parseRealmRuntimeSaveArchive}=await import('../modules/world-transfer/realm-runtime-save.ts');
  const {endSharedRuntimePools}=await import('../app/api/world-scope.ts');
  const {mkdtemp,writeFile,readFile,rm,mkdir}=await import('node:fs/promises');
  const {join}=await import('node:path');const {homedir}=await import('node:os');
  const scratch=process.env.TMPDIR || join(homedir(),'.hermes/cache/scratch');await mkdir(scratch,{recursive:true});
  const directory=await mkdtemp(join(scratch,'realm-goal-archive-'));
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL!,max:1});
  const cookie=`realm_session=${sessionProofFor(POSTGRES_DEMO_IDS.principal)}`;
  try {
    const scope=await fixture(admin);
    const fixed=await commands.POST(commandRequest(scope.recordId,{draft:{...draft,changePolicy:'fixed'}},'save.fixed'));
    assert.equal(fixed.status,201);const fixedBody=await fixed.json();
    const evolving=await commands.POST(commandRequest(scope.recordId,{expectedHead:{recordVersion:1,ordinal:1}},'save.evolving'));
    assert.equal(evolving.status,201);const evolvingBody=await evolving.json();
    const revision=await commands.POST(commandRequest(scope.recordId,{operation:'revise',expectedHead:{recordVersion:2,ordinal:2},
      goalInstanceId:evolvingBody.data.goalInstanceId,expectedDefinitionVersion:1,expectedInstanceRevision:1,
      reason:'A revised delivery direction',draft:{...draft,title:'Find the recipient at the northern gate'}},'save.revise'));
    assert.equal(revision.status,200);
    const withdrawn=await commands.POST(commandRequest(scope.recordId,{operation:'withdraw',draft:undefined,expectedHead:{recordVersion:3,ordinal:3},
      goalInstanceId:fixedBody.data.goalInstanceId,expectedDefinitionVersion:1,expectedInstanceRevision:1,
      reason:'The player explicitly withdraws this fixed direction'},'save.withdraw'));
    assert.equal(withdrawn.status,200);
    const {emptyNarrativeState,planNarrativeConsequence}=await import('../modules/application/narrative-situation.ts');
    const {applyCommittedNarrativeState}=await import('../database/postgres/narrative-situation-repository.ts');
    let situation=emptyNarrativeState();
    for(const [version,status,fact] of [[5,'active','A patrol blocks the gate.'],[6,'resolved','The patrol has left; the gate is clear.']] as const) {
      const eventId=`save-narration-${version}-${randomUUID()}`;
      const next=planNarrativeConsequence({scope,previous:situation,expectedRevision:situation.revision,sourceEventId:eventId,
        observedHead:{recordVersion:version-1,ordinal:version-1},sourceRole:'narrator',turnKind:'player',
        committedEventIds:situation.lastEventId?[situation.lastEventId]:[],timeAdvanceAuthorized:false,
        proposal:{changes:[{situationId:situation.situations[0]?.id??null,status,fact,obstacle:status==='active'?'The patrol':null,
          unknowns:[],exitConditions:[],basisEventIds:situation.lastEventId?[situation.lastEventId]:[],playerActions:[]}],elapsedMinutes:0}})!;
      await withWorkspaceTransaction(admin,scope.workspaceId,async client=>{
        await client.query(`INSERT INTO events SELECT (jsonb_populate_record(NULL::events,to_jsonb(source)||$1::jsonb)).*
          FROM events source WHERE workspace_id=$2 AND id=$3`,[JSON.stringify({id:eventId,event_kind:'narration.committed',
          record_version:version,record_ordinal:version,world_ordinal:version,content:fact,actor_participant_id:null,
          payload:{__realmRuntimePayload:{schemaVersion:1,role:'narrator',content:fact,narrativeState:next}}}),scope.workspaceId,fixedBody.data.eventId]);
        await client.query(`UPDATE record_heads SET record_version=$3::bigint,next_record_ordinal=($3::bigint)+1,last_event_id=$4,last_world_ordinal=$3::bigint
          WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,scope.recordId,version,eventId]);
        await client.query(`UPDATE worldlines SET head_ordinal=$3 WHERE workspace_id=$1 AND id=$2`,[scope.workspaceId,scope.worldlineId,version]);
        await applyCommittedNarrativeState(client,{scope,sourceEventId:eventId,expectedRevision:situation.revision});
      });
      situation=next;
    }
    const activeSource=(await (await commands.GET(new Request(`http://localhost/api/record/goals/commands?recordId=${scope.recordId}`,{headers:{cookie}}))).json()).data.goals.find((goal:{state:string})=>goal.state==='active');
    const workerPool=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
    const {createPostgresGoalAssessmentJobQueue}=await import('../database/postgres/goal-assessment-job-queue.ts');
    const {createRecordGoalDefinitionResolver}=await import('../modules/application/record-goal-definition.ts');
    const {runGoalAssessmentOnce}=await import('../modules/goals/assessment-worker.ts');
    const {createModelGoalJudge}=await import('../modules/goals/model-judge.ts');
    const progress={summary:'The patrol left; the named recipient has not yet been reached.'};
    try {
      const queue=createPostgresGoalAssessmentJobQueue({pool:workerPool,workspaceId:scope.workspaceId,leaseOwner:`archive-${randomUUID()}`});
      await queue.enqueue({...scope,jobId:`archive-${randomUUID()}`,goalInstanceId:activeSource.goalInstanceId,sourceEventId:situation.lastEventId!});
      const judge=createModelGoalJudge({getGateway:async()=>({providerId:'lmstudio',async discoverModels(){return[];},async chat(){
        return {model:'deterministic-archive-test-fixture',content:JSON.stringify({decision:'continue',evidenceEventIds:[situation.lastEventId],progress,outcome:null}),toolCalls:[],finishReason:'stop',usage:null};
      }})});
      assert.deepEqual(await runGoalAssessmentOnce({repository:queue,resolveDefinition:createRecordGoalDefinitionResolver(workerPool),judge,now:new Date().toISOString()}),{kind:'settled',status:'accepted'});
    } finally {await workerPool.end();}
    const source=await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 ORDER BY definition_version,id',[scope.workspaceId,scope.recordId]);
    const response=await save.POST(new Request('http://localhost/api/record/save',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({recordId:scope.recordId})}));
    assert.equal(response.status,200,await response.clone().text());
    const file=join(directory,'record.realm');await writeFile(file,new Uint8Array(await response.arrayBuffer()));
    const bytes=await readFile(file);const archive=parseRealmRuntimeSaveArchive(bytes);
    assert.equal(archive.goals.definitions?.length,3,'the production export includes every immutable definition');
    assert.equal(archive.goals.instances.length,3);
    assert.equal(archive.goals.assessments.length,1,'native assessment history is part of the actual ZIP, not just an in-memory contract');
    const request=()=>new Request('http://localhost/api/record/restore',{method:'POST',headers:{cookie,
      'content-type':'application/vnd.realm.save+zip','x-realm-target-world':scope.worldId,'idempotency-key':'native-goal-restore'},body:bytes});
    await withWorkspaceTransaction(admin,scope.workspaceId,client=>client.query(`UPDATE player_world_memberships SET role='player' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`,[scope.workspaceId,scope.worldId,POSTGRES_DEMO_IDS.principal]));
    const deniedSave=await save.POST(new Request('http://localhost/api/record/save',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({recordId:scope.recordId})}));
    assert.equal(deniedSave.status,403,'a player cannot read private archive definitions via an owner-only backup operation');
    const deniedRestore=await restore.POST(request());assert.equal(deniedRestore.status,403);
    await withWorkspaceTransaction(admin,scope.workspaceId,client=>client.query(`UPDATE player_world_memberships SET role='owner' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`,[scope.workspaceId,scope.worldId,POSTGRES_DEMO_IDS.principal]));
    const imported=await restore.POST(request());

    assert.equal(imported.status,201,await imported.clone().text());
    const target=await imported.json();assert.notEqual(target.recordId,scope.recordId);
    const read=await commands.GET(new Request(`http://localhost/api/record/goals/commands?recordId=${target.recordId}`,{headers:{cookie}}));
    assert.equal(read.status,200);const snapshot=(await read.json()).data;
    assert.equal(snapshot.goals.length,3);
    assert.equal(snapshot.goals.filter((goal:{resolutionKind:string})=>goal.resolutionKind==='withdrawn').length,1);
    assert.equal(snapshot.goals.filter((goal:{resolutionKind:string})=>goal.resolutionKind==='superseded').length,1);
    assert.equal(snapshot.goals.filter((goal:{state:string})=>goal.state==='active').length,1);
    assert.deepEqual((await admin.query(`SELECT progress FROM goal_instances WHERE workspace_id=$1 AND record_id=$2 AND state='active'`,[scope.workspaceId,target.recordId])).rows,[{progress}]);
    const restoredAssessment=(await admin.query(`SELECT assessment.evidence_event_ids,assessment.source_event_id,assessment.policy_version,goal.policy_version AS bound_policy
      FROM goal_assessments assessment JOIN goal_instances goal ON goal.workspace_id=assessment.workspace_id AND goal.id=assessment.goal_instance_id
      WHERE assessment.workspace_id=$1 AND assessment.record_id=$2`,[scope.workspaceId,target.recordId])).rows;
    assert.equal(restoredAssessment.length,1);assert.equal(restoredAssessment[0].policy_version,restoredAssessment[0].bound_policy);
    assert.deepEqual(restoredAssessment[0].evidence_event_ids,[restoredAssessment[0].source_event_id]);
    assert.notEqual(restoredAssessment[0].source_event_id,situation.lastEventId);
    const definitions=await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,target.recordId]);
    assert.equal(definitions.rows.length,3);
    for(const {definition} of definitions.rows){assert.equal(definition.scope.recordId,target.recordId);assert.equal(definition.scope.worldlineId,target.worldlineId);}
    const {loadRecordNarrativeState}=await import('../database/postgres/narrative-situation-repository.ts');
    const restoredSituation=await withWorkspaceTransaction(admin,scope.workspaceId,client=>loadRecordNarrativeState(client,{...scope,recordId:target.recordId,worldlineId:target.worldlineId}));
    assert.equal(restoredSituation.scope?.recordId,target.recordId);assert.equal(restoredSituation.situations[0].status,'resolved');
    assert.equal(restoredSituation.situations[0].fact,situation.situations[0].fact);
    const history=JSON.stringify((await admin.query('SELECT payload FROM events WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,target.recordId])).rows);
    assert.equal(history.includes(fixedBody.data.goalInstanceId),false,'Goal transition identities must be rebased, not borrowed from the source');
    assert.deepEqual((await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 ORDER BY definition_version,id',[scope.workspaceId,scope.recordId])).rows,source.rows,'the source history is immutable');
    const replay=await restore.POST(request());assert.equal(replay.status,200);assert.equal((await replay.json()).recordId,target.recordId);
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM goal_assessment_jobs WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,target.recordId])).rows[0].count,0,'restore never resurrects source leases or assessment jobs');
    await withWorkspaceTransaction(admin,scope.workspaceId,client=>client.query(`UPDATE worlds SET world_version='9.9.9' WHERE workspace_id=$1 AND id=$2`,[scope.workspaceId,scope.worldId]));
    const branch=await import('../app/api/record/branch/route.ts');
    const branchRequest=()=>new Request('http://localhost/api/record/branch',{method:'POST',headers:{cookie,'content-type':'application/json'},
      body:JSON.stringify({recordId:scope.recordId,idempotencyKey:'native-goal-branch',recordTitle:'A separate delivery route'})});
    const branches=await Promise.all([branch.POST(branchRequest()),branch.POST(branchRequest())]);
    assert.deepEqual(branches.map(response=>response.status).sort(),[200,201],JSON.stringify(await Promise.all(branches.map(response=>response.clone().json()))));
    const branchTarget=await branches[0].json();const branchReplayBody=await branches[1].json();
    assert.equal(branchReplayBody.recordId,branchTarget.recordId);
    assert.deepEqual(branchTarget.fork,branchReplayBody.fork,'exact branch replay preserves its actual fork');
    const forkRows=(await admin.query(`SELECT record.start_tick::text,record.start_ordinal::text,line.fork_tick::text,line.fork_ordinal::text
      FROM records record JOIN worldlines line ON line.workspace_id=record.workspace_id AND line.id=record.worldline_id
      WHERE record.workspace_id=$1 AND record.id=$2`,[scope.workspaceId,branchTarget.recordId])).rows[0];
    assert.deepEqual([forkRows.start_tick,forkRows.start_ordinal],[forkRows.fork_tick,forkRows.fork_ordinal]);
    assert.deepEqual(branchTarget.fork,{tick:Number(forkRows.fork_tick),ordinal:Number(forkRows.fork_ordinal)});
    const metadata=(await admin.query(`SELECT record.timeline_kind,record.linked_record_id,record.world_version,line.parent_worldline_id,story.premise
      FROM records record JOIN worldlines line ON line.workspace_id=record.workspace_id AND line.id=record.worldline_id
      JOIN stories story ON story.workspace_id=record.workspace_id AND story.id=record.story_id WHERE record.workspace_id=$1 AND record.id=$2`,[scope.workspaceId,branchTarget.recordId])).rows[0];
    const origin=(await admin.query(`SELECT record.world_version,story.premise FROM records record JOIN stories story
      ON story.workspace_id=record.workspace_id AND story.id=record.story_id WHERE record.workspace_id=$1 AND record.id=$2`,[scope.workspaceId,scope.recordId])).rows[0];
    assert.deepEqual(metadata,{timeline_kind:'branch',linked_record_id:scope.recordId,world_version:origin.world_version,parent_worldline_id:scope.worldlineId,premise:origin.premise});
    const branchAssessments=(await admin.query(`SELECT assessment.evidence_event_ids,assessment.source_event_id,assessment.policy_version,goal.policy_version AS bound_policy
      FROM goal_assessments assessment JOIN goal_instances goal ON goal.workspace_id=assessment.workspace_id AND goal.id=assessment.goal_instance_id
      WHERE assessment.workspace_id=$1 AND assessment.record_id=$2`,[scope.workspaceId,branchTarget.recordId])).rows;
    assert.equal(branchAssessments.length,1);assert.equal(branchAssessments[0].policy_version,branchAssessments[0].bound_policy);
    assert.deepEqual(branchAssessments[0].evidence_event_ids,[branchAssessments[0].source_event_id]);
    assert.notEqual(branchAssessments[0].source_event_id,situation.lastEventId);
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM goal_assessment_jobs WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,branchTarget.recordId])).rows[0].count,0,'branch creation copies immutable assessments, not operational jobs or leases');
    const historical=await branch.POST(new Request('http://localhost/api/record/branch',{method:'POST',headers:{cookie,'content-type':'application/json'},
      body:JSON.stringify({recordId:scope.recordId,idempotencyKey:'native-goal-historical-branch',fork:{worldTick:0,worldOrdinal:0}})}));
    assert.equal(historical.status,409);assert.equal((await historical.json()).error.code,'BRANCH_GOAL_STATE_UNAVAILABLE');
    const resumedPool=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
    try {
      for(const continuedTarget of [target,branchTarget]) {
      const {createPostgresRuntimeRepository,createPostgresDeliveryProjectionRepository,createPostgresRecordRuntimeScopeRepository}=await import('../database/postgres/public.ts');
      const {createLocalRecordService,mapLocalFormalEvent}=await import('../modules/application/local-record-service.ts');
      const {createLocalM2TurnOrchestrator}=await import('../modules/orchestration/public.ts');
      const {createRecordGoalContextScopeRepository}=await import('../modules/application/record-goal-projection.ts');
      const scopes=createRecordGoalContextScopeRepository(resumedPool,createPostgresRecordRuntimeScopeRepository(resumedPool));
      let resumedNarratorCalls=0;
      const submittedEvidence:string[]=[];
      const activeDestination=(await admin.query(`SELECT id FROM goal_instances WHERE workspace_id=$1 AND record_id=$2 AND state='active'`,[scope.workspaceId,continuedTarget.recordId])).rows;
      assert.equal(activeDestination.length,1);
      const service=createLocalRecordService({workspaceId:scope.workspaceId,
        repository:createPostgresRuntimeRepository({pool:resumedPool,workspaceId:scope.workspaceId,mapFormalEvent:mapLocalFormalEvent,
          onFormalEventsCommitted:async(client,committed)=>{const {reconcileGoalAssessmentJobsForCommittedEvents}=await import('../database/postgres/goal-runtime-materialization.ts');
            assert.equal(committed.recordId,continuedTarget.recordId);submittedEvidence.push(...committed.eventIds);
            await reconcileGoalAssessmentJobsForCommittedEvents(client,committed);}}),
        projection:createPostgresDeliveryProjectionRepository(resumedPool),runtimeScopeProvider:scopes,
        orchestratorFactory:current=>{
          assert.equal(current.recordId,continuedTarget.recordId);
          const narrative=JSON.parse(current.brief.narrativeState!);
          assert.equal(narrative.situations[0].status,'resolved');assert.equal(narrative.scope.recordId,continuedTarget.recordId);
          const directions=JSON.parse(current.brief.recordGoals!);
          assert.deepEqual(directions.goals.find((goal:{state:string})=>goal.state==='active').progress,progress);
          return createLocalM2TurnOrchestrator({characters:[],narrator:{async narrate(){resumedNarratorCalls++;
            const content='The gate remains clear. The sealed letter is still awaiting delivery.';
            return {speaker:'Narrator',participantId:null,characterInstanceId:null,content,
              segments:[{id:'resumed-environment',kind:'environment',content,speechMode:'none'}]};
          }}});
        }});
      const envelope=await service.loadRecord(continuedTarget.recordId);
      const command={recordId:continuedTarget.recordId,content:'I check the open gate without handing over the letter.',idempotencyKey:'restored-turn',writeToken:envelope.writeToken};
      assert.equal((await service.submitMessage(command)).disposition,'committed');
      assert.equal((await service.submitMessage(command)).disposition,'duplicate');
      assert.equal(resumedNarratorCalls,1);
      assert.ok(submittedEvidence.length>0);
      assert.deepEqual((await admin.query(`SELECT goal_instance_id,source_event_id FROM goal_assessment_jobs
        WHERE workspace_id=$1 AND record_id=$2 ORDER BY source_event_id`,[scope.workspaceId,continuedTarget.recordId])).rows,
        submittedEvidence.sort().map(source_event_id=>({goal_instance_id:activeDestination[0].id,source_event_id})),
        'new jobs are exactly the destination active Goal × newly committed formal evidence; no source or terminal Goal jobs');
      assert.equal((await withWorkspaceTransaction(resumedPool,scope.workspaceId,client=>loadRecordNarrativeState(client,{...scope,recordId:continuedTarget.recordId,worldlineId:continuedTarget.worldlineId}))).situations[0].status,'resolved');
      const beforeSource=await admin.query('SELECT record_version FROM record_heads WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,scope.recordId]);
      assert.equal(Number(beforeSource.rows[0].record_version),archive.record.head.recordVersion,'the resumed target cannot write to its source');
      }
    } finally {await resumedPool.end();}
    const branchView=await commands.GET(new Request(`http://localhost/api/record/goals/commands?recordId=${branchTarget.recordId}`,{headers:{cookie}}));
    assert.equal(branchView.status,200,await branchView.clone().text());
    const branchSnapshot=(await branchView.json()).data;
    assert.equal(branchSnapshot.goals.length,3,'a branch must retain authored definitions, not silently relabel them as package goals');
    const branchSituation=await withWorkspaceTransaction(admin,scope.workspaceId,client=>loadRecordNarrativeState(client,{...scope,recordId:branchTarget.recordId,worldlineId:branchTarget.worldlineId}));
    assert.equal(branchSituation.situations[0].status,'resolved');assert.equal(branchSituation.scope?.recordId,branchTarget.recordId);
    const activeBranch=branchSnapshot.goals.find((goal:{state:string})=>goal.state==='active');
    const branchRevision=await commands.POST(commandRequest(branchTarget.recordId,{operation:'revise',expectedHead:branchSnapshot.head,
      goalInstanceId:activeBranch.goalInstanceId,expectedDefinitionVersion:activeBranch.definitionVersion,expectedInstanceRevision:activeBranch.revision,
      reason:'Only this branch takes the western route',draft:{...draft,title:'Take the western delivery route'}},'native.branch.revise'));
    assert.equal(branchRevision.status,200,await branchRevision.clone().text());
    assert.deepEqual((await admin.query('SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2 ORDER BY definition_version,id',[scope.workspaceId,scope.recordId])).rows,source.rows);
    const branchReplay=await branch.POST(branchRequest());assert.equal(branchReplay.status,200);assert.equal((await branchReplay.json()).recordId,branchTarget.recordId);
  } finally {await endSharedRuntimePools();await admin.end();await rm(directory,{recursive:true,force:true});}
});

test('a Goal-free Record branch retains resolved formal narrative state instead of replaying its opening threat',options,async()=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const {endSharedRuntimePools}=await import('../app/api/world-scope.ts');
  try {
    const scope=await fixture(admin);
    const {emptyNarrativeState,planNarrativeConsequence}=await import('../modules/application/narrative-situation.ts');
    const {applyCommittedNarrativeState,loadRecordNarrativeState}=await import('../database/postgres/narrative-situation-repository.ts');
    let state=emptyNarrativeState();
    for(const [version,status,fact] of [[1,'active','A patrol blocks the gate.'],[2,'resolved','The patrol has left; the gate is clear.']] as const) {
      const eventId=`no-goal-narration-${randomUUID()}`;
      const next=planNarrativeConsequence({scope,previous:state,expectedRevision:state.revision,sourceEventId:eventId,
        observedHead:{recordVersion:version-1,ordinal:version-1},sourceRole:'narrator',turnKind:'player',
        committedEventIds:state.lastEventId?[state.lastEventId]:[],timeAdvanceAuthorized:false,
        proposal:{changes:[{situationId:state.situations[0]?.id??null,status,fact,obstacle:status==='active'?'The patrol':null,
          unknowns:[],exitConditions:[],basisEventIds:state.lastEventId?[state.lastEventId]:[],playerActions:[]}],elapsedMinutes:0}})!;
      await withWorkspaceTransaction(admin,scope.workspaceId,async client=>{
        const scene=(await client.query('SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2 LIMIT 1',[scope.workspaceId,scope.recordId])).rows[0].id;
        const policy=(await client.query('SELECT id FROM visibility_policies WHERE workspace_id=$1 AND record_id=$2 LIMIT 1',[scope.workspaceId,scope.recordId])).rows[0].id;
        const inserted=await client.query(`INSERT INTO events SELECT (jsonb_populate_record(NULL::events,to_jsonb(source)||$1::jsonb)).*
          FROM events source WHERE workspace_id=$2 AND record_id=$3 LIMIT 1`,[JSON.stringify({workspace_id:scope.workspaceId,world_id:scope.worldId,
          worldline_id:scope.worldlineId,record_id:scope.recordId,scene_id:scene,visibility_policy_id:policy,id:eventId,event_kind:'narration.committed',
          record_version:version,record_ordinal:version,world_tick:0,world_ordinal:version,content:fact,actor_participant_id:null,
          payload:{__realmRuntimePayload:{schemaVersion:1,role:'narrator',content:fact,narrativeState:next}}}),scope.workspaceId,POSTGRES_DEMO_IDS.record]);
        assert.equal(inserted.rowCount,1);
        await client.query(`UPDATE record_heads SET record_version=$3::bigint,next_record_ordinal=$3::bigint+1,last_event_id=$4,last_world_tick=0,last_world_ordinal=$3::bigint
          WHERE workspace_id=$1 AND record_id=$2`,[scope.workspaceId,scope.recordId,version,eventId]);
        await client.query('UPDATE worldlines SET head_ordinal=$3 WHERE workspace_id=$1 AND id=$2',[scope.workspaceId,scope.worldlineId,version]);
        await applyCommittedNarrativeState(client,{scope,sourceEventId:eventId,expectedRevision:state.revision});
      });
      state=next;
    }
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM goal_instances WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,scope.recordId])).rows[0].count,0);
    const {POST}=await import('../app/api/record/branch/route.ts');
    const response=await POST(new Request('http://localhost/api/record/branch',{method:'POST',headers:{'content-type':'application/json',
      cookie:`realm_session=${sessionProofFor(POSTGRES_DEMO_IDS.principal)}`},body:JSON.stringify({recordId:scope.recordId,idempotencyKey:'goal-free-narrative-branch'})}));
    assert.equal(response.status,201,await response.clone().text());const target=await response.json();
    const inherited=await withWorkspaceTransaction(admin,scope.workspaceId,client=>loadRecordNarrativeState(client,{...scope,recordId:target.recordId,worldlineId:target.worldlineId}));
    assert.equal(inherited.situations[0]?.status,'resolved');assert.equal(inherited.scope?.recordId,target.recordId);
    assert.equal((await admin.query('SELECT record_version FROM record_heads WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,scope.recordId])).rows[0].record_version,'2');
  } finally {await endSharedRuntimePools();await admin.end();}
});

test('restore capabilities reject direct runtime append, missing admissions and proof reservations without a new Record',options,async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const runtimePool=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  t.after(async()=>{await runtimePool.end();await admin.end();});
  const scope=await fixture(admin);
  for(const signature of ['record_goal_restore_prepare(text,text,text,text,text,text)','record_goal_restore_definitions(text,text,text,jsonb)','record_goal_branch_prepare(text,text,text,text,text,bigint)']) {
    const catalog=(await admin.query(`SELECT p.prosecdef,has_function_privilege('realm_runtime',p.oid,'EXECUTE') AS runtime_execute,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute,
      owner.rolcanlogin,owner.rolsuper,owner.rolbypassrls FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature])).rows[0];
    assert.deepEqual(catalog,{prosecdef:true,runtime_execute:true,public_execute:false,rolcanlogin:false,rolsuper:false,rolbypassrls:false});
  }
  assert.equal((await admin.query(`SELECT has_table_privilege('realm_runtime','record_goal_restore_admissions','INSERT') AS allowed`)).rows[0].allowed,false);
  await assert.rejects(withWorkspaceTransaction(runtimePool,scope.workspaceId,client=>client.query('INSERT INTO record_goal_restore_admissions DEFAULT VALUES')),{code:'42501'});
  await assert.rejects(withWorkspaceTransaction(runtimePool,scope.workspaceId,client=>client.query('SELECT record_goal_restore_definitions($1,$2,$3,$4::jsonb)',
    [scope.workspaceId,sessionProofFor(POSTGRES_DEMO_IDS.principal),scope.recordId,'[]'])),/GOAL_RESTORE_PROOF_REQUIRED/);
  const {createHash}=await import('node:crypto');const token=randomUUID().replaceAll('-','').slice(0,24);
  const recordId=`record_restore_${token}`,worldlineId=`worldline_restore_${token}`;
  const branchToken=token.slice(0,18);const branchHash=createHash('sha256').update('isolated branch fixture').digest('hex');
  await assert.rejects(withWorkspaceTransaction(runtimePool,scope.workspaceId,client=>client.query('SELECT record_goal_branch_prepare($1,$2,$3,$4,$5,$6)',
    [scope.workspaceId,'forged',scope.recordId,branchToken,branchHash,0])));
  await assert.rejects(withWorkspaceTransaction(runtimePool,scope.workspaceId,client=>client.query('SELECT record_goal_branch_prepare($1,$2,$3,$4,$5,$6)',
    [scope.workspaceId,sessionProofFor(POSTGRES_DEMO_IDS.principal),scope.recordId,branchToken,branchHash,1])),/GOAL_BRANCH_HEAD_CHANGED/);
  await assert.rejects(withWorkspaceTransaction(runtimePool,scope.workspaceId,client=>client.query('SELECT record_goal_branch_prepare($1,$2,$3,$4,$5,$6)',
    [scope.workspaceId,sessionProofFor(POSTGRES_DEMO_IDS.principal),scope.recordId,branchToken,branchHash,0])),{code:'23503'});
  await withWorkspaceTransaction(admin,scope.workspaceId,client=>client.query(`UPDATE player_world_memberships SET role='player' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`,[scope.workspaceId,scope.worldId,POSTGRES_DEMO_IDS.principal]));
  await assert.rejects(withWorkspaceTransaction(runtimePool,scope.workspaceId,client=>client.query('SELECT record_goal_branch_prepare($1,$2,$3,$4,$5,$6)',
    [scope.workspaceId,sessionProofFor(POSTGRES_DEMO_IDS.principal),scope.recordId,branchToken,branchHash,0])),/GOAL_BRANCH_PROOF_REQUIRED/);
  await withWorkspaceTransaction(admin,scope.workspaceId,client=>client.query(`UPDATE player_world_memberships SET role='owner' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`,[scope.workspaceId,scope.worldId,POSTGRES_DEMO_IDS.principal]));
  await assert.rejects(withWorkspaceTransaction(runtimePool,scope.workspaceId,client=>client.query('SELECT record_goal_restore_prepare($1,$2,$3,$4,$5,$6)',
    [scope.workspaceId,sessionProofFor(POSTGRES_DEMO_IDS.principal),scope.worldId,worldlineId,recordId,createHash('sha256').update('isolated capability fixture').digest('hex')])),{code:'23503'});
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM record_goal_restore_admissions WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,recordId])).rows[0].count,0,
    'a reservation cannot survive in another transaction without materializing its brand-new Record');
});

test('runtime backup is one immutable snapshot even when another owner commits a Goal during export',options,async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});
  const runtimePool=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  const {endSharedRuntimePools}=await import('../app/api/world-scope.ts');
  t.after(async()=>{await endSharedRuntimePools();await runtimePool.end();await admin.end();});
  const scope=await fixture(admin);
  const api=await import('../app/api/record/goals/commands/route.ts');
  const initial=await api.POST(commandRequest(scope.recordId,{operation:'create',recordId:scope.recordId,
    expectedHead:{recordVersion:0,ordinal:0},draft},'snapshot.first'));
  assert.equal(initial.status,201);
  let interleaved=false;
  const wrapped=new Proxy(runtimePool,{get(pool,key){
    if(key!=='connect'){const member=Reflect.get(pool,key);return typeof member==='function'?member.bind(pool):member;}
    return async()=>{const client=await pool.connect();return new Proxy(client,{get(connection,property){
      if(property!=='query'){const member=Reflect.get(connection,property);return typeof member==='function'?member.bind(connection):member;}
      return async(...args:unknown[])=>{
        const result=await Reflect.apply(connection.query,connection,args);
        if(!interleaved&&typeof args[0]==='string'&&/FROM events\s+WHERE workspace_id/.test(args[0])){
          interleaved=true;
          const concurrent=await api.POST(commandRequest(scope.recordId,{operation:'create',recordId:scope.recordId,
            expectedHead:{recordVersion:1,ordinal:1},draft:{...draft,title:'A concurrent second Goal'}},'snapshot.concurrent'));
          assert.equal(concurrent.status,201,await concurrent.clone().text());
        }
        return result;
      };
    }});};
  }});
  const {createPostgresRealmRuntimeSaveReader}=await import('../database/postgres/realm-runtime-save-repository.ts');
  const archive=await createPostgresRealmRuntimeSaveReader(wrapped).load({workspaceId:scope.workspaceId,recordId:scope.recordId,principalId:POSTGRES_DEMO_IDS.principal,purpose:"record-export"});
  assert.equal(interleaved,true,'the concurrent write really happened between archive reads');
  assert.equal(archive!.goals.instances.length,1,'backup must not mix the old record head with new Goal definitions');
  assert.equal(archive!.goals.definitions!.length,1);
  assert.equal(archive!.record.events.length,1);
  const source=await admin.query('SELECT record_version FROM record_heads WHERE workspace_id=$1 AND record_id=$2',[scope.workspaceId,scope.recordId]);
  assert.equal(Number(source.rows[0].record_version),2,'source commit is independent of the frozen backup');
});
