import {
  assertSameScope,
  CURRENCY_JPY,
  positiveAmount,
  readScope,
  requireCurrency,
  type Currency,
  ProjectFinanceError,
  type ProjectScope,
} from "../projects/public.ts";

export const FINANCE_ACCOUNT_STATUSES = ["active", "closed"] as const;
export type FinanceAccountStatus = (typeof FINANCE_ACCOUNT_STATUSES)[number];

export const LEDGER_ENTRY_KINDS = ["income", "expense", "adjustment"] as const;
export type LedgerEntryKind = (typeof LEDGER_ENTRY_KINDS)[number];
export type LedgerEntryDirection = "income" | "expense";

export interface FinanceAccount extends ProjectScope {
  id: string;
  currency: Currency;
  status: FinanceAccountStatus;
  openingBalanceMinor: number;
}

export interface FinanceAccountInput extends Partial<ProjectScope> {
  scope?: ProjectScope;
  id: string;
  currency: string;
  status: FinanceAccountStatus | string;
  openingBalanceMinor: number;
}

export interface LedgerEntry extends ProjectScope {
  id: string;
  accountId: string;
  kind: LedgerEntryKind;
  direction: LedgerEntryDirection;
  amountMinor: number;
  currency: Currency;
  category: string;
  memo: string;
  projectId: string | null;
  recordId: string | null;
  sourceEventId: string | null;
  occurredAt: string;
  idempotencyKey: string;
}

export interface LedgerEntryInput extends Partial<ProjectScope> {
  scope?: ProjectScope;
  id: string;
  accountId: string;
  kind: LedgerEntryKind | string;
  direction: LedgerEntryDirection | string;
  amountMinor: number;
  currency: string;
  category: string;
  memo: string;
  projectId?: string | null;
  recordId?: string | null;
  sourceEventId?: string | null;
  occurredAt: string;
  idempotencyKey: string;
}

export interface CashPosition {
  currency: Currency;
  openingBalanceMinor: number;
  incomeMinor: number;
  expenseMinor: number;
  adjustmentMinor: number;
  balanceMinor: number;
  entryCount: number;
}

export function normalizeFinanceAccount(input: FinanceAccountInput): FinanceAccount {
  const scope = input.scope ? readScope(input.scope) : readScope(input);
  requireCurrency(input.currency);
  if (!FINANCE_ACCOUNT_STATUSES.includes(input.status as FinanceAccountStatus)) {
    throw new ProjectFinanceError("FINANCE_ACCOUNT_STATUS_INVALID", "Finance account status is invalid.");
  }
  if (!Number.isSafeInteger(input.openingBalanceMinor) || input.openingBalanceMinor < 0) {
    throw new ProjectFinanceError("AMOUNT_INVALID", "openingBalanceMinor must be a non-negative safe integer.");
  }
  return Object.freeze({
    ...scope,
    id: requiredText(input.id, "id"),
    currency: CURRENCY_JPY,
    status: input.status as FinanceAccountStatus,
    openingBalanceMinor: input.openingBalanceMinor,
  });
}

export function normalizeLedgerEntry(input: LedgerEntryInput): LedgerEntry {
  const scope = input.scope ? readScope(input.scope) : readScope(input);
  requireCurrency(input.currency);
  const kind = input.kind as LedgerEntryKind;
  const direction = input.direction as LedgerEntryDirection;
  if (!LEDGER_ENTRY_KINDS.includes(kind)) {
    throw new ProjectFinanceError("LEDGER_KIND_INVALID", "Ledger entry kind is invalid.");
  }
  if (direction !== "income" && direction !== "expense") {
    throw new ProjectFinanceError("LEDGER_DIRECTION_INVALID", "Ledger entry direction is invalid.");
  }
  if ((kind === "income" && direction !== "income") || (kind === "expense" && direction !== "expense")) {
    throw new ProjectFinanceError("COMMAND_INVALID", "Income and expense entries must use their matching direction.");
  }
  return Object.freeze({
    ...scope,
    id: requiredText(input.id, "id"),
    accountId: requiredText(input.accountId, "accountId"),
    kind,
    direction,
    amountMinor: positiveAmount(input.amountMinor),
    currency: CURRENCY_JPY,
    category: requiredText(input.category, "category"),
    memo: requiredText(input.memo, "memo"),
    projectId: optionalText(input.projectId, "projectId"),
    recordId: optionalText(input.recordId, "recordId"),
    sourceEventId: optionalText(input.sourceEventId, "sourceEventId"),
    occurredAt: validDate(input.occurredAt, "occurredAt"),
    idempotencyKey: boundedKey(input.idempotencyKey),
  });
}

export function deriveCashPosition(
  account: FinanceAccount,
  entries: readonly LedgerEntry[],
): CashPosition {
  const normalizedAccount = normalizeFinanceAccount(account);
  let incomeMinor = 0;
  let expenseMinor = 0;
  let adjustmentMinor = 0;
  for (const entry of entries) {
    assertSameScope(normalizedAccount, entry);
    requireCurrency(entry.currency);
    if (entry.accountId !== normalizedAccount.id) {
      throw new ProjectFinanceError("SCOPE_MISMATCH", "Ledger entry belongs to a different finance account.");
    }
    positiveAmount(entry.amountMinor);
    if (entry.kind === "income") incomeMinor = safeAdd(incomeMinor, entry.amountMinor);
    if (entry.kind === "expense") expenseMinor = safeAdd(expenseMinor, entry.amountMinor);
    if (entry.kind === "adjustment") {
      const signed = entry.direction === "income" ? entry.amountMinor : -entry.amountMinor;
      adjustmentMinor = safeAdd(adjustmentMinor, signed);
    }
  }
  const balanceMinor = safeAdd(
    safeAdd(normalizedAccount.openingBalanceMinor, incomeMinor - expenseMinor),
    adjustmentMinor,
  );
  return {
    currency: CURRENCY_JPY,
    openingBalanceMinor: normalizedAccount.openingBalanceMinor,
    incomeMinor,
    expenseMinor,
    adjustmentMinor,
    balanceMinor,
    entryCount: entries.length,
  };
}

/** Alias used by read-side projections: the balance is never a writable fact. */
export const deriveCashBalance = deriveCashPosition;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProjectFinanceError("IDENTIFIER_INVALID", `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalText(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredText(value, field);
}

function validDate(value: unknown, field: string): string {
  const normalized = requiredText(value, field);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new ProjectFinanceError("DATE_INVALID", `${field} must be an ISO-compatible date.`);
  }
  return normalized;
}

function boundedKey(value: unknown): string {
  const normalized = requiredText(value, "idempotencyKey");
  if (normalized.length > 128) {
    throw new ProjectFinanceError("COMMAND_INVALID", "idempotencyKey is too long.");
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
