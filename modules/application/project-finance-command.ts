import type { RequestPolicy } from "../world-transfer/realmworld-command-policy.ts";
import { compareReplay, type ResolvedReplayProofV1 } from "./command-replay-lineage.ts";
import {
  deriveCashPosition,
  normalizeFinanceAccount,
  type FinanceAccount,
  type LedgerEntry,
} from "../finance/public.ts";
import {
  positiveAmount,
  projectFinanceCommandFingerprintFor,
  projectFinanceCommandGroupIdFor,
  readScope,
  type ProjectScope,
} from "../projects/public.ts";
import { isSemanticEventKey } from "../world-transfer/semantic-events.ts";

export const PROJECT_FINANCE_COMMAND_POLICY_VERSION = "project-finance-command.v1" as const;

export type ProjectFinanceCommandErrorCode =
  | "BUSINESS_POLICY_MISSING"
  | "BUSINESS_PRECONDITION_FAILED"
  | "COMMAND_INVALID"
  | "FINANCE_ACCOUNT_NOT_FOUND"
  | "WRITE_CONFLICT"
  | "INSUFFICIENT_FUNDS"
  | "IDEMPOTENCY_KEY_REUSE"
  | "PROJECT_NOT_FOUND"
  | "MILESTONE_NOT_FOUND"
  | "MILESTONE_NOT_OPEN"
  | "PROJECT_NOT_ACTIVE"
  | "OBLIGATION_NOT_FOUND"
  | "OBLIGATION_NOT_OPEN";

export class ProjectFinanceCommandError extends Error {
  readonly code: ProjectFinanceCommandErrorCode;

  constructor(code: ProjectFinanceCommandErrorCode, message: string) {
    super(message);
    this.name = "ProjectFinanceCommandError";
    this.code = code;
  }
}

export interface RecordExpenseCommand {
  scope: ProjectScope;
  accountId?: string | null;
  amountMinor: number;
  category: string;
  memo: string;
  projectId?: string | null;
  recordId?: string | null;
  occurredAt: string;
  idempotencyKey: string;
  expectedBalanceMinor: number;
  /** Ignored. Cash is derived by the server and is not a client-writable fact. */
  balanceMinor?: number;
  evidence?: RecordEvidence | null;
}

export interface ExpenseCommitInput {
  scope: ProjectScope;
  commandGroupId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  /** Canonical fingerprinted request payload, persisted for replay provenance. */
  request: Readonly<Record<string, unknown>>;
  accountId: string;
  entryId: string;
  sourceEventId: string;
  amountMinor: number;
  category: string;
  memo: string;
  projectId: string | null;
  recordId: string | null;
  occurredAt: string;
  expectedBalanceMinor: number;
  evidence?: RecordEvidence | null;
}

export interface LedgerCommitInput extends ExpenseCommitInput {
  kind: "income" | "expense" | "adjustment";
  direction: "income" | "expense";
  eventKind: "finance.income.recorded" | "finance.expense.recorded" | "finance.adjustment.recorded";
}

export const PROJECT_STAGES = [
  "planning",
  "funding",
  "production",
  "scheduled",
  "delivery",
  "closed",
] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];

export interface RecordEvidence {
  recordId: string;
  sceneId: string;
  visibility: "public" | "restricted";
  expectedWorldCursor: { worldTick: number; worldOrdinal: number };
}

export interface StageChangeInput {
  scope: ProjectScope;
  commandGroupId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  request: Readonly<Record<string, unknown>>;
  projectId: string;
  stage: ProjectStage;
  expectedProjectVersion: number;
  evidence: RecordEvidence | null;
}

export interface StageCommandResult {
  status: "committed" | "replayed";
  commandGroupId: string;
  projectId: string;
  stage: ProjectStage;
  projectVersion: number;
  eventKind: "project.stage.changed";
  worldCursor: { worldTick: number; worldOrdinal: number } | null;
}

export type ProjectFinanceAction =
  | {
    command: "change_stage";
    projectId: string;
    stage: ProjectStage;
    expectedProjectVersion: number;
  }
  | {
    command: "confirm_milestone";
    projectId: string;
    milestoneId: string;
    expectedProjectVersion: number;
  }
  | {
    command: "record_expense";
    accountId?: string | null;
    amountMinor: number;
    category: string;
    memo: string;
    projectId?: string | null;
    occurredAt: string;
    expectedBalanceMinor: number;
  };

