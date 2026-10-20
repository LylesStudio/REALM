import { normalizeCommandMaterializations, type CommandMaterializations } from "./realmworld-command-policy.ts";
import { decodeReplayBinding, deduplicateReplayContexts, validateReplayBundle, REPLAY_LINEAGE_MAX_BYTES, type ArchiveReplayBindingV1, type ReplayContextV1 } from "../application/command-replay-lineage.ts";
import { countRuntimeSectionWireBytes, type RuntimeSectionWireLedger, RealmRuntimeSaveError, validateRealmRuntimeSaveRecordBundle, type RealmRuntimeSaveRecordBundleV1 } from "./realm-runtime-save.ts";
import type { JsonValue } from "../runtime/public.ts";

export type RealmRuntimeSaveDomainErrorCode = "INVALID_DOMAIN_SAVE";

export class RealmRuntimeSaveDomainError extends Error {
  readonly code: RealmRuntimeSaveDomainErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "RealmRuntimeSaveDomainError";
    this.code = "INVALID_DOMAIN_SAVE";
  }
}

type JsonObject = Readonly<Record<string, JsonValue>>;

type ProjectKind = "production" | "campaign" | "operation" | "initiative";
type ProjectStatus = "planned" | "active" | "completed" | "cancelled" | "archived";
type ProjectStage = "planning" | "funding" | "production" | "scheduled" | "delivery" | "closed";
type MilestoneStatus = "planned" | "active" | "completed" | "cancelled";
type LedgerKind = "income" | "expense" | "adjustment";
type LedgerDirection = "income" | "expense";
type CommandState = "committed" | "rejected";
type ObligationKind = "loan" | "presale" | "revenue_share";
type ObligationStatus = "open" | "settled" | "cancelled";
type SettlementKind = "repayment" | "draw" | "share";
type StoryNodeState = "locked" | "active" | "completed" | "failed";
type UnlockTransition = "unlocked" | "rolled_back";

export interface RealmRuntimeSaveDomainProjectV1 {
  id: string;
  kind: ProjectKind;
  status: ProjectStatus;
  stage: ProjectStage;
  title: string;
  currency: "JPY";
  deadline: string | null;
  version: number;
}

export interface RealmRuntimeSaveDomainMilestoneV1 {
  id: string;
  projectId: string;
  sequence: number;
  title: string;
  status: MilestoneStatus;
  dueOn: string | null;
  completionRecordId: string | null;
  completionEventId: string | null;
}

export interface RealmRuntimeSaveDomainProjectStoryLinkV1 {
  id: string;
  projectId: string;
  storyId: string;
  linkKind: "primary" | "related";
}

export interface RealmRuntimeSaveDomainBudgetAllocationV1 {
  id: string;
  projectId: string;
  category: string;
  amountMinor: number;
  currency: "JPY";
  version: number;
}

export interface RealmRuntimeSaveDomainFinanceAccountV1 {
  id: string;
  currency: "JPY";
  status: "active" | "closed";
  openingBalanceMinor: number;
}

export interface RealmRuntimeSaveDomainLedgerEntryV1 {
  id: string;
  accountId: string;
  kind: LedgerKind;
  direction: LedgerDirection;
  amountMinor: number;
  currency: "JPY";
  category: string;
  memo: string;
  projectId: string | null;
  sourceRecordId: string | null;
  sourceEventId: string | null;
  occurredAt: string;
  idempotencyKey: string;
}

export interface RealmRuntimeSaveDomainFinanceCommandGroupV1 {
  provenance?: "request-result-v1" | "legacy-result-v1";
  request?: JsonObject | null;
  replayLineage?: ArchiveReplayBindingV1;
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  state: CommandState;
  resultManifest: JsonObject;
  rejectionCode: string | null;
  policyVersion: string;
  sourceRecordId: string | null;
}

export interface RealmRuntimeSaveDomainObligationV1 {
  id: string;
  projectId: string | null;
  kind: ObligationKind;
  status: ObligationStatus;
  principalMinor: number;
  outstandingMinor: number;
  shareBps: number | null;
  undeliveredCount: number;
  dueOn: string | null;
  version: number;
}

export interface RealmRuntimeSaveDomainObligationSettlementV1 {
  id: string;
  obligationId: string;
  ledgerEntryId: string | null;
  kind: SettlementKind;
  amountMinor: number;
}

export interface RealmRuntimeSaveDomainStoryNodeV1 {
  storyId?: string;
  id: string;
  nodeKey: string;
  state: StoryNodeState;
  revision: number;
  recordId: string | null;
  definitionHash: string;
  unlockEvidenceEventIds: readonly string[];
  unlockEvidence: JsonObject;
}

export interface RealmRuntimeSaveDomainStoryUnlockLedgerV1 {
  storyId?: string;
  id: string;
  storyNodeInstanceId: string;
  nodeKey: string;
  transition: UnlockTransition;
  idempotencyKey: string;
  recordId: string | null;
  evidenceEventIds: readonly string[];
  evidenceHash: string;
  evidence: JsonObject;
}

export interface RealmRuntimeSaveDomainCommittedFactCommandV1 {
  provenance?: "request-result-v1" | "legacy-result-v1";
  request?: JsonObject | null;
  replayLineage?: ArchiveReplayBindingV1;
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  kind: "inventory_adjusted" | "inventory_granted" | "relationship_revised" | "performance_assessed";
  resultManifest: JsonObject;
}

export interface RealmRuntimeSaveDomainPerformanceAssessmentV1 {
  id: string;
  recordId: string;
  policyVersion: string;
  score: number;
  evidenceEventIds: readonly string[];
  evidenceSnapshotHash: string;
  commandId: string;
}

export interface RealmRuntimeSaveDomainMemberRelationshipRevisionV1 {
  id: string;
  subjectEntityKey: string;
  objectEntityKey: string;
  relationKind: string;
  revisionOrdinal: number;
  sourceEventId: string;
  sourceRecordId: string;
  occurredTick: number;
  occurredOrdinal: number;
  commandId: string;
}

export interface RealmRuntimeSaveDomainCharacterAssetV1 {
  rulePackKey?: string;
  recordId: string;
  characterInstanceId: string;
  assetDefinitionId: string;
  /** Stable content key for cross-World binding; absent in legacy v1 archives. */
  assetKey?: string;
  quantity: number;
  revision: number;
  metadata: JsonObject;
}

export interface RealmRuntimeSaveDomainV1 {
  commandMaterializations?: CommandMaterializations;
  /** Optional only for the shipped single-Record wire format. Whole closures require all three. */
  stories?: readonly wholeRealmRuntimeSaveDomainStoryV1[];
  storyDefinitions?: readonly wholeRealmRuntimeSaveDomainStoryDefinitionV1[];
  records?: readonly wholeRealmRuntimeSaveDomainRecordSnapshotV1[];
  commandReplayContexts?: readonly ReplayContextV1[];
  format: "realm-runtime-domain";
  schemaVersion: 1;
  source: {
    worldId: string;
    worldlineId: string;
    storyId: string;
    recordId: string;
  };
  projects: readonly RealmRuntimeSaveDomainProjectV1[];
  milestones: readonly RealmRuntimeSaveDomainMilestoneV1[];
  projectStoryLinks: readonly RealmRuntimeSaveDomainProjectStoryLinkV1[];
  budgetAllocations: readonly RealmRuntimeSaveDomainBudgetAllocationV1[];
  financeAccounts: readonly RealmRuntimeSaveDomainFinanceAccountV1[];
  ledgerEntries: readonly RealmRuntimeSaveDomainLedgerEntryV1[];
  financeCommandGroups: readonly RealmRuntimeSaveDomainFinanceCommandGroupV1[];
  obligations: readonly RealmRuntimeSaveDomainObligationV1[];
  obligationSettlements: readonly RealmRuntimeSaveDomainObligationSettlementV1[];
  storyNodes: readonly RealmRuntimeSaveDomainStoryNodeV1[];
  storyUnlockLedger: readonly RealmRuntimeSaveDomainStoryUnlockLedgerV1[];
  committedFactCommands: readonly RealmRuntimeSaveDomainCommittedFactCommandV1[];
  performanceAssessments: readonly RealmRuntimeSaveDomainPerformanceAssessmentV1[];
  memberRelationshipRevisions: readonly RealmRuntimeSaveDomainMemberRelationshipRevisionV1[];
  characterAssets: readonly RealmRuntimeSaveDomainCharacterAssetV1[];
}

const PROJECT_KINDS = new Set<ProjectKind>(["production", "campaign", "operation", "initiative"]);
const PROJECT_STATUSES = new Set<ProjectStatus>(["planned", "active", "completed", "cancelled", "archived"]);
const PROJECT_STAGES = new Set<ProjectStage>(["planning", "funding", "production", "scheduled", "delivery", "closed"]);
const MILESTONE_STATUSES = new Set<MilestoneStatus>(["planned", "active", "completed", "cancelled"]);
const LEDGER_KINDS = new Set<LedgerKind>(["income", "expense", "adjustment"]);
const LEDGER_DIRECTIONS = new Set<LedgerDirection>(["income", "expense"]);
const COMMAND_STATES = new Set<CommandState>(["committed", "rejected"]);
const OBLIGATION_KINDS = new Set<ObligationKind>(["loan", "presale", "revenue_share"]);
const OBLIGATION_STATUSES = new Set<ObligationStatus>(["open", "settled", "cancelled"]);
const SETTLEMENT_KINDS = new Set<SettlementKind>(["repayment", "draw", "share"]);
const NODE_STATES = new Set<StoryNodeState>(["locked", "active", "completed", "failed"]);
const UNLOCK_TRANSITIONS = new Set<UnlockTransition>(["unlocked", "rolled_back"]);
const FACT_KINDS = new Set<RealmRuntimeSaveDomainCommittedFactCommandV1["kind"]>(["inventory_adjusted", "inventory_granted", "relationship_revised", "performance_assessed"]);
const IDENTITY = /^[A-Za-z0-9._:-]+$/;
const HASH = /^[0-9a-f]{64}$/;

function fail(field: string): never {
  throw new RealmRuntimeSaveDomainError(`runtime domain save ${field} is invalid`);
}

function object(value: unknown, field: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(field);
  return value as JsonObject;
}

function keys(value: JsonObject, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${field}.unknownKey`);
}

function stringValue(value: unknown, field: string, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) fail(field);
  return value;
}

function identity(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (!IDENTITY.test(result) || result === "." || result === "..") fail(field);
  return result;
}

function nullableString(value: unknown, field: string): string | null {
  return value === null ? null : stringValue(value, field, false);
}

function integer(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(field);
  return value as number;
}

function finiteScore(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < -1_000_000 || (value as number) > 1_000_000) fail(field);
  return value as number;
}

function jsonValue(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(field);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${field}[${index}]`));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) result[key] = jsonValue(item, `${field}.${key}`);
    return result;
  }
  fail(field);
}

function jsonObject(value: unknown, field: string): JsonObject {
  const normalized = jsonValue(value, field);
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) fail(field);
  return normalized as JsonObject;
}

function stringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) fail(field);
  return value.map((item, index) => stringValue(item, `${field}[${index}]`));
}

function enumValue<T extends string>(value: unknown, set: ReadonlySet<T>, field: string): T {
  if (typeof value !== "string" || !set.has(value as T)) fail(field);
  return value as T;
}

function dateString(value: unknown, field: string): string {
  const result = stringValue(value, field);
  if (Number.isNaN(new Date(result).getTime())) fail(field);
  return new Date(result).toISOString();
}

function normalizeProject(value: unknown, index: number): RealmRuntimeSaveDomainProjectV1 {
  const row = object(value, `projects[${index}]`);
  keys(row, ["id", "kind", "status", "stage", "title", "currency", "deadline", "version"], `projects[${index}]`);
  return {
    id: identity(row.id, `projects[${index}].id`),
    kind: enumValue(row.kind, PROJECT_KINDS, `projects[${index}].kind`),
    status: enumValue(row.status, PROJECT_STATUSES, `projects[${index}].status`),
    stage: enumValue(row.stage, PROJECT_STAGES, `projects[${index}].stage`),
    title: stringValue(row.title, `projects[${index}].title`),
    currency: row.currency === "JPY" ? "JPY" : fail(`projects[${index}].currency`),
    deadline: nullableString(row.deadline, `projects[${index}].deadline`),
    version: integer(row.version, `projects[${index}].version`, 1),
  };
}

