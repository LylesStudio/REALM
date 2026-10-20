import type { PoolClient } from "pg";
import type { ProjectScope } from "../../modules/projects/public.ts";
import type { ScopedFactReceiptRow } from "./committed-fact-command-repository.ts";
import { PerformanceEvidenceReceiptError, validatePerformanceEvidenceReceipt } from "../../modules/application/performance-evidence-receipt.ts";
import type { PerformanceEvidenceSnapshotV1 } from "../../modules/application/performance-evidence-snapshot.ts";
import { normalizeRuntimePerformanceWitnesses, performanceWitnessEnvelopeCanonical,
  type PerformanceWitnessEnvelopeV1 } from "../../modules/world-transfer/runtime-performance-witness-transport.ts";

/** Source-only read. No target identity, restore actor or mutable current head is an input. */
export const PERFORMANCE_EVIDENCE_SOURCE_SQL = `SELECT snapshot.record_id, snapshot.assessment_id, snapshot.command_id, snapshot.version,
       CASE WHEN octet_length(snapshot.manifest_canonical) <= 262144 THEN snapshot.manifest_canonical ELSE NULL END AS manifest_canonical,
       snapshot.manifest_hash, assessment.policy_version, assessment.score, assessment.evidence_event_ids, assessment.evidence_snapshot_hash,
       assessment.record_id AS assessment_record_id, assessment.command_id AS assessment_command_id
FROM performance_evidence_snapshots AS snapshot
JOIN performance_assessments AS assessment
  ON (assessment.workspace_id, assessment.world_id, assessment.worldline_id, assessment.id)
   = (snapshot.workspace_id, snapshot.world_id, snapshot.worldline_id, snapshot.assessment_id)
WHERE snapshot.workspace_id = $1 AND snapshot.world_id = $2 AND snapshot.worldline_id = $3
  AND snapshot.record_id = $4 AND snapshot.command_id = $5 AND snapshot.assessment_id = $6`;

interface SourceWitnessRow {
  record_id: string; assessment_id: string; command_id: string; version: number;
  manifest_canonical: string | null; manifest_hash: string;
  policy_version: string; score: number; evidence_event_ids: string[]; evidence_snapshot_hash: string;
  assessment_record_id: string; assessment_command_id: string;
}

export interface PerformanceEvidenceSource {
  snapshot: PerformanceEvidenceSnapshotV1;
  receipt: {
    scope: ProjectScope; commandId: string; requestFingerprint: string;
    request: Record<string, unknown>; result: Record<string, unknown>; marker: Record<string, unknown>;
    witness: { recordId: string; assessmentId: string; commandId: string; version: number; manifestCanonical: string; manifestHash: string };
    assessment: { id: string; recordId: string; commandId: string; policyVersion: string; score: number; evidenceEventIds: string[]; evidenceSnapshotHash: string };
  };
}

function invalid(): never { throw new PerformanceEvidenceReceiptError(); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function dataObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !descriptors[key]?.enumerable
    || !Object.hasOwn(descriptors[key], "value"))) invalid();
  return value as Record<string, unknown>;
}

/**
 * Inspect the stored envelope before ordinary receipt projection loses the marker.
 * Validate and retain the original accepted source tuple, not a guessed request or
 * a target-rehashed snapshot. The returned private data proves consistency only;
 * it grants no current permission and does not establish source authenticity.
 * A caller still needs a versioned writer before it can transport this data.
 */