export interface ObligationCommitInput {
  scope: ProjectScope;
  commandGroupId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  request: Readonly<Record<string, unknown>>;
  obligationId: string;
  projectId: string | null;
  kind: "loan" | "presale" | "revenue_share";
  principalMinor: number;
  shareBps: number | null;
  undeliveredCount: number;
}

export interface ObligationResult {
  status: "committed" | "replayed";
  commandGroupId: string;
  obligationId: string;
  kind: "loan" | "presale" | "revenue_share";
  outstandingMinor: number;
  undeliveredCount: number;
}

export interface ObligationSettlementInput {
  scope: ProjectScope;
  commandGroupId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  request: Readonly<Record<string, unknown>>;
  obligationId: string;
  amountMinor: number;
  expectedOutstandingMinor: number;
  expectedBalanceMinor: number;
  accountId?: string | null;
  category: string;
  memo: string;
  occurredAt: string;
  settlementId: string;
  entryId: string;
  settlementKind: "repayment" | "draw" | "share";
}

/**
 * Declared semantic event key carried by a generic formal completion event.
 * World/content vocabulary (for example a World-declared completion signal),
 * never an engine event kind. Shape primitives live in
 * modules/world-transfer/semantic-events.ts (shared with package
 * instantiation and runtime-save restore). Shape validation is NOT
 * authorization: the PostgreSQL command store additionally requires the key
 * to be declared by the installed World (worlds.settings.declaredEvents)
 * before any write.
 */

/** Returns the validated key, or null when absent. Throws COMMAND_INVALID otherwise. */
export function normalizeSemanticEventKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isSemanticEventKey(value)) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "semanticEventKey is invalid.");
  }
  return value;
}

export interface MilestoneConfirmInput {
  scope: ProjectScope;
  commandGroupId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  request: Readonly<Record<string, unknown>>;
  projectId: string;
  milestoneId: string;
  expectedProjectVersion: number;
  evidence?: RecordEvidence | null;
  semanticEventKey?: string | null;
}

export interface MilestoneCommandResult {
  requestPolicy?: RequestPolicy;
  status: "committed" | "replayed";
  commandGroupId: string;
  projectId: string;
  milestoneId: string;
  projectVersion: number;
  eventKind: "project.milestone.confirmed";
  worldCursor?: { worldTick: number; worldOrdinal: number } | null;
  /** Echo of the declared semantic event key, present iff one was declared. */
  semanticEventKey?: string;
}

export interface BudgetCommitInput {
  scope: ProjectScope;
  commandGroupId: string;
  requestFingerprint: string;
  idempotencyKey: string;
  request: Readonly<Record<string, unknown>>;
  projectId: string;
  category: string;
  amountMinor: number;
  expectedVersion: number;
  allocationId: string;
}

export interface BudgetCommandResult {
  status: "committed" | "replayed";
  commandGroupId: string;
  projectId: string;
  category: string;
  amountMinor: number;
  version: number;
  eventKind: "finance.budget.allocated";
}

export interface ExpenseCommandResult {
  status: "committed" | "replayed";
  commandGroupId: string;
  entry: LedgerEntry;
  cash: ReturnType<typeof deriveCashPosition>;
  eventKind: "finance.income.recorded" | "finance.expense.recorded" | "finance.adjustment.recorded";
  worldCursor?: { worldTick: number; worldOrdinal: number } | null;
}

export interface ApplyProjectFinanceResult {
  status: "committed" | "replayed";
  commandGroupId: string;
  worldCursor: { worldTick: number; worldOrdinal: number } | null;
}

export type StoredCommandResult =
  | ExpenseCommandResult
  | MilestoneCommandResult
  | BudgetCommandResult
  | StageCommandResult
  | ObligationResult
  | ApplyProjectFinanceResult;

