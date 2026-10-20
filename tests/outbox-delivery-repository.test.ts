import assert from "node:assert/strict";
import test from "node:test";
type Pool = Parameters<typeof createPostgresOutboxDeliveryRepository>[0]["pool"];
import { createPostgresOutboxDeliveryRepository } from "../database/postgres/public.ts";
import { decodeOutboxDeliveryBody } from "../modules/application/outbox-delivery-contract.ts";

const now = "2026-10-18T00:00:00.000Z";
const later = "2026-10-18T00:01:00.000Z";
function row(patch: Record<string, unknown> = {}) {
  return { workspace_id: "ws", world_id: "world", worldline_id: "line", record_id: "record", event_id: null,
    id: "message", turn_run_id: null as string | null, topic: "record.events.committed", restore_delivery_kind: "record-events-v1",
    dedupe_key: "stable", payload: { recordId: "record", eventIds: ["event", "event"] },
    scan_available_at: now, state: "pending", revision: 0, attempt_count: 0, available_at: now, created_at: now, updated_at: now,
    lease_owner: null as string | null, lease_expires_at: null as string | null, published_at: null, last_error_code: null, last_error_message: null, last_error_at: null, ...patch };
}
type R = ReturnType<typeof row>;
function harness(rows: R[] = [row()], mode: "disabled" | "record-events-v2" = "record-events-v2", batchLimit = 2) {
  const calls: { sql: string; values: unknown[] }[] = [], invalid: string[] = [];
  let fail: Error | undefined;
  const query = async (raw: string, values: unknown[] = []) => {
    const sql = raw.replace(/\s+/g, " ").trim(); calls.push({ sql, values: structuredClone(values) });
    const result = (items: unknown[]) => ({ rows: structuredClone(items), rowCount: items.length });
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) { assert.deepEqual(values, []); return result([]); }
    if (sql === "SELECT set_config('realm.workspace_id', $1, true)") { assert.deepEqual(values, ["ws"]); return result([]); }
    if (fail) throw fail;
    if (sql === "SELECT restore_delivery_kind FROM public.outbox WHERE false") { assert.deepEqual(values, []); return result([]); }
    if (sql.startsWith("SELECT o.id,")) {
      assert.match(sql, /o\.workspace_id = \$1/); assert.match(sql, /o\.topic = ANY\(\$2::text\[\]\)/);
      assert.match(sql, /length\(btrim\(o\.turn_run_id\)\) > 0/);
      assert.deepEqual(values.slice(0, 2), ["ws", ["record.events.committed", "custom"]]);
      if (mode === "disabled") assert.doesNotMatch(sql, /restore_delivery_kind/);
      else { assert.match(sql, /o\.restore_delivery_kind IS NULL/); assert.match(sql, /o\.restore_delivery_kind = 'record-events-v1'/); }
      const eligible = rows.filter(r => r.workspace_id === values[0] && (values[1] as string[]).includes(r.topic)
        && ((typeof r.turn_run_id === "string" && r.turn_run_id.trim() !== "" && (mode === "disabled" || r.restore_delivery_kind === null))
          || (mode !== "disabled" && r.turn_run_id === null && r.restore_delivery_kind === "record-events-v1" && r.topic === "record.events.committed")));
      if (sql.endsWith("FOR UPDATE OF o")) { assert.equal(values.length, 3); return result(eligible.filter(r => r.id === values[2])); }
      assert.match(sql, /ORDER BY o\.available_at, o\.id COLLATE "C" LIMIT \$6/);
      assert.match(sql, /o\.available_at <= \$3::timestamptz/); assert.match(sql, /o\.lease_expires_at <= \$3::timestamptz/);
      assert.equal(values.length, 6); assert.equal(values[5], batchLimit);
      return result(eligible.filter(r => ((["pending", "retryable"].includes(r.state) && r.available_at <= String(values[2]))
        || (r.state === "delivering" && r.lease_expires_at !== null && String(r.lease_expires_at) <= String(values[2])))
        && (values[3] === null || r.available_at > String(values[3]) || (r.available_at === values[3] && r.id > String(values[4]))))
        .sort((a,b) => a.available_at < b.available_at ? -1 : a.available_at > b.available_at ? 1 : a.id < b.id ? -1 : 1).slice(0, batchLimit));
    }
    if (sql === "SELECT id FROM records WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4") {
      assert.equal(values.length, 4); return result(values.slice(0, 3).join("/") === "ws/world/line" && values[3] === "record" ? [{id:"record"}] : []);
    }
    if (sql === "SELECT id FROM events WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 AND id = ANY($5::text[])") {
      assert.equal(values.length, 5); return result(values.slice(0, 4).join("/") === "ws/world/line/record" ? [{id:"event"}].filter(r => (values[4] as string[]).includes(r.id)) : []);
    }
    if (sql.startsWith("UPDATE outbox SET")) {
      assert.match(sql, /WHERE workspace_id = \$1 AND id = \$2 RETURNING/);
      const r = rows.find(r => r.workspace_id === values[0] && r.id === values[1])!;
      if (sql.includes("attempt_count = attempt_count + 1")) {
        assert.equal(values.length, 5); r.state="delivering"; r.attempt_count++; r.revision++; r.lease_owner=values[2] as never; r.lease_expires_at=values[3] as never; r.updated_at=String(values[4]);
      } else {
        assert.equal(values.length, 8); r.state=String(values[2]); r.revision++; r.lease_owner=null; r.lease_expires_at=null;
        if(r.state==="retryable") r.available_at=String(values[3]);
        if(r.state==="delivered") r.published_at=values[4] as never;
        r.updated_at=String(values[4]);r.last_error_code=values[5] as never;r.last_error_message=values[6] as never;r.last_error_at=values[7] as never;
      }
      return result([r]);
    }
    throw new Error(`UNKNOWN_DELIVERY_SQL:${sql}`);
  };
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const repo = createPostgresOutboxDeliveryRepository({ pool, workspaceId: "ws", topics: ["record.events.committed", "custom"], restoreDelivery: mode, batchLimit, onInvalidMessage: code => invalid.push(code) });
  return {repo, rows, calls, invalid, pool, query, fail(error: Error) {fail=error;} };
}
const claim = {messageId:"message",expectedRevision:0,leaseOwner:"worker",now,leaseExpiresAt:later};
const settle = {messageId:"message",expectedRevision:1,leaseOwner:"worker",now,outcome:"delivered" as const};

