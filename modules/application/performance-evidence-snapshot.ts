import { createHash } from "node:crypto";

export const PERFORMANCE_SNAPSHOT_MAX_BYTES = 262144;
const ID_MAX_BYTES = 1024;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HASH = /^[0-9a-f]{64}$/;
export type PerformanceEvidenceMode = "engine-authoritative-v1" | "viewer-limited-v1";
export interface PerformanceEventHeader {
  id: string; sceneId: string; visibilityPolicyId: string;
  policyVersion: string; policyKind: string; recordVersion: string;
  recordOrdinal: string; worldTick: string; worldOrdinal: string;
}
export interface PerformanceEvidenceHeader extends PerformanceEventHeader {
  sceneStartTick: string; sceneStartOrdinal: string;
}
export interface PerformanceEvidenceSnapshotV1 {
  version: 1;
  scope: { workspaceId: string; worldId: string; worldlineId: string; recordId: string };
  assessmentId: string; commandId: string; requestFingerprint: string;
  policyVersion: "structured-factors:v1";
  admission: { principalId: string; role: "owner" | "player"; evidencePolicyId: string; evidenceMode: PerformanceEvidenceMode };
  binding: { storyId: string; worldVersion: string };
  head: { recordVersion: string; nextRecordOrdinal: string; lastEventId: string;
    lastWorldTick: string; lastWorldOrdinal: string; effectiveTick: string; effectiveOrdinal: string };
  worldlineHead: { tick: string; ordinal: string };
  currentScene: { id: string; startTick: string; startOrdinal: string; status: string };
  headEvent: PerformanceEventHeader;
  evidence: PerformanceEvidenceHeader[];
  factors: { evidenceCount: number; milestoneCompleted: boolean; score: number };
  milestoneWitness: null | { id: string; projectId: string; completionRecordId: string;
    completionEventId: string; completionHeader: PerformanceEvidenceHeader };
}

export class PerformanceSnapshotError extends Error {
  readonly code = "SNAPSHOT_INVALID";
  constructor() { super("Performance evidence snapshot is invalid."); this.name = "PerformanceSnapshotError"; }
}
function invalid(): never { throw new PerformanceSnapshotError(); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.some(k => !descriptors[k as string]?.enumerable || !Object.hasOwn(descriptors[k as string], "value"))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > ID_MAX_BYTES
    || Buffer.byteLength(value, "utf8") > ID_MAX_BYTES || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) invalid();
  return value;
}
function decimal(value: unknown, positive = false): string {
  const result = text(value);
  // PostgreSQL bigint domain, retained as a decimal string without Number conversion.
  if (!DECIMAL.test(result) || result.length > 19 || BigInt(result) > BigInt("9223372036854775807")
    || (positive && result === "0")) invalid();
  return result;
}
function same(a: unknown, b: unknown): void { if (a !== b) invalid(); }
function cursorLTE(a: string, b: string, c: string, d: string): boolean {
  return BigInt(a) < BigInt(c) || (a === c && BigInt(b) <= BigInt(d));
}
const HEADER_KEYS = ["id", "sceneId", "visibilityPolicyId", "policyVersion", "policyKind", "recordVersion", "recordOrdinal", "worldTick", "worldOrdinal"];
function header(value: unknown, withScene: false): PerformanceEventHeader;
function header(value: unknown, withScene: true): PerformanceEvidenceHeader;
function header(value: unknown, withScene: boolean): PerformanceEventHeader | PerformanceEvidenceHeader {
  const o = object(value, withScene ? [...HEADER_KEYS, "sceneStartTick", "sceneStartOrdinal"] : HEADER_KEYS);
  const result: PerformanceEventHeader = {
    id: text(o.id), sceneId: text(o.sceneId), visibilityPolicyId: text(o.visibilityPolicyId),
    policyVersion: decimal(o.policyVersion, true), policyKind: text(o.policyKind),
    recordVersion: decimal(o.recordVersion, true), recordOrdinal: decimal(o.recordOrdinal),
    worldTick: decimal(o.worldTick), worldOrdinal: decimal(o.worldOrdinal),
  };
  if (!["public", "scene", "restricted", "private", "dm_only"].includes(result.policyKind)) invalid();
  if (!withScene) return result;
  const sceneStartTick = decimal(o.sceneStartTick), sceneStartOrdinal = decimal(o.sceneStartOrdinal);
  if (!cursorLTE(sceneStartTick, sceneStartOrdinal, result.worldTick, result.worldOrdinal)) invalid();
  return { ...result, sceneStartTick, sceneStartOrdinal };
}

