import { createHash } from "node:crypto";
import type { GoalDefinition } from "./public.ts";
import { createRealmWorldContentStore } from "../world-transfer/realmworld-content.ts";
import type { RealmWorldManifestV1 } from "../world-transfer/realmworld-manifest.ts";

/** Pure data only. A valid digest or binding is never package/signature verification. */
export type GoalOwner =
  | { scopeKind: "record"; worldId: string; worldlineId: string; recordId: string }
  | { scopeKind: "story"; worldId: string; worldlineId: string; storyId: string }
  | { scopeKind: "worldline"; worldId: string; worldlineId: string };
export type GoalSource =
  | { sourceKind: "installed"; sourceWorldId: string; sourceWorldVersion: string;
      packageContentHash: string; baseRevision: null; baseContentHash: null }
  | { sourceKind: "base"; sourceWorldId: ""; sourceWorldVersion: "0.0.0-local";
      packageContentHash: null; baseRevision: string; baseContentHash: string };
export interface GoalContentBindingV1 {
  bindingVersion: 1; workspaceId: string; owner: GoalOwner; instanceId: string;
  goalKey: string; policyVersion: string; definitionHash: string;
  normalization: "goal-definition-c14n-v1"; source: GoalSource;
}
export interface GoalHistoricalProof { algorithm: string; immutableSourceId: string; sourceSha256: string }
export type GoalBindingQualification =
  | { kind: "NEW_BOUND"; binding: GoalContentBindingV1 }
  | { kind: "LEGACY_PROVABLE"; binding: GoalContentBindingV1; proof: GoalHistoricalProof }
  | { kind: "UNRESOLVED_LEGACY"; code: "GOAL_HISTORICAL_BINDING_UNRESOLVED" };
export class GoalContentBindingError extends Error {
  readonly code = "GOAL_CONTENT_BINDING_INVALID";
  constructor() { super("Goal content binding is invalid."); this.name = "GoalContentBindingError"; }
}
function bad(): never { throw new GoalContentBindingError(); }
export const MAX_GOAL_JSON_BYTES = 16 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;

/** Counts escaped JSON UTF-8 bytes before allocating the complete serialization. */
export function canonicalGoalJson(value: unknown, maximumBytes = MAX_GOAL_JSON_BYTES): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_GOAL_JSON_BYTES) bad();
  return canonicalGoalJsonWithinBudget(value, maximumBytes);
}
/** Same canonicalization and object guards; archive sections supply their own
 * existing file budget. Definition/binding callers retain the V1 16 MiB cap. */
