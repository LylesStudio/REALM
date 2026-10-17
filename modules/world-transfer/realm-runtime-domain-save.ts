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

export function normalizeRealmRuntimeSaveDomainV1(value: unknown): RealmRuntimeSaveDomainV1 {
  const row = object(value, "domain");
  keys(row, ["format", "schemaVersion", "source", "projects", "milestones", "projectStoryLinks", "budgetAllocations", "financeAccounts", "ledgerEntries", "financeCommandGroups", "obligations", "obligationSettlements", "storyNodes", "storyUnlockLedger", "committedFactCommands", "performanceAssessments", "memberRelationshipRevisions", "characterAssets"], "domain");
  if (row.format !== "realm-runtime-domain" || row.schemaVersion !== 1) fail("domain.format");
  const source = object(row.source, "domain.source");
  keys(source, ["worldId", "worldlineId", "storyId", "recordId"], "domain.source");
  const normalized: RealmRuntimeSaveDomainV1 = {
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
  return normalized;
}

export function serializeRealmRuntimeSaveDomainV1(value: RealmRuntimeSaveDomainV1): string {
  return JSON.stringify(normalizeRealmRuntimeSaveDomainV1(value));
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
