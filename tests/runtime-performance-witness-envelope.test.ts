import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { committedFactRequestFingerprintFor, evidenceHash } from "../modules/application/committed-fact-command.ts";
import { decodePerformanceEvidenceSnapshot, performanceEvidenceSnapshotCanonical, performanceEvidenceSnapshotHash, type PerformanceEvidenceSnapshotV1 } from "../modules/application/performance-evidence-snapshot.ts";
import { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive, realmRuntimeSaveManifestFromData, computeRealmRuntimeSaveContentHash, RUNTIME_SAVE_FILE_BYTES, RuntimeSectionWireLedger, type RealmRuntimeSaveArchive } from "../modules/world-transfer/realm-runtime-save.ts";
import { performanceWitnessEnvelopeDigest, performanceWitnessEnvelopeCanonical, runtimePerformanceWitnessesCanonical, runtimePerformanceWitnessesDigest, normalizeRuntimePerformanceWitnesses,
  type PerformanceWitnessOriginV1, type PerformanceWitnessProjectionV1 } from "../modules/world-transfer/runtime-performance-witness-transport.ts";
import { createPostgresRealmRuntimeSaveRestorer } from "../database/postgres/realm-runtime-save-repository.ts";

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
function rehash(entries: Record<string, Uint8Array>): Uint8Array {
  const manifest = JSON.parse(Buffer.from(entries["realm-save-manifest.json"]).toString());
  manifest.snapshot.runtimeHash = computeRealmRuntimeSaveContentHash(new Map(Object.entries(entries).filter(([p])=>p.startsWith("runtime/"))));
  entries["realm-save-manifest.json"] = Buffer.from(JSON.stringify(manifest));
  return zipSync(entries);
}

test("complete native-origin private witness travels through the real ZIP codec and retains historical bytes", () => {
  const source = fixture(), before = structuredClone(source);
  const bytes = buildRealmRuntimeSaveArchive(source), parsed = parseRealmRuntimeSaveArchive(bytes);
  assert.ok(unzipSync(bytes)["runtime/performance-witnesses.json"]);
  assert.deepEqual(parsed.performanceWitnesses, source.performanceWitnesses);
  assert.equal(parsed.manifest.performanceWitnessesFormat?.digest, runtimePerformanceWitnessesDigest(source.performanceWitnesses));
  assert.equal(parsed.performanceWitnesses!.witnesses[0].origin.witness.manifestCanonical, before.performanceWitnesses!.witnesses[0].origin.witness.manifestCanonical);
  assert.match(runtimePerformanceWitnessesCanonical(parsed.performanceWitnesses), /historical-private-actor/);
  assert.equal(performanceWitnessEnvelopeCanonical(parsed.performanceWitnesses!.witnesses[0]),JSON.stringify(JSON.parse(runtimePerformanceWitnessesCanonical(parsed.performanceWitnesses)).witnesses[0]));
  assert.deepEqual(source, before);
  assert.deepEqual(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(parsed)).performanceWitnesses, parsed.performanceWitnesses);
});

test("ZIP independently refuses family/declaration/version/digest/marker omissions and tampering even with repaired outer hash", () => {
  const valid = buildRealmRuntimeSaveArchive(fixture());
  const attacks: Array<(entries: Record<string, Uint8Array>)=>void> = [
    entries => { delete entries["runtime/performance-witnesses.json"]; },
    entries => { const m = JSON.parse(Buffer.from(entries["realm-save-manifest.json"]).toString()); delete m.performanceWitnessesFormat; entries["realm-save-manifest.json"] = Buffer.from(JSON.stringify(m)); },
    entries => { const m = JSON.parse(Buffer.from(entries["realm-save-manifest.json"]).toString()); m.performanceWitnessesFormat.schemaVersion=99; entries["realm-save-manifest.json"] = Buffer.from(JSON.stringify(m)); },
    entries => { const f=JSON.parse(Buffer.from(entries["runtime/performance-witnesses.json"]).toString()); f.schemaVersion=2; entries["runtime/performance-witnesses.json"]=Buffer.from(JSON.stringify(f)); },
    entries => { const f=JSON.parse(Buffer.from(entries["runtime/performance-witnesses.json"]).toString()); f.witnesses[0].origin.result.score=11; entries["runtime/performance-witnesses.json"]=Buffer.from(JSON.stringify(f)); },
    entries => { const d=JSON.parse(Buffer.from(entries["runtime/domain.json"]).toString()); delete d.committedFactCommands[0].resultManifest.performanceTransport; entries["runtime/domain.json"]=Buffer.from(JSON.stringify(d)); },
  ];
  for (const attack of attacks) { const entries=unzipSync(valid); attack(entries); assert.throws(()=>parseRealmRuntimeSaveArchive(rehash(entries))); }
});

