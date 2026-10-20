/** AUTHORED ONLY in development batch 19. Do not run during development.
 * Centralized acceptance must use the existing disposable PG runner. Real
 * runtime-role/RLS plans and server work cannot be inferred from pure doubles.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { evidenceHeaderSql,evidenceBodySql } from "../database/postgres/runtime-evidence-resource-reader.ts";
import { POSTGRES_DEMO_IDS, withWorkspaceTransaction } from "../database/postgres/public.ts";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
async function fixture(t: test.TestContext, count = 1, receiptShape: "default" | "long-decimal" | "overflow" = "default") {
    assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith('realm'), 'authorized disposable runner required');
    assert.ok(process.env.DATABASE_URL && process.env.REALM_RUNTIME_DATABASE_URL);
    const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    t.after(() => owner.end());
    const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 1 });
    t.after(() => runtime.end());
    const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: `evidence_world_${randomUUID()}`, worldlineId: `evidence_line_${randomUUID()}`, recordId: `evidence_record_${randomUUID()}` };
    const storyId = `evidence_story_${randomUUID()}`;
    const text=Array.from({length:16384},(_,i)=>createHash('sha256').update('n3.'+i).digest('hex')).join('');
    await withWorkspaceTransaction(owner, scope.workspaceId, async (client) => {
        const clone = async (table: string, predicate: string, sourceId: string, patch: object) => {
            const result = await client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`, [JSON.stringify(patch), scope.workspaceId, sourceId]);
            assert.equal(result.rowCount, 1, `fixture ${table}`);
        };
        const scoped = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId };
        await clone("worlds", "id", POSTGRES_DEMO_IDS.world, { id: scope.worldId, name: "Evidence bounded resources" });
        await clone("worldlines", "id", POSTGRES_DEMO_IDS.worldline, { id: scope.worldlineId, world_id: scope.worldId, head_tick: 0, head_ordinal: 0 });
        await clone("stories", "id", POSTGRES_DEMO_IDS.story, { ...scoped, id: storyId, start_tick: 0, start_ordinal: 0 });
        await clone("records", "id", POSTGRES_DEMO_IDS.record, { ...scoped, id: scope.recordId, story_id: storyId, status: "active", start_tick: 0, start_ordinal: 0 });
        await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')", [scope.workspaceId, scope.worldId, POSTGRES_DEMO_IDS.principal]);
        await clone("character_definitions", "id", POSTGRES_DEMO_IDS.scoutDefinition, { workspace_id: scope.workspaceId, world_id: scope.worldId, id: scope.recordId + '.definition' });
        await clone("character_continuities", "id", POSTGRES_DEMO_IDS.scoutContinuity, { ...scoped, id: scope.recordId + '.continuity', definition_id: scope.recordId + '.definition', continuity_key: 'topology', born_tick: 0, born_ordinal: 0, ended_tick: null, ended_ordinal: null });
        await clone("character_instances", "id", POSTGRES_DEMO_IDS.scoutInstance, { ...scoped, id: scope.recordId + '.instance', continuity_id: scope.recordId + '.continuity', predecessor_instance_id: null, instantiated_tick: 0, instantiated_ordinal: 0, inheritance_cutoff_tick: 0, inheritance_cutoff_ordinal: 0, retired_tick: null, retired_ordinal: null, state: {} });
        await client.query(`INSERT INTO participants(workspace_id,world_id,worldline_id,record_id,id,participant_kind,character_instance_id,controller_mode,speaking_order)
          VALUES($1,$2,$3,$4,$4||'.participant','character',$4||'.instance','ai',0)`,Object.values(scope));
        await clone("scenes","id",POSTGRES_DEMO_IDS.scene,{...scoped,id:scope.recordId+'.scene',start_tick:0,start_ordinal:0,end_tick:null,end_ordinal:null});
        await client.query(`INSERT INTO visibility_policies(workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_version,policy_kind)
          VALUES($1,$2,$3,$4,$4||'.policy','public',1,'public')`,Object.values(scope));
        await client.query(`INSERT INTO events(workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,content,visibility_policy_id,world_tick,world_ordinal,calendar_id)
          VALUES($1,$2,$3,$4,$4||'.scene',$4||'.event',1,0,0,'narration.committed','Evidence event',$4||'.policy',0,0,'calendar')`,Object.values(scope));
        await clone("record_heads", "record_id", POSTGRES_DEMO_IDS.record, { ...scoped, record_version: 1, next_record_ordinal: 1, last_event_id: scope.recordId + ".event", last_world_tick: 0, last_world_ordinal: 0 });
        const receiptSql = receiptShape === "long-decimal"
          ? `(SELECT jsonb_object_agg('key'||n,('0.'||repeat('0',16382)||'1')::numeric) FROM generate_series(1,4096)n)`
          : receiptShape === "overflow"
            ? `jsonb_build_object('a',repeat('x',1048576),'z',jsonb_build_object('nested','1e400'::numeric))`
            : `jsonb_build_object('text',$6::text)`;
        await client.query(`INSERT INTO action_receipts(workspace_id,world_id,worldline_id,record_id,actor_character_instance_id,source_event_id,id,transaction_id,call_fingerprint,receipt,world_tick,world_ordinal,recorded_at)
          SELECT $1,$2,$3,$4,$4||'.instance',$4||'.event',$4||'.receipt.'||lpad(n::text,6,'0'),'tx-'||n,' fingerprint ',CASE WHEN n=1 THEN ${receiptSql} ELSE '{}'::jsonb END,0,0,'2026-10-18T00:00:00Z'::timestamptz FROM generate_series(1,$5::int)n`,[...Object.values(scope),count,...(receiptShape === "default" ? [text] : [])]);
        await client.query(`INSERT INTO effect_definitions(workspace_id,world_id,id,effect_key,title,rule_pack_key,effect_kind)
          SELECT $1,$2,$3||'.definition.'||n,'effect-'||n,'Evidence fixture','n3.fixture','buff' FROM generate_series(1,$4::int)n`,[scope.workspaceId,scope.worldId,scope.recordId,count]);
        await client.query(`INSERT INTO character_effects(workspace_id,world_id,worldline_id,record_id,character_instance_id,effect_definition_id,source_action_receipt_id,id,status,applied_tick,applied_ordinal,ended_tick,ended_ordinal,revision,metadata)
          SELECT $1,$2,$3,$4,$4||'.instance',$4||'.definition.'||n,$4||'.receipt.'||lpad(n::text,6,'0'),$4||'.effect.'||lpad(n::text,6,'0'),'expired',0,0,0,0,0,CASE WHEN n=1 THEN jsonb_build_object('text',$6::text) ELSE '{}'::jsonb END FROM generate_series(1,$5::int)n`,[...Object.values(scope),count,text]);
        await client.query(`INSERT INTO observations(workspace_id,world_id,worldline_id,record_id,observer_character_instance_id,source_event_id,id,dedupe_key,observation_kind,content,fidelity,occurred_tick,occurred_ordinal,available_from_tick,available_from_ordinal,metadata)
          SELECT $1,$2,$3,$4,$4||'.instance',$4||'.event',$4||'.observation.'||lpad(n::text,6,'0'),'dedupe-'||n,'direct',CASE WHEN n=1 THEN $6 ELSE 'Small observation' END,1,0,0,0,0,'{}'::jsonb FROM generate_series(1,$5::int)n`,[...Object.values(scope),count,text]);
    });
    const trace:{sql:string;rows:number;maxString:number;maxBuffer:number}[]=[];
    let failFetch=false,released=0;
    const database={async connect(){
      const client=await runtime.connect(),query=client.query,release=client.release;
      const execute=client.query.bind(client) as (sql:string,values?:unknown[])=>Promise<pg.QueryResult>;
      client.query=(async(sql:string,values?:unknown[])=>{
        const result=await execute(sql,values);
        if(failFetch && sql.startsWith('/* runtime evidence body */') && result.rows.length) result.rows[0].chunk_start=2;
        const cells=result.rows.flatMap(row=>Object.values(row));
        trace.push({sql,rows:result.rows.length,maxString:Math.max(0,...cells.filter((v):v is string=>typeof v==='string').map(v=>Buffer.byteLength(v))),maxBuffer:Math.max(0,...cells.filter(Buffer.isBuffer).map(v=>v.length))});
        return result;
      }) as typeof client.query;
      client.release=(...args)=>{released++;client.query=query;client.release=release;release.apply(client,args);};return client;
    }};
    const load=(purpose:'record-export'|'native-record-branch'|'whole-closure-backup'='record-export')=>createPostgresRealmRuntimeSaveReader(database as never).load({workspaceId:scope.workspaceId,recordId:scope.recordId,principalId:POSTGRES_DEMO_IDS.principal,purpose,...(purpose==='native-record-branch'?{sessionProof:'fixture-proof'}:{})});
    const mutate=(sql:string,values:unknown[]=[])=>withWorkspaceTransaction(owner,scope.workspaceId,client=>client.query(sql,[...Object.values(scope),...values]));
    return {scope,trace,load,mutate,runtime,fail(){failFetch=true;},released:()=>released};
}

