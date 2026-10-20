/** Stateful production SQL protocol development controls. No SQL predicates, PG, network or provider execution. */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildRealmRuntimeSaveArchive,parseRealmRuntimeSaveArchive,realmRuntimeSaveManifestFromData,type RealmRuntimeSaveArchive,type RealmRuntimeSaveGoals } from "../modules/world-transfer/realm-runtime-save.ts";
import { committedFactRequestFingerprintFor,evidenceHash,createCommittedFactCommandService } from "../modules/application/committed-fact-command.ts";
import { performanceEvidenceSnapshotCanonical,performanceEvidenceSnapshotHash, type PerformanceEvidenceSnapshotV1 } from "../modules/application/performance-evidence-snapshot.ts";
import { performanceWitnessEnvelopeDigest,type PerformanceWitnessOriginV1,type PerformanceWitnessProjectionV1 } from "../modules/world-transfer/runtime-performance-witness-transport.ts";
import { createPostgresRealmRuntimeSaveReader,createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { PERFORMANCE_EVIDENCE_SOURCE_SQL,PERFORMANCE_TRANSPORT_READ_SQL,PERFORMANCE_TRANSPORT_HEADERS_SQL,PERFORMANCE_TRANSPORT_SCENE_SQL,PERFORMANCE_TRANSPORT_MILESTONE_SQL } from "../database/postgres/performance-evidence-transport-repository.ts";
import { INSERT_PERFORMANCE_TRANSPORT_SQL } from "../database/postgres/runtime-performance-witness-restore.ts";
import { PERFORMANCE_RESTORE_TARGET_CAPABILITY_SQL } from "../database/postgres/runtime-restore-v3.ts";
import { GOAL_TRANSPORT_CAPABILITY_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { topologyHeaderSql } from "../database/postgres/runtime-topology-resource-reader.ts";
import { evidenceHeaderSql, type EvidenceFamily } from "../database/postgres/runtime-evidence-resource-reader.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";
import { createRecordGoalDefinition } from "../modules/goals/record-authoring.ts";
import { goalEvidenceSnapshotHash } from "../modules/goals/public.ts";
import { GOAL_RESTORE_TARGET_CAPABILITY_SQL, planGoalRestore } from "../database/postgres/runtime-goal-restore.ts";
import { LOAD_TRANSPORT_GOALS_SQL } from "../database/postgres/runtime-goal-binding-reader.ts";
import { LOAD_GOAL_CONTENT_BINDING_SQL } from "../database/postgres/goal-content-binding-repository.ts";
import { createGoalContentBindingSource, bindGoalContentWitness } from "../modules/application/goal-content-binding-source.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
type Row=Record<string,unknown>;
const norm=(s:string)=>s.replace(/\s+/g," ").trim();
const stamp="2026-10-19T00:00:00.000Z";
const unknownProtocolPaths:string[]=[];
function unknownProtocol(message:string):never {unknownProtocolPaths.push(message);throw Error(message);}
// Unknown protocol paths fail independently even when a product negative uses
// assert.rejects. They cannot masquerade as the intended refusal.
after(()=>assert.deepEqual(unknownProtocolPaths,[]));
function fixture(): RealmRuntimeSaveArchive {
  const scope = { workspaceId: "workspace", worldId: "world", worldlineId: "line" };
  const request = { command: "performance.assessed" as const, recordId: "record", policyVersion: "structured-factors:v1" as const, score: 10, evidenceEventIds: ["event"] };
  const requestFingerprint = committedFactRequestFingerprintFor(scope, request);
  const header = { id: "event", sceneId: "scene", visibilityPolicyId: "policy", policyVersion: "1", policyKind: "public", recordVersion: "1", recordOrdinal: "1", worldTick: "2", worldOrdinal: "1" };
  const snapshot: PerformanceEvidenceSnapshotV1 = { version: 1, scope: { ...scope, recordId: "record" }, assessmentId: "command:assessment", commandId: "command", requestFingerprint,
    policyVersion: "structured-factors:v1", admission: { principalId: "historical-private-actor", role: "player", evidencePolicyId: "evidence-policy", evidenceMode: "engine-authoritative-v1" },
    binding: { storyId: "story", worldVersion: "1.0" }, head: { recordVersion: "1", nextRecordOrdinal: "2", lastEventId: "event", lastWorldTick: "2", lastWorldOrdinal: "1", effectiveTick: "2", effectiveOrdinal: "1" },
    worldlineHead: { tick: "3", ordinal: "0" }, currentScene: { id: "scene", startTick: "0", startOrdinal: "0", status: "active" }, headEvent: header,
    evidence: [{ ...header, sceneStartTick: "0", sceneStartOrdinal: "0" }], factors: { evidenceCount: 1, milestoneCompleted: false, score: 10 }, milestoneWitness: null };
  const manifestHash = performanceEvidenceSnapshotHash(snapshot);
  const result = { status: "committed" as const, commandId: "command", assessmentId: "command:assessment", score: 10, evidenceSnapshotHash: evidenceHash(["event"]), goalTransition: null };
  const assessment = { id: "command:assessment", recordId: "record", commandId: "command", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["event"], evidenceSnapshotHash: result.evidenceSnapshotHash };
  const origin: PerformanceWitnessOriginV1 = { scope, commandId: "command", requestFingerprint, request, result, marker: { version: 1, manifestHash },
    witness: { version: 1, recordId: "record", commandId: "command", assessmentId: assessment.id, manifestCanonical: performanceEvidenceSnapshotCanonical(snapshot), manifestHash }, assessment };
  const projection: PerformanceWitnessProjectionV1 = { scope, recordId: "record", storyId: "story", commandId: "command", assessmentId: assessment.id, request, requestFingerprint, result, assessment, history: "origin-only",
    relation: { version: 1, originScope: scope, currentScope: scope, identities: [
      { kind: "record", originId: "record", currentId: "record" }, { kind: "story", originId: "story", currentId: "story" },
      { kind: "command", originId: "command", currentId: "command" }, { kind: "assessment", originId: assessment.id, currentId: assessment.id },
      { kind: "event", originId: "event", currentId: "event" }, { kind: "scene", originId: "scene", currentId: "scene" }, { kind: "policy", originId: "policy", currentId: "policy" } ] } };
  const body = { version: 1 as const, origin, projection }, digest = performanceWitnessEnvelopeDigest(body);
  const archive: RealmRuntimeSaveArchive = {
    manifest: { format: "realm-save", formatVersion: 2, engineApi: "1.x", mode: "world-bound", world: { worldId: "world", worldVersion: "1.0" }, scope: { workspaceId: "workspace", worldlineId: "line", recordId: "record" }, snapshot: { recordVersion: 2, nextRecordOrdinal: 3, runtimeHash: "0".repeat(64) } },
    record: { format: "realm-runtime-record", schemaVersion: 1, scope: { worldId: "world", worldlineId: "line", recordId: "record" }, head: { recordVersion: 2, nextRecordOrdinal: 3 }, events: [{ eventId: "event", recordVersion: 1, ordinal: 1, kind: "utterance.committed", payload: { content: "private", speakerName: "", actorParticipantId: null, sceneId: "scene", visibilityPolicyId: "policy", worldTick: 2, worldOrdinal: 1, calendarId: "calendar", displayTime: "", eventPayload: {} } }] },
    goals: { format: "realm-runtime-goals", schemaVersion: 1, instances: [], assessments: [] },
    topology: { format: "realm-runtime-topology", schemaVersion: 1, participants: [], scenes: [{ sourceSceneId: "scene", title: "", status: "closed", location: "", objective: "", tension: "", weather: "", displayTime: "", startTick: 0, startOrdinal: 0, endTick: 3, endOrdinal: 0 }], visibilityPolicies: [{ sourceVisibilityPolicyId: "policy", policyKey: "public", policyVersion: 1, policyKind: "public", sourceSceneId: null, restrictedDomainId: null, sourcePrivateCharacterInstanceId: null, sourceAudienceCharacterInstanceIds: [] }] },
    domain: { format: "realm-runtime-domain", schemaVersion: 1, source: { worldId: "world", worldlineId: "line", recordId: "record", storyId: "story" }, stories: [{ id: "story", title: "Source", status: "active", premise: "" }], storyDefinitions: [], records: [],
      projects: [], milestones: [], projectStoryLinks: [], budgetAllocations: [], financeAccounts: [], ledgerEntries: [], financeCommandGroups: [], obligations: [], obligationSettlements: [], storyNodes: [], storyUnlockLedger: [], memberRelationshipRevisions: [], characterAssets: [],
      committedFactCommands: [{ id: "command", idempotencyKey: "accepted", kind: "performance_assessed", provenance: "request-result-v1", request, requestFingerprint, resultManifest: { ...result, performanceTransport: { version: 1, digest } } }], performanceAssessments: [assessment] },
    performanceWitnesses: { format: "realm-runtime-performance-witnesses", schemaVersion: 1, witnesses: [{ ...body, digest }] },
  };
  archive.manifest = realmRuntimeSaveManifestFromData({ ...archive, ...archive.manifest });
  return archive;
}
function topologyFixtureHeaders(sql:string,rows:Record<string,unknown>[],values:unknown[]) {
 const family=(["participants","scenes","visibility"] as const).find(f=>sql===topologyHeaderSql(f).replace(/\s+/g," ").trim());
 if(!family)throw Error("UNKNOWN_TOPOLOGY_HEADER_SQL");
 const keys=family==='participants'?['participant_speaking_order','participant_id']:family==='scenes'?['start_tick','start_ordinal','scene_id']:['policy_key','policy_version','policy_id'];
 assert.equal(values.length,4+keys.length);
 const fields=[...sql.matchAll(/ AS (\w+)_bytes/g)].map(m=>m[1]!);
 return rows.filter(row=>values[4]===null||keys.some((k,i)=>keys.slice(0,i).every((prior,j)=>String(row[prior])===String(values[j+4]))&&String(row[k])>String(values[i+4]))).slice(0,1000).map((row,i)=>({
  ...row,locator:`(0,${i+1})`,source_count:String(rows.length),cursor_progress:true,
  ...Object.fromEntries(fields.flatMap(k=>{
   const json=['instance_state','definition_profile','audience_character_instance_ids'].includes(k);
   const value=json?JSON.stringify(row[k]??(k==='audience_character_instance_ids'?[]:{})):row[k]??null;
   if(value!==null&&typeof value!=='string')throw Error('INVALID_FIXTURE_TOPOLOGY_TEXT');
   const bytes=value===null?0:Buffer.byteLength(value);
   assert.ok(bytes<=256,'this inherited fixture must explicitly model any new body cursor');
   return [[k,value],[`${k}_is_null`,value===null],[`${k}_bytes`,bytes],[`${k}_chars`,value===null?0:[...value].length]];
  }))
 }));
}
function inserted(sql: string, values: unknown[]) {
  const m = /^INSERT INTO (\w+) \((.*?)\) VALUES \((.*)\)$/.exec(sql); assert.ok(m);
  let depth = 0, start = 0; const terms: string[] = [];
  for (let i = 0; i < m[3].length; i++) {
    if (m[3][i] === "(") depth++; if (m[3][i] === ")") depth--;
    if (m[3][i] === "," && depth === 0) { terms.push(m[3].slice(start, i).trim()); start = i + 1; }
  }
  terms.push(m[3].slice(start).trim()); const columns = m[2].split(",").map(s => s.trim());
  assert.equal(columns.length, terms.length); const row: Row = {};
  columns.forEach((column, i) => {
    const term = terms[i], p = /^\$(\d+)(?:::\w+(?:\[\])?)?$/.exec(term);
    if (p) { row[column] = values[Number(p[1]) - 1]; if (term.endsWith("::jsonb") && row[column] !== null) row[column] = JSON.parse(String(row[column])); }
    else if (term === "NULL") row[column] = null;
    else if (term === "CURRENT_TIMESTAMP") row[column] = stamp; // simulated server time, asserted separately from old source time
    else if (term === "true" || term === "false") row[column] = term === "true";
    else if (/^'.*'$/.test(term)) row[column] = term.slice(1, -1);
    else if (/^\d+$/.test(term)) row[column] = Number(term);
    else if (term.startsWith("CASE WHEN $7 =")) row[column] = values[6] === "active" ? null : stamp;
    else if (term === "CASE WHEN $9='active' THEN NULL ELSE CURRENT_TIMESTAMP END") row[column] = values[8] === "active" ? null : stamp;
    else unknownProtocol(`UNKNOWN_INSERT_TERM:${term}`);
  });
  return { table: m[1], row };
}

const known=new Set<string>();
known.add("SELECT record.world_id, record.worldline_id, record.id AS record_id, record.story_id, record.world_version, head.record_version, head.next_record_ordinal FROM records AS record JOIN worlds AS world ON world.workspace_id = record.workspace_id AND world.id = record.world_id JOIN record_heads AS head ON head.workspace_id = record.workspace_id AND head.record_id = record.id WHERE record.workspace_id = $1 AND record.id = $2 AND EXISTS ( SELECT 1 FROM player_world_memberships AS backup_membership WHERE backup_membership.workspace_id = record.workspace_id AND backup_membership.world_id = record.world_id AND backup_membership.principal_id = $3 AND backup_membership.role = 'owner' )");
for(const file of ["realm-runtime-save-repository.ts","committed-fact-command-repository.ts","business-command-policy.ts","world-write-gate.ts","workspace-transaction.ts","runtime-goal-restore.ts","goal-runtime-materialization.ts"]) {
  const source=readFileSync(new URL(`../database/postgres/${file}`,import.meta.url),"utf8");
  for(const m of source.matchAll(/`([^`]*?)`/g)) if(!m[1].includes("${")&&/^(SELECT|INSERT|UPDATE|\/\*)/.test(m[1].trim())) known.add(norm(m[1]));
  for(const m of source.matchAll(/"(SELECT [^"\n]+)"/g)) known.add(norm(m[1]));
}
for(const m of readFileSync(new URL("../modules/application/library-service.ts",import.meta.url),"utf8").matchAll(/`([^`]*?)`/g)) if(!m[1].includes("${"))known.add(norm(m[1]));
for(const sql of [GOAL_RESTORE_TARGET_CAPABILITY_SQL,LOAD_TRANSPORT_GOALS_SQL,LOAD_GOAL_CONTENT_BINDING_SQL,
  "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
  "SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)",
  "SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only",
  "SELECT current_setting('realm.workspace_id', true) AS workspace_id"])known.add(norm(sql));
for(const sql of [PERFORMANCE_EVIDENCE_SOURCE_SQL,PERFORMANCE_TRANSPORT_READ_SQL,PERFORMANCE_TRANSPORT_HEADERS_SQL,PERFORMANCE_TRANSPORT_SCENE_SQL,PERFORMANCE_TRANSPORT_MILESTONE_SQL,INSERT_PERFORMANCE_TRANSPORT_SQL,PERFORMANCE_RESTORE_TARGET_CAPABILITY_SQL,GOAL_TRANSPORT_CAPABILITY_SQL,
  "SELECT record_goal_restore_group_prepare_v3($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission",
  "SELECT record_goal_restore_group_replay_v3($1,$2,$3,$4,$5,$6::jsonb) AS actor",
  "SELECT restore_delivery_kind FROM public.outbox WHERE false",
  "SELECT world_version, status, settings FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE"] ) known.add(norm(sql));
const empty=new Set(["goal_instances","goal_assessments","action_receipts","character_effects","observations","memory_conclusions","memory_snapshots","relationship_states","record_first_nights","record_self_play_sessions","record_goal_definitions","project_story_links","projects","project_milestones","budget_allocations","finance_accounts","ledger_entries","project_finance_command_groups","obligations","obligation_settlements","story_node_instances","story_unlock_ledger","member_relationship_revisions","character_assets"]);
const insertTables=new Set(["worldlines","stories","records","participants","scenes","visibility_policies","events","record_heads","committed_fact_commands","performance_assessments","performance_evidence_transport_provenance","projects","project_milestones","project_story_links","goal_instances","goal_assessments"]);
function protocol(workspaceId:string, seed=false, milestone=false) {
  let state:Record<string,Row[]>={}; let before:typeof state={}; let active=false; let configured="";
  const calls:{sql:string;params:unknown[]}[]=[];
  const controls={ready:true,owner:true,failTable:"",goalSchema:false}; let acquired=0,released=0;
  const savepoints:Record<string,Row[]>[]=[];
  const evidenceCursors=new Set<string>();
  if(seed) {
    const a=fixture(),e=a.performanceWitnesses!.witnesses[0],s=JSON.parse(e.origin.witness.manifestCanonical);
    state={
      records:[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",id:"record",story_id:"story",world_version:"1.0",status:"active"}],
      stories:[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",id:"story",title:"Source",status:"active",premise:""}],
      record_heads:[{record_id:"record",record_version:2,next_record_ordinal:3}],
      scenes:[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",record_id:"record",id:"scene",title:"",status:"closed",location:"",objective:"",tension:"",weather:"",display_time:"",start_tick:0,start_ordinal:0,end_tick:3,end_ordinal:0}],
      visibility_policies:[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",id:"policy",policy_key:"public",policy_version:1,policy_kind:"public",scene_id:null,restricted_domain_id:null,private_character_instance_id:null,audience_character_instance_ids:[]}],
      events:[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",record_id:"record",id:"event",record_version:1,record_ordinal:1,event_kind:"utterance.committed",actor_participant_id:null,speaker_name:"",content:"private",payload:{},scene_id:"scene",visibility_policy_id:"policy",world_tick:2,world_ordinal:1,calendar_id:"calendar",display_time:""}],
      committed_fact_commands:[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",id:"command",idempotency_key:"accepted",request_fingerprint:e.origin.requestFingerprint,kind:"performance_assessed",result_manifest:{request:e.origin.request,result:e.origin.result,performanceWitness:e.origin.marker},receipt_oversized:false}],
      performance_assessments:[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",record_id:"record",id:"command:assessment",policy_version:s.policyVersion,score:10,evidence_event_ids:["event"],evidence_snapshot_hash:e.origin.assessment.evidenceSnapshotHash,command_id:"command"}],
      performance_evidence_snapshots:[{record_id:"record",assessment_id:"command:assessment",command_id:"command",version:1,manifest_canonical:e.origin.witness.manifestCanonical,manifest_hash:e.origin.witness.manifestHash}]
    };
    state.events.push({...structuredClone(state.events[0]),id:"later-event",record_version:2,record_ordinal:2,world_tick:3,world_ordinal:0});
    if(milestone) {
      s.factors={evidenceCount:1,milestoneCompleted:true,score:30};
      s.milestoneWitness={id:"milestone",projectId:"project",completionRecordId:"record",completionEventId:"event",completionHeader:{...s.evidence[0]}};
      const c=state.committed_fact_commands[0],m=c.result_manifest as {request:Row;result:Row;performanceWitness:Row};
      m.request.score=30;m.result.score=30;state.performance_assessments[0].score=30;
      c.request_fingerprint=committedFactRequestFingerprintFor(e.origin.scope,m.request);s.requestFingerprint=c.request_fingerprint;
      state.performance_evidence_snapshots[0].manifest_canonical=performanceEvidenceSnapshotCanonical(s);
      state.performance_evidence_snapshots[0].manifest_hash=performanceEvidenceSnapshotHash(s);m.performanceWitness.manifestHash=performanceEvidenceSnapshotHash(s);
      state.projects=[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",id:"project",kind:"production",status:"active",stage:"planning",title:"Project",currency:"JPY",deadline:null,version:1}];
      state.project_milestones=[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",id:"milestone",project_id:"project",sequence:1,title:"Done",status:"completed",due_on:null,completion_record_id:"record",completion_event_id:"event"}];
      state.project_story_links=[{workspace_id:workspaceId,world_id:"world",worldline_id:"line",id:"link",project_id:"project",story_id:"story",link_kind:"primary"}];
    }
  }
  const rows=(table:string)=>state[table]??[];
  const factRead=(commandId:unknown)=>{
    const c=rows("committed_fact_commands").find(r=>r.id===commandId),a=rows("performance_assessments").find(r=>r.command_id===commandId);
    assert.ok(c&&a);return {request_fingerprint:c.request_fingerprint,result_manifest:c.result_manifest,policy_version:a.policy_version,score:a.score,evidence_event_ids:a.evidence_event_ids,evidence_snapshot_hash:a.evidence_snapshot_hash,assessment_record_id:a.record_id,assessment_command_id:a.command_id};
  };
  const client={release(){released++;},async query(sql:string,params:unknown[]=[]):Promise<{rows:Row[];rowCount:number}> {
    const q=norm(sql);calls.push({sql:q,params:structuredClone(params)});
    const result=(r:Row[])=>({rows:structuredClone(r).reverse(),rowCount:r.length});
    if(q.startsWith("BEGIN")) {assert.equal(active,false);active=true;before=structuredClone(state);return result([]);}
    if(q==="COMMIT") {assert.ok(active);active=false;return result([]);}
    if(q==="ROLLBACK") {state=before;active=false;return result([]);}
    if(q==="SAVEPOINT realm_workspace_scope"){assert.ok(active);savepoints.push(structuredClone(state));return result([]);}
    if(q==="ROLLBACK TO SAVEPOINT realm_workspace_scope"){state=structuredClone(savepoints.at(-1)!);return result([]);}
    if(q==="RELEASE SAVEPOINT realm_workspace_scope"){assert.ok(savepoints.pop());return result([]);}
    if(q==="SELECT set_config('realm.workspace_id', $1, true)"){assert.ok(active);assert.deepEqual(params,[workspaceId]);configured=workspaceId;return result([]);}
    assert.ok(active&&configured===workspaceId,"same scoped transaction required");
    const evidence=/^\/\* runtime evidence (action_receipts|character_effects|observations) headers \*\/ DECLARE (realm_evidence_[a-f0-9]+) /.exec(q);
    if(evidence) {
      assert.equal(q,norm(evidenceHeaderSql(evidence[1] as EvidenceFamily,evidence[2])));
      assert.equal(params.length,4);assert.equal(params[0],workspaceId);
      assert.equal(rows(evidence[1]).length,0);assert.equal(evidenceCursors.has(evidence[2]),false);
      evidenceCursors.add(evidence[2]);return result([]);
    }
    const fetch=/^\/\* runtime evidence headers \*\/ FETCH FORWARD 1000 FROM (realm_evidence_[a-f0-9]+)$/.exec(q);
    if(fetch){assert.deepEqual(params,[]);assert.ok(evidenceCursors.has(fetch[1]));return result([]);}
    if(q.startsWith("CLOSE realm_evidence_")){assert.deepEqual(params,[]);assert.ok(evidenceCursors.delete(q.slice(6)));return result([]);}
    const topology=(["participants","scenes","visibility"] as const).find(f=>q===norm(topologyHeaderSql(f)));
    const eventHeaders=q.startsWith("/* runtime event headers */ SELECT ") && q.includes("FROM events WHERE workspace_id=$1 AND record_id=$2") && q.endsWith("LIMIT 1000");
    const outboxHeaders=q.startsWith("/* runtime outbox headers; outbox preflight; outbox bounded envelope */ SELECT ")&&q.endsWith("LIMIT 1000");
    const memoryHeader=/^\/\* memory resource header (snapshots|conclusions|relationships) \*\/ SELECT keys,invalid,lower_bytes,content_bytes,content_chars,fidelity_text, lower_bytes::numeric > [0-9]+ AS oversize, /.exec(q);
    if(memoryHeader) {
      const table={snapshots:"memory_snapshots",conclusions:"memory_conclusions",relationships:"relationship_states"}[memoryHeader[1]]!;
      assert.ok(q.includes(`FROM ${table} WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3`));
      assert.ok(q.endsWith('LIMIT 1000) memory_headers ORDER BY keys COLLATE "C"'));assert.equal(rows(table).length,0);
      assert.equal(params[0],workspaceId);return result([]);
    }
    if(!known.has(q)&&!topology&&!eventHeaders&&!outboxHeaders) unknownProtocol(`UNKNOWN_SQL_TEXT:${q}`);
    if(q===norm(PERFORMANCE_RESTORE_TARGET_CAPABILITY_SQL)) {assert.deepEqual(params,[]);assert.equal(calls.slice(calls.findLastIndex(c=>c.sql.startsWith("BEGIN"))).filter(c=>c.sql.startsWith("INSERT")).length,0);return result([{available:controls.ready}]);}
    if(q===norm(GOAL_TRANSPORT_CAPABILITY_SQL)||q===norm(GOAL_RESTORE_TARGET_CAPABILITY_SQL)) {assert.deepEqual(params,[]);return result([{available:controls.goalSchema}]);}
    if(q===norm(LOAD_TRANSPORT_GOALS_SQL))return result(rows("goal_instances").filter(g=>g.worldline_id===params[2]));
    if(q===norm(LOAD_GOAL_CONTENT_BINDING_SQL))return result(rows("bindings").filter(b=>b.goal_instance_id===params[1]));
    if(q.startsWith("SELECT goal_content_write_prepare_v3(")) {
      assert.equal(params[1],"proof");assert.equal(params[2],"restore-v3");
      assert.equal(params[3],rows("admissions").at(-1)!.body);return result([{admission:{actor:"owner",planCommitment:"d".repeat(64)}}]);
    }
    if(q==="SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)") {
      for(const binding of JSON.parse(String(params[4]))) (state.bindings??=[]).push({goal_instance_id:binding.instanceId,binding});return result([]);
    }
    if(q.startsWith("SELECT record_goal_restore_group_definitions(")) {
      for(const definition of JSON.parse(String(params[5]))) (state.record_goal_definitions??=[]).push({workspace_id:workspaceId,world_id:"world",worldline_id:definition.scope.worldlineId,record_id:definition.scope.recordId,definition});return result([]);
    }
    if(q.startsWith("SELECT record_goal_restore_group_prepare_v3(")) {
      assert.equal(params.length,7);assert.equal(params[0],workspaceId);assert.equal(params[1],"proof");
      const plan=JSON.parse(String(params[6]));assert.equal(plan.bodyVersion,3);
      assert.equal(params[5],createHash("sha256").update("realm-save:body-v3:").update(plan.sourceBody).digest("hex"));
      const admission={workspace_id:workspaceId,record_id:params[3],body:params[5],plan};
      (state.admissions??=[]).push(admission);
      return result([{admission:{actor:"owner",planCommitment:"c".repeat(64)}}]);
    }
    if(q.startsWith("SELECT record_goal_restore_group_replay_v3(")) {
      const saved=rows("admissions").find(a=>a.record_id===params[3]);assert.ok(saved);
      assert.equal(params[4],saved.body);assert.deepEqual(JSON.parse(String(params[5])),saved.plan);return result([{actor:"owner"}]);
    }
    if(q===norm(PERFORMANCE_EVIDENCE_SOURCE_SQL)) {
      assert.deepEqual(params,[workspaceId,"world","line","record","command","command:assessment"]);
      return result(rows("performance_evidence_snapshots").map(r=>({...r,...factRead(r.command_id)})));
    }
    if(q===norm(PERFORMANCE_TRANSPORT_READ_SQL)) {
      assert.equal(params.length,4);assert.equal(params[0],workspaceId);
      return result(rows("performance_evidence_transport_provenance").filter(r=>r.workspace_id===params[0]&&r.world_id===params[1]&&r.worldline_id===params[2]&&r.command_id===params[3]).map(r=>({...r,...factRead(r.command_id)})));
    }
    if(q===norm(PERFORMANCE_TRANSPORT_HEADERS_SQL)) {
      assert.equal(params.length,5);assert.equal(params[0],workspaceId);
      return result(rows("events").filter(e=>e.record_id===params[3]&&(params[4] as string[]).includes(String(e.id))).map(e=>{
        const r=rows("records").find(r=>r.id===e.record_id)!,h=rows("record_heads").find(h=>h.record_id===e.record_id)!,p=rows("visibility_policies").find(p=>p.id===e.visibility_policy_id)!,s=rows("scenes").find(s=>s.id===e.scene_id)!;
        return {...e,record_version:String(e.record_version),record_ordinal:String(e.record_ordinal),world_tick:String(e.world_tick),world_ordinal:String(e.world_ordinal),policy_version:String(p.policy_version),policy_kind:p.policy_kind,start_tick:String(s.start_tick),start_ordinal:String(s.start_ordinal),story_id:r.story_id,world_version:r.world_version,head_version:String(h.record_version),head_ordinal:String(h.next_record_ordinal)};
      }));
    }
    if(q===norm(PERFORMANCE_TRANSPORT_SCENE_SQL)) {assert.equal(params.length,5);return result(rows("scenes").filter(s=>s.id===params[4]&&s.record_id===params[3]).map(s=>({start_tick:String(s.start_tick),start_ordinal:String(s.start_ordinal)})));}
    if(q===norm(PERFORMANCE_TRANSPORT_MILESTONE_SQL)) {assert.equal(params.length,4);assert.equal(params[0],workspaceId);return result(rows("project_milestones").filter(m=>m.id===params[3]).map(m=>({project_id:m.project_id,status:m.status,completion_record_id:m.completion_record_id,completion_event_id:m.completion_event_id})));}
    if(q.startsWith("INSERT INTO ")) {
      const {table,row}=inserted(q,params);assert.ok(insertTables.has(table),table);assert.equal(params[0],workspaceId);assert.equal(params[1],"world");
      if(table==="goal_instances"){row.scope_kind??="record";row.story_id??=null;}
      if(controls.failTable===table)throw Error(`INJECTED_WRITE:${table}`);
      (state[table]??=[]).push(row);return result([row]);
    }
    if(q.startsWith("SELECT world_version, status, settings FROM worlds")) return result([{world_version:"1.0",status:"active",settings:{}}]);
    if(q==="SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR UPDATE")return result([{status:"active"}]);
    if(q==="SELECT id FROM worlds WHERE workspace_id = $1 AND id = $2")return result([{id:"world"}]);
    if(q==="SELECT current_setting('transaction_isolation') AS isolation_level, current_setting('transaction_read_only') AS read_only")return result([{isolation_level:"repeatable read",read_only:"off"}]);
    if(q==="SELECT current_setting('realm.workspace_id', true) AS workspace_id")return result([{workspace_id:workspaceId}]);
    if(q.startsWith("SELECT world_id FROM records"))return result(rows("records").filter(r=>r.id===params[1]).map(r=>({world_id:r.world_id})));
    if(q.startsWith("SELECT record.worldline_id,")) {
      const r=rows("records").find(r=>r.id===params[1])!,s=rows("stories").find(s=>s.id===r.story_id)!;
      return result([{...r,record_title:"Record",record_status:r.status,story_title:s.title,story_premise:s.premise,start_tick:"0",start_ordinal:"0",observer:false,player_role:""}]);
    }
    if(q.startsWith("SELECT last_world_tick::text"))return result(rows("record_heads").filter(h=>h.record_id===params[1]).map(h=>({...h,last_world_tick:"3",last_world_ordinal:"0"})));
    if(q.startsWith("SELECT id, goal_key, state, revision::text"))return result(rows("goal_instances").filter(g=>g.record_id===params[1]));
    if(q===branchRuntimePresenceSql) {
      assert.deepEqual(params,[workspaceId,"record","world","line"]);
      const performance=rows("performance_assessments").some(a=>a.workspace_id===params[0]&&a.record_id===params[1]&&a.world_id===params[2]&&a.worldline_id===params[3]);
      assert.equal(rows("events").some(e=>e.record_id===params[1]&&e.event_kind==="narration.committed"),false,"this explicit fixture has no narrative snapshot");
      return result([{present:performance}]);
    }
    if(q===legacyBranchSceneSql) {
      assert.deepEqual(params,[workspaceId,"world","line","record",3,0]);
      throw Object.assign(Error("Legacy clone selected; this control stops before cloning"),{code:"TEST_LEGACY_BRANCH_SELECTED"});
    }
    if(q.startsWith("SELECT EXISTS(SELECT 1 FROM events"))return result([{present:false}]);
    if(q.startsWith("SELECT 1 FROM events"))return result(rows("events").filter(e=>e.record_id===params[1]&&e.world_tick===params[2]&&e.world_ordinal===params[3]).map(()=>({"?column?":1})));
    if(q.startsWith("SELECT id, worldline_id, story_id,"))return result(rows("records").filter(r=>r.id===params[1]));
    if(q.startsWith("SELECT role FROM player_world_memberships")) return result(controls.owner?[{role:"owner"}]:[]);
    if(q==="SELECT current_setting('transaction_isolation') AS isolation_level") {assert.deepEqual(params,[]);return result([{isolation_level:"read committed"}]);}
    if(q==="SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") {const key=JSON.parse(String(params[0]));assert.deepEqual(key.slice(0,4),["realm-command-key:v1","fact",workspaceId,"world"]);return result([]);}
    if(q.includes("record.id AS record_id")) {
      if(params.length===3){assert.equal(params[2],"owner");if(!controls.owner)return result([]);}
      const r=rows("records").find(r=>r.id===params[1]);if(!r)return result([]);const h=rows("record_heads").find(h=>h.record_id===r.id)!;
      return result([{...r,record_id:r.id,record_version:h.record_version,next_record_ordinal:h.next_record_ordinal}]);
    }
    if(q.startsWith("SELECT record.world_id, record.worldline_id, record.story_id, record.status,")) {
      const r=rows("records").find(r=>r.id===params[1]);return result(r?[{...r,story_premise:rows("stories").find(s=>s.id===r.story_id)!.premise}]:[]);
    }
    if(q.startsWith("SELECT status FROM records"))return result(rows("records").filter(r=>r.id===params[1]).map(r=>({status:r.status})));
    if(q.endsWith("AS mixed"))return result([{mixed:false}]);if(q.endsWith("AS bound"))return result([{bound:false}]);
    if(q.endsWith("AS command_materializations_available"))return result([{command_materializations_available:false}]);
    if(eventHeaders) return result(rows("events").filter(e=>e.record_id===params[1]).map(e=>{
      const h:Row={...e,actor_is_null:e.actor_participant_id===null,payload_bytes:Buffer.byteLength(JSON.stringify(e.payload))};
      for(const k of ["id","event_kind","speaker_name","actor_participant_id","scene_id","visibility_policy_id","calendar_id","display_time","content"]){h[k+"_bytes"]=Buffer.byteLength(String(e[k]??""));h[k+"_chars"]=String(e[k]??"").length;}return h;
    }));
    if(outboxHeaders)return result([]);
    if(topology) {
      assert.equal(params[0],workspaceId);
      const data=topology==="participants"?rows("participants").filter(p=>p.record_id===params[3]).map(p=>({participant_id:p.id,participant_kind:p.participant_kind,
        participant_character_instance_id:p.character_instance_id,participant_principal_id:p.principal_id,participant_controller_mode:p.controller_mode,
        participant_is_active:p.is_active,participant_speaking_order:p.speaking_order,participant_shared_control_enabled:p.shared_control_enabled}))
        :topology==="scenes"?rows("scenes").filter(s=>s.record_id===params[3]).map(s=>({...s,scene_id:s.id})):rows("visibility_policies").filter(p=>p.worldline_id===params[2]).map(p=>({...p,policy_id:p.id}));
      return result(topologyFixtureHeaders(q,data,params));
    }
    if(q.startsWith("SELECT 1 AS unsupported_scoped_goal"))return result([]);
    if(q.startsWith("SELECT record.id FROM records record WHERE")) {assert.equal(params[0],workspaceId);return result([]);}
    if(q.startsWith("/* memory resource head */")) {assert.deepEqual(params,[workspaceId,"world","line"]);return result([{head_tick:3,head_ordinal:0}]);}
    if(q.startsWith("SELECT linked_record_id FROM records")) {assert.deepEqual(params,[workspaceId,"world","line","record"]);return result([{linked_record_id:null}]);}
    if(q.startsWith("SELECT restore_delivery_kind")) {assert.deepEqual(params,[]);return result([]);}
    if(q.includes("FROM committed_fact_commands AS command")) {
      assert.equal(params[0],workspaceId);return result(rows("committed_fact_commands").filter(c=>c.worldline_id===params[2]&&c.idempotency_key===params[3]).map(c=>({...c,receipt_oversized:false,anchor_row:null})));
    }
    const table=/\bFROM (\w+)/.exec(q)?.[1];
    if(table==="goal_instances"||table==="goal_assessments")return result(rows(table).filter(g=>g.record_id===params[1]));
    if(table==="record_goal_definitions")return result(rows(table).filter(d=>d.record_id===(params.length===2?params[1]:params[3])));
    if(table==="committed_fact_commands")return result(rows(table).filter(c=>c.worldline_id===params[2]).map(c=>({...c,receipt_oversized:false})));
    if(table==="performance_assessments")return result(rows(table).filter(a=>a.worldline_id===params[2]));
    if(table==="stories")return result(rows(table).filter(s=>s.worldline_id===params[2]&&(params.length===3||s.id===params[3])));
    if(table&&["projects","project_milestones","project_story_links"].includes(table)) {assert.equal(params[0],workspaceId);return result(rows(table));}
    if(table==="story_definition_bindings") {assert.equal(params.length,4);assert.equal(params[0],workspaceId);assert.deepEqual(params[3],[]);assert.equal(rows("story_node_instances").length,0);return result([]);}
    if(table&&empty.has(table)) {assert.equal(params[0],workspaceId);assert.equal(rows(table).length,0,`explicit empty fixture ${table}`);return result([]);}
    unknownProtocol(`UNHANDLED_SQL_PROTOCOL:${q}`);
  }};
  return {database:{async connect(){acquired++;return client;}},controls,calls,state:()=>state,counts:()=>({acquired,released})};
}
const options={performanceWitnessesSchemaVersion:1 as const,validateWorldBinding:async()=>{}};
async function read(p:ReturnType<typeof protocol>,workspaceId:string,recordId:string,purpose:"record-export"|"whole-closure-backup"="record-export") {
  const a=await createPostgresRealmRuntimeSaveReader(p.database as never,{performanceWitnessesSchemaVersion:1,goalsSchemaVersion:2,resolveGoalSource:goalResolver}).load({workspaceId,recordId,principalId:"owner",purpose});assert.ok(a);return parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a),{goalsSchemaVersion:2});
}
function restore(p:ReturnType<typeof protocol>,workspaceId:string,archive:RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>,key="restore") {
  return createPostgresRealmRuntimeSaveRestorer(p.database as never,{...options,goalsSchemaVersion:2,resolveGoalSource:goalResolver}).restore({workspaceId,principalId:"owner",sessionProof:"proof",targetWorldId:"world",archive,idempotencyKey:key});
}

const contentDefinition={goalKey:"arrival",policyVersion:"p1",mode:"deterministic" as const,visible:true,
  rubric:{kind:"event_count" as const,eventKind:"utterance.committed",progressKey:"count",threshold:3},outcome:{}};
const goalResolver=createGoalContentBindingSource({mount:async()=>({manifest:{format:"realmworld",formatVersion:1,worldId:"world",worldVersion:"1.0",
  engineCompat:{schemaLatest:"",requiresMigrations:[],baseRange:"*"},contentHash:"a".repeat(64),signature:{algorithm:"ed25519",keyId:"fixture",value:""}},
  files:new Map([["content/goals.json",Buffer.from(JSON.stringify({format:"realmworld-goals",schemaVersion:1,goals:[contentDefinition]}))]])})});
async function seedGoals(p:ReturnType<typeof protocol>,withContent=false) {
  const state=p.state(),record=state.records[0];
  const scope={workspaceId:String(record.workspace_id),worldId:"world",worldlineId:"line",recordId:"record"};
  const d=createRecordGoalDefinition({scope,goalId:"authored",activationHead:{recordVersion:0,ordinal:0},draft:{title:"Keep evidence",description:"Retain the original.",changePolicy:"fixed",visible:true,successConditions:["Original retained"],failureConditions:[],settlementConditions:[]}});
  const g={...scope,workspace_id:scope.workspaceId,world_id:"world",worldline_id:"line",record_id:"record",scope_kind:"record",story_id:null,
    id:d.goalInstanceId,goal_key:d.goalKey,policy_version:d.policyVersion,state:"active",revision:1,progress:{literal:"original"},outcome:null,
    definition_source:"record",definition_id:d.definitionId,resolution_kind:"natural",evidence_start_version:0,evidence_start_ordinal:0,attempt:1,supersedes_instance_id:null,completed_at:null};
  state.goal_instances=[g];state.record_goal_definitions=[{workspace_id:scope.workspaceId,world_id:"world",worldline_id:"line",record_id:"record",definition:d}];
  const hash=goalEvidenceSnapshotHash({definition:d,instance:{goalInstanceId:g.id,recordId:"record",state:"active",revision:1,progress:g.progress,outcome:null},
    events:[{eventId:"event",recordId:"record",recordVersion:1,ordinal:1,kind:"utterance.committed",payload:{}}],evidenceHead:{recordVersion:1,ordinal:1}});
  state.goal_assessments=[{workspace_id:scope.workspaceId,world_id:"world",worldline_id:"line",record_id:"record",id:"goal-assessment",goal_instance_id:g.id,assessment_job_id:null,
    source_event_id:"event",source:"judge",status:"accepted",result:{policyVersion:d.policyVersion,evidenceSnapshotHash:hash,evidenceEventIds:["event"],literal:"original"},evidence_event_ids:["event"],evidence_head_version:1,evidence_head_ordinal:1,evidence_snapshot_hash:hash,policy_version:d.policyVersion}];
  if(withContent) {
    p.controls.goalSchema=true;
    const owner={scopeKind:"record" as const,worldId:"world",worldlineId:"line",recordId:"record"};
    const binding=bindGoalContentWitness(await goalResolver({worldId:"world",worldVersion:"1.0",goalKey:"arrival"}),scope.workspaceId,owner,"content-goal");
    state.goal_instances.push({...g,id:"content-goal",goal_key:"arrival",policy_version:"p1",revision:0,definition_source:"content",definition_id:null});
    state.bindings=[{goal_instance_id:"content-goal",binding}];
  }
}

test("proven legacy authored Goal evidence refuses a forged supplied historical hash before target writes",async()=>{
  const source=protocol("workspace",true);await seedGoals(source);
  const a=await read(source,"workspace","record");assert.equal(a.goals.schemaVersion,1);
  const bad=structuredClone(a);(bad.goals as unknown as {assessments:Row[]}).assessments[0].evidenceSnapshotHash="0".repeat(64);
  const target=protocol("target");target.controls.goalSchema=true;
  await assert.rejects(restore(target,"target",bad));assert.equal(target.calls.filter(c=>c.sql.startsWith("INSERT")).length,0);
});

test("candidate v3 admits only explicitly derived legacy authored identities through the complete Goal checker",()=>{
  const sql=readFileSync(new URL("../database/postgres/migrations/0085_runtime_performance_transport_body_v3.sql",import.meta.url),"utf8");
  assert.match(sql,/CREATE FUNCTION performance_restore_legacy_goal_source\(p_body jsonb\)/);
  assert.match(sql,/performance_restore_legacy_goal_source\(body\)/);
  assert.match(sql,/goal_restore_v2_plan_assert\(p_workspace,p_world,validation_plan\)/);
  assert.match(PERFORMANCE_RESTORE_TARGET_CAPABILITY_SQL,/performance_restore_legacy_goal_source\(jsonb\)/);
});

test("legacy authored planning keeps a Goal-bearing Record when its carried sibling has no Goals",async()=>{
  const source=protocol("workspace",true);await seedGoals(source);
  const archive=await read(source,"workspace","record"),emptyRecord={...archive.record,scope:{...archive.record.scope,recordId:"empty-record"},events:[],head:{recordVersion:0,nextRecordOrdinal:0}};
  archive.domain!.records=[{bundle:{record:emptyRecord,goals:{format:"realm-runtime-goals",schemaVersion:1,instances:[],assessments:[]}}} as never];
  const plan=planGoalRestore(archive,{workspaceId:"target",worldId:"world",worldlineId:"target-line",token:"token",storyIds:new Map([["story","target-story"]]),
    records:[{sourceRecordId:"record",targetRecordId:"target-record",recordDocument:archive.record,eventTargetIds:new Map([["event","target-event"],["later-event","target-later-event"]])},
      {sourceRecordId:"empty-record",targetRecordId:"target-empty",recordDocument:emptyRecord,eventTargetIds:new Map()}]});
  assert.equal(plan!.source.roots.length,1);assert.equal(plan!.source.assessments.length,1);
  assert.equal(plan!.mappings.filter(m=>m.entityKind==="record").length,2);
});

for(const withContent of [false,true])test(`nonempty performance plus ${withContent?"V2 content and record":"legacy record-authored"} Goals through real reader ZIP two independent targets and replay`,async()=>{
  const source=protocol("workspace",true);await seedGoals(source,withContent);
  const a=await read(source,"workspace","record");assert.equal(a.goals.schemaVersion,withContent?2:1);
  const target=protocol("target");target.controls.goalSchema=true;const first=await restore(target,"target",a);
  const writes=target.calls.filter(c=>c.sql.startsWith("INSERT")).length;
  assert.equal((await restore(target,"target",a)).replayed,true);assert.equal(target.calls.filter(c=>c.sql.startsWith("INSERT")).length,writes);
  const exported=await read(target,"target",first.recordId),second=protocol("second");second.controls.goalSchema=true;
  const last=await restore(second,"second",exported,"second-goal"),again=await read(second,"second",last.recordId);
  assert.equal(target.state().goal_instances.length,withContent?2:1);assert.equal(second.state().goal_assessments.length,1);
  assert.notEqual(second.state().goal_assessments[0].id,target.state().goal_assessments[0].id);
  assert.notEqual(second.state().goal_assessments[0].evidence_snapshot_hash,target.state().goal_assessments[0].evidence_snapshot_hash);
  assert.equal((second.state().goal_assessments[0].result as Row).literal,"original");
  assert.deepEqual(again.performanceWitnesses!.witnesses[0].origin,a.performanceWitnesses!.witnesses[0].origin);
});

const branchRuntimePresenceSql=norm(`SELECT EXISTS(SELECT 1 FROM events WHERE workspace_id=$1 AND record_id=$2
    AND event_kind='narration.committed' AND (jsonb_typeof(payload#>'{__realmRuntimePayload,narrativeState}')='object'
      OR jsonb_typeof(payload->'narrativeState')='object'))
    OR EXISTS(SELECT 1 FROM performance_assessments WHERE workspace_id=$1 AND record_id=$2 AND world_id=$3 AND worldline_id=$4) AS present`);
const legacyBranchSceneSql=norm(`SELECT title, location, objective, tension, weather, display_time
     FROM scenes WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4
       AND (start_tick < $5 OR (start_tick = $5 AND start_ordinal <= $6))
     ORDER BY start_tick DESC, start_ordinal DESC, created_at DESC LIMIT 1`);
function performanceOnlyNative() {
  const p=protocol("workspace",true);p.controls.goalSchema=true;
  p.state().records[0].world_version=LOCAL_WORLD_VERSION;
  const snapshot=JSON.parse(String(p.state().performance_evidence_snapshots[0].manifest_canonical));
  snapshot.binding.worldVersion=LOCAL_WORLD_VERSION;
  const hash=performanceEvidenceSnapshotHash(snapshot);
  p.state().performance_evidence_snapshots[0].manifest_canonical=performanceEvidenceSnapshotCanonical(snapshot);
  p.state().performance_evidence_snapshots[0].manifest_hash=hash;
  (p.state().committed_fact_commands[0].result_manifest as {performanceWitness:Row}).performanceWitness.manifestHash=hash;
  assert.equal((p.state().goal_instances??[]).length,0);
  assert.equal((p.state().record_goal_definitions??[]).length,0);
  assert.ok(p.state().events.every(e=>e.event_kind!=="narration.committed"));
  return p;
}
test("performance-only native source selects the complete Library snapshot without Goals or narrative",async()=>{
  const p=performanceOnlyNative(),scope={workspaceId:"workspace",principalId:"owner",sessionProof:"proof"};
  const privateSibling={...structuredClone(p.state().records[0]),id:"private-sibling",title:"private sibling"};
  p.state().records.push(privateSibling);
  const sourceCanonical=p.state().performance_evidence_snapshots[0].manifest_canonical;
  const service=createPostgresLibraryService(p.database as never,undefined,{performanceWitnessesSchemaVersion:1});
  let branch:Awaited<ReturnType<typeof service.branchRecord>>|undefined,failure:unknown;
  try {branch=await service.branchRecord(scope,{sourceRecordId:"record",idempotencyKey:"only-performance"});}catch(e){failure=e;}
  assert.equal(p.calls.some(c=>c.sql===legacyBranchSceneSql),false,"nonempty performance history must not select the lossy legacy clone branch");
  assert.ifError(failure);assert.ok(branch);assert.equal(branch.replayed,false);
  const ledger=p.state().performance_evidence_transport_provenance;
  assert.equal(ledger.length,1);assert.equal(ledger[0].record_id,branch.recordId);
  const envelope=JSON.parse(String(ledger[0].envelope_canonical));
  assert.equal(envelope.origin.witness.manifestCanonical,sourceCanonical);assert.equal(envelope.projection.assessment.score,10);
  assert.equal((p.state().goal_instances??[]).length,0,"no Goal is fabricated to force snapshot selection");
  assert.deepEqual(p.state().records.find(r=>r.id==="private-sibling"),privateSibling);
  const inserts=p.calls.filter(c=>c.sql.startsWith("INSERT")).length;
  assert.equal((await service.branchRecord(scope,{sourceRecordId:"record",idempotencyKey:"only-performance"})).replayed,true);
  assert.equal(p.calls.filter(c=>c.sql.startsWith("INSERT")).length,inserts);
  await assert.rejects(service.branchRecord(scope,{sourceRecordId:"record",idempotencyKey:"old-only-performance",fork:{worldTick:2,worldOrdinal:1}}),{code:"BRANCH_GOAL_STATE_UNAVAILABLE"});
  assert.equal(p.calls.filter(c=>c.sql.startsWith("INSERT")).length,inserts);
  const denied=performanceOnlyNative();
  await assert.rejects(createPostgresRealmRuntimeSaveReader(denied.database as never,{goalsSchemaVersion:2,performanceWitnessesSchemaVersion:undefined}).load({workspaceId:scope.workspaceId,principalId:scope.principalId,recordId:"record",purpose:"record-export"}),{code:"PERFORMANCE_TRANSPORT_VERSION_UNSUPPORTED"});
  assert.equal(denied.calls.filter(c=>c.sql.startsWith("INSERT")).length,0);
});
test("performance-only native selector keeps the no-performance source on the existing legacy path",async()=>{
  const p=performanceOnlyNative();p.state().performance_assessments=[];p.state().performance_evidence_snapshots=[];p.state().committed_fact_commands=[];
  await assert.rejects(createPostgresLibraryService(p.database as never,undefined,{performanceWitnessesSchemaVersion:1}).branchRecord(
    {workspaceId:"workspace",principalId:"owner",sessionProof:"proof"},{sourceRecordId:"record",idempotencyKey:"no-performance"}),{code:"TEST_LEGACY_BRANCH_SELECTED"});
  assert.equal(p.calls.filter(c=>c.sql===legacyBranchSceneSql).length,1);
  assert.equal(p.calls.filter(c=>c.sql.startsWith("INSERT")).length,0);
  // Deliberate pre-write path-selection sentinel, NOT proof of a completed legacy clone.
});

test("performance native branch calls the actual Library facade, locks source/head, restores and replays without private siblings",async()=>{
  const p=protocol("workspace",true);await seedGoals(p);p.controls.goalSchema=true;
  // Base native branch still uses the real package/version boundary.
  p.state().records[0].world_version=LOCAL_WORLD_VERSION;
  const snapshot=JSON.parse(String(p.state().performance_evidence_snapshots[0].manifest_canonical));
  snapshot.binding.worldVersion=LOCAL_WORLD_VERSION;
  const hash=performanceEvidenceSnapshotHash(snapshot);
  p.state().performance_evidence_snapshots[0].manifest_canonical=performanceEvidenceSnapshotCanonical(snapshot);
  p.state().performance_evidence_snapshots[0].manifest_hash=hash;
  (p.state().committed_fact_commands[0].result_manifest as {performanceWitness:Row}).performanceWitness.manifestHash=hash;
  const privateSibling={...structuredClone(p.state().records[0]),id:"private-sibling",title:"private sibling"};
  p.state().records.push(privateSibling);
  const defaults=createPostgresLibraryService(p.database as never);
  p.controls.ready=false;
  await assert.rejects(defaults.branchRecord({workspaceId:"workspace",principalId:"owner",sessionProof:"proof"},
    {sourceRecordId:"record",idempotencyKey:"request-cannot-enable",performanceWitnessesSchemaVersion:1} as never),{code:"PERFORMANCE_TRANSPORT_TARGET_UNSUPPORTED"});
  assert.equal(p.calls.filter(c=>c.sql.startsWith("INSERT")).length,0);
  p.controls.ready=true;
  const service=defaults;
  const scope={workspaceId:"workspace",principalId:"owner",sessionProof:"proof"},input={sourceRecordId:"record",idempotencyKey:"native-performance"};
  p.controls.ready=false;
  await assert.rejects(service.branchRecord(scope,input),{code:"PERFORMANCE_TRANSPORT_TARGET_UNSUPPORTED"});
  assert.equal(p.calls.filter(c=>c.sql.startsWith("INSERT")).length,0);p.controls.ready=true;
  await assert.rejects(service.branchRecord({...scope,sessionProof:undefined},input));
  assert.equal(p.calls.filter(c=>c.sql.startsWith("INSERT")).length,0);
  const created=await service.branchRecord(scope,input);assert.equal(created.replayed,false);
  assert.equal(p.state().performance_evidence_transport_provenance.length,1);
  const writes=p.calls.filter(c=>c.sql.startsWith("INSERT")).length;
  assert.equal((await service.branchRecord(scope,input)).replayed,true);assert.equal(p.calls.filter(c=>c.sql.startsWith("INSERT")).length,writes);
  await assert.rejects(service.branchRecord(scope,{...input,idempotencyKey:"historical",fork:{worldTick:2,worldOrdinal:1}}),{code:"BRANCH_GOAL_STATE_UNAVAILABLE"});
  assert.equal(p.calls.filter(c=>c.sql.startsWith("INSERT")).length,writes);
  const sourceLock=p.calls.findIndex(c=>c.sql.includes("FOR UPDATE OF record")),headLock=p.calls.findIndex(c=>c.sql.startsWith("SELECT last_world_tick::text"));
  assert.ok(sourceLock>0&&headLock>sourceLock);assert.equal(p.state().records.length,3);
  assert.deepEqual(p.state().records.find(r=>r.id==="private-sibling"),privateSibling);
});

test("native source reader -> ZIP -> real restore -> persisted proof -> store/service replay -> reader reexport -> second independent restore",async()=>{
  const source=protocol("workspace",true),a=await read(source,"workspace","record");
  const target=protocol("target"),first=await restore(target,"target",a);
  assert.equal(first.replayed,false);assert.equal(target.state().performance_evidence_transport_provenance.length,1);
  const writes=target.calls.filter(c=>c.sql.startsWith("INSERT")).length;
  assert.equal((await restore(target,"target",a)).replayed,true);assert.equal(target.calls.filter(c=>c.sql.startsWith("INSERT")).length,writes);
  const scope={workspaceId:"target",worldId:"world",worldlineId:first.worldlineId};
  const service=createCommittedFactCommandService({store:createPostgresCommittedFactCommandStore(target.database as never)});
  const e=JSON.parse(String(target.state().performance_evidence_transport_provenance[0].envelope_canonical));
  const intent={scope,recordId:first.recordId,policyVersion:"structured-factors:v1",evidenceEventIds:e.projection.request.evidenceEventIds,idempotencyKey:"accepted"};
  const result=await service.recordPerformanceAssessment(intent);assert.equal(result.status,"replayed");assert.equal(result.score,10);
  assert.doesNotMatch(JSON.stringify(result),/historical-private-actor|manifestCanonical|origin|performanceTransport/);
  const exported=await read(target,"target",first.recordId);
  const second=protocol("second"),last=await restore(second,"second",exported,"second-restore");
  const again=await read(second,"second",last.recordId);
  assert.deepEqual(again.performanceWitnesses!.witnesses[0].origin,a.performanceWitnesses!.witnesses[0].origin);
  assert.notEqual(last.recordId,first.recordId);assert.notEqual(again.performanceWitnesses!.witnesses[0].projection.commandId,e.projection.commandId);
  assert.notEqual(again.performanceWitnesses!.witnesses[0].projection.assessmentId,e.projection.assessmentId);
  assert.equal((await createCommittedFactCommandService({store:createPostgresCommittedFactCommandStore(second.database as never)}).recordPerformanceAssessment({scope:{workspaceId:"second",worldId:"world",worldlineId:last.worldlineId},recordId:last.recordId,policyVersion:"structured-factors:v1",evidenceEventIds:again.performanceWitnesses!.witnesses[0].projection.request.evidenceEventIds,idempotencyKey:"accepted"})).score,10);
  await assert.rejects(service.recordPerformanceAssessment({...intent,evidenceEventIds:["other"]}),{code:"IDEMPOTENCY_KEY_REUSE"});
  assert.equal(target.calls.filter(c=>c.sql.startsWith("INSERT")).length,writes);
  for(const p of [source,target,second])assert.equal(p.counts().acquired,p.counts().released);
});

test("complete milestone references survive real reader/materializer/readback and a second persistent hop",async()=>{
  const a=await read(protocol("workspace",true,true),"workspace","record");
  const t=protocol("target"),r=await restore(t,"target",a);
  const exported=await read(t,"target",r.recordId);
  const next=protocol("second"),second=await restore(next,"second",exported,"milestone-second");
  const saved=await read(next,"second",second.recordId),e=saved.performanceWitnesses!.witnesses[0];
  assert.equal(e.projection.result.score,30);assert.deepEqual(e.origin,a.performanceWitnesses!.witnesses[0].origin);
  for(const kind of ["project","milestone"]) {
    const pair=e.projection.relation.identities.find(p=>p.kind===kind)!;assert.notEqual(pair.originId,pair.currentId);
  }
});

test("whole-closure reader retains the same private native family through its authorized snapshot",async()=>{
  const previous=process.env.REALM_OPERATOR_PRINCIPALS;process.env.REALM_OPERATOR_PRINCIPALS="owner";
  try {
    const a=await read(protocol("workspace",true),"workspace","record","whole-closure-backup");
    assert.equal(a.performanceWitnesses!.witnesses[0].origin.assessment.score,10);
  } finally {if(previous===undefined)delete process.env.REALM_OPERATOR_PRINCIPALS;else process.env.REALM_OPERATOR_PRINCIPALS=previous;}
});

test("direct store checks the complete transported request, later unrelated facts preserve score, and complete-body reuse refuses",async()=>{
  const a=await read(protocol("workspace",true),"workspace","record"),t=protocol("target"),r=await restore(t,"target",a);
  const e=JSON.parse(String(t.state().performance_evidence_transport_provenance[0].envelope_canonical)),p=e.projection;
  const store=createPostgresCommittedFactCommandStore(t.database as never);
  const input={scope:p.scope,commandId:p.commandId,idempotencyKey:"accepted",requestFingerprint:p.requestFingerprint,recordId:p.recordId,policyVersion:p.request.policyVersion,score:p.request.score,evidenceEventIds:p.request.evidenceEventIds,evidenceSnapshotHash:p.result.evidenceSnapshotHash,request:p.request};
  assert.equal((await store.recordPerformanceAssessment(input)).status,"replayed");
  const request={...p.request,score:11};
  await assert.rejects(store.recordPerformanceAssessment({...input,score:11,request,requestFingerprint:committedFactRequestFingerprintFor(p.scope,request)}),{code:"IDEMPOTENCY_KEY_REUSE"});
  t.state().events.push({...structuredClone(t.state().events[0]),id:"after-acceptance",record_version:3,record_ordinal:3,world_tick:4,world_ordinal:0});
  Object.assign(t.state().record_heads[0],{record_version:3,next_record_ordinal:4});
  assert.equal((await store.recordPerformanceAssessment(input)).score,10);
  const changed=structuredClone(a);changed.domain!.stories![0].title="different full body";
  changed.manifest=realmRuntimeSaveManifestFromData({...changed,...changed.manifest});
  await assert.rejects(restore(t,"target",changed));
  const broken=structuredClone(a);delete broken.performanceWitnesses;
  await assert.rejects(restore(t,"target",broken));
  t.controls.owner=false;await assert.rejects(restore(t,"target",a),{code:"WORLD_NOT_FOUND"});
  assert.equal(r.replayed,false);
});

test("declared consumer fails readiness and current permission before target projection; phase failures roll back",async()=>{
  const a=await read(protocol("workspace",true),"workspace","record");
  for(const failure of ["ready","owner","events","committed_fact_commands","performance_assessments","performance_evidence_transport_provenance"]) {
    const target=protocol("target");if(failure==="ready")target.controls.ready=false;else if(failure==="owner")target.controls.owner=false;else target.controls.failTable=failure;
    if(failure==="ready"||failure==="owner") await assert.rejects(restore(target,"target",a),{code:failure==="ready"?"PERFORMANCE_TRANSPORT_TARGET_UNSUPPORTED":"WORLD_NOT_FOUND"});
    else await assert.rejects(restore(target,"target",a),new RegExp(`INJECTED_WRITE:${failure}`));
    assert.deepEqual(target.state(),{});assert.equal(target.calls.at(-1)!.sql,"ROLLBACK");
  }
});

test("independent native source and persistent ledger/request/result/assessment corruption cannot replay or export",async()=>{
  for(const field of ["request","result","assessment","witness"]) {
    const p=protocol("workspace",true);
    if(field==="request") (p.state().committed_fact_commands[0].result_manifest as {request:Row}).request.score=11;
    if(field==="result") (p.state().committed_fact_commands[0].result_manifest as {result:Row}).result.score=11;
    if(field==="assessment")p.state().performance_assessments[0].score=11;
    if(field==="witness")p.state().performance_evidence_snapshots=[];
    await assert.rejects(read(p,"workspace","record"));
  }
  const a=await read(protocol("workspace",true),"workspace","record");
  for(const field of ["ledger","ledger-missing","scope","tuple","request","result","assessment","header"]) {
    const p=protocol("target"),r=await restore(p,"target",a),c=p.state().committed_fact_commands[0];
    if(field==="ledger")p.state().performance_evidence_transport_provenance[0].envelope_hash="0".repeat(64);
    if(field==="ledger-missing")p.state().performance_evidence_transport_provenance=[];
    if(field==="scope")p.state().performance_evidence_transport_provenance[0].workspace_id="foreign";
    if(field==="tuple")p.state().performance_evidence_transport_provenance[0].source_command_id="other";
    if(field==="request")(c.result_manifest as {request:Row}).request.score=11;
    if(field==="result")(c.result_manifest as {result:Row}).result.score=11;
    if(field==="assessment")p.state().performance_assessments[0].score=11;
    if(field==="header")p.state().events[0].world_tick=99;
    await assert.rejects(read(p,"target",r.recordId));await assert.rejects(restore(p,"target",a));
  }
});