function normalizeMilestone(value: unknown, index: number): RealmRuntimeSaveDomainMilestoneV1 {
  const row = object(value, `milestones[${index}]`);
  keys(row, ["id", "projectId", "sequence", "title", "status", "dueOn", "completionRecordId", "completionEventId"], `milestones[${index}]`);
  const completionRecordId = nullableString(row.completionRecordId, `milestones[${index}].completionRecordId`);
  const completionEventId = nullableString(row.completionEventId, `milestones[${index}].completionEventId`);
  if ((completionRecordId === null) !== (completionEventId === null)) fail(`milestones[${index}].completionEvidence`);
  return {
    id: identity(row.id, `milestones[${index}].id`),
    projectId: identity(row.projectId, `milestones[${index}].projectId`),
    sequence: integer(row.sequence, `milestones[${index}].sequence`, 1),
    title: stringValue(row.title, `milestones[${index}].title`),
    status: enumValue(row.status, MILESTONE_STATUSES, `milestones[${index}].status`),
    dueOn: nullableString(row.dueOn, `milestones[${index}].dueOn`),
    completionRecordId,
    completionEventId,
  };
}

function normalizeLink(value: unknown, index: number): RealmRuntimeSaveDomainProjectStoryLinkV1 {
  const row = object(value, `projectStoryLinks[${index}]`);
  keys(row, ["id", "projectId", "storyId", "linkKind"], `projectStoryLinks[${index}]`);
  return {
    id: identity(row.id, `projectStoryLinks[${index}].id`),
    projectId: identity(row.projectId, `projectStoryLinks[${index}].projectId`),
    storyId: identity(row.storyId, `projectStoryLinks[${index}].storyId`),
    linkKind: row.linkKind === "primary" || row.linkKind === "related" ? row.linkKind : fail(`projectStoryLinks[${index}].linkKind`),
  };
}

function normalizeBudget(value: unknown, index: number): RealmRuntimeSaveDomainBudgetAllocationV1 {
  const row = object(value, `budgetAllocations[${index}]`);
  keys(row, ["id", "projectId", "category", "amountMinor", "currency", "version"], `budgetAllocations[${index}]`);
  return {
    id: identity(row.id, `budgetAllocations[${index}].id`),
    projectId: identity(row.projectId, `budgetAllocations[${index}].projectId`),
    category: stringValue(row.category, `budgetAllocations[${index}].category`),
    amountMinor: integer(row.amountMinor, `budgetAllocations[${index}].amountMinor`, 1),
    currency: row.currency === "JPY" ? "JPY" : fail(`budgetAllocations[${index}].currency`),
    version: integer(row.version, `budgetAllocations[${index}].version`, 1),
  };
}

function normalizeAccount(value: unknown, index: number): RealmRuntimeSaveDomainFinanceAccountV1 {
  const row = object(value, `financeAccounts[${index}]`);
  keys(row, ["id", "currency", "status", "openingBalanceMinor"], `financeAccounts[${index}]`);
  return {
    id: identity(row.id, `financeAccounts[${index}].id`),
    currency: row.currency === "JPY" ? "JPY" : fail(`financeAccounts[${index}].currency`),
    status: row.status === "active" || row.status === "closed" ? row.status : fail(`financeAccounts[${index}].status`),
    openingBalanceMinor: integer(row.openingBalanceMinor, `financeAccounts[${index}].openingBalanceMinor`),
  };
}

function normalizeLedger(value: unknown, index: number): RealmRuntimeSaveDomainLedgerEntryV1 {
  const row = object(value, `ledgerEntries[${index}]`);
  keys(row, ["id", "accountId", "kind", "direction", "amountMinor", "currency", "category", "memo", "projectId", "sourceRecordId", "sourceEventId", "occurredAt", "idempotencyKey"], `ledgerEntries[${index}]`);
  const sourceRecordId = nullableString(row.sourceRecordId, `ledgerEntries[${index}].sourceRecordId`);
  const sourceEventId = nullableString(row.sourceEventId, `ledgerEntries[${index}].sourceEventId`);
  if (sourceEventId !== null && sourceRecordId === null) fail(`ledgerEntries[${index}].sourceEvidence`);
  return {
    id: identity(row.id, `ledgerEntries[${index}].id`),
    accountId: identity(row.accountId, `ledgerEntries[${index}].accountId`),
    kind: enumValue(row.kind, LEDGER_KINDS, `ledgerEntries[${index}].kind`),
    direction: enumValue(row.direction, LEDGER_DIRECTIONS, `ledgerEntries[${index}].direction`),
    amountMinor: integer(row.amountMinor, `ledgerEntries[${index}].amountMinor`, 1),
    currency: row.currency === "JPY" ? "JPY" : fail(`ledgerEntries[${index}].currency`),
    category: stringValue(row.category, `ledgerEntries[${index}].category`),
    memo: stringValue(row.memo, `ledgerEntries[${index}].memo`),
    projectId: nullableString(row.projectId, `ledgerEntries[${index}].projectId`),
    sourceRecordId,
    sourceEventId,
    occurredAt: dateString(row.occurredAt, `ledgerEntries[${index}].occurredAt`),
    idempotencyKey: stringValue(row.idempotencyKey, `ledgerEntries[${index}].idempotencyKey`),
  };
}

function normalizeFinanceGroup(value: unknown, index: number): RealmRuntimeSaveDomainFinanceCommandGroupV1 {
  const row = object(value, `financeCommandGroups[${index}]`);
  keys(row, ["id", "idempotencyKey", "requestFingerprint", "state", "resultManifest", "rejectionCode", "policyVersion", "sourceRecordId"], `financeCommandGroups[${index}]`);
  const state = enumValue(row.state, COMMAND_STATES, `financeCommandGroups[${index}].state`);
  const rejectionCode = nullableString(row.rejectionCode, `financeCommandGroups[${index}].rejectionCode`);
  if ((state === "rejected") !== (rejectionCode !== null)) fail(`financeCommandGroups[${index}].stateShape`);
  const fingerprint = stringValue(row.requestFingerprint, `financeCommandGroups[${index}].requestFingerprint`);
  if (!HASH.test(fingerprint)) fail(`financeCommandGroups[${index}].requestFingerprint`);
  return {
    id: identity(row.id, `financeCommandGroups[${index}].id`),
    idempotencyKey: stringValue(row.idempotencyKey, `financeCommandGroups[${index}].idempotencyKey`),
    requestFingerprint: fingerprint,
    state,
    resultManifest: jsonObject(row.resultManifest, `financeCommandGroups[${index}].resultManifest`),
    rejectionCode,
    policyVersion: stringValue(row.policyVersion, `financeCommandGroups[${index}].policyVersion`),
    sourceRecordId: nullableString(row.sourceRecordId, `financeCommandGroups[${index}].sourceRecordId`),
  };
}

function normalizeObligation(value: unknown, index: number): RealmRuntimeSaveDomainObligationV1 {
  const row = object(value, `obligations[${index}]`);
  keys(row, ["id", "projectId", "kind", "status", "principalMinor", "outstandingMinor", "shareBps", "undeliveredCount", "dueOn", "version"], `obligations[${index}]`);
  const principalMinor = integer(row.principalMinor, `obligations[${index}].principalMinor`);
  const outstandingMinor = integer(row.outstandingMinor, `obligations[${index}].outstandingMinor`);
  if (outstandingMinor > principalMinor) fail(`obligations[${index}].outstandingMinor`);
  const shareBps = row.shareBps === null ? null : integer(row.shareBps, `obligations[${index}].shareBps`);
  const kind = enumValue(row.kind, OBLIGATION_KINDS, `obligations[${index}].kind`);
  if (kind === "revenue_share" ? shareBps === null || shareBps > 10000 : shareBps !== null) fail(`obligations[${index}].shareBps`);
  return {
    id: identity(row.id, `obligations[${index}].id`),
    projectId: nullableString(row.projectId, `obligations[${index}].projectId`),
    kind,
    status: enumValue(row.status, OBLIGATION_STATUSES, `obligations[${index}].status`),
    principalMinor,
    outstandingMinor,
    shareBps,
    undeliveredCount: integer(row.undeliveredCount, `obligations[${index}].undeliveredCount`),
    dueOn: nullableString(row.dueOn, `obligations[${index}].dueOn`),
    version: integer(row.version, `obligations[${index}].version`, 1),
  };
}

function normalizeSettlement(value: unknown, index: number): RealmRuntimeSaveDomainObligationSettlementV1 {
  const row = object(value, `obligationSettlements[${index}]`);
  keys(row, ["id", "obligationId", "ledgerEntryId", "kind", "amountMinor"], `obligationSettlements[${index}]`);
  return {
    id: identity(row.id, `obligationSettlements[${index}].id`),
    obligationId: identity(row.obligationId, `obligationSettlements[${index}].obligationId`),
    ledgerEntryId: nullableString(row.ledgerEntryId, `obligationSettlements[${index}].ledgerEntryId`),
    kind: enumValue(row.kind, SETTLEMENT_KINDS, `obligationSettlements[${index}].kind`),
    amountMinor: integer(row.amountMinor, `obligationSettlements[${index}].amountMinor`, 1),
  };
}

function normalizeNode(value: unknown, index: number): RealmRuntimeSaveDomainStoryNodeV1 {
  const row = object(value, `storyNodes[${index}]`);
  keys(row, ["id", "nodeKey", "state", "revision", "recordId", "definitionHash", "unlockEvidenceEventIds", "unlockEvidence"], `storyNodes[${index}]`);
  const definitionHash = stringValue(row.definitionHash, `storyNodes[${index}].definitionHash`);
  if (!HASH.test(definitionHash)) fail(`storyNodes[${index}].definitionHash`);
  const state = enumValue(row.state, NODE_STATES, `storyNodes[${index}].state`);
  const recordId = nullableString(row.recordId, `storyNodes[${index}].recordId`);
  if ((state === "locked") !== (recordId === null)) fail(`storyNodes[${index}].stateShape`);
  return {
    id: identity(row.id, `storyNodes[${index}].id`),
    nodeKey: stringValue(row.nodeKey, `storyNodes[${index}].nodeKey`),
    state,
    revision: integer(row.revision, `storyNodes[${index}].revision`),
    recordId,
    definitionHash,
    unlockEvidenceEventIds: stringArray(row.unlockEvidenceEventIds, `storyNodes[${index}].unlockEvidenceEventIds`),
    unlockEvidence: jsonObject(row.unlockEvidence, `storyNodes[${index}].unlockEvidence`),
  };
}

function normalizeUnlock(value: unknown, index: number): RealmRuntimeSaveDomainStoryUnlockLedgerV1 {
  const row = object(value, `storyUnlockLedger[${index}]`);
  keys(row, ["id", "storyNodeInstanceId", "nodeKey", "transition", "idempotencyKey", "recordId", "evidenceEventIds", "evidenceHash", "evidence"], `storyUnlockLedger[${index}]`);
  const evidenceHash = stringValue(row.evidenceHash, `storyUnlockLedger[${index}].evidenceHash`);
  if (!HASH.test(evidenceHash)) fail(`storyUnlockLedger[${index}].evidenceHash`);
  return {
    id: identity(row.id, `storyUnlockLedger[${index}].id`),
    storyNodeInstanceId: identity(row.storyNodeInstanceId, `storyUnlockLedger[${index}].storyNodeInstanceId`),
    nodeKey: stringValue(row.nodeKey, `storyUnlockLedger[${index}].nodeKey`),
    transition: enumValue(row.transition, UNLOCK_TRANSITIONS, `storyUnlockLedger[${index}].transition`),
    idempotencyKey: stringValue(row.idempotencyKey, `storyUnlockLedger[${index}].idempotencyKey`),
    recordId: nullableString(row.recordId, `storyUnlockLedger[${index}].recordId`),
    evidenceEventIds: stringArray(row.evidenceEventIds, `storyUnlockLedger[${index}].evidenceEventIds`),
    evidenceHash,
    evidence: jsonObject(row.evidence, `storyUnlockLedger[${index}].evidence`),
  };
}