export async function readPerformanceEvidenceSource(
  client: PoolClient, scope: ProjectScope, row: ScopedFactReceiptRow,
): Promise<PerformanceEvidenceSource | null> {
  const manifest = dataObject(row.result_manifest);
  if (!Object.hasOwn(manifest, "performanceWitness")) return null;
  if (row.workspace_id !== scope.workspaceId || row.world_id !== scope.worldId || row.worldline_id !== scope.worldlineId
    || row.receipt_oversized !== false || row.kind !== "performance_assessed"
    || Object.keys(manifest).some(key => !["provenance", "request", "result", "performanceWitness"].includes(key))
    || (Object.hasOwn(manifest, "provenance") && manifest.provenance !== "request-result-v1")) invalid();
  const marker = dataObject(manifest.performanceWitness);
  if (Object.keys(marker).sort().join(",") !== "manifestHash,version" || marker.version !== 1
    || typeof marker.manifestHash !== "string" || !/^[0-9a-f]{64}$/.test(marker.manifestHash)) invalid();
  const request = dataObject(manifest.request), result = dataObject(manifest.result);
  exactKeys(request, ["command", "recordId", "policyVersion", "score", "evidenceEventIds"]);
  exactKeys(result, ["status", "commandId", "assessmentId", "score", "evidenceSnapshotHash", "goalTransition"]);
  if (request.command !== "performance.assessed" || typeof request.policyVersion !== "string" || !Number.isSafeInteger(request.score)
    || !Array.isArray(request.evidenceEventIds) || request.evidenceEventIds.length < 1 || request.evidenceEventIds.length > 32
    || Reflect.ownKeys(request.evidenceEventIds).length !== request.evidenceEventIds.length + 1
    || typeof result.status !== "string" || !["committed", "replayed"].includes(result.status) || !Number.isSafeInteger(result.score)
    || typeof result.evidenceSnapshotHash !== "string" || result.goalTransition !== null) invalid();
  const ids = Object.getOwnPropertyDescriptors(request.evidenceEventIds);
  for (let index = 0; index < request.evidenceEventIds.length; index++) {
    const descriptor = ids[String(index)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string"
      || Buffer.byteLength(descriptor.value, "utf8") > 1024) invalid();
  }
  if (typeof request.recordId !== "string" || !request.recordId || typeof result.assessmentId !== "string"
    || !result.assessmentId || result.commandId !== row.id) invalid();
  for (const value of [request.recordId, request.policyVersion, result.commandId, result.assessmentId, row.request_fingerprint, result.evidenceSnapshotHash]) {
    if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 1024) invalid();
  }
  // Detach before the query await. The raw source request/marker must not drift
  // while the sidecar is read on the caller's same scoped snapshot/client.
  const source = JSON.parse(JSON.stringify({ scope: { workspaceId: scope.workspaceId, worldId: scope.worldId, worldlineId: scope.worldlineId }, commandId: row.id, requestFingerprint: row.request_fingerprint,
    request, result, marker })) as Omit<PerformanceEvidenceSource["receipt"], "witness" | "assessment">;
  const found = await client.query<SourceWitnessRow>(PERFORMANCE_EVIDENCE_SOURCE_SQL,
    [source.scope.workspaceId, source.scope.worldId, source.scope.worldlineId,
      source.request.recordId, source.commandId, source.result.assessmentId]);
  const witness = found.rows[0];
  if (found.rowCount !== 1 || found.rows.length !== 1 || !witness || typeof witness.manifest_canonical !== "string") invalid();
  const receipt: PerformanceEvidenceSource["receipt"] = { ...source,
    witness: { recordId: witness.record_id, assessmentId: witness.assessment_id, commandId: witness.command_id,
      version: witness.version, manifestCanonical: witness.manifest_canonical, manifestHash: witness.manifest_hash },
    assessment: { id: witness.assessment_id, recordId: witness.assessment_record_id, commandId: witness.assessment_command_id,
      policyVersion: witness.policy_version, score: witness.score, evidenceEventIds: witness.evidence_event_ids,
      evidenceSnapshotHash: witness.evidence_snapshot_hash },
  };
  const snapshot = validatePerformanceEvidenceReceipt(receipt);
  return { snapshot, receipt: structuredClone(receipt) };
}

export const PERFORMANCE_TRANSPORT_READ_SQL = `SELECT ledger.*,
  command.request_fingerprint, command.result_manifest,
  assessment.policy_version, assessment.score, assessment.evidence_event_ids, assessment.evidence_snapshot_hash,
  assessment.record_id AS assessment_record_id, assessment.command_id AS assessment_command_id
FROM performance_evidence_transport_provenance ledger
JOIN committed_fact_commands command ON (command.workspace_id,command.world_id,command.worldline_id,command.id)
  = (ledger.workspace_id,ledger.world_id,ledger.worldline_id,ledger.command_id)
JOIN performance_assessments assessment ON (assessment.workspace_id,assessment.world_id,assessment.worldline_id,assessment.id)
  = (ledger.workspace_id,ledger.world_id,ledger.worldline_id,ledger.assessment_id)
WHERE ledger.workspace_id=$1 AND ledger.world_id=$2 AND ledger.worldline_id=$3 AND ledger.command_id=$4`;