test("exact typed bijection rejects duplicates, cross-scope, missing kinds and bad origin before repaired projections", () => {
  const source = fixture();
  const attacks: Array<(f: NonNullable<RealmRuntimeSaveArchive["performanceWitnesses"]>)=>void> = [
    f => { const p=f.witnesses[0].projection; p.relation.identities=[...p.relation.identities,p.relation.identities[0]]; },
    f => { f.witnesses[0].projection.relation.currentScope = { ...f.witnesses[0].projection.scope, workspaceId: "foreign" }; },
    f => { f.witnesses[0].projection.relation.identities=f.witnesses[0].projection.relation.identities.filter(p=>p.kind!=="policy"); },
    f => { f.witnesses[0].origin.request.score=11; },
    f => { Object.assign(f.witnesses[0].projection, { currentHead: {} }); },
    f => { f.witnesses=[...f.witnesses,f.witnesses[0]]; },
    f => { f.witnesses[0].projection.result.goalTransition=NaN as never; },
    f => { delete (f.witnesses as unknown[])[0]; },
  ];
  for (const attack of attacks) { const f=structuredClone(source.performanceWitnesses!); attack(f); assert.throws(()=>normalizeRuntimePerformanceWitnesses(f)); }
  let calls=0; const f=structuredClone(source.performanceWitnesses!);
  Object.defineProperty(f.witnesses[0], "origin", { enumerable:true, get(){calls++;throw Error("private");} });
  assert.throws(()=>normalizeRuntimePerformanceWitnesses(f)); assert.equal(calls,0);
});

test("current facts and historical headers cannot be substituted by rehashing the projection", () => {
  for (const mutate of [(a: RealmRuntimeSaveArchive)=>{ (a.record.events[0].payload as Record<string, unknown>).worldTick=8; },
    (a: RealmRuntimeSaveArchive)=>{ a.topology!.visibilityPolicies=[{...a.topology!.visibilityPolicies[0],policyVersion:2}]; }]) {
    const a=fixture(); mutate(a); assert.throws(()=>realmRuntimeSaveManifestFromData({...a,...a.manifest}));
  }
});

test("family uses the existing per-file and remaining aggregate wire ledger", () => {
  const family=fixture().performanceWitnesses!;
  const bytes=Buffer.byteLength(runtimePerformanceWitnessesCanonical(family));
  const ledger=new RuntimeSectionWireLedger("runtime/performance-witnesses.json","canonical-runtime",bytes);
  ledger.reserve(family); ledger.verify(bytes);
  assert.throws(()=>new RuntimeSectionWireLedger("runtime/performance-witnesses.json","canonical-runtime",bytes-1).reserve(family));
  assert.equal(RUNTIME_SAVE_FILE_BYTES,64*1024*1024);
});

test("explicitly undeclared consumer refuses the accepted family before package lookup or database acquisition", async () => {
  const archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(fixture())); let connects=0, lookups=0;
  const restorer=createPostgresRealmRuntimeSaveRestorer({async connect(){connects++;throw Error("forbidden");}} as never,{performanceWitnessesSchemaVersion:undefined,async validateWorldBinding(){lookups++;throw Error("forbidden");}});
  await assert.rejects(restorer.restore({archive,workspaceId:"target",principalId:"operator",targetWorldId:"world",idempotencyKey:"restore"}),{code:"PERFORMANCE_TRANSPORT_VERSION_UNSUPPORTED"});
  const missing=structuredClone(archive);delete missing.performanceWitnesses;
  await assert.rejects(restorer.restore({archive:missing,workspaceId:"target",principalId:"operator",targetWorldId:"world",idempotencyKey:"missing-family"}),{code:"PERFORMANCE_TRANSPORT_VERSION_UNSUPPORTED"});
  assert.equal(connects,0);assert.equal(lookups,0);
});

test("projection scope can advance with explicit typed references while immutable origin survives repeated codec hops", () => {
  let archive=fixture(); const origin=structuredClone(archive.performanceWitnesses!.witnesses[0].origin);
  for(const workspaceId of ["hop-two","hop-three"]){
    archive=structuredClone(archive);
    const e=archive.performanceWitnesses!.witnesses[0],p=e.projection;
    p.scope={...p.scope,workspaceId};p.relation.currentScope={...p.scope};
    p.relation.identities=[...p.relation.identities].reverse();
    p.requestFingerprint=committedFactRequestFingerprintFor(p.scope,p.request);
    e.digest=performanceWitnessEnvelopeDigest({version:1,origin:e.origin,projection:p});
    archive.domain!.committedFactCommands=[{...archive.domain!.committedFactCommands[0],requestFingerprint:p.requestFingerprint,resultManifest:{...p.result,performanceTransport:{version:1,digest:e.digest}}}];
    archive.manifest.scope.workspaceId=workspaceId;
    archive.manifest=realmRuntimeSaveManifestFromData({...archive,...archive.manifest});
    archive=parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive));
    assert.deepEqual(archive.performanceWitnesses!.witnesses[0].origin,origin);
  }
});