function normalizeFact(value: unknown, index: number): RealmRuntimeSaveDomainCommittedFactCommandV1 {
  const row = object(value, `committedFactCommands[${index}]`);
  assertFactWitnessTransportSupported(row);
  keys(row, ["id", "idempotencyKey", "requestFingerprint", "kind", "resultManifest"], `committedFactCommands[${index}]`);
  const fingerprint = stringValue(row.requestFingerprint, `committedFactCommands[${index}].requestFingerprint`);
  if (!HASH.test(fingerprint)) fail(`committedFactCommands[${index}].requestFingerprint`);
  return {
    id: identity(row.id, `committedFactCommands[${index}].id`),
    idempotencyKey: stringValue(row.idempotencyKey, `committedFactCommands[${index}].idempotencyKey`),
    requestFingerprint: fingerprint,
    kind: enumValue(row.kind, FACT_KINDS, `committedFactCommands[${index}].kind`),
    resultManifest: jsonObject(row.resultManifest, `committedFactCommands[${index}].resultManifest`),
  };
}

function normalizeAssessment(value: unknown, index: number): RealmRuntimeSaveDomainPerformanceAssessmentV1 {
  const row = object(value, `performanceAssessments[${index}]`);
  keys(row, ["id", "recordId", "policyVersion", "score", "evidenceEventIds", "evidenceSnapshotHash", "commandId"], `performanceAssessments[${index}]`);
  const evidenceSnapshotHash = stringValue(row.evidenceSnapshotHash, `performanceAssessments[${index}].evidenceSnapshotHash`);
  if (!HASH.test(evidenceSnapshotHash)) fail(`performanceAssessments[${index}].evidenceSnapshotHash`);
  return {
    id: identity(row.id, `performanceAssessments[${index}].id`),
    recordId: identity(row.recordId, `performanceAssessments[${index}].recordId`),
    policyVersion: stringValue(row.policyVersion, `performanceAssessments[${index}].policyVersion`),
    score: finiteScore(row.score, `performanceAssessments[${index}].score`),
    evidenceEventIds: stringArray(row.evidenceEventIds, `performanceAssessments[${index}].evidenceEventIds`),
    evidenceSnapshotHash,
    commandId: identity(row.commandId, `performanceAssessments[${index}].commandId`),
  };
}

function normalizeRelationship(value: unknown, index: number): RealmRuntimeSaveDomainMemberRelationshipRevisionV1 {
  const row = object(value, `memberRelationshipRevisions[${index}]`);
  keys(row, ["id", "subjectEntityKey", "objectEntityKey", "relationKind", "revisionOrdinal", "sourceEventId", "sourceRecordId", "occurredTick", "occurredOrdinal", "commandId"], `memberRelationshipRevisions[${index}]`);
  return {
    id: identity(row.id, `memberRelationshipRevisions[${index}].id`),
    subjectEntityKey: stringValue(row.subjectEntityKey, `memberRelationshipRevisions[${index}].subjectEntityKey`),
    objectEntityKey: stringValue(row.objectEntityKey, `memberRelationshipRevisions[${index}].objectEntityKey`),
    relationKind: stringValue(row.relationKind, `memberRelationshipRevisions[${index}].relationKind`),
    revisionOrdinal: integer(row.revisionOrdinal, `memberRelationshipRevisions[${index}].revisionOrdinal`, 1),
    sourceEventId: identity(row.sourceEventId, `memberRelationshipRevisions[${index}].sourceEventId`),
    sourceRecordId: identity(row.sourceRecordId, `memberRelationshipRevisions[${index}].sourceRecordId`),
    occurredTick: integer(row.occurredTick, `memberRelationshipRevisions[${index}].occurredTick`),
    occurredOrdinal: integer(row.occurredOrdinal, `memberRelationshipRevisions[${index}].occurredOrdinal`),
    commandId: identity(row.commandId, `memberRelationshipRevisions[${index}].commandId`),
  };
}

function normalizeAsset(value: unknown, index: number): RealmRuntimeSaveDomainCharacterAssetV1 {
  const row = object(value, `characterAssets[${index}]`);
  keys(row, ["recordId", "characterInstanceId", "assetDefinitionId", "assetKey", "quantity", "revision", "metadata"], `characterAssets[${index}]`);
  return {
    recordId: identity(row.recordId, `characterAssets[${index}].recordId`),
    characterInstanceId: identity(row.characterInstanceId, `characterAssets[${index}].characterInstanceId`),
    assetDefinitionId: identity(row.assetDefinitionId, `characterAssets[${index}].assetDefinitionId`),
    ...(row.assetKey === undefined ? {} : { assetKey: stringValue(row.assetKey, `characterAssets[${index}].assetKey`) }),
    quantity: integer(row.quantity, `characterAssets[${index}].quantity`),
    revision: integer(row.revision, `characterAssets[${index}].revision`),
    metadata: jsonObject(row.metadata, `characterAssets[${index}].metadata`),
  };
}

function rejectBalance(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach(rejectBalance);
    return;
  }
  if (Object.prototype.hasOwnProperty.call(value, "balanceMinor")) fail("balanceMinor");
  Object.values(value).forEach(rejectBalance);
}

function normalizeSingleRecordDomainV1(value: unknown): RealmRuntimeSaveDomainV1 {
  const row = object(value, "domain");
  keys(row, ["commandMaterializations", "format", "schemaVersion", "source", "projects", "milestones", "projectStoryLinks", "budgetAllocations", "financeAccounts", "ledgerEntries", "financeCommandGroups", "obligations", "obligationSettlements", "storyNodes", "storyUnlockLedger", "committedFactCommands", "performanceAssessments", "memberRelationshipRevisions", "characterAssets"], "domain");
  if (row.format !== "realm-runtime-domain" || row.schemaVersion !== 1) fail("domain.format");
  const source = object(row.source, "domain.source");
  keys(source, ["worldId", "worldlineId", "storyId", "recordId"], "domain.source");
  const normalized: RealmRuntimeSaveDomainV1 = {
    ...(Object.hasOwn(row, "commandMaterializations") ? { commandMaterializations: normalizePolicyMap(row.commandMaterializations) } : {}),
    format: "realm-runtime-domain",
    schemaVersion: 1,
    source: {
      worldId: identity(source.worldId, "domain.source.worldId"),
      worldlineId: identity(source.worldlineId, "domain.source.worldlineId"),
      storyId: identity(source.storyId, "domain.source.storyId"),
      recordId: identity(source.recordId, "domain.source.recordId"),
    },
    projects: (Array.isArray(row.projects) ? row.projects : fail("domain.projects")).map(normalizeProject),
    milestones: (Array.isArray(row.milestones) ? row.milestones : fail("domain.milestones")).map(normalizeMilestone),
    projectStoryLinks: (Array.isArray(row.projectStoryLinks) ? row.projectStoryLinks : fail("domain.projectStoryLinks")).map(normalizeLink),
    budgetAllocations: (Array.isArray(row.budgetAllocations) ? row.budgetAllocations : fail("domain.budgetAllocations")).map(normalizeBudget),
    financeAccounts: (Array.isArray(row.financeAccounts) ? row.financeAccounts : fail("domain.financeAccounts")).map(normalizeAccount),
    ledgerEntries: (Array.isArray(row.ledgerEntries) ? row.ledgerEntries : fail("domain.ledgerEntries")).map(normalizeLedger),
    financeCommandGroups: (Array.isArray(row.financeCommandGroups) ? row.financeCommandGroups : fail("domain.financeCommandGroups")).map(normalizeFinanceGroup),
    obligations: (Array.isArray(row.obligations) ? row.obligations : fail("domain.obligations")).map(normalizeObligation),
    obligationSettlements: (Array.isArray(row.obligationSettlements) ? row.obligationSettlements : fail("domain.obligationSettlements")).map(normalizeSettlement),
    storyNodes: (Array.isArray(row.storyNodes) ? row.storyNodes : fail("domain.storyNodes")).map(normalizeNode),
    storyUnlockLedger: (Array.isArray(row.storyUnlockLedger) ? row.storyUnlockLedger : fail("domain.storyUnlockLedger")).map(normalizeUnlock),
    committedFactCommands: (Array.isArray(row.committedFactCommands) ? row.committedFactCommands : fail("domain.committedFactCommands")).map(normalizeFact),
    performanceAssessments: (Array.isArray(row.performanceAssessments) ? row.performanceAssessments : fail("domain.performanceAssessments")).map(normalizeAssessment),
    memberRelationshipRevisions: (Array.isArray(row.memberRelationshipRevisions) ? row.memberRelationshipRevisions : fail("domain.memberRelationshipRevisions")).map(normalizeRelationship),
    characterAssets: (Array.isArray(row.characterAssets) ? row.characterAssets : fail("domain.characterAssets")).map(normalizeAsset),
  };
  rejectBalance(normalized);
  const sourceStoryId = normalized.source.storyId;
  if (normalized.projectStoryLinks.some((link) => link.storyId !== sourceStoryId)) fail("domain.projectStoryLinks.crossStory");
  if (normalized.performanceAssessments.some((assessment) => assessment.recordId !== normalized.source.recordId)) fail("domain.performanceAssessments.crossRecord");
  if (normalized.memberRelationshipRevisions.some((revision) => revision.sourceRecordId !== normalized.source.recordId)) fail("domain.memberRelationshipRevisions.crossRecord");
  validatePolicyMapClosure(normalized);
  return normalized;
}

export function serializeRealmRuntimeSaveDomainV1(value: RealmRuntimeSaveDomainV1): string {
  return JSON.stringify(normalizeRealmRuntimeSaveDomainV1(value));
}

/** Archive-only path: the producer already normalized/validated this domain
 * for closure checks. Do not allocate another normalized graph or full JSON
 * before admission. Standalone serializer/parser contracts remain separate.
 */
export function serializeNormalizedRealmRuntimeSaveDomainV1ForArchive(
  normalized: RealmRuntimeSaveDomainV1,
  ledger: RuntimeSectionWireLedger,
): string {
  ledger.reserve(normalized);
  const text = JSON.stringify(normalized);
  ledger.verify(Buffer.byteLength(text, "utf8"));
  return text;
}

export function parseRealmRuntimeSaveDomainV1(input: string | Uint8Array): RealmRuntimeSaveDomainV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof input === "string" ? input : Buffer.from(input).toString("utf8"));
  } catch {
    throw new RealmRuntimeSaveDomainError("runtime domain save is not valid JSON");
  }
  return normalizeRealmRuntimeSaveDomainV1(parsed);
}

/** The two supported domain wire shapes retain their own validation and serialization. */
export function normalizeRealmRuntimeSaveDomainV1(value: unknown): RealmRuntimeSaveDomainV1 {
  if (value !== null && typeof value === "object" &&
    ["stories", "storyDefinitions", "records", "commandReplayContexts"].some(key => Object.hasOwn(value, key))) {
    return normalizeWholeDomainV1(value);
  }
  return normalizeSingleRecordDomainV1(value);
}

type wholeJsonObject = Readonly<Record<string, JsonValue>>;

type wholeProjectKind = "production" | "campaign" | "operation" | "initiative";
type wholeProjectStatus = "planned" | "active" | "completed" | "cancelled" | "archived";
type wholeProjectStage = "planning" | "funding" | "production" | "scheduled" | "delivery" | "closed";
type wholeMilestoneStatus = "planned" | "active" | "completed" | "cancelled";
type wholeLedgerKind = "income" | "expense" | "adjustment";
type wholeLedgerDirection = "income" | "expense";
type wholeCommandState = "committed" | "rejected";
type wholeObligationKind = "loan" | "presale" | "revenue_share";
type wholeObligationStatus = "open" | "settled" | "cancelled";
type wholeSettlementKind = "repayment" | "draw" | "share";
type wholeStoryNodeState = "locked" | "active" | "completed" | "failed";
type wholeUnlockTransition = "unlocked" | "rolled_back";
type wholeStoryStatus = "draft" | "active" | "completed" | "archived";
type wholeRecordStatus = "draft" | "active" | "closed" | "archived";
type wholeRecordTimelineKind = "primary" | "retrospection" | "merged" | "branch";
type wholeCommandProvenance = "request-result-v1" | "legacy-result-v1";

