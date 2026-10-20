/** AUTHORED / NOT_RUN in development-batch-32. Real PG17 acceptance is deferred. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import pg from "pg";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { materializeGoalInstances } from "../database/postgres/goal-runtime-materialization.ts";
import { lockGoalContentWorld } from "../database/postgres/goal-content-binding-repository.ts";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { createGoalContentBindingSource } from "../modules/application/goal-content-binding-source.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";

const enabled=!!process.env.REALM_SCRATCH_POSTGRES_CONTAINER && !!process.env.DATABASE_URL && !!process.env.REALM_RUNTIME_DATABASE_URL;
const options={skip:enabled?false:"requires isolated scratch PG17 runner",timeout:120_000};
const workspaceId=POSTGRES_DEMO_IDS.workspace;const principalId=POSTGRES_DEMO_IDS.principal;
async function fixture(admin:pg.Pool,runtime:pg.Pool) {
  installTestSessionSecret();await seedCapabilitySessionKey(admin,workspaceId);
  const suffix=randomUUID().replaceAll("-","");const ids={workspaceId,worldId:`world_gct_${suffix}`,worldlineId:`line_gct_${suffix}`,storyId:`story_gct_${suffix}`,recordId:`record_gct_${suffix}`};
  await withWorkspaceTransaction(admin,workspaceId,async client=>{
    const clone=async(table:"worlds"|"worldlines"|"stories"|"records",sourceId:string,patch:object)=>{
      assert.equal((await client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND id=$3`,[JSON.stringify(patch),workspaceId,sourceId])).rowCount,1);
    };
    await clone("worlds",POSTGRES_DEMO_IDS.world,{id:ids.worldId,world_version:"0.0.0-local",status:"active"});
    await clone("worldlines",POSTGRES_DEMO_IDS.worldline,{id:ids.worldlineId,world_id:ids.worldId,status:"active",head_tick:0,head_ordinal:0});
    await clone("stories",POSTGRES_DEMO_IDS.story,{id:ids.storyId,world_id:ids.worldId,worldline_id:ids.worldlineId});
    await clone("records",POSTGRES_DEMO_IDS.record,{id:ids.recordId,world_id:ids.worldId,worldline_id:ids.worldlineId,story_id:ids.storyId,
      world_version:"0.0.0-local",status:"active",timeline_kind:"primary",linked_record_id:null,start_tick:0,start_ordinal:0});
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')",[workspaceId,ids.worldId,principalId]);
    await client.query(`INSERT INTO record_heads(workspace_id,world_id,worldline_id,record_id,record_version,next_record_ordinal)
      VALUES($1,$2,$3,$4,0,0)`,[workspaceId,ids.worldId,ids.worldlineId,ids.recordId]);
  });
  const resolve=createGoalContentBindingSource();const sessionProof=sessionProofFor(principalId);
  await withWorkspaceTransaction(runtime,workspaceId,async client=>{
    await lockGoalContentWorld(client,workspaceId,ids.worldId);
    for(const scope of [
      {kind:"record" as const,workspaceId:ids.workspaceId,worldId:ids.worldId,worldlineId:ids.worldlineId,recordId:ids.recordId},
      {kind:"story" as const,workspaceId:ids.workspaceId,worldId:ids.worldId,worldlineId:ids.worldlineId,storyId:ids.storyId},
      {kind:"worldline" as const,workspaceId:ids.workspaceId,worldId:ids.worldId,worldlineId:ids.worldlineId},
    ]) {
      await materializeGoalInstances(client,scope,[{goalKey:"base.first-narration",policyVersion:"base-v1"}],{sessionProof,worldVersion:"0.0.0-local",resolveSource:resolve});
    }
  });
  return {...ids,sessionProof,resolve};
}

test("V2 real export/ZIP/parse/restore/reexport/second restore and fresh-process durable three-scope consumption",options,async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL,max:3});
  t.after(async()=>{await runtime.end();await admin.end();});const ids=await fixture(admin,runtime);
  const reader=createPostgresRealmRuntimeSaveReader(runtime,{goalsSchemaVersion:2,resolveGoalSource:ids.resolve});
  const first=await reader.load({workspaceId,principalId,recordId:ids.recordId,purpose:"record-export"});assert.ok(first);
  const archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(first),{goalsSchemaVersion:2});assert.equal(archive.goals.schemaVersion,2);
  const restore=createPostgresRealmRuntimeSaveRestorer(runtime,{goalsSchemaVersion:2,resolveGoalSource:ids.resolve});
  const input={workspaceId,principalId,sessionProof:ids.sessionProof,targetWorldId:ids.worldId,archive,idempotencyKey:`pg-gct-${randomUUID()}`};
  // Both calls perform the actual SQL; World locking serializes admission and replay.
  const results=await Promise.all([restore.restore(input),restore.restore(input)]);
  assert.equal(results.filter(r=>r.replayed).length,1);const target=results[0];
  assert.equal(target.importedGoalInstanceCount,3);
  const secondSave=await reader.load({workspaceId,principalId,recordId:target.recordId,purpose:"record-export"});assert.ok(secondSave);
  const secondArchive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(secondSave),{goalsSchemaVersion:2});
  const second=await restore.restore({...input,archive:secondArchive,idempotencyKey:`pg-gct-second-${randomUUID()}`});
  assert.equal(second.importedGoalInstanceCount,3);
  const scope={workspaceId,worldId:ids.worldId,worldlineId:second.worldlineId};
  const output=await new Promise<string>((resolve,reject)=>{
    const child=spawn(process.execPath,["--experimental-strip-types","tests/helpers/goal-binding-fresh-process-child.ts"],{
      cwd:process.cwd(),env:{...process.env,REALM_GOAL_DISCOVERY_SCOPE:JSON.stringify(scope)},stdio:["ignore","pipe","pipe"]});
    let stdout="";let stderr="";child.stdout.on("data",chunk=>{stdout+=String(chunk);});child.stderr.on("data",chunk=>{stderr+=String(chunk);});
    child.once("error",reject);child.once("exit",code=>code===0?resolve(stdout):reject(new Error(`scratch child exited ${code}: ${stderr}`)));
  });
  assert.deepEqual(JSON.parse(output),{count:3,kinds:["record","story","worldline"]});
  await withWorkspaceTransaction(admin,workspaceId,async client=>{
    const groups=await client.query(`SELECT group_plan->'bodyVersion' AS version,count(*)::integer AS members
      FROM record_goal_restore_admissions WHERE workspace_id=$1 AND group_root=$2 GROUP BY group_plan->'bodyVersion'`,[workspaceId,target.recordId]);
    assert.deepEqual(groups.rows,[{version:2,members:1}]);
  });
});

test("V2 real rollback at binding leaves no topology/admissions and same-key replay rechecks source and membership",options,async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  t.after(async()=>{await runtime.end();await admin.end();});const ids=await fixture(admin,runtime);
  const saved=await createPostgresRealmRuntimeSaveReader(runtime,{goalsSchemaVersion:2,resolveGoalSource:ids.resolve}).load({workspaceId,principalId,recordId:ids.recordId,purpose:"record-export"});assert.ok(saved);
  const archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(saved),{goalsSchemaVersion:2});
  const input={workspaceId,principalId,sessionProof:ids.sessionProof,targetWorldId:ids.worldId,archive,idempotencyKey:`pg-rollback-${randomUUID()}`};
  const before=await withWorkspaceTransaction(admin,workspaceId,async client=>(await client.query("SELECT id FROM worldlines WHERE workspace_id=$1 AND world_id=$2 ORDER BY id",[workspaceId,ids.worldId])).rows);
  // Fail one actual query on the real transaction client. Every earlier SQL runs on PG.
  const failBind={async connect(){const client=await runtime.connect();return new Proxy(client,{get(target,key){
    if(key==="query")return (sql:string,values?:unknown[])=>sql==="SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)"?Promise.reject(new Error("injected-bind-failure")):target.query(sql,values);
    const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
  }});}};
  await assert.rejects(createPostgresRealmRuntimeSaveRestorer(failBind as never,{goalsSchemaVersion:2,resolveGoalSource:ids.resolve}).restore(input),/injected-bind-failure/);
  await withWorkspaceTransaction(admin,workspaceId,async client=>{
    assert.deepEqual((await client.query("SELECT id FROM worldlines WHERE workspace_id=$1 AND world_id=$2 ORDER BY id",[workspaceId,ids.worldId])).rows,before);
    assert.equal((await client.query("SELECT record_id FROM record_goal_restore_admissions WHERE workspace_id=$1 AND world_id=$2",[workspaceId,ids.worldId])).rowCount,0);
  });
  let revoked=false;const resolver:typeof ids.resolve=async request=>{if(revoked)throw new Error("source-revoked");return ids.resolve(request);};
  const restorer=createPostgresRealmRuntimeSaveRestorer(runtime,{goalsSchemaVersion:2,resolveGoalSource:resolver});
  const result=await restorer.restore(input);assert.equal(result.replayed,false);revoked=true;await assert.rejects(restorer.restore(input));revoked=false;
  await withWorkspaceTransaction(admin,workspaceId,client=>client.query("UPDATE player_world_memberships SET role='player' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3",[workspaceId,ids.worldId,principalId]));
  await assert.rejects(restorer.restore(input),{code:"WORLD_READ_ONLY"});
});

test("V2 PG deferred completeness rejects an omitted member and an early-check late mutation",options,async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  t.after(async()=>{await runtime.end();await admin.end();});const ids=await fixture(admin,runtime);
  const saved=await createPostgresRealmRuntimeSaveReader(runtime,{goalsSchemaVersion:2,resolveGoalSource:ids.resolve}).load({workspaceId,principalId,recordId:ids.recordId,purpose:"record-export"});assert.ok(saved);
  const archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(saved),{goalsSchemaVersion:2});
  for(const mode of ["omit","late-change"] as const) {
    let goalId:string|undefined;const sabotaged={async connect(){const client=await runtime.connect();return new Proxy(client,{get(target,key){
      if(key==="query")return async(sql:string,values?:unknown[])=>{
        if(sql.startsWith("INSERT INTO goal_instances (") && values?.[3]==="worldline") {goalId=String(values[6]);if(mode==="omit")return {rows:[],rowCount:0};}
        if(sql==="COMMIT" && mode==="late-change" && goalId!==undefined) {
          await target.query("SET CONSTRAINTS ALL IMMEDIATE");await target.query("SET CONSTRAINTS ALL DEFERRED");
          await target.query("UPDATE goal_instances SET progress=$3::jsonb WHERE workspace_id=$1 AND id=$2",[workspaceId,goalId,JSON.stringify({late:true})]);
        }
        return target.query(sql,values);
      };
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});}};
    await assert.rejects(createPostgresRealmRuntimeSaveRestorer(sabotaged as never,{goalsSchemaVersion:2,resolveGoalSource:ids.resolve}).restore({
      workspaceId,principalId,sessionProof:ids.sessionProof,targetWorldId:ids.worldId,archive,idempotencyKey:`pg-${mode}-${randomUUID()}`}));
  }
});
