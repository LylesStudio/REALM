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
import { projectFinanceCommandFingerprintFor, type ProjectScope } from "../modules/projects/public.ts";
import { createReplayContext } from "../modules/application/command-replay-lineage.ts";

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
  const groups = new Map<string, { fingerprint: string; result: unknown; request: Readonly<Record<string, unknown>> }>();
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
        ? {
          requestFingerprint: found.fingerprint,
          result: found.result as ExpenseCommandResult,
          request: found.request,
        }
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
        request: input.request,
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
        ...(input.semanticEventKey ? { semanticEventKey: input.semanticEventKey } : {}),
      };
      groups.set(`${input.scope.worldlineId}\0${input.idempotencyKey}`, {
        fingerprint: input.requestFingerprint,
        result,
        request: input.request,
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
        request: input.request,
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
        request: input.request,
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
        request: input.request,
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
        request: input.request,
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
        request: input.request,
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

test("declared semantic event key is validated generically and covered by the idempotency fingerprint", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  const base = {
    scope,
    projectId: "project_first_live",
    milestoneId: "milestone_rehearsal",
    expectedProjectVersion: 1,
  };
  const milestone = await service.confirmMilestone({
    ...base,
    semanticEventKey: "harbor.festival.completed",
    idempotencyKey: "milestone-semantic",
  });
  assert.equal(milestone.status, "committed");
  const replay = await service.confirmMilestone({
    ...base,
    semanticEventKey: "harbor.festival.completed",
    idempotencyKey: "milestone-semantic",
  });
  assert.equal(replay.status, "replayed");
  // Same idempotency key but a different declared semantic key is key reuse.
  await assert.rejects(
    service.confirmMilestone({
      ...base,
      semanticEventKey: "harbor.festival.cancelled",
      idempotencyKey: "milestone-semantic",
    }),
    (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
  // Engine event kinds and malformed keys are rejected before any write.
  const invalid = [
    "project.milestone.confirmed",
    "Concert.Completed",
    "",
    "-leading",
    "double..dot",
    `k${"e".repeat(120)}y`,
  ];
  for (const [index, semanticEventKey] of invalid.entries()) {
    await assert.rejects(
      service.confirmMilestone({
        ...base,
        semanticEventKey,
        idempotencyKey: `milestone-invalid-${index}`,
      }),
      (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "COMMAND_INVALID",
    );
  }
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

test("legacy rows with an unprovable scope fingerprint fail closed", async () => {
  const store = memoryStore();
  const service = createProjectFinanceCommandService({ store });
  await service.recordExpense({
    scope,
    accountId: account.id,
    amountMinor: 1_000,
    category: "venue",
    memo: "Deposit",
    occurredAt: "2026-10-16T00:00:00.000Z",
    idempotencyKey: "legacy-expense",
    expectedBalanceMinor: 100_000,
  });
  await service.applyRecordProjectFinance({
    scope,
    idempotencyKey: "legacy-apply",
    actions: [{
      command: "record_expense",
      accountId: account.id,
      amountMinor: 100,
      category: "props",
      memo: "props",
      occurredAt: "2026-10-16T00:00:00.000Z",
      expectedBalanceMinor: 99_000,
    }],
  });
  // Simulate pre-provenance / legacy-restored rows: no canonical request and
  // a fingerprint that no longer matches the current scope.
  const legacyStore: ProjectFinanceCommandStore = {
    ...store,
    async loadCommand(commandScope, idempotencyKey) {
      const found = await store.loadCommand(commandScope, idempotencyKey);
      return found
        ? { ...found, request: null, requestFingerprint: "0".repeat(64) }
        : null;
    },
  };
  const before = structuredClone(store.entries);
  const legacy = createProjectFinanceCommandService({ store: legacyStore });
  await assert.rejects(legacy.recordExpense({
    scope,
    accountId: account.id,
    amountMinor: 1_000,
    category: "venue",
    memo: "Deposit",
    occurredAt: "2026-10-16T00:00:00.000Z",
    idempotencyKey: "legacy-expense",
    expectedBalanceMinor: 100_000,
  }), { code: "IDEMPOTENCY_KEY_REUSE" });
  // A changed candidate under the same legacy key is also refused.
  await assert.rejects(
    legacy.recordExpense({
      scope,
      accountId: account.id,
      amountMinor: 1_001,
      category: "venue",
      memo: "Deposit",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey: "legacy-expense",
      expectedBalanceMinor: 100_000,
    }),
    (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
  // A mismatched scope hash also refuses the original apply request.
  await assert.rejects(
    legacy.applyRecordProjectFinance({
      scope,
      idempotencyKey: "legacy-apply",
      actions: [{
        command: "record_expense",
        accountId: account.id,
        amountMinor: 100,
        category: "props",
        memo: "props",
        occurredAt: "2026-10-16T00:00:00.000Z",
        expectedBalanceMinor: 99_000,
      }],
    }),
    (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
  assert.deepEqual(store.entries, before, "unprovable replays leave ledger unchanged");
});


test("F2b3 all Finance service builders retain full canonical shapes under reverse replay", async () => {
  const targetScope = { ...scope, workspaceId: "ws_target", worldId: "world_target", worldlineId: "line_target" };
  const context = createReplayContext({ format: "realm-command-lineage-context", version: 1, family: "finance", originScope: scope, currentScope: targetScope,
    identities: { record: [["target_record", "record_one"]], scene: [["target_scene", "scene_one"]], project: [["target_project", "project_one"]],
      financeAccount: [["target_account", "account_main"]], milestone: [["target_milestone", "milestone_one"]], obligation: [["target_obligation", "obligation_one"]],
      event: [], characterInstance: [], assetDefinition: [] } });
  const evidence = { recordId: "record_one", sceneId: "scene_one", visibility: "public", worldTick: 0, worldOrdinal: 1 };
  const ledger = { accountId: "account_main", projectId: "project_one", recordId: "record_one", amountMinor: 100, category: "studio", memo: "memo",
    occurredAt: "2026-10-16T00:00:00.000Z", expectedBalanceMinor: 10000, evidence };
  const cases: { method: keyof ReturnType<typeof createProjectFinanceCommandService>; request: Record<string, unknown> & { command: string } }[] = [
    { method: "recordExpense", request: { command: "finance.expense.recorded", ...ledger } },
    { method: "recordExpense", request: { command: "finance.expense.recorded", ...ledger, accountId: null, projectId: null, recordId: null, evidence: null } },
    { method: "recordIncome", request: { command: "finance.income.recorded", ...ledger, direction: "income" } },
    ...(["income", "expense"] as const).map((direction) => ({ method: "recordAdjustment" as const, request: { command: "finance.adjustment.recorded", ...ledger, direction } })),
    { method: "confirmMilestone", request: { command: "project.milestone.confirmed", projectId: "project_one", milestoneId: "milestone_one", expectedProjectVersion: 1, evidence } },
    { method: "confirmMilestone", request: { command: "project.milestone.confirmed", projectId: "project_one", milestoneId: "milestone_one", expectedProjectVersion: 1, evidence, semanticEventKey: "finance.ready" } },
    { method: "changeStage", request: { command: "project.stage.changed", projectId: "project_one", stage: "production", expectedProjectVersion: 1, evidence } },
    { method: "allocateBudget", request: { command: "finance.budget.allocated", projectId: "project_one", amountMinor: 100, category: "studio", expectedVersion: 0 } },
    ...(["loan", "presale", "revenue_share"] as const).map((kind) => ({ method: "createObligation" as const, request: { command: "finance.obligation.created", projectId: "project_one",
      kind, principalMinor: 100, shareBps: kind === "revenue_share" ? 1200 : null, undeliveredCount: kind === "presale" ? 2 : 0 } })),
    ...(["repayment", "draw", "share"] as const).map((settlementKind) => ({ method: "settleObligation" as const, request: { command: "finance.obligation.settled", obligationId: "obligation_one",
      accountId: null, settlementKind, amountMinor: 10, expectedOutstandingMinor: 100, expectedBalanceMinor: 10000, category: "studio", occurredAt: "2026-10-16T00:00:00.000Z" } })),
    { method: "applyRecordProjectFinance", request: { command: "record.apply_project_finance", evidence, actions: [
      { command: "change_stage", projectId: "project_one", stage: "production", expectedProjectVersion: 1 },
      { command: "confirm_milestone", projectId: "project_one", milestoneId: "milestone_one", expectedProjectVersion: 2 },
      { command: "record_expense", accountId: null, projectId: "project_one", amountMinor: 10, category: "props", memo: "props", occurredAt: "2026-10-16T00:00:00.000Z", expectedBalanceMinor: 10000 },
    ] } },
  ];
  const mapped = (value: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...value };
    for (const [field, target] of [["accountId", "target_account"], ["projectId", "target_project"], ["recordId", "target_record"], ["sceneId", "target_scene"],
      ["milestoneId", "target_milestone"], ["obligationId", "target_obligation"]]) if (typeof next[field!] === "string") next[field!] = target;
    if (next.evidence) next.evidence = mapped(next.evidence as Record<string, unknown>);
    if (Array.isArray(next.actions)) next.actions = next.actions.map((action) => mapped(action as Record<string, unknown>));
    return next;
  };
  for (const item of cases) {
    const originalHash = projectFinanceCommandFingerprintFor(scope, item.request);
    const request = mapped(item.request);
    const input: Record<string, unknown> = { ...request, scope: targetScope, idempotencyKey: "original-key" }; delete input.command;
    if (input.evidence) {
      const ev = input.evidence as Record<string, unknown>;
      input.evidence = { recordId: ev.recordId, sceneId: ev.sceneId, visibility: ev.visibility, expectedWorldCursor: { worldTick: ev.worldTick, worldOrdinal: ev.worldOrdinal } };
    }
    if (item.method === "settleObligation") input.memo = "omitted from existing hash";
    let writes = 0;
    const forbidden = async (): Promise<never> => { writes++; throw new Error("unexpected commit"); };
    const store: ProjectFinanceCommandStore = { ...memoryStore(),
      loadCommand: async () => ({ requestFingerprint: originalHash, request: null, result: { status: "committed", commandGroupId: "stored_group" } as never,
        provenance: "legacy-result-v1", state: "committed", policyVersion: "project-finance-command.v1",
        replayProof: { binding: { version: 1, contextId: context.id, originalRequestFingerprint: originalHash }, context } }),
      commitExpense: forbidden, commitLedger: forbidden, confirmMilestone: forbidden, changeStage: forbidden,
      allocateBudget: forbidden, createObligation: forbidden, settleObligation: forbidden, applyRecordProjectFinance: forbidden,
    };
    const service = createProjectFinanceCommandService({ store });
    assert.equal((await Reflect.apply(service[item.method], service, [input])).status, "replayed", item.request.command);
    const changed = { ...input };
    if (Array.isArray(input.actions)) changed.actions = [...input.actions].reverse();
    else if (typeof input.amountMinor === "number") changed.amountMinor = input.amountMinor + 1;
    else if (typeof input.principalMinor === "number") changed.principalMinor = input.principalMinor + 1;
    else changed.expectedProjectVersion = Number(input.expectedProjectVersion) + 1;
    await assert.rejects(Reflect.apply(service[item.method], service, [changed]), { code: "IDEMPOTENCY_KEY_REUSE" });
    for (const patch of [{ state: "rejected" as const }, { policyVersion: "unsupported" }]) {
      const bad = createProjectFinanceCommandService({ store: { ...store, loadCommand: async (...args) => ({ ...(await store.loadCommand(...args))!, ...patch }) } });
      await assert.rejects(Reflect.apply(bad[item.method], bad, [input]), { code: "IDEMPOTENCY_KEY_REUSE" });
    }
    if (item.method === "settleObligation") assert.equal((await service.settleObligation({ ...input, memo: "changed still unhashed" } as never)).status, "replayed");
    assert.equal(writes, 0);
  }
});

test("A2 real store admits signed S0, refuses S1 and scoped evidence before writes, and replays original intent with policy offline", async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { installSignedRealmWorldFixture, syntheticCommandPolicyFixture } = await import("./helpers/realmworld-package-fixture.ts");
  const { serializeRealmWorldManifestSigningPayload } = await import("../modules/world-transfer/realmworld-manifest.ts");
  const { createInstalledRealmWorldCommandPolicyResolver } = await import("../modules/world-transfer/realmworld-command-policy.ts");
  const { createPostgresProjectFinanceCommandStore } = await import("../database/postgres/project-finance-command-repository.ts");
  const directory = await mkdtemp(join(tmpdir(), "a2-command-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync("ed25519"), keyPair = { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() };
  await installSignedRealmWorldFixture({ installRoot: directory, worldId: scope.worldId, version: "1.0.0", recordTitle: "Synthetic", keyId: "synthetic", keyPair,
    commandPolicy: syntheticCommandPolicyFixture(), declaredEvents: ["synthetic.ready"] });
  const resolver = createInstalledRealmWorldCommandPolicyResolver({ installRoot: directory, verifySignature: ({ manifest }) => verify(null,
    Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)), keyPair.publicKeyPem, Buffer.from(manifest.signature.value, "base64url")) });
  const policy = (await resolver({ worldId: scope.worldId, worldVersion: "1.0.0" }))!;
  type Options = { prior?: string; missingMap?: boolean; noResolver?: boolean; fakeResolver?: boolean; foreignStory?: boolean; privateSupport?: boolean; badVersion?: boolean; noSupport?: boolean };
  function fixture(options: Options = {}) {
    let state = { projectVersion: 1, milestone: "active", recordVersion: 1, nextOrdinal: 1, head: { worldTick: 2, worldOrdinal: 3 },
      completion: null as null | unknown[], events: [] as Record<string, unknown>[], groups: [] as Record<string, unknown>[] };
    let saved = structuredClone(state), offline = false; const history: string[] = [];
    const rows = (rows: Record<string, unknown>[]) => ({ rows, rowCount: rows.length });
    const client = { release() {}, async query(sql: string, args: unknown[] = []) {
      const q = sql.replace(/\s+/g, " ").trim(); history.push(q);
      if (q === "BEGIN" || q === "BEGIN READ ONLY") { saved = structuredClone(state); return rows([]); }
      if (q === "COMMIT") return rows([]);
      if (q === "ROLLBACK") { state = structuredClone(saved); return rows([]); }
      if (q === "SELECT set_config('realm.workspace_id', $1, true)" || q === "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))") return rows([]);
      if (q === "SELECT current_setting('transaction_isolation') AS isolation_level") return rows([{ isolation_level: "read committed" }]);
      if (q.startsWith("SELECT command.workspace_id,") && q.includes("FROM project_finance_command_groups AS command")) return rows(state.groups.filter(g => g.idempotency_key === args[3]));
      if (q === "SELECT status, version::text FROM projects WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4 FOR UPDATE") {
        assert.deepEqual(args, [scope.workspaceId, scope.worldId, scope.worldlineId, "project-a2"]); return rows([{ status: "active", version: String(state.projectVersion) }]);
      }
      if (q === "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR SHARE") {
        assert.deepEqual(args,[scope.workspaceId,scope.worldId]); return rows([{status:"active"}]);
      }
      if (q === "SELECT status FROM worldlines WHERE workspace_id = $1 AND world_id = $2 AND id = $3 FOR UPDATE") {
        assert.deepEqual(args,[scope.workspaceId,scope.worldId,scope.worldlineId]); return rows([{status:"active"}]);
      }
      if (q === "SELECT settings FROM worlds WHERE workspace_id = $1 AND id = $2") return rows([{ settings: { declaredEvents: ["synthetic.ready"] } }]);
      if (q === "SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available") { assert.deepEqual(args, []); return rows([{ command_materializations_available: true }]); }
      if (q.startsWith("SELECT schema_version, world_version, content_hash, policy_version,") && q.endsWith("ORDER BY project_key, milestone_key LIMIT 257")) {
        assert.deepEqual(args, [scope.workspaceId, scope.worldId, scope.worldlineId]);
        return rows(options.missingMap ? [] : ["target", "prior"].map(key => ({ schema_version: 1, world_version: "1.0.0", content_hash: policy.contentHash,
          policy_version: policy.policyVersion, project_key: "p", milestone_key: key, project_id: "project-a2", milestone_id: `milestone-${key}`,
          story_id: "story-a2", record_id: "record-a2", link_kind: "primary" })));
      }
      if (q === "SELECT world_version FROM public.command_policy_record_version_locked($1, $2, $3, $4, $5, $6)") {
        assert.deepEqual(args, [scope.workspaceId, scope.worldId, scope.worldlineId, "record-a2", "story-a2", "project-a2"]);
        return rows(options.foreignStory ? [] : [{ world_version: options.badVersion ? "2.0.0" : "1.0.0" }]);
      }
      if (q.startsWith("SELECT id, status, completion_record_id, completion_event_id FROM project_milestones") && q.endsWith("ORDER BY id FOR UPDATE")) {
        assert.deepEqual(args[4], ["milestone-prior", "milestone-target"]);
        return rows([{ id: "milestone-target", status: state.milestone, completion_record_id: null, completion_event_id: null },
          { id: "milestone-prior", status: options.prior ?? "completed", completion_record_id: "record-a2", completion_event_id: options.noSupport ? null : "event-prior" }]);
      }
      if (q.startsWith("SELECT e.id FROM events AS e") && q.includes("AND e.payload->>'milestoneId' = $7")) {
        assert.deepEqual(args, [scope.workspaceId, scope.worldId, scope.worldlineId, "record-a2", "event-prior", "project-a2", "milestone-prior"]);
        return rows(options.privateSupport ? [] : [{ id: "event-prior" }]);
      }
      if (q === "SELECT status FROM project_milestones WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND project_id = $4 AND id = $5 FOR UPDATE") return rows([{ status: state.milestone }]);
      if (q.startsWith("SELECT worldline.head_tick,") && q.endsWith("FOR UPDATE OF worldline")) return rows([{ head_tick: state.head.worldTick, head_ordinal: state.head.worldOrdinal, calendar_id: "calendar", display_time: "" }]);
      if (q === "SELECT status FROM records WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4") return rows(args[3] === "record-a2" ? [{ status: "active" }] : []);
      if (q === "SELECT id FROM scenes WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4 AND id = $5") return rows(args[4] === "scene-a2" ? [{ id: "scene-a2" }] : []);
      if (q.startsWith("SELECT id FROM visibility_policies WHERE workspace_id = $1") && q.endsWith("ORDER BY id LIMIT 1")) return rows(args[4] === "public" ? [{ id: "visibility-public" }] : []);
      if (q === "SELECT record_version::text, next_record_ordinal::text FROM record_heads WHERE workspace_id = $1 AND record_id = $2 FOR UPDATE") return rows([{ record_version: state.recordVersion, next_record_ordinal: state.nextOrdinal }]);
      if (q.startsWith("INSERT INTO events ( workspace_id, world_id, worldline_id, record_id, scene_id, id,")) { state.events.push({ id: args[5], recordId: args[3], payload: JSON.parse(String(args[14])) }); return rows([{}]); }
      if (q.startsWith("UPDATE record_heads SET record_version = $3,")) { state.recordVersion = Number(args[2]); state.nextOrdinal = Number(args[3]); return rows([{}]); }
      if (q.startsWith("UPDATE worldlines SET head_tick = $4,")) { state.head = { worldTick: Number(args[3]), worldOrdinal: Number(args[4]) }; return rows([{}]); }
      if (q.startsWith("UPDATE project_milestones SET status = 'completed', completion_record_id = $3,")) { state.milestone = "completed"; state.completion = [args[2], args[3]]; return rows([{}]); }
      if (q === "UPDATE projects SET version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE workspace_id = $1 AND id = $2 AND version = $3 RETURNING version::text") { state.projectVersion++; return rows([{ version: String(state.projectVersion) }]); }
      if (q.startsWith("INSERT INTO project_finance_command_groups ( workspace_id, world_id, worldline_id, id, idempotency_key,")) {
        state.groups.push({ workspace_id: args[0], world_id: args[1], worldline_id: args[2], id: args[3], idempotency_key: args[4], request_fingerprint: args[5],
          result_manifest: JSON.parse(String(args[6])), policy_version: args[7], state: "committed", receipt_oversized: false, anchor_row: null }); return rows([{}]);
      }
      throw new Error(`UNRECOGNIZED_SQL:${q}`);
    } };
    const store = createPostgresProjectFinanceCommandStore({ connect: async () => client } as unknown as import("../database/postgres/workspace-transaction.ts").WorkspaceDatabase,
      { resolveCommandPolicy: options.noResolver ? undefined : async () => { if (offline) throw new Error("package offline"); return options.fakeResolver ? { ...policy } : policy; } });
    const service = createProjectFinanceCommandService({ store });
    const command = { scope, projectId: "project-a2", milestoneId: "milestone-target", expectedProjectVersion: 1, idempotencyKey: "a2-strict",
      semanticEventKey: "synthetic.ready", evidence: { recordId: "record-a2", sceneId: "scene-a2", visibility: "public", expectedWorldCursor: { worldTick: 2, worldOrdinal: 3 } } as import("../modules/application/project-finance-command.ts").RecordEvidence };
    return { command, run: (change: Partial<typeof command> = {}) => service.confirmMilestone({ ...command, ...change }),
      snapshot: () => structuredClone(state), history, offline() { offline = true; } };
  }
  await t.test("signed S0 commits once and receipt-first replay ignores offline package", async () => {
    const f = fixture(), result = await f.run(); assert.equal(result.status, "committed");
    assert.deepEqual(result.requestPolicy, { schemaVersion: 1, contentHash: policy.contentHash, policyVersion: "synthetic.v1", bindingKey: "target.ready" });
    assert.equal(f.snapshot().events.length, 1); assert.equal(f.snapshot().groups.length, 1); assert.equal(f.snapshot().projectVersion, 2);
    f.offline(); const before = f.snapshot(); assert.equal((await f.run()).status, "replayed");
    for (const change of [{ semanticEventKey: "synthetic.other" }, { expectedProjectVersion: 2 }, { projectId: "other" }, { milestoneId: "other" },
      { evidence: { ...f.command.evidence, sceneId: "other" } }]) await assert.rejects(() => f.run(change), (e: unknown) => e instanceof ProjectFinanceCommandError && e.code === "IDEMPOTENCY_KEY_REUSE");
    assert.deepEqual(f.snapshot(), before);
  });
  for (const [name, options, code] of [
    ["only predecessor false S1", { prior: "active" }, "BUSINESS_PRECONDITION_FAILED"], ["no formal support", { noSupport: true }, "BUSINESS_PRECONDITION_FAILED"],
    ["private support", { privateSupport: true }, "BUSINESS_PRECONDITION_FAILED"], ["missing map", { missingMap: true }, "BUSINESS_POLICY_MISSING"],
    ["missing resolver", { noResolver: true }, "BUSINESS_POLICY_MISSING"], ["fake resolver", { fakeResolver: true }, "BUSINESS_POLICY_MISSING"],
    ["wrong version", { badVersion: true }, "BUSINESS_POLICY_MISSING"], ["foreign Story", { foreignStory: true }, "COMMAND_INVALID"],
  ] as const) await t.test(name, async () => {
    const f = fixture(options), before = f.snapshot(); await assert.rejects(f.run, (e: unknown) => e instanceof ProjectFinanceCommandError && e.code === code);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.history.some(q => /^(INSERT|UPDATE|DELETE) /.test(q)), false);
  });
  for (const [name, change, code] of [
    ["missing evidence", { evidence: undefined }, "COMMAND_INVALID"],
    ["foreign Record", { evidence: { recordId: "other" } }, "COMMAND_INVALID"], ["foreign Scene", { evidence: { sceneId: "other" } }, "COMMAND_INVALID"],
    ["restricted evidence", { evidence: { visibility: "restricted" } }, "COMMAND_INVALID"],
    ["old cursor", { evidence: { expectedWorldCursor: { worldTick: 2, worldOrdinal: 2 } } }, "WRITE_CONFLICT"],
    ["old project", { expectedProjectVersion: 2 }, "WRITE_CONFLICT"],
  ] as const) await t.test(name, async () => {
    const f = fixture(), before = f.snapshot();
    const override = "evidence" in change ? { evidence: change.evidence === undefined ? undefined : { ...f.command.evidence, ...change.evidence } } : change;
    await assert.rejects(() => f.run(override), (e: unknown) => e instanceof ProjectFinanceCommandError && e.code === code);
    assert.deepEqual(f.snapshot(), before); assert.equal(f.history.some(q => /^(INSERT|UPDATE|DELETE) /.test(q)), false);
  });
});