export interface wholeRealmRuntimeSaveDomainProjectV1 {
  id: string;
  kind: wholeProjectKind;
  status: wholeProjectStatus;
  stage: wholeProjectStage;
  title: string;
  currency: "JPY";
  deadline: string | null;
  version: number;
}

export interface wholeRealmRuntimeSaveDomainMilestoneV1 {
  id: string;
  projectId: string;
  sequence: number;
  title: string;
  status: wholeMilestoneStatus;
  dueOn: string | null;
  completionRecordId: string | null;
  completionEventId: string | null;
}

export interface wholeRealmRuntimeSaveDomainProjectStoryLinkV1 {
  id: string;
  projectId: string;
  storyId: string;
  linkKind: "primary" | "related";
}

export interface wholeRealmRuntimeSaveDomainBudgetAllocationV1 {
  id: string;
  projectId: string;
  category: string;
  amountMinor: number;
  currency: "JPY";
  version: number;
}

export interface wholeRealmRuntimeSaveDomainFinanceAccountV1 {
  id: string;
  currency: "JPY";
  status: "active" | "closed";
  openingBalanceMinor: number;
}

export interface wholeRealmRuntimeSaveDomainLedgerEntryV1 {
  id: string;
  accountId: string;
  kind: wholeLedgerKind;
  direction: wholeLedgerDirection;
  amountMinor: number;
  currency: "JPY";
  category: string;
  memo: string;
  projectId: string | null;
  sourceRecordId: string | null;
  sourceEventId: string | null;
  occurredAt: string;
  idempotencyKey: string;
}

export interface wholeRealmRuntimeSaveDomainFinanceCommandGroupV1 {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  state: wholeCommandState;
  resultManifest: wholeJsonObject;
  rejectionCode: string | null;
  policyVersion: string;
  sourceRecordId: string | null;
  replayLineage?: ArchiveReplayBindingV1;
  /**
   * Replay provenance contract. "request-result-v1" rows persist the
   * canonical fingerprinted request at commit time: the fingerprint covers
   * the source scope and source identities, so a restore must recompute it
   * from this request against the remapped target scope; copying the source
   * hash is not replay provenance. "legacy-result-v1" rows predate request
   * persistence: the original fingerprint stays untouched and the unknown
   * request is never reconstructed. Eligible legacy receipts may carry a
   * typed reverse proof; replay still requires the full original hash.
   */
  provenance: wholeCommandProvenance;
  request: wholeJsonObject | null;
}

export interface wholeRealmRuntimeSaveDomainObligationV1 {
  id: string;
  projectId: string | null;
  kind: wholeObligationKind;
  status: wholeObligationStatus;
  principalMinor: number;
  outstandingMinor: number;
  shareBps: number | null;
  undeliveredCount: number;
  dueOn: string | null;
  version: number;
}

export interface wholeRealmRuntimeSaveDomainObligationSettlementV1 {
  id: string;
  obligationId: string;
  ledgerEntryId: string | null;
  kind: wholeSettlementKind;
  amountMinor: number;
}

export interface wholeRealmRuntimeSaveDomainStoryNodeV1 {
  id: string;
  storyId: string;
  nodeKey: string;
  state: wholeStoryNodeState;
  revision: number;
  recordId: string | null;
  definitionHash: string;
  unlockEvidenceEventIds: readonly string[];
  unlockEvidence: wholeJsonObject;
}

export interface wholeRealmRuntimeSaveDomainStoryUnlockLedgerV1 {
  id: string;
  storyId: string;
  storyNodeInstanceId: string;
  nodeKey: string;
  transition: wholeUnlockTransition;
  idempotencyKey: string;
  recordId: string | null;
  evidenceEventIds: readonly string[];
  evidenceHash: string;
  evidence: wholeJsonObject;
}

export interface wholeRealmRuntimeSaveDomainCommittedFactCommandV1 {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
  kind: "inventory_adjusted" | "inventory_granted" | "relationship_revised" | "performance_assessed";
  resultManifest: wholeJsonObject;
  replayLineage?: ArchiveReplayBindingV1;
  /** Same provenance contract as finance command groups. */
  provenance: wholeCommandProvenance;
  request: wholeJsonObject | null;
}

/** A Story of the saved worldline (the saved Story and every sibling). */
export interface wholeRealmRuntimeSaveDomainStoryV1 {
  id: string;
  title: string;
  status: wholeStoryStatus;
  premise: string;
}

/**
 * Immutable first-known origin of a Story definition binding. This is
 * descriptive provenance carried by the archive — never a signature, an
 * authority grant, or replay proof. On a native materialization it is
 * absent; on the first restore of an archive that predates this field the
 * binding records the immediate source actually known from the archive
 * scope/definition (older history, if any, is lost and never fabricated),
 * and every later save carries it forward literally so a repeated restore
 * never relabels the previous target as the origin.
 */
export interface wholeRealmRuntimeSaveDomainStorySourceBindingV1 {
  workspaceId: string;
  storyId: string;
  definitionHash: string;
}

/**
 * The exact normalized Story Graph definition a Story's node rows were
 * materialized from. Required for every Story that has node rows so a
 * restore can remap its runtime identities (milestone/obligation/Record
 * references inside unlock rules) and bind the target node rows to the
 * remapped definition hash — the original hash would never unlock again.
 */
export interface wholeRealmRuntimeSaveDomainStoryDefinitionV1 {
  storyId: string;
  definitionHash: string;
  definition: wholeJsonObject;
  /**
   * Present exactly when the persisted binding was created by a restore:
   * the immutable first-known source identity. Absent for native
   * materializations and for archives written before this field existed.
   */
  sourceBinding?: wholeRealmRuntimeSaveDomainStorySourceBindingV1;
}

/**
 * A complete sibling Record snapshot of the saved worldline: every Record
 * that owns domain evidence (Story node bindings/unlock evidence, milestone
 * completion, relationship history, assessments, inventory, record-bound
 * finance) is carried with its full event log, topology, goals, and every
 * other persisted section needed to continue it safely — never an
 * evidence-only stub. Visibility policies and audiences are carried
 * verbatim; private/restricted/secret semantics are never downgraded.
 */
export interface wholeRealmRuntimeSaveDomainRecordSnapshotV1 {
  recordId: string;
  storyId: string;
  title: string;
  status: wholeRecordStatus;
  /** records.world_version: the exact World binding the Record was made with. */
  worldVersion: string;
  startTick: number;
  startOrdinal: number;
  timelineKind: wholeRecordTimelineKind;
  linkedRecordId: string | null;
  /** record_heads cursor columns, carried explicitly for continuation. */
  lastEventId: string | null;
  lastWorldTick: number | null;
  lastWorldOrdinal: number | null;
  bundle: RealmRuntimeSaveRecordBundleV1;
}

export interface wholeRealmRuntimeSaveDomainPerformanceAssessmentV1 {
  id: string;
  recordId: string;
  policyVersion: string;
  score: number;
  evidenceEventIds: readonly string[];
  evidenceSnapshotHash: string;
  commandId: string;
}

export interface wholeRealmRuntimeSaveDomainMemberRelationshipRevisionV1 {
  id: string;
  subjectEntityKey: string;
  objectEntityKey: string;
  relationKind: string;
  revisionOrdinal: number;
  sourceEventId: string;
  sourceRecordId: string;
  occurredTick: number;
  occurredOrdinal: number;
  commandId: string;
}

export interface wholeRealmRuntimeSaveDomainCharacterAssetV1 {
  recordId: string;
  characterInstanceId: string;
  assetDefinitionId: string;
  /**
   * Stable definition identity (asset_definitions.asset_key) used to resolve
   * the definition inside the restore target World; the row id is per-World
   * suffixed and cannot be reused across Worlds. Optional so archives written
   * before this field existed still parse; restores then fall back to a
   * direct id lookup that only succeeds for same-World targets.
   */
  assetKey?: string;
  /**
   * Owning rule pack. Only the engine-owned base pack may be materialized
   * into the target World on demand during restore; every other pack must
   * already be installed with the target World.
   */
  rulePackKey?: string;
  quantity: number;
  revision: number;
  metadata: wholeJsonObject;
}

export interface RealmRuntimeSaveWholeDomainV1 {
  commandMaterializations?: CommandMaterializations;
  format: "realm-runtime-domain";
  schemaVersion: 1;
  source: {
    worldId: string;
    worldlineId: string;
    storyId: string;
    recordId: string;
  };
  stories: readonly wholeRealmRuntimeSaveDomainStoryV1[];
  storyDefinitions: readonly wholeRealmRuntimeSaveDomainStoryDefinitionV1[];
  records: readonly wholeRealmRuntimeSaveDomainRecordSnapshotV1[];
  projects: readonly wholeRealmRuntimeSaveDomainProjectV1[];
  milestones: readonly wholeRealmRuntimeSaveDomainMilestoneV1[];
  projectStoryLinks: readonly wholeRealmRuntimeSaveDomainProjectStoryLinkV1[];
  budgetAllocations: readonly wholeRealmRuntimeSaveDomainBudgetAllocationV1[];
  financeAccounts: readonly wholeRealmRuntimeSaveDomainFinanceAccountV1[];
  ledgerEntries: readonly wholeRealmRuntimeSaveDomainLedgerEntryV1[];
  financeCommandGroups: readonly wholeRealmRuntimeSaveDomainFinanceCommandGroupV1[];
  obligations: readonly wholeRealmRuntimeSaveDomainObligationV1[];
  obligationSettlements: readonly wholeRealmRuntimeSaveDomainObligationSettlementV1[];
  storyNodes: readonly wholeRealmRuntimeSaveDomainStoryNodeV1[];
  storyUnlockLedger: readonly wholeRealmRuntimeSaveDomainStoryUnlockLedgerV1[];
  commandReplayContexts?: readonly ReplayContextV1[];
  committedFactCommands: readonly wholeRealmRuntimeSaveDomainCommittedFactCommandV1[];
  performanceAssessments: readonly wholeRealmRuntimeSaveDomainPerformanceAssessmentV1[];
  memberRelationshipRevisions: readonly wholeRealmRuntimeSaveDomainMemberRelationshipRevisionV1[];
  characterAssets: readonly wholeRealmRuntimeSaveDomainCharacterAssetV1[];
}

const wholePROJECT_KINDS = new Set<wholeProjectKind>(["production", "campaign", "operation", "initiative"]);
const wholePROJECT_STATUSES = new Set<wholeProjectStatus>(["planned", "active", "completed", "cancelled", "archived"]);
const wholePROJECT_STAGES = new Set<wholeProjectStage>(["planning", "funding", "production", "scheduled", "delivery", "closed"]);
const wholeMILESTONE_STATUSES = new Set<wholeMilestoneStatus>(["planned", "active", "completed", "cancelled"]);
const wholeLEDGER_KINDS = new Set<wholeLedgerKind>(["income", "expense", "adjustment"]);
const wholeLEDGER_DIRECTIONS = new Set<wholeLedgerDirection>(["income", "expense"]);
const wholeCOMMAND_STATES = new Set<wholeCommandState>(["committed", "rejected"]);
const wholeOBLIGATION_KINDS = new Set<wholeObligationKind>(["loan", "presale", "revenue_share"]);
const wholeOBLIGATION_STATUSES = new Set<wholeObligationStatus>(["open", "settled", "cancelled"]);
const wholeSETTLEMENT_KINDS = new Set<wholeSettlementKind>(["repayment", "draw", "share"]);
const wholeNODE_STATES = new Set<wholeStoryNodeState>(["locked", "active", "completed", "failed"]);
const wholeUNLOCK_TRANSITIONS = new Set<wholeUnlockTransition>(["unlocked", "rolled_back"]);
const wholeFACT_KINDS = new Set<wholeRealmRuntimeSaveDomainCommittedFactCommandV1["kind"]>(["inventory_adjusted", "inventory_granted", "relationship_revised", "performance_assessed"]);
const wholeSTORY_STATUSES = new Set<wholeStoryStatus>(["draft", "active", "completed", "archived"]);
const wholeRECORD_STATUSES = new Set<wholeRecordStatus>(["draft", "active", "closed", "archived"]);
const wholeRECORD_TIMELINE_KINDS = new Set<wholeRecordTimelineKind>(["primary", "retrospection", "merged", "branch"]);
const wholeCOMMAND_PROVENANCES = new Set<wholeCommandProvenance>(["request-result-v1", "legacy-result-v1"]);
const wholeIDENTITY = /^[A-Za-z0-9._:-]+$/;
const wholeHASH = /^[0-9a-f]{64}$/;