test("delivery SQL discovers marked restore; scope membership preserves duplicate event IDs", async () => {
  const d=harness();const [m]=await d.repo.listOutboxMessages({now,limit:2});
  assert.equal(m.origin,"record-events-restore-v1");assert.equal(m.turnId,null);assert.deepEqual(m.payload,{recordId:"record",eventIds:["event","event"]});
  assert.equal(d.calls.filter(c=>c.sql.startsWith("SELECT o.id,")).length,1);
});
test("disabled old-schema native query never references marker and excludes NULL turn before decoder", async () => {
  const d=harness([row(),row({id:"native",turn_run_id:"turn",restore_delivery_kind:null,payload:{__realmRuntimePayload:{recordId:"record",eventIds:[]}}}),row({id:"other-topic",topic:"forbidden",turn_run_id:"turn",payload:7})],"disabled");
  assert.deepEqual((await d.repo.listOutboxMessages({now,limit:2})).map(m=>[m.messageId,m.origin]),[["native","runtime-turn"]]);
  assert.deepEqual(d.invalid,[]);
});
test("poison full page advances raw cursor; partial and empty pages reset for future polls", async () => {
  const d=harness([row({id:"a",payload:7}),row({id:"b",payload:{__realmRuntimePayload:7}}),row({id:"c"})]);
  assert.deepEqual(await d.repo.listOutboxMessages({now,limit:2}),[]);assert.equal(d.invalid.length,2);
  assert.deepEqual((await d.repo.listOutboxMessages({now,limit:2})).map(m=>m.messageId),["c"]);
  await d.repo.listOutboxMessages({now,limit:2});assert.equal(d.invalid.length,4);
  assert.equal(d.calls.filter(c=>c.sql.startsWith("SELECT o.id,")).length,3);
});
test("unmarked NULL, malformed origin, forbidden topic and blank turn never reach decoder", async () => {
  const d=harness([row({restore_delivery_kind:null,payload:7}),row({id:"bad-marker",restore_delivery_kind:"forged",payload:7}),row({id:"topic",topic:"forbidden",payload:7}),row({id:"blank",turn_run_id:" ",payload:7})]);
  assert.deepEqual(await d.repo.listOutboxMessages({now,limit:2}),[]);assert.deepEqual(d.invalid,[]);
});
test("scope and body poison is rejected locally while valid same-page rows survive", async () => {
  for(const patch of [{world_id:"other"},{worldline_id:"sibling"},{payload:{recordId:"foreign",eventIds:[]}},{payload:{recordId:"record",eventIds:["foreign"]}},{payload:{recordId:"record",eventIds:[" bad "]}}]) {
    const d=harness([row({id:"a",...patch}),row({id:"b"})]);
    assert.deepEqual((await d.repo.listOutboxMessages({now,limit:2})).map(m=>m.messageId),["b"]);assert.deepEqual(d.invalid,["OUTBOX_DELIVERY_MESSAGE_INVALID"]);
    assert.equal(d.calls.filter(c=>c.sql.startsWith("UPDATE")).length,0);
  }
});
test("custom wrapper is decoded once, nested keys and literal IDs remain literal",async()=>{
  const body={recordId:"foreign",__realmRuntimePayload:{eventIds:["foreign"]}};
  const d=harness([row({topic:"custom",turn_run_id:"turn",restore_delivery_kind:null,payload:{__realmRuntimePayload:body}})]);
  assert.deepEqual((await d.repo.listOutboxMessages({now,limit:2}))[0].payload,body);
});
test("unknown SQL/driver errors propagate instead of becoming malformed rows",async()=>{
  const d=harness();const error=Object.assign(new Error("driver private"),{code:"42703"});d.fail(error);
  await assert.rejects(d.repo.listOutboxMessages({now,limit:2}),e=>e===error);assert.deepEqual(d.invalid,[]);
});
test("direct claim and settle independently recheck SQL eligibility and codec with zero updates",async()=>{
  for(const mode of ["disabled","record-events-v2"] as const) for(const patch of [{workspace_id:"foreign"},{topic:"forbidden"},{restore_delivery_kind:null},{payload:7},{worldline_id:"sibling"}]) {
    for(const operation of ["claim","settle"]) {
      const d=harness([row({...patch,...(operation==="settle"?{state:"delivering",revision:1,lease_owner:"worker",lease_expires_at:later}:{})})],mode);
      await assert.rejects(operation==="claim"?d.repo.claimOutbox(claim):d.repo.settleOutbox(settle), (e:unknown)=>!!e&&typeof e==="object"&&"code" in e&&["OUTBOX_NOT_FOUND","OUTBOX_DELIVERY_MESSAGE_INVALID"].includes(String(e.code)));
      assert.equal(d.calls.filter(c=>c.sql.startsWith("UPDATE")).length,0);assert.equal(d.calls.at(-1)?.sql,"ROLLBACK");
    }
  }
});
test("claim/settle use original revision, lease, availability and identity fences",async()=>{
  const d=harness();const c=await d.repo.claimOutbox(claim);assert.equal(c.revision,1);assert.equal(c.attempts,1);assert.equal(c.origin,"record-events-restore-v1");
  await assert.rejects(d.repo.claimOutbox(claim),{code:"TURN_REVISION_CONFLICT"});
  for(const patch of [{expectedRevision:0},{leaseOwner:"other"},{now:later}]) await assert.rejects(d.repo.settleOutbox({...settle,...patch}),{code:"TURN_REVISION_CONFLICT"});
  const s=await d.repo.settleOutbox(settle);assert.equal(s.state,"delivered");assert.equal(s.revision,2);assert.equal(s.dedupeKey,c.dedupeKey);assert.equal(s.turnId,null);
  await assert.rejects(d.repo.settleOutbox({...settle,expectedRevision:2}),{code:"TURN_REVISION_CONFLICT"});
});
test("expired delivery can be reclaimed; retry retains stable identity and increments attempts",async()=>{
  const d=harness([row({state:"delivering",revision:4,attempt_count:3,lease_owner:"dead",lease_expires_at:now})]);
  const c=await d.repo.claimOutbox({...claim,expectedRevision:4});assert.equal(c.revision,5);assert.equal(c.attempts,4);
  const s=await d.repo.settleOutbox({...settle,expectedRevision:5,outcome:"retryable",retryAt:later,failure:{code:"RETRY",message:"safe",occurredAt:now}});
  assert.equal(s.state,"retryable");await assert.rejects(d.repo.claimOutbox({...claim,expectedRevision:6}),{code:"TURN_REVISION_CONFLICT"});
  const again=await d.repo.claimOutbox({...claim,expectedRevision:6,now:later,leaseExpiresAt:"2026-10-18T00:02:00.000Z"});assert.equal(again.dedupeKey,c.dedupeKey);assert.equal(again.attempts,5);
});
test("exact bounds/config validated before any connection",()=>{
  const d=harness();for(const batchLimit of [0,-1,1.5,Infinity]) assert.throws(()=>createPostgresOutboxDeliveryRepository({pool:d.pool,workspaceId:"ws",topics:["custom"],batchLimit}));
  assert.throws(()=>createPostgresOutboxDeliveryRepository({pool:d.pool,workspaceId:"ws",topics:[],batchLimit:2}));assert.deepEqual(d.calls,[]);
});
test("decoder own-wrapper malformed does not fall back and marker is not inferred from body",()=>{
  const input={recordId:"record",topic:"record.events.committed",turnId:null,restoreDeliveryKind:"record-events-v1",payload:{recordId:"record",eventIds:[],__realmRuntimePayload:7}};
  assert.throws(()=>decodeOutboxDeliveryBody(input,"record-events-v2"),{code:"OUTBOX_DELIVERY_MESSAGE_INVALID"});
  assert.throws(()=>decodeOutboxDeliveryBody({...input,restoreDeliveryKind:null},"record-events-v2"),{code:"OUTBOX_DELIVERY_MESSAGE_INVALID"});
});

