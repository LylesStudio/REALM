/** SOURCE ONLY / NOT_RUN. Official disposable serial PG runner and new clearance required. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { authorizeProjectFinanceWrite } from "../app/api/bridge/v1/project-finance-context.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { normalizeGenesisDraft } from "../modules/application/world-genesis-contract.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { installTestSessionSecret, sessionProofFor } from "./helpers/session-proof.ts";

const options = { skip: !process.env.DATABASE_URL || !process.env.REALM_RUNTIME_DATABASE_URL ? "requires cleared disposable serial PostgreSQL" : false, timeout: 120_000 };
const workspaceId=POSTGRES_DEMO_IDS.workspace, principalId=POSTGRES_DEMO_IDS.principal;
async function begin(c:PoolClient, repeatable=false) {
  await c.query(`BEGIN ISOLATION LEVEL ${repeatable ? "REPEATABLE READ" : "READ COMMITTED"}`);
  await c.query("SELECT set_config('realm.workspace_id',$1,true)",[workspaceId]);
  await c.query("SET LOCAL statement_timeout='15s'");
}
async function blockedPids(observer:PoolClient,w:number,b:number) {
  const deadline=Date.now()+5_000;
  while(Date.now()<deadline)if((await observer.query("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked",[w,b])).rows[0].blocked)return;
  assert.fail("required actual backend lock barrier was not observed");
}
async function fixture(t:test.TestContext) {
  assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"),"official disposable runner required before connect");
  installTestSessionSecret();
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
  const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL,max:2});
  // The disposable runner destroys this fixture's immutable runtime history.
  t.after(async()=>{try{await runtime.end();}finally{await admin.end();}});
  const actor={workspaceId,principalId,sessionProof:sessionProofFor(principalId)};
  const draft=normalizeGenesisDraft({world:{name:`Authority ${randomUUID()}`},playerStance:"player",scene:{objective:"Inspect the authority gate"},opening:"The sealed letter is still here.",recordGoals:[{title:"Keep the letter",description:"Deliver the original letter",successConditions:["Letter delivered"],failureConditions:[],settlementConditions:[],changePolicy:"fixed",visible:true}]});
  assert.ok(draft);
  const created=await createPostgresLibraryService(runtime).createGenesis(actor,draft,{creationRequestId:`authority_${randomUUID()}`});
  const line=(await admin.query("SELECT worldline_id FROM records WHERE workspace_id=$1 AND id=$2",[workspaceId,created.recordId])).rows[0].worldline_id as string;
  const scope={workspaceId,worldId:created.worldId,worldlineId:line};
  return {admin,runtime,actor,created,scope};
}

test("authority PG catalog preserves runtime membership refusal, definer ownership/RLS, exact workspace/principal and roles",options,async t=>{
  const f=await fixture(t);const c=await f.runtime.connect();
  try {
    const catalog=(await f.admin.query(`SELECT p.prosecdef,p.proconfig,r.rolname,r.rolcanlogin,r.rolbypassrls,
      has_function_privilege('realm_runtime',p.oid,'EXECUTE') AS runtime_execute,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='public.bridge_command_membership_role(text,text,text)'::regprocedure`)).rows[0];
    assert.equal(catalog.prosecdef,true);assert.deepEqual(catalog.proconfig,["search_path=pg_catalog, public"]);
    assert.equal(catalog.rolname,"realm_capability");assert.equal(catalog.rolcanlogin,false);assert.equal(catalog.rolbypassrls,false);
    assert.equal(catalog.runtime_execute,true);assert.equal(catalog.public_execute,false);
    const grants=(await f.admin.query(`SELECT has_column_privilege('realm_runtime','player_world_memberships','role','UPDATE') AS runtime_update,
      has_table_privilege('realm_runtime','player_world_memberships','DELETE') AS runtime_delete,
      has_column_privilege('realm_capability','player_world_memberships','role','UPDATE') AS capability_lock,
      (SELECT relforcerowsecurity FROM pg_class WHERE oid='player_world_memberships'::regclass) AS forced`)).rows[0];
    assert.deepEqual(grants,{runtime_update:false,runtime_delete:false,capability_lock:true,forced:true});
    for(const role of ["owner","player","observer"]){
      await f.admin.query("UPDATE player_world_memberships SET role=$4 WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3",[workspaceId,f.scope.worldId,principalId,role]);
      await begin(c);
      const call=authorizeProjectFinanceWrite(c,{scope:f.scope,principalId});
      if(role==='observer')await assert.rejects(call,{code:'FORBIDDEN'});else await call;
      await c.query("ROLLBACK");
    }
    await begin(c);await assert.rejects(authorizeProjectFinanceWrite(c,{scope:f.scope,principalId:`principal_absent_${randomUUID()}`}),{code:"WORLD_NOT_FOUND"});await c.query("ROLLBACK");
    await begin(c);await assert.rejects(c.query("SELECT public.bridge_command_membership_role($1,$2,$3)",["foreign_workspace",f.scope.worldId,principalId]),/WORKSPACE_SCOPE_MISMATCH/);await c.query("ROLLBACK");
    await begin(c);await assert.rejects(c.query("SELECT role FROM player_world_memberships WHERE workspace_id=$1 AND world_id=$2 FOR SHARE",[workspaceId,f.scope.worldId]),{code:"42501"});await c.query("ROLLBACK");
    await begin(c);await assert.rejects(authorizeProjectFinanceWrite(c,{scope:{...f.scope,worldlineId:POSTGRES_DEMO_IDS.worldline},principalId}),{code:"FORBIDDEN"});await c.query("ROLLBACK");
    // Re-enable a legitimate writer, then ensure the wrong World's line cannot pass.
    await f.admin.query("UPDATE player_world_memberships SET role='owner' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3",[workspaceId,f.scope.worldId,principalId]);
    await begin(c);await assert.rejects(authorizeProjectFinanceWrite(c,{scope:{...f.scope,worldlineId:POSTGRES_DEMO_IDS.worldline},principalId}),{code:"WORLD_NOT_FOUND"});await c.query("ROLLBACK");
  }finally{await c.query("ROLLBACK");c.release();}
});

test("authority PG archive before/after lock and rollback expose no writable archived World",options,async t=>{
  const f=await fixture(t);const [writer,archiver,observer]=await Promise.all([f.runtime.connect(),f.admin.connect(),f.admin.connect()]);
  try{
    const writerPid=Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const archiverPid=Number((await archiver.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await archiver.query("UPDATE worlds SET status='archived' WHERE workspace_id=$1 AND id=$2",[workspaceId,f.scope.worldId]);
    await begin(writer);await assert.rejects(authorizeProjectFinanceWrite(writer,{scope:f.scope,principalId}),{code:"WORLD_ARCHIVED"});await writer.query("ROLLBACK");
    await archiver.query("UPDATE worlds SET status='active' WHERE workspace_id=$1 AND id=$2",[workspaceId,f.scope.worldId]);
    await begin(writer);await authorizeProjectFinanceWrite(writer,{scope:f.scope,principalId});await begin(archiver);
    const archive=archiver.query("UPDATE worlds SET status='archived' WHERE workspace_id=$1 AND id=$2",[workspaceId,f.scope.worldId]).then(()=>null,e=>e);
    await blockedPids(observer,archiverPid,writerPid);await writer.query("ROLLBACK");assert.equal(await archive,null);await archiver.query("COMMIT");
    await begin(writer);await assert.rejects(authorizeProjectFinanceWrite(writer,{scope:f.scope,principalId}),{code:"WORLD_ARCHIVED"});await writer.query("ROLLBACK");
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM committed_fact_commands WHERE workspace_id=$1 AND world_id=$2",[workspaceId,f.scope.worldId])).rows[0].n,0);
  }finally{await Promise.all([writer.query("ROLLBACK"),archiver.query("ROLLBACK")]);writer.release();archiver.release();observer.release();}
});

test("authority PG real native Goal branch versus command locks World before source Record, both directions, rollback removes branch",options,async t=>{
  const f=await fixture(t);const [command,branch,observer]=await Promise.all([f.runtime.connect(),f.runtime.connect(),f.admin.connect()]);
  const key=`authority_branch_${randomUUID()}`;
  try{
    const commandPid=Number((await command.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const branchPid=Number((await branch.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await begin(command);await authorizeProjectFinanceWrite(command,{scope:f.scope,principalId});await begin(branch,true);
    const pending=createPostgresLibraryService(branch).branchRecord(f.actor,{sourceRecordId:f.created.recordId,idempotencyKey:key}).then(value=>({value,error:null}),error=>({value:null,error}));
    await blockedPids(observer,branchPid,commandPid);
    // This would deadlock/time out with the old KEY SHARE -> Record -> World upgrade.
    await command.query("SELECT id FROM records WHERE workspace_id=$1 AND id=$2 FOR UPDATE",[workspaceId,f.created.recordId]);
    await command.query("ROLLBACK");const result=await pending;assert.equal(result.error,null);assert.ok(result.value);
    const target=result.value.recordId;
    assert.equal((await branch.query("SELECT count(*)::int AS n FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2",[workspaceId,target])).rows[0].n,1);
    await begin(command);
    const auth=authorizeProjectFinanceWrite(command,{scope:f.scope,principalId}).then(()=>null,e=>e);
    await blockedPids(observer,commandPid,branchPid);await branch.query("ROLLBACK");assert.equal(await auth,null);await command.query("ROLLBACK");
    assert.equal((await observer.query("SELECT count(*)::int AS n FROM records WHERE workspace_id=$1 AND id=$2",[workspaceId,target])).rows[0].n,0);
  }finally{await Promise.all([command.query("ROLLBACK"),branch.query("ROLLBACK")]);command.release();branch.release();observer.release();}
});
