import type { PoolClient } from "pg";
import type { ProjectScope } from "../../modules/projects/public.ts";
import { committedFactCommandIdFor, committedFactRequestFingerprintFor, evidenceHash } from "../../modules/application/committed-fact-command.ts";
import { normalizePerformanceEvidenceSnapshot, performanceEvidenceSnapshotCanonical, performanceEvidenceSnapshotHash, PERFORMANCE_SNAPSHOT_MAX_BYTES, type PerformanceEvidenceMode, type PerformanceEvidenceSnapshotV1 } from "../../modules/application/performance-evidence-snapshot.ts";
import { lockWorkspaceCommandKey, withWorkspaceTransaction, type WorkspaceDatabase } from "./workspace-transaction.ts";

export interface ApprovedPerformanceEvidencePolicy { mode: PerformanceEvidenceMode; policyId: string }
export interface PerformanceCommandTrust {
  scope: ProjectScope; principalId: string; evidencePolicy: ApprovedPerformanceEvidencePolicy | null;
  /** Server assembly only. Production leaves both disabled pending schema and A4-T approval. */
  enablement?: { schema: boolean; durableTransport: boolean };
}
export interface PerformanceAssessmentIntent { recordId: string; policyVersion: "structured-factors:v1"; evidenceEventIds: readonly string[]; idempotencyKey: string }
export class PerformanceAdmissionError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status: number) { super("Performance assessment is unavailable."); this.name = "PerformanceAdmissionError"; this.code = code; this.status = status; }
}
function refuse(code: string, status = 422): never { throw new PerformanceAdmissionError(code, status); }
interface Admission {
  trust: PerformanceCommandTrust; intent: PerformanceAssessmentIntent; role: "owner" | "player";
  capture?: PerformanceEvidenceSnapshotV1; consumed: boolean; executing: boolean;
}
// No serializable bearer token and no public function to adopt an arbitrary client.
const transactions = new WeakMap<PoolClient, Admission>();
function identity(trust: PerformanceCommandTrust, intent: PerformanceAssessmentIntent): string {
  return JSON.stringify([trust.scope.workspaceId, trust.scope.worldId, trust.scope.worldlineId, trust.principalId, intent]);
}
function one(rows: { rows: Array<{ status: string }>; rowCount: number | null }, missing: string): string {
  if (rows.rowCount !== 1 || !rows.rows[0]) refuse(missing, 404);
  return rows.rows[0].status;
}

/** Pool entry owns BEGIN; client entry only composes inside this function's still-live private admission. */
export async function withPerformanceAdmissionTransaction<T>(database: WorkspaceDatabase, trust: PerformanceCommandTrust, intent: PerformanceAssessmentIntent, work: (client: PoolClient) => Promise<T>): Promise<T> {
  if ("release" in database) {
    const admission = transactions.get(database);
    if (!admission || admission.executing || identity(admission.trust, admission.intent) !== identity(trust, intent)) refuse("PERFORMANCE_TRANSACTION_UNPROVEN");
    admission.executing = true;
    try { return await work(database); } finally { admission.executing = false; }
  }
  return withWorkspaceTransaction(database, trust.scope.workspaceId, async client => {
    const mode = await client.query<{ isolation_level: string; read_only: string; workspace_id: string }>(
      `SELECT current_setting('transaction_isolation') AS isolation_level,
              current_setting('transaction_read_only') AS read_only,
              current_setting('realm.workspace_id', true) AS workspace_id`, []);
    const m = mode.rows[0];
    if (mode.rowCount !== 1 || m?.isolation_level !== "read committed" || m.read_only !== "off" || m.workspace_id !== trust.scope.workspaceId) refuse("PERFORMANCE_TRANSACTION_UNPROVEN");
    const { workspaceId, worldId, worldlineId } = trust.scope;
    const world = one(await client.query<{ status: string }>(`SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR SHARE`, [workspaceId, worldId]), "WORLD_NOT_FOUND");
    const membership = await client.query<{ role: string | null }>(`SELECT public.bridge_command_membership_role($1, $2, $3) AS role`, [workspaceId, worldId, trust.principalId]);
    const role = membership.rows[0]?.role;
    if (membership.rowCount !== 1 || !role) refuse("WORLD_NOT_FOUND", 404);
    if (role !== "owner" && role !== "player") refuse("FORBIDDEN", 403);
    if (world !== "active") refuse("WORLD_ARCHIVED", 409);
    const record = one(await client.query<{ status: string }>(`SELECT status FROM records WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4 FOR NO KEY UPDATE`, [workspaceId, worldId, worldlineId, intent.recordId]), "RECORD_NOT_FOUND");
    if (record === "archived") refuse("RECORD_ARCHIVED", 409);
    const line = one(await client.query<{ status: string }>(`SELECT status FROM worldlines WHERE workspace_id = $1 AND world_id = $2 AND id = $3 FOR UPDATE`, [workspaceId, worldId, worldlineId]), "WORLD_NOT_FOUND");
    if (line !== "active") refuse("WORLDLINE_NOT_WRITABLE", 409);
    const head = await client.query<{ record_version: string; next_record_ordinal: string; last_event_id: string | null; last_world_tick: string | null; last_world_ordinal: string | null }>(
      `SELECT record_version::text, next_record_ordinal::text, last_event_id, last_world_tick::text, last_world_ordinal::text FROM record_heads WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 FOR UPDATE`, [workspaceId, worldId, worldlineId, intent.recordId]);
    const h = head.rows[0];
    const dec = (x: unknown) => typeof x === "string" && /^(0|[1-9][0-9]{0,18})$/.test(x);
    if (head.rowCount !== 1 || !h || !dec(h.record_version) || h.record_version === "0" || !dec(h.next_record_ordinal) || h.next_record_ordinal === "0"
      || typeof h.last_event_id !== "string" || !h.last_event_id || !dec(h.last_world_tick) || !dec(h.last_world_ordinal)) refuse("SNAPSHOT_UNAVAILABLE");
    await lockWorkspaceCommandKey(client, "fact", trust.scope, intent.idempotencyKey);
    const admission: Admission = { trust: structuredClone(trust), intent: structuredClone(intent), role, consumed: false, executing: false };
    transactions.set(client, admission);
    try { return await work(client); } finally { transactions.delete(client); }
  });
}