// Only replace the module constructors below; no PG instance or connection is created.
const { default: pg } = await import("pg");
import { createOutboxWorkerRuntime } from "../modules/application/outbox-worker-runtime.ts";
import { createHttpOutboxDeliverySink } from "../modules/application/outbox-delivery-sink.ts";
const P="SELECT restore_delivery_kind FROM public.outbox WHERE false";

test("original host assembles delivery repository, dispatcher and injected HTTP sink through settlement", async t=>{
  const originalPool=pg.Pool,originalClient=pg.Client;
  t.after(()=>{pg.Pool=originalPool;pg.Client=originalClient;});
  const d=harness(), bodies:unknown[]=[], headers:Headers[]=[], logs:string[]=[];
  let poolClosed=0,lockClosed=0;
  class FakePool {
    on() {}
    async connect(){return {query:d.query,release(){}};}
    async query(sql:string,values?:unknown[]){
      if(sql.includes("to_regclass"))return {rows:[{outbox:"outbox",turnRuns:"turn_runs"}],rowCount:1};
      return d.query(sql,values);
    }
    async end(){poolClosed++;}
  }
  class FakeClient {
    async connect(){}
    async query(sql:string,values:unknown[]){assert.equal(sql,"SELECT pg_try_advisory_lock(hashtext($1)) AS locked");assert.deepEqual(values,["realm_outbox_worker"]);return {rows:[{locked:true}]};}
    async end(){lockClosed++;}
  }
  pg.Pool=FakePool as unknown as typeof pg.Pool;pg.Client=FakeClient as unknown as typeof pg.Client;
  const sink=createHttpOutboxDeliverySink({endpoint:"https://delivery.example.test/events",restoreDelivery:"record-events-v2",fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init?.body)));headers.push(new Headers(init?.headers));return new Response(null,{status:202});}});
  const runtime=createOutboxWorkerRuntime({connectionString:"postgresql://realm_runtime@127.0.0.1/fixture",deliveryUrl:"https://delivery.example.test/events",workspaces:["ws"],topics:["record.events.committed","custom"],...({restoreDelivery:"record-events-v2"} as object),batchLimit:2,clock:()=>now,sink,logger:line=>{logs.push(line);if(line.includes("claimed=")||line.includes("poll error"))void runtime.stop();}});
  const timeout=setTimeout(()=>void runtime.stop(),1000);t.after(()=>clearTimeout(timeout));await runtime.start();await runtime.stop();
  assert.equal(bodies.length,1,logs.join("\n"));assert.deepEqual(bodies[0],{version:2,origin:"record-events-restore-v1",messageId:"message",turnId:null,recordId:"record",topic:"record.events.committed",dedupeKey:"stable",attempt:1,payload:{recordId:"record",eventIds:["event","event"]}});
  assert.equal(headers[0].get("Idempotency-Key"),"stable");assert.equal(d.rows[0].state,"delivered");assert.equal(d.rows[0].revision,2);assert.equal(poolClosed,1);assert.equal(lockClosed,1);
  assert.equal(d.calls.filter(c=>c.sql===P).length,1);
});