export function canonicalGoalJsonWithinBudget(value: unknown, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) bad();
  let bytes = 0;
  const add = (n: number) => { bytes += n; if (bytes > maximumBytes) bad(); };
  const textBytes = (s: string) => {
    add(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) bad(); add(4);
      } else if (c >= 0xdc00 && c <= 0xdfff) bad();
      else if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) add(2);
      else if (c < 32) add(6);
      else add(c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  };
  const stack = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (depth > 64) bad();
    if (typeof v === "string") { textBytes(v); return; }
    if (v === null) { add(4); return; }
    if (typeof v === "boolean") { add(v ? 4 : 5); return; }
    if (typeof v === "number") { if (!Number.isFinite(v)) bad(); add(JSON.stringify(v).length); return; }
    if (!v || typeof v !== "object" || stack.has(v)) bad();
    const proto = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) bad();
    if (Object.getOwnPropertySymbols(v).length) bad();
    stack.add(v); add(2);
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) bad();
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i)); if (!d || !("value" in d)) bad();
        if (i) add(1); walk(d.value, depth + 1);
      }
    } else {
      const names = Object.getOwnPropertyNames(v);
      names.forEach((k, i) => {
        const d = Object.getOwnPropertyDescriptor(v, k)!; if (!d.enumerable || !("value" in d)) bad();
        if (i) add(1); textBytes(k); add(1); walk(d.value, depth + 1);
      });
    }
    stack.delete(v);
  };
  walk(value, 0);
  const serialize = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(serialize).join(",")}]`;
    const row = v as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(k => `${JSON.stringify(k)}:${serialize(row[k])}`).join(",")}}`;
  };
  return serialize(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad();
  return value as Record<string, unknown>;
}
function exact(row: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k))) bad();
}
function text(v: unknown): string {
  if (typeof v !== "string" || !v.trim() || v.length > 4096 || v.includes("\0")) bad(); return v;
}
export function goalOwnerKey(owner: GoalOwner): string {
  return JSON.stringify([owner.scopeKind, owner.worldId, owner.worldlineId,
    owner.scopeKind === "record" ? owner.recordId : owner.scopeKind === "story" ? owner.storyId : ""]);
}
export function decodeGoalOwner(value: unknown): GoalOwner {
  canonicalGoalJson(value);
  const row = object(value); const common = ["scopeKind", "worldId", "worldlineId"];
  if (row.scopeKind === "record") { exact(row, [...common, "recordId"]); return { scopeKind: "record", worldId: text(row.worldId), worldlineId: text(row.worldlineId), recordId: text(row.recordId) }; }
  if (row.scopeKind === "story") { exact(row, [...common, "storyId"]); return { scopeKind: "story", worldId: text(row.worldId), worldlineId: text(row.worldlineId), storyId: text(row.storyId) }; }
  if (row.scopeKind !== "worldline") bad(); exact(row, common);
  return { scopeKind: "worldline", worldId: text(row.worldId), worldlineId: text(row.worldlineId) };
}
function source(value: unknown, owner: GoalOwner): GoalSource {
  const r = object(value); exact(r, ["sourceKind", "sourceWorldId", "sourceWorldVersion", "packageContentHash", "baseRevision", "baseContentHash"]);
  if (r.sourceKind === "installed") {
    if (r.sourceWorldId !== owner.worldId || r.sourceWorldVersion === "0.0.0-local"
      || typeof r.packageContentHash !== "string" || !HASH.test(r.packageContentHash)
      || r.baseRevision !== null || r.baseContentHash !== null) bad();
    return { sourceKind: "installed", sourceWorldId: text(r.sourceWorldId), sourceWorldVersion: text(r.sourceWorldVersion), packageContentHash: r.packageContentHash, baseRevision: null, baseContentHash: null };
  }
  if (r.sourceKind !== "base" || r.sourceWorldId !== "" || r.sourceWorldVersion !== "0.0.0-local"
    || r.packageContentHash !== null || typeof r.baseContentHash !== "string" || !HASH.test(r.baseContentHash)) bad();
  return { sourceKind: "base", sourceWorldId: "", sourceWorldVersion: "0.0.0-local", packageContentHash: null, baseRevision: text(r.baseRevision), baseContentHash: r.baseContentHash };
}

/** The production decoder owns the complete GoalDefinition, including optional
 * terminal/retry settings and semantic criteria normalization.
 * The manifest below is only a decoder argument, never a mount or source witness. */
