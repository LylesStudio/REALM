import { canonicalGoalJson, canonicalGoalJsonWithinBudget, decodeGoalContentBinding, decodeGoalOwner, goalOwnerKey,
  normalizeGoalDefinition, type GoalContentBindingV1, type GoalOwner } from "../goals/content-binding.ts";
import { decodeRecordGoalDefinition, rebaseRecordGoalDefinitions, type RecordGoalDefinitionVersion } from "../goals/record-authoring.ts";
import { goalAllowedTerminals, goalEvidenceSnapshotHash, type GoalDefinition, type GoalEvent, type GoalState } from "../goals/public.ts";
import type { JsonValue } from "../runtime/public.ts";
import { RUNTIME_SAVE_FILE_BYTES } from "./runtime-save-primitives.ts";

type JsonObject = Readonly<Record<string, JsonValue>>;
export interface GoalRef { owner: GoalOwner; instanceId: string }
export interface RecordEventRef { worldId: string; worldlineId: string; recordId: string; eventId: string }
export interface GoalInstanceV2 {
  ref: GoalRef; goalKey: string;
  definition: { kind: "content"; binding: GoalContentBindingV1 } | { kind: "record"; definitionId: string; goalId: string; definitionVersion: number };
  state: GoalState; revision: number; progress: JsonObject; outcome: JsonObject | null;
  policyVersion: string; attempt: number; predecessor: null | { kind: "retry" | "definition-revision"; ref: GoalRef };
  resolutionKind: "natural" | "withdrawn" | "superseded";
  evidenceStart: null | { recordVersion: number; ordinal: number };
}
export interface GoalAssessmentV2 {
  id: string; goal: GoalRef; sourceEvent: RecordEventRef; source: "deterministic" | "judge" | "fallback";
  status: "accepted" | "rejected" | "stale" | "failed"; result: JsonObject; evidenceEvents: readonly RecordEventRef[];
  evidenceHead: { recordVersion: number; ordinal: number } | null; evidenceSnapshotHash: string; policyVersion: string;
}
export interface RealmRuntimeSaveGoalsV2 {
  format: "realm-runtime-goals"; schemaVersion: 2; workspaceId: string;
  roots: readonly { owner: GoalOwner; instances: readonly GoalInstanceV2[] }[];
  definitions: readonly RecordGoalDefinitionVersion[]; assessments: readonly GoalAssessmentV2[];
}
export class RealmRuntimeGoalsV2Error extends Error {
  readonly code: "INVALID_SAVE" | "GOAL_CONTENT_BINDING_INVALID" | "GOAL_SCOPED_ASSESSMENT_UNSUPPORTED" | "GOAL_HISTORICAL_BINDING_UNRESOLVED";
  constructor(code: RealmRuntimeGoalsV2Error["code"] = "INVALID_SAVE") {
    super("Runtime GoalsV2 document is invalid or requires trusted evidence."); this.name = "RealmRuntimeGoalsV2Error"; this.code = code;
  }
}
function bad(code?: RealmRuntimeGoalsV2Error["code"]): never { throw new RealmRuntimeGoalsV2Error(code); }
const HASH = /^[0-9a-f]{64}$/;
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) bad(); return v as Record<string, unknown>; }
function keys(r: Record<string, unknown>, allowed: readonly string[]) { if (Object.keys(r).length !== allowed.length || allowed.some(k => !Object.hasOwn(r, k))) bad(); }
function text(v: unknown): string { if (typeof v !== "string" || !v.trim() || v.length > 4096 || v.includes("\0")) bad(); return v; }
function integer(v: unknown, min = 0): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) bad(); return v; }
function list(v: unknown): unknown[] { if (!Array.isArray(v) || v.length > 10000) bad(); return v; }
function choice<T extends string>(v: unknown, allowed: readonly T[]): T { if (!allowed.includes(v as T)) bad(); return v as T; }
function jsonObject(v: unknown): JsonObject { return object(v) as JsonObject; }
function head(v: unknown): { recordVersion: number; ordinal: number } | null {
  if (v === null) return null; const r = object(v); keys(r, ["recordVersion", "ordinal"]);
  const recordVersion = integer(r.recordVersion); const ordinal = integer(r.ordinal);
  return { recordVersion, ordinal };
}
function ref(v: unknown): GoalRef { const r = object(v); keys(r, ["owner", "instanceId"]); return { owner: decodeGoalOwner(r.owner), instanceId: text(r.instanceId) }; }
function refKey(r: GoalRef): string { return JSON.stringify([goalOwnerKey(r.owner), r.instanceId]); }
function eventRef(v: unknown): RecordEventRef {
  const r = object(v); keys(r, ["worldId", "worldlineId", "recordId", "eventId"]);
  return { worldId: text(r.worldId), worldlineId: text(r.worldlineId), recordId: text(r.recordId), eventId: text(r.eventId) };
}
function eventOwner(r: RecordEventRef): Extract<GoalOwner, { scopeKind: "record" }> { return { scopeKind: "record", worldId: r.worldId, worldlineId: r.worldlineId, recordId: r.recordId }; }
function definitionOwner(d: RecordGoalDefinitionVersion): GoalOwner { return { scopeKind: "record", worldId: d.scope.worldId, worldlineId: d.scope.worldlineId, recordId: d.scope.recordId }; }
function decodeInstance(v: unknown, owner: GoalOwner, workspaceId: string): GoalInstanceV2 {
  const r = object(v); keys(r, ["ref", "goalKey", "definition", "state", "revision", "progress", "outcome", "policyVersion", "attempt", "predecessor", "resolutionKind", "evidenceStart"]);
  const identity = ref(r.ref); if (goalOwnerKey(identity.owner) !== goalOwnerKey(owner)) bad();
  const d = object(r.definition); let definition: GoalInstanceV2["definition"];
  if (d.kind === "content") {
    keys(d, ["kind", "binding"]); const b = decodeGoalContentBinding(d.binding);
    if (b.workspaceId !== workspaceId || b.instanceId !== identity.instanceId || goalOwnerKey(b.owner) !== goalOwnerKey(owner)
      || b.goalKey !== r.goalKey || b.policyVersion !== r.policyVersion) bad("GOAL_CONTENT_BINDING_INVALID");
    definition = { kind: "content", binding: b };
  } else {
    keys(d, ["kind", "definitionId", "goalId", "definitionVersion"]); if (d.kind !== "record" || owner.scopeKind !== "record") bad();
    definition = { kind: "record", definitionId: text(d.definitionId), goalId: text(d.goalId), definitionVersion: integer(d.definitionVersion, 1) };
  }
  let predecessor: GoalInstanceV2["predecessor"] = null;
  if (r.predecessor !== null) { const p = object(r.predecessor); keys(p, ["kind", "ref"]); predecessor = { kind: choice(p.kind, ["retry", "definition-revision"]), ref: ref(p.ref) }; }
  const state = choice(r.state, ["active", "completed", "failed", "settled"]);
  const resolutionKind = choice(r.resolutionKind, ["natural", "withdrawn", "superseded"]);
  if (resolutionKind !== "natural" && state !== "settled") bad();
  return { ref: identity, goalKey: text(r.goalKey), definition, state, revision: integer(r.revision), progress: jsonObject(r.progress),
    outcome: r.outcome === null ? null : jsonObject(r.outcome), policyVersion: text(r.policyVersion), attempt: integer(r.attempt, 1), predecessor, resolutionKind, evidenceStart: head(r.evidenceStart) };
}
function family(g: GoalInstanceV2): string { return JSON.stringify([goalOwnerKey(g.ref.owner), g.definition.kind, g.definition.kind === "content" ? g.goalKey : g.definition.goalId]); }
function ordered(document: RealmRuntimeSaveGoalsV2): GoalInstanceV2[] {
  const all = document.roots.flatMap(r => r.instances); const byId = new Map<string, GoalInstanceV2>();
  const identities = new Set<string>(); const active = new Set<string>();
  const definitions = new Map(document.definitions.map(d => [d.definitionId, d])); const bound = new Set<string>();
  for (const g of all) {
    const key = refKey(g.ref); if (byId.has(key)) bad(); byId.set(key, g);
    const f = family(g); const identity = JSON.stringify([f, g.definition.kind === "content" ? null : g.definition.definitionVersion, g.attempt]);
    if (identities.has(identity)) bad(); identities.add(identity);
    if (g.state === "active") { if (active.has(f)) bad(); active.add(f); }
    if (g.definition.kind === "record") {
      const d = definitions.get(g.definition.definitionId);
      if (!d || bound.has(d.definitionId) || d.scope.workspaceId !== document.workspaceId
        || goalOwnerKey(definitionOwner(d)) !== goalOwnerKey(g.ref.owner) || d.goalId !== g.definition.goalId
        || d.definitionVersion !== g.definition.definitionVersion || d.goalKey !== g.goalKey || d.policyVersion !== g.policyVersion
        || d.goalInstanceId !== g.ref.instanceId || g.attempt !== 1
        || canonicalGoalJson(d.activationHead) !== canonicalGoalJson(g.evidenceStart)) bad();
      bound.add(d.definitionId);
    }
  }
  if (bound.size !== definitions.size) bad();
  const pending: GoalInstanceV2[] = []; const children = new Map<string, GoalInstanceV2[]>();
  for (const g of all) {
    if (!g.predecessor) {
      if (g.attempt !== 1 || (g.definition.kind === "record" && g.definition.definitionVersion !== 1)) bad();
      pending.push(g); continue;
    }
    const p = byId.get(refKey(g.predecessor.ref));
    if (!p || p === g || family(p) !== family(g)) bad();
    if (g.predecessor.kind === "retry") {
      if (g.definition.kind !== "content" || p.definition.kind !== "content" || p.state === "active" || p.resolutionKind !== "natural"
        || p.attempt + 1 !== g.attempt || p.policyVersion !== g.policyVersion
        || p.definition.binding.definitionHash !== g.definition.binding.definitionHash
        || canonicalGoalJson(p.definition.binding.source) !== canonicalGoalJson(g.definition.binding.source)) bad();
    } else {
      if (g.definition.kind !== "record" || p.definition.kind !== "record" || g.attempt !== 1 || p.attempt !== 1
        || g.definition.definitionVersion !== p.definition.definitionVersion + 1) bad();
      const d = definitions.get(g.definition.definitionId)!; const previous = definitions.get(p.definition.definitionId)!;
      if (d.supersedesDefinitionId !== previous.definitionId || previous.draft.changePolicy !== "evolving"
        || p.state === "active" || p.resolutionKind === "withdrawn" || (p.resolutionKind === "superseded" && p.state !== "settled")) bad();
    }
    const parentKey = refKey(p.ref); const group = children.get(parentKey) ?? []; group.push(g); children.set(parentKey, group);
  }
  const result: GoalInstanceV2[] = [];
  for (let i = 0; i < pending.length; i++) { const g = pending[i]; result.push(g); pending.push(...(children.get(refKey(g.ref)) ?? [])); }
  if (result.length !== all.length) bad(); return result;
}
/** Optional trusted definitions enforce rubric-dependent terminal/retry rules.
 * A structural decode without them makes no assertion about historical source trust. */
