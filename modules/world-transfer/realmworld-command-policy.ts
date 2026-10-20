import { mountRealmWorld, type RealmWorldSignatureVerifier } from "./realmworld-loader.ts";
import { isSemanticEventKey, parseDeclaredSemanticEvents } from "./semantic-events.ts";

export const COMMAND_POLICY_PATH = "content/command-policy.json";
export const COMMAND_POLICY_MAX_BYTES = 256 * 1024;
export interface CommandPolicyDocument {
  format: "realmworld-command-policy";
  schemaVersion: 1;
  policyVersion: string;
  projects: { projectKey: string; kind: "production" | "campaign" | "operation" | "initiative";
    title: Record<string, string>; milestones: { milestoneKey: string; title: Record<string, string> }[] }[];
  bindings: { bindingKey: string; command: "confirm_milestone"; projectKey: string; milestoneKey: string;
    semanticEventKey: string; storySelector: "genesis"; recordSelector: "genesis";
    all: { kind: "milestone_status"; milestoneKey: string; status: "completed" }[] }[];
}
export interface ResolvedCommandPolicy {
  worldId: string; worldVersion: string; contentHash: string; policyVersion: string; document: CommandPolicyDocument;
}
const mountedPolicies = new WeakSet<object>();
export function assertMountedCommandPolicy(policy: ResolvedCommandPolicy): void {
  if (!mountedPolicies.has(policy)) throw new CommandPolicyError();
}
function freezePolicy<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezePolicy); Object.freeze(value); }
  return value;
}
export type CommandPolicyResolver = (binding: { worldId: string; worldVersion: string }) => Promise<ResolvedCommandPolicy | null>;
export interface RequestPolicy { schemaVersion: 1; contentHash: string; policyVersion: string; bindingKey: string }
export class CommandPolicyError extends Error {
  readonly code = "BUSINESS_POLICY_MISSING";
  constructor() { super("A verified command policy is unavailable or invalid."); this.name = "CommandPolicyError"; }
}
function invalid(): never { throw new CommandPolicyError(); }
export function commandPolicyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || value === "." || value === ".." || !/^[A-Za-z0-9._:-]+$/.test(value)) invalid();
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: unknown, names: string[]): Record<string, unknown> {
  const o = object(value);
  if (Object.keys(o).length !== names.length || names.some(n => !Object.hasOwn(o, n))) invalid();
  return o;
}
function array(value: unknown, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid();
  return value;
}
function title(value: unknown): Record<string, string> {
  const entries = Object.entries(object(value)); if (!entries.length) invalid();
  const result: Record<string, string> = {};
  for (const [locale, text] of entries) {
    if (!/^[A-Za-z0-9-]+$/.test(locale) || typeof text !== "string" || text.length < 1 || text.length > 512 || text.trim() !== text) invalid();
    result[locale] = text;
  }
  return result;
}
/** Validate JSON grammar first, then scan members at each nesting level, including escaped equivalent keys. */
export function parseCommandPolicyJson(bytes: Uint8Array): unknown {
  let source: string; let value: unknown;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); value = JSON.parse(source); } catch { return invalid(); }
  let i = 0;
  function ws() { while (/\s/.test(source[i] ?? "") && i < source.length) i++; }
  function string(): string {
    const start = i++;
    while (i < source.length) { const c = source[i++]; if (c === "\\") i++; else if (c === '"') return JSON.parse(source.slice(start, i)); }
    return invalid();
  }
  function visit(depth: number): void {
    if (depth > 16) invalid(); ws();
    if (source[i] === "{") {
      i++; ws(); const seen = new Set<string>();
      if (source[i] === "}") { i++; return; }
      while (true) {
        ws(); const key = string(); if (seen.has(key)) invalid(); seen.add(key); ws(); i++; visit(depth + 1); ws();
        if (source[i++] === "}") return;
      }
    }
    if (source[i] === "[") {
      i++; ws(); if (source[i] === "]") { i++; return; }
      while (true) { visit(depth + 1); ws(); if (source[i++] === "]") return; }
    }
    if (source[i] === '"') { string(); return; }
    while (i < source.length && !/[\s,}\]]/.test(source[i]!)) i++;
  }
  visit(0);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > COMMAND_POLICY_MAX_BYTES) invalid();
  return value;
}
export function decodeCommandPolicy(value: unknown, declaredEvents: readonly string[]): CommandPolicyDocument {
  const o = keys(value, ["format", "schemaVersion", "policyVersion", "projects", "bindings"]);
  if (o.format !== "realmworld-command-policy" || o.schemaVersion !== 1) invalid();
  const projectKeys = new Set<string>(); let total = 0;
  const projects = array(o.projects, 1, 64).map(raw => {
    const p = keys(raw, ["projectKey", "kind", "title", "milestones"]); const projectKey = commandPolicyKey(p.projectKey);
    if (projectKeys.has(projectKey) || !["production", "campaign", "operation", "initiative"].includes(String(p.kind))) invalid();
    projectKeys.add(projectKey); const milestoneKeys = new Set<string>();
    const milestones = array(p.milestones, 1, 64).map(raw => {
      const m = keys(raw, ["milestoneKey", "title"]); const milestoneKey = commandPolicyKey(m.milestoneKey);
      if (milestoneKeys.has(milestoneKey) || ++total > 256) invalid(); milestoneKeys.add(milestoneKey);
      return { milestoneKey, title: title(m.title) };
    });
    return { projectKey, kind: p.kind as CommandPolicyDocument["projects"][number]["kind"], title: title(p.title), milestones };
  });
  const bindingKeys = new Set<string>(); const tuples = new Set<string>();
  const bindings = array(o.bindings, 1, 64).map(raw => {
    const b = keys(raw, ["bindingKey", "command", "projectKey", "milestoneKey", "semanticEventKey", "storySelector", "recordSelector", "all"]);
    const bindingKey = commandPolicyKey(b.bindingKey), projectKey = commandPolicyKey(b.projectKey), milestoneKey = commandPolicyKey(b.milestoneKey);
    const project = projects.find(p => p.projectKey === projectKey);
    if (!project || !project.milestones.some(m => m.milestoneKey === milestoneKey) || bindingKeys.has(bindingKey)
      || b.command !== "confirm_milestone" || b.storySelector !== "genesis" || b.recordSelector !== "genesis"
      || !isSemanticEventKey(b.semanticEventKey) || !declaredEvents.includes(b.semanticEventKey)) invalid();
    bindingKeys.add(bindingKey);
    const tuple = JSON.stringify([b.command, projectKey, milestoneKey, b.semanticEventKey, b.storySelector, b.recordSelector]);
    if (tuples.has(tuple)) invalid(); tuples.add(tuple);
    const all = array(b.all, 0, 8).map(raw => {
      const a = keys(raw, ["kind", "milestoneKey", "status"]); const key = commandPolicyKey(a.milestoneKey);
      if (a.kind !== "milestone_status" || a.status !== "completed" || key === milestoneKey || !project.milestones.some(m => m.milestoneKey === key)) invalid();
      return { kind: "milestone_status" as const, milestoneKey: key, status: "completed" as const };
    });
    return { bindingKey, command: "confirm_milestone" as const, projectKey, milestoneKey, semanticEventKey: b.semanticEventKey,
      storySelector: "genesis" as const, recordSelector: "genesis" as const, all };
  });
  const result: CommandPolicyDocument = { format: "realmworld-command-policy", schemaVersion: 1, policyVersion: commandPolicyKey(o.policyVersion), projects, bindings };
  if (Buffer.byteLength(JSON.stringify(result)) > COMMAND_POLICY_MAX_BYTES) invalid();
  return result;
}
export function commandPolicyFromFiles(files: ReadonlyMap<string, Uint8Array>): CommandPolicyDocument | undefined {
  const bytes = files.get(COMMAND_POLICY_PATH); if (!bytes) return undefined;
  const world = object(parseCommandPolicyJson(files.get("content/world.json") ?? invalid()));
  const declared = parseDeclaredSemanticEvents(object(world.settings).declaredEvents); if (!declared) invalid();
  return decodeCommandPolicy(parseCommandPolicyJson(bytes), declared);
}
export function normalizeRequestPolicy(value: unknown): RequestPolicy {
  const o = keys(value, ["schemaVersion", "contentHash", "policyVersion", "bindingKey"]);
  if (o.schemaVersion !== 1 || typeof o.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(o.contentHash)) invalid();
  return { schemaVersion: 1, contentHash: o.contentHash, policyVersion: commandPolicyKey(o.policyVersion), bindingKey: commandPolicyKey(o.bindingKey) };
}
/** Called lazily by the server after receipt replay. Only this mount supplies package trust. */
export function createInstalledRealmWorldCommandPolicyResolver(input: {
  installRoot: string; verifySignature: RealmWorldSignatureVerifier; engineBaseVersion?: string;
}): CommandPolicyResolver {
  return async binding => {
    const mounted = await mountRealmWorld({ ...input, ...binding });
    if (mounted.manifest.worldId !== binding.worldId || mounted.manifest.worldVersion !== binding.worldVersion) invalid();
    const document = commandPolicyFromFiles(mounted.files); if (!document) return null;
    const result = freezePolicy({ ...binding, contentHash: mounted.manifest.contentHash, policyVersion: document.policyVersion, document });
    mountedPolicies.add(result);
    return result;
  };
}