/** Exact, bounded, fresh data. This is historical header validation, never a visibility authorization. */
export function normalizePerformanceEvidenceSnapshot(value: unknown): PerformanceEvidenceSnapshotV1 {
  const o = object(value, ["version", "scope", "assessmentId", "commandId", "requestFingerprint", "policyVersion", "admission", "binding", "head", "worldlineHead", "currentScene", "headEvent", "evidence", "factors", "milestoneWitness"]);
  same(o.version, 1); same(o.policyVersion, "structured-factors:v1");
  const s = object(o.scope, ["workspaceId", "worldId", "worldlineId", "recordId"]);
  const scope = { workspaceId: text(s.workspaceId), worldId: text(s.worldId), worldlineId: text(s.worldlineId), recordId: text(s.recordId) };
  const a = object(o.admission, ["principalId", "role", "evidencePolicyId", "evidenceMode"]);
  if (a.role !== "owner" && a.role !== "player") invalid();
  if (a.evidenceMode !== "engine-authoritative-v1" && a.evidenceMode !== "viewer-limited-v1") invalid();
  const admission: PerformanceEvidenceSnapshotV1["admission"] = { principalId: text(a.principalId), role: a.role, evidencePolicyId: text(a.evidencePolicyId), evidenceMode: a.evidenceMode };
  const b = object(o.binding, ["storyId", "worldVersion"]);
  const binding = { storyId: text(b.storyId), worldVersion: text(b.worldVersion) };
  const h = object(o.head, ["recordVersion", "nextRecordOrdinal", "lastEventId", "lastWorldTick", "lastWorldOrdinal", "effectiveTick", "effectiveOrdinal"]);
  const head = { recordVersion: decimal(h.recordVersion, true), nextRecordOrdinal: decimal(h.nextRecordOrdinal, true), lastEventId: text(h.lastEventId), lastWorldTick: decimal(h.lastWorldTick), lastWorldOrdinal: decimal(h.lastWorldOrdinal), effectiveTick: decimal(h.effectiveTick), effectiveOrdinal: decimal(h.effectiveOrdinal) };
  same(head.effectiveTick, head.lastWorldTick); same(head.effectiveOrdinal, head.lastWorldOrdinal);
  const w = object(o.worldlineHead, ["tick", "ordinal"]);
  const worldlineHead = { tick: decimal(w.tick), ordinal: decimal(w.ordinal) };
  if (!cursorLTE(head.effectiveTick, head.effectiveOrdinal, worldlineHead.tick, worldlineHead.ordinal)) invalid();
  const c = object(o.currentScene, ["id", "startTick", "startOrdinal", "status"]);
  const currentScene = { id: text(c.id), startTick: decimal(c.startTick), startOrdinal: decimal(c.startOrdinal), status: text(c.status) };
  if (!["planned", "active", "closed", "cancelled"].includes(currentScene.status)
    || !cursorLTE(currentScene.startTick, currentScene.startOrdinal, head.effectiveTick, head.effectiveOrdinal)) invalid();
  const headEvent = header(o.headEvent, false);
  same(headEvent.id, head.lastEventId); same(headEvent.recordVersion, head.recordVersion);
  same(BigInt(headEvent.recordOrdinal) + BigInt(1), BigInt(head.nextRecordOrdinal));
  same(headEvent.worldTick, head.lastWorldTick); same(headEvent.worldOrdinal, head.lastWorldOrdinal);
  if (!Array.isArray(o.evidence) || o.evidence.length < 1 || o.evidence.length > 32) invalid();
  const evidenceInput = o.evidence;
  if (Reflect.ownKeys(evidenceInput).length !== evidenceInput.length + 1
    || evidenceInput.some((_, i) => !Object.hasOwn(evidenceInput, i))) invalid();
  const evidence = evidenceInput.map(x => header(x, true));
  if (new Set(evidence.map(x => x.id)).size !== evidence.length
    || evidence.some((x, i) => i > 0 && evidence[i - 1].id.localeCompare(x.id) >= 0)) invalid();
  const f = object(o.factors, ["evidenceCount", "milestoneCompleted", "score"]);
  if (typeof f.milestoneCompleted !== "boolean") invalid();
  same(f.evidenceCount, evidence.length); same(f.score, evidence.length * 10 + (f.milestoneCompleted ? 20 : 0));
  const factors = { evidenceCount: evidence.length, milestoneCompleted: f.milestoneCompleted, score: f.score as number };
  let milestoneWitness: PerformanceEvidenceSnapshotV1["milestoneWitness"] = null;
  if (o.milestoneWitness !== null) {
    const m = object(o.milestoneWitness, ["id", "projectId", "completionRecordId", "completionEventId", "completionHeader"]);
    milestoneWitness = { id: text(m.id), projectId: text(m.projectId), completionRecordId: text(m.completionRecordId), completionEventId: text(m.completionEventId), completionHeader: header(m.completionHeader, true) };
    same(milestoneWitness.completionRecordId, scope.recordId);
    same(milestoneWitness.completionEventId, milestoneWitness.completionHeader.id);
  }
  same(milestoneWitness !== null, factors.milestoneCompleted);
  // One immutable Event/policy/Scene cannot acquire conflicting historical
  // headers merely because it appears in more than one witness role.
  const eventHeaders = new Map<string, PerformanceEventHeader>();
  const policyHeaders = new Map<string, PerformanceEventHeader>();
  const sceneHeaders = new Map<string, { startTick: string; startOrdinal: string }>([[currentScene.id, currentScene]]);
  for (const event of [headEvent, ...evidence, ...(milestoneWitness ? [milestoneWitness.completionHeader] : [])]) {
    const previous = eventHeaders.get(event.id);
    if (previous) for (const key of HEADER_KEYS as (keyof PerformanceEventHeader)[]) same(previous[key], event[key]);
    eventHeaders.set(event.id, event);
    const policy = policyHeaders.get(event.visibilityPolicyId);
    if (policy) { same(policy.policyVersion, event.policyVersion); same(policy.policyKind, event.policyKind); }
    policyHeaders.set(event.visibilityPolicyId, event);
  }
  for (const event of [...evidence, ...(milestoneWitness ? [milestoneWitness.completionHeader] : [])]) {
    const scene = sceneHeaders.get(event.sceneId);
    if (scene) { same(scene.startTick, event.sceneStartTick); same(scene.startOrdinal, event.sceneStartOrdinal); }
    sceneHeaders.set(event.sceneId, { startTick: event.sceneStartTick, startOrdinal: event.sceneStartOrdinal });
  }
  for (const event of [headEvent, ...evidence, ...(milestoneWitness ? [milestoneWitness.completionHeader] : [])]) {
    if (BigInt(event.recordVersion) > BigInt(head.recordVersion)
      || BigInt(event.recordOrdinal) >= BigInt(head.nextRecordOrdinal)
      || !cursorLTE(event.worldTick, event.worldOrdinal, head.effectiveTick, head.effectiveOrdinal)) invalid();
  }
  const requestFingerprint = text(o.requestFingerprint);
  if (!HASH.test(requestFingerprint)) invalid();
  const result: PerformanceEvidenceSnapshotV1 = { version: 1, scope, assessmentId: text(o.assessmentId), commandId: text(o.commandId), requestFingerprint, policyVersion: "structured-factors:v1", admission, binding, head, worldlineHead, currentScene, headEvent, evidence, factors, milestoneWitness };
  canonical(result); // Counts UTF-8 bytes while emitting, before joining any large output.
  return result;
}
function canonical(value: unknown): string {
  const parts: string[] = []; let bytes = 0;
  const emit = (part: string) => { bytes += Buffer.byteLength(part, "utf8"); if (bytes > PERFORMANCE_SNAPSHOT_MAX_BYTES) invalid(); parts.push(part); };
  const visit = (x: unknown): void => {
    if (Array.isArray(x)) { emit("["); x.forEach((v, i) => { if (i) emit(","); visit(v); }); emit("]"); }
    else if (x !== null && typeof x === "object") { emit("{"); Object.keys(x).sort().forEach((key, i) => { if (i) emit(","); emit(JSON.stringify(key)); emit(":"); visit((x as Record<string, unknown>)[key]); }); emit("}"); }
    else { const encoded = JSON.stringify(x); if (encoded === undefined) invalid(); emit(encoded); }
  };
  visit(value); return parts.join("");
}
export function performanceEvidenceSnapshotCanonical(value: unknown): string { return canonical(normalizePerformanceEvidenceSnapshot(value)); }
export function performanceEvidenceSnapshotHash(value: unknown): string {
  return createHash("sha256").update("performance-evidence-snapshot:v1\0", "utf8").update(performanceEvidenceSnapshotCanonical(value), "utf8").digest("hex");
}
export function decodePerformanceEvidenceSnapshot(text: string): PerformanceEvidenceSnapshotV1 {
  if (typeof text !== "string" || text.length > PERFORMANCE_SNAPSHOT_MAX_BYTES || Buffer.byteLength(text, "utf8") > PERFORMANCE_SNAPSHOT_MAX_BYTES) invalid();
  try { return normalizePerformanceEvidenceSnapshot(JSON.parse(text)); } catch { return invalid(); }
}
