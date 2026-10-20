/**
 * Pure, internal F2b replay contract. Context digests prove structural consistency,
 * not signed history or permission. No database, service, or archive wiring lives here.
 */
import { createHash } from "node:crypto";
import { projectFinanceCommandFingerprintFor } from "../projects/public.ts";
import { isSemanticEventKey } from "../world-transfer/semantic-events.ts";

export type ReplayIdentityKind = "record" | "event" | "scene" | "characterInstance" | "assetDefinition"
  | "project" | "financeAccount" | "milestone" | "obligation";
export type ReplayScopeV1 = Readonly<{ workspaceId: string; worldId: string; worldlineId: string }>;
export type ReplayIdentityPairV1 = readonly [currentId: string, originId: string | null];
export type ReplayIdentitiesV1 = Readonly<Record<ReplayIdentityKind, readonly ReplayIdentityPairV1[]>>;
export type ReplayContextBodyV1 = Readonly<{
  format: "realm-command-lineage-context"; version: 1; family: "fact" | "finance";
  originScope: ReplayScopeV1; currentScope: ReplayScopeV1; identities: ReplayIdentitiesV1;
}>;
export type ReplayContextV1 = ReplayContextBodyV1 & Readonly<{ id: string }>;
export type ArchiveReplayBindingV1 = Readonly<{ version: 1; contextId: string; originalRequestFingerprint: string }>;
export type StoredReplayBindingV1 = ArchiveReplayBindingV1 & Readonly<{ anchorCommandId: string }>;
export type ResolvedReplayProofV1 = Readonly<{ binding: ArchiveReplayBindingV1; context: ReplayContextV1 }>;
export type ReplayClosure = Readonly<Record<ReplayIdentityKind, readonly string[]>>;
export type ReplayForwardMaps = Readonly<Record<ReplayIdentityKind, readonly (readonly [string, string])[]>>;
export type ReplayBudget = Readonly<{ maxBytes?: number }>;
export const REPLAY_LINEAGE_MAX_BYTES = 64 * 1024 * 1024;

const KINDS: readonly ReplayIdentityKind[] = ["record", "event", "scene", "characterInstance", "assetDefinition", "project", "financeAccount", "milestone", "obligation"];
const FACT_NAMESPACES = new Set<ReplayIdentityKind>(["record", "event", "characterInstance", "assetDefinition"]);
const FINANCE_NAMESPACES = new Set<ReplayIdentityKind>(["record", "scene", "project", "financeAccount", "milestone", "obligation"]);
const CONTEXT_KEYS = ["format", "version", "family", "originScope", "currentScope", "identities"];
const BINDING_KEYS = ["version", "contextId", "originalRequestFingerprint"];
const ID = /^[A-Za-z0-9._:-]+$/;
const HASH = /^[0-9a-f]{64}$/;

type Data = Record<string, unknown>;
class ReplayLineageError extends Error {
  readonly code: "REPLAY_LINEAGE_INVALID" | "REPLAY_LINEAGE_LIMIT";
  constructor(code: "REPLAY_LINEAGE_INVALID" | "REPLAY_LINEAGE_LIMIT" = "REPLAY_LINEAGE_INVALID") {
    super(code === "REPLAY_LINEAGE_LIMIT" ? "Replay lineage exceeds its byte budget." : "Replay lineage is invalid.");
    this.name = "ReplayLineageError";
    this.code = code;
  }
}
function invalid(): never { throw new ReplayLineageError(); }
function limit(): never { throw new ReplayLineageError("REPLAY_LINEAGE_LIMIT"); }