test("milestone completion keeps complete Project/Milestone/Event typed relations and admitted factors", () => {
  const a=structuredClone(fixture()),e=a.performanceWitnesses!.witnesses[0],o=e.origin;
  const snapshot=decodePerformanceEvidenceSnapshot(o.witness.manifestCanonical);
  snapshot.factors={evidenceCount:1,milestoneCompleted:true,score:30};
  snapshot.milestoneWitness={id:"milestone",projectId:"project",completionRecordId:"record",completionEventId:"event",completionHeader:{...snapshot.evidence[0]}};
  o.request={...o.request,score:30};o.requestFingerprint=committedFactRequestFingerprintFor(o.scope,o.request);
  snapshot.requestFingerprint=o.requestFingerprint;
  o.result={...o.result,score:30};o.assessment={...o.assessment,score:30};
  o.witness.manifestCanonical=performanceEvidenceSnapshotCanonical(snapshot);o.witness.manifestHash=performanceEvidenceSnapshotHash(snapshot);o.marker={version:1,manifestHash:o.witness.manifestHash};
  const p=e.projection;p.request={...o.request};p.requestFingerprint=o.requestFingerprint;p.result={...o.result};p.assessment={...o.assessment};
  p.relation.identities=[...p.relation.identities,{kind:"project",originId:"project",currentId:"project"},{kind:"milestone",originId:"milestone",currentId:"milestone"}];
  e.digest=performanceWitnessEnvelopeDigest({version:1,origin:o,projection:p});
  a.domain!.projects=[{id:"project",kind:"production",status:"active",stage:"planning",title:"Project",currency:"JPY",deadline:null,version:1}];
  a.domain!.milestones=[{id:"milestone",projectId:"project",sequence:1,title:"Done",status:"completed",dueOn:null,completionRecordId:"record",completionEventId:"event"}];
  a.domain!.performanceAssessments=[p.assessment];a.domain!.committedFactCommands=[{...a.domain!.committedFactCommands[0],request:p.request,requestFingerprint:p.requestFingerprint,resultManifest:{...p.result,performanceTransport:{version:1,digest:e.digest}}}];
  a.manifest=realmRuntimeSaveManifestFromData({...a,...a.manifest});
  assert.equal(parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(a)).performanceWitnesses!.witnesses[0].projection.result.score,30);
  a.domain!.milestones=[{...a.domain!.milestones[0],completionEventId:null}];
  assert.throws(()=>realmRuntimeSaveManifestFromData({...a,...a.manifest}));
});

test("0084 candidate has exact private schema/tuple/hash/append-only guards and once-only registrations", () => {
  const sql=readFileSync(new URL("../database/postgres/migrations/0084_performance_evidence_transport_provenance.sql",import.meta.url),"utf8");
  assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS /g)??[]).length,1);
  assert.match(sql,/CREATE TABLE IF NOT EXISTS performance_evidence_transport_provenance/);
  assert.match(sql,/FOREIGN KEY \(workspace_id\) REFERENCES workspaces \(id\)/);
  for(const [column,table] of [["record_id","records"],["command_id","committed_fact_commands"],["assessment_id","performance_assessments"]])
    assert.ok(sql.includes(`FOREIGN KEY (workspace_id,world_id,worldline_id,${column})\n    REFERENCES ${table}(workspace_id,world_id,worldline_id,id)`));
  for(const text of ["ENABLE ROW LEVEL SECURITY","FORCE ROW LEVEL SECURITY","BEFORE UPDATE OR DELETE","BEFORE TRUNCATE","version=1","262144","67108864","PERFORMANCE_TRANSPORT_CANONICAL","PERFORMANCE_TRANSPORT_RELATION","PERFORMANCE_TRANSPORT_ORIGIN","PERFORMANCE_TRANSPORT_TUPLE","realm-runtime-performance-witness-envelope:v1","performance-evidence-snapshot:v1"])assert.ok(sql.includes(text),text);
  assert.doesNotMatch(sql,/SECURITY DEFINER|REFERENCES (?:accounts|player_world_memberships)|GRANT (?:UPDATE|DELETE|TRUNCATE)|ALTER TABLE (?!performance_evidence_transport_provenance)/);
  assert.match(sql,/GRANT SELECT,INSERT ON performance_evidence_transport_provenance TO realm_runtime/);
  assert.match(sql,/REVOKE ALL ON performance_evidence_transport_provenance FROM PUBLIC,realm_runtime,realm_transfer,realm_control/);
  const pkg=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  const core=Object.entries(pkg.scripts).filter(([name])=>name!=="test:postgres-runtime").flatMap(([,s])=>String(s).match(/tests\/runtime-performance-witness-envelope\.test\.ts/g)??[]);
  assert.equal(core.length,1);assert.match(pkg.scripts["test:core"],/tests\/runtime-performance-witness-envelope\.test\.ts/);
  const runner=readFileSync(new URL("../scripts/test-postgres-runtime-with-scratch.mjs",import.meta.url),"utf8");
  assert.equal((runner.match(/"tests\/postgres-performance-evidence-transport-schema\.test\.ts"/g)??[]).length,1);
  assert.equal(Object.values(pkg.scripts).filter(s=>String(s).includes("postgres-performance-evidence-transport-schema.test.ts")).length,0);
});
