import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeFinanceAccount,
  normalizeLedgerEntry,
} from "../modules/finance/public.ts";
import {
  applyProjectFinanceRuntimeSnapshot,
  buildProjectFinanceRuntimeSnapshot,
  ProjectFinanceRuntimeSaveError,
  type ProjectFinanceRuntimeState,
} from "../modules/world-transfer/project-finance-runtime-save.ts";

const scope = {
  workspaceId: "ws_demo",
  worldId: "world_demo",
  worldlineId: "worldline_demo",
};

function state(): ProjectFinanceRuntimeState {
  const account = normalizeFinanceAccount({
    ...scope,
    id: "account_main",
    currency: "JPY",
    status: "active",
    openingBalanceMinor: 100_000,
  });
  const entry = normalizeLedgerEntry({
    ...scope,
    id: "entry_1",
    accountId: account.id,
    kind: "expense",
    direction: "expense",
    amountMinor: 12_000,
    currency: "JPY",
    category: "venue",
    memo: "Deposit",
    projectId: "project_1",
    recordId: "record_1",
    sourceEventId: "event_1",
    occurredAt: "2026-10-16T00:00:00.000Z",
    idempotencyKey: "expense-1",
  });
  return {
    accounts: [account],
    ledger: [entry],
    commandGroups: [{
      id: "group_1",
      idempotencyKey: "expense-1",
      requestFingerprint: "a".repeat(64),
    }],
    milestones: [{
      id: "milestone_1",
      projectId: "project_1",
      status: "completed",
      completionRecordId: "record_1",
      completionEventId: "event_1",
    }],
  };
}

test("project finance runtime save restores balance, idempotency, and milestone evidence", () => {
  const snapshot = buildProjectFinanceRuntimeSnapshot(scope, state());
  const empty: ProjectFinanceRuntimeState = {
    accounts: [],
    ledger: [],
    commandGroups: [],
    milestones: [],
  };
  const first = applyProjectFinanceRuntimeSnapshot(scope, empty, snapshot);
  assert.equal(first.status, "committed");
  assert.equal(first.balanceMinor, 88_000);
  assert.equal(first.state.ledger.length, 1);
  assert.equal(first.state.milestones[0]?.completionRecordId, "record_1");
  assert.equal(first.state.milestones[0]?.completionEventId, "event_1");
  const second = applyProjectFinanceRuntimeSnapshot(scope, first.state, snapshot);
  assert.equal(second.status, "replayed");
  assert.equal(second.state.ledger.length, 1);
  assert.equal(second.balanceMinor, 88_000);
  assert.throws(
    () => applyProjectFinanceRuntimeSnapshot(scope, first.state, {
      ...snapshot,
      commandGroups: [{
        id: "group_1",
        idempotencyKey: "expense-1",
        requestFingerprint: "b".repeat(64),
      }],
    }),
    (error: unknown) => error instanceof ProjectFinanceRuntimeSaveError && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
  assert.equal(first.state.ledger.length, 1);
});

test("project finance runtime save rejects a client balance", () => {
  const snapshot = buildProjectFinanceRuntimeSnapshot(scope, state());
  assert.throws(
    () => applyProjectFinanceRuntimeSnapshot(scope, {
      accounts: [],
      ledger: [],
      commandGroups: [],
      milestones: [],
    }, { ...snapshot, balanceMinor: 1 } as typeof snapshot),
    (error: unknown) => error instanceof ProjectFinanceRuntimeSaveError && error.code === "RUNTIME_SAVE_INVALID",
  );
});