export interface ProjectFinanceCommandStore {
  loadCommand(
    scope: ProjectScope,
    idempotencyKey: string,
  ): Promise<{
    requestFingerprint: string;
    state?: "committed" | "rejected";
    policyVersion?: string;
    provenance?: "legacy-result-v1" | "request-result-v1";
    replayProof?: ResolvedReplayProofV1;
    result: StoredCommandResult;
    /** Canonical request payload persisted at commit; null only for pre-provenance rows. */
    request: Readonly<Record<string, unknown>> | null;
  } | null>;
  loadAccount(scope: ProjectScope, accountId: string): Promise<FinanceAccount | null>;
  loadDefaultAccount(scope: ProjectScope): Promise<FinanceAccount | null>;
  loadLedger(scope: ProjectScope, accountId: string): Promise<readonly LedgerEntry[]>;
  commitExpense(input: ExpenseCommitInput): Promise<ExpenseCommandResult>;
  commitLedger(input: LedgerCommitInput): Promise<ExpenseCommandResult>;
  confirmMilestone(input: MilestoneConfirmInput): Promise<MilestoneCommandResult>;
  allocateBudget(input: BudgetCommitInput): Promise<BudgetCommandResult>;
  changeStage(input: StageChangeInput): Promise<StageCommandResult>;
  applyRecordProjectFinance(input: {
    scope: ProjectScope;
    commandGroupId: string;
    requestFingerprint: string;
    idempotencyKey: string;
    evidence: RecordEvidence | null;
    actions: readonly ProjectFinanceAction[];
    request: Readonly<Record<string, unknown>>;
  }): Promise<ApplyProjectFinanceResult>;
  createObligation(input: ObligationCommitInput): Promise<ObligationResult>;
  settleObligation(input: ObligationSettlementInput): Promise<ObligationResult & {
    cash: ReturnType<typeof deriveCashPosition>;
  }>;
}