function wholefail(field: string): never {
  throw new RealmRuntimeSaveDomainError(`runtime domain save ${field} is invalid`);
}

function wholeobject(value: unknown, field: string): wholeJsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) wholefail(field);
  return value as wholeJsonObject;
}

function wholekeys(
  value: wholeJsonObject,
  allowed: readonly string[],
  field: string,
  optional: readonly string[] = [],
): void {
  const accepted = new Set([...allowed, ...optional]);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) wholefail(field);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !accepted.has(key) || !descriptor.enumerable || !("value" in descriptor)) wholefail(`${field}.unknownKey`);
  }
}

function wholestringValue(value: unknown, field: string, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.length === 0)) wholefail(field);
  return value;
}

const wholeMAX_IDENTITY_LENGTH = 256;
const wholeMAX_JSON_DEPTH = 32;
/** Keys that must never be materialized onto a fresh object. */
const wholeUNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function wholeidentity(value: unknown, field: string): string {
  const result = wholestringValue(value, field);
  if (result.length > wholeMAX_IDENTITY_LENGTH || !wholeIDENTITY.test(result) || result === "." || result === "..") wholefail(field);
  return result;
}

function wholenullableString(value: unknown, field: string): string | null {
  return value === null ? null : wholestringValue(value, field, false);
}

function wholeinteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) wholefail(field);
  return value as number;
}

function wholefiniteScore(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < -1_000_000 || (value as number) > 1_000_000) wholefail(field);
  return value as number;
}

function wholejsonValue(value: unknown, field: string, depth = 0): JsonValue {
  if (depth > wholeMAX_JSON_DEPTH) wholefail(field);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 16_384) wholefail(field);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) wholefail(field);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) wholefail(field);
    return value.map((item, index) => wholejsonValue(item, `${field}[${index}]`, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (wholeUNSAFE_KEYS.has(key)) wholefail(`${field}.${key}`);
      result[key] = wholejsonValue(item, `${field}.${key}`, depth + 1);
    }
    return result;
  }
  wholefail(field);
}

function wholejsonObject(value: unknown, field: string): wholeJsonObject {
  const normalized = wholejsonValue(value, field);
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) wholefail(field);
  return normalized as wholeJsonObject;
}

function wholestringArray(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) wholefail(field);
  return value.map((item, index) => wholestringValue(item, `${field}[${index}]`));
}

function wholeenumValue<T extends string>(value: unknown, set: ReadonlySet<T>, field: string): T {
  if (typeof value !== "string" || !set.has(value as T)) wholefail(field);
  return value as T;
}

function wholedateString(value: unknown, field: string): string {
  const result = wholestringValue(value, field);
  if (Number.isNaN(new Date(result).getTime())) wholefail(field);
  return new Date(result).toISOString();
}

function wholenormalizeProject(value: unknown, index: number): wholeRealmRuntimeSaveDomainProjectV1 {
  const row = wholeobject(value, `projects[${index}]`);
  wholekeys(row, ["id", "kind", "status", "stage", "title", "currency", "deadline", "version"], `projects[${index}]`);
  return {
    id: wholeidentity(row.id, `projects[${index}].id`),
    kind: wholeenumValue(row.kind, wholePROJECT_KINDS, `projects[${index}].kind`),
    status: wholeenumValue(row.status, wholePROJECT_STATUSES, `projects[${index}].status`),
    stage: wholeenumValue(row.stage, wholePROJECT_STAGES, `projects[${index}].stage`),
    title: wholestringValue(row.title, `projects[${index}].title`),
    currency: row.currency === "JPY" ? "JPY" : wholefail(`projects[${index}].currency`),
    deadline: wholenullableString(row.deadline, `projects[${index}].deadline`),
    version: wholeinteger(row.version, `projects[${index}].version`, 1),
  };
}

function wholenormalizeMilestone(value: unknown, index: number): wholeRealmRuntimeSaveDomainMilestoneV1 {
  const row = wholeobject(value, `milestones[${index}]`);
  wholekeys(row, ["id", "projectId", "sequence", "title", "status", "dueOn", "completionRecordId", "completionEventId"], `milestones[${index}]`);
  const completionRecordId = wholenullableString(row.completionRecordId, `milestones[${index}].completionRecordId`);
  const completionEventId = wholenullableString(row.completionEventId, `milestones[${index}].completionEventId`);
  if ((completionRecordId === null) !== (completionEventId === null)) wholefail(`milestones[${index}].completionEvidence`);
  return {
    id: wholeidentity(row.id, `milestones[${index}].id`),
    projectId: wholeidentity(row.projectId, `milestones[${index}].projectId`),
    sequence: wholeinteger(row.sequence, `milestones[${index}].sequence`, 1),
    title: wholestringValue(row.title, `milestones[${index}].title`),
    status: wholeenumValue(row.status, wholeMILESTONE_STATUSES, `milestones[${index}].status`),
    dueOn: wholenullableString(row.dueOn, `milestones[${index}].dueOn`),
    completionRecordId,
    completionEventId,
  };
}

function wholenormalizeLink(value: unknown, index: number): wholeRealmRuntimeSaveDomainProjectStoryLinkV1 {
  const row = wholeobject(value, `projectStoryLinks[${index}]`);
  wholekeys(row, ["id", "projectId", "storyId", "linkKind"], `projectStoryLinks[${index}]`);
  return {
    id: wholeidentity(row.id, `projectStoryLinks[${index}].id`),
    projectId: wholeidentity(row.projectId, `projectStoryLinks[${index}].projectId`),
    storyId: wholeidentity(row.storyId, `projectStoryLinks[${index}].storyId`),
    linkKind: row.linkKind === "primary" || row.linkKind === "related" ? row.linkKind : wholefail(`projectStoryLinks[${index}].linkKind`),
  };
}

function wholenormalizeBudget(value: unknown, index: number): wholeRealmRuntimeSaveDomainBudgetAllocationV1 {
  const row = wholeobject(value, `budgetAllocations[${index}]`);
  wholekeys(row, ["id", "projectId", "category", "amountMinor", "currency", "version"], `budgetAllocations[${index}]`);
  return {
    id: wholeidentity(row.id, `budgetAllocations[${index}].id`),
    projectId: wholeidentity(row.projectId, `budgetAllocations[${index}].projectId`),
    category: wholestringValue(row.category, `budgetAllocations[${index}].category`),
    amountMinor: wholeinteger(row.amountMinor, `budgetAllocations[${index}].amountMinor`, 1),
    currency: row.currency === "JPY" ? "JPY" : wholefail(`budgetAllocations[${index}].currency`),
    version: wholeinteger(row.version, `budgetAllocations[${index}].version`, 1),
  };
}

function wholenormalizeAccount(value: unknown, index: number): wholeRealmRuntimeSaveDomainFinanceAccountV1 {
  const row = wholeobject(value, `financeAccounts[${index}]`);
  wholekeys(row, ["id", "currency", "status", "openingBalanceMinor"], `financeAccounts[${index}]`);
  return {
    id: wholeidentity(row.id, `financeAccounts[${index}].id`),
    currency: row.currency === "JPY" ? "JPY" : wholefail(`financeAccounts[${index}].currency`),
    status: row.status === "active" || row.status === "closed" ? row.status : wholefail(`financeAccounts[${index}].status`),
    openingBalanceMinor: wholeinteger(row.openingBalanceMinor, `financeAccounts[${index}].openingBalanceMinor`),
  };
}

function wholenormalizeLedger(value: unknown, index: number): wholeRealmRuntimeSaveDomainLedgerEntryV1 {
  const row = wholeobject(value, `ledgerEntries[${index}]`);
  wholekeys(row, ["id", "accountId", "kind", "direction", "amountMinor", "currency", "category", "memo", "projectId", "sourceRecordId", "sourceEventId", "occurredAt", "idempotencyKey"], `ledgerEntries[${index}]`);
  const sourceRecordId = wholenullableString(row.sourceRecordId, `ledgerEntries[${index}].sourceRecordId`);
  const sourceEventId = wholenullableString(row.sourceEventId, `ledgerEntries[${index}].sourceEventId`);
  if (sourceEventId !== null && sourceRecordId === null) wholefail(`ledgerEntries[${index}].sourceEvidence`);
  return {
    id: wholeidentity(row.id, `ledgerEntries[${index}].id`),
    accountId: wholeidentity(row.accountId, `ledgerEntries[${index}].accountId`),
    kind: wholeenumValue(row.kind, wholeLEDGER_KINDS, `ledgerEntries[${index}].kind`),
    direction: wholeenumValue(row.direction, wholeLEDGER_DIRECTIONS, `ledgerEntries[${index}].direction`),
    amountMinor: wholeinteger(row.amountMinor, `ledgerEntries[${index}].amountMinor`, 1),
    currency: row.currency === "JPY" ? "JPY" : wholefail(`ledgerEntries[${index}].currency`),
    category: wholestringValue(row.category, `ledgerEntries[${index}].category`),
    memo: wholestringValue(row.memo, `ledgerEntries[${index}].memo`),
    projectId: wholenullableString(row.projectId, `ledgerEntries[${index}].projectId`),
    sourceRecordId,
    sourceEventId,
    occurredAt: wholedateString(row.occurredAt, `ledgerEntries[${index}].occurredAt`),
    idempotencyKey: wholestringValue(row.idempotencyKey, `ledgerEntries[${index}].idempotencyKey`),
  };
}

/** Shared provenance normalization for persisted command receipts. */
function wholenormalizeCommandProvenance(
  row: wholeJsonObject,
  field: string,
): { provenance: wholeCommandProvenance; resultManifest: wholeJsonObject; request: wholeJsonObject | null } {
  const provenance = wholeenumValue(row.provenance, wholeCOMMAND_PROVENANCES, `${field}.provenance`);
  const resultManifest = wholejsonObject(row.resultManifest, `${field}.resultManifest`);
  if (provenance === "request-result-v1") {
    return { provenance, resultManifest, request: wholejsonObject(row.request, `${field}.request`) };
  }
  // legacy-result-v1: a pre-provenance bare result manifest. The original
  // request is unknown and must never be guessed or backfilled.
  if (row.request !== null) wholefail(`${field}.request`);
  return { provenance, resultManifest, request: null };
}

function wholenormalizeFinanceGroup(value: unknown, index: number): wholeRealmRuntimeSaveDomainFinanceCommandGroupV1 {
  const row = wholeobject(value, `financeCommandGroups[${index}]`);
  wholekeys(row, ["id", "idempotencyKey", "requestFingerprint", "state", "resultManifest", "rejectionCode", "policyVersion", "sourceRecordId", "provenance", "request"], `financeCommandGroups[${index}]`, ["replayLineage"]);
  const state = wholeenumValue(row.state, wholeCOMMAND_STATES, `financeCommandGroups[${index}].state`);
  const rejectionCode = wholenullableString(row.rejectionCode, `financeCommandGroups[${index}].rejectionCode`);
  if ((state === "rejected") !== (rejectionCode !== null)) wholefail(`financeCommandGroups[${index}].stateShape`);
  const fingerprint = wholestringValue(row.requestFingerprint, `financeCommandGroups[${index}].requestFingerprint`);
  if (!wholeHASH.test(fingerprint)) wholefail(`financeCommandGroups[${index}].requestFingerprint`);
  const provenance = wholenormalizeCommandProvenance(row, `financeCommandGroups[${index}]`);
  const policyVersion = wholestringValue(row.policyVersion, `financeCommandGroups[${index}].policyVersion`);
  let replayLineage: ArchiveReplayBindingV1 | undefined;
  if (Object.hasOwn(row, "replayLineage")) {
    try { replayLineage = decodeReplayBinding(row.replayLineage); } catch { wholefail("finance.replayLineage"); }
    if (state !== "committed" || policyVersion !== "project-finance-command.v1"
      || provenance.provenance !== "legacy-result-v1" || provenance.request !== null
      || provenance.resultManifest.commandGroupId !== row.id) wholefail("finance.replayLineage.eligibility");
  }
  return {
    ...(replayLineage ? { replayLineage } : {}),
    id: wholeidentity(row.id, `financeCommandGroups[${index}].id`),
    idempotencyKey: wholestringValue(row.idempotencyKey, `financeCommandGroups[${index}].idempotencyKey`),
    requestFingerprint: fingerprint,
    state,
    resultManifest: provenance.resultManifest,
    rejectionCode,
    policyVersion,
    sourceRecordId: wholenullableString(row.sourceRecordId, `financeCommandGroups[${index}].sourceRecordId`),
    provenance: provenance.provenance,
    request: provenance.request,
  };
}

