/** NOT_RUN: syntax/type checks only in this batch. Use the authorized disposable PG runner. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { POSTGRES_DEMO_IDS, withWorkspaceTransaction } from "../database/postgres/public.ts";
import { createPostgresRealmRuntimeSaveReader } from "../database/postgres/realm-runtime-save-repository.ts";
import { countRuntimeSectionWireBytes, serializeRealmRuntimeSaveOutboxV1 } from "../modules/world-transfer/realm-runtime-save.ts";

const LIMIT = 67108864, CHUNK = 65536;
function assertClosedCursors(trace: readonly {sql:string}[]) {
  const cursors = trace.flatMap(row => /\bDECLARE (realm_(?:outbox_payload|evidence)_[a-f0-9]+) NO SCROLL CURSOR FOR\b/.exec(row.sql)?.[1] ?? []);
  assert.equal(cursors.filter(name=>name.startsWith('realm_outbox_payload_')).length,1);
  assert.equal(cursors.filter(name=>name.startsWith('realm_evidence_')).length,3);
  for (const name of cursors) assert.equal(trace.filter(row=>row.sql===`CLOSE ${name}`).length,1,`close exact cursor ${name}`);
}
async function fixture(t: test.TestContext, count = 1) {
  assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"), "authorized disposable runner required");
  assert.ok(process.env.DATABASE_URL && process.env.REALM_RUNTIME_DATABASE_URL);
  const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  t.after(() => owner.end()); // registered before the next allocation or fallible setup
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 2 });
  t.after(() => runtime.end());
  // Immutable history belongs to the disposable runner's cluster teardown.
  // No DELETE/TRUNCATE cleanup of shared or immutable application data.
  const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: `outbox_world_${randomUUID()}`,
    worldlineId: `outbox_line_${randomUUID()}`, recordId: `outbox_record_${randomUUID()}` };
  const storyId = `outbox_story_${randomUUID()}`;
  await withWorkspaceTransaction(owner, scope.workspaceId, async client => {
    const clone = async (table: string, predicate: string, sourceId: string, patch: object) => {
      const result = await client.query(`INSERT INTO ${table}
        SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND ${predicate}=$3 LIMIT 1`,
        [JSON.stringify(patch),scope.workspaceId,sourceId]);
      assert.equal(result.rowCount,1,`fixture ${table}`);
    };
    const scoped = { workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, record_id: scope.recordId };
    await clone("worlds","id",POSTGRES_DEMO_IDS.world,{id:scope.worldId,name:"Outbox bounded resources"});
    await clone("worldlines","id",POSTGRES_DEMO_IDS.worldline,{id:scope.worldlineId,world_id:scope.worldId,head_tick:0,head_ordinal:0});
    await clone("stories","id",POSTGRES_DEMO_IDS.story,{...scoped,id:storyId,start_tick:0,start_ordinal:0});
    await clone("records","id",POSTGRES_DEMO_IDS.record,{...scoped,id:scope.recordId,story_id:storyId,status:"active",start_tick:0,start_ordinal:0});
    await clone("record_heads","record_id",POSTGRES_DEMO_IDS.record,{...scoped,record_version:0,next_record_ordinal:1,last_event_id:null,last_world_tick:0,last_world_ordinal:0});
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')",[scope.workspaceId,scope.worldId,POSTGRES_DEMO_IDS.principal]);
  });
  const mutate = (sql: string, extra: unknown[] = []) => withWorkspaceTransaction(owner,scope.workspaceId,
    client=>client.query(sql,[scope.workspaceId,scope.recordId,...extra]));
  async function append(start: number, end: number) {
    await withWorkspaceTransaction(owner,scope.workspaceId,client=>client.query(`INSERT INTO outbox
      (workspace_id,world_id,worldline_id,record_id,id,dedupe_key,topic,payload,state,available_at,created_at)
      SELECT $1,$2,$3,$4,$4||'.m.'||lpad(n::text,8,'0'),$4||'.d.'||n,'event.committed',
        '{"number":1.000000,"text":"汉😀"}'::jsonb,'pending','2026-10-18T00:00:00Z',
        '2026-10-18T00:00:00Z'::timestamptz+(n/2)*interval '1 microsecond'
      FROM generate_series($5::int,$6::int) n`,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,start,end]));
  }
  if (count) await append(1,count);
  const trace: { sql: string; rows: number; maxText: number; maxBuffer: number; payloads: number }[] = [];
  let afterPage: (()=>Promise<void>) | undefined;
  let failFetch = false;
  const database = { async connect() {
    const client = await runtime.connect(), originalQuery = client.query, originalRelease = client.release;
    const execute = client.query.bind(client) as (sql: string, values?: unknown[])=>Promise<pg.QueryResult<pg.QueryResultRow>>;
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = failFetch && sql.includes("runtime outbox payload chunk") ? { rows: [] } : await execute(sql,values);
      if (sql.includes("runtime outbox") || sql.includes("runtime evidence") || sql.startsWith("CLOSE ")) {
        const values = result.rows.flatMap(row=>Object.values(row));
        trace.push({sql,rows:result.rows.length,maxText:Math.max(0,...values.filter((v):v is string=>typeof v==="string").map(v=>v.length)),
          maxBuffer:Math.max(0,...values.filter((v):v is Buffer=>Buffer.isBuffer(v)).map(v=>v.length)),
          payloads:result.rows.filter(row=>Object.hasOwn(row,"payload")).length});
        if (sql.includes("outbox headers") && afterPage) { const writer=afterPage;afterPage=undefined;await writer(); }
      }
      return result;
    }) as typeof client.query;
    client.release = (...args) => {client.query=originalQuery;client.release=originalRelease;originalRelease.apply(client,args);};
    return client;
  } };
  const load = (purpose: "record-export" | "native-record-branch" | "whole-closure-backup" = "record-export") =>
    createPostgresRealmRuntimeSaveReader(database as never).load({workspaceId:scope.workspaceId,recordId:scope.recordId,
      principalId:POSTGRES_DEMO_IDS.principal,purpose,...(purpose==="native-record-branch"?{sessionProof:"proof"}:{})});
  return {scope,owner,trace,load,append,mutate,afterPage(writer:()=>Promise<void>){afterPage=writer;},failFetch(){failFetch=true;}};
}
for (const count of [1001,2001]) test(`Outbox PG keyset keeps ${count} microsecond/tie rows in ordinary/native/whole readers`,async t=>{
  const f=await fixture(t,count),old=process.env.REALM_OPERATOR_PRINCIPALS;
  process.env.REALM_OPERATOR_PRINCIPALS=POSTGRES_DEMO_IDS.principal;
  try {for(const purpose of ["record-export","native-record-branch","whole-closure-backup"] as const){
    f.trace.length=0;const archive=await f.load(purpose);assert.equal(archive!.outbox!.messages.length,count);
    assert.deepEqual(archive!.outbox!.messages.map(m=>m.sourceMessageId),Array.from({length:count},(_,i)=>`${f.scope.recordId}.m.${String(i+1).padStart(8,"0")}`));
    const headers=f.trace.filter(c=>c.sql.includes("outbox headers"));assert.equal(headers.length,Math.floor(count/1000)+1);
    assert.ok(headers.every(c=>c.rows<=1000&&c.payloads===0));
  }} finally {if(old===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=old;}
});
test("Outbox PG pages keep the repeatable-read image across an independent append",async t=>{
  const f=await fixture(t,2001);f.afterPage(()=>f.append(2002,2002));
  assert.equal((await f.load())!.outbox!.messages.length,2001);
  assert.equal((await f.load())!.outbox!.messages.length,2002);
});
for(const [text,valid] of [["汉".repeat(256),true],["😀".repeat(128),true],["😀".repeat(129),false],["a\u0001b",true],[" topic",false],["topic\uFEFF",false],["x".repeat(1024*1024),false]] as const){
  test(`Outbox PG UTF16/trim topic preflight ${text.length}/${valid}`,async t=>{
    const f=await fixture(t);await f.mutate("UPDATE outbox SET topic=$3,payload=jsonb_build_object('unrelated',repeat('x',1048576)) WHERE workspace_id=$1 AND record_id=$2",[text]);
    if(valid)assert.equal((await f.load())!.outbox!.messages[0]!.topic,text);
    else await assert.rejects(f.load(),{code:"RUNTIME_SAVE_INVALID"});
    assert.ok(f.trace.filter(c=>c.sql.includes("outbox headers")).every(c=>c.maxText<=4096&&c.payloads===0));
    if(!valid)assert.equal(f.trace.filter(c=>c.sql.includes("payload cursor")).length,0);
  });
}
test("Outbox PG exact normalized 64MiB and +1 enforce streaming budget and close failure cursor",async t=>{
  const f=await fixture(t);await f.mutate("UPDATE outbox SET payload=jsonb_build_object('big','') WHERE workspace_id=$1 AND record_id=$2");
  const empty=(await f.load())!.outbox!;const overhead=countRuntimeSectionWireBytes(empty,"canonical-runtime");
  await f.mutate("UPDATE outbox SET payload=jsonb_build_object('big',repeat('x',$3)) WHERE workspace_id=$1 AND record_id=$2",[LIMIT-overhead]);
  const exact=(await f.load())!.outbox!;assert.equal(Buffer.byteLength(serializeRealmRuntimeSaveOutboxV1(exact)),LIMIT);
  await f.mutate("UPDATE outbox SET payload=jsonb_set(payload,'{big}',to_jsonb((payload->>'big')||'x')) WHERE workspace_id=$1 AND record_id=$2");
  f.trace.length=0;await assert.rejects(f.load(),{code:"RUNTIME_SAVE_INVALID"});
  assertClosedCursors(f.trace);
  assert.ok(f.trace.every(c=>c.maxBuffer<=CHUNK));
});
test("Outbox PG long-decimal raw >64MiB stays normalized-small with one materialized conversion",async t=>{
  const f=await fixture(t);await f.mutate(`UPDATE outbox SET payload=(SELECT jsonb_object_agg('n'||lpad(n::text,4,'0'),
    ('0.'||repeat('0',16382)||'1')::numeric) FROM generate_series(0,4095) n) WHERE workspace_id=$1 AND record_id=$2`);
  const archive=await f.load();assert.equal(Object.keys(archive!.outbox!.messages[0]!.envelope).length,4096);
  assert.ok(Buffer.byteLength(serializeRealmRuntimeSaveOutboxV1(archive!.outbox!))<100000);
  assert.equal(f.trace.filter(c=>c.sql.includes("payload cursor")).length,1);
  assert.equal(f.trace.filter(c=>/FETCH FORWARD 1 FROM realm_outbox_payload_/.test(c.sql)).length,1026);
  assert.ok(f.trace.every(c=>c.maxBuffer<=CHUNK));
});
test("Outbox PG nonfinite nested number falls back before giant unrelated payload crosses driver",async t=>{
  const f=await fixture(t);await f.mutate("UPDATE outbox SET payload=jsonb_build_object('overflow','1e999'::jsonb,'large',repeat('x',67108865)) WHERE workspace_id=$1 AND record_id=$2");
  assert.deepEqual((await f.load())!.outbox!.messages[0]!.envelope,{});
  assert.ok(f.trace.every(c=>c.maxBuffer<=CHUNK));
});
test("Outbox PG injected missing fetch closes cursor and fails without fallback",async t=>{
  const f=await fixture(t);f.failFetch();await assert.rejects(f.load(),{code:"RUNTIME_SAVE_INVALID"});
  assertClosedCursors(f.trace);
});