export const PERFORMANCE_SNAPSHOT_READY_SQL = "SELECT version, manifest_canonical, manifest_hash FROM public.performance_evidence_snapshots WHERE false";

/** Called once, only after the post-key receipt read returned NEW. */
export async function capturePerformanceEvidence(client: PoolClient): Promise<PerformanceEvidenceSnapshotV1> {
  const a = transactions.get(client);
  if (!a || a.capture || a.consumed) refuse("PERFORMANCE_TRANSACTION_UNPROVEN");
  const policy = a.trust.evidencePolicy;
  if (!policy || policy.mode !== "engine-authoritative-v1" || typeof policy.policyId !== "string" || !policy.policyId.trim() || Buffer.byteLength(policy.policyId, "utf8") > 1024) refuse("PERFORMANCE_EVIDENCE_POLICY_UNRESOLVED");
  if (a.trust.enablement?.schema !== true) refuse("PERFORMANCE_SCHEMA_UNAVAILABLE", 503);
  if (a.trust.enablement?.durableTransport !== true) refuse("PERFORMANCE_TRANSPORT_UNAVAILABLE", 503);
  try { await client.query(PERFORMANCE_SNAPSHOT_READY_SQL, []); }
  catch (error) { if (["42P01", "42703", "42501"].includes((error as { code?: string }).code ?? "")) refuse("PERFORMANCE_SCHEMA_UNAVAILABLE", 503); throw error; }
  const { scope, principalId } = a.trust, i = a.intent;
  const result = await client.query<{ error_code: string | null; capture_text: string | null }>(PERFORMANCE_CAPTURE_SQL,
    [scope.workspaceId, scope.worldId, scope.worldlineId, i.recordId, i.evidenceEventIds, principalId, a.role, policy.policyId, policy.mode]);
  const row = result.rows[0];
  if (result.rowCount !== 1 || !row || row.error_code || typeof row.capture_text !== "string"
    || row.capture_text.length > PERFORMANCE_SNAPSHOT_MAX_BYTES || Buffer.byteLength(row.capture_text, "utf8") > PERFORMANCE_SNAPSHOT_MAX_BYTES) {
    if (row?.error_code === "EVENT_NOT_FOUND") refuse("EVENT_NOT_FOUND", 404);
    refuse("SNAPSHOT_UNAVAILABLE");
  }
  let capture: Record<string, unknown>;
  try { capture = JSON.parse(row.capture_text); } catch { return refuse("SNAPSHOT_UNAVAILABLE"); }
  if (capture === null || typeof capture !== "object" || Array.isArray(capture)
    || Object.keys(capture).sort().join(",") !== ["scope", "admission", "binding", "head", "worldlineHead", "currentScene", "headEvent", "evidence", "factors", "milestoneWitness"].sort().join(",")) refuse("SNAPSHOT_UNAVAILABLE");
  const factors = capture.factors as { score?: unknown } | undefined;
  const request = { command: "performance.assessed", recordId: i.recordId, policyVersion: i.policyVersion, score: factors?.score, evidenceEventIds: i.evidenceEventIds };
  const requestFingerprint = committedFactRequestFingerprintFor(scope, request);
  const commandId = committedFactCommandIdFor(scope, i.idempotencyKey, requestFingerprint);
  let snapshot: PerformanceEvidenceSnapshotV1;
  try { snapshot = normalizePerformanceEvidenceSnapshot({ ...capture, version: 1, policyVersion: i.policyVersion, commandId, assessmentId: `${commandId}:assessment`, requestFingerprint }); }
  catch { return refuse("SNAPSHOT_UNAVAILABLE"); }
  if (JSON.stringify(snapshot.scope) !== JSON.stringify({ ...scope, recordId: i.recordId })
    || snapshot.admission.principalId !== principalId || snapshot.admission.role !== a.role
    || snapshot.admission.evidencePolicyId !== policy.policyId || snapshot.admission.evidenceMode !== policy.mode
    || JSON.stringify(snapshot.evidence.map(e => e.id)) !== JSON.stringify(i.evidenceEventIds)) refuse("SNAPSHOT_UNAVAILABLE");
  a.capture = snapshot;
  return normalizePerformanceEvidenceSnapshot(snapshot);
}