function wholenormalizeObligation(value: unknown, index: number): wholeRealmRuntimeSaveDomainObligationV1 {
  const row = wholeobject(value, `obligations[${index}]`);
  wholekeys(row, ["id", "projectId", "kind", "status", "principalMinor", "outstandingMinor", "shareBps", "undeliveredCount", "dueOn", "version"], `obligations[${index}]`);
  const principalMinor = wholeinteger(row.principalMinor, `obligations[${index}].principalMinor`);
  const outstandingMinor = wholeinteger(row.outstandingMinor, `obligations[${index}].outstandingMinor`);
  if (outstandingMinor > principalMinor) wholefail(`obligations[${index}].outstandingMinor`);
  const shareBps = row.shareBps === null ? null : wholeinteger(row.shareBps, `obligations[${index}].shareBps`);
  const kind = wholeenumValue(row.kind, wholeOBLIGATION_KINDS, `obligations[${index}].kind`);
  if (kind === "revenue_share" ? shareBps === null || shareBps > 10000 : shareBps !== null) wholefail(`obligations[${index}].shareBps`);
  return {
    id: wholeidentity(row.id, `obligations[${index}].id`),
    projectId: wholenullableString(row.projectId, `obligations[${index}].projectId`),
    kind,
    status: wholeenumValue(row.status, wholeOBLIGATION_STATUSES, `obligations[${index}].status`),
    principalMinor,
    outstandingMinor,
    shareBps,
    undeliveredCount: wholeinteger(row.undeliveredCount, `obligations[${index}].undeliveredCount`),
    dueOn: wholenullableString(row.dueOn, `obligations[${index}].dueOn`),
    version: wholeinteger(row.version, `obligations[${index}].version`, 1),
  };
}

function wholenormalizeSettlement(value: unknown, index: number): wholeRealmRuntimeSaveDomainObligationSettlementV1 {
  const row = wholeobject(value, `obligationSettlements[${index}]`);
  wholekeys(row, ["id", "obligationId", "ledgerEntryId", "kind", "amountMinor"], `obligationSettlements[${index}]`);
  return {
    id: wholeidentity(row.id, `obligationSettlements[${index}].id`),
    obligationId: wholeidentity(row.obligationId, `obligationSettlements[${index}].obligationId`),
    ledgerEntryId: wholenullableString(row.ledgerEntryId, `obligationSettlements[${index}].ledgerEntryId`),
    kind: wholeenumValue(row.kind, wholeSETTLEMENT_KINDS, `obligationSettlements[${index}].kind`),
    amountMinor: wholeinteger(row.amountMinor, `obligationSettlements[${index}].amountMinor`, 1),
  };
}

function wholenormalizeNode(value: unknown, index: number): wholeRealmRuntimeSaveDomainStoryNodeV1 {
  const row = wholeobject(value, `storyNodes[${index}]`);
  wholekeys(row, ["id", "storyId", "nodeKey", "state", "revision", "recordId", "definitionHash", "unlockEvidenceEventIds", "unlockEvidence"], `storyNodes[${index}]`);
  const definitionHash = wholestringValue(row.definitionHash, `storyNodes[${index}].definitionHash`);
  if (!wholeHASH.test(definitionHash)) wholefail(`storyNodes[${index}].definitionHash`);
  const state = wholeenumValue(row.state, wholeNODE_STATES, `storyNodes[${index}].state`);
  const recordId = wholenullableString(row.recordId, `storyNodes[${index}].recordId`);
  if ((state === "locked") !== (recordId === null)) wholefail(`storyNodes[${index}].stateShape`);
  const unlockEvidenceEventIds = wholestringArray(row.unlockEvidenceEventIds, `storyNodes[${index}].unlockEvidenceEventIds`);
  const unlockEvidence = wholejsonObject(row.unlockEvidence, `storyNodes[${index}].unlockEvidence`);
  // State-aware evidence contract (mirrors story-graph-repository):
  // a locked node has never unlocked, so it carries exactly `{}` and no
  // evidence event ids — evidence must never be invented for it; every
  // other state carries the full typed unlock evidence snapshot.
  if (state === "locked") {
    if (unlockEvidenceEventIds.length > 0 || Object.keys(unlockEvidence).length > 0) {
      wholefail(`storyNodes[${index}].unlockEvidence`);
    }
  } else {
    wholevalidateUnlockEvidenceShape(unlockEvidence, `storyNodes[${index}].unlockEvidence`);
    for (const eventId of unlockEvidenceEventIds) wholeidentity(eventId, `storyNodes[${index}].unlockEvidenceEventIds[]`);
  }
  return {
    id: wholeidentity(row.id, `storyNodes[${index}].id`),
    storyId: wholeidentity(row.storyId, `storyNodes[${index}].storyId`),
    nodeKey: wholestringValue(row.nodeKey, `storyNodes[${index}].nodeKey`),
    state,
    revision: wholeinteger(row.revision, `storyNodes[${index}].revision`),
    recordId,
    definitionHash,
    unlockEvidenceEventIds,
    unlockEvidence,
  };
}

/** Typed shape of a Story unlock evidence snapshot for a non-locked node. */
function wholevalidateUnlockEvidenceShape(value: wholeJsonObject, field: string): void {
  wholekeys(value, ["eventIds", "goalKeys", "nodeKeys"], field, ["milestoneIds", "obligationIds"]);
  for (const key of ["eventIds", "goalKeys", "nodeKeys"] as const) {
    if (!(key in value)) wholefail(field);
    wholestringArray(value[key], `${field}.${key}`);
  }
  for (const key of ["milestoneIds", "obligationIds"] as const) {
    if (key in value && value[key] !== undefined) wholestringArray(value[key], `${field}.${key}`);
  }
}

function wholenormalizeUnlock(value: unknown, index: number): wholeRealmRuntimeSaveDomainStoryUnlockLedgerV1 {
  const row = wholeobject(value, `storyUnlockLedger[${index}]`);
  wholekeys(row, ["id", "storyId", "storyNodeInstanceId", "nodeKey", "transition", "idempotencyKey", "recordId", "evidenceEventIds", "evidenceHash", "evidence"], `storyUnlockLedger[${index}]`);
  const evidenceHash = wholestringValue(row.evidenceHash, `storyUnlockLedger[${index}].evidenceHash`);
  if (!wholeHASH.test(evidenceHash)) wholefail(`storyUnlockLedger[${index}].evidenceHash`);
  // A ledger row is an actual unlock/rollback transition: it always carries
  // the full typed evidence snapshot (never the locked-node empty object).
  wholevalidateUnlockEvidenceShape(wholejsonObject(row.evidence, `storyUnlockLedger[${index}].evidence`), `storyUnlockLedger[${index}].evidence`);
  return {
    id: wholeidentity(row.id, `storyUnlockLedger[${index}].id`),
    storyId: wholeidentity(row.storyId, `storyUnlockLedger[${index}].storyId`),
    storyNodeInstanceId: wholeidentity(row.storyNodeInstanceId, `storyUnlockLedger[${index}].storyNodeInstanceId`),
    nodeKey: wholestringValue(row.nodeKey, `storyUnlockLedger[${index}].nodeKey`),
    transition: wholeenumValue(row.transition, wholeUNLOCK_TRANSITIONS, `storyUnlockLedger[${index}].transition`),
    idempotencyKey: wholestringValue(row.idempotencyKey, `storyUnlockLedger[${index}].idempotencyKey`),
    recordId: wholenullableString(row.recordId, `storyUnlockLedger[${index}].recordId`),
    evidenceEventIds: wholestringArray(row.evidenceEventIds, `storyUnlockLedger[${index}].evidenceEventIds`),
    evidenceHash,
    evidence: wholejsonObject(row.evidence, `storyUnlockLedger[${index}].evidence`),
  };
}

function wholedecodeFactBinding(value: unknown): ArchiveReplayBindingV1 {
  try { return decodeReplayBinding(value); } catch { return wholefail("fact.replayLineage"); }
}

function assertFactWitnessTransportSupported(row: Readonly<Record<string, unknown>>): void {
  const result = Object.getOwnPropertyDescriptor(row, "resultManifest")?.value;
  if (Object.hasOwn(row, "performanceWitness")
    || (result !== null && typeof result === "object" && Object.hasOwn(result, "performanceWitness"))) {
    throw new RealmRuntimeSaveDomainError("Runtime domain performance witness transport is unsupported.");
  }
}

function wholenormalizeFact(value: unknown, index: number): wholeRealmRuntimeSaveDomainCommittedFactCommandV1 {
  const row = wholeobject(value, `committedFactCommands[${index}]`);
  assertFactWitnessTransportSupported(row);
  wholekeys(row, ["id", "idempotencyKey", "requestFingerprint", "kind", "resultManifest", "provenance", "request"], `committedFactCommands[${index}]`, ["replayLineage"]);
  const fingerprint = wholestringValue(row.requestFingerprint, `committedFactCommands[${index}].requestFingerprint`);
  if (!wholeHASH.test(fingerprint)) wholefail(`committedFactCommands[${index}].requestFingerprint`);
  const provenance = wholenormalizeCommandProvenance(row, `committedFactCommands[${index}]`);
  return {
    ...(Object.hasOwn(row, "replayLineage") ? { replayLineage: wholedecodeFactBinding(row.replayLineage) } : {}),
    id: wholeidentity(row.id, `committedFactCommands[${index}].id`),
    idempotencyKey: wholestringValue(row.idempotencyKey, `committedFactCommands[${index}].idempotencyKey`),
    requestFingerprint: fingerprint,
    kind: wholeenumValue(row.kind, wholeFACT_KINDS, `committedFactCommands[${index}].kind`),
    resultManifest: provenance.resultManifest,
    provenance: provenance.provenance,
    request: provenance.request,
  };
}

function wholenormalizeAssessment(value: unknown, index: number): wholeRealmRuntimeSaveDomainPerformanceAssessmentV1 {
  const row = wholeobject(value, `performanceAssessments[${index}]`);
  wholekeys(row, ["id", "recordId", "policyVersion", "score", "evidenceEventIds", "evidenceSnapshotHash", "commandId"], `performanceAssessments[${index}]`);
  const evidenceSnapshotHash = wholestringValue(row.evidenceSnapshotHash, `performanceAssessments[${index}].evidenceSnapshotHash`);
  if (!wholeHASH.test(evidenceSnapshotHash)) wholefail(`performanceAssessments[${index}].evidenceSnapshotHash`);
  return {
    id: wholeidentity(row.id, `performanceAssessments[${index}].id`),
    recordId: wholeidentity(row.recordId, `performanceAssessments[${index}].recordId`),
    policyVersion: wholestringValue(row.policyVersion, `performanceAssessments[${index}].policyVersion`),
    score: wholefiniteScore(row.score, `performanceAssessments[${index}].score`),
    evidenceEventIds: wholestringArray(row.evidenceEventIds, `performanceAssessments[${index}].evidenceEventIds`),
    evidenceSnapshotHash,
    commandId: wholeidentity(row.commandId, `performanceAssessments[${index}].commandId`),
  };
}