test("host disabled old-schema health has zero marker probes; opted-in schema failure stops safely",async t=>{
  const originalPool=pg.Pool,originalClient=pg.Client;t.after(()=>{pg.Pool=originalPool;pg.Client=originalClient;});
  for(const mode of ["disabled","record-events-v2"] as const){
    let probes=0,closed=0,unlocked=0,queries=0;const logs:string[]=[];
    class FakePool {
      on(){} async connect(){throw new Error("unexpected poll after schema refusal");}
      async query(sql:string,values?:unknown[]){queries++;if(sql.includes("to_regclass"))return {rows:[{outbox:"outbox",turnRuns:"turn_runs"}]};assert.equal(sql,P);assert.deepEqual(values,[]);probes++;throw Object.assign(new Error("private driver"),{code:"42703"});}
      async end(){closed++;}
    }
    class FakeClient {async connect(){}async query(){return {rows:[{locked:true}]};}async end(){unlocked++;}}
    pg.Pool=FakePool as unknown as typeof pg.Pool;pg.Client=FakeClient as unknown as typeof pg.Client;
    const runtime=createOutboxWorkerRuntime({connectionString:"postgresql://realm_runtime@127.0.0.1/fixture",deliveryUrl:"https://delivery.example.test/events",workspaces:["ws"],...({restoreDelivery:mode} as object),sink:{async publish(){throw new Error("unexpected publish");}},logger:line=>{logs.push(line);if(line.includes("poll error"))void runtime.stop();}});
    if(mode==="disabled")await runtime.start();else await assert.rejects(runtime.start(),{code:"OUTBOX_RESTORE_DELIVERY_SCHEMA_REQUIRED"});
    await runtime.stop();assert.equal(probes,mode==="disabled"?0:1);assert.equal(queries,mode==="disabled"?1:2);assert.equal(closed,1);assert.equal(unlocked,1);assert.ok(logs.every(line=>!line.includes("private driver")));
  }
});

