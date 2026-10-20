/** AUTHORED / PG NOT_RUN. Only the disposable PG runner may execute this spec.
 * Stateful core doubles do not execute any of these SQL predicates or privileges. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { POSTGRES_DEMO_IDS, seedPostgresDemo } from "../database/postgres/demo-seed.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { createCommittedFactCommandService } from "../modules/application/committed-fact-command.ts";
import { createPerformanceCommandTrust, executePerformanceAssessmentCommand } from "../modules/application/performance-command-executor.ts";
import { buildRealmRuntimeSaveArchive,parseRealmRuntimeSaveArchive,realmRuntimeSaveManifestFromData,normalizeRealmRuntimeSaveEventForRestore } from "../modules/world-transfer/realm-runtime-save.ts";
import { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } from "./helpers/session-proof.ts";
import { hasPerformanceRestoreTarget } from "../database/postgres/runtime-restore-v3.ts";
import { executeRecordGoalCommand } from "../modules/application/record-goal-command.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { createGoalContentBindingSource } from "../modules/application/goal-content-binding-source.ts";
import { materializeGoalInstances } from "../database/postgres/goal-runtime-materialization.ts";
import { lockGoalContentWorld } from "../database/postgres/goal-content-binding-repository.ts";
import { goalEvidenceSnapshotHash } from "../modules/goals/public.ts";
import { decodeRecordGoalDefinition } from "../modules/goals/record-authoring.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { POST as postFactCommand } from "../app/api/bridge/v1/facts/commands/route.ts";
import { POST as postRuntimeSave } from "../app/api/record/save/route.ts";
import { POST as postRuntimeBackup } from "../app/api/record/backup/route.ts";
import { POST as postRuntimeRestore } from "../app/api/record/restore/route.ts";

function scratch(value: string | undefined): string {
  assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"));
  assert.ok(value);const url=new URL(value);
  assert.ok(["postgres:","postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1","localhost","::1"].includes(url.hostname.replace(/^\[|\]$/g,"")));
  assert.ok(url.pathname.length>1);return value;
}
const declared={goalsSchemaVersion:2 as const,performanceWitnessesSchemaVersion:1 as const};

test("0085 real SQL installation, role/RLS/read-grant negatives, durable consumer, replay and second restore",async t=>{
  const ownerUrl=scratch(process.env.DATABASE_URL),runtimeUrl=scratch(process.env.REALM_RUNTIME_DATABASE_URL);
  for(const key of ["hostname","port","pathname"] as const)assert.equal(new URL(ownerUrl)[key],new URL(runtimeUrl)[key]);
  const owner=new pg.Pool({connectionString:ownerUrl,max:1}),runtime=new pg.Pool({connectionString:runtimeUrl,max:2});
  t.after(async()=>{await endSharedRuntimePools();await runtime.end();await owner.end();});
  const directory=new URL("../database/postgres/migrations/",import.meta.url);
  const files=(await readdir(directory)).filter(p=>p.endsWith(".sql")).sort();assert.equal(files.length,86);
  const installed=await owner.query("SELECT filename,checksum FROM realm_schema_migrations ORDER BY filename");
  assert.deepEqual(installed.rows.map(r=>r.filename),files);
  for(const r of installed.rows)assert.equal(r.checksum,createHash("sha256").update(await readFile(new URL(r.filename,directory))).digest("hex"));
  const role=await owner.query("SELECT rolbypassrls,rolsuper FROM pg_roles WHERE rolname='realm_goal_authoring'");
  assert.deepEqual(role.rows,[{rolbypassrls:false,rolsuper:false}]);
  const suffix=randomUUID().replaceAll("-","");
  const sourceWorkspace=`pv3_source_${suffix}`,workspaceId=`pv3_target_${suffix}`,historical=`principal_pv3_historical_${suffix}`,principalId=`principal_pv3_operator_${suffix}`;
  await seedPostgresDemo(owner,{workspaceId:sourceWorkspace,principalId:historical});
  await seedPostgresDemo(owner,{workspaceId,principalId});
  installTestSessionSecret();await seedCapabilitySessionKey(owner,workspaceId);await seedCapabilitySessionKey(owner,sourceWorkspace);
  const sourceScope={workspaceId:sourceWorkspace,worldId:POSTGRES_DEMO_IDS.world,worldlineId:POSTGRES_DEMO_IDS.worldline};
  const accepted=await executePerformanceAssessmentCommand(runtime,{...createPerformanceCommandTrust(sourceScope,historical),enablement:{schema:true,durableTransport:true}},
    {recordId:POSTGRES_DEMO_IDS.record,policyVersion:"structured-factors:v1",evidenceEventIds:[POSTGRES_DEMO_IDS.openingEvent],idempotencyKey:`accepted_${suffix}`});
  const reader=createPostgresRealmRuntimeSaveReader(runtime,declared);
  const saved=await reader.load({workspaceId:sourceWorkspace,principalId:historical,recordId:POSTGRES_DEMO_IDS.record,purpose:"record-export"});assert.ok(saved);
  const archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(saved),{goalsSchemaVersion:2});assert.ok(archive.performanceWitnesses);
  const origin=archive.performanceWitnesses.witnesses[0].origin;
  assert.equal(JSON.parse(origin.witness.manifestCanonical).admission.principalId,historical);
  const restorer=createPostgresRealmRuntimeSaveRestorer(runtime,{...declared,validateWorldBinding:async()=>{}});
  const input={workspaceId,principalId,sessionProof:sessionProofFor(principalId),targetWorldId:POSTGRES_DEMO_IDS.world,archive,idempotencyKey:`restore_${suffix}`};
  const first=await restorer.restore(input);assert.equal(first.replayed,false);
  assert.equal((await restorer.restore(input)).replayed,true);
  const exported=await reader.load({workspaceId,principalId,recordId:first.recordId,purpose:"record-export"});assert.ok(exported);
  assert.deepEqual(exported.performanceWitnesses!.witnesses[0].origin,origin);
  const second=await restorer.restore({...input,archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(exported),{goalsSchemaVersion:2}),idempotencyKey:`second_${suffix}`});
  const last=await reader.load({workspaceId,principalId,recordId:second.recordId,purpose:"record-export"});assert.ok(last);
  const p=last.performanceWitnesses!.witnesses[0].projection;
  assert.deepEqual(last.performanceWitnesses!.witnesses[0].origin,origin);assert.notEqual(p.commandId,origin.commandId);assert.notEqual(p.assessmentId,origin.assessment.id);
  const service=createCommittedFactCommandService({store:createPostgresCommittedFactCommandStore(runtime)});
  const intent={scope:p.scope,recordId:p.recordId,policyVersion:p.request.policyVersion,evidenceEventIds:p.request.evidenceEventIds,idempotencyKey:`accepted_${suffix}`};
  assert.equal((await service.recordPerformanceAssessment(intent)).score,accepted.result.score);
  await assert.rejects(service.recordPerformanceAssessment({...intent,evidenceEventIds:["wrong"]}),{code:"IDEMPOTENCY_KEY_REUSE"});
  await withWorkspaceTransaction(runtime,workspaceId,async client=>{
    assert.equal(await hasPerformanceRestoreTarget(client),true);
    const fake=await client.query("SELECT assessment_id FROM performance_evidence_snapshots WHERE workspace_id=$1 AND assessment_id=$2",[workspaceId,p.assessmentId]);assert.equal(fake.rowCount,0);
  });
  await withWorkspaceTransaction(owner,workspaceId,async client=>{
    const body=await client.query("SELECT group_plan->'bodyVersion' AS version FROM record_goal_restore_admissions WHERE workspace_id=$1 AND record_id=$2",[workspaceId,first.recordId]);assert.deepEqual(body.rows,[{version:3}]);
  });
  const modified=structuredClone(archive);modified.domain!.stories![0].title="other committed body";
  modified.manifest=realmRuntimeSaveManifestFromData({...modified,...modified.manifest});
  await assert.rejects(restorer.restore({...input,archive:modified}));
  await assert.rejects(restorer.restore({...input,sessionProof:"invalid-proof"}));

  // Snapshot every affected scoped table, including private admissions and Goal
  // bindings. A failed COMMIT must leave no partial topology/history/ledger.
  const transactionTables=["worldlines","stories","records","record_heads","events","scenes","visibility_policies",
    "goal_instances","goal_assessments","record_goal_definitions","record_goal_restore_admissions",
    "goal_content_write_admissions","goal_content_instance_bindings","committed_fact_commands",
    "performance_assessments","performance_evidence_transport_provenance"];
  const snapshot=()=>withWorkspaceTransaction(owner,workspaceId,async client=>{
    const rows:Record<string,unknown>={};
    for(const table of transactionTables)rows[table]=(await client.query(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE workspace_id=$1 ORDER BY to_jsonb(t)::text`,[workspaceId])).rows;
    return rows;
  });
  await t.test("performance-only native Library selection without Goal or narrative state",async()=>{
    const scope={workspaceId:sourceWorkspace,principalId:historical,sessionProof:sessionProofFor(historical)};
    const branchInput={sourceRecordId:POSTGRES_DEMO_IDS.record,idempotencyKey:`only_performance_${suffix}`};
    const absent=await withWorkspaceTransaction(runtime,sourceWorkspace,c=>c.query(`SELECT
      EXISTS(SELECT 1 FROM goal_instances WHERE workspace_id=$1 AND record_id=$2) AS goals,
      EXISTS(SELECT 1 FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2) AS definitions,
      EXISTS(SELECT 1 FROM events WHERE workspace_id=$1 AND record_id=$2 AND
        (jsonb_typeof(payload#>'{__realmRuntimePayload,narrativeState}')='object' OR jsonb_typeof(payload->'narrativeState')='object')) AS narrative`,
    [sourceWorkspace,POSTGRES_DEMO_IDS.record]));
    assert.deepEqual(absent.rows,[{goals:false,definitions:false,narrative:false}]);
    const sourceSnapshot=()=>withWorkspaceTransaction(owner,sourceWorkspace,async client=>{
      const state:Record<string,unknown>={};
      for(const table of [...transactionTables,"performance_evidence_snapshots"])state[table]=
        (await client.query(`SELECT to_jsonb(t) AS row FROM public.${table} t WHERE workspace_id=$1 ORDER BY to_jsonb(t)::text`,[sourceWorkspace])).rows;
      return state;
    });
    const beforeDisabled=await sourceSnapshot();
    await assert.rejects(createPostgresRealmRuntimeSaveReader(runtime,{goalsSchemaVersion:2,performanceWitnessesSchemaVersion:undefined}).load({
      workspaceId:sourceWorkspace,principalId:historical,recordId:POSTGRES_DEMO_IDS.record,purpose:"record-export",
    }),{code:"PERFORMANCE_TRANSPORT_VERSION_UNSUPPORTED"});
    assert.deepEqual(await sourceSnapshot(),beforeDisabled);
    const library=createPostgresLibraryService(runtime);
    const branch=await library.branchRecord(scope,branchInput);assert.equal(branch.replayed,false);
    const exported=await reader.load({workspaceId:sourceWorkspace,principalId:historical,recordId:branch.recordId,purpose:"record-export"});assert.ok(exported);
    assert.deepEqual(exported.performanceWitnesses!.witnesses[0].origin,origin);
    assert.equal(exported.goals.assessments.length,0);
    assert.equal(exported.goals.schemaVersion===1?exported.goals.instances.length:exported.goals.roots.flatMap(r=>r.instances).length,0);
    assert.equal(exported.domain!.records?.length,0);
    const durable=await withWorkspaceTransaction(runtime,sourceWorkspace,c=>c.query(
      "SELECT envelope_canonical FROM performance_evidence_transport_provenance WHERE workspace_id=$1 AND record_id=$2",[sourceWorkspace,branch.recordId]));
    assert.equal(durable.rowCount,1);assert.deepEqual(JSON.parse(durable.rows[0].envelope_canonical).origin,origin);
    const beforeReplay=await sourceSnapshot();
    assert.equal((await library.branchRecord(scope,branchInput)).replayed,true);assert.deepEqual(await sourceSnapshot(),beforeReplay);
    const start=await withWorkspaceTransaction(runtime,sourceWorkspace,c=>c.query(
      "SELECT start_tick,start_ordinal FROM records WHERE workspace_id=$1 AND id=$2",[sourceWorkspace,POSTGRES_DEMO_IDS.record]));
    const historicalFork={worldTick:Number(start.rows[0].start_tick),worldOrdinal:Number(start.rows[0].start_ordinal)};
    const opening=normalizeRealmRuntimeSaveEventForRestore(archive.record.events.find(e=>e.eventId===POSTGRES_DEMO_IDS.openingEvent)!);
    assert.ok(historicalFork.worldTick<opening.worldTick||(historicalFork.worldTick===opening.worldTick&&historicalFork.worldOrdinal<opening.worldOrdinal),"negative control must precede the current head, not select that head again");
    await assert.rejects(library.branchRecord(scope,{...branchInput,idempotencyKey:`only_performance_old_${suffix}`,
      fork:historicalFork}),{code:"BRANCH_GOAL_STATE_UNAVAILABLE"});
    assert.deepEqual(await sourceSnapshot(),beforeReplay);
  });
  await t.test("A4 actual default fact/save/backup/restore routes preserve witness and replay without factory overrides",async()=>{
    // The route's real workspace is used only in this disposable cluster; never
    // rewrite LOCAL_RECORD_SCOPE or inject alternate factories into a handler.
    await seedCapabilitySessionKey(owner,LOCAL_RECORD_SCOPE.workspaceId);
    const cookie=`realm_session=${sessionProofFor(LOCAL_RECORD_SCOPE.principalId)}`;
    const intent={command:"record_performance_assessment",recordId:LOCAL_RECORD_SCOPE.recordId,
      policyVersion:"structured-factors:v1",evidenceEventIds:[POSTGRES_DEMO_IDS.openingEvent]};
    const acceptedKey=`default_route_${suffix}`;
    const commandRequest=(worldlineId:string,body:unknown,key:string)=>new Request(
      `http://127.0.0.1/api/bridge/v1/facts/commands?worldId=${POSTGRES_DEMO_IDS.world}&worldlineId=${worldlineId}`,
      {method:"POST",headers:{cookie,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(body)});
    const initial=(await owner.query("SELECT count(*)::text AS n FROM performance_assessments WHERE workspace_id=$1",[LOCAL_RECORD_SCOPE.workspaceId])).rows;
    const refused=await postFactCommand(commandRequest(POSTGRES_DEMO_IDS.worldline,{...intent,score:999},`${acceptedKey}:invalid`));
    assert.equal(refused.status,422);
    assert.equal((await refused.json()).error.code,"COMMAND_INVALID");
    assert.deepEqual((await owner.query("SELECT count(*)::text AS n FROM performance_assessments WHERE workspace_id=$1",[LOCAL_RECORD_SCOPE.workspaceId])).rows,initial);
    const committed=await postFactCommand(commandRequest(POSTGRES_DEMO_IDS.worldline,intent,acceptedKey));
    assert.equal(committed.status,200);const result=await committed.json();assert.equal(result.ok,true);assert.equal(result.data.score,10);
    const saveRequest=(recordId:string)=>new Request("http://127.0.0.1/api/record/save",{
      method:"POST",headers:{cookie,"content-type":"application/json"},body:JSON.stringify({recordId})});
    const savedResponse=await postRuntimeSave(saveRequest(LOCAL_RECORD_SCOPE.recordId));assert.equal(savedResponse.status,200);
    const savedBytes=new Uint8Array(await savedResponse.arrayBuffer());
    const savedArchive=parseRealmRuntimeSaveArchive(savedBytes,{goalsSchemaVersion:2});
    assert.ok(savedArchive.performanceWitnesses);assert.equal(savedArchive.performanceWitnesses.witnesses.length,1);
    const acceptedOrigin=savedArchive.performanceWitnesses.witnesses[0].origin;
    assert.equal(JSON.parse(acceptedOrigin.witness.manifestCanonical).admission.principalId,LOCAL_RECORD_SCOPE.principalId);
    const priorOperator=process.env.REALM_OPERATOR_PRINCIPALS;
    try{
      process.env.REALM_OPERATOR_PRINCIPALS=LOCAL_RECORD_SCOPE.principalId;
      const backup=await postRuntimeBackup(saveRequest(LOCAL_RECORD_SCOPE.recordId));assert.equal(backup.status,200);
      const backupArchive=parseRealmRuntimeSaveArchive(new Uint8Array(await backup.arrayBuffer()),{goalsSchemaVersion:2});
      assert.deepEqual(backupArchive.performanceWitnesses!.witnesses[0].origin,acceptedOrigin);
    }finally{if(priorOperator===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=priorOperator;}
    const restoreRequest=()=>new Request("http://127.0.0.1/api/record/restore",{
      method:"POST",headers:{cookie,"content-type":"application/vnd.realm.save+zip","idempotency-key":`restore_${acceptedKey}`,
        "x-realm-target-world":POSTGRES_DEMO_IDS.world},body:savedBytes});
    const restoredResponse=await postRuntimeRestore(restoreRequest());assert.equal(restoredResponse.status,201);
    const restored=await restoredResponse.json();assert.equal(restored.ok,true);assert.equal(restored.replayed,false);
    const replayResponse=await postRuntimeRestore(restoreRequest());assert.equal(replayResponse.status,200);
    const replayBody=await replayResponse.json();assert.equal(replayBody.replayed,true);assert.equal(replayBody.recordId,restored.recordId);
    const reexportResponse=await postRuntimeSave(saveRequest(restored.recordId));assert.equal(reexportResponse.status,200);
    const reexport=parseRealmRuntimeSaveArchive(new Uint8Array(await reexportResponse.arrayBuffer()),{goalsSchemaVersion:2});
    assert.deepEqual(reexport.performanceWitnesses!.witnesses[0].origin,acceptedOrigin);
    const projection=reexport.performanceWitnesses!.witnesses[0].projection;
    const commandReplay=await postFactCommand(commandRequest(projection.scope.worldlineId,
      {...intent,recordId:projection.recordId,evidenceEventIds:projection.request.evidenceEventIds},acceptedKey));
    assert.equal(commandReplay.status,200);const replayResult=await commandReplay.json();
    assert.equal(replayResult.data.status,"replayed");assert.equal(replayResult.data.score,10);
  });
  const authored=await executeRecordGoalCommand(runtime,{scope:{...sourceScope,recordId:POSTGRES_DEMO_IDS.record},principalId:historical,
    sessionProof:sessionProofFor(historical),idempotencyKey:`authored_${suffix}`,command:{operation:"create",recordId:POSTGRES_DEMO_IDS.record,
      expectedHead:{recordVersion:archive.record.head.recordVersion,ordinal:archive.record.head.nextRecordOrdinal-1},
      draft:{title:"Retain the original",description:"Keep the original evidence.",visible:true,changePolicy:"fixed",
        successConditions:["The original is retained"],failureConditions:[],settlementConditions:[]}}});
  const sourceBeforeAssessment=await reader.load({workspaceId:sourceWorkspace,principalId:historical,recordId:POSTGRES_DEMO_IDS.record,purpose:"record-export"});assert.ok(sourceBeforeAssessment);
  assert.equal(sourceBeforeAssessment.goals.schemaVersion,1);
  const definitions=await withWorkspaceTransaction(runtime,sourceWorkspace,client=>client.query("SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND record_id=$2",[sourceWorkspace,POSTGRES_DEMO_IDS.record]));
  const definition=decodeRecordGoalDefinition(definitions.rows[0].definition);
  const event=sourceBeforeAssessment.record.events.find(e=>e.eventId===authored.eventId);assert.ok(event);
  const evidenceHead={recordVersion:event.recordVersion,ordinal:event.ordinal};
  const hash=goalEvidenceSnapshotHash({definition,instance:{goalInstanceId:definition.goalInstanceId,recordId:POSTGRES_DEMO_IDS.record,
    state:"active",revision:1,progress:{},outcome:null},events:[{eventId:event.eventId,recordId:POSTGRES_DEMO_IDS.record,
      recordVersion:event.recordVersion,ordinal:event.ordinal,kind:event.kind,payload:normalizeRealmRuntimeSaveEventForRestore(event).eventPayload}],evidenceHead});
  // Explicit privileged fixture history; the consumer still uses runtime role,
  // source proof validation and the real production reader/restorer throughout.
  await withWorkspaceTransaction(owner,sourceWorkspace,client=>client.query(`INSERT INTO goal_assessments
    (workspace_id,world_id,worldline_id,record_id,id,goal_instance_id,assessment_job_id,source_event_id,source,status,
      result,evidence_event_ids,evidence_head_version,evidence_head_ordinal,evidence_snapshot_hash,policy_version)
    VALUES($1,$2,$3,$4,$5,$6,NULL,$7,'judge','accepted',$8::jsonb,$9::text[],$10,$11,$12,$13)`,
    [sourceWorkspace,sourceScope.worldId,sourceScope.worldlineId,POSTGRES_DEMO_IDS.record,`goal_assessment_${suffix}`,definition.goalInstanceId,event.eventId,
      JSON.stringify({policyVersion:definition.policyVersion,evidenceSnapshotHash:hash,evidenceEventIds:[event.eventId],literal:"original"}),[event.eventId],event.recordVersion,event.ordinal,hash,definition.policyVersion]));
  for(const content of [false,true])await t.test(`nonempty ${content?"source-proven V2 content/record":"legacy authored"} Goals + performance, second target and deferred late mutation`,async()=>{
    if(content)await withWorkspaceTransaction(runtime,sourceWorkspace,async client=>{
      await lockGoalContentWorld(client,sourceWorkspace,sourceScope.worldId);
      await materializeGoalInstances(client,{kind:"record",...sourceScope,recordId:POSTGRES_DEMO_IDS.record},
        [{goalKey:"base.first-narration",policyVersion:"base-v1"}],{sessionProof:sessionProofFor(historical),worldVersion:"0.0.0-local",resolveSource:createGoalContentBindingSource()});
    });
    const loaded=await reader.load({workspaceId:sourceWorkspace,principalId:historical,recordId:POSTGRES_DEMO_IDS.record,purpose:"record-export"});assert.ok(loaded);
    const combined=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(loaded),{goalsSchemaVersion:2});
    assert.equal(combined.goals.schemaVersion,content?2:1);assert.equal(combined.goals.assessments.length,1);
    const key=`combined_${content}_${suffix}`,combinedInput={...input,archive:combined,idempotencyKey:key};
    const restored=await restorer.restore(combinedInput);assert.equal(restored.replayed,false);
    const stored=await withWorkspaceTransaction(owner,workspaceId,c=>c.query("SELECT group_plan FROM record_goal_restore_admissions WHERE workspace_id=$1 AND record_id=$2",[workspaceId,restored.recordId]));
    // Check complete typed equality, independently of the JS remapper and row
    // counts. None of these target plans describes the committed sourceBody.
    for(const field of ["status","result","evidence","policy","owner","instance","definition","omission"]) {
      const plan=structuredClone(stored.rows[0].group_plan),goal=plan.goals.roots.flatMap((r:{instances:Record<string,unknown>[]})=>r.instances)
        .find((g:{definition:{kind:string}})=>g.definition.kind==="record");assert.ok(goal);
      if(field==="status")plan.goals.assessments[0].status="rejected";
      if(field==="result")plan.goals.assessments[0].result.literal="forged";
      if(field==="evidence")plan.goals.assessments[0].evidenceEvents[0].eventId="outside";
      if(field==="policy")plan.goals.assessments[0].policyVersion="forged";
      if(field==="owner")goal.ref.owner.recordId="outside";
      if(field==="instance")goal.ref.instanceId="outside";
      if(field==="definition")goal.definition.definitionId="outside";
      if(field==="omission")plan.goals.assessments=[];
      await assert.rejects(withWorkspaceTransaction(owner,workspaceId,c=>c.query("SELECT performance_restore_v3_plan_assert($1,$2,$3::jsonb)",[workspaceId,input.targetWorldId,JSON.stringify(plan)])),error=>{
        const sql=error as {code?:string;message?:string};t.diagnostic(`typed ${field} raw SQLSTATE=${sql.code}`);assert.equal(sql.code,"P0001");
        assert.match(sql.message??"",/GOAL_(RESTORE_PROOF_REQUIRED|DEFINITION_INVALID|SCOPE_MISMATCH)/);return true;
      });
    }
    const beforeReplay=await snapshot();assert.equal((await restorer.restore(combinedInput)).replayed,true);assert.deepEqual(await snapshot(),beforeReplay);
    const reexport=await reader.load({workspaceId,principalId,recordId:restored.recordId,purpose:"record-export"});assert.ok(reexport);
    const secondTarget=await restorer.restore({...combinedInput,archive:parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(reexport),{goalsSchemaVersion:2}),idempotencyKey:`${key}_second`});
    const twice=await reader.load({workspaceId,principalId,recordId:secondTarget.recordId,purpose:"record-export"});assert.ok(twice);
    assert.equal(twice.goals.assessments.length,1);assert.deepEqual(twice.performanceWitnesses!.witnesses[0].origin,origin);
    const twiceAssessment=twice.goals.assessments[0] as unknown as {id:string;evidenceSnapshotHash:string};
    const firstAssessment=reexport.goals.assessments[0] as unknown as {id:string;evidenceSnapshotHash:string};
    assert.notEqual(twiceAssessment.id,firstAssessment.id);
    assert.notEqual(twiceAssessment.evidenceSnapshotHash,firstAssessment.evidenceSnapshotHash);
    if(content&&combined.goals.schemaVersion===2&&twice.goals.schemaVersion===2) {
      const originalBinding=combined.goals.roots.flatMap(r=>r.instances).find(g=>g.definition.kind==="content")!.definition;
      const transportedBinding=twice.goals.roots.flatMap(r=>r.instances).find(g=>g.definition.kind==="content")!.definition;
      assert.equal(originalBinding.kind,"content");assert.equal(transportedBinding.kind,"content");
      if(originalBinding.kind==="content"&&transportedBinding.kind==="content")assert.deepEqual(transportedBinding.binding.source,originalBinding.binding.source);
    }
    let earlySucceeded=false,mutated=false,targetRecordId:string|undefined;
    const late={async connect(){const client=await runtime.connect();return new Proxy(client,{get(target,key){
      if(key==="query")return async(sql:string,values?:unknown[])=>{
        if(sql==="SELECT record_goal_restore_group_prepare_v3($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission") {
          assert.equal(values?.[0],workspaceId);assert.equal(typeof values?.[3],"string");
          targetRecordId=values![3] as string;
        }
        if(sql==="COMMIT"&&targetRecordId!==undefined) {
          // First prove the complete transaction, then requeue the actual
          // deferred guard with a legal mutable-column write, then COMMIT.
          await target.query("SET CONSTRAINTS ALL IMMEDIATE");earlySucceeded=true;
          await target.query("SET CONSTRAINTS ALL DEFERRED");
          assert.ok(targetRecordId);
          const update=await target.query(`UPDATE goal_instances SET progress='{"late":true}'::jsonb WHERE workspace_id=$1
            AND record_id=$2`,[workspaceId,targetRecordId]);assert.ok(update.rowCount);mutated=true;
        }
        return target.query(sql,values);
      };const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});}};
    const beforeLate=await snapshot();
    await assert.rejects(createPostgresRealmRuntimeSaveRestorer(late as never,{...declared,validateWorldBinding:async()=>{}}).restore({...combinedInput,idempotencyKey:`${key}_late`}),error=>{
      const sql=error as {code?:string;message?:string};t.diagnostic(`late mutation raw SQLSTATE=${sql.code}`);
      assert.equal(sql.code,"P0001");assert.match(sql.message??"",/GOAL_RESTORE_PROOF_REQUIRED/);return true;
    });
    assert.equal(earlySucceeded,true);assert.equal(mutated,true);assert.deepEqual(await snapshot(),beforeLate);
  });
  await t.test("real native Library facade preserves combined history, private siblings, session/owner/head guards and exact replay",async()=>{
    const library=createPostgresLibraryService(runtime,undefined,declared),scope={workspaceId:sourceWorkspace,principalId:historical,sessionProof:sessionProofFor(historical)};
    const branchInput={sourceRecordId:POSTGRES_DEMO_IDS.record,idempotencyKey:`native_${suffix}`};
    const branch=await library.branchRecord(scope,branchInput);assert.equal(branch.replayed,false);
    const exported=await reader.load({workspaceId:sourceWorkspace,principalId:historical,recordId:branch.recordId,purpose:"record-export"});assert.ok(exported);
    assert.equal(exported.domain!.records?.length,0);assert.equal(exported.goals.assessments.length,1);
    assert.deepEqual(exported.performanceWitnesses!.witnesses[0].origin,origin);
    const ledger=await withWorkspaceTransaction(runtime,sourceWorkspace,c=>c.query("SELECT command_id FROM performance_evidence_transport_provenance WHERE workspace_id=$1 AND record_id=$2",[sourceWorkspace,branch.recordId]));assert.equal(ledger.rowCount,1);
    assert.equal((await library.branchRecord(scope,branchInput)).replayed,true);
    await assert.rejects(library.branchRecord({...scope,sessionProof:"invalid-proof"},{...branchInput,idempotencyKey:`native_bad_${suffix}`}));
    await assert.rejects(library.branchRecord(scope,{...branchInput,idempotencyKey:`native_old_${suffix}`,fork:{eventId:POSTGRES_DEMO_IDS.openingEvent}}),{code:"BRANCH_GOAL_STATE_UNAVAILABLE"});
  });

  // Every new SELECT column grant: forced workspace RLS, no runtime or
  // capability-role write expansion, and no accidental access to other columns.
  const grants=[
    ["performance_evidence_transport_provenance","command_id","source_manifest_hash"],
    ["performance_assessments","score","created_at"],
    ["committed_fact_commands","request_fingerprint","created_at"],
    ["project_milestones","completion_event_id","title"],
    ["projects","id","title"],
  ];
  for(const [table,column,privateColumn] of grants) {
    const rls=await owner.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",[table]);assert.deepEqual(rls.rows,[{relrowsecurity:true,relforcerowsecurity:true}]);
    await withWorkspaceTransaction(owner,workspaceId,async client=>{
      await client.query("SET LOCAL ROLE realm_goal_authoring");
      await client.query(`SELECT ${column} FROM ${table} WHERE workspace_id=$1`,[workspaceId]);
      assert.equal((await client.query(`SELECT ${column} FROM ${table} WHERE workspace_id=$1`,[sourceWorkspace])).rowCount,0);
      await client.query("SELECT set_config('realm.workspace_id','',true)");
      assert.equal((await client.query(`SELECT ${column} FROM ${table}`)).rowCount,0);
    });
    for(const statement of [`SELECT ${privateColumn} FROM ${table}`,`UPDATE ${table} SET ${column}=${column}`,`DELETE FROM ${table}`,`INSERT INTO ${table} DEFAULT VALUES`]) {
      await assert.rejects(withWorkspaceTransaction(owner,workspaceId,async client=>{await client.query("SET LOCAL ROLE realm_goal_authoring");await client.query(statement);}),{code:"42501"});
    }
  }
  for(const helper of ["performance_transport_canonical(jsonb)","performance_transport_keys(jsonb,text[])"]) {
    const acl=await owner.query("SELECT has_function_privilege('realm_goal_authoring',$1,'EXECUTE') AS capability,has_function_privilege('realm_transfer',$1,'EXECUTE') AS transfer,has_function_privilege('realm_control',$1,'EXECUTE') AS control",[helper]);
    assert.deepEqual(acl.rows,[{capability:true,transfer:false,control:false}]);
  }

  // Real transaction/FK/deferred failures: omit the actual ledger INSERT while
  // retaining the claimed rowCount, then force an early check and omit a fact.
  for(const mode of ["omit-ledger","write-error","early-check"] as const) {
    const sabotaged={async connect(){const client=await runtime.connect();return new Proxy(client,{get(target,key){
      if(key==="query")return async(sql:string,values?:unknown[])=>{
        if(sql.startsWith("INSERT INTO performance_evidence_transport_provenance")) {
          if(mode==="write-error")throw Error("pg-spec-injected-write");
          if(mode==="omit-ledger")return {rows:[],rowCount:1};
        }
        const result=await target.query(sql,values);
        if(mode==="early-check"&&sql.startsWith("INSERT INTO worldlines"))await target.query("SET CONSTRAINTS ALL IMMEDIATE");
        return result;
      };
      const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
    }});}};
    const before=await snapshot();
    await assert.rejects(createPostgresRealmRuntimeSaveRestorer(sabotaged as never,{...declared,validateWorldBinding:async()=>{}}).restore({...input,idempotencyKey:`${mode}_${suffix}`}),error=>{
      t.diagnostic(`${mode} raw SQLSTATE=${(error as {code?:string}).code??"non-SQL failure"}`);return error instanceof Error;
    });
    assert.deepEqual(await snapshot(),before);
  }
});
