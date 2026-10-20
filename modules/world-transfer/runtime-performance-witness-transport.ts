/** Private archive integrity/provenance, never authentication or current admission. */
import { createHash } from "node:crypto";
import { validatePerformanceEvidenceReceipt } from "../application/performance-evidence-receipt.ts";
import { createReplayContext, walkFactReplayRequest, type ReplayScopeV1 } from "../application/command-replay-lineage.ts";
import { committedFactRequestFingerprintFor, evidenceHash } from "../application/committed-fact-command.ts";
import type { PerformanceEvidenceSnapshotV1 } from "../application/performance-evidence-snapshot.ts";
import { countRuntimeSectionWireBytes, RUNTIME_SAVE_FILE_BYTES, RealmRuntimeSaveError } from "./runtime-save-primitives.ts";
import { normalizeRealmRuntimeSaveEventForRestore } from "./runtime-save-event.ts";
import type { RealmRuntimeSaveArchive, RealmRuntimeSaveGoals } from "./realm-runtime-save.ts";

type Request = { command: "performance.assessed"; recordId: string; policyVersion: "structured-factors:v1"; score: number; evidenceEventIds: string[] };
type Result = { status: "committed" | "replayed"; commandId: string; assessmentId: string; score: number; evidenceSnapshotHash: string; goalTransition: null };
type Assessment = { id: string; recordId: string; commandId: string; policyVersion: string; score: number; evidenceEventIds: readonly string[]; evidenceSnapshotHash: string };
export interface PerformanceWitnessOriginV1 {
  scope: ReplayScopeV1; commandId: string; requestFingerprint: string; request: Request; result: Result;
  marker: { version: 1; manifestHash: string };
  witness: { recordId: string; assessmentId: string; commandId: string; version: 1; manifestCanonical: string; manifestHash: string };
  assessment: Assessment;
}
export type PerformanceWitnessIdentityKind = "record" | "story" | "command" | "assessment" | "event" | "scene" | "policy" | "project" | "milestone";
export interface PerformanceWitnessProjectionV1 {
  scope: ReplayScopeV1; recordId: string; storyId: string; commandId: string; assessmentId: string;
  request: Request; requestFingerprint: string; result: Result; assessment: Assessment;
  /** No target head, worldline cursor or current Scene is asserted by this format. */
  history: "origin-only";
  relation: { version: 1; originScope: ReplayScopeV1; currentScope: ReplayScopeV1;
    identities: readonly { kind: PerformanceWitnessIdentityKind; originId: string; currentId: string }[] };
}
export interface PerformanceWitnessEnvelopeV1 {
  version: 1; origin: PerformanceWitnessOriginV1; projection: PerformanceWitnessProjectionV1; digest: string;
}
export interface RuntimePerformanceWitnessesV1 {
  format: "realm-runtime-performance-witnesses"; schemaVersion: 1; witnesses: readonly PerformanceWitnessEnvelopeV1[];
}
export const PERFORMANCE_WITNESSES_ENTRY = "runtime/performance-witnesses.json";
const KINDS: readonly PerformanceWitnessIdentityKind[] = ["record", "story", "command", "assessment", "event", "scene", "policy", "project", "milestone"];
function invalid(): never { throw new RealmRuntimeSaveError("INVALID_SAVE", "Private performance witness family is invalid."); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !descriptors[k]?.enumerable || !Object.hasOwn(descriptors[k], "value"))) invalid();
  return value as Record<string, unknown>;
}
function same(a: unknown, b: unknown): void { if (canonical(a) !== canonical(b)) invalid(); }
function dense(value: unknown): unknown[] {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let i=0;i<value.length;i++) if (!descriptors[String(i)]?.enumerable || !Object.hasOwn(descriptors[String(i)], "value")) invalid();
  return value;
}
function canonical(value: unknown, depth=0): string {
  // The exact family has no recursive JSON field (the snapshot is a string).
  // This exceeds its maximum structural depth without reducing string budgets.
  if (depth>32) invalid();
  if (Array.isArray(value)) return `[${dense(value).map(v=>canonical(v,depth+1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row=exact(value,Object.keys(value));
    return `{${Object.keys(row).sort().map(k => `${JSON.stringify(k)}:${canonical(row[k],depth+1)}`).join(",")}}`;
  }
  if (value!==null && !["string","boolean","number"].includes(typeof value)) invalid();
  if (typeof value==="number" && !Number.isFinite(value)) invalid();
  return JSON.stringify(value);
}
function digest(domain: string, text: string): string { return createHash("sha256").update(domain).update("\0").update(text).digest("hex"); }
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value) || value.length > 256 || [".", ".."].includes(value)) invalid();
  return value;
}
function scope(value: unknown): ReplayScopeV1 {
  const s = exact(value, ["workspaceId", "worldId", "worldlineId"]);
  return { workspaceId: id(s.workspaceId), worldId: id(s.worldId), worldlineId: id(s.worldlineId) };
}
export function performanceOriginIdentities(s: PerformanceEvidenceSnapshotV1): Map<PerformanceWitnessIdentityKind, Set<string>> {
  const out = new Map(KINDS.map(k => [k, new Set<string>()]));
  const add = (kind: PerformanceWitnessIdentityKind, value: string) => out.get(kind)!.add(value);
  add("record", s.scope.recordId); add("story", s.binding.storyId); add("command", s.commandId); add("assessment", s.assessmentId);
  add("scene", s.currentScene.id);
  for (const h of [s.headEvent, ...s.evidence, ...(s.milestoneWitness ? [s.milestoneWitness.completionHeader] : [])]) {
    add("event", h.id); add("scene", h.sceneId); add("policy", h.visibilityPolicyId);
  }
  if (s.milestoneWitness) { add("milestone", s.milestoneWitness.id); add("project", s.milestoneWitness.projectId); }
  return out;
}

/** Digest domains are independent of the original performance-evidence-snapshot:v1. */
export function performanceWitnessEnvelopeDigest(value: Omit<PerformanceWitnessEnvelopeV1, "digest">): string {
  countRuntimeSectionWireBytes(value, "canonical-runtime", RUNTIME_SAVE_FILE_BYTES);
  return digest("realm-runtime-performance-witness-envelope:v1", canonical(value));
}
function readRuntimePerformanceWitnesses(value: unknown): RuntimePerformanceWitnessesV1 {
  // Descriptor/cycle/finite-number and exact wire budget check before cloning or encoding.
  countRuntimeSectionWireBytes(value, "canonical-runtime", RUNTIME_SAVE_FILE_BYTES);
  const root = exact(value, ["format", "schemaVersion", "witnesses"]);
  if (root.format !== "realm-runtime-performance-witnesses" || root.schemaVersion !== 1 || !Array.isArray(root.witnesses) || !root.witnesses.length) invalid();
  const commands = new Set<string>(), forward = new Map<string, string>(), reverse = new Map<string, string>();
  const witnesses = dense(root.witnesses).map(raw => {
    const row = exact(raw, ["version", "origin", "projection", "digest"]);
    if (row.version !== 1) invalid();
    // The real source validator runs before any projection identity/hash work.
    const snapshot = validatePerformanceEvidenceReceipt(row.origin);
    const origin = row.origin as PerformanceWitnessOriginV1;
    const p = exact(row.projection, ["scope", "recordId", "storyId", "commandId", "assessmentId", "request", "requestFingerprint", "result", "assessment", "history", "relation"]);
    const currentScope = scope(p.scope), originScope = scope(origin.scope);
    if (p.history !== "origin-only") invalid();
    const relation = exact(p.relation, ["version", "originScope", "currentScope", "identities"]);
    if (relation.version !== 1 || !Array.isArray(relation.identities)) invalid();
    same(scope(relation.originScope), originScope); same(scope(relation.currentScope), currentScope);
    const expected = performanceOriginIdentities(snapshot), maps = new Map(KINDS.map(k => [k, new Map<string, string>()]));
    const targets = new Map(KINDS.map(k => [k, new Set<string>()]));
    for (const rawPair of dense(relation.identities)) {
      const pair = exact(rawPair, ["kind", "originId", "currentId"]), kind = pair.kind as PerformanceWitnessIdentityKind;
      if (!KINDS.includes(kind)) invalid();
      const from = id(pair.originId), to = id(pair.currentId);
      if (canonical(originScope) === canonical(currentScope) && from !== to) invalid();
      if (!expected.get(kind)!.has(from) || maps.get(kind)!.has(from) || targets.get(kind)!.has(to)) invalid();
      maps.get(kind)!.set(from, to); targets.get(kind)!.add(to);
      const fromKey = canonical([originScope, kind, from]), toKey = canonical([currentScope, kind, to]);
      if ((forward.has(fromKey) && forward.get(fromKey) !== toKey) || (reverse.has(toKey) && reverse.get(toKey) !== fromKey)) invalid();
      forward.set(fromKey, toKey); reverse.set(toKey, fromKey);
    }
    for (const kind of KINDS) if (maps.get(kind)!.size !== expected.get(kind)!.size) invalid();
    const mapped = (kind: PerformanceWitnessIdentityKind, from: string): string => maps.get(kind)!.get(from) ?? invalid();
    // Reuse the established lineage validator for its supported typed namespaces.
    createReplayContext({ format: "realm-command-lineage-context", version: 1, family: "fact", originScope, currentScope,
      identities: { record: [...maps.get("record")!].map(([o,c]) => [c,o]).sort(), event: [...maps.get("event")!].map(([o,c]) => [c,o]).sort(),
        scene: [], characterInstance: [], assetDefinition: [], project: [], financeAccount: [], milestone: [], obligation: [] } });
    const recordId = mapped("record", snapshot.scope.recordId), commandId = mapped("command", snapshot.commandId), assessmentId = mapped("assessment", snapshot.assessmentId);
    same(p.recordId, recordId); same(p.storyId, mapped("story", snapshot.binding.storyId)); same(p.commandId, commandId); same(p.assessmentId, assessmentId);
    const request = walkFactReplayRequest("performance_assessed", p.request, (_kind, value) => value);
    same(request, { ...origin.request, recordId, evidenceEventIds: origin.request.evidenceEventIds.map(e => mapped("event", e)).sort((a,b)=>a.localeCompare(b)) });
    same(p.requestFingerprint, committedFactRequestFingerprintFor(currentScope, request));
    const hash = evidenceHash((request as Request).evidenceEventIds);
    same(p.result, { ...origin.result, commandId, assessmentId, evidenceSnapshotHash: hash });
    same(p.assessment, { ...origin.assessment, id: assessmentId, recordId, commandId, evidenceEventIds: (request as Request).evidenceEventIds, evidenceSnapshotHash: hash });
    const key = canonical([currentScope, commandId]); if (commands.has(key)) invalid(); commands.add(key);
    same(row.digest, performanceWitnessEnvelopeDigest({ version: 1, origin, projection: p as unknown as PerformanceWitnessProjectionV1 }));
    return structuredClone(raw) as PerformanceWitnessEnvelopeV1;
  });
  return { format: "realm-runtime-performance-witnesses", schemaVersion: 1, witnesses };
}
export function normalizeRuntimePerformanceWitnesses(value: unknown): RuntimePerformanceWitnessesV1 {
  try { return readRuntimePerformanceWitnesses(value); } catch { return invalid(); }
}
export function runtimePerformanceWitnessesCanonical(value: unknown): string { return canonical(normalizeRuntimePerformanceWitnesses(value)); }
/** Exact bytes for 0084.envelope_canonical, including its detached digest field. */
export function performanceWitnessEnvelopeCanonical(value: unknown): string {
  return canonical(normalizeRuntimePerformanceWitnesses({ format: "realm-runtime-performance-witnesses", schemaVersion: 1, witnesses: [value] }).witnesses[0]);
}
export function runtimePerformanceWitnessesDigest(value: unknown): string {
  return digest("realm-runtime-performance-witnesses:v1", runtimePerformanceWitnessesCanonical(value));
}

/** Compose explicit typed maps with the previous hop. Never rewrite origin. */
export function projectPerformanceWitness(entry: PerformanceWitnessEnvelopeV1, targetScope: ReplayScopeV1,
  maps: ReadonlyMap<PerformanceWitnessIdentityKind, ReadonlyMap<string, string>>): PerformanceWitnessEnvelopeV1 {
  const source = normalizeRuntimePerformanceWitnesses({ format: "realm-runtime-performance-witnesses", schemaVersion: 1, witnesses: [entry] }).witnesses[0];
  const identities = source.projection.relation.identities.map(pair => ({ ...pair,
    currentId: maps.get(pair.kind)?.get(pair.currentId) ?? invalid() }));
  const mapped = (kind: PerformanceWitnessIdentityKind, originId: string) => identities.find(p => p.kind === kind && p.originId === originId)?.currentId ?? invalid();
  const o = source.origin, snapshot = validatePerformanceEvidenceReceipt(o);
  const recordId = mapped("record", snapshot.scope.recordId), commandId = mapped("command", o.commandId), assessmentId = mapped("assessment", o.assessment.id);
  const request = { ...o.request, recordId, evidenceEventIds: o.request.evidenceEventIds.map(id => mapped("event", id)).sort((a,b)=>a.localeCompare(b)) };
  const hash = evidenceHash(request.evidenceEventIds);
  const projection: PerformanceWitnessProjectionV1 = { scope: { ...targetScope }, recordId, storyId: mapped("story", snapshot.binding.storyId), commandId, assessmentId,
    request, requestFingerprint: committedFactRequestFingerprintFor(targetScope, request),
    result: { ...o.result, commandId, assessmentId, evidenceSnapshotHash: hash },
    assessment: { ...o.assessment, id: assessmentId, commandId, recordId, evidenceEventIds: request.evidenceEventIds, evidenceSnapshotHash: hash },
    history: "origin-only", relation: { version: 1, originScope: { ...o.scope }, currentScope: { ...targetScope }, identities } };
  const body = { version: 1 as const, origin: o, projection };
  return { ...body, digest: performanceWitnessEnvelopeDigest(body) };
}

export function nativePerformanceWitness(origin: PerformanceWitnessOriginV1): PerformanceWitnessEnvelopeV1 {
  const s = validatePerformanceEvidenceReceipt(origin);
  const identities = [...performanceOriginIdentities(s)].flatMap(([kind, ids]) => [...ids].map(id => ({ kind, originId: id, currentId: id })));
  const projection: PerformanceWitnessProjectionV1 = { scope: { ...origin.scope }, recordId: s.scope.recordId, storyId: s.binding.storyId,
    commandId: origin.commandId, assessmentId: origin.assessment.id, request: origin.request, requestFingerprint: origin.requestFingerprint,
    result: origin.result, assessment: origin.assessment, history: "origin-only",
    relation: { version: 1, originScope: origin.scope, currentScope: origin.scope, identities } };
  const body = { version: 1 as const, origin, projection };
  return normalizeRuntimePerformanceWitnesses({ format: "realm-runtime-performance-witnesses", schemaVersion: 1,
    witnesses: [{ ...body, digest: performanceWitnessEnvelopeDigest(body) }] }).witnesses[0];
}

/** Both codecs use real carried facts; maps never establish their own closure. */
export function validateRuntimePerformanceWitnessClosure(archive: Pick<RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>, "manifest" | "record" | "domain" | "topology" | "performanceWitnesses">): void {
  const family = archive.performanceWitnesses, declaration = archive.manifest.performanceWitnessesFormat;
  if (!family) {
    if (declaration || archive.domain?.committedFactCommands.some(c => Object.hasOwn(c.resultManifest, "performanceTransport"))) invalid();
    return;
  }
  if (!declaration || declaration.schemaVersion !== 1 || declaration.digest !== runtimePerformanceWitnessesDigest(family) || !archive.domain) invalid();
  const domain = archive.domain;
  const bundles = [{ record: archive.record, topology: archive.topology, storyId: domain.source.storyId },
    ...(domain.records ?? []).map(r => ({ ...r.bundle, storyId: r.storyId }))];
  const seen = new Set<string>();
  for (const envelope of family.witnesses) {
    const p = envelope.projection, s = validatePerformanceEvidenceReceipt(envelope.origin);
    same(p.scope, { workspaceId: archive.manifest.scope.workspaceId, worldId: domain.source.worldId, worldlineId: domain.source.worldlineId });
    const bundle = bundles.find(b => b.record.scope.recordId === p.recordId);
    if (!bundle || bundle.storyId !== p.storyId || !bundle.topology) invalid();
    const command = domain.committedFactCommands.find(c => c.id === p.commandId);
    if (!command || command.kind !== "performance_assessed" || command.provenance !== "request-result-v1") invalid();
    same(command.request, p.request); same(command.requestFingerprint, p.requestFingerprint);
    same(command.resultManifest, { ...p.result, performanceTransport: { version: 1, digest: envelope.digest } });
    same(domain.performanceAssessments.find(a => a.id === p.assessmentId), p.assessment);
    seen.add(command.id);
    const mapped = (kind: PerformanceWitnessIdentityKind, originId: string) => p.relation.identities.find(pair => pair.kind === kind && pair.originId === originId)?.currentId ?? invalid();
    // Scalars below are proven against carried immutable facts. The historical
    // worldlineHead/currentScene status remain origin-only, never target state.
    for (const h of [s.headEvent, ...s.evidence, ...(s.milestoneWitness ? [s.milestoneWitness.completionHeader] : [])]) {
      const event = bundle.record.events.find(e => e.eventId === mapped("event", h.id)); if (!event) invalid();
      const actual = normalizeRealmRuntimeSaveEventForRestore(event);
      const policy = bundle.topology.visibilityPolicies.find(v => v.sourceVisibilityPolicyId === mapped("policy", h.visibilityPolicyId));
      const scene = bundle.topology.scenes.find(v => v.sourceSceneId === mapped("scene", h.sceneId));
      if (!policy || !scene) invalid();
      same([actual.sourceSceneId, actual.sourceVisibilityPolicyId, String(actual.recordVersion), String(actual.ordinal), String(actual.worldTick), String(actual.worldOrdinal), String(policy.policyVersion), policy.policyKind],
        [scene.sourceSceneId, policy.sourceVisibilityPolicyId, h.recordVersion, h.recordOrdinal, h.worldTick, h.worldOrdinal, h.policyVersion, h.policyKind]);
      if ("sceneStartTick" in h && "sceneStartOrdinal" in h) same([String(scene.startTick),String(scene.startOrdinal)], [h.sceneStartTick,h.sceneStartOrdinal]);
    }
    const scene = bundle.topology.scenes.find(v => v.sourceSceneId === mapped("scene", s.currentScene.id));
    if (!scene) invalid();
    same([String(scene.startTick), String(scene.startOrdinal)], [s.currentScene.startTick, s.currentScene.startOrdinal]);
    if (BigInt(s.head.recordVersion) > BigInt(bundle.record.head.recordVersion) || BigInt(s.head.nextRecordOrdinal) > BigInt(bundle.record.head.nextRecordOrdinal)) invalid();
    if (archive.manifest.world && archive.manifest.world.worldVersion !== s.binding.worldVersion) invalid();
    if (s.milestoneWitness) {
      const m = s.milestoneWitness, actual = domain.milestones.find(v => v.id === mapped("milestone", m.id));
      if (!actual || !domain.projects.some(v => v.id === mapped("project", m.projectId))) invalid();
      same([actual.projectId,actual.status,actual.completionRecordId,actual.completionEventId], [mapped("project",m.projectId),"completed",p.recordId,mapped("event",m.completionEventId)]);
    }
  }
  for (const command of domain.committedFactCommands) if (Object.hasOwn(command.resultManifest, "performanceTransport") && !seen.has(command.id)) invalid();
}
