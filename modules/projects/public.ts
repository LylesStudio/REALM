import { createHash } from "node:crypto";

export const PROJECT_KINDS = [
  "production",
  "campaign",
  "operation",
  "initiative",
] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_STATUSES = [
  "planned",
  "active",
  "completed",
  "cancelled",
  "archived",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STAGES = [
  "planning",
  "funding",
  "production",
  "scheduled",
  "delivery",
  "closed",
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export const MILESTONE_STATUSES = [
  "planned",
  "active",
  "completed",
  "cancelled",
] as const;
export type ProjectMilestoneStatus = (typeof MILESTONE_STATUSES)[number];

export const CURRENCY_JPY = "JPY" as const;
export type Currency = typeof CURRENCY_JPY;

export interface ProjectScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
}

export interface Project extends ProjectScope {
  id: string;
  kind: ProjectKind;
  status: ProjectStatus;
  stage: ProjectStage;
  title: string;
  currency: Currency;
  version: number;
  deadline: string | null;
  ownerId: string | null;
}

export interface ProjectInput extends Partial<ProjectScope> {
  scope?: ProjectScope;
  id: string;
  kind: ProjectKind | string;
  status: ProjectStatus | string;
  stage: ProjectStage | string;
  title: string;
  currency?: string;
  version: number;
  deadline?: string | null;
  ownerId?: string | null;
}

export interface ProjectMilestone extends ProjectScope {
  id: string;
  projectId: string;
  sequence: number;
  title: string;
  status: ProjectMilestoneStatus;
  dueOn: string | null;
  completionEventId: string | null;
}

export interface ProjectMilestoneInput extends Partial<ProjectScope> {
  scope?: ProjectScope;
  /** Optional server-known project scope; when present it is checked atomically. */
  projectScope?: ProjectScope;
  id: string;
  projectId: string;
  sequence: number;
  title: string;
  status: ProjectMilestoneStatus | string;
  dueOn?: string | null;
  completionEventId?: string | null;
}

export interface BudgetAllocation extends ProjectScope {
  id: string;
  projectId: string;
  category: string;
  amountMinor: number;
  currency: Currency;
  version: number;
}

export interface BudgetAllocationInput extends Partial<ProjectScope> {
  scope?: ProjectScope;
  projectScope?: ProjectScope;
  id: string;
  projectId: string;
  category: string;
  amountMinor: number;
  currency?: string;
  version: number;
}

export interface BudgetUsage {
  budgetedMinor: number;
  spentMinor: number;
  remainingMinor: number;
  allocationCount: number;
}

export interface ProjectFinanceCommandFingerprintInput {
  command: string;
  [key: string]: unknown;
}

export type ProjectFinanceErrorCode =
  | "SCOPE_INVALID"
  | "SCOPE_MISMATCH"
  | "IDENTIFIER_INVALID"
  | "PROJECT_KIND_INVALID"
  | "PROJECT_STATUS_INVALID"
  | "FINANCE_ACCOUNT_STATUS_INVALID"
  | "LEDGER_KIND_INVALID"
  | "LEDGER_DIRECTION_INVALID"
  | "PROJECT_STAGE_INVALID"
  | "MILESTONE_STATUS_INVALID"
  | "CURRENCY_INVALID"
  | "AMOUNT_INVALID"
  | "VERSION_INVALID"
  | "SEQUENCE_INVALID"
  | "DATE_INVALID"
  | "COMMAND_INVALID";

export class ProjectFinanceError extends Error {
  readonly code: ProjectFinanceErrorCode;

  constructor(code: ProjectFinanceErrorCode, message: string) {
    super(message);
    this.name = "ProjectFinanceError";
    this.code = code;
  }
}

export function assertSameScope(left: ProjectScope, right: ProjectScope): void {
  const leftScope = readScope(left);
  const rightScope = readScope(right);
  if (
    leftScope.workspaceId !== rightScope.workspaceId
    || leftScope.worldId !== rightScope.worldId
    || leftScope.worldlineId !== rightScope.worldlineId
  ) {
    throw new ProjectFinanceError(
      "SCOPE_MISMATCH",
      "Project and finance facts must belong to the same workspace, world, and worldline.",
    );
  }
}

export function normalizeProject(input: ProjectInput): Project {
  const scope = input.scope ? readScope(input.scope) : readScope(input);
  const kind = enumValue(input.kind, PROJECT_KINDS, "PROJECT_KIND_INVALID");
  const status = enumValue(input.status, PROJECT_STATUSES, "PROJECT_STATUS_INVALID");
  const stage = enumValue(input.stage, PROJECT_STAGES, "PROJECT_STAGE_INVALID");
  const version = positiveInteger(input.version, "VERSION_INVALID");
  const title = requiredText(input.title, "title");
  const deadline = optionalDate(input.deadline, "deadline");
  const ownerId = optionalText(input.ownerId, "ownerId");
  requireCurrency(input.currency ?? CURRENCY_JPY);
  return Object.freeze({
    ...scope,
    id: requiredText(input.id, "id"),
    kind,
    status,
    stage,
    title,
    currency: CURRENCY_JPY,
    version,
    deadline,
    ownerId,
  });
}

export function normalizeProjectMilestone(input: ProjectMilestoneInput): ProjectMilestone {
  const scope = input.scope ? readScope(input.scope) : readScope(input);
  if (input.projectScope) assertSameScope(scope, input.projectScope);
  return Object.freeze({
    ...scope,
    id: requiredText(input.id, "id"),
    projectId: requiredText(input.projectId, "projectId"),
    sequence: positiveInteger(input.sequence, "SEQUENCE_INVALID"),
    title: requiredText(input.title, "title"),
    status: enumValue(input.status, MILESTONE_STATUSES, "MILESTONE_STATUS_INVALID"),
    dueOn: optionalDate(input.dueOn, "dueOn"),
    completionEventId: optionalText(input.completionEventId, "completionEventId"),
  });
}

export function normalizeBudgetAllocation(input: BudgetAllocationInput): BudgetAllocation {
  const scope = input.scope ? readScope(input.scope) : readScope(input);
  if (input.projectScope) assertSameScope(scope, input.projectScope);
  requireCurrency(input.currency ?? CURRENCY_JPY);
  return Object.freeze({
    ...scope,
    id: requiredText(input.id, "id"),
    projectId: requiredText(input.projectId, "projectId"),
    category: requiredText(input.category, "category"),
    amountMinor: positiveAmount(input.amountMinor),
    currency: CURRENCY_JPY,
    version: positiveInteger(input.version, "VERSION_INVALID"),
  });
}

export function deriveBudgetUsage(
  scope: ProjectScope,
  projectId: string,
  allocations: readonly BudgetAllocation[],
  entries: readonly {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    projectId?: string | null;
    direction: "income" | "expense";
    amountMinor: number;
    kind: "income" | "expense" | "adjustment";
    currency: Currency;
  }[],
): BudgetUsage {
  const normalizedScope = readScope(scope);
  const normalizedProjectId = requiredText(projectId, "projectId");
  let budgetedMinor = 0;
  for (const allocation of allocations) {
    assertSameScope(normalizedScope, allocation);
    requireCurrency(allocation.currency);
    if (allocation.projectId === normalizedProjectId) {
      budgetedMinor = safeAdd(budgetedMinor, allocation.amountMinor);
    }
  }
  let spentMinor = 0;
  for (const entry of entries) {
    assertSameScope(normalizedScope, entry);
    requireCurrency(entry.currency);
    positiveAmount(entry.amountMinor);
    if (entry.projectId === normalizedProjectId && entry.direction === "expense") {
      spentMinor = safeAdd(spentMinor, entry.amountMinor);
    }
  }
  return {
    budgetedMinor,
    spentMinor,
    remainingMinor: budgetedMinor - spentMinor,
    allocationCount: allocations.filter((allocation) => allocation.projectId === normalizedProjectId).length,
  };
}

export function projectFinanceCommandFingerprintFor(
  scope: ProjectScope,
  input: ProjectFinanceCommandFingerprintInput,
): string {
  const normalizedScope = readScope(scope);
  if (!input || typeof input !== "object" || typeof input.command !== "string" || input.command.trim() === "") {
    throw new ProjectFinanceError("COMMAND_INVALID", "A command kind is required for fingerprinting.");
  }
  const canonical = stableJson({
    scope: normalizedScope,
    request: input,
  });
  return createHash("sha256")
    .update(`project-finance-command:v1\0${canonical}`)
    .digest("hex");
}

export function projectFinanceCommandGroupIdFor(
  scope: ProjectScope,
  idempotencyKey: string,
  requestFingerprint: string,
): string {
  const normalizedScope = readScope(scope);
  const key = requiredText(idempotencyKey, "idempotencyKey");
  if (!/^[a-f0-9]{64}$/.test(requestFingerprint)) {
    throw new ProjectFinanceError("COMMAND_INVALID", "requestFingerprint must be lowercase SHA-256 hex.");
  }
  const digest = createHash("sha256")
    .update([
      "project-finance-command-group:v1",
      normalizedScope.workspaceId,
      normalizedScope.worldId,
      normalizedScope.worldlineId,
      key,
      requestFingerprint,
    ].join("\0"))
    .digest("hex");
  return `pfcmd_${digest.slice(0, 24)}`;
}

export function scopeKey(scope: ProjectScope): string {
  const normalized = readScope(scope);
  return [normalized.workspaceId, normalized.worldId, normalized.worldlineId].join("\0");
}

export function readScope(input: Partial<ProjectScope>): ProjectScope {
  if (!input || typeof input !== "object") {
    throw new ProjectFinanceError("SCOPE_INVALID", "A workspace/world/worldline scope is required.");
  }
  return {
    workspaceId: requiredText(input.workspaceId, "workspaceId", "SCOPE_INVALID"),
    worldId: requiredText(input.worldId, "worldId", "SCOPE_INVALID"),
    worldlineId: requiredText(input.worldlineId, "worldlineId", "SCOPE_INVALID"),
  };
}

export function requireCurrency(value: string): Currency {
  if (value !== CURRENCY_JPY) {
    throw new ProjectFinanceError("CURRENCY_INVALID", "Only JPY integer-minor facts are supported by this worldline.");
  }
  return CURRENCY_JPY;
}

export function positiveAmount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProjectFinanceError("AMOUNT_INVALID", "amountMinor must be a positive safe integer.");
  }
  return value;
}

export function positiveInteger(value: number, code: "VERSION_INVALID" | "SEQUENCE_INVALID"): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProjectFinanceError(code, "Value must be a positive safe integer.");
  }
  return value;
}

function enumValue<T extends string>(value: string, allowed: readonly T[], code: ProjectFinanceErrorCode): T {
  if (!allowed.includes(value as T)) {
    throw new ProjectFinanceError(code, `Value ${JSON.stringify(value)} is not allowed.`);
  }
  return value as T;
}

function requiredText(value: unknown, field: string, code: ProjectFinanceErrorCode = "IDENTIFIER_INVALID"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectFinanceError(code, `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field);
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const normalized = requiredText(value, field);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new ProjectFinanceError("DATE_INVALID", `${field} must be an ISO-compatible date.`);
  }
  return normalized;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new ProjectFinanceError("AMOUNT_INVALID", "Derived amount exceeds safe integer range.");
  }
  return result;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProjectFinanceError("COMMAND_INVALID", "Command payload contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
  }
  throw new ProjectFinanceError("COMMAND_INVALID", "Command payload contains an unsupported value.");
}
