import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectFinanceError,
  assertSameScope,
  deriveBudgetUsage,
  normalizeBudgetAllocation,
  normalizeProject,
  normalizeProjectMilestone,
  projectFinanceCommandFingerprintFor,
  projectFinanceCommandGroupIdFor,
  type ProjectScope,
} from "../modules/projects/public.ts";
import {
  deriveCashPosition,
  normalizeFinanceAccount,
  normalizeLedgerEntry,
  type FinanceAccount,
} from "../modules/finance/public.ts";

const scope: ProjectScope = {
  workspaceId: "ws_demo",
  worldId: "world_demo",
  worldlineId: "worldline_demo",
};
const otherScope: ProjectScope = { ...scope, worldlineId: "worldline_other" };

const account: FinanceAccount = normalizeFinanceAccount({
  ...scope,
  id: "account_main",
  currency: "JPY",
  status: "active",
  openingBalanceMinor: 100_000,
});

const entry = (overrides: Record<string, unknown> = {}) => normalizeLedgerEntry({
  ...scope,
  id: "entry_income",
  accountId: account.id,
  kind: "income",
  direction: "income",
  amountMinor: 30_000,
  currency: "JPY",
  category: "sponsorship",
  memo: "Initial committed income",
  occurredAt: "2026-10-15T00:00:00.000Z",
  idempotencyKey: "entry-income-1",
  ...overrides,
});

test("normalizes a generic Project, milestone, and budget allocation", () => {
  const project = normalizeProject({
    ...scope,
    id: "project_demo",
    kind: "production",
    status: "active",
    stage: "planning",
    title: "A bounded production project",
    version: 1,
  });
  assert.equal(project.currency, "JPY");
  assert.equal(Object.isFrozen(project), true);

  const milestone = normalizeProjectMilestone({
    ...scope,
    id: "milestone_prepare",
    projectId: project.id,
    sequence: 1,
    title: "Prepare the production",
    status: "planned",
  });
  assert.equal(milestone.status, "planned");

  const allocation = normalizeBudgetAllocation({
    ...scope,
    id: "budget_room",
    projectId: project.id,
    category: "venue",
    amountMinor: 50_000,
    currency: "JPY",
    version: 1,
  });
  assert.equal(allocation.amountMinor, 50_000);
});

test("rejects invalid statuses, kinds, zero/negative/fractional amounts, and non-JPY currency", () => {
  assert.throws(
    () => normalizeProject({ ...scope, id: "p", kind: "idol", status: "active", stage: "planning", title: "x", version: 1 }),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "PROJECT_KIND_INVALID",
  );
  assert.throws(
    () => normalizeProject({ ...scope, id: "p", kind: "production", status: "paused", stage: "planning", title: "x", version: 1 }),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "PROJECT_STATUS_INVALID",
  );
  for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => normalizeBudgetAllocation({
        ...scope,
        id: "budget_bad",
        projectId: "p",
        category: "venue",
        amountMinor,
        currency: "JPY",
        version: 1,
      }),
      (error: unknown) => error instanceof ProjectFinanceError && error.code === "AMOUNT_INVALID",
    );
  }
  assert.throws(
    () => normalizeFinanceAccount({ ...scope, id: "account", currency: "USD", status: "active", openingBalanceMinor: 0 }),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "CURRENCY_INVALID",
  );
  assert.throws(
    () => normalizeFinanceAccount({ ...scope, id: "account", currency: "JPY", status: "paused", openingBalanceMinor: 0 }),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "FINANCE_ACCOUNT_STATUS_INVALID",
  );
  assert.throws(
    () => entry({ kind: "unknown", id: "bad-kind" }),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "LEDGER_KIND_INVALID",
  );
  assert.throws(
    () => entry({ direction: "unknown", id: "bad-direction" }),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "LEDGER_DIRECTION_INVALID",
  );
});