for(const count of [1000,1001,2001]) test(`N3 PG ${count} tuple ties, bounded headers/bodies, three public routes`,async t=>{
  const f=await fixture(t,count),old=process.env.REALM_OPERATOR_PRINCIPALS;
  process.env.REALM_OPERATOR_PRINCIPALS=POSTGRES_DEMO_IDS.principal;
  try {for(const purpose of ['record-export','native-record-branch','whole-closure-backup'] as const) {
    f.trace.length=0;
    const a=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await f.load(purpose))!));
    assert.equal(a.actionReceipts!.receipts.length,count);assert.equal(a.characterEffects!.effects.length,count);assert.equal(a.observations!.observations.length,count);
    assert.equal(a.actionReceipts!.receipts.at(-1)!.sourceReceiptId,`${f.scope.recordId}.receipt.${String(count).padStart(6,'0')}`);
    const headers=f.trace.filter(c=>c.sql.startsWith('/* runtime evidence headers */'));
    assert.equal(headers.length,3*(Math.ceil(count/1000)+1));assert.ok(headers.every(c=>c.rows<=1000&&c.maxString<=256));
    const bodies=f.trace.filter(c=>c.sql.startsWith('/* runtime evidence body */'));assert.ok(bodies.length>30);assert.ok(bodies.every(c=>c.rows<=1&&c.maxBuffer<=65536));
    assert.equal(f.trace.filter(c=>c.sql.includes('headers */ DECLARE')).length,3);
    assert.ok(f.trace.some(c=>c.sql==='COMMIT'));
  }} finally {if(old===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=old;}
  assert.equal(f.released(),3);
});
test('N3 PG fresh rows and runtime RLS retain unique INNER lookup and scoped tid body plans',async t=>{
  const f=await fixture(t,2001),scope=Object.values(f.scope),plans:unknown[]=[];
  // Intentionally no ANALYZE, planner GUC, owner reads or RLS relaxation.
  await withWorkspaceTransaction(f.runtime,f.scope.workspaceId,async client=>{
    const role=(await client.query("SELECT current_user,current_setting('row_security') rls,(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser")).rows[0];
    assert.equal(role.current_user,'realm_runtime');assert.equal(role.rls,'on');assert.equal(role.superuser,false);
    const select=evidenceHeaderSql('character_effects','realm_evidence_abcdef').split('CURSOR FOR')[1]!;
    const plan=(await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+select,scope)).rows[0]['QUERY PLAN'];plans.push(plan);
    // Preserve the complete observed plan even when the original gate fails.
    t.diagnostic(JSON.stringify({headerPlan:plan,fresh_fixture_without_manual_analyze:true}));
    const nodes=(node:Record<string,unknown>):Record<string,unknown>[]=>[node,...((node.Plans??[]) as Record<string,unknown>[]).flatMap(nodes)];
    const lookups=nodes(plan[0].Plan).filter(n=>n['Relation Name']==='effect_definitions');assert.ok(lookups.length);
    for(const n of lookups) {assert.ok(Number(n['Actual Rows'])<=1);assert.match(String(n['Index Cond']),/(?:\W|^)id =/);}
    const header=(await client.query(select,scope)).rows[0];assert.ok(header);
    const body=evidenceBodySql('character_effects','metadata','realm_evidence_abcdef').split('CURSOR FOR')[1]!;
    const bodyPlan=(await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+body,[...scope,header.locator])).rows[0]['QUERY PLAN'];plans.push(bodyPlan);
    assert.ok(nodes(bodyPlan[0].Plan).some(n=>n['Relation Name']==='character_effects'&&String(n['Node Type']).includes('Tid')));
    for(const wrong of [['foreign-workspace',...scope.slice(1)],[scope[0],'foreign-world',...scope.slice(2)],[...scope.slice(0,2),'foreign-line',scope[3]],[...scope.slice(0,3),'foreign-record']]) assert.equal((await client.query(select,wrong)).rows.length,0);
  });
  t.diagnostic(JSON.stringify({plans,fresh_fixture_without_manual_analyze:true}));
});
test('N3 PG malformed body closes both cursors, rolls back and returns reusable connection',async t=>{
  const f=await fixture(t);f.fail();await assert.rejects(f.load());assert.equal(f.released(),1);
  assert.ok(f.trace.filter(c=>c.sql.startsWith('CLOSE realm_evidence_')).length>=2);assert.ok(f.trace.some(c=>c.sql==='ROLLBACK'));
  const client=await f.runtime.connect();try {assert.equal((await client.query("SELECT name FROM pg_cursors WHERE name LIKE 'realm_evidence_%'")).rows.length,0);assert.equal((await client.query('SELECT 1 AS usable')).rows[0].usable,1);} finally {client.release();}
});
test('N3 PG legal raw JSON above file capacity normalizes without a raw-text rejection',async t=>{
  const f=await fixture(t,1,"long-decimal");
  const raw=await f.mutate('SELECT octet_length(receipt::text) bytes FROM action_receipts WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4');assert.ok(Number(raw.rows[0].bytes)>64*1024*1024);
  const a=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await f.load())!));assert.equal(Object.keys(a.actionReceipts!.receipts[0]!.receipt).length,4096);assert.ok(Object.values(a.actionReceipts!.receipts[0]!.receipt).every(v=>v===0));
  assert.ok(f.trace.filter(c=>c.sql.startsWith('/* runtime evidence body */')).every(c=>c.maxBuffer<=65536));
});
test('N3 PG late nested overflow keeps whole-object fallback before large unrelated text transfer',async t=>{
  const f=await fixture(t,1,"overflow");
  const a=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive((await f.load())!));assert.deepEqual(a.actionReceipts!.receipts[0]!.receipt,{});
  assert.equal(f.trace.filter(c=>c.sql.includes('action_receipts receipt body */')).length,0);
});