function wholenormalizeRelationship(value: unknown, index: number): wholeRealmRuntimeSaveDomainMemberRelationshipRevisionV1 {
  const row = wholeobject(value, `memberRelationshipRevisions[${index}]`);
  wholekeys(row, ["id", "subjectEntityKey", "objectEntityKey", "relationKind", "revisionOrdinal", "sourceEventId", "sourceRecordId", "occurredTick", "occurredOrdinal", "commandId"], `memberRelationshipRevisions[${index}]`);
  return {
    id: wholeidentity(row.id, `memberRelationshipRevisions[${index}].id`),
    subjectEntityKey: wholestringValue(row.subjectEntityKey, `memberRelationshipRevisions[${index}].subjectEntityKey`),
    objectEntityKey: wholestringValue(row.objectEntityKey, `memberRelationshipRevisions[${index}].objectEntityKey`),
    relationKind: wholestringValue(row.relationKind, `memberRelationshipRevisions[${index}].relationKind`),
    revisionOrdinal: wholeinteger(row.revisionOrdinal, `memberRelationshipRevisions[${index}].revisionOrdinal`, 1),
    sourceEventId: wholeidentity(row.sourceEventId, `memberRelationshipRevisions[${index}].sourceEventId`),
    sourceRecordId: wholeidentity(row.sourceRecordId, `memberRelationshipRevisions[${index}].sourceRecordId`),
    occurredTick: wholeinteger(row.occurredTick, `memberRelationshipRevisions[${index}].occurredTick`),
    occurredOrdinal: wholeinteger(row.occurredOrdinal, `memberRelationshipRevisions[${index}].occurredOrdinal`),
    commandId: wholeidentity(row.commandId, `memberRelationshipRevisions[${index}].commandId`),
  };
}

function wholenormalizeAsset(value: unknown, index: number): wholeRealmRuntimeSaveDomainCharacterAssetV1 {
  const row = wholeobject(value, `characterAssets[${index}]`);
  wholekeys(
    row,
    ["recordId", "characterInstanceId", "assetDefinitionId", "quantity", "revision", "metadata"],
    `characterAssets[${index}]`,
    ["assetKey", "rulePackKey"],
  );
  return {
    recordId: wholeidentity(row.recordId, `characterAssets[${index}].recordId`),
    characterInstanceId: wholeidentity(row.characterInstanceId, `characterAssets[${index}].characterInstanceId`),
    assetDefinitionId: wholeidentity(row.assetDefinitionId, `characterAssets[${index}].assetDefinitionId`),
    ...(row.assetKey === undefined
      ? {}
      : { assetKey: wholeidentity(row.assetKey, `characterAssets[${index}].assetKey`) }),
    ...(row.rulePackKey === undefined
      ? {}
      : { rulePackKey: wholeidentity(row.rulePackKey, `characterAssets[${index}].rulePackKey`) }),
    quantity: wholeinteger(row.quantity, `characterAssets[${index}].quantity`),
    revision: wholeinteger(row.revision, `characterAssets[${index}].revision`),
    metadata: wholejsonObject(row.metadata, `characterAssets[${index}].metadata`),
  };
}

function wholenormalizeStory(value: unknown, index: number): wholeRealmRuntimeSaveDomainStoryV1 {
  const row = wholeobject(value, `stories[${index}]`);
  wholekeys(row, ["id", "title", "status", "premise"], `stories[${index}]`);
  return {
    id: wholeidentity(row.id, `stories[${index}].id`),
    title: wholestringValue(row.title, `stories[${index}].title`),
    status: wholeenumValue(row.status, wholeSTORY_STATUSES, `stories[${index}].status`),
    premise: wholestringValue(row.premise, `stories[${index}].premise`, false),
  };
}

function wholenormalizeStorySourceBinding(
  value: unknown,
  field: string,
): wholeRealmRuntimeSaveDomainStorySourceBindingV1 {
  const row = wholeobject(value, field);
  wholekeys(row, ["workspaceId", "storyId", "definitionHash"], field);
  const definitionHash = wholestringValue(row.definitionHash, `${field}.definitionHash`);
  if (!wholeHASH.test(definitionHash)) wholefail(`${field}.definitionHash`);
  return {
    workspaceId: wholeidentity(row.workspaceId, `${field}.workspaceId`),
    storyId: wholeidentity(row.storyId, `${field}.storyId`),
    definitionHash,
  };
}

function wholenormalizeStoryDefinition(value: unknown, index: number): wholeRealmRuntimeSaveDomainStoryDefinitionV1 {
  const row = wholeobject(value, `storyDefinitions[${index}]`);
  wholekeys(row, ["storyId", "definitionHash", "definition"], `storyDefinitions[${index}]`, ["sourceBinding"]);
  const definitionHash = wholestringValue(row.definitionHash, `storyDefinitions[${index}].definitionHash`);
  if (!wholeHASH.test(definitionHash)) wholefail(`storyDefinitions[${index}].definitionHash`);
  return {
    storyId: wholeidentity(row.storyId, `storyDefinitions[${index}].storyId`),
    definitionHash,
    definition: wholejsonObject(row.definition, `storyDefinitions[${index}].definition`),
    ...(row.sourceBinding === undefined
      ? {}
      : {
          sourceBinding: wholenormalizeStorySourceBinding(
            row.sourceBinding,
            `storyDefinitions[${index}].sourceBinding`,
          ),
        }),
  };
}

function wholenormalizeRecordSnapshot(
  value: unknown,
  index: number,
  source: { worldId: string; worldlineId: string },
): wholeRealmRuntimeSaveDomainRecordSnapshotV1 {
  const field = `records[${index}]`;
  const row = wholeobject(value, field);
  wholekeys(
    row,
    ["recordId", "storyId", "title", "status", "worldVersion", "startTick", "startOrdinal", "timelineKind", "linkedRecordId", "lastEventId", "lastWorldTick", "lastWorldOrdinal", "bundle"],
    field,
  );
  const recordId = wholeidentity(row.recordId, `${field}.recordId`);
  const lastEventId = row.lastEventId === null ? null : wholeidentity(row.lastEventId, `${field}.lastEventId`);
  const lastWorldTick = row.lastWorldTick === null ? null : wholeinteger(row.lastWorldTick, `${field}.lastWorldTick`);
  const lastWorldOrdinal = row.lastWorldOrdinal === null ? null : wholeinteger(row.lastWorldOrdinal, `${field}.lastWorldOrdinal`);
  // record_heads may carry a worldline-join world cursor with no committed
  // event yet (last_event_id NULL), so only the cursor pair itself must agree.
  if ((lastWorldTick === null) !== (lastWorldOrdinal === null)) wholefail(`${field}.lastWorldCursor`);
  // The sibling bundle runs through the same production section validators
  // as the archive entries, scoped to this Record's declared identity.
  let bundle: RealmRuntimeSaveRecordBundleV1;
  try {
    bundle = validateRealmRuntimeSaveRecordBundle(row.bundle, {
      worldId: source.worldId,
      worldlineId: source.worldlineId,
      recordId,
    });
  } catch (error) {
    if (error instanceof RealmRuntimeSaveError) wholefail(`${field}.bundle`);
    throw error;
  }
  return {
    recordId,
    storyId: wholeidentity(row.storyId, `${field}.storyId`),
    title: wholestringValue(row.title, `${field}.title`),
    status: wholeenumValue(row.status, wholeRECORD_STATUSES, `${field}.status`),
    worldVersion: wholestringValue(row.worldVersion, `${field}.worldVersion`),
    startTick: wholeinteger(row.startTick, `${field}.startTick`),
    startOrdinal: wholeinteger(row.startOrdinal, `${field}.startOrdinal`),
    timelineKind: wholeenumValue(row.timelineKind, wholeRECORD_TIMELINE_KINDS, `${field}.timelineKind`),
    linkedRecordId: row.linkedRecordId === null ? null : wholeidentity(row.linkedRecordId, `${field}.linkedRecordId`),
    lastEventId,
    lastWorldTick,
    lastWorldOrdinal,
    bundle,
  };
}

