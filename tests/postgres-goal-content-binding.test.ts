/** AUTHORED / NOT_RUN in development-batch-32. Only the isolated scratch runner may execute this spec. */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { materializeGoalInstances } from "../database/postgres/goal-runtime-materialization.ts";
import { lockGoalContentWorld, prepareGoalContentWrites } from "../database/postgres/goal-content-binding-repository.ts";
import { bindGoalContentWitness, createGoalContentBindingSource } from "../modules/application/goal-content-binding-source.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";

const enabled=!!process.env.REALM_SCRATCH_POSTGRES_CONTAINER && !!process.env.DATABASE_URL && !!process.env.REALM_RUNTIME_DATABASE_URL;
const options={skip:enabled?false:"requires isolated scratch PG17 runner",timeout:120_000};
const workspaceId=POSTGRES_DEMO_IDS.workspace;
const principalId=POSTGRES_DEMO_IDS.principal;
const resolve=createGoalContentBindingSource();
async function fixture(admin:pg.Pool) {
  installTestSessionSecret(); await seedCapabilitySessionKey(admin,workspaceId);
  const suffix=randomUUID().replaceAll("-","");
  const ids={workspaceId,worldId:`world_gcb_${suffix}`,worldlineId:`line_gcb_${suffix}`,storyId:`story_gcb_${suffix}`,recordId:`record_gcb_${suffix}`};
  await withWorkspaceTransaction(admin,workspaceId,async client=>{
    const clone=async(table:"worlds"|"worldlines"|"stories"|"records",sourceId:string,patch:object)=>{
      const inserted=await client.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).*
        FROM ${table} source WHERE workspace_id=$2 AND id=$3`,[JSON.stringify(patch),workspaceId,sourceId]);
      assert.equal(inserted.rowCount,1);
    };
    await clone("worlds",POSTGRES_DEMO_IDS.world,{id:ids.worldId,world_version:"0.0.0-local",status:"active"});
    await clone("worldlines",POSTGRES_DEMO_IDS.worldline,{id:ids.worldlineId,world_id:ids.worldId,status:"active",head_tick:0,head_ordinal:0});
    await clone("stories",POSTGRES_DEMO_IDS.story,{id:ids.storyId,world_id:ids.worldId,worldline_id:ids.worldlineId});
    await clone("records",POSTGRES_DEMO_IDS.record,{id:ids.recordId,world_id:ids.worldId,worldline_id:ids.worldlineId,story_id:ids.storyId,
      world_version:"0.0.0-local",status:"active",timeline_kind:"primary",linked_record_id:null,start_tick:0,start_ordinal:0});
    await client.query("INSERT INTO player_world_memberships(workspace_id,world_id,principal_id,role) VALUES($1,$2,$3,'owner')",[workspaceId,ids.worldId,principalId]);
  });
  return ids;
}

test("0083 real runtime ACL, FORCE RLS and proof-bound three-owner materialization",options,async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL}); const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  t.after(async()=>{await runtime.end();await admin.end();}); const ids=await fixture(admin);
  const acl=await admin.query(`SELECT has_table_privilege('realm_runtime','goal_content_instance_bindings','SELECT') AS reads,
    has_table_privilege('realm_runtime','goal_content_instance_bindings','INSERT') AS writes,
    has_table_privilege('realm_runtime','goal_content_write_admissions','SELECT,INSERT') AS admissions,
    (SELECT rolbypassrls FROM pg_roles WHERE rolname='realm_goal_authoring') AS bypass`);
  assert.deepEqual(acl.rows,[{reads:true,writes:false,admissions:false,bypass:false}]);
  const policy=await admin.query(`SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='goal_content_instance_bindings'::regclass`);
  assert.deepEqual(policy.rows,[{relrowsecurity:true,relforcerowsecurity:true}]);
  const sessionProof=sessionProofFor(principalId);
  await withWorkspaceTransaction(runtime,workspaceId,async client=>{
    await lockGoalContentWorld(client,workspaceId,ids.worldId);
    for(const scope of [
      {kind:"record" as const,workspaceId:ids.workspaceId,worldId:ids.worldId,worldlineId:ids.worldlineId,recordId:ids.recordId},
      {kind:"story" as const,workspaceId:ids.workspaceId,worldId:ids.worldId,worldlineId:ids.worldlineId,storyId:ids.storyId},
      {kind:"worldline" as const,workspaceId:ids.workspaceId,worldId:ids.worldId,worldlineId:ids.worldlineId},
    ]) {
      await materializeGoalInstances(client,scope,[{goalKey:"base.first-narration",policyVersion:"base-v1"}],
        {sessionProof,worldVersion:"0.0.0-local",resolveSource:resolve});
    }
  });
  await withWorkspaceTransaction(runtime,workspaceId,async client=>{
    const rows=await client.query("SELECT scope_kind,record_id,story_id FROM goal_content_instance_bindings WHERE workspace_id=$1 AND world_id=$2 ORDER BY scope_kind",[workspaceId,ids.worldId]);
    assert.deepEqual(rows.rows,[{scope_kind:"record",record_id:ids.recordId,story_id:null},{scope_kind:"story",record_id:null,story_id:ids.storyId},{scope_kind:"worldline",record_id:null,story_id:null}]);
  });
  await withWorkspaceTransaction(runtime,"workspace_gcb_other",async client=>{
    assert.equal((await client.query("SELECT goal_instance_id FROM goal_content_instance_bindings WHERE world_id=$1",[ids.worldId])).rowCount,0);
  });
  await assert.rejects(withWorkspaceTransaction(runtime,workspaceId,client=>client.query(`INSERT INTO goal_content_instance_bindings
    SELECT * FROM goal_content_instance_bindings WHERE false`)),{code:"42501"});
  await assert.rejects(withWorkspaceTransaction(runtime,workspaceId,client=>client.query(`INSERT INTO goal_instances
    (workspace_id,world_id,worldline_id,record_id,id,goal_key,policy_version) VALUES($1,$2,$3,$4,$5,'raw','p1')`,
    [workspaceId,ids.worldId,ids.worldlineId,ids.recordId,`raw_${randomUUID()}`])),/GOAL_CONTENT_PROOF_REQUIRED/);
});

test("0083 deferred admission/FK/binding failures rollback every original row and admission",options,async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL});
  t.after(async()=>{await runtime.end();await admin.end();});const ids=await fixture(admin);const sessionProof=sessionProofFor(principalId);
  const witness=await resolve({worldId:ids.worldId,worldVersion:"0.0.0-local",goalKey:"base.first-narration"});
  for(const writeInstance of [false,true]) {
    const id=`deferred_${randomUUID()}`;const binding=bindGoalContentWitness(witness,workspaceId,{scopeKind:"record",worldId:ids.worldId,worldlineId:ids.worldlineId,recordId:ids.recordId},id);
    await assert.rejects(withWorkspaceTransaction(runtime,workspaceId,async client=>{
      await lockGoalContentWorld(client,workspaceId,ids.worldId);
      await prepareGoalContentWrites(client,{workspaceId,sessionProof,operation:"materialize",bindings:[binding],body:{ids,id}});
      if(writeInstance) await client.query(`INSERT INTO goal_instances(workspace_id,world_id,worldline_id,record_id,id,goal_key,policy_version)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[workspaceId,ids.worldId,ids.worldlineId,ids.recordId,id,binding.goalKey,binding.policyVersion]);
      await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    }));
    await withWorkspaceTransaction(admin,workspaceId,async client=>{
      assert.equal((await client.query("SELECT id FROM goal_instances WHERE workspace_id=$1 AND id=$2",[workspaceId,id])).rowCount,0);
      assert.equal((await client.query("SELECT goal_instance_id FROM goal_content_write_admissions WHERE workspace_id=$1 AND goal_instance_id=$2",[workspaceId,id])).rowCount,0);
    });
  }
});