export function createProjectFinanceCommandService(options: {
  store: ProjectFinanceCommandStore;
}) {
  return {
    async recordExpense(command: RecordExpenseCommand): Promise<ExpenseCommandResult> {
      const scope = readScope(command.scope);
      const amountMinor = positiveAmount(command.amountMinor);
      const request = {
        command: "finance.expense.recorded",
        accountId: command.accountId ?? null,
        amountMinor,
        category: required(command.category, "category"),
        memo: required(command.memo, "memo"),
        projectId: command.projectId ?? null,
        recordId: command.recordId ?? null,
        occurredAt: required(command.occurredAt, "occurredAt"),
        expectedBalanceMinor: command.expectedBalanceMinor,
        evidence: evidenceFingerprint(command.evidence),
      };
      const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
      const idempotencyKey = required(command.idempotencyKey, "idempotencyKey");
      const existing = await options.store.loadCommand(scope, idempotencyKey);
      if (existing) {
        return replayStoredCommand<ExpenseCommandResult>(existing, scope, request, requestFingerprint);
      }

      const account = command.accountId
        ? await options.store.loadAccount(scope, command.accountId)
        : await options.store.loadDefaultAccount(scope);
      if (!account || account.status !== "active") {
        throw new ProjectFinanceCommandError(
          "FINANCE_ACCOUNT_NOT_FOUND",
          "The finance account is not available.",
        );
      }
      const normalizedAccount = normalizeFinanceAccount(account);
      const ledger = await options.store.loadLedger(scope, normalizedAccount.id);
      const cash = deriveCashPosition(normalizedAccount, ledger);
      if (command.expectedBalanceMinor !== cash.balanceMinor) {
        throw new ProjectFinanceCommandError(
          "WRITE_CONFLICT",
          "The cash position changed. Read it again before retrying.",
        );
      }
      if (amountMinor > cash.balanceMinor) {
        throw new ProjectFinanceCommandError(
          "INSUFFICIENT_FUNDS",
          "The available balance cannot cover this expense.",
        );
      }

      const commandGroupId = projectFinanceCommandGroupIdFor(
        scope,
        idempotencyKey,
        requestFingerprint,
      );
      return options.store.commitExpense({
        scope,
        commandGroupId,
        requestFingerprint,
        idempotencyKey,
        request,
        accountId: normalizedAccount.id,
        entryId: `${commandGroupId}:entry`,
        sourceEventId: `${commandGroupId}:event`,
        amountMinor,
        category: required(command.category, "category"),
        memo: required(command.memo, "memo"),
        projectId: command.projectId ?? null,
        recordId: command.recordId ?? null,
        occurredAt: required(command.occurredAt, "occurredAt"),
        expectedBalanceMinor: cash.balanceMinor,
        evidence: command.evidence ?? null,
      });
    },
    async recordIncome(command: RecordExpenseCommand): Promise<ExpenseCommandResult> {
      return recordLedger(options.store, command, "income", "income", "finance.income.recorded", false);
    },
    async recordAdjustment(command: RecordExpenseCommand & { direction: "income" | "expense" }): Promise<ExpenseCommandResult> {
      return recordLedger(
        options.store,
        command,
        "adjustment",
        command.direction,
        "finance.adjustment.recorded",
        command.direction === "expense",
      );
    },
    async confirmMilestone(command: {
      scope: ProjectScope;
      projectId: string;
      milestoneId: string;
      expectedProjectVersion: number;
      idempotencyKey: string;
      evidence?: RecordEvidence | null;
      semanticEventKey?: string | null;
    }): Promise<MilestoneCommandResult> {
      const scope = readScope(command.scope);
      const semanticEventKey = normalizeSemanticEventKey(command.semanticEventKey);
      const request = {
        command: "project.milestone.confirmed",
        projectId: required(command.projectId, "projectId"),
        milestoneId: required(command.milestoneId, "milestoneId"),
        expectedProjectVersion: command.expectedProjectVersion,
        evidence: evidenceFingerprint(command.evidence),
        ...(semanticEventKey ? { semanticEventKey } : {}),
      };
      const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
      const idempotencyKey = required(command.idempotencyKey, "idempotencyKey");
      const existing = await options.store.loadCommand(scope, idempotencyKey);
      if (existing) {
        return replayStoredCommand<MilestoneCommandResult>(existing, scope, request, requestFingerprint);
      }
      return options.store.confirmMilestone({
        scope,
        commandGroupId: projectFinanceCommandGroupIdFor(scope, idempotencyKey, requestFingerprint),
        requestFingerprint,
        idempotencyKey,
        request,
        projectId: required(command.projectId, "projectId"),
        milestoneId: required(command.milestoneId, "milestoneId"),
        expectedProjectVersion: command.expectedProjectVersion,
        evidence: command.evidence ?? null,
        semanticEventKey,
      });
    },
    async changeStage(command: {
      scope: ProjectScope;
      projectId: string;
      stage: string;
      expectedProjectVersion: number;
      idempotencyKey: string;
      evidence?: RecordEvidence | null;
    }): Promise<StageCommandResult> {
      const scope = readScope(command.scope);
      const stage = readStage(command.stage);
      const request = {
        command: "project.stage.changed",
        projectId: required(command.projectId, "projectId"),
        stage,
        expectedProjectVersion: command.expectedProjectVersion,
        evidence: evidenceFingerprint(command.evidence),
      };
      const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
      const idempotencyKey = required(command.idempotencyKey, "idempotencyKey");
      const existing = await options.store.loadCommand(scope, idempotencyKey);
      if (existing) {
        return replayStoredCommand<StageCommandResult>(existing, scope, request, requestFingerprint);
      }
      return options.store.changeStage({
        scope,
        commandGroupId: projectFinanceCommandGroupIdFor(scope, idempotencyKey, requestFingerprint),
        requestFingerprint,
        idempotencyKey,
        request,
        projectId: required(command.projectId, "projectId"),
        stage,
        expectedProjectVersion: command.expectedProjectVersion,
        evidence: command.evidence ?? null,
      });
    },
    async applyRecordProjectFinance(command: {
      scope: ProjectScope;
      idempotencyKey: string;
      evidence?: RecordEvidence | null;
      actions: readonly ProjectFinanceAction[];
    }) {
      const scope = readScope(command.scope);
      if (!Array.isArray(command.actions) || command.actions.length === 0 || command.actions.length > 8) {
        throw new ProjectFinanceCommandError("COMMAND_INVALID", "actions must be a bounded non-empty list.");
      }
      const actions = command.actions.map((action) => normalizeFinanceAction(action));
      const request = {
        command: "record.apply_project_finance",
        evidence: evidenceFingerprint(command.evidence),
        actions,
      };
      const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
      const idempotencyKey = required(command.idempotencyKey, "idempotencyKey");
      const existing = await options.store.loadCommand(scope, idempotencyKey);
      if (existing) {
        return replayStoredCommand<Awaited<ReturnType<ProjectFinanceCommandStore["applyRecordProjectFinance"]>>>(existing, scope, request, requestFingerprint);
      }
      return options.store.applyRecordProjectFinance({
        scope,
        commandGroupId: projectFinanceCommandGroupIdFor(scope, idempotencyKey, requestFingerprint),
        requestFingerprint,
        idempotencyKey,
        evidence: command.evidence ?? null,
        actions,
        request,
      });
    },
    async createObligation(command: {
      scope: ProjectScope;
      idempotencyKey: string;
      projectId?: string | null;
      kind: "loan" | "presale" | "revenue_share";
      principalMinor: number;
      shareBps?: number | null;
      undeliveredCount?: number;
    }): Promise<ObligationResult> {
      const scope = readScope(command.scope);
      const kind = readObligationKind(command.kind);
      const principalMinor = positiveAmount(command.principalMinor);
      const shareBps = kind === "revenue_share" ? readShareBps(command.shareBps) : null;
      if (kind !== "revenue_share" && command.shareBps != null) {
        throw new ProjectFinanceCommandError("COMMAND_INVALID", "shareBps is only valid for revenue_share.");
      }
      const undeliveredCount = kind === "presale" ? readCount(command.undeliveredCount ?? 0) : 0;
      const request = {
        command: "finance.obligation.created",
        projectId: command.projectId ?? null,
        kind,
        principalMinor,
        shareBps,
        undeliveredCount,
      };
      const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
      const idempotencyKey = required(command.idempotencyKey, "idempotencyKey");
      const existing = await options.store.loadCommand(scope, idempotencyKey);
      if (existing) {
        return replayStoredCommand<ObligationResult>(existing, scope, request, requestFingerprint);
      }
      const commandGroupId = projectFinanceCommandGroupIdFor(scope, idempotencyKey, requestFingerprint);
      return options.store.createObligation({
        scope,
        commandGroupId,
        requestFingerprint,
        idempotencyKey,
        request,
        obligationId: `${commandGroupId}:obligation`,
        projectId: command.projectId ?? null,
        kind,
        principalMinor,
        shareBps,
        undeliveredCount,
      });
    },
    async settleObligation(command: {
      scope: ProjectScope;
      idempotencyKey: string;
      obligationId: string;
      amountMinor: number;
      expectedOutstandingMinor: number;
      expectedBalanceMinor: number;
      accountId?: string | null;
      category: string;
      memo: string;
      occurredAt: string;
      settlementKind: string;
    }): Promise<ObligationResult & { cash: ReturnType<typeof deriveCashPosition> }> {
      const scope = readScope(command.scope);
      const settlementKind = readSettlementKind(command.settlementKind);
      const amountMinor = positiveAmount(command.amountMinor);
      const request = {
        command: "finance.obligation.settled",
        obligationId: required(command.obligationId, "obligationId"),
        settlementKind,
        amountMinor,
        expectedOutstandingMinor: command.expectedOutstandingMinor,
        expectedBalanceMinor: command.expectedBalanceMinor,
        accountId: command.accountId ?? null,
        category: required(command.category, "category"),
        occurredAt: required(command.occurredAt, "occurredAt"),
      };
      const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
      const idempotencyKey = required(command.idempotencyKey, "idempotencyKey");
      const existing = await options.store.loadCommand(scope, idempotencyKey);
      if (existing) {
        return replayStoredCommand<ObligationResult & { cash: ReturnType<typeof deriveCashPosition> }>(existing, scope, request, requestFingerprint);
      }
      const commandGroupId = projectFinanceCommandGroupIdFor(scope, idempotencyKey, requestFingerprint);
      return options.store.settleObligation({
        scope,
        commandGroupId,
        requestFingerprint,
        idempotencyKey,
        request,
        obligationId: required(command.obligationId, "obligationId"),
        amountMinor,
        expectedOutstandingMinor: command.expectedOutstandingMinor,
        expectedBalanceMinor: command.expectedBalanceMinor,
        accountId: command.accountId ?? null,
        category: required(command.category, "category"),
        memo: required(command.memo, "memo"),
        occurredAt: required(command.occurredAt, "occurredAt"),
        settlementId: `${commandGroupId}:settlement`,
        entryId: `${commandGroupId}:entry`,
        settlementKind,
      });
    },
    async allocateBudget(command: {
      scope: ProjectScope;
      projectId: string;
      category: string;
      amountMinor: number;
      expectedVersion: number;
      idempotencyKey: string;
    }): Promise<BudgetCommandResult> {
      const scope = readScope(command.scope);
      const amountMinor = positiveAmount(command.amountMinor);
      const request = {
        command: "finance.budget.allocated",
        projectId: required(command.projectId, "projectId"),
        category: required(command.category, "category"),
        amountMinor,
        expectedVersion: command.expectedVersion,
      };
      const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
      const idempotencyKey = required(command.idempotencyKey, "idempotencyKey");
      const existing = await options.store.loadCommand(scope, idempotencyKey);
      if (existing) {
        return replayStoredCommand<BudgetCommandResult>(existing, scope, request, requestFingerprint);
      }
      return options.store.allocateBudget({
        scope,
        commandGroupId: projectFinanceCommandGroupIdFor(scope, idempotencyKey, requestFingerprint),
        requestFingerprint,
        idempotencyKey,
        request,
        projectId: required(command.projectId, "projectId"),
        category: required(command.category, "category"),
        amountMinor,
        expectedVersion: command.expectedVersion,
        allocationId: `${projectFinanceCommandGroupIdFor(scope, idempotencyKey, requestFingerprint)}:budget`,
      });
    },
  };
}