/** Check every descriptor before reading values; never invoke getters or toJSON. */
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Data {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    if (typeof key !== "string" || (!required.includes(key) && !optional.includes(key))) invalid();
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) invalid();
  }
  if (required.some((key) => !Object.hasOwn(descriptors, key))) invalid();
  const copy: Data = {};
  for (const key of keys as string[]) copy[key] = descriptors[key]!.value;
  return copy;
}
function array(value: unknown, maximum = REPLAY_LINEAGE_MAX_BYTES): unknown[] {
  if (!Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Array.prototype && prototype !== null) invalid();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0) invalid();
  if (length > maximum) limit();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) invalid();
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) invalid();
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) invalid();
  }
  return Array.from({ length }, (_, index) => {
    if (!Object.hasOwn(descriptors, String(index))) invalid();
    return descriptors[String(index)]!.value;
  });
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 256 || !ID.test(value) || value === "." || value === "..") invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) invalid();
  return value;
}
function scope(value: unknown): ReplayScopeV1 {
  const row = object(value, ["workspaceId", "worldId", "worldlineId"]);
  return Object.freeze({ workspaceId: identity(row.workspaceId), worldId: identity(row.worldId), worldlineId: identity(row.worldlineId) });
}
function sameScope(left: ReplayScopeV1, right: ReplayScopeV1): boolean {
  return left.workspaceId === right.workspaceId && left.worldId === right.worldId && left.worldlineId === right.worldlineId;
}
function budget(options: ReplayBudget = {}): number {
  const row = object(options, [], ["maxBytes"]);
  if (!Object.hasOwn(row, "maxBytes")) return REPLAY_LINEAGE_MAX_BYTES;
  if (!Number.isSafeInteger(row.maxBytes) || (row.maxBytes as number) < 1 || (row.maxBytes as number) > REPLAY_LINEAGE_MAX_BYTES) invalid();
  return row.maxBytes as number;
}
// Only descriptor-validated, newly built JSON values enter this encoder.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const row = value as Data;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function bytes(value: unknown): number { return Buffer.byteLength(canonical(value), "utf8"); }
function within(value: unknown, maximum: number): void { if (bytes(value) > maximum) limit(); }
function eligible(family: "fact" | "finance"): ReadonlySet<ReplayIdentityKind> {
  return family === "fact" ? FACT_NAMESPACES : FINANCE_NAMESPACES;
}
function readBody(value: unknown, maximum: number, tagged: boolean): ReplayContextBodyV1 {
  const row = object(value, tagged ? [...CONTEXT_KEYS, "id"] : CONTEXT_KEYS);
  if (row.format !== "realm-command-lineage-context" || row.version !== 1 || (row.family !== "fact" && row.family !== "finance")) invalid();
  const family = row.family;
  const raw = object(row.identities, KINDS);
  const identities = {} as Record<ReplayIdentityKind, readonly ReplayIdentityPairV1[]>;
  let consumed = 0;
  for (const kind of KINDS) {
    const entries = array(raw[kind], Math.floor(maximum / 9));
    if (!eligible(family).has(kind) && entries.length) invalid();
    const origins = new Set<string>();
    let previous: string | undefined;
    identities[kind] = Object.freeze(entries.map((entry) => {
      const pair = array(entry, 2);
      if (pair.length !== 2) invalid();
      const current = identity(pair[0]);
      const origin = pair[1] === null ? null : identity(pair[1]);
      if (previous !== undefined && current <= previous) invalid();
      previous = current;
      if (origin !== null && origins.has(origin)) invalid();
      if (origin !== null) origins.add(origin);
      const output = Object.freeze([current, origin] as const);
      consumed += bytes(output) + 1;
      if (consumed > maximum) limit();
      return output;
    }));
  }
  return Object.freeze({ format: "realm-command-lineage-context", version: 1, family,
    originScope: scope(row.originScope), currentScope: scope(row.currentScope), identities: Object.freeze(identities) });
}
function digest(body: ReplayContextBodyV1): string {
  return createHash("sha256").update(`realm-command-lineage-context:v1\0${canonical(body)}`).digest("hex");
}
export function decodeReplayContext(value: unknown, options?: ReplayBudget): ReplayContextV1 {
  const maximum = budget(options);
  const body = readBody(value, maximum, true);
  const id = hash(object(value, [...CONTEXT_KEYS, "id"]).id);
  if (id !== digest(body)) invalid();
  const output = Object.freeze({ ...body, id });
  within(output, maximum);
  return output;
}