export interface GoalsV2Validation {
  contentDefinition?: (binding: GoalContentBindingV1) => GoalDefinition;
}
export function decodeRealmRuntimeSaveGoalsV2(value: unknown, validation: GoalsV2Validation = {}): RealmRuntimeSaveGoalsV2 {
  let detached: unknown;
  try { detached = JSON.parse(canonicalGoalJsonWithinBudget(value, RUNTIME_SAVE_FILE_BYTES)); } catch { return bad(); }
  const r = object(detached); keys(r, ["format", "schemaVersion", "workspaceId", "roots", "definitions", "assessments"]);
  if (r.format !== "realm-runtime-goals" || r.schemaVersion !== 2) bad(); const workspaceId = text(r.workspaceId);
  const rootKeys = new Set<string>();
  const roots = list(r.roots).map(raw => {
    const row = object(raw); keys(row, ["owner", "instances"]); const owner = decodeGoalOwner(row.owner); const key = goalOwnerKey(owner);
    if (rootKeys.has(key)) bad(); rootKeys.add(key);
    const instances = list(row.instances).map(g => decodeInstance(g, owner, workspaceId)); if (!instances.length) bad();
    return { owner, instances };
  });
  const definitionIds = new Set<string>();
  const definitions = list(r.definitions).map(raw => {
    let d: RecordGoalDefinitionVersion; try { d = decodeRecordGoalDefinition(raw); } catch { return bad(); }
    if (definitionIds.has(d.definitionId)) bad(); definitionIds.add(d.definitionId); return d;
  });
  const partial: RealmRuntimeSaveGoalsV2 = { format: "realm-runtime-goals", schemaVersion: 2, workspaceId, roots, definitions, assessments: [] };
  const all = ordered(partial); const byId = new Map(all.map(g => [refKey(g.ref), g]));
  for (const g of all) {
    const d = g.definition.kind === "record" ? definitions.find(d => d.definitionId === (g.definition as { definitionId: string }).definitionId)
      : validation.contentDefinition?.(g.definition.binding);
    if (!d) continue;
    if (g.definition.kind === "content") decodeGoalContentBinding(g.definition.binding, d);
    if (g.resolutionKind === "natural" && g.state !== "active" && !goalAllowedTerminals(d).has(g.state)) bad();
    if (g.predecessor?.kind === "retry" && d.retryable !== true) bad();
  }
  const assessmentIds = new Set<string>();
  const assessments = list(r.assessments).map(raw => {
    const row = object(raw); keys(row, ["id", "goal", "sourceEvent", "source", "status", "result", "evidenceEvents", "evidenceHead", "evidenceSnapshotHash", "policyVersion"]);
    const goal = ref(row.goal); if (goal.owner.scopeKind !== "record") bad("GOAL_SCOPED_ASSESSMENT_UNSUPPORTED");
    const g = byId.get(refKey(goal)); const id = text(row.id); if (!g || assessmentIds.has(id)) bad(); assessmentIds.add(id);
    const sourceEvent = eventRef(row.sourceEvent); const evidenceEvents = list(row.evidenceEvents).map(eventRef); const eventIds = new Set<string>();
    for (const e of [sourceEvent, ...evidenceEvents]) if (goalOwnerKey(eventOwner(e)) !== goalOwnerKey(goal.owner)) bad();
    for (const e of evidenceEvents) { if (eventIds.has(e.eventId)) bad(); eventIds.add(e.eventId); }
    if (row.policyVersion !== g.policyVersion || typeof row.evidenceSnapshotHash !== "string" || !HASH.test(row.evidenceSnapshotHash)) bad();
    return { id, goal, sourceEvent, source: choice(row.source, ["deterministic", "judge", "fallback"]), status: choice(row.status, ["accepted", "rejected", "stale", "failed"]),
      result: jsonObject(row.result), evidenceEvents, evidenceHead: head(row.evidenceHead), evidenceSnapshotHash: row.evidenceSnapshotHash, policyVersion: text(row.policyVersion) };
  });
  // Stable V2-only ordering. Graph parent order is exposed separately for a future writer.
  roots.sort((a, b) => goalOwnerKey(a.owner) < goalOwnerKey(b.owner) ? -1 : goalOwnerKey(a.owner) > goalOwnerKey(b.owner) ? 1 : 0);
  roots.forEach(r => r.instances.sort((a, b) => a.ref.instanceId < b.ref.instanceId ? -1 : a.ref.instanceId > b.ref.instanceId ? 1 : 0));
  definitions.sort((a, b) => a.definitionId < b.definitionId ? -1 : a.definitionId > b.definitionId ? 1 : 0);
  assessments.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { ...partial, assessments };
}
export function goalInstancesParentFirst(value: unknown): readonly GoalInstanceV2[] { return ordered(decodeRealmRuntimeSaveGoalsV2(value)); }
export function serializeRealmRuntimeSaveGoalsV2(value: unknown, maximumBytes = RUNTIME_SAVE_FILE_BYTES): Uint8Array {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > RUNTIME_SAVE_FILE_BYTES) bad();
  try { return Buffer.from(canonicalGoalJsonWithinBudget(decodeRealmRuntimeSaveGoalsV2(value), maximumBytes), "utf8"); } catch (error) { if (error instanceof RealmRuntimeGoalsV2Error) throw error; return bad(); }
}
export function parseRealmRuntimeSaveGoalsV2(bytes: Uint8Array): RealmRuntimeSaveGoalsV2 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > RUNTIME_SAVE_FILE_BYTES) bad();
  try { return decodeRealmRuntimeSaveGoalsV2(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))); } catch (error) { if (error instanceof RealmRuntimeGoalsV2Error) throw error; return bad(); }
}