/** The same full-candidate comparator also guards transaction-local occupied keys. */
function replayStoredCommand<T extends { status: "committed" | "replayed" }>(
  existing: NonNullable<Awaited<ReturnType<ProjectFinanceCommandStore["loadCommand"]>>>,
  scope: ProjectScope,
  request: Readonly<Record<string, unknown>>,
  requestFingerprint: string,
): T {
  const { result, ...receipt } = existing;
  if (!compareReplay({ family: "finance", trustedScope: scope, candidate: request,
    expectedOperation: request.command, existing: receipt, suppliedTargetFingerprint: requestFingerprint })) {
    throw new ProjectFinanceCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
  }
  return { ...(result as object), status: "replayed" } as T;
}

async function recordLedger(
  store: ProjectFinanceCommandStore,
  command: RecordExpenseCommand,
  kind: LedgerCommitInput["kind"],
  direction: LedgerCommitInput["direction"],
  eventKind: LedgerCommitInput["eventKind"],
  enforceFunds: boolean,
): Promise<ExpenseCommandResult> {
  const scope = readScope(command.scope);
  const amountMinor = positiveAmount(command.amountMinor);
  const request = {
    command: eventKind,
    accountId: command.accountId ?? null,
    amountMinor,
    category: required(command.category, "category"),
    memo: required(command.memo, "memo"),
    projectId: command.projectId ?? null,
    recordId: command.recordId ?? null,
    occurredAt: required(command.occurredAt, "occurredAt"),
    expectedBalanceMinor: command.expectedBalanceMinor,
    direction,
    evidence: evidenceFingerprint(command.evidence),
  };
  const requestFingerprint = projectFinanceCommandFingerprintFor(scope, request);
  const idempotencyKey = required(command.idempotencyKey, "idempotencyKey");
  const existing = await store.loadCommand(scope, idempotencyKey);
  if (existing) {
    return replayStoredCommand<ExpenseCommandResult>(existing, scope, request, requestFingerprint);
  }
  const account = command.accountId
    ? await store.loadAccount(scope, command.accountId)
    : await store.loadDefaultAccount(scope);
  if (!account || account.status !== "active") {
    throw new ProjectFinanceCommandError("FINANCE_ACCOUNT_NOT_FOUND", "The finance account is not available.");
  }
  const normalizedAccount = normalizeFinanceAccount(account);
  const ledger = await store.loadLedger(scope, normalizedAccount.id);
  const cash = deriveCashPosition(normalizedAccount, ledger);
  if (command.expectedBalanceMinor !== cash.balanceMinor) {
    throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The cash position changed. Read it again before retrying.");
  }
  if (enforceFunds && amountMinor > cash.balanceMinor) {
    throw new ProjectFinanceCommandError("INSUFFICIENT_FUNDS", "The available balance cannot cover this entry.");
  }
  const commandGroupId = projectFinanceCommandGroupIdFor(scope, idempotencyKey, requestFingerprint);
  return store.commitLedger({
    scope,
    commandGroupId,
    requestFingerprint,
    idempotencyKey,
    request,
    accountId: normalizedAccount.id,
    entryId: `${commandGroupId}:entry`,
    sourceEventId: `${commandGroupId}:event`,
    amountMinor,
    category: required(command.category, "category"),
    memo: required(command.memo, "memo"),
    projectId: command.projectId ?? null,
    recordId: command.recordId ?? null,
    occurredAt: required(command.occurredAt, "occurredAt"),
    expectedBalanceMinor: cash.balanceMinor,
    kind,
    direction,
    eventKind,
    evidence: command.evidence ?? null,
  });
}