type PerformanceInput = Parameters<import("../../modules/application/committed-fact-command.ts").CommittedFactCommandStore["recordPerformanceAssessment"]>[0];
/** Revalidate the complete direct-store request, without replacing any field with historical data. */
export function validatePerformanceStoreInput(input: PerformanceInput): void {
  const expected = { command: "performance.assessed", recordId: input.recordId, policyVersion: input.policyVersion, score: input.score, evidenceEventIds: input.evidenceEventIds };
  if (Object.keys(input.request).length !== Object.keys(expected).length
    || Object.entries(expected).some(([k, v]) => JSON.stringify(input.request[k]) !== JSON.stringify(v))
    || committedFactRequestFingerprintFor(input.scope, input.request) !== input.requestFingerprint
    || evidenceHash(input.evidenceEventIds) !== input.evidenceSnapshotHash) refuse("IDEMPOTENCY_KEY_REUSE", 409);
}
export function requirePerformanceWriteAdmission(client: PoolClient, input: PerformanceInput): { snapshot: PerformanceEvidenceSnapshotV1; canonical: string; hash: string } {
  validatePerformanceStoreInput(input);
  const a = transactions.get(client), s = a?.capture;
  if (!a || !s || a.consumed || identity(a.trust, a.intent) !== identity({ ...a.trust, scope: input.scope }, { recordId: input.recordId, policyVersion: input.policyVersion as "structured-factors:v1", evidenceEventIds: input.evidenceEventIds, idempotencyKey: input.idempotencyKey })
    || s.commandId !== input.commandId || s.requestFingerprint !== input.requestFingerprint || s.factors.score !== input.score) refuse("PERFORMANCE_ADMISSION_REQUIRED");
  a.consumed = true;
  return { snapshot: normalizePerformanceEvidenceSnapshot(s), canonical: performanceEvidenceSnapshotCanonical(s), hash: performanceEvidenceSnapshotHash(s) };
}