export function createReplayContext(value: unknown, options?: ReplayBudget): ReplayContextV1 {
  const maximum = budget(options);
  const body = readBody(value, maximum, false);
  const output = Object.freeze({ ...body, id: digest(body) });
  within(output, maximum);
  return output;
}
function readClosure(value: unknown, maximum: number, selected: ReadonlySet<ReplayIdentityKind>): ReplayClosure {
  const raw = object(value, KINDS);
  const output = {} as Record<ReplayIdentityKind, readonly string[]>;
  let consumed = 0;
  for (const kind of KINDS) {
    // Closure is caller-supplied source data, not stored lineage. Validate all
    // namespaces, but charge only those represented by the context(s).
    const ids = array(raw[kind], selected.has(kind) ? maximum : REPLAY_LINEAGE_MAX_BYTES).map(identity);
    if (new Set(ids).size !== ids.length) invalid();
    if (selected.has(kind)) consumed += bytes(ids);
    if (consumed > maximum) limit();
    output[kind] = ids.sort();
  }
  return output;
}
function requireCoverage(context: ReplayContextV1, closure: ReplayClosure): void {
  for (const kind of eligible(context.family)) {
    const pairs = context.identities[kind];
    const ids = closure[kind];
    if (pairs.length !== ids.length || pairs.some(([current], index) => current !== ids[index])) invalid();
  }
}
/** Trusted source knowledge may contain IDs omitted by the outgoing archive. */
export function projectReplayContext(value: unknown, actualSourceScope: ReplayScopeV1, actualClosure: ReplayClosure, options?: ReplayBudget): ReplayContextV1 {
  const context = decodeReplayContext(value, options);
  if (!sameScope(context.currentScope, scope(actualSourceScope))) invalid();
  const closure = readClosure(actualClosure, budget(options), eligible(context.family));
  const identities = {} as Record<ReplayIdentityKind, readonly ReplayIdentityPairV1[]>;
  for (const kind of KINDS) {
    const known = new Map(context.identities[kind]);
    identities[kind] = eligible(context.family).has(kind)
      ? closure[kind].map((id) => [id, known.get(id) ?? null] as const) : [];
  }
  return createReplayContext({ format: context.format, version: context.version, family: context.family,
    originScope: context.originScope, currentScope: context.currentScope, identities }, options);
}
/** Compose actual planned IDs; origin scope/associations are never rebound. */
export function composeReplayContext(value: unknown, actualSourceScope: ReplayScopeV1, actualClosure: ReplayClosure, targetScope: ReplayScopeV1, plannedMaps: unknown, options?: ReplayBudget): ReplayContextV1 {
  const context = decodeReplayContext(value, options);
  if (!sameScope(context.currentScope, scope(actualSourceScope))) invalid();
  const closure = readClosure(actualClosure, budget(options), eligible(context.family));
  requireCoverage(context, closure);
  const raw = object(plannedMaps, KINDS);
  const identities = {} as Record<ReplayIdentityKind, readonly ReplayIdentityPairV1[]>;
  for (const kind of KINDS) {
    const entries = array(raw[kind], Math.floor(budget(options) / 9));
    if (!eligible(context.family).has(kind)) {
      if (entries.length) invalid();
      identities[kind] = [];
      continue;
    }
    const forward = new Map<string, string>();
    const targets = new Set<string>();
    for (const entry of entries) {
      const pair = array(entry, 2);
      if (pair.length !== 2) invalid();
      const from = identity(pair[0]); const to = identity(pair[1]);
      if (forward.has(from) || targets.has(to)) invalid();
      forward.set(from, to); targets.add(to);
    }
    if (forward.size !== closure[kind].length || closure[kind].some((id) => !forward.has(id))) invalid();
    identities[kind] = context.identities[kind].map(([current, origin]) => [forward.get(current)!, origin] as const)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  }
  return createReplayContext({ format: context.format, version: context.version, family: context.family,
    originScope: context.originScope, currentScope: scope(targetScope), identities }, options);
}