export function readRecordEvidence(body: Record<string, unknown>): RecordEvidence | null {
  const names = ["recordId", "sceneId", "visibility", "expectedWorldCursor"] as const;
  const present = names.filter((name) => body[name] !== undefined && body[name] !== null);
  if (present.length === 0) return null;
  if (present.length !== names.length) {
    throw new ProjectFinanceCommandError(
      "COMMAND_INVALID",
      "Record evidence must include recordId, sceneId, visibility, and expectedWorldCursor together.",
    );
  }
  const recordId = required(String(body.recordId), "recordId");
  const sceneId = required(String(body.sceneId), "sceneId");
  if (body.visibility !== "public" && body.visibility !== "restricted") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "visibility is invalid.");
  }
  const cursor = body.expectedWorldCursor;
  if (cursor === null || typeof cursor !== "object" || Array.isArray(cursor)) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "expectedWorldCursor is invalid.");
  }
  const worldTick = (cursor as { worldTick?: unknown }).worldTick;
  const worldOrdinal = (cursor as { worldOrdinal?: unknown }).worldOrdinal;
  if (!Number.isSafeInteger(worldTick) || !Number.isSafeInteger(worldOrdinal) || (worldTick as number) < 0 || (worldOrdinal as number) < 0) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "expectedWorldCursor is invalid.");
  }
  return {
    recordId,
    sceneId,
    visibility: body.visibility,
    expectedWorldCursor: { worldTick: worldTick as number, worldOrdinal: worldOrdinal as number },
  };
}