export function normalizeGoalDefinition(value: unknown): GoalDefinition {
  const detached = object(JSON.parse(canonicalGoalJson(value)));
  const manifest: RealmWorldManifestV1 = { format: "realmworld", formatVersion: 1, worldId: "pure-decoder", worldVersion: "1.0.0",
    engineCompat: { schemaLatest: "", requiresMigrations: [], baseRange: "*" }, contentHash: "0".repeat(64), signature: { algorithm: "ed25519", keyId: "pure-decoder", value: "" } };
  try {
    const bytes = Buffer.from(canonicalGoalJson({ format: "realmworld-goals", schemaVersion: 1, goals: [detached] }));
    const definition = createRealmWorldContentStore({ manifest, files: new Map([["content/goals.json", bytes]]) }).listGoalDefinitions()[0];
    if ((definition.mode === "semantic") !== (definition.rubric.kind === "semantic")) bad();
    return definition;
  } catch { return bad(); }
}
export function goalDefinitionHash(value: unknown): string {
  return createHash("sha256").update("realm-goal-definition:c14n-v1\0").update(canonicalGoalJson(normalizeGoalDefinition(value))).digest("hex");
}
export function baseGoalDefinitionsHash(values: readonly unknown[]): string {
  canonicalGoalJson(values);
  const definitions = values.map(normalizeGoalDefinition).sort((a, b) => a.goalKey < b.goalKey ? -1 : a.goalKey > b.goalKey ? 1 : 0);
  if (new Set(definitions.map(d => d.goalKey)).size !== definitions.length) bad();
  return createHash("sha256").update("realm-base-goals:c14n-v1\0").update(canonicalGoalJson(definitions)).digest("hex");
}
export function decodeGoalContentBinding(value: unknown, definition?: unknown): GoalContentBindingV1 {
  const r = object(JSON.parse(canonicalGoalJson(value)));
  exact(r, ["bindingVersion", "workspaceId", "owner", "instanceId", "goalKey", "policyVersion", "definitionHash", "normalization", "source"]);
  if (r.bindingVersion !== 1 || r.normalization !== "goal-definition-c14n-v1" || typeof r.definitionHash !== "string" || !HASH.test(r.definitionHash)) bad();
  const owner = decodeGoalOwner(r.owner);
  const binding: GoalContentBindingV1 = { bindingVersion: 1, workspaceId: text(r.workspaceId), owner, instanceId: text(r.instanceId), goalKey: text(r.goalKey), policyVersion: text(r.policyVersion), definitionHash: r.definitionHash, normalization: "goal-definition-c14n-v1", source: source(r.source, owner) };
  if (definition !== undefined) {
    const d = normalizeGoalDefinition(definition);
    if (d.goalKey !== binding.goalKey || d.policyVersion !== binding.policyVersion || goalDefinitionHash(d) !== binding.definitionHash) bad();
  }
  return binding;
}
/** Inject only independently trusted evidence. No resolver, registry or proof issuer is created here. */
export type TrustedGoalBindingEvidence =
  | { kind: "new"; binding: GoalContentBindingV1; definition: GoalDefinition }
  | { kind: "legacy"; binding: GoalContentBindingV1; definition: GoalDefinition;
      creation?: { workspaceId: string; owner: GoalOwner; instanceId: string }; proof: GoalHistoricalProof };
export function qualifyGoalContentBinding(value: unknown, trustedEvidence?: TrustedGoalBindingEvidence): GoalBindingQualification {
  const binding = decodeGoalContentBinding(value);
  if (!trustedEvidence) return { kind: "UNRESOLVED_LEGACY", code: "GOAL_HISTORICAL_BINDING_UNRESOLVED" };
  const witness = decodeGoalContentBinding(trustedEvidence.binding, trustedEvidence.definition);
  if (canonicalGoalJson(binding) !== canonicalGoalJson(witness)) bad();
  if (trustedEvidence.kind === "new") return { kind: "NEW_BOUND", binding };
  if (trustedEvidence.kind !== "legacy" || !trustedEvidence.creation) bad();
  const creation = trustedEvidence.creation;
  if (creation.workspaceId !== binding.workspaceId || creation.instanceId !== binding.instanceId
    || goalOwnerKey(decodeGoalOwner(creation.owner)) !== goalOwnerKey(binding.owner)) bad();
  const p = object(trustedEvidence.proof); exact(p, ["algorithm", "immutableSourceId", "sourceSha256"]);
  if (typeof p.sourceSha256 !== "string" || !HASH.test(p.sourceSha256)) bad();
  return { kind: "LEGACY_PROVABLE", binding, proof: { algorithm: text(p.algorithm), immutableSourceId: text(p.immutableSourceId), sourceSha256: p.sourceSha256 } };
}