export function decodeReplayBinding(value: unknown, options?: ReplayBudget): ArchiveReplayBindingV1 {
  const row = object(value, BINDING_KEYS);
  if (row.version !== 1) invalid();
  const output = Object.freeze({ version: 1 as const, contextId: hash(row.contextId), originalRequestFingerprint: hash(row.originalRequestFingerprint) });
  within(output, budget(options));
  return output;
}
/** Pure locator shape only; SQL anchor eligibility and lookup are a later slice. */
export function decodeStoredReplayBinding(value: unknown, options?: ReplayBudget): StoredReplayBindingV1 {
  const row = object(value, [...BINDING_KEYS, "anchorCommandId"]);
  const output = Object.freeze({ ...decodeReplayBinding({ version: row.version, contextId: row.contextId, originalRequestFingerprint: row.originalRequestFingerprint }, options), anchorCommandId: identity(row.anchorCommandId) });
  within(output, budget(options));
  return output;
}
/** Writer-side dedup; identical bodies only, never result/request resemblance. */
export function deduplicateReplayContexts(values: unknown, options?: ReplayBudget): readonly ReplayContextV1[] {
  const contexts = new Map<string, ReplayContextV1>();
  const seenObjects = new WeakMap<object, ReplayContextV1>();
  let consumed = 2;
  for (const value of array(values, budget(options))) {
    let context = value !== null && typeof value === "object" ? seenObjects.get(value) : undefined;
    if (!context) {
      context = decodeReplayContext(value, options);
      if (value !== null && typeof value === "object") seenObjects.set(value, context);
    }
    const existing = contexts.get(context.id);
    if (existing) {
      if (existing !== context && canonical(existing) !== canonical(context)) invalid();
    } else {
      consumed += bytes(context) + (contexts.size ? 1 : 0);
      if (consumed > budget(options)) limit();
      contexts.set(context.id, context);
    }
  }
  return Object.freeze([...contexts.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
export type ReplayReceiptReferenceV1 = Readonly<{
  id: string; family: "fact" | "finance"; requestFingerprint: string; replayLineage: ArchiveReplayBindingV1;
}>;
/** Incoming validation is deliberately separate from trusted source projection. */
export function validateReplayBundle(contextValues: unknown, receiptValues: unknown, actualScope: ReplayScopeV1, actualClosure: ReplayClosure, options?: ReplayBudget): Readonly<{
  contexts: readonly ReplayContextV1[]; receipts: readonly ReplayReceiptReferenceV1[]; byteLength: number;
}> {
  const maximum = budget(options);
  const expectedScope = scope(actualScope);
  const byId = new Map<string, ReplayContextV1>();
  const selected = new Set<ReplayIdentityKind>();
  let previous: string | undefined;
  let consumed = Buffer.byteLength('{"contexts":[],"receipts":[]}', "utf8");
  for (const raw of array(contextValues, maximum)) {
    const context = decodeReplayContext(raw, options);
    if (previous !== undefined && context.id <= previous) invalid();
    previous = context.id;
    if (!sameScope(context.currentScope, expectedScope)) invalid();
    for (const kind of eligible(context.family)) selected.add(kind);
    consumed += bytes(context) + (byId.size ? 1 : 0);
    if (consumed > maximum) limit();
    byId.set(context.id, context);
  }
  const closure = readClosure(actualClosure, maximum, selected);
  for (const context of byId.values()) requireCoverage(context, closure);
  const seen = new Map<string, Set<string>>();
  const used = new Set<string>();
  const receipts: ReplayReceiptReferenceV1[] = [];
  for (const raw of array(receiptValues, maximum)) {
    const row = object(raw, ["id", "family", "requestFingerprint", "replayLineage"]);
    const id = identity(row.id);
    if (row.family !== "fact" && row.family !== "finance") invalid();
    const family = row.family;
    const familyIds = seen.get(family) ?? new Set<string>();
    if (familyIds.has(id)) invalid();
    familyIds.add(id); seen.set(family, familyIds);
    const requestFingerprint = hash(row.requestFingerprint);
    const replayLineage = decodeReplayBinding(row.replayLineage, options);
    const context = byId.get(replayLineage.contextId);
    if (!context || context.family !== family || replayLineage.originalRequestFingerprint !== requestFingerprint) invalid();
    used.add(context.id);
    const receipt = Object.freeze({ id, family, requestFingerprint, replayLineage });
    consumed += bytes(receipt) + (receipts.length ? 1 : 0);
    if (consumed > maximum) limit();
    receipts.push(receipt);
  }
  if (used.size !== byId.size) invalid();
  return Object.freeze({ contexts: Object.freeze([...byId.values()]), receipts: Object.freeze(receipts), byteLength: consumed });
}

export type FactKind = "inventory_adjusted" | "inventory_granted" | "relationship_revised" | "performance_assessed";
export type FactReplayRequest =
  | Readonly<{ command: "inventory.adjusted"; recordId: string; characterInstanceId: string; assetDefinitionId: string; delta: number; sourceEventId: string; expectedRevision: number }>
  | Readonly<{ command: "inventory.granted"; recordId: string; characterInstanceId: string; assetDefinitionId: string; quantity: number; sourceEventId: string }>
  | Readonly<{ command: "relationship.revised"; subjectEntityKey: string; objectEntityKey: string; relationKind: string; sourceEventId: string }>
  | Readonly<{ command: "performance.assessed"; recordId: string; policyVersion: "structured-factors:v1"; score: number; evidenceEventIds: readonly string[] }>;
type Evidence = Readonly<{ recordId: string; sceneId: string; visibility: "public" | "restricted"; worldTick: number; worldOrdinal: number }>;
type Stage = "planning" | "funding" | "production" | "scheduled" | "delivery" | "closed";
type ExpenseFields = Readonly<{ accountId: string | null; projectId: string | null; amountMinor: number; category: string; memo: string; occurredAt: string; expectedBalanceMinor: number }>;
type LedgerFields = ExpenseFields & Readonly<{ recordId: string | null; evidence: Evidence | null }>;
type FinanceAction =
  | Readonly<{ command: "change_stage"; projectId: string; stage: Stage; expectedProjectVersion: number }>
  | Readonly<{ command: "confirm_milestone"; projectId: string; milestoneId: string; expectedProjectVersion: number }>
  | (ExpenseFields & Readonly<{ command: "record_expense" }>);
export type FinanceReplayRequest =
  | (LedgerFields & Readonly<{ command: "finance.expense.recorded" }>)
  | (LedgerFields & Readonly<{ command: "finance.income.recorded"; direction: "income" }>)
  | (LedgerFields & Readonly<{ command: "finance.adjustment.recorded"; direction: "income" | "expense" }>)
  | Readonly<{ command: "project.milestone.confirmed"; projectId: string; milestoneId: string; expectedProjectVersion: number; evidence: Evidence | null; semanticEventKey?: string }>
  | Readonly<{ command: "project.stage.changed"; projectId: string; stage: Stage; expectedProjectVersion: number; evidence: Evidence | null }>
  | Readonly<{ command: "finance.budget.allocated"; projectId: string; category: string; amountMinor: number; expectedVersion: number }>
  | Readonly<{ command: "finance.obligation.created"; projectId: string | null; kind: "loan" | "presale" | "revenue_share"; principalMinor: number; shareBps: number | null; undeliveredCount: number }>
  | Readonly<{ command: "finance.obligation.settled"; obligationId: string; settlementKind: "repayment" | "draw" | "share"; amountMinor: number; expectedOutstandingMinor: number; expectedBalanceMinor: number; accountId: string | null; category: string; occurredAt: string }>
  | Readonly<{ command: "record.apply_project_finance"; evidence: Evidence | null; actions: readonly FinanceAction[] }>;
export type ReplayIdentityResolver = (kind: ReplayIdentityKind, id: string) => string;
const FACT_COMMANDS: Readonly<Record<FactKind, FactReplayRequest["command"]>> = {
  inventory_adjusted: "inventory.adjusted", inventory_granted: "inventory.granted",
  relationship_revised: "relationship.revised", performance_assessed: "performance.assessed",
};
const STAGES = ["planning", "funding", "production", "scheduled", "delivery", "closed"] as const;
function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalid();
  return value;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid();
  return value as number;
}
function enumeration<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) invalid();
  return value as T[number];
}
function mapped(value: unknown, kind: ReplayIdentityKind, resolve: ReplayIdentityResolver): string {
  return identity(resolve(kind, identity(value)));
}
function nullableMapped(value: unknown, kind: ReplayIdentityKind, resolve: ReplayIdentityResolver): string | null {
  return value === null ? null : mapped(value, kind, resolve);
}
function checkedResolver(resolve: ReplayIdentityResolver): ReplayIdentityResolver {
  const forward = new Map<ReplayIdentityKind, Map<string, string>>();
  const inverse = new Map<ReplayIdentityKind, Map<string, string>>();
  return (kind, from) => {
    let to: string;
    try { to = identity(resolve(kind, from)); } catch { return invalid(); }
    const sources = forward.get(kind) ?? new Map<string, string>();
    const targets = inverse.get(kind) ?? new Map<string, string>();
    if ((sources.has(from) && sources.get(from) !== to) || (targets.has(to) && targets.get(to) !== from)) invalid();
    sources.set(from, to); targets.set(to, from);
    forward.set(kind, sources); inverse.set(kind, targets);
    return to;
  };
}
export function walkFactReplayRequest(kind: FactKind, value: unknown, resolve: ReplayIdentityResolver): FactReplayRequest {
  resolve = checkedResolver(resolve);
  if (!Object.hasOwn(FACT_COMMANDS, kind)) invalid();
  const command = FACT_COMMANDS[kind];
  switch (kind) {
    case "inventory_adjusted": {
      const row = object(value, ["command", "recordId", "characterInstanceId", "assetDefinitionId", "delta", "sourceEventId", "expectedRevision"]);
      if (row.command !== command) invalid();
      const delta = integer(row.delta, Number.MIN_SAFE_INTEGER);
      if (delta === 0) invalid();
      return Object.freeze({ command: "inventory.adjusted", recordId: mapped(row.recordId, "record", resolve),
        characterInstanceId: mapped(row.characterInstanceId, "characterInstance", resolve), assetDefinitionId: mapped(row.assetDefinitionId, "assetDefinition", resolve),
        delta, sourceEventId: mapped(row.sourceEventId, "event", resolve), expectedRevision: integer(row.expectedRevision) });
    }
    case "inventory_granted": {
      const row = object(value, ["command", "recordId", "characterInstanceId", "assetDefinitionId", "quantity", "sourceEventId"]);
      if (row.command !== command) invalid();
      return Object.freeze({ command: "inventory.granted", recordId: mapped(row.recordId, "record", resolve),
        characterInstanceId: mapped(row.characterInstanceId, "characterInstance", resolve), assetDefinitionId: mapped(row.assetDefinitionId, "assetDefinition", resolve),
        quantity: integer(row.quantity, 1), sourceEventId: mapped(row.sourceEventId, "event", resolve) });
    }
    case "relationship_revised": {
      const row = object(value, ["command", "subjectEntityKey", "objectEntityKey", "relationKind", "sourceEventId"]);
      if (row.command !== command) invalid();
      const subjectEntityKey = text(row.subjectEntityKey); const objectEntityKey = text(row.objectEntityKey);
      if (subjectEntityKey.length > 256 || objectEntityKey.length > 256 || subjectEntityKey === objectEntityKey) invalid();
      const relationKind = text(row.relationKind);
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(relationKind)) invalid();
      return Object.freeze({ command: "relationship.revised", subjectEntityKey, objectEntityKey, relationKind, sourceEventId: mapped(row.sourceEventId, "event", resolve) });
    }
    case "performance_assessed": {
      const row = object(value, ["command", "recordId", "policyVersion", "score", "evidenceEventIds"]);
      if (row.command !== command || row.policyVersion !== "structured-factors:v1") invalid();
      const evidence = array(row.evidenceEventIds, 32).map(identity);
      if (!evidence.length || new Set(evidence).size !== evidence.length) invalid();
      if (evidence.some((id, index) => index > 0 && evidence[index - 1]!.localeCompare(id) > 0)) invalid();
      const evidenceEventIds = evidence.map((id) => mapped(id, "event", resolve)).sort((a, b) => a.localeCompare(b));
      if (new Set(evidenceEventIds).size !== evidenceEventIds.length) invalid();
      return Object.freeze({ command: "performance.assessed", recordId: mapped(row.recordId, "record", resolve), policyVersion: "structured-factors:v1",
        score: integer(row.score, -1_000_000, 1_000_000), evidenceEventIds: Object.freeze(evidenceEventIds) });
    }
  }
}
function evidenceValue(value: unknown, resolve: ReplayIdentityResolver): Evidence | null {
  if (value === null) return null;
  const row = object(value, ["recordId", "sceneId", "visibility", "worldTick", "worldOrdinal"]);
  return Object.freeze({ recordId: mapped(row.recordId, "record", resolve), sceneId: mapped(row.sceneId, "scene", resolve),
    visibility: enumeration(row.visibility, ["public", "restricted"]), worldTick: integer(row.worldTick), worldOrdinal: integer(row.worldOrdinal) });
}
const EXPENSE_KEYS = ["accountId", "projectId", "amountMinor", "category", "memo", "occurredAt", "expectedBalanceMinor"];
const FINANCE_KEYS = ["command", ...EXPENSE_KEYS, "recordId", "evidence", "direction", "projectId", "milestoneId", "expectedProjectVersion", "semanticEventKey", "stage", "expectedVersion", "kind", "principalMinor", "shareBps", "undeliveredCount", "obligationId", "settlementKind", "expectedOutstandingMinor", "actions"];
function expenseFields(row: Data, resolve: ReplayIdentityResolver): ExpenseFields {
  return { accountId: nullableMapped(row.accountId, "financeAccount", resolve), projectId: nullableMapped(row.projectId, "project", resolve),
    amountMinor: integer(row.amountMinor, 1), category: text(row.category), memo: text(row.memo), occurredAt: text(row.occurredAt), expectedBalanceMinor: integer(row.expectedBalanceMinor) };
}
function financeAction(value: unknown, resolve: ReplayIdentityResolver): FinanceAction {
  const peek = object(value, ["command"], [...EXPENSE_KEYS, "projectId", "stage", "milestoneId", "expectedProjectVersion"]);
  switch (peek.command) {
    case "change_stage": {
      const row = object(value, ["command", "projectId", "stage", "expectedProjectVersion"]);
      return Object.freeze({ command: "change_stage", projectId: mapped(row.projectId, "project", resolve), stage: enumeration(row.stage, STAGES), expectedProjectVersion: integer(row.expectedProjectVersion, 1) });
    }
    case "confirm_milestone": {
      const row = object(value, ["command", "projectId", "milestoneId", "expectedProjectVersion"]);
      return Object.freeze({ command: "confirm_milestone", projectId: mapped(row.projectId, "project", resolve), milestoneId: mapped(row.milestoneId, "milestone", resolve), expectedProjectVersion: integer(row.expectedProjectVersion, 1) });
    }
    case "record_expense": {
      const row = object(value, ["command", ...EXPENSE_KEYS]);
      return Object.freeze({ command: "record_expense", ...expenseFields(row, resolve) });
    }
    default: return invalid();
  }
}
export function walkFinanceReplayRequest(value: unknown, resolve: ReplayIdentityResolver): FinanceReplayRequest {
  resolve = checkedResolver(resolve);
  const peek = object(value, ["command"], FINANCE_KEYS);
  const command = peek.command;
  switch (command) {
    case "finance.expense.recorded":
    case "finance.income.recorded":
    case "finance.adjustment.recorded": {
      const row = object(value, ["command", ...EXPENSE_KEYS, "recordId", "evidence", ...(command === "finance.expense.recorded" ? [] : ["direction"])]);
      const fields = { ...expenseFields(row, resolve), recordId: nullableMapped(row.recordId, "record", resolve), evidence: evidenceValue(row.evidence, resolve) };
      if (command === "finance.expense.recorded") return Object.freeze({ command, ...fields });
      if (command === "finance.income.recorded") {
        if (row.direction !== "income") invalid();
        return Object.freeze({ command, ...fields, direction: "income" });
      }
      return Object.freeze({ command, ...fields, direction: enumeration(row.direction, ["income", "expense"]) });
    }
    case "project.milestone.confirmed": {
      const row = object(value, ["command", "projectId", "milestoneId", "expectedProjectVersion", "evidence"], ["semanticEventKey"]);
      let semantic: { semanticEventKey?: string } = {};
      if (Object.hasOwn(row, "semanticEventKey")) {
        if (!isSemanticEventKey(row.semanticEventKey)) invalid();
        semantic = { semanticEventKey: row.semanticEventKey };
      }
      return Object.freeze({ command, projectId: mapped(row.projectId, "project", resolve), milestoneId: mapped(row.milestoneId, "milestone", resolve),
        expectedProjectVersion: integer(row.expectedProjectVersion, 1), evidence: evidenceValue(row.evidence, resolve), ...semantic });
    }
    case "project.stage.changed": {
      const row = object(value, ["command", "projectId", "stage", "expectedProjectVersion", "evidence"]);
      return Object.freeze({ command, projectId: mapped(row.projectId, "project", resolve), stage: enumeration(row.stage, STAGES),
        expectedProjectVersion: integer(row.expectedProjectVersion, 1), evidence: evidenceValue(row.evidence, resolve) });
    }
    case "finance.budget.allocated": {
      const row = object(value, ["command", "projectId", "category", "amountMinor", "expectedVersion"]);
      return Object.freeze({ command, projectId: mapped(row.projectId, "project", resolve), category: text(row.category), amountMinor: integer(row.amountMinor, 1), expectedVersion: integer(row.expectedVersion) });
    }
    case "finance.obligation.created": {
      const row = object(value, ["command", "projectId", "kind", "principalMinor", "shareBps", "undeliveredCount"]);
      const kind = enumeration(row.kind, ["loan", "presale", "revenue_share"]);
      const shareBps = row.shareBps === null ? null : integer(row.shareBps, 0, 10000);
      const undeliveredCount = integer(row.undeliveredCount);
      if ((kind === "revenue_share") !== (shareBps !== null) || (kind !== "presale" && undeliveredCount !== 0)) invalid();
      return Object.freeze({ command, projectId: nullableMapped(row.projectId, "project", resolve), kind, principalMinor: integer(row.principalMinor, 1), shareBps, undeliveredCount });
    }
    case "finance.obligation.settled": {
      const row = object(value, ["command", "obligationId", "settlementKind", "amountMinor", "expectedOutstandingMinor", "expectedBalanceMinor", "accountId", "category", "occurredAt"]);
      return Object.freeze({ command, obligationId: mapped(row.obligationId, "obligation", resolve), settlementKind: enumeration(row.settlementKind, ["repayment", "draw", "share"]),
        amountMinor: integer(row.amountMinor, 1), expectedOutstandingMinor: integer(row.expectedOutstandingMinor), expectedBalanceMinor: integer(row.expectedBalanceMinor),
        accountId: nullableMapped(row.accountId, "financeAccount", resolve), category: text(row.category), occurredAt: text(row.occurredAt) });
    }
    case "record.apply_project_finance": {
      const row = object(value, ["command", "evidence", "actions"]);
      const actions = array(row.actions, 8);
      if (!actions.length) invalid();
      return Object.freeze({ command, evidence: evidenceValue(row.evidence, resolve), actions: Object.freeze(actions.map((action) => financeAction(action, resolve))) });
    }
    default: return invalid();
  }
}

