import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as context from "../app/api/bridge/v1/project-finance-context.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { lockWorkspaceCommandKey } from "../database/postgres/workspace-transaction.ts";
type Client = Parameters<typeof lockWorkspaceCommandKey>[0];
const scope = { workspaceId: "ws", worldId: "world", worldlineId: "line" };

test("authority candidate has fixed least-privilege definer and no membership mutation", () => {
  const sql = readFileSync(new URL("../database/postgres/migrations/0078_bridge_command_write_authorization.sql", import.meta.url), "utf8");
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  assert.match(sql, /public\.player_world_memberships/);
  assert.match(sql, /current_setting\('realm.workspace_id', true\)/);
  assert.match(sql, /FOR SHARE/);
  assert.match(sql, /OWNER TO realm_capability/);
  assert.match(sql, /REVOKE ALL ON FUNCTION[^;]+FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION[^;]+TO realm_runtime/);
  assert.doesNotMatch(sql, /(?:INSERT INTO|UPDATE public\.|DELETE FROM|CREATE TABLE|GRANT (?:UPDATE|SELECT|ALL) ON)/i);
});

test("command authorizes exact scope/principal with separate ordered locks and role/status refusal", async () => {
  const authorize = (context as unknown as {authorizeProjectFinanceWrite:(c:Client,x:unknown)=>Promise<void>}).authorizeProjectFinanceWrite;
  assert.equal(typeof authorize,"function");
  for (const [role,world,line,expected] of [["owner","active","active",null],["player","active","active",null],["observer","active","active","FORBIDDEN"],[null,"active","active","WORLD_NOT_FOUND"],["owner","archived","active","WORLD_ARCHIVED"],["owner","active","frozen","WORLDLINE_NOT_WRITABLE"]] as const) {
    const trace:{sql:string;values:unknown[]}[]=[];
    const client={async query(sql:string,values:unknown[]){trace.push({sql,values}); if(sql.includes("FROM worlds"))return {rows:[{status:world}]};if(sql.includes("bridge_command_membership_role"))return {rows:[{role}]};if(sql.includes("FROM worldlines"))return {rows:[{status:line}]};throw Error(sql);}} as unknown as Client;
    const call=authorize(client,{scope,principalId:"server-principal"});
    if(expected)await assert.rejects(call,{code:expected});else await call;
    assert.match(trace[0]!.sql,/FROM worlds[\s\S]+FOR SHARE/);
    assert.deepEqual(trace[0]!.values,[scope.workspaceId,scope.worldId]);
    if(trace[1])assert.deepEqual(trace[1].values,[scope.workspaceId,scope.worldId,"server-principal"]);
    if(trace[2]) {assert.match(trace[2].sql,/FROM worldlines[\s\S]+FOR UPDATE/);assert.deepEqual(trace[2].values,[scope.workspaceId,scope.worldId,scope.worldlineId]);}
    assert.ok(trace.every(x=>!x.sql.includes("FOR SHARE OF membership")));
  }
});

test("actual branch acquires sufficient World lock before source Record and head while preserving RR",async()=>{
  const trace:string[]=[];const STOP=Error("stop before goals/snapshot");
  const client={release(){},async query(sql:string){trace.push(sql);
    if(sql.includes("transaction_isolation"))return {rows:[{isolation_level:"repeatable read",read_only:"off"}],rowCount:1};
    if(sql.includes("current_setting('realm.workspace_id'"))return {rows:[{workspace_id:"ws"}],rowCount:1};
    if(sql.includes("SELECT world_id FROM records"))return {rows:[{world_id:"world"}],rowCount:1};
    if(sql.includes("FROM player_world_memberships"))return {rows:[{role:"player"}],rowCount:1};
    if(sql.includes("SELECT status FROM worlds"))return {rows:[{status:"active"}],rowCount:1};
    if(sql.includes("FOR UPDATE OF record"))return {rows:[{worldline_id:"line",story_id:"story",world_version:"local",record_title:"Record",record_status:"active",story_title:"Story",story_premise:"",start_tick:"0",start_ordinal:"0",observer:false,player_role:""}],rowCount:1};
    if(sql.includes("FROM record_heads"))return {rows:[{last_world_tick:"0",last_world_ordinal:"0"}],rowCount:1};
    if(sql.includes("FROM goal_instances"))throw STOP;
    return {rows:[],rowCount:0};}} as unknown as Client;
  await assert.rejects(createPostgresLibraryService(client).branchRecord({workspaceId:"ws",principalId:"principal",sessionProof:"probe"},{sourceRecordId:"record",idempotencyKey:"key"}),e=>e===STOP);
  const locks=trace.filter(sql=>/FOR (UPDATE|KEY SHARE|SHARE)/.test(sql));
  assert.match(locks[0]!,/FROM worlds[\s\S]+FOR UPDATE/);
  assert.match(locks[1]!,/FOR UPDATE OF record/);
  assert.match(locks[2]!,/FROM record_heads[\s\S]+FOR UPDATE/);
});

test("authority PG fixture leaves immutable history disposal to the disposable runner", () => {
  const source = readFileSync(new URL("./postgres-parallel-command-authority-regression.test.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function fixture(");
  const end = source.indexOf("\ntest(", start);
  assert.ok(start >= 0 && end > start);
  const fixture = source.slice(start, end);
  assert.doesNotMatch(fixture, /\bDELETE\s+FROM\s+worlds\b/i,
    "World deletion cascades into immutable authored Goal history; the disposable runner must own data disposal.");
});

test("authority PG fixture registers every owned pool finalizer before fallible setup", () => {
  const source = readFileSync(new URL("./postgres-parallel-command-authority-regression.test.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function fixture(");
  const end = source.indexOf("\ntest(", start);
  assert.ok(start >= 0 && end > start);
  const fixture = source.slice(start, end);
  const hook = fixture.indexOf("t.after(");
  assert.ok(hook > fixture.indexOf("const runtime=new pg.Pool"));
  assert.ok(hook < fixture.indexOf("normalizeGenesisDraft("),
    "Pool shutdown must already be registered if draft normalization or creation fails.");
  assert.match(fixture, /try\s*\{\s*await runtime\.end\(\);\s*\}\s*finally\s*\{\s*await admin\.end\(\);\s*\}/);
});