test("host rejects invalid restore mode before pool construction even with custom sink",t=>{
  const original=pg.Pool;let pools=0;pg.Pool=class{constructor(){pools++;}} as unknown as typeof pg.Pool;t.after(()=>{pg.Pool=original;});
  for(const mode of ["",null,true,"v2"," record-events-v2 "]){
    assert.throws(()=>createOutboxWorkerRuntime({connectionString:"postgresql://realm_runtime@127.0.0.1/fixture",deliveryUrl:"https://delivery.example.test/events",workspaces:["ws"],...({restoreDelivery:mode} as object),sink:{async publish(){}}}),{code:"OUTBOX_RESTORE_DELIVERY_CONFIG_INVALID"});
  }
  assert.equal(pools,0);
});

test("malformed delivery state is a local poison row, not an outage hiding later candidates",async()=>{
  for(const patch of [{state:"unknown"},{revision:-1},{attempt_count:-1},{created_at:"invalid"}]){
    const d=harness([row({id:"a",...patch}),row({id:"b"})]);
    // An unknown state is not ready and is already excluded by SQL.
    const messages=await d.repo.listOutboxMessages({now,limit:2});
    assert.deepEqual(messages.map(m=>m.messageId),["b"]);assert.equal(d.invalid.length,patch.state?0:1);
  }
});