/**
 * One comparison for future fast/recheck callers. Scope/metadata are supplied by
 * the trusted caller, not inferred from context. Failure never returns data or
 * authorizes a commit. A missing proof uses only the existing current-scope hash.
 */
export function compareReplay(value: unknown): boolean {
  try {
    const input = object(value, ["family", "trustedScope", "candidate", "expectedOperation", "existing"], ["factFingerprint", "suppliedTargetFingerprint"]);
    if (input.family !== "fact" && input.family !== "finance") invalid();
    const family = input.family;
    const trustedScope = scope(input.trustedScope);
    const expectedOperation = text(input.expectedOperation);
    const factEntry = Object.entries(FACT_COMMANDS).find(([, operation]) => operation === expectedOperation);
    const kind = factEntry?.[0] as FactKind | undefined;
    if (family === "fact" && (!kind || typeof input.factFingerprint !== "function")) invalid();
    if (family === "finance" && Object.hasOwn(input, "factFingerprint")) invalid();
    const identityResolver: ReplayIdentityResolver = (_kind, id) => id;
    const validated = family === "fact" ? walkFactReplayRequest(kind!, input.candidate, identityResolver) : walkFinanceReplayRequest(input.candidate, identityResolver);
    if (validated.command !== expectedOperation) invalid();
    const fingerprint = family === "fact"
      ? input.factFingerprint as (scope: ReplayScopeV1, request: Readonly<Record<string, unknown>>) => string
      : (atScope: ReplayScopeV1, request: Readonly<Record<string, unknown>>) => projectFinanceCommandFingerprintFor(atScope, request as { command: string });
    // Hash the FULL candidate, including its supplied array order/presence. The
    // typed reverse walker may sort origin evidence, but never repairs this hash.
    const targetHash = hash(fingerprint(trustedScope, input.candidate as Readonly<Record<string, unknown>>));
    if (Object.hasOwn(input, "suppliedTargetFingerprint") && hash(input.suppliedTargetFingerprint) !== targetHash) return false;
    const existing = object(input.existing, ["requestFingerprint", "request"], ["provenance", "kind", "state", "policyVersion", "replayProof"]);
    const originalHash = hash(existing.requestFingerprint);
    if (Object.hasOwn(existing, "provenance") && existing.provenance !== "legacy-result-v1" && existing.provenance !== "request-result-v1") invalid();
    if (existing.provenance === "legacy-result-v1" && existing.request !== null) invalid();
    if (existing.provenance === "request-result-v1" && (existing.request === null || typeof existing.request !== "object" || Array.isArray(existing.request))) invalid();
    if (family === "fact" && Object.hasOwn(existing, "kind") && existing.kind !== kind) invalid();
    if (!Object.hasOwn(existing, "replayProof")) return originalHash === targetHash;
    if (existing.provenance !== "legacy-result-v1" || existing.request !== null) invalid();
    if (family === "fact") {
      if (existing.kind !== kind || Object.hasOwn(existing, "state") || Object.hasOwn(existing, "policyVersion")) invalid();
    } else if (existing.state !== "committed" || existing.policyVersion !== "project-finance-command.v1" || Object.hasOwn(existing, "kind")) invalid();
    const proof = object(existing.replayProof, ["binding", "context"]);
    const context = decodeReplayContext(proof.context);
    const binding = decodeReplayBinding(proof.binding);
    if (context.family !== family || !sameScope(context.currentScope, trustedScope) || binding.contextId !== context.id || binding.originalRequestFingerprint !== originalHash) invalid();
    const maps = new Map(KINDS.map((namespace) => [namespace, new Map(context.identities[namespace])] as const));
    const reverse: ReplayIdentityResolver = (namespace, current) => {
      const origin = maps.get(namespace)!.get(current);
      if (origin === null || origin === undefined) invalid();
      return origin;
    };
    const request = family === "fact" ? walkFactReplayRequest(kind!, input.candidate, reverse) : walkFinanceReplayRequest(input.candidate, reverse);
    return hash(fingerprint(context.originScope, request)) === originalHash;
  } catch {
    return false;
  }
}