function evidenceFingerprint(evidence: RecordEvidence | null | undefined) {
  if (!evidence) return null;
  return {
    recordId: evidence.recordId,
    sceneId: evidence.sceneId,
    visibility: evidence.visibility,
    worldTick: evidence.expectedWorldCursor.worldTick,
    worldOrdinal: evidence.expectedWorldCursor.worldOrdinal,
  };
}

function readStage(value: string): ProjectStage {
  if (!(PROJECT_STAGES as readonly string[]).includes(value)) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "stage is invalid.");
  }
  return value as ProjectStage;
}

function readObligationKind(value: string): "loan" | "presale" | "revenue_share" {
  if (value !== "loan" && value !== "presale" && value !== "revenue_share") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "obligation kind is invalid.");
  }
  return value;
}

function readShareBps(value: number | null | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "shareBps is invalid.");
  }
  return value as number;
}

function readCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "undeliveredCount is invalid.");
  }
  return value;
}

function readSettlementKind(value: string): "repayment" | "draw" | "share" {
  if (value !== "repayment" && value !== "draw" && value !== "share") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "settlement kind is invalid.");
  }
  return value;
}

function readExpectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "expectedProjectVersion is invalid.");
  }
  return value;
}

function normalizeFinanceAction(action: ProjectFinanceAction): ProjectFinanceAction {
  if (!action || typeof action !== "object") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "action is invalid.");
  }
  if (action.command === "change_stage") {
    return {
      command: "change_stage",
      projectId: required(action.projectId, "projectId"),
      stage: readStage(action.stage),
      expectedProjectVersion: readExpectedVersion(action.expectedProjectVersion),
    };
  }
  if (action.command === "confirm_milestone") {
    return {
      command: "confirm_milestone",
      projectId: required(action.projectId, "projectId"),
      milestoneId: required(action.milestoneId, "milestoneId"),
      expectedProjectVersion: readExpectedVersion(action.expectedProjectVersion),
    };
  }
      if (action.command === "record_expense") {
        if (!Number.isSafeInteger(action.expectedBalanceMinor) || action.expectedBalanceMinor < 0) {
          throw new ProjectFinanceCommandError("COMMAND_INVALID", "expectedBalanceMinor is invalid.");
        }
        return {
      command: "record_expense",
      accountId: action.accountId ?? null,
      amountMinor: positiveAmount(action.amountMinor),
      category: required(action.category, "category"),
      memo: required(action.memo, "memo"),
      projectId: action.projectId ?? null,
      occurredAt: required(action.occurredAt, "occurredAt"),
      expectedBalanceMinor: action.expectedBalanceMinor,
    };
  }
  throw new ProjectFinanceCommandError("COMMAND_INVALID", "action is invalid.");
}

function required(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", `${field} is required.`);
  }
  return value.trim();
}