export const PERFORMANCE_CAPTURE_SQL = `WITH h AS MATERIALIZED (
 SELECT r.story_id,r.world_version,r.status AS record_status,
  rh.record_version,rh.next_record_ordinal,rh.last_event_id,
  rh.last_world_tick,rh.last_world_ordinal,
  COALESCE(rh.last_world_tick,r.start_tick) AS effective_tick,
  COALESCE(rh.last_world_ordinal,r.start_ordinal) AS effective_ordinal,
  wl.head_tick,wl.head_ordinal
 FROM records r JOIN record_heads rh ON
  (rh.workspace_id,rh.world_id,rh.worldline_id,rh.record_id)=
  (r.workspace_id,r.world_id,r.worldline_id,r.id)
 JOIN worldlines wl ON (wl.workspace_id,wl.world_id,wl.id)=
  (r.workspace_id,r.world_id,r.worldline_id)
 WHERE r.workspace_id=$1 AND r.world_id=$2 AND r.worldline_id=$3 AND r.id=$4
), requested AS MATERIALIZED (
 SELECT id,ord FROM unnest($5::text[]) WITH ORDINALITY AS q(id,ord)
), m AS MATERIALIZED (
 SELECT pm.id,pm.project_id,pm.completion_record_id,pm.completion_event_id
 FROM project_milestones pm
 WHERE pm.workspace_id=$1 AND pm.world_id=$2 AND pm.worldline_id=$3
  AND pm.completion_record_id=$4 AND pm.status='completed'
 ORDER BY pm.id COLLATE "C" LIMIT 1
), wanted AS MATERIALIZED (
 SELECT 'evidence'::text AS source,ord,id FROM requested
 UNION ALL SELECT 'head',0,last_event_id FROM h WHERE last_event_id IS NOT NULL
 UNION ALL SELECT 'milestone',0,completion_event_id FROM m
), headers AS MATERIALIZED (
 SELECT w.source,w.ord,ev.id,ev.scene_id,ev.visibility_policy_id,
  ev.record_version,ev.record_ordinal,ev.world_tick,ev.world_ordinal,
  p.policy_version,p.policy_kind,s.start_tick,s.start_ordinal
 FROM wanted w JOIN events ev ON ev.id=w.id
 JOIN scenes s ON (s.workspace_id,s.world_id,s.worldline_id,s.record_id,s.id)=
  (ev.workspace_id,ev.world_id,ev.worldline_id,ev.record_id,ev.scene_id)
 JOIN visibility_policies p ON
  (p.workspace_id,p.world_id,p.worldline_id,p.record_id,p.id)=
  (ev.workspace_id,ev.world_id,ev.worldline_id,ev.record_id,ev.visibility_policy_id)
 WHERE ev.workspace_id=$1 AND ev.world_id=$2 AND ev.worldline_id=$3 AND ev.record_id=$4
), current_scene AS MATERIALIZED (
 SELECT s.id,s.start_tick,s.start_ordinal,s.status FROM scenes s CROSS JOIN h
 WHERE s.workspace_id=$1 AND s.world_id=$2 AND s.worldline_id=$3 AND s.record_id=$4
  AND (s.start_tick,s.start_ordinal)<=(h.effective_tick,h.effective_ordinal)
 ORDER BY s.start_tick DESC,s.start_ordinal DESC,s.id ASC LIMIT 1
), gate AS MATERIALIZED (
 SELECT CASE
 WHEN $9::text IS DISTINCT FROM 'engine-authoritative-v1'
   OR $8::text IS NULL OR btrim($8::text)='' THEN 'PERFORMANCE_EVIDENCE_POLICY_UNRESOLVED'
 WHEN cardinality($5::text[]) NOT BETWEEN 1 AND 32
   OR (SELECT count(DISTINCT id) FROM requested)<>cardinality($5::text[])
   OR array_position($5::text[],NULL) IS NOT NULL THEN 'COMMAND_INVALID'
 WHEN (SELECT count(*) FROM h)<>1 OR (SELECT count(*) FROM current_scene)<>1
   THEN 'SNAPSHOT_UNAVAILABLE'
 WHEN (SELECT count(*) FROM headers WHERE source='evidence')<>cardinality($5::text[])
   THEN 'EVENT_NOT_FOUND'
 WHEN (SELECT count(*) FROM headers WHERE source='head')<>1
   THEN 'SNAPSHOT_UNAVAILABLE'
 WHEN (SELECT count(*) FROM headers WHERE source='milestone')<>(SELECT count(*) FROM m)
   THEN 'SNAPSHOT_UNAVAILABLE'
 WHEN EXISTS (SELECT 1 FROM h WHERE record_status='archived'
   OR record_version<1 OR next_record_ordinal<1 OR last_event_id IS NULL
   OR last_world_tick IS NULL OR last_world_ordinal IS NULL
   OR (last_world_tick,last_world_ordinal)>(head_tick,head_ordinal))
   THEN 'SNAPSHOT_UNAVAILABLE'
 WHEN EXISTS (SELECT 1 FROM headers x CROSS JOIN h
   WHERE x.record_version>h.record_version OR x.record_ordinal>=h.next_record_ordinal
    OR (x.world_tick,x.world_ordinal)>(h.effective_tick,h.effective_ordinal)
    OR (x.world_tick,x.world_ordinal)>(h.head_tick,h.head_ordinal)
    OR (x.start_tick,x.start_ordinal)>(x.world_tick,x.world_ordinal))
   THEN 'SNAPSHOT_UNAVAILABLE'
 WHEN EXISTS (SELECT 1 FROM headers x CROSS JOIN h WHERE x.source='head'
   AND (x.id IS DISTINCT FROM h.last_event_id
    OR x.record_version IS DISTINCT FROM h.record_version
    OR x.record_ordinal IS DISTINCT FROM h.next_record_ordinal-1
    OR x.world_tick IS DISTINCT FROM h.last_world_tick
    OR x.world_ordinal IS DISTINCT FROM h.last_world_ordinal))
   THEN 'SNAPSHOT_UNAVAILABLE'
 WHEN EXISTS (SELECT 1 FROM headers WHERE
   octet_length(id)>1024 OR octet_length(scene_id)>1024 OR octet_length(visibility_policy_id)>1024)
   OR EXISTS (SELECT 1 FROM current_scene WHERE octet_length(id)>1024)
   OR EXISTS (SELECT 1 FROM h WHERE octet_length(story_id)>1024 OR octet_length(world_version)>1024)
   OR EXISTS (SELECT 1 FROM m WHERE octet_length(id)>1024 OR octet_length(project_id)>1024
     OR octet_length(completion_record_id)>1024 OR octet_length(completion_event_id)>1024)
   OR octet_length($1::text)>1024 OR octet_length($2::text)>1024
   OR octet_length($3::text)>1024 OR octet_length($4::text)>1024
   OR octet_length($6::text)>1024 OR octet_length($8::text)>1024
   THEN 'SNAPSHOT_OVERSIZED'
 WHEN $6::text IS NULL OR btrim($6::text)='' OR $7::text IS NULL
   OR $7::text NOT IN ('owner','player') THEN 'FORBIDDEN'
 ELSE NULL END AS error_code
), encoded_headers AS MATERIALIZED (
 SELECT x.source,x.ord,CASE WHEN g.error_code IS NULL THEN jsonb_build_object(
  'id',x.id,'sceneId',x.scene_id,'visibilityPolicyId',x.visibility_policy_id,
  'policyVersion',x.policy_version::text,'policyKind',x.policy_kind,
  'recordVersion',x.record_version::text,'recordOrdinal',x.record_ordinal::text,
  'worldTick',x.world_tick::text,'worldOrdinal',x.world_ordinal::text,
  'sceneStartTick',x.start_tick::text,'sceneStartOrdinal',x.start_ordinal::text
 ) ELSE NULL END AS header FROM headers x CROSS JOIN gate g
), body AS MATERIALIZED (
 SELECT g.error_code,CASE WHEN g.error_code IS NULL THEN jsonb_build_object(
  'scope',jsonb_build_object('workspaceId',$1::text,'worldId',$2::text,'worldlineId',$3::text,'recordId',$4::text),
  'admission',jsonb_build_object('principalId',$6::text,'role',$7::text,
    'evidencePolicyId',$8::text,'evidenceMode',$9::text),
  'binding',(SELECT jsonb_build_object('storyId',story_id,'worldVersion',world_version) FROM h),
  'head',(SELECT jsonb_build_object('recordVersion',record_version::text,
    'nextRecordOrdinal',next_record_ordinal::text,'lastEventId',last_event_id,
    'lastWorldTick',last_world_tick::text,'lastWorldOrdinal',last_world_ordinal::text,
    'effectiveTick',effective_tick::text,'effectiveOrdinal',effective_ordinal::text) FROM h),
  'worldlineHead',(SELECT jsonb_build_object('tick',head_tick::text,'ordinal',head_ordinal::text) FROM h),
  'currentScene',(SELECT jsonb_build_object('id',id,'startTick',start_tick::text,
    'startOrdinal',start_ordinal::text,'status',status) FROM current_scene),
  'headEvent',(SELECT header-'sceneStartTick'-'sceneStartOrdinal' FROM encoded_headers WHERE source='head'),
  'evidence',(SELECT jsonb_agg(header ORDER BY ord) FROM encoded_headers WHERE source='evidence'),
  'factors',jsonb_build_object('evidenceCount',cardinality($5::text[]),
    'milestoneCompleted',EXISTS(SELECT 1 FROM m),
    'score',cardinality($5::text[])*10+CASE WHEN EXISTS(SELECT 1 FROM m) THEN 20 ELSE 0 END),
  'milestoneWitness',(SELECT jsonb_build_object('id',id,'projectId',project_id,
    'completionRecordId',completion_record_id,'completionEventId',completion_event_id,
    'completionHeader',(SELECT header FROM encoded_headers WHERE source='milestone')) FROM m)
 ) ELSE NULL END AS capture FROM gate g
), wire AS MATERIALIZED (
 SELECT error_code,capture::text AS capture_text FROM body
)
SELECT CASE WHEN error_code IS NOT NULL THEN error_code
  WHEN octet_length(capture_text)>262144 THEN 'SNAPSHOT_OVERSIZED' ELSE NULL END AS error_code,
 CASE WHEN error_code IS NULL AND octet_length(capture_text)<=262144 THEN capture_text
  ELSE NULL END AS capture_text FROM wire;`;
