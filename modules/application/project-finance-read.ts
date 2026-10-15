import {
  readScope,
  type BudgetAllocation,
  type BudgetUsage,
  type Project,
  type ProjectMilestone,
  type ProjectScope,
} from "../projects/public.ts";
import {
  type CashPosition,
  type LedgerEntry,
  type LedgerEntryDirection,
} from "../finance/public.ts";

export const WORKBENCH_PROJECTION_VERSION = 1 as const;
export const DEFAULT_LEDGER_PAGE_SIZE = 50 as const;
export const MAX_LEDGER_PAGE_SIZE = 100 as const;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CURSOR_LENGTH = 512;

export type ProjectMilestoneCounts = Readonly<{
  planned: number;
  active: number;
  completed: number;
  cancelled: number;
}>;

export interface ProjectStoryRecordRead {
  id: string;
  title: string;
  status: string;
}

export interface ProjectStoryLinkRead {
  id: string;
  projectId: string;
  storyId: string;
  linkKind: "primary" | "related";
  title: string;
  status: string;
  premise: string;
  records: readonly ProjectStoryRecordRead[];
}

export interface ProjectSummaryRead extends Project {
  budgetUsage: BudgetUsage;
  milestoneSummary: ProjectMilestoneCounts;
  storyCount: number;
  recordCount: number;
}

export interface ProjectDetailRead extends ProjectSummaryRead {
  milestones: readonly ProjectMilestone[];
  allocations: readonly BudgetAllocation[];
  stories: readonly ProjectStoryLinkRead[];
}

export interface FinanceProjectSummaryRead {
  projectId: string;
  budgetUsage: BudgetUsage;
}

export interface FinanceSummaryRead {
  currency: "JPY";
  cash: CashPosition;
  accountCount: number;
  byProject: readonly FinanceProjectSummaryRead[];
}

export interface ReadCursor {
  tick: number;
  ordinal: number;
}

export interface LedgerCursor {
  occurredAt: string;
  id: string;
}

export interface LedgerQuery {
  projectId: string | null;
  direction: LedgerEntryDirection | null;
  after: LedgerCursor | null;
  limit: number;
}

export interface LedgerPageRead {
  entries: readonly LedgerEntry[];
  nextCursor: LedgerCursor | null;
  hasMore: boolean;
}

export interface WorkbenchSnapshot {
  scope: ProjectScope;
  readCursor: ReadCursor;
  projectionVersion: typeof WORKBENCH_PROJECTION_VERSION;
  projects: readonly ProjectSummaryRead[];
  /** Kept as a projection-side lookup so routes never reconstruct details in UI code. */
  projectDetails: ReadonlyMap<string, ProjectDetailRead>;
  finance: FinanceSummaryRead;
  activeStoryCount: number;
  activeRecordCount: number;
}

export interface ProjectFinanceReadProjection {
  loadWorkbench(scope: ProjectScope): Promise<WorkbenchSnapshot>;
  loadProject(scope: ProjectScope, projectId: string): Promise<ProjectDetailRead | null>;
  loadLedger(
    scope: ProjectScope,
    query: LedgerQuery,
  ): Promise<{ readCursor: ReadCursor; page: LedgerPageRead }>;
}

export interface ProjectFinanceReadService {
  loadWorkbench(scope: ProjectScope): Promise<WorkbenchSnapshot>;
  loadProject(scope: ProjectScope, projectId: string): Promise<ProjectDetailRead | null>;
  loadFinanceSummary(scope: ProjectScope): Promise<FinanceSummaryRead>;
  loadLedger(scope: ProjectScope, query: unknown): Promise<{
    readCursor: ReadCursor;
    page: LedgerPageRead;
  }>;
}

export type ProjectFinanceReadErrorCode =
  | "INVALID_REQUEST"
  | "SCOPE_INVALID"
  | "CURSOR_INVALID"
  | "PROJECT_NOT_FOUND"
  | "FINANCE_NOT_FOUND"
  | "PROJECT_FINANCE_READ_FAILED"
  | "PROJECT_FINANCE_ROW_INVALID";

export class ProjectFinanceReadError extends Error {
  readonly code: ProjectFinanceReadErrorCode;

