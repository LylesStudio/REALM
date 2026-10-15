import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFinanceReadService,
  decodeLedgerCursor,
  encodeLedgerCursor,
  normalizeLedgerQuery,
  ProjectFinanceReadError,
  type ProjectFinanceReadProjection,
  type WorkbenchSnapshot,
} from "../modules/application/project-finance-read.ts";
import {
  toFinanceSummaryApi,
  toLedgerPageApi,
  toProjectDetailApi,
  toWorkbenchApi,
} from "../modules/application/project-finance-api-v1.ts";

const SCOPE = {
  workspaceId: "workspace_demo",
  worldId: "world_demo",
  worldlineId: "worldline_demo",
} as const;

const snapshot: WorkbenchSnapshot = {
  scope: SCOPE,
  readCursor: { tick: 7, ordinal: 11 },
  projectionVersion: 1,
  projects: [{
    workspaceId: SCOPE.workspaceId,
    worldId: SCOPE.worldId,
    worldlineId: SCOPE.worldlineId,
    id: "project_first_live",
    kind: "production",
    status: "active",
    stage: "production",
    title: "首演企划",
    currency: "JPY",
    version: 2,
    deadline: "2026-11-01",
    ownerId: "principal_private",
    budgetUsage: {
      budgetedMinor: 500_000,
      spentMinor: 120_000,
      remainingMinor: 380_000,
      allocationCount: 2,
    },
    milestoneSummary: { planned: 1, active: 1, completed: 0, cancelled: 0 },
    storyCount: 1,
    recordCount: 2,
  }],
  projectDetails: new Map(),
  finance: {
    currency: "JPY",
    cash: {
      currency: "JPY",
      openingBalanceMinor: 1_000_000,
      incomeMinor: 300_000,
      expenseMinor: 120_000,
      adjustmentMinor: 0,
      balanceMinor: 1_180_000,
      entryCount: 3,
    },
    accountCount: 1,
    byProject: [{
      projectId: "project_first_live",
      budgetUsage: {
        budgetedMinor: 500_000,
        spentMinor: 120_000,
        remainingMinor: 380_000,
        allocationCount: 2,
      },
    }],
  },
  activeStoryCount: 1,
  activeRecordCount: 2,
};

function fakeProjection(): ProjectFinanceReadProjection {
  return {
    async loadWorkbench() {
      return snapshot;
    },
    async loadProject() {
      return null;
    },
    async loadLedger() {
      return {
        readCursor: snapshot.readCursor,
        page: {
          entries: [{
            workspaceId: SCOPE.workspaceId,
            worldId: SCOPE.worldId,
            worldlineId: SCOPE.worldlineId,
            id: "ledger_income_1",
            accountId: "account_private",
            kind: "income",
            direction: "income",
            amountMinor: 300_000,
            currency: "JPY",
            category: "sponsor",
            memo: "赞助入账",
            projectId: "project_first_live",
            recordId: null,
            sourceEventId: "event_private",
            occurredAt: "2026-10-15T00:00:00.000Z",
            idempotencyKey: "private-key",
          }],
          nextCursor: null,
          hasMore: false,
        },
      };
    },
  };
}

test("ledger cursor round-trips and rejects malformed values", () => {
  const encoded = encodeLedgerCursor({
    occurredAt: "2026-10-15T00:00:00.000Z",
    id: "ledger_income_1",
  });
  assert.deepEqual(decodeLedgerCursor(encoded), {
    occurredAt: "2026-10-15T00:00:00.000Z",
    id: "ledger_income_1",
  });
  assert.throws(
    () => decodeLedgerCursor("not-a-valid-cursor"),
    (error: unknown) => error instanceof ProjectFinanceReadError
      && error.code === "CURSOR_INVALID",
  );
});

test("ledger query normalization bounds filters and page size", () => {
  assert.deepEqual(
    normalizeLedgerQuery({
      projectId: " project_first_live ",
      direction: "expense",
      limit: 25,
    }),
    { projectId: "project_first_live", direction: "expense", limit: 25, after: null },
  );
  assert.throws(
    () => normalizeLedgerQuery({ limit: 101 }),
    (error: unknown) => error instanceof ProjectFinanceReadError
      && error.code === "INVALID_REQUEST",
  );
});

test("read service validates resource ids before reaching the projection", async () => {
  let calls = 0;
  const service = createProjectFinanceReadService({
    projection: {
      ...fakeProjection(),
      async loadWorkbench() {
        calls += 1;
        return snapshot;
      },
    },
  });
  await assert.rejects(
    service.loadProject(SCOPE, ""),
    (error: unknown) => error instanceof ProjectFinanceReadError
      && error.code === "INVALID_REQUEST",
  );
  assert.equal(calls, 0);
  const result = await service.loadWorkbench(SCOPE);
  assert.equal(result.projects[0]?.id, "project_first_live");
});

test("player-safe API mappers omit workspace, owner, account, source and idempotency identities", () => {
  const workbench = toWorkbenchApi(snapshot);
  assert.deepEqual(workbench.meta, {
    worldId: "world_demo",
    worldlineId: "worldline_demo",
    readCursor: { tick: 7, ordinal: 11 },
    projectionVersion: 1,
  });
  assert.equal(Object.hasOwn(workbench.data.projects[0]!, "ownerId"), false);
  assert.equal(Object.hasOwn(workbench.data.projects[0]!, "workspaceId"), false);

  const finance = toFinanceSummaryApi(snapshot.finance);
  assert.equal(finance.accountCount, 1);
  assert.equal(Object.hasOwn(finance, "accounts"), false);

  const ledger = toLedgerPageApi(snapshot, {
    entries: [{
      workspaceId: SCOPE.workspaceId,
      worldId: SCOPE.worldId,
      worldlineId: SCOPE.worldlineId,
      id: "ledger_income_1",
      accountId: "account_private",
      kind: "income",
      direction: "income",
      amountMinor: 300_000,
      currency: "JPY",
      category: "sponsor",
      memo: "赞助入账",
      projectId: "project_first_live",
      recordId: null,
      sourceEventId: "event_private",
      occurredAt: "2026-10-15T00:00:00.000Z",
      idempotencyKey: "private-key",
    }],
    nextCursor: null,
    hasMore: false,
  });
  assert.equal(Object.hasOwn(ledger.data.entries[0]!, "accountId"), false);
  assert.equal(Object.hasOwn(ledger.data.entries[0]!, "sourceEventId"), false);
  assert.equal(Object.hasOwn(ledger.data.entries[0]!, "idempotencyKey"), false);
  assert.equal(typeof toProjectDetailApi, "function");
});