test("keyset cursor preserves database timestamp precision and C identity beyond one full page",async()=>{
  const precise="2026-10-18 00:00:00.000123+00";
  const d=harness([row({id:"a",scan_available_at:precise}),row({id:"b",scan_available_at:precise}),row({id:"c"})]);
  await d.repo.listOutboxMessages({now,limit:2});await d.repo.listOutboxMessages({now,limit:2});
  const scans=d.calls.filter(c=>c.sql.startsWith("SELECT o.id,"));
  assert.equal(scans[1].values[3],precise);assert.equal(scans[1].values[4],"b");
});

test("empty page clears the cursor; future, live leased and terminal rows are excluded before decoding",async()=>{
  const d=harness([row({id:"a"}),row({id:"b"}),row({id:"future",available_at:later,payload:7}),row({id:"live",state:"delivering",lease_expires_at:later,payload:7}),row({id:"terminal",state:"delivered",payload:7})]);
  assert.equal((await d.repo.listOutboxMessages({now,limit:2})).length,2);
  assert.deepEqual(await d.repo.listOutboxMessages({now,limit:2}),[]);
  assert.equal((await d.repo.listOutboxMessages({now,limit:2})).length,2);assert.deepEqual(d.invalid,[]);
});
test("direct claim and settle keep input validation before UPDATE",async()=>{
  for(const patch of [{leaseOwner:" "},{leaseExpiresAt:now}]){
    const d=harness();await assert.rejects(d.repo.claimOutbox({...claim,...patch}),{code:"OUTBOX_LEASE_INVALID"});assert.equal(d.calls.filter(c=>c.sql.startsWith("UPDATE")).length,0);
  }
  for(const [patch,code] of [[{outcome:"retryable"},"OUTBOX_FAILURE_REQUIRED"],[{outcome:"retryable",failure:{code:"RETRY",message:"safe",occurredAt:now}},"OUTBOX_RETRY_TIME_REQUIRED"],[{outcome:"retryable",retryAt:now,failure:{code:"RETRY",message:"safe",occurredAt:now}},"OUTBOX_RETRY_TIME_INVALID"]] as const){
    const d=harness([row({state:"delivering",revision:1,lease_owner:"worker",lease_expires_at:later})]);await assert.rejects(d.repo.settleOutbox({...settle,...patch}),{code});assert.equal(d.calls.filter(c=>c.sql.startsWith("UPDATE")).length,0);
  }
});
test("direct settle rechecks stored body and origin after claim, rather than trusting its projection",async()=>{
  for(const patch of [{payload:{recordId:"foreign",eventIds:[]}},{restore_delivery_kind:null},{topic:"forbidden"}]){
    const d=harness();await d.repo.claimOutbox(claim);Object.assign(d.rows[0],patch);
    const before=d.calls.filter(c=>c.sql.startsWith("UPDATE")).length;
    await assert.rejects(d.repo.settleOutbox(settle));assert.equal(d.calls.filter(c=>c.sql.startsWith("UPDATE")).length,before);
  }
});
