import assert from "node:assert/strict";
import test from "node:test";

import {
  createProjectFinanceCommandService,
  ProjectFinanceCommandError,
  readRecordEvidence,
  type ExpenseCommandResult,
  type ProjectFinanceCommandStore,
} from "../modules/application/project-finance-command.ts";
import {
  deriveCashPosition,
  normalizeFinanceAccount,
  normalizeLedgerEntry,
  type FinanceAccount,
  type LedgerEntry,
} from "../modules/finance/public.ts";
import type { ProjectScope } from "../modules/projects/public.ts";

const scope: ProjectScope = {
  workspaceId: "ws_demo",
  worldId: "world_demo",
  worldlineId: "worldline_demo",
};

const account: FinanceAccount = normalizeFinanceAccount({
  ...scope,
  id: "account_main",
  currency: "JPY",
  status: "active",
  openingBalanceMinor: 100_000,
});

function memoryStore(): ProjectFinanceCommandStore & {
  entries: LedgerEntry[];
  commits: number;
  milestones: Map<string, string>;
  worldHead: { worldTick: number; worldOrdinal: number };
} {
  const entries: LedgerEntry[] = [];
  const groups = new Map<string, { fingerprint: string; result: unknown }>();
  const obligations = new Map<string, {
    obligationId: string;
    kind: "loan" | "presale" | "revenue_share";
    outstandingMinor: number;
    undeliveredCount: number;
    principalMinor: number;
  }>();
  const milestones = new Map<string, string>();
  const worldHead = { worldTick: 3, worldOrdinal: 4 };
  let commits = 0;
  const store: ProjectFinanceCommandStore & {
    entries: LedgerEntry[];
    commits: number;
    milestones: Map<string, string>;
    worldHead: { worldTick: number; worldOrdinal: number };
  } = {
    entries,
    milestones,
    worldHead,
    get commits() {
      return commits;
    },
    async loadCommand(commandScope, idempotencyKey) {
      const found = groups.get(`${commandScope.worldlineId}\0${idempotencyKey}`);
      return found
        ? { requestFingerprint: found.fingerprint, result: found.result as ExpenseCommandResult }
        : null;
    },
    async loadAccount(commandScope, accountId) {
      if (commandScope.worldlineId !== scope.worldlineId || accountId !== account.id) return null;
      return account;
    },
    async loadDefaultAccount(commandScope) {
      if (commandScope.worldlineId !== scope.worldlineId) return null;
      return account;
    },
    async loadLedger() {
      return entries.map((entry) => ({ ...entry }));
    },
    async commitExpense(input) {
      return this.commitLedger({
        ...input,
        kind: "expense",
        direction: "expense",
        eventKind: "finance.expense.recorded",
      });
    },
    async commitLedger(input) {
      commits += 1;
      const entry = normalizeLedgerEntry({
        ...input.scope,
        id: input.entryId,
        accountId: input.accountId,
        kind: input.kind,
        direction: input.direction,
        amountMinor: input.amountMinor,
        currency: "JPY",
        category: input.category,
        memo: input.memo,
        projectId: input.projectId,
        recordId: input.recordId,
        sourceEventId: input.sourceEventId,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
      });
      entries.push(entry);
      const result = {
        status: "committed" as const,
        commandGroupId: input.commandGroupId,
        entry,
        cash: deriveCashPosition(account, entries),
        eventKind: input.eventKind,
      };
      groups.set(`${input.scope.worldlineId}\0${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
      });
      return result;
    },
    async confirmMilestone(input) {
      const result = {
        status: "committed" as const,
        commandGroupId: input.commandGroupId,
        projectId: input.projectId,
        milestoneId: input.milestoneId,
        projectVersion: input.expectedProjectVersion + 1,
        eventKind: "project.milestone.confirmed" as const,
      };
      groups.set(`${input.scope.worldlineId}\0${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
      });
      return result;
    },
    async allocateBudget(input) {
      const result = {
        status: "committed" as const,
        commandGroupId: input.commandGroupId,
        projectId: input.projectId,
        category: input.category,
        amountMinor: input.amountMinor,
        version: input.expectedVersion === 0 ? 1 : input.expectedVersion + 1,
        eventKind: "finance.budget.allocated" as const,
      };
      groups.set(`${input.scope.worldlineId}\0${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
      });
      return result;
    },
    async changeStage(input) {
      const result = {
        status: "committed" as const,
        commandGroupId: input.commandGroupId,
        projectId: input.projectId,
        stage: input.stage,
        projectVersion: input.expectedProjectVersion + 1,
        eventKind: "project.stage.changed" as const,
        worldCursor: null,
      };
      groups.set(`${input.scope.worldlineId}\0${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
      });
      return result;
    },
    async applyRecordProjectFinance(input) {
      let balance = deriveCashPosition(account, entries).balanceMinor;
      const pendingEntries = [...entries];
      const pendingMilestones = new Map(milestones);
      const pendingHead = { ...worldHead };
      for (const action of input.actions) {
        if (action.command === "confirm_milestone") {
          pendingMilestones.set(action.milestoneId, "completed");
          if (input.evidence) {
            pendingHead.worldTick = input.evidence.expectedWorldCursor.worldTick;
            pendingHead.worldOrdinal = input.evidence.expectedWorldCursor.worldOrdinal + 1;
          }
          continue;
        }
        if (action.command !== "record_expense") continue;
        if (action.expectedBalanceMinor !== balance) {
          throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The cash position changed. Read it again before retrying.");
        }
        if (action.amountMinor > balance) {
          throw new ProjectFinanceCommandError("INSUFFICIENT_FUNDS", "The available balance cannot cover this entry.");
        }
        balance -= action.amountMinor;
        pendingEntries.push(normalizeLedgerEntry({
          ...input.scope,
          id: `${input.commandGroupId}:${pendingEntries.length}`,
          accountId: action.accountId ?? account.id,
          kind: "expense",
          direction: "expense",
          amountMinor: action.amountMinor,
          currency: "JPY",
          category: action.category,
          memo: action.memo,
          projectId: action.projectId ?? null,
          recordId: input.evidence?.recordId ?? null,
          sourceEventId: null,
          occurredAt: action.occurredAt,
          idempotencyKey: input.idempotencyKey,
        }));
      }
      entries.splice(0, entries.length, ...pendingEntries);
      milestones.clear();
      for (const [id, status] of pendingMilestones) milestones.set(id, status);
      worldHead.worldTick = pendingHead.worldTick;
      worldHead.worldOrdinal = pendingHead.worldOrdinal;
      const result = {
        status: "committed" as const,
        commandGroupId: input.commandGroupId,
        worldCursor: input.evidence ? { ...worldHead } : null,
      };
      groups.set(`${input.scope.worldlineId}\0${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
      });
      return result;
    },
    async createObligation(input) {
      const outstandingMinor = input.kind === "revenue_share" ? 0 : input.principalMinor;
      const result = {
        status: "committed" as const,
        commandGroupId: input.commandGroupId,
        obligationId: input.obligationId,
        kind: input.kind,
        outstandingMinor,
        undeliveredCount: input.undeliveredCount,
      };
      obligations.set(input.obligationId, { ...result, principalMinor: input.principalMinor });
      groups.set(`${input.scope.worldlineId}\0${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
      });
      return result;
    },
    async settleObligation(input) {
      const current = obligations.get(input.obligationId);
      if (!current) {
        throw new ProjectFinanceCommandError("OBLIGATION_NOT_FOUND", "The obligation is not available.");
      }
      if (current.outstandingMinor !== input.expectedOutstandingMinor) {
        throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The obligation changed. Read it again before retrying.");
      }
      const cash = deriveCashPosition(account, entries);
      if (cash.balanceMinor !== input.expectedBalanceMinor) {
        throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The cash position changed. Read it again before retrying.");
      }
      const direction = input.settlementKind === "draw" ? "income" as const : "expense" as const;
      if (direction === "expense" && input.amountMinor > cash.balanceMinor) {
        throw new ProjectFinanceCommandError("INSUFFICIENT_FUNDS", "The available balance cannot cover this entry.");
      }
      if (input.settlementKind === "repayment" && input.amountMinor > current.outstandingMinor) {
        throw new ProjectFinanceCommandError("COMMAND_INVALID", "Repayment exceeds the outstanding obligation.");
      }
      const entry = normalizeLedgerEntry({
        ...input.scope,
        id: input.entryId,
        accountId: input.accountId ?? account.id,
        kind: direction,
        direction,
        amountMinor: input.amountMinor,
        currency: "JPY",
        category: input.category,
        memo: input.memo,
        projectId: null,
        recordId: null,
        sourceEventId: null,
        occurredAt: input.occurredAt,
        idempotencyKey: input.idempotencyKey,
      });
      entries.push(entry);
      const outstandingMinor = input.settlementKind === "repayment"
        ? current.outstandingMinor - input.amountMinor
        : current.outstandingMinor;
      current.outstandingMinor = outstandingMinor;
      const result = {
        status: "committed" as const,
        commandGroupId: input.commandGroupId,
        obligationId: input.obligationId,
        kind: current.kind,
        outstandingMinor,
        undeliveredCount: current.undeliveredCount,
        cash: deriveCashPosition(account, entries),
      };
      groups.set(`${input.scope.worldlineId}\0${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
      });
      return result;
    },
  };
  return store;
}

test("records an expense from derived cash and ignores a client-supplied balance", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  const result = await service.recordExpense({
    scope,
    accountId: account.id,
    amountMinor: 12_000,
    category: "venue",
    memo: "Venue deposit",
    occurredAt: "2026-10-16T00:00:00.000Z",
    idempotencyKey: "expense-1",
    expectedBalanceMinor: 100_000,
    balanceMinor: 1,
  });

  assert.equal(result.status, "committed");
  assert.equal(result.entry.amountMinor, 12_000);
  assert.equal(result.cash.balanceMinor, 88_000);
  assert.equal(result.cash.expenseMinor, 12_000);
  assert.equal(result.eventKind, "finance.expense.recorded");
  assert.equal(store.entries.length, 1);
  assert.equal("balanceMinor" in result.entry, false);
});

test("rejects an expense that the derived balance cannot cover", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  await assert.rejects(
    service.recordExpense({
      scope,
      accountId: account.id,
      amountMinor: 100_001,
      category: "venue",
      memo: "Too expensive",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey: "expense-too-big",
      expectedBalanceMinor: 100_000,
    }),
    (error: unknown) => {
      if (!(error instanceof ProjectFinanceCommandError)) return false;
      return error.code === "INSUFFICIENT_FUNDS";
    },
  );
  assert.equal(store.entries.length, 0);
  assert.equal(store.commits, 0);
});

test("replays the same expense key and rejects a different payload", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  const first = await service.recordExpense({
    scope,
    accountId: account.id,
    amountMinor: 1_000,
    category: "venue",
    memo: "Deposit",
    occurredAt: "2026-10-16T00:00:00.000Z",
    idempotencyKey: "expense-replay",
    expectedBalanceMinor: 100_000,
  });
  const replay = await service.recordExpense({
    scope,
    accountId: account.id,
    amountMinor: 1_000,
    category: "venue",
    memo: "Deposit",
    occurredAt: "2026-10-16T00:00:00.000Z",
    idempotencyKey: "expense-replay",
    expectedBalanceMinor: 100_000,
  });
  assert.equal(replay.status, "replayed");
  assert.equal(replay.entry.id, first.entry.id);
  assert.equal(store.entries.length, 1);
  await assert.rejects(
    service.recordExpense({
      scope,
      accountId: account.id,
      amountMinor: 2_000,
      category: "venue",
      memo: "Deposit",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey: "expense-replay",
      expectedBalanceMinor: 99_000,
    }),
    (error: unknown) => {
      if (!(error instanceof ProjectFinanceCommandError)) return false;
      return error.code === "IDEMPOTENCY_KEY_REUSE";
    },
  );
  assert.equal(store.entries.length, 1);
});

test("records income against the only active account and ignores a client balance", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  const result = await service.recordIncome({
    scope,
    amountMinor: 20_000,
    category: "ticket",
    memo: "Presale",
    occurredAt: "2026-10-18T00:00:00.000Z",
    idempotencyKey: "income-1",
    expectedBalanceMinor: 100_000,
    balanceMinor: 1,
  });
  assert.equal(result.status, "committed");
  assert.equal(result.entry.direction, "income");
  assert.equal(result.cash.balanceMinor, 120_000);
  assert.equal(result.eventKind, "finance.income.recorded");
});

test("rejects an expense adjustment that would make cash negative", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  await assert.rejects(
    service.recordAdjustment({
      scope,
      accountId: account.id,
      direction: "expense",
      amountMinor: 100_001,
      category: "correction",
      memo: "Too large",
      occurredAt: "2026-10-18T00:00:00.000Z",
      idempotencyKey: "adjust-too-big",
      expectedBalanceMinor: 100_000,
    }),
    (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "INSUFFICIENT_FUNDS",
  );
  assert.equal(store.entries.length, 0);
});

test("confirms a milestone and allocates a budget without writing cash", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  const milestone = await service.confirmMilestone({
    scope,
    projectId: "project_first_live",
    milestoneId: "milestone_rehearsal",
    expectedProjectVersion: 1,
    idempotencyKey: "milestone-1",
  });
  assert.equal(milestone.status, "committed");
  assert.equal(milestone.projectVersion, 2);
  assert.equal(milestone.eventKind, "project.milestone.confirmed");
  const budget = await service.allocateBudget({
    scope,
    projectId: "project_first_live",
    category: "venue",
    amountMinor: 300_000,
    expectedVersion: 0,
    idempotencyKey: "budget-1",
  });
  assert.equal(budget.version, 1);
  assert.equal(budget.eventKind, "finance.budget.allocated");
  assert.equal(store.entries.length, 0);
});

test("changes stage once and rejects a reused key with a different stage", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  const first = await service.changeStage({
    scope,
    projectId: "project_first_live",
    stage: "funding",
    expectedProjectVersion: 1,
    idempotencyKey: "stage-1",
  });
  const replay = await service.changeStage({
    scope,
    projectId: "project_first_live",
    stage: "funding",
    expectedProjectVersion: 1,
    idempotencyKey: "stage-1",
  });
  assert.equal(first.projectVersion, 2);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.projectVersion, 2);
  assert.equal(replay.worldCursor, null);
  assert.equal(store.entries.length, 0);
  await assert.rejects(
    service.changeStage({
      scope,
      projectId: "project_first_live",
      stage: "production",
      expectedProjectVersion: 2,
      idempotencyKey: "stage-1",
    }),
    (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
});

test("rejects partial record evidence before any write", () => {
  assert.throws(
    () => readRecordEvidence({ recordId: "record_1", sceneId: "scene_1" }),
    (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "COMMAND_INVALID",
  );
  assert.equal(readRecordEvidence({}), null);
});

test("rolls back a combined milestone and expense when cash cannot cover it", async () => {
  const store = memoryStore();
  store.milestones.set("milestone_rehearsal", "active");
  const headBefore = { ...store.worldHead };
  const service = createProjectFinanceCommandService({ store });
  await assert.rejects(
    service.applyRecordProjectFinance({
      scope,
      idempotencyKey: "apply-short",
      evidence: {
        recordId: "record_live",
        sceneId: "scene_live",
        visibility: "public",
        expectedWorldCursor: headBefore,
      },
      actions: [
        {
          command: "confirm_milestone",
          projectId: "project_first_live",
          milestoneId: "milestone_rehearsal",
          expectedProjectVersion: 1,
        },
        {
          command: "record_expense",
          amountMinor: 100_001,
          category: "venue",
          memo: "Too expensive",
          occurredAt: "2026-10-16T00:00:00.000Z",
          expectedBalanceMinor: 100_000,
        },
      ],
    }),
    (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "INSUFFICIENT_FUNDS",
  );
  assert.equal(store.entries.length, 0);
  assert.equal(store.milestones.get("milestone_rehearsal"), "active");
  assert.deepEqual(store.worldHead, headBefore);
});

test("creating an obligation does not move cash, and an unaffordable repayment leaves it outstanding", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  const created = await service.createObligation({
    scope,
    idempotencyKey: "loan-1",
    kind: "loan",
    principalMinor: 200_000,
  });
  assert.equal(created.outstandingMinor, 200_000);
  assert.equal(store.entries.length, 0);
  const presale = await service.createObligation({
    scope,
    idempotencyKey: "presale-1",
    kind: "presale",
    principalMinor: 20_000,
    undeliveredCount: 3,
  });
  assert.equal(presale.undeliveredCount, 3);
  const share = await service.createObligation({
    scope,
    idempotencyKey: "share-1",
    kind: "revenue_share",
    principalMinor: 10_000,
    shareBps: 1_500,
  });
  assert.equal(share.outstandingMinor, 0);
  assert.equal(store.entries.length, 0);
  await assert.rejects(
    service.settleObligation({
      scope,
      idempotencyKey: "repay-too-big",
      obligationId: created.obligationId,
      settlementKind: "repayment",
      amountMinor: 150_000,
      expectedOutstandingMinor: 200_000,
      expectedBalanceMinor: 100_000,
      category: "loan",
      memo: "Repayment",
      occurredAt: "2026-10-16T00:00:00.000Z",
    }),
    (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "INSUFFICIENT_FUNDS",
  );
  const draw = await service.settleObligation({
    scope,
    idempotencyKey: "loan-draw",
    obligationId: created.obligationId,
    settlementKind: "draw",
      amountMinor: 40_000,
      expectedOutstandingMinor: 200_000,
    expectedBalanceMinor: 100_000,
    category: "loan",
    memo: "Draw",
    occurredAt: "2026-10-16T00:00:00.000Z",
  });
  assert.equal(draw.outstandingMinor, 200_000);
  assert.equal(draw.cash.balanceMinor, 140_000);
  const repaid = await service.settleObligation({
    scope,
    idempotencyKey: "loan-repay",
    obligationId: created.obligationId,
    settlementKind: "repayment",
      amountMinor: 15_000,
      expectedOutstandingMinor: 200_000,
    expectedBalanceMinor: 140_000,
    category: "loan",
    memo: "Repayment",
    occurredAt: "2026-10-16T00:00:00.000Z",
  });
  assert.equal(repaid.outstandingMinor, 185_000);
  assert.equal(repaid.cash.balanceMinor, 125_000);
});