export const PERFORMANCE_TRANSPORT_HEADERS_SQL = `SELECT event.id, event.record_id, event.scene_id, event.visibility_policy_id,
  event.record_version::text, event.record_ordinal::text, event.world_tick::text, event.world_ordinal::text,
  policy.policy_version::text, policy.policy_kind, scene.start_tick::text, scene.start_ordinal::text,
  record.story_id, record.world_version, head.record_version::text AS head_version, head.next_record_ordinal::text AS head_ordinal
FROM events event
JOIN records record ON (record.workspace_id,record.world_id,record.worldline_id,record.id)
  = (event.workspace_id,event.world_id,event.worldline_id,event.record_id)
JOIN record_heads head ON head.workspace_id=record.workspace_id AND head.record_id=record.id
JOIN scenes scene ON (scene.workspace_id,scene.world_id,scene.worldline_id,scene.id)
  = (event.workspace_id,event.world_id,event.worldline_id,event.scene_id)
JOIN visibility_policies policy ON (policy.workspace_id,policy.world_id,policy.worldline_id,policy.id)
  = (event.workspace_id,event.world_id,event.worldline_id,event.visibility_policy_id)
WHERE event.workspace_id=$1 AND event.world_id=$2 AND event.worldline_id=$3 AND event.record_id=$4 AND event.id=ANY($5::text[])`;

export const PERFORMANCE_TRANSPORT_SCENE_SQL = `SELECT start_tick::text,start_ordinal::text FROM scenes
WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 AND id=$5`;
export const PERFORMANCE_TRANSPORT_MILESTONE_SQL = `SELECT milestone.project_id,milestone.status,milestone.completion_record_id,milestone.completion_event_id
FROM project_milestones milestone JOIN projects project
  ON (project.workspace_id,project.world_id,project.worldline_id,project.id)
   = (milestone.workspace_id,milestone.world_id,milestone.worldline_id,milestone.project_id)
WHERE milestone.workspace_id=$1 AND milestone.world_id=$2 AND milestone.worldline_id=$3 AND milestone.id=$4`;