export interface CommandMaterializationRow {
  projectKey: string; milestoneKey: string; projectId: string; milestoneId: string; storyId: string; recordId: string;
}
export interface CommandMaterializations {
  format: "realmworld-command-materializations"; schemaVersion: 1;
  worldVersion: string; contentHash: string; policyVersion: string; rows: CommandMaterializationRow[];
}
export function normalizeCommandMaterializations(value: unknown): CommandMaterializations {
  const o = keys(value, ["format", "schemaVersion", "worldVersion", "contentHash", "policyVersion", "rows"]);
  if (o.format !== "realmworld-command-materializations" || o.schemaVersion !== 1 || typeof o.worldVersion !== "string"
    || !o.worldVersion.length || o.worldVersion.length > 256 || typeof o.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(o.contentHash)) invalid();
  const seen = new Set<string>(), ids = new Set<string>(), projects = new Map<string, string>(), reverse = new Map<string, string>();
  let topology: string | undefined;
  const rows = array(o.rows, 1, 256).map(raw => {
    const r = keys(raw, ["projectKey", "milestoneKey", "projectId", "milestoneId", "storyId", "recordId"]);
    const projectKey = commandPolicyKey(r.projectKey), milestoneKey = commandPolicyKey(r.milestoneKey);
    for (const k of ["projectId", "milestoneId", "storyId", "recordId"]) if (typeof r[k] !== "string" || !r[k].length || r[k].length > 256 || r[k].trim() !== r[k]) invalid();
    const row = { ...r, projectKey, milestoneKey } as unknown as CommandMaterializationRow;
    const key = JSON.stringify([projectKey, milestoneKey]), top = JSON.stringify([row.storyId, row.recordId]);
    if (seen.has(key) || ids.has(row.milestoneId) || (projects.has(projectKey) && projects.get(projectKey) !== row.projectId)
      || (reverse.has(row.projectId) && reverse.get(row.projectId) !== projectKey) || (topology !== undefined && topology !== top)) invalid();
    seen.add(key); ids.add(row.milestoneId); projects.set(projectKey, row.projectId); reverse.set(row.projectId, projectKey); topology = top;
    return row;
  });
  const result: CommandMaterializations = { format: "realmworld-command-materializations", schemaVersion: 1, worldVersion: o.worldVersion,
    contentHash: o.contentHash, policyVersion: commandPolicyKey(o.policyVersion), rows };
  if (Buffer.byteLength(JSON.stringify(result)) > COMMAND_POLICY_MAX_BYTES) invalid();
  return result;
}
export function validateCommandMaterializations(map: CommandMaterializations, policy: ResolvedCommandPolicy): void {
  assertMountedCommandPolicy(policy);
  if (map.worldVersion !== policy.worldVersion || map.contentHash !== policy.contentHash || map.policyVersion !== policy.policyVersion
    || policy.policyVersion !== policy.document.policyVersion) invalid();
  const expected = policy.document.projects.flatMap(p => p.milestones.map(m => JSON.stringify([p.projectKey, m.milestoneKey]))).sort();
  const actual = map.rows.map(r => JSON.stringify([r.projectKey, r.milestoneKey])).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) invalid();
}