export type GoalMappedEntityKind = "worldline" | "record" | "story" | "instance" | "definition" | "event" | "assessment";
export interface GoalTypedIdentity { workspaceId: string; owner: GoalOwner; id: string }
export interface GoalIdentityMapping { entityKind: GoalMappedEntityKind; source: GoalTypedIdentity; target: GoalTypedIdentity }
export function goalTypedIdentityKey(kind: GoalMappedEntityKind, identity: GoalTypedIdentity): string {
  return JSON.stringify([identity.workspaceId, ...JSON.parse(goalOwnerKey(identity.owner)), kind, identity.id]);
}
export interface GoalsV2RemapInput {
  workspaceId: string; mappings: readonly GoalIdentityMapping[];
  /** Trusted full source events/definition are mandatory for assessments; hashes alone are insufficient. */
  assessmentEvidence?: (assessment: GoalAssessmentV2, goal: GoalInstanceV2) => { definition: GoalDefinition; events: readonly GoalEvent[] };
}
/** Explicit bijection, independent of source/map input order. This never activates archive transport. */
export function remapRealmRuntimeSaveGoalsV2(value: unknown, input: GoalsV2RemapInput): RealmRuntimeSaveGoalsV2 {
  // Validate all source tuples and graph BEFORE consulting any map or recomputing a hash.
  const source = decodeRealmRuntimeSaveGoalsV2(value); const workspaceId = text(input.workspaceId);
  const mappings = JSON.parse(canonicalGoalJsonWithinBudget(input.mappings, RUNTIME_SAVE_FILE_BYTES)) as unknown[];
  const map = new Map<string, GoalTypedIdentity>(); const targets = new Set<string>();
  for (const raw of mappings) {
    const row = object(raw); keys(row, ["entityKind", "source", "target"]); const kind = choice(row.entityKind, ["worldline", "record", "story", "instance", "definition", "event", "assessment"]);
    const identity = (v: unknown): GoalTypedIdentity => { const r = object(v); keys(r, ["workspaceId", "owner", "id"]); return { workspaceId: text(r.workspaceId), owner: decodeGoalOwner(r.owner), id: text(r.id) }; };
    const s = identity(row.source); const t = identity(row.target);
    if (s.workspaceId !== source.workspaceId || t.workspaceId !== workspaceId || s.owner.scopeKind !== t.owner.scopeKind) bad();
    if (["record", "story", "worldline"].includes(kind)) {
      if (s.owner.scopeKind !== kind || t.owner.scopeKind !== kind) bad();
      const anchor = (o: GoalOwner) => o.scopeKind === "record" ? o.recordId : o.scopeKind === "story" ? o.storyId : o.worldlineId;
      if (s.id !== anchor(s.owner) || t.id !== anchor(t.owner)) bad();
    }
    const key = goalTypedIdentityKey(kind, s); const targetKey = goalTypedIdentityKey(kind, t);
    if (map.has(key) || targets.has(targetKey)) bad(); map.set(key, t); targets.add(targetKey);
  }
  const mapped = (kind: GoalMappedEntityKind, owner: GoalOwner, id: string): GoalTypedIdentity => {
    const target = map.get(goalTypedIdentityKey(kind, { workspaceId: source.workspaceId, owner, id })); if (!target) bad(); return target;
  };
  const mapOwner = (owner: GoalOwner): GoalOwner => {
    const line: GoalOwner = { scopeKind: "worldline", worldId: owner.worldId, worldlineId: owner.worldlineId };
    const targetLine = mapped("worldline", line, line.worldlineId).owner;
    if (targetLine.scopeKind !== "worldline") bad();
    if (owner.scopeKind === "worldline") return targetLine;
    const target = mapped(owner.scopeKind, owner, owner.scopeKind === "record" ? owner.recordId : owner.storyId).owner;
    if (target.worldId !== targetLine.worldId || target.worldlineId !== targetLine.worldlineId) bad(); return target;
  };
  const mapIdentity = (kind: GoalMappedEntityKind, owner: GoalOwner, id: string): GoalTypedIdentity => {
    const target = mapped(kind, owner, id); if (goalOwnerKey(target.owner) !== goalOwnerKey(mapOwner(owner))) bad(); return target;
  };
  const mapRef = (r: GoalRef): GoalRef => { const t = mapIdentity("instance", r.owner, r.instanceId); return { owner: t.owner, instanceId: t.id }; };
  const mapEvent = (e: RecordEventRef): RecordEventRef => { const t = mapIdentity("event", eventOwner(e), e.eventId); if (t.owner.scopeKind !== "record") bad(); return { worldId: t.owner.worldId, worldlineId: t.owner.worldlineId, recordId: t.owner.recordId, eventId: t.id }; };
  const rebased = new Map<string, RecordGoalDefinitionVersion>();
  for (const root of source.roots) {
    if (root.owner.scopeKind !== "record") continue;
    const ds = source.definitions.filter(d => goalOwnerKey(definitionOwner(d)) === goalOwnerKey(root.owner));
    if (!ds.length) continue; const target = mapOwner(root.owner); if (target.scopeKind !== "record") bad();
    const events = new Map<string, string>();
    ds.forEach(d => d.basisEventIds.forEach(id => events.set(id, mapIdentity("event", root.owner, id).id)));
    const definitions = rebaseRecordGoalDefinitions({ definitions: ds, scope: { workspaceId, worldId: target.worldId, worldlineId: target.worldlineId, recordId: target.recordId }, eventIds: events });
    for (const d of ds) {
      const result = definitions.find(t => t.goalId === d.goalId && t.definitionVersion === d.definitionVersion)!;
      if (mapIdentity("definition", root.owner, d.definitionId).id !== result.definitionId
        || mapIdentity("instance", root.owner, d.goalInstanceId).id !== result.goalInstanceId) bad();
      rebased.set(d.definitionId, result);
    }
  }
  const roots = source.roots.map(root => ({ owner: mapOwner(root.owner), instances: root.instances.map(g => {
    const targetRef = mapRef(g.ref); let definition: GoalInstanceV2["definition"]; let policyVersion = g.policyVersion;
    if (g.definition.kind === "content") {
      definition = { kind: "content", binding: { ...g.definition.binding, workspaceId, owner: targetRef.owner, instanceId: targetRef.instanceId } };
    } else {
      const d = rebased.get(g.definition.definitionId); if (!d) bad();
      definition = { kind: "record", definitionId: d.definitionId, goalId: d.goalId, definitionVersion: d.definitionVersion }; policyVersion = d.policyVersion;
    }
    return { ...g, ref: targetRef, definition, policyVersion, predecessor: g.predecessor ? { kind: g.predecessor.kind, ref: mapRef(g.predecessor.ref) } : null };
  }) }));
  const sourceGoals = new Map(source.roots.flatMap(r => r.instances).map(g => [refKey(g.ref), g]));
  const targetGoals = new Map(roots.flatMap(r => r.instances).map(g => [refKey(g.ref), g]));
  const assessments = source.assessments.map(a => {
    const g = sourceGoals.get(refKey(a.goal))!;
    if (!input.assessmentEvidence) bad("GOAL_HISTORICAL_BINDING_UNRESOLVED");
    const proof = JSON.parse(canonicalGoalJsonWithinBudget(input.assessmentEvidence(
      JSON.parse(canonicalGoalJsonWithinBudget(a, RUNTIME_SAVE_FILE_BYTES)),
      JSON.parse(canonicalGoalJsonWithinBudget(g, RUNTIME_SAVE_FILE_BYTES))), RUNTIME_SAVE_FILE_BYTES)) as { definition: GoalDefinition; events: readonly GoalEvent[] };
    for (const event of list(proof.events)) {
      const e = object(event); keys(e, ["eventId", "recordId", "recordVersion", "ordinal", "kind", "payload"]);
      text(e.eventId); text(e.recordId); text(e.kind); integer(e.recordVersion, 1); integer(e.ordinal);
      if (e.recordId !== a.sourceEvent.recordId) bad();
    }
    if (new Set(proof.events.map(e => e.eventId)).size !== proof.events.length
      || !proof.events.some(e => e.eventId === a.sourceEvent.eventId && e.recordId === a.sourceEvent.recordId)) bad();
    const d = g.definition.kind === "content" ? normalizeGoalDefinition(proof.definition) : decodeRecordGoalDefinition(proof.definition);
    if (g.definition.kind === "content") decodeGoalContentBinding(g.definition.binding, d);
    else if ((d as RecordGoalDefinitionVersion).definitionId !== g.definition.definitionId) bad();
    if (d.goalKey !== g.goalKey || d.policyVersion !== g.policyVersion) bad();
    const events = a.evidenceEvents.map(e => {
      const found = proof.events.filter(x => x.eventId === e.eventId && x.recordId === e.recordId); if (found.length !== 1) bad();
      const event = found[0]; integer(event.recordVersion, 1); integer(event.ordinal); text(event.kind);
      if (a.evidenceHead && (event.recordVersion > a.evidenceHead.recordVersion || event.recordVersion === a.evidenceHead.recordVersion && event.ordinal > a.evidenceHead.ordinal)) bad();
      return event;
    });
    const sourceSnapshot = { ...g, goalInstanceId: g.ref.instanceId, recordId: (g.ref.owner as Extract<GoalOwner, { scopeKind: "record" }>).recordId };
    const sourceHash = goalEvidenceSnapshotHash({ definition: d, instance: sourceSnapshot, events, evidenceHead: a.evidenceHead });
    if (sourceHash !== a.evidenceSnapshotHash) bad();
    // Only registered candidate fields are rewritten; arbitrary prose/custom metadata remains data.
    if (Object.hasOwn(a.result, "policyVersion") && a.result.policyVersion !== a.policyVersion) bad();
    if (Object.hasOwn(a.result, "evidenceSnapshotHash") && a.result.evidenceSnapshotHash !== sourceHash) bad();
    if (Object.hasOwn(a.result, "evidenceEventIds") && canonicalGoalJson(a.result.evidenceEventIds) !== canonicalGoalJson(a.evidenceEvents.map(e => e.eventId))) bad();
    const goal = mapRef(a.goal); const targetGoal = targetGoals.get(refKey(goal))!;
    const td = targetGoal.definition.kind === "record" ? rebased.get(g.definition.kind === "record" ? g.definition.definitionId : "")! : d;
    const targetEvents = events.map((event, i) => { const t = mapEvent(a.evidenceEvents[i]); return { ...event, eventId: t.eventId, recordId: t.recordId }; });
    const targetSnapshot = { ...targetGoal, goalInstanceId: goal.instanceId, recordId: (goal.owner as Extract<GoalOwner, { scopeKind: "record" }>).recordId };
    const evidenceSnapshotHash = goalEvidenceSnapshotHash({ definition: td, instance: targetSnapshot, events: targetEvents, evidenceHead: a.evidenceHead });
    const result = { ...a.result };
    if (Object.hasOwn(result, "policyVersion")) result.policyVersion = targetGoal.policyVersion;
    if (Object.hasOwn(result, "evidenceSnapshotHash")) result.evidenceSnapshotHash = evidenceSnapshotHash;
    if (Object.hasOwn(result, "evidenceEventIds")) result.evidenceEventIds = targetEvents.map(e => e.eventId);
    return { ...a, id: mapIdentity("assessment", a.goal.owner, a.id).id, goal, sourceEvent: mapEvent(a.sourceEvent), result,
      evidenceEvents: a.evidenceEvents.map(mapEvent), evidenceSnapshotHash, policyVersion: targetGoal.policyVersion };
  });
  return decodeRealmRuntimeSaveGoalsV2({ format: "realm-runtime-goals", schemaVersion: 2, workspaceId, roots, definitions: [...rebased.values()], assessments });
}