function equal(a: unknown, b: unknown): void { if (JSON.stringify(a) !== JSON.stringify(b)) invalid(); }
/** Actual persisted proof and immutable fact readback. No cache or supplied origin. */
export async function readPerformanceTransport(client: PoolClient, scope: ProjectScope,
  commandId: string, expectedRow?: ScopedFactReceiptRow): Promise<PerformanceWitnessEnvelopeV1> {
  const found = await client.query(PERFORMANCE_TRANSPORT_READ_SQL, [scope.workspaceId,scope.worldId,scope.worldlineId,commandId]);
  if (found.rowCount !== 1 || found.rows.length !== 1) invalid();
  const r = found.rows[0];
  let entry: PerformanceWitnessEnvelopeV1;
  try {
    entry = normalizeRuntimePerformanceWitnesses({ format: "realm-runtime-performance-witnesses", schemaVersion: 1,
      witnesses: [JSON.parse(r.envelope_canonical)] }).witnesses[0];
    if (performanceWitnessEnvelopeCanonical(entry) !== r.envelope_canonical) invalid();
  } catch { return invalid(); }
  const p = entry.projection, o = entry.origin;
  equal([r.workspace_id,r.world_id,r.worldline_id,r.record_id,r.command_id,r.assessment_id,r.version,r.envelope_hash,r.source_manifest_hash],
    [scope.workspaceId,scope.worldId,scope.worldlineId,p.recordId,commandId,p.assessmentId,1,entry.digest,o.witness.manifestHash]);
  equal([r.source_workspace_id,r.source_world_id,r.source_worldline_id,r.source_record_id,r.source_command_id,r.source_assessment_id],
    [o.scope.workspaceId,o.scope.worldId,o.scope.worldlineId,o.request.recordId,o.commandId,o.assessment.id]);
  equal([p.scope.workspaceId,p.scope.worldId,p.scope.worldlineId,p.commandId], [scope.workspaceId,scope.worldId,scope.worldlineId,commandId]);
  const manifest = dataObject(r.result_manifest);
  exactKeys(manifest, ["request","result","performanceTransport"]);
  // Canonical comparison also rejects repaired result/assessment mutations.
  const canon = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
    if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canon(Reflect.get(v,k))}`).join(",")}}`;
    return JSON.stringify(v);
  };
  if (canon(manifest) !== canon({request:p.request,result:p.result,performanceTransport:{version:1,digest:entry.digest}})
    || r.request_fingerprint !== p.requestFingerprint) invalid();
  if (expectedRow && (expectedRow.id !== commandId || expectedRow.kind !== "performance_assessed"
    || expectedRow.receipt_oversized !== false || expectedRow.workspace_id !== scope.workspaceId
    || expectedRow.world_id !== scope.worldId || expectedRow.worldline_id !== scope.worldlineId
    || expectedRow.request_fingerprint !== p.requestFingerprint || canon(expectedRow.result_manifest) !== canon(manifest))) invalid();
  equal([r.assessment_record_id,r.assessment_command_id,r.policy_version,r.score,r.evidence_event_ids,r.evidence_snapshot_hash],
    [p.recordId,p.commandId,p.assessment.policyVersion,p.assessment.score,p.assessment.evidenceEventIds,p.assessment.evidenceSnapshotHash]);
  const s = validatePerformanceEvidenceReceipt(o);
  const mapped = (kind: string, id: string) => p.relation.identities.find(pair=>pair.kind===kind && pair.originId===id)?.currentId ?? invalid();
  const headers = [s.headEvent,...s.evidence,...(s.milestoneWitness?[s.milestoneWitness.completionHeader]:[])];
  const ids = [...new Set(headers.map(h=>mapped("event",h.id)))];
  const facts = await client.query(PERFORMANCE_TRANSPORT_HEADERS_SQL,[scope.workspaceId,scope.worldId,scope.worldlineId,p.recordId,ids]);
  if (facts.rows.length !== ids.length || new Set(facts.rows.map(r=>r.id)).size !== ids.length) invalid();
  for (const h of headers) {
    const f = facts.rows.find(f=>f.id===mapped("event",h.id)); if (!f) invalid();
    equal([f.record_id,f.story_id,f.world_version,f.scene_id,f.visibility_policy_id,f.record_version,f.record_ordinal,f.world_tick,f.world_ordinal,f.policy_version,f.policy_kind],
      [p.recordId,p.storyId,s.binding.worldVersion,mapped("scene",h.sceneId),mapped("policy",h.visibilityPolicyId),h.recordVersion,h.recordOrdinal,h.worldTick,h.worldOrdinal,h.policyVersion,h.policyKind]);
    if (BigInt(f.head_version)<BigInt(s.head.recordVersion) || BigInt(f.head_ordinal)<BigInt(s.head.nextRecordOrdinal)) invalid();
    if ("sceneStartTick" in h && "sceneStartOrdinal" in h) equal([f.start_tick,f.start_ordinal],[h.sceneStartTick,h.sceneStartOrdinal]);
  }
  const scene = await client.query(PERFORMANCE_TRANSPORT_SCENE_SQL,[scope.workspaceId,scope.worldId,scope.worldlineId,p.recordId,mapped("scene",s.currentScene.id)]);
  if (scene.rows.length!==1) invalid();
  equal([scene.rows[0].start_tick,scene.rows[0].start_ordinal],[s.currentScene.startTick,s.currentScene.startOrdinal]);
  if(s.milestoneWitness) {
    const m=s.milestoneWitness, result=await client.query(PERFORMANCE_TRANSPORT_MILESTONE_SQL,[scope.workspaceId,scope.worldId,scope.worldlineId,mapped("milestone",m.id)]);
    if(result.rows.length!==1) invalid(); const v=result.rows[0];
    equal([v.project_id,v.status,v.completion_record_id,v.completion_event_id],[mapped("project",m.projectId),"completed",p.recordId,mapped("event",m.completionEventId)]);
  }
  return entry;
}