  constructor(code: ProjectFinanceReadErrorCode, message: string) {
    super(message);
    this.name = "ProjectFinanceReadError";
    this.code = code;
  }
}

export function createProjectFinanceReadService(options: {
  projection: ProjectFinanceReadProjection;
}): ProjectFinanceReadService {
  return {
    async loadWorkbench(scope) {
      return options.projection.loadWorkbench(normalizeScope(scope));
    },
    async loadProject(scope, projectId) {
      const normalizedProjectId = boundedIdentifier(projectId, "projectId");
      return options.projection.loadProject(normalizeScope(scope), normalizedProjectId);
    },
    async loadFinanceSummary(scope) {
      return (await options.projection.loadWorkbench(normalizeScope(scope))).finance;
    },
    async loadLedger(scope, query) {
      return options.projection.loadLedger(
        normalizeScope(scope),
        normalizeLedgerQuery(query),
      );
    },
  };
}

export function normalizeLedgerQuery(input: unknown): LedgerQuery {
  if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) {
    throw new ProjectFinanceReadError(
      "INVALID_REQUEST",
      "Ledger query must be an object.",
    );
  }
  const value = (input ?? {}) as Record<string, unknown>;
  const projectId = value.projectId === undefined || value.projectId === null
    ? null
    : boundedIdentifier(typeof value.projectId === "string" ? value.projectId.trim() : value.projectId, "projectId");
  const direction = value.direction === undefined || value.direction === null || value.direction === ""
    ? null
    : value.direction === "income" || value.direction === "expense"
      ? value.direction
      : invalid("direction must be income or expense.");
  const limit = value.limit === undefined
    ? DEFAULT_LEDGER_PAGE_SIZE
    : boundedPageSize(value.limit);
  const after = value.after === undefined || value.after === null || value.after === ""
    ? null
    : typeof value.after === "string"
      ? decodeLedgerCursor(value.after)
      : invalid("after cursor is invalid.");
  return { projectId, direction, after, limit };
}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  validateLedgerCursor(cursor);
  return encodeURIComponent(JSON.stringify({
    occurredAt: cursor.occurredAt,
    id: cursor.id,
  }));
}

export function decodeLedgerCursor(value: string): LedgerCursor {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new ProjectFinanceReadError("CURSOR_INVALID", "Ledger cursor is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(value));
  } catch {
    throw new ProjectFinanceReadError("CURSOR_INVALID", "Ledger cursor is invalid.");
  }
  if (
    parsed === null
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || typeof (parsed as { occurredAt?: unknown }).occurredAt !== "string"
    || typeof (parsed as { id?: unknown }).id !== "string"
  ) {
    throw new ProjectFinanceReadError("CURSOR_INVALID", "Ledger cursor is invalid.");
  }
  const cursor = parsed as LedgerCursor;
  validateLedgerCursor(cursor);
  return { occurredAt: cursor.occurredAt, id: cursor.id };
}

function normalizeScope(scope: ProjectScope): ProjectScope {
  try {
    return readScope(scope);
  } catch {
    throw new ProjectFinanceReadError(
      "SCOPE_INVALID",
      "A complete workspace, world, and worldline scope is required.",
    );
  }
}

function boundedIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.trim() !== value
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new ProjectFinanceReadError(
      "INVALID_REQUEST",
      `${field} is required and must be a bounded trimmed identifier.`,
    );
  }
  return value;
}

function boundedPageSize(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_LEDGER_PAGE_SIZE) {
    throw new ProjectFinanceReadError(
      "INVALID_REQUEST",
      `limit must be an integer between 1 and ${MAX_LEDGER_PAGE_SIZE}.`,
    );
  }
  return value as number;
}

function validateLedgerCursor(cursor: LedgerCursor): void {
  if (
    typeof cursor.occurredAt !== "string"
    || Number.isNaN(Date.parse(cursor.occurredAt))
    || typeof cursor.id !== "string"
    || cursor.id.trim() !== cursor.id
    || cursor.id.length === 0
    || cursor.id.length > MAX_IDENTIFIER_LENGTH
  ) {
    throw new ProjectFinanceReadError("CURSOR_INVALID", "Ledger cursor is invalid.");
  }
}

function invalid(message: string): never {
  throw new ProjectFinanceReadError("INVALID_REQUEST", message);
}