test("scope is explicit and cross-worldline relationships fail closed", () => {
  assert.throws(
    () => assertSameScope(scope, otherScope),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "SCOPE_MISMATCH",
  );
  assert.throws(
    () => normalizeProjectMilestone({
      ...otherScope,
      projectScope: scope,
      id: "milestone_wrong_scope",
      projectId: "project_demo",
      sequence: 1,
      title: "Wrong scope",
      status: "planned",
    }),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "SCOPE_MISMATCH",
  );
});

test("ledger entries are positive append-only facts and cash is derived", () => {
  const entries = [
    entry(),
    entry({ id: "entry_expense", kind: "expense", direction: "expense", amountMinor: 12_000, category: "materials", idempotencyKey: "entry-expense-1" }),
    entry({ id: "entry_adjustment", kind: "adjustment", direction: "expense", amountMinor: 3_000, category: "correction", idempotencyKey: "entry-adjustment-1" }),
  ];
  const cash = deriveCashPosition(account, entries);
  assert.deepEqual(cash, {
    currency: "JPY",
    openingBalanceMinor: 100_000,
    incomeMinor: 30_000,
    expenseMinor: 12_000,
    adjustmentMinor: -3_000,
    balanceMinor: 115_000,
    entryCount: 3,
  });
  assert.throws(
    () => normalizeLedgerEntry({ ...scope, id: "bad", accountId: account.id, kind: "income", direction: "income", amountMinor: 0, currency: "JPY", category: "x", memo: "x", occurredAt: "2026-10-15T00:00:00.000Z", idempotencyKey: "bad" }),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "AMOUNT_INVALID",
  );
  assert.throws(
    () => deriveCashPosition(account, [entry({ ...otherScope, id: "cross_scope" })]),
    (error: unknown) => error instanceof ProjectFinanceError && error.code === "SCOPE_MISMATCH",
  );
});

test("budget usage derives actual expense from ledger facts, not a client progress field", () => {
  const projectId = "project_demo";
  const allocations = [
    normalizeBudgetAllocation({ ...scope, id: "budget_venue", projectId, category: "venue", amountMinor: 50_000, currency: "JPY", version: 1 }),
    normalizeBudgetAllocation({ ...scope, id: "budget_materials", projectId, category: "materials", amountMinor: 20_000, currency: "JPY", version: 1 }),
  ];
  const entries = [
    entry({ id: "project_expense", kind: "expense", direction: "expense", amountMinor: 12_000, projectId, category: "venue", idempotencyKey: "project-expense-1" }),
    entry({ id: "other_project_expense", kind: "expense", direction: "expense", amountMinor: 99_000, projectId: "other_project", category: "venue", idempotencyKey: "project-expense-2" }),
  ];
  assert.deepEqual(deriveBudgetUsage(scope, projectId, allocations, entries), {
    budgetedMinor: 70_000,
    spentMinor: 12_000,
    remainingMinor: 58_000,
    allocationCount: 2,
  });
});

test("command fingerprint and command-group identity are deterministic and scope-separated", () => {
  const first = projectFinanceCommandFingerprintFor(scope, {
    command: "record_expense",
    projectId: "project_demo",
    amountMinor: 1200,
    metadata: { b: 2, a: 1 },
  });
  const same = projectFinanceCommandFingerprintFor(scope, {
    metadata: { a: 1, b: 2 },
    amountMinor: 1200,
    projectId: "project_demo",
    command: "record_expense",
  });
  assert.equal(first, same);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, projectFinanceCommandFingerprintFor(otherScope, { command: "record_expense", projectId: "project_demo", amountMinor: 1200, metadata: { a: 1, b: 2 } }));
  assert.equal(
    projectFinanceCommandGroupIdFor(scope, "idempotency-1", first),
    projectFinanceCommandGroupIdFor(scope, "idempotency-1", first),
  );
  assert.notEqual(
    projectFinanceCommandGroupIdFor(scope, "idempotency-1", first),
    projectFinanceCommandGroupIdFor(scope, "idempotency-2", first),
  );
});