export function normalizeWholeDomainV1(value: unknown): RealmRuntimeSaveWholeDomainV1 {
  const row = wholeobject(value, "domain");
  wholekeys(row, ["format", "schemaVersion", "source", "stories", "storyDefinitions", "records", "projects", "milestones", "projectStoryLinks", "budgetAllocations", "financeAccounts", "ledgerEntries", "financeCommandGroups", "obligations", "obligationSettlements", "storyNodes", "storyUnlockLedger", "committedFactCommands", "performanceAssessments", "memberRelationshipRevisions", "characterAssets"], "domain", ["commandReplayContexts", "commandMaterializations"]);
  if (row.format !== "realm-runtime-domain" || row.schemaVersion !== 1) wholefail("domain.format");
  const source = wholeobject(row.source, "domain.source");
  wholekeys(source, ["worldId", "worldlineId", "storyId", "recordId"], "domain.source");
  const normalizedSource = {
    worldId: wholeidentity(source.worldId, "domain.source.worldId"),
    worldlineId: wholeidentity(source.worldlineId, "domain.source.worldlineId"),
    storyId: wholeidentity(source.storyId, "domain.source.storyId"),
    recordId: wholeidentity(source.recordId, "domain.source.recordId"),
  };
  const normalized: RealmRuntimeSaveWholeDomainV1 = {
    ...(Object.hasOwn(row, "commandMaterializations") ? { commandMaterializations: normalizePolicyMap(row.commandMaterializations) } : {}),
    format: "realm-runtime-domain",
    schemaVersion: 1,
    source: normalizedSource,
    stories: (Array.isArray(row.stories) ? row.stories : wholefail("domain.stories")).map(wholenormalizeStory),
    storyDefinitions: (Array.isArray(row.storyDefinitions) ? row.storyDefinitions : wholefail("domain.storyDefinitions")).map(wholenormalizeStoryDefinition),
    records: (Array.isArray(row.records) ? row.records : wholefail("domain.records")).map(
      (record, index) => wholenormalizeRecordSnapshot(record, index, normalizedSource),
    ),
    projects: (Array.isArray(row.projects) ? row.projects : wholefail("domain.projects")).map(wholenormalizeProject),
    milestones: (Array.isArray(row.milestones) ? row.milestones : wholefail("domain.milestones")).map(wholenormalizeMilestone),
    projectStoryLinks: (Array.isArray(row.projectStoryLinks) ? row.projectStoryLinks : wholefail("domain.projectStoryLinks")).map(wholenormalizeLink),
    budgetAllocations: (Array.isArray(row.budgetAllocations) ? row.budgetAllocations : wholefail("domain.budgetAllocations")).map(wholenormalizeBudget),
    financeAccounts: (Array.isArray(row.financeAccounts) ? row.financeAccounts : wholefail("domain.financeAccounts")).map(wholenormalizeAccount),
    ledgerEntries: (Array.isArray(row.ledgerEntries) ? row.ledgerEntries : wholefail("domain.ledgerEntries")).map(wholenormalizeLedger),
    financeCommandGroups: (Array.isArray(row.financeCommandGroups) ? row.financeCommandGroups : wholefail("domain.financeCommandGroups")).map(wholenormalizeFinanceGroup),
    obligations: (Array.isArray(row.obligations) ? row.obligations : wholefail("domain.obligations")).map(wholenormalizeObligation),
    obligationSettlements: (Array.isArray(row.obligationSettlements) ? row.obligationSettlements : wholefail("domain.obligationSettlements")).map(wholenormalizeSettlement),
    storyNodes: (Array.isArray(row.storyNodes) ? row.storyNodes : wholefail("domain.storyNodes")).map(wholenormalizeNode),
    storyUnlockLedger: (Array.isArray(row.storyUnlockLedger) ? row.storyUnlockLedger : wholefail("domain.storyUnlockLedger")).map(wholenormalizeUnlock),
    committedFactCommands: (Array.isArray(row.committedFactCommands) ? row.committedFactCommands : wholefail("domain.committedFactCommands")).map(wholenormalizeFact),
    performanceAssessments: (Array.isArray(row.performanceAssessments) ? row.performanceAssessments : wholefail("domain.performanceAssessments")).map(wholenormalizeAssessment),
    memberRelationshipRevisions: (Array.isArray(row.memberRelationshipRevisions) ? row.memberRelationshipRevisions : wholefail("domain.memberRelationshipRevisions")).map(wholenormalizeRelationship),
    characterAssets: (Array.isArray(row.characterAssets) ? row.characterAssets : wholefail("domain.characterAssets")).map(wholenormalizeAsset),
  };
  if (Object.hasOwn(row, "commandReplayContexts")) {
    try {
      const contexts = deduplicateReplayContexts(row.commandReplayContexts);
      // The archive layer checks the actual manifest workspace and evidence closure.
      // Here retain strict ordering and reject duplicate contexts rather than repairing input.
      if (!Array.isArray(row.commandReplayContexts) || contexts.length !== row.commandReplayContexts.length
        || contexts.some((context, index) => context.id !== (row.commandReplayContexts as unknown as ReplayContextV1[])[index]?.id)) wholefail("domain.commandReplayContexts");
      normalized.commandReplayContexts = contexts;
    } catch { wholefail("domain.commandReplayContexts"); }
  }
  const boundFacts = normalized.committedFactCommands.filter((command) => command.replayLineage !== undefined);
  for (const command of boundFacts) {
    if (command.provenance !== "legacy-result-v1" || command.request !== null) wholefail("fact.replayLineage.provenance");
  }
  const boundFinance = normalized.financeCommandGroups.filter((group) => group.replayLineage !== undefined);
  const contexts = normalized.commandReplayContexts ?? [];
  if (contexts.length || boundFacts.length || boundFinance.length) {
    try {
      const current = contexts[0];
      if (!current || current.currentScope.worldId !== normalized.source.worldId
        || current.currentScope.worldlineId !== normalized.source.worldlineId) wholefail("domain.commandReplayContexts.scope");
      const closure = Object.fromEntries(Object.keys(current.identities).map((kind) => [kind,
        [...new Set(contexts.flatMap((context) => context.identities[kind as keyof typeof context.identities].map(([id]) => id)))].sort()]));
      validateReplayBundle(contexts, [
        ...boundFacts.map((command) => ({ id: command.id, family: "fact", requestFingerprint: command.requestFingerprint, replayLineage: command.replayLineage })),
        ...boundFinance.map((group) => ({ id: group.id, family: "finance", requestFingerprint: group.requestFingerprint, replayLineage: group.replayLineage })),
      ],
      current.currentScope, closure as unknown as Parameters<typeof validateReplayBundle>[3]);
    } catch { wholefail("domain.commandReplayContexts.references"); }
  }
  wholeduplicateIdentities(normalized.committedFactCommands.map((command) => command.idempotencyKey), "domain.factKeys");
  wholeduplicateIdentities(normalized.financeCommandGroups.map((command) => command.idempotencyKey), "domain.financeKeys");
  // Client-derived balances cannot enter as state: every state-carrying
  // section validates exact keys (a balanceMinor field is an unknownKey
  // failure), while balances themselves are always derived from the ledger.
  // Command result manifests legitimately carry server-computed cash
  // positions (cash.balanceMinor) as replay receipts, so no blanket key walk
  // may reject that name inside opaque provenance payloads.
  // Whole-worldline closure: the domain carries every Story of the saved
  // worldline (Projects may link to any of them), every Record that owns
  // domain evidence as a complete sibling snapshot, and every Story Graph
  // definition that materialized node rows. Nothing is filtered away to
  // make the archive fit.
  wholeduplicateIdentities(normalized.stories.map((story) => story.id), "domain.stories");
  const storyIds = new Set(normalized.stories.map((story) => story.id));
  if (!storyIds.has(normalized.source.storyId)) wholefail("domain.source.storyId");
  wholeduplicateIdentities(normalized.storyDefinitions.map((definition) => definition.storyId), "domain.storyDefinitions");
  if (normalized.storyDefinitions.some((definition) => !storyIds.has(definition.storyId))) wholefail("domain.storyDefinitions.storyId");
  // A Story with materialized node rows must carry the exact definition it
  // was materialized from, or a restore could never unlock its remaining
  // nodes again (the original hash references source runtime identities).
  const definitionStoryIds = new Set(normalized.storyDefinitions.map((definition) => definition.storyId));
  if (normalized.storyNodes.some((node) => !definitionStoryIds.has(node.storyId))) wholefail("domain.storyDefinitions.missing");
  wholeduplicateIdentities(normalized.records.map((record) => record.recordId), "domain.records");
  const siblingRecordIds = new Set(normalized.records.map((record) => record.recordId));
  if (siblingRecordIds.has(normalized.source.recordId)) wholefail("domain.records.sourceRecord");
  const recordScope = new Set([normalized.source.recordId, ...siblingRecordIds]);
  if (normalized.records.some((record) => !storyIds.has(record.storyId))) wholefail("domain.records.storyId");
  if (normalized.records.some((record) => record.linkedRecordId !== null && !recordScope.has(record.linkedRecordId))) wholefail("domain.records.linkedRecordId");
  wholeduplicateIdentities(normalized.projects.map((project) => project.id), "domain.projects");
  wholeduplicateIdentities(normalized.milestones.map((milestone) => milestone.id), "domain.milestones");
  wholeduplicateIdentities(normalized.projectStoryLinks.map((link) => link.id), "domain.projectStoryLinks");
  wholeduplicateIdentities(normalized.budgetAllocations.map((budget) => budget.id), "domain.budgetAllocations");
  wholeduplicateIdentities(normalized.financeAccounts.map((account) => account.id), "domain.financeAccounts");
  wholeduplicateIdentities(normalized.ledgerEntries.map((entry) => entry.id), "domain.ledgerEntries");
  wholeduplicateIdentities(normalized.financeCommandGroups.map((group) => group.id), "domain.financeCommandGroups");
  wholeduplicateIdentities(normalized.obligations.map((obligation) => obligation.id), "domain.obligations");
  wholeduplicateIdentities(normalized.obligationSettlements.map((settlement) => settlement.id), "domain.obligationSettlements");
  wholeduplicateIdentities(normalized.storyNodes.map((node) => node.id), "domain.storyNodes");
  wholeduplicateIdentities(normalized.storyUnlockLedger.map((unlock) => unlock.id), "domain.storyUnlockLedger");
  wholeduplicateIdentities(normalized.committedFactCommands.map((command) => command.id), "domain.committedFactCommands");
  wholeduplicateIdentities(normalized.performanceAssessments.map((assessment) => assessment.id), "domain.performanceAssessments");
  wholeduplicateIdentities(normalized.memberRelationshipRevisions.map((revision) => revision.id), "domain.memberRelationshipRevisions");
  const projectIds = new Set(normalized.projects.map((project) => project.id));
  if (normalized.milestones.some((milestone) => !projectIds.has(milestone.projectId))) wholefail("domain.milestones.projectId");
  if (normalized.projectStoryLinks.some((link) => !projectIds.has(link.projectId))) wholefail("domain.projectStoryLinks.projectId");
  if (normalized.projectStoryLinks.some((link) => !storyIds.has(link.storyId))) wholefail("domain.projectStoryLinks.storyId");
  if (normalized.budgetAllocations.some((budget) => !projectIds.has(budget.projectId))) wholefail("domain.budgetAllocations.projectId");
  if (normalized.ledgerEntries.some((entry) => entry.projectId !== null && !projectIds.has(entry.projectId))) wholefail("domain.ledgerEntries.projectId");
  if (normalized.obligations.some((obligation) => obligation.projectId !== null && !projectIds.has(obligation.projectId))) wholefail("domain.obligations.projectId");
  const accountIds = new Set(normalized.financeAccounts.map((account) => account.id));
  if (normalized.ledgerEntries.some((entry) => !accountIds.has(entry.accountId))) wholefail("domain.ledgerEntries.accountId");
  const obligationIds = new Set(normalized.obligations.map((obligation) => obligation.id));
  const ledgerIds = new Set(normalized.ledgerEntries.map((entry) => entry.id));
  if (normalized.obligationSettlements.some((settlement) => !obligationIds.has(settlement.obligationId))) wholefail("domain.obligationSettlements.obligationId");
  if (normalized.obligationSettlements.some((settlement) => settlement.ledgerEntryId !== null && !ledgerIds.has(settlement.ledgerEntryId))) wholefail("domain.obligationSettlements.ledgerEntryId");
  if (normalized.storyNodes.some((node) => !storyIds.has(node.storyId))) wholefail("domain.storyNodes.storyId");
  const nodeIds = new Set(normalized.storyNodes.map((node) => node.id));
  if (normalized.storyUnlockLedger.some((unlock) => !nodeIds.has(unlock.storyNodeInstanceId))) wholefail("domain.storyUnlockLedger.storyNodeInstanceId");
  if (normalized.storyUnlockLedger.some((unlock) => !storyIds.has(unlock.storyId))) wholefail("domain.storyUnlockLedger.storyId");
  const factCommandIds = new Set(normalized.committedFactCommands.map((command) => command.id));
  if (normalized.performanceAssessments.some((assessment) => !factCommandIds.has(assessment.commandId))) wholefail("domain.performanceAssessments.commandId");
  if (normalized.memberRelationshipRevisions.some((revision) => !factCommandIds.has(revision.commandId))) wholefail("domain.memberRelationshipRevisions.commandId");
  // Every Record identity referenced by any carried domain row must resolve
  // to the saved Record or to an explicitly carried sibling Record snapshot.
  if (normalized.milestones.some((milestone) => milestone.completionRecordId !== null && !recordScope.has(milestone.completionRecordId))) wholefail("domain.milestones.completionRecordId");
  if (normalized.ledgerEntries.some((entry) => entry.sourceRecordId !== null && !recordScope.has(entry.sourceRecordId))) wholefail("domain.ledgerEntries.sourceRecordId");
  if (normalized.financeCommandGroups.some((group) => group.sourceRecordId !== null && !recordScope.has(group.sourceRecordId))) wholefail("domain.financeCommandGroups.sourceRecordId");
  if (normalized.storyNodes.some((node) => node.recordId !== null && !recordScope.has(node.recordId))) wholefail("domain.storyNodes.recordId");
  if (normalized.storyUnlockLedger.some((unlock) => unlock.recordId !== null && !recordScope.has(unlock.recordId))) wholefail("domain.storyUnlockLedger.recordId");
  if (normalized.performanceAssessments.some((assessment) => !recordScope.has(assessment.recordId))) wholefail("domain.performanceAssessments.recordId");
  if (normalized.memberRelationshipRevisions.some((revision) => !recordScope.has(revision.sourceRecordId))) wholefail("domain.memberRelationshipRevisions.sourceRecordId");
  if (normalized.characterAssets.some((asset) => !recordScope.has(asset.recordId))) wholefail("domain.characterAssets.recordId");
  if (countRuntimeSectionWireBytes(normalized, "normalized-domain") > REPLAY_LINEAGE_MAX_BYTES) wholefail("domain.byteBudget");
  validatePolicyMapClosure(normalized);
  return normalized;
}

function wholeduplicateIdentities(ids: readonly string[], field: string): void {
  if (new Set(ids).size !== ids.length) wholefail(`${field}.duplicate`);
}

function normalizePolicyMap(value: unknown): CommandMaterializations {
  try { return normalizeCommandMaterializations(value); } catch { return fail("commandMaterializations"); }
}
function validatePolicyMapClosure(domain: RealmRuntimeSaveDomainV1 | RealmRuntimeSaveWholeDomainV1): void {
  if (!domain.commandMaterializations) return;
  for (const row of domain.commandMaterializations.rows) {
    if (!domain.projects.some(p => p.id === row.projectId)
      || !domain.milestones.some(m => m.id === row.milestoneId && m.projectId === row.projectId)
      || !domain.projectStoryLinks.some(l => l.projectId === row.projectId && l.storyId === row.storyId && l.linkKind === "primary")
      || !(row.storyId === domain.source.storyId || domain.stories?.some(s => s.id === row.storyId))
      || !((row.recordId === domain.source.recordId && row.storyId === domain.source.storyId) || domain.records?.some(r => r.recordId === row.recordId && r.storyId === row.storyId && r.worldVersion === domain.commandMaterializations!.worldVersion))) fail("commandMaterializations.closure");
  }
}
