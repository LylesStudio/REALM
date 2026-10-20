/** AUTHORED / PG NOT_RUN. Candidate schema/ACL/RLS/append-only/tuple specification.
 * This does not specify the unfinished body-v3 materializer or replay consumer. */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { POSTGRES_DEMO_IDS, seedPostgresDemo } from "../database/postgres/demo-seed.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { createPerformanceCommandTrust, executePerformanceAssessmentCommand } from "../modules/application/performance-command-executor.ts";
import { readPerformanceEvidenceSource } from "../database/postgres/performance-evidence-transport-repository.ts";
import type { ScopedFactReceiptRow } from "../database/postgres/committed-fact-command-repository.ts";
import { committedFactRequestFingerprintFor } from "../modules/application/committed-fact-command.ts";
import { performanceWitnessEnvelopeDigest, performanceWitnessEnvelopeCanonical, type PerformanceWitnessOriginV1,
  type PerformanceWitnessProjectionV1, type PerformanceWitnessIdentityKind } from "../modules/world-transfer/runtime-performance-witness-transport.ts";

function scratch(value: string | undefined): string {
  assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"), "disposable runner required before allocating a pool");
  assert.ok(value); const url=new URL(value);
  assert.ok(["postgres:","postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1","localhost","::1"].includes(url.hostname.replace(/^\[|\]$/g,"")));
  assert.ok(url.pathname.length>1); return value;
}
function canonicalData(value: unknown): string {
  if(Array.isArray(value))return `[${value.map(canonicalData).join(",")}]`;
  if(value!==null&&typeof value==="object")return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalData((value as Record<string,unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}

test("0084 real catalog and runtime enforce private canonical provenance, full tuple, RLS and append-only storage", async t => {
  const ownerUrl=scratch(process.env.DATABASE_URL), runtimeUrl=scratch(process.env.REALM_RUNTIME_DATABASE_URL);
  for (const key of ["hostname","port","pathname"] as const) assert.equal(new URL(ownerUrl)[key],new URL(runtimeUrl)[key]);
  const owner=new pg.Pool({connectionString:ownerUrl,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
  const runtime=new pg.Pool({connectionString:runtimeUrl,max:1,connectionTimeoutMillis:5000,statement_timeout:10000});
  t.after(async()=>{await runtime.end();await owner.end();});
  // Runner owns complete cluster destruction; no append-only fixture deletion.
  const directory=new URL("../database/postgres/migrations/",import.meta.url);
  const files=(await readdir(directory)).filter(f=>f.endsWith(".sql")).sort(); assert.equal(files.length,86); assert.equal(files.at(-1),"0086_unsigned_import_declaration_guard.sql");
  const ledger=await owner.query<{filename:string;checksum:string}>("SELECT filename,checksum FROM realm_schema_migrations ORDER BY filename");
  assert.deepEqual(ledger.rows.map(r=>r.filename),files);
  for (const r of ledger.rows) assert.equal(r.checksum,createHash("sha256").update(await readFile(new URL(r.filename,directory))).digest("hex"));
  const table="performance_evidence_transport_provenance";
  const flags=await owner.query("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",[table]);
  assert.deepEqual(flags.rows,[{relrowsecurity:true,relforcerowsecurity:true}]);
  for (const role of ["realm_runtime","realm_transfer","realm_control"]) {
    for (const privilege of ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"]) {
      const result=await owner.query("SELECT has_table_privilege($1,$2,$3) AS allowed",[role,table,privilege]);
      assert.equal(result.rows[0].allowed,role==="realm_runtime"&&["SELECT","INSERT"].includes(privilege),`${role} ${privilege}`);
    }
  }
  const publicAcl=await owner.query("SELECT privilege_type FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=$1::regclass AND a.grantee=0",[table]); assert.equal(publicAcl.rowCount,0);
  const policies=await owner.query("SELECT qual,with_check FROM pg_policies WHERE tablename=$1",[table]);
  assert.equal(policies.rowCount,1);assert.match(policies.rows[0].qual,/realm_current_workspace_id/);assert.match(policies.rows[0].with_check,/realm_current_workspace_id/);
  const functions=await owner.query("SELECT proname,prosecdef FROM pg_proc WHERE proname IN ('performance_transport_canonical','performance_transport_keys','guard_performance_transport_provenance_insert','guard_performance_transport_provenance_append_only')");
  assert.equal(functions.rowCount,4);assert.ok(functions.rows.every(r=>!r.prosecdef));
  const fks=await owner.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass AND contype='f'",[table]);
  assert.equal(fks.rowCount,4);assert.ok(fks.rows.every(r=>!r.definition.includes("source_")&&!/accounts|members/.test(r.definition)));
  const suffix=randomUUID().replaceAll("-","");
  const sourceWorkspace=`pt_source_${suffix}`,targetWorkspace=`pt_target_${suffix}`;
  await seedPostgresDemo(owner,{workspaceId:sourceWorkspace,principalId:`principal_historical_${suffix}`});
  await seedPostgresDemo(owner,{workspaceId:targetWorkspace,principalId:`principal_operator_${suffix}`});
  const scope={workspaceId:sourceWorkspace,worldId:POSTGRES_DEMO_IDS.world,worldlineId:POSTGRES_DEMO_IDS.worldline};
  const accepted=await executePerformanceAssessmentCommand(runtime,{...createPerformanceCommandTrust(scope,`principal_historical_${suffix}`),enablement:{schema:true,durableTransport:true}},
    {recordId:POSTGRES_DEMO_IDS.record,policyVersion:"structured-factors:v1",evidenceEventIds:[POSTGRES_DEMO_IDS.openingEvent],idempotencyKey:`source_${suffix}`});
  const source=await withWorkspaceTransaction(runtime,sourceWorkspace,async client=>{
    const rows=await client.query<ScopedFactReceiptRow>("SELECT workspace_id,world_id,worldline_id,id,request_fingerprint,kind,result_manifest,false AS receipt_oversized FROM committed_fact_commands WHERE workspace_id=$1 AND id=$2",[sourceWorkspace,accepted.result.commandId]);
    return readPerformanceEvidenceSource(client,scope,rows.rows[0]);
  },{readOnly:true}); assert.ok(source);
  const origin=source.receipt as unknown as PerformanceWitnessOriginV1, snapshot=source.snapshot;
  const targetScope={...scope,workspaceId:targetWorkspace},commandId=`pt_command_${suffix}`,assessmentId=`${commandId}:assessment`;
  const result={...origin.result,commandId,assessmentId},assessment={...origin.assessment,id:assessmentId,commandId};
  const refs=new Map<string,{kind:PerformanceWitnessIdentityKind;originId:string;currentId:string}>();
  const add=(kind:PerformanceWitnessIdentityKind,originId:string,currentId=originId)=>refs.set(`${kind}:${originId}`,{kind,originId,currentId});
  add("record",snapshot.scope.recordId);add("story",snapshot.binding.storyId);add("command",origin.commandId,commandId);add("assessment",origin.assessment.id,assessmentId);add("scene",snapshot.currentScene.id);
  for (const h of [snapshot.headEvent,...snapshot.evidence,...(snapshot.milestoneWitness?[snapshot.milestoneWitness.completionHeader]:[])]) {add("event",h.id);add("scene",h.sceneId);add("policy",h.visibilityPolicyId);}
  if(snapshot.milestoneWitness){add("milestone",snapshot.milestoneWitness.id);add("project",snapshot.milestoneWitness.projectId);}
  const projection:PerformanceWitnessProjectionV1={scope:targetScope,recordId:snapshot.scope.recordId,storyId:snapshot.binding.storyId,commandId,assessmentId,request:origin.request,
    requestFingerprint:committedFactRequestFingerprintFor(targetScope,origin.request),result,assessment,history:"origin-only",relation:{version:1,originScope:scope,currentScope:targetScope,identities:[...refs.values()]}};
  const body={version:1 as const,origin,projection},envelope={...body,digest:performanceWitnessEnvelopeDigest(body)};
  const canonical=performanceWitnessEnvelopeCanonical(envelope);
  const insert=`INSERT INTO performance_evidence_transport_provenance(workspace_id,world_id,worldline_id,record_id,command_id,assessment_id,source_workspace_id,source_world_id,source_worldline_id,source_record_id,source_command_id,source_assessment_id,version,envelope_canonical,envelope_hash,source_manifest_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`;
  const values=[targetWorkspace,scope.worldId,scope.worldlineId,snapshot.scope.recordId,commandId,assessmentId,sourceWorkspace,scope.worldId,scope.worldlineId,snapshot.scope.recordId,origin.commandId,origin.assessment.id,1,canonical,envelope.digest,origin.witness.manifestHash];
  await withWorkspaceTransaction(runtime,targetWorkspace,async client=>{
    await client.query("INSERT INTO committed_fact_commands(workspace_id,world_id,worldline_id,id,idempotency_key,request_fingerprint,kind,result_manifest) VALUES($1,$2,$3,$4,$5,$6,'performance_assessed',$7::jsonb)",[targetWorkspace,scope.worldId,scope.worldlineId,commandId,`target_${suffix}`,projection.requestFingerprint,JSON.stringify({request:projection.request,result,performanceTransport:{version:1,digest:envelope.digest}})]);
    await client.query("INSERT INTO performance_assessments(workspace_id,world_id,worldline_id,record_id,id,policy_version,score,evidence_event_ids,evidence_snapshot_hash,command_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10)",[targetWorkspace,scope.worldId,scope.worldlineId,snapshot.scope.recordId,assessmentId,assessment.policyVersion,assessment.score,assessment.evidenceEventIds,assessment.evidenceSnapshotHash,commandId]);
  });
  const attacks:Array<[(v:unknown[])=>void,RegExp|{code:string}]>=[
    [v=>{v[0]=sourceWorkspace;},/PERFORMANCE_TRANSPORT_SCOPE/], [v=>{v[3]="foreign_record";},/PERFORMANCE_TRANSPORT_TUPLE/],
    [v=>{v[5]="foreign_assessment";},/PERFORMANCE_TRANSPORT_TUPLE/], [v=>{v[6]="wrong_source";},/PERFORMANCE_TRANSPORT_ORIGIN/],
    [v=>{v[12]=2;},{code:"23514"}], [v=>{v[13]=canonical+" ";},/PERFORMANCE_TRANSPORT_CANONICAL/],
    [v=>{v[14]="0".repeat(64);},/PERFORMANCE_TRANSPORT_CANONICAL/], [v=>{v[15]="0".repeat(64);},/PERFORMANCE_TRANSPORT_ORIGIN/]];
  for(const [attack,error] of attacks){const bad=[...values];attack(bad);await assert.rejects(withWorkspaceTransaction(runtime,targetWorkspace,c=>c.query(insert,bad)),error);}
  const malformed:Array<[(e:typeof envelope)=>void,RegExp]>=[
    [e=>{e.projection.relation.identities=[...e.projection.relation.identities,e.projection.relation.identities[0]];},/PERFORMANCE_TRANSPORT_RELATION/],
    [e=>{e.projection.relation.currentScope={...targetScope,workspaceId:sourceWorkspace};},/PERFORMANCE_TRANSPORT_SHAPE/],
    [e=>{e.origin.result.score++;},/PERFORMANCE_TRANSPORT_ORIGIN/]];
  for(const [change,error] of malformed){
    const bad=structuredClone(envelope);change(bad);bad.digest=performanceWitnessEnvelopeDigest({version:1,origin:bad.origin,projection:bad.projection});
    const v=[...values];v[13]=canonicalData(bad);
    v[14]=bad.digest;await assert.rejects(withWorkspaceTransaction(runtime,targetWorkspace,c=>c.query(insert,v)),error);
  }
  await withWorkspaceTransaction(runtime,targetWorkspace,c=>c.query(insert,values));
  const stored=await withWorkspaceTransaction(runtime,targetWorkspace,c=>c.query("SELECT envelope_canonical,envelope_hash FROM performance_evidence_transport_provenance"),{readOnly:true});
  assert.deepEqual(stored.rows,[{envelope_canonical:canonical,envelope_hash:envelope.digest}]);
  assert.equal((await runtime.query("SELECT * FROM performance_evidence_transport_provenance")).rowCount,0,"unscoped runtime cannot read");
  assert.equal((await withWorkspaceTransaction(runtime,sourceWorkspace,c=>c.query("SELECT * FROM performance_evidence_transport_provenance"),{readOnly:true})).rowCount,0,"foreign workspace cannot read");
  await assert.rejects(withWorkspaceTransaction(runtime,targetWorkspace,c=>c.query(insert,values)),{code:"23505"});
  for(const sql of ["UPDATE performance_evidence_transport_provenance SET version=1","DELETE FROM performance_evidence_transport_provenance","TRUNCATE performance_evidence_transport_provenance"]){
    await assert.rejects(withWorkspaceTransaction(runtime,targetWorkspace,c=>c.query(sql)),{code:"42501"});
    // Owner bypass of ACL still meets the table's append-only triggers.
    await assert.rejects(withWorkspaceTransaction(owner,targetWorkspace,c=>c.query(sql)),/append-only/);
  }
  const historicalAccount=await owner.query("SELECT principal_id FROM accounts WHERE workspace_id=$1 AND principal_id=$2",[targetWorkspace,`principal_historical_${suffix}`]);assert.equal(historicalAccount.rowCount,0);
});