test("0083 World-first competing materializations serialize and revoked membership cannot acquire admission",options,async t=>{
  const admin=new pg.Pool({connectionString:process.env.DATABASE_URL});const runtime=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL,max:2});
  t.after(async()=>{await runtime.end();await admin.end();});const ids=await fixture(admin);const sessionProof=sessionProofFor(principalId);
  const write=()=>withWorkspaceTransaction(runtime,workspaceId,async client=>{
    await lockGoalContentWorld(client,workspaceId,ids.worldId);
    return materializeGoalInstances(client,{kind:"record",...ids},[{goalKey:"base.first-narration",policyVersion:"base-v1"}],{sessionProof,worldVersion:"0.0.0-local",resolveSource:resolve});
  });
  const results=await Promise.allSettled([write(),write()]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  await withWorkspaceTransaction(admin,workspaceId,client=>client.query("UPDATE player_world_memberships SET role='player' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3",[workspaceId,ids.worldId,principalId]));
  await assert.rejects(write());
  await withWorkspaceTransaction(admin,workspaceId,async client=>{
    assert.equal((await client.query("SELECT id FROM goal_instances WHERE workspace_id=$1 AND world_id=$2",[workspaceId,ids.worldId])).rowCount,1);
    assert.equal((await client.query("SELECT goal_instance_id FROM goal_content_write_admissions WHERE workspace_id=$1 AND world_id=$2",[workspaceId,ids.worldId])).rowCount,1);
  });
});
