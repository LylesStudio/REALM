import type { PoolClient, QueryResultRow } from "pg";

import {
  ProjectFinanceCommandError,
  PROJECT_FINANCE_COMMAND_POLICY_VERSION,
  type BudgetCommandResult,
  type ExpenseCommandResult,
  type ExpenseCommitInput,
  type LedgerCommitInput,
  type ApplyProjectFinanceResult,
  type MilestoneCommandResult,
  type ObligationResult,
  type ProjectFinanceCommandStore,
  type RecordEvidence,
  type StageChangeInput,
  type StageCommandResult,
  type StoredCommandResult,
} from "../../modules/application/project-finance-command.ts";
import {
  deriveCashPosition,
  normalizeFinanceAccount,
  normalizeLedgerEntry,
  type FinanceAccount,
  type LedgerEntry,
} from "../../modules/finance/public.ts";
import type { ProjectScope } from "../../modules/projects/public.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

interface AccountRow extends QueryResultRow {
  workspace_id: string;
  world_id: string;
  worldline_id: string;
  id: string;
  currency: string;
  status: string;
  opening_balance_minor: string | number;
}

interface LedgerRow extends QueryResultRow {
  workspace_id: string;
  world_id: string;
  worldline_id: string;
  id: string;
  account_id: string;
  kind: string;
  direction: string;
  amount_minor: string | number;
  currency: string;
  category: string;
  memo: string;
  project_id: string | null;
  source_record_id: string | null;
  source_event_id: string | null;
  occurred_at: string;
  idempotency_key: string;
}

interface CommandRow extends QueryResultRow {
  request_fingerprint: string;
  result_manifest: StoredCommandResult;
}

const LEDGER_SQL = `SELECT workspace_id, world_id, worldline_id, id,
  account_id, kind, direction, amount_minor, currency,
  category, memo, project_id, source_record_id, source_event_id,
  occurred_at::text AS occurred_at, idempotency_key
  FROM ledger_entries
  WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND account_id = $4
  ORDER BY occurred_at ASC, id ASC`;

export function createPostgresProjectFinanceCommandStore(
  database: WorkspaceDatabase,
): ProjectFinanceCommandStore {
  return {
    async loadCommand(scope, idempotencyKey) {
      return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
        return readCommand(client, scope, idempotencyKey);
      }, { readOnly: true });
    },
    async loadAccount(scope, accountId) {
      return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
        return readAccount(client, scope, accountId, false);
      }, { readOnly: true });
    },
    async loadLedger(scope, accountId) {
      return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
        return readLedger(client, scope, accountId);
      }, { readOnly: true });
    },
    async commitExpense(input) {
      return commitLedgerEntry(database, {
        ...input,
        kind: "expense",
        direction: "expense",
        eventKind: "finance.expense.recorded",
      }, true);
    },
    async loadDefaultAccount(scope) {
      return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
        const result = await client.query<AccountRow>(
          `SELECT workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
           FROM finance_accounts
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND status = 'active'
           ORDER BY id
           LIMIT 2`,
          [scope.workspaceId, scope.worldId, scope.worldlineId],
        );
        if (result.rows.length !== 1) return null;
        const row = result.rows[0]!;
        return normalizeFinanceAccount({
          workspaceId: row.workspace_id,
          worldId: row.world_id,
          worldlineId: row.worldline_id,
          id: row.id,
          currency: row.currency,
          status: row.status,
          openingBalanceMinor: Number(row.opening_balance_minor),
        });
      }, { readOnly: true });
    },
    async commitLedger(input) {
      return commitLedgerEntry(database, input, input.kind === "expense" || (input.kind === "adjustment" && input.direction === "expense"));
    },
    async confirmMilestone(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new ProjectFinanceCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
          }
          return { ...(existing.result as unknown as MilestoneCommandResult), status: "replayed" as const };
        }
        const project = await client.query<{ status: string; version: string }>(
          `SELECT status, version::text
           FROM projects
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4
           FOR UPDATE`,
          [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.projectId],
        );
        const projectRow = project.rows[0];
        if (!projectRow) {
          throw new ProjectFinanceCommandError("PROJECT_NOT_FOUND", "The project is not available.");
        }
        if (projectRow.status !== "planned" && projectRow.status !== "active") {
          throw new ProjectFinanceCommandError("PROJECT_NOT_ACTIVE", "The project cannot accept a milestone confirmation.");
        }
        if (Number(projectRow.version) !== input.expectedProjectVersion) {
          throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The project changed. Read it again before retrying.");
        }
        const milestone = await client.query<{ status: string }>(
          `SELECT status
           FROM project_milestones
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND project_id = $4 AND id = $5
           FOR UPDATE`,
          [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.projectId, input.milestoneId],
        );
        const milestoneRow = milestone.rows[0];
        if (!milestoneRow) {
          throw new ProjectFinanceCommandError("MILESTONE_NOT_FOUND", "The milestone is not available.");
        }
        if (milestoneRow.status !== "planned" && milestoneRow.status !== "active") {
          throw new ProjectFinanceCommandError("MILESTONE_NOT_OPEN", "The milestone is not open for confirmation.");
        }
        const evidenceEvent = input.evidence
          ? await writeRecordEvidence(client, input.scope, input.evidence, "project.milestone.confirmed", `${input.commandGroupId}:milestone-event`)
          : null;
        const updatedMilestone = await client.query(
          `UPDATE project_milestones
           SET status = 'completed',
               completion_record_id = $3,
               completion_event_id = $4,
               updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND id = $2 AND status IN ('planned', 'active')`,
          [input.scope.workspaceId, input.milestoneId, evidenceEvent?.recordId ?? null, evidenceEvent?.eventId ?? null],
        );
        if (updatedMilestone.rowCount !== 1) {
          throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The milestone changed. Read it again before retrying.");
        }
        const updatedProject = await client.query<{ version: string }>(
          `UPDATE projects
           SET version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND id = $2 AND version = $3
           RETURNING version::text`,
          [input.scope.workspaceId, input.projectId, input.expectedProjectVersion],
        );
        const version = Number(updatedProject.rows[0]?.version);
        if (!Number.isInteger(version)) {
          throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The project changed. Read it again before retrying.");
        }
        const result: MilestoneCommandResult = {
          status: "committed",
          commandGroupId: input.commandGroupId,
          projectId: input.projectId,
          milestoneId: input.milestoneId,
          projectVersion: version,
          eventKind: "project.milestone.confirmed",
          ...(evidenceEvent ? { worldCursor: evidenceEvent.worldCursor } : {}),
        };
        await insertCommandGroup(client, input, result, evidenceEvent?.recordId ?? null);
        return result;
      });
    },
    async allocateBudget(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new ProjectFinanceCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
          }
          return { ...(existing.result as unknown as BudgetCommandResult), status: "replayed" as const };
        }
        const project = await client.query<{ status: string }>(
          `SELECT status FROM projects
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
          [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.projectId],
        );
        if (!project.rows[0]) {
          throw new ProjectFinanceCommandError("PROJECT_NOT_FOUND", "The project is not available.");
        }
        if (project.rows[0].status !== "planned" && project.rows[0].status !== "active") {
          throw new ProjectFinanceCommandError("PROJECT_NOT_ACTIVE", "The project cannot accept a budget allocation.");
        }
        const current = await client.query<{ id: string; version: string }>(
          `SELECT id, version::text
           FROM budget_allocations
           WHERE workspace_id = $1 AND project_id = $2 AND category = $3
           FOR UPDATE`,
          [input.scope.workspaceId, input.projectId, input.category],
        );
        const currentRow = current.rows[0];
        let version = 1;
        if (!currentRow) {
          if (input.expectedVersion !== 0) {
            throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The budget allocation changed. Read it again before retrying.");
          }
          await client.query(
            `INSERT INTO budget_allocations (
               workspace_id, world_id, worldline_id, id, project_id,
               category, amount_minor, currency, version
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'JPY', 1)`,
            [
              input.scope.workspaceId,
              input.scope.worldId,
              input.scope.worldlineId,
              input.allocationId,
              input.projectId,
              input.category,
              input.amountMinor,
            ],
          );
        } else {
          if (Number(currentRow.version) !== input.expectedVersion) {
            throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The budget allocation changed. Read it again before retrying.");
          }
          const updated = await client.query<{ version: string }>(
            `UPDATE budget_allocations
             SET amount_minor = $4, version = version + 1, updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND version = $3
             RETURNING version::text`,
            [input.scope.workspaceId, currentRow.id, input.expectedVersion, input.amountMinor],
          );
          version = Number(updated.rows[0]?.version);
          if (!Number.isInteger(version)) {
            throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The budget allocation changed. Read it again before retrying.");
          }
        }
        const result: BudgetCommandResult = {
          status: "committed",
          commandGroupId: input.commandGroupId,
          projectId: input.projectId,
          category: input.category,
          amountMinor: input.amountMinor,
          version,
          eventKind: "finance.budget.allocated",
        };
        await insertCommandGroup(client, input, result, null);
        return result;
      });
    },
    async changeStage(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new ProjectFinanceCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
          }
          return { ...(existing.result as unknown as StageCommandResult), status: "replayed" as const };
        }
        const applied = await applyStageChange(client, input);
        await insertCommandGroup(client, input, applied, applied.worldCursor ? input.evidence?.recordId ?? null : null);
        return applied;
      });
    },
    async applyRecordProjectFinance(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new ProjectFinanceCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
          }
          return { ...(existing.result as unknown as ApplyProjectFinanceResult), status: "replayed" as const };
        }
        let evidence = input.evidence;
        let worldCursor: { worldTick: number; worldOrdinal: number } | null = null;
        for (const [index, action] of input.actions.entries()) {
          if (action.command === "change_stage") {
            const applied = await applyStageChange(client, {
              scope: input.scope,
              commandGroupId: input.commandGroupId,
              requestFingerprint: input.requestFingerprint,
              idempotencyKey: input.idempotencyKey,
              projectId: action.projectId,
              stage: action.stage,
              expectedProjectVersion: action.expectedProjectVersion,
              evidence,
              eventId: `${input.commandGroupId}:event:${index}`,
            });
            evidence = advanceEvidence(evidence, applied.worldCursor);
            worldCursor = applied.worldCursor ?? worldCursor;
            continue;
          }
          if (action.command === "confirm_milestone") {
            const applied = await applyMilestone(client, {
              scope: input.scope,
              projectId: action.projectId,
              milestoneId: action.milestoneId,
              expectedProjectVersion: action.expectedProjectVersion,
              evidence,
              eventId: `${input.commandGroupId}:event:${index}`,
            });
            evidence = advanceEvidence(evidence, applied.worldCursor);
            worldCursor = applied.worldCursor ?? worldCursor;
            continue;
          }
          const accountId = action.accountId ?? await defaultAccountId(client, input.scope);
          const applied = await insertLedgerRow(client, {
            scope: input.scope,
            commandGroupId: input.commandGroupId,
            requestFingerprint: input.requestFingerprint,
            idempotencyKey: `${input.idempotencyKey}:${index}`,
            accountId,
            entryId: `${input.commandGroupId}:entry:${index}`,
            sourceEventId: `${input.commandGroupId}:event:${index}`,
            amountMinor: action.amountMinor,
            category: action.category,
            memo: action.memo,
            projectId: action.projectId ?? null,
            recordId: evidence?.recordId ?? null,
            occurredAt: action.occurredAt,
            expectedBalanceMinor: action.expectedBalanceMinor,
            evidence,
            kind: "expense",
            direction: "expense",
            eventKind: "finance.expense.recorded",
          }, true);
          evidence = advanceEvidence(evidence, applied.worldCursor ?? null);
          worldCursor = applied.worldCursor ?? worldCursor;
        }
        const result: ApplyProjectFinanceResult = {
          status: "committed",
          commandGroupId: input.commandGroupId,
          worldCursor,
        };
        await insertCommandGroup(client, input, result, input.evidence?.recordId ?? null);
        return result;
      });
    },
    async createObligation(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new ProjectFinanceCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
          }
          return { ...(existing.result as unknown as ObligationResult), status: "replayed" as const };
        }
        if (input.projectId) {
          await requireActiveProject(client, input.scope, input.projectId);
        }
        const outstandingMinor = input.kind === "revenue_share" ? 0 : input.principalMinor;
        await client.query(
          `INSERT INTO obligations (
             workspace_id, world_id, worldline_id, id, project_id,
             kind, status, principal_minor, outstanding_minor, share_bps, undelivered_count
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, 'open', $7, $8, $9, $10
           )`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.obligationId,
            input.projectId,
            input.kind,
            input.principalMinor,
            outstandingMinor,
            input.shareBps,
            input.undeliveredCount,
          ],
        );
        const result: ObligationResult = {
          status: "committed",
          commandGroupId: input.commandGroupId,
          obligationId: input.obligationId,
          kind: input.kind,
          outstandingMinor,
          undeliveredCount: input.undeliveredCount,
        };
        await insertCommandGroup(client, input, result, null);
        return result;
      });
    },
    async settleObligation(input) {
      return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
        const existing = await readCommand(client, input.scope, input.idempotencyKey);
        if (existing) {
          if (existing.requestFingerprint !== input.requestFingerprint) {
            throw new ProjectFinanceCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
          }
          return {
            ...(existing.result as ObligationResult & { cash: ReturnType<typeof deriveCashPosition> }),
            status: "replayed" as const,
          };
        }
        const obligation = await client.query<{
          kind: "loan" | "presale" | "revenue_share";
          status: string;
          principal_minor: string;
          outstanding_minor: string;
          undelivered_count: string;
          version: string;
        }>(
          `SELECT kind, status, principal_minor::text, outstanding_minor::text, undelivered_count::text, version::text
           FROM obligations
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4
           FOR UPDATE`,
          [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.obligationId],
        );
        const row = obligation.rows[0];
        if (!row) {
          throw new ProjectFinanceCommandError("OBLIGATION_NOT_FOUND", "The obligation is not available.");
        }
        if (row.status !== "open") {
          throw new ProjectFinanceCommandError("OBLIGATION_NOT_OPEN", "The obligation is not open.");
        }
        const outstanding = Number(row.outstanding_minor);
        if (outstanding !== input.expectedOutstandingMinor) {
          throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The obligation changed. Read it again before retrying.");
        }
        const nextOutstanding = nextObligationOutstanding(row.kind, input.settlementKind, outstanding, Number(row.principal_minor), input.amountMinor);
        const direction = input.settlementKind === "draw" ? "income" : "expense";
        const accountId = input.accountId ?? await defaultAccountId(client, input.scope);
        const ledger = await insertLedgerRow(client, {
          scope: input.scope,
          commandGroupId: input.commandGroupId,
          requestFingerprint: input.requestFingerprint,
          idempotencyKey: input.idempotencyKey,
          accountId,
          entryId: input.entryId,
          sourceEventId: `${input.commandGroupId}:event`,
          amountMinor: input.amountMinor,
          category: input.category,
          memo: input.memo,
          projectId: null,
          recordId: null,
          occurredAt: input.occurredAt,
          expectedBalanceMinor: input.expectedBalanceMinor,
          evidence: null,
          kind: direction,
          direction,
          eventKind: direction === "income" ? "finance.income.recorded" : "finance.expense.recorded",
        }, direction === "expense");
        await client.query(
          `INSERT INTO obligation_settlements (
             workspace_id, world_id, worldline_id, id, obligation_id,
             ledger_entry_id, kind, amount_minor
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            input.scope.workspaceId,
            input.scope.worldId,
            input.scope.worldlineId,
            input.settlementId,
            input.obligationId,
            ledger.entry.id,
            input.settlementKind,
            input.amountMinor,
          ],
        );
        const status = row.kind === "loan" && nextOutstanding === 0 ? "settled" : "open";
        const updated = await client.query(
          `UPDATE obligations
           SET outstanding_minor = $4, status = $5, version = version + 1, updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND id = $2 AND version = $3`,
          [input.scope.workspaceId, input.obligationId, Number(row.version), nextOutstanding, status],
        );
        if (updated.rowCount !== 1) {
          throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The obligation changed. Read it again before retrying.");
        }
        const result = {
          status: "committed" as const,
          commandGroupId: input.commandGroupId,
          obligationId: input.obligationId,
          kind: row.kind,
          outstandingMinor: nextOutstanding,
          undeliveredCount: Number(row.undelivered_count),
          cash: ledger.cash,
        };
        await insertCommandGroup(client, input, result, null);
        return result;
      });
    },
  };
}

async function readCommand(
  client: PoolClient,
  scope: ProjectScope,
  idempotencyKey: string,
): Promise<{ requestFingerprint: string; result: StoredCommandResult } | null> {
  const result = await client.query<CommandRow>(
    `SELECT request_fingerprint, result_manifest
     FROM project_finance_command_groups
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND idempotency_key = $4`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    requestFingerprint: row.request_fingerprint,
    result: row.result_manifest,
  };
}

async function readAccount(
  client: PoolClient,
  scope: ProjectScope,
  accountId: string,
  lock: boolean,
): Promise<FinanceAccount | null> {
  if (lock) {
    await client.query(
      `UPDATE finance_accounts
       SET updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
      [scope.workspaceId, scope.worldId, scope.worldlineId, accountId],
    );
  }
  const result = await client.query<AccountRow>(
    `SELECT workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
     FROM finance_accounts
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, accountId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return normalizeFinanceAccount({
    workspaceId: row.workspace_id,
    worldId: row.world_id,
    worldlineId: row.worldline_id,
    id: row.id,
    currency: row.currency,
    status: row.status,
    openingBalanceMinor: Number(row.opening_balance_minor),
  });
}

async function readLedger(
  client: PoolClient,
  scope: ProjectScope,
  accountId: string,
): Promise<LedgerEntry[]> {
  const result = await client.query<LedgerRow>(LEDGER_SQL, [
    scope.workspaceId,
    scope.worldId,
    scope.worldlineId,
    accountId,
  ]);
  return result.rows.map((row) => normalizeLedgerEntry({
    workspaceId: row.workspace_id,
    worldId: row.world_id,
    worldlineId: row.worldline_id,
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    direction: row.direction,
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    category: row.category,
    memo: row.memo,
    projectId: row.project_id,
    recordId: row.source_record_id,
    sourceEventId: row.source_event_id,
    occurredAt: row.occurred_at,
    idempotencyKey: row.idempotency_key,
  }));
}

export type { ExpenseCommitInput };

async function commitLedgerEntry(
  database: WorkspaceDatabase,
  input: LedgerCommitInput,
  enforceFunds: boolean,
): Promise<ExpenseCommandResult> {
  return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
    const existing = await readCommand(client, input.scope, input.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== input.requestFingerprint) {
        throw new ProjectFinanceCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
      }
      return { ...(existing.result as ExpenseCommandResult), status: "replayed" };
    }
    const account = await readAccount(client, input.scope, input.accountId, true);
    if (!account || account.status !== "active") {
      throw new ProjectFinanceCommandError("FINANCE_ACCOUNT_NOT_FOUND", "The finance account is not available.");
    }
    const ledger = await readLedger(client, input.scope, account.id);
    const cash = deriveCashPosition(account, ledger);
    if (cash.balanceMinor !== input.expectedBalanceMinor) {
      throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The cash position changed. Read it again before retrying.");
    }
    if (enforceFunds && input.amountMinor > cash.balanceMinor) {
      throw new ProjectFinanceCommandError("INSUFFICIENT_FUNDS", "The available balance cannot cover this entry.");
    }
    const result = await insertLedgerRow(client, input, false);
    await insertCommandGroup(client, input, result, input.evidence?.recordId ?? input.recordId);
    return result;
  });
}

async function insertCommandGroup(
  client: PoolClient,
  input: { scope: { workspaceId: string; worldId: string; worldlineId: string }; commandGroupId: string; idempotencyKey: string; requestFingerprint: string },
  result: StoredCommandResult | (ObligationResult & { cash: ReturnType<typeof deriveCashPosition> }),
  recordId: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO project_finance_command_groups (
       workspace_id, world_id, worldline_id, id, idempotency_key,
       request_fingerprint, state, result_manifest, policy_version,
       source_record_id, completed_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, 'committed', $7::jsonb, $8,
       $9, CURRENT_TIMESTAMP
     )`,
    [
      input.scope.workspaceId,
      input.scope.worldId,
      input.scope.worldlineId,
      input.commandGroupId,
      input.idempotencyKey,
      input.requestFingerprint,
      JSON.stringify(result),
      PROJECT_FINANCE_COMMAND_POLICY_VERSION,
      recordId,
    ],
  );
}

async function applyStageChange(
  client: PoolClient,
  input: StageChangeInput & { eventId?: string },
): Promise<StageCommandResult> {
  const project = await client.query<{ status: string; version: string }>(
    `SELECT status, version::text
     FROM projects
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4
     FOR UPDATE`,
    [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.projectId],
  );
  const projectRow = project.rows[0];
  if (!projectRow) {
    throw new ProjectFinanceCommandError("PROJECT_NOT_FOUND", "The project is not available.");
  }
  if (projectRow.status !== "planned" && projectRow.status !== "active") {
    throw new ProjectFinanceCommandError("PROJECT_NOT_ACTIVE", "The project cannot change stage.");
  }
  if (Number(projectRow.version) !== input.expectedProjectVersion) {
    throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The project changed. Read it again before retrying.");
  }
  const evidenceEvent = input.evidence
    ? await writeRecordEvidence(
      client,
      input.scope,
      input.evidence,
      "project.stage.changed",
      input.eventId ?? `${input.commandGroupId}:stage-event`,
    )
    : null;
  const updated = await client.query<{ version: string }>(
    `UPDATE projects
     SET stage = $4, version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1 AND id = $2 AND version = $3
     RETURNING version::text`,
    [input.scope.workspaceId, input.projectId, input.expectedProjectVersion, input.stage],
  );
  const version = Number(updated.rows[0]?.version);
  if (!Number.isInteger(version)) {
    throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The project changed. Read it again before retrying.");
  }
  return {
    status: "committed",
    commandGroupId: input.commandGroupId,
    projectId: input.projectId,
    stage: input.stage,
    projectVersion: version,
    eventKind: "project.stage.changed",
    worldCursor: evidenceEvent?.worldCursor ?? null,
  };
}

async function applyMilestone(
  client: PoolClient,
  input: {
    scope: ProjectScope;
    projectId: string;
    milestoneId: string;
    expectedProjectVersion: number;
    evidence: RecordEvidence | null;
    eventId: string;
  },
): Promise<{ projectVersion: number; worldCursor: { worldTick: number; worldOrdinal: number } | null }> {
  const project = await client.query<{ status: string; version: string }>(
    `SELECT status, version::text
     FROM projects
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4
     FOR UPDATE`,
    [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.projectId],
  );
  const projectRow = project.rows[0];
  if (!projectRow) {
    throw new ProjectFinanceCommandError("PROJECT_NOT_FOUND", "The project is not available.");
  }
  if (projectRow.status !== "planned" && projectRow.status !== "active") {
    throw new ProjectFinanceCommandError("PROJECT_NOT_ACTIVE", "The project cannot accept a milestone confirmation.");
  }
  if (Number(projectRow.version) !== input.expectedProjectVersion) {
    throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The project changed. Read it again before retrying.");
  }
  const milestone = await client.query<{ status: string }>(
    `SELECT status
     FROM project_milestones
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND project_id = $4 AND id = $5
     FOR UPDATE`,
    [input.scope.workspaceId, input.scope.worldId, input.scope.worldlineId, input.projectId, input.milestoneId],
  );
  if (!milestone.rows[0]) {
    throw new ProjectFinanceCommandError("MILESTONE_NOT_FOUND", "The milestone is not available.");
  }
  if (milestone.rows[0].status !== "planned" && milestone.rows[0].status !== "active") {
    throw new ProjectFinanceCommandError("MILESTONE_NOT_OPEN", "The milestone is not open for confirmation.");
  }
  const evidenceEvent = input.evidence
    ? await writeRecordEvidence(client, input.scope, input.evidence, "project.milestone.confirmed", input.eventId)
    : null;
  const updatedMilestone = await client.query(
    `UPDATE project_milestones
     SET status = 'completed',
         completion_record_id = $3,
         completion_event_id = $4,
         updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1 AND id = $2 AND status IN ('planned', 'active')`,
    [input.scope.workspaceId, input.milestoneId, evidenceEvent?.recordId ?? null, evidenceEvent?.eventId ?? null],
  );
  if (updatedMilestone.rowCount !== 1) {
    throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The milestone changed. Read it again before retrying.");
  }
  const updatedProject = await client.query<{ version: string }>(
    `UPDATE projects
     SET version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1 AND id = $2 AND version = $3
     RETURNING version::text`,
    [input.scope.workspaceId, input.projectId, input.expectedProjectVersion],
  );
  const version = Number(updatedProject.rows[0]?.version);
  if (!Number.isInteger(version)) {
    throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The project changed. Read it again before retrying.");
  }
  return { projectVersion: version, worldCursor: evidenceEvent?.worldCursor ?? null };
}

async function insertLedgerRow(
  client: PoolClient,
  input: LedgerCommitInput,
  enforceFunds: boolean,
): Promise<ExpenseCommandResult> {
  const account = await readAccount(client, input.scope, input.accountId, true);
  if (!account || account.status !== "active") {
    throw new ProjectFinanceCommandError("FINANCE_ACCOUNT_NOT_FOUND", "The finance account is not available.");
  }
  const ledger = await readLedger(client, input.scope, account.id);
  const cash = deriveCashPosition(account, ledger);
  if (cash.balanceMinor !== input.expectedBalanceMinor) {
    throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The cash position changed. Read it again before retrying.");
  }
  if (enforceFunds && input.amountMinor > cash.balanceMinor) {
    throw new ProjectFinanceCommandError("INSUFFICIENT_FUNDS", "The available balance cannot cover this entry.");
  }
  const evidenceEvent = input.evidence
    ? await writeRecordEvidence(client, input.scope, input.evidence, input.eventKind, input.sourceEventId)
    : null;
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
    recordId: evidenceEvent?.recordId ?? input.recordId,
    sourceEventId: evidenceEvent?.eventId ?? null,
    occurredAt: input.occurredAt,
    idempotencyKey: input.idempotencyKey,
  });
  await client.query(
    `INSERT INTO ledger_entries (
       workspace_id, world_id, worldline_id, id, account_id,
       kind, direction, amount_minor, currency, category, memo,
       project_id, source_record_id, source_event_id, occurred_at, idempotency_key
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, 'JPY', $9, $10,
       $11, $12, $13, $14, $15
     )`,
    [
      input.scope.workspaceId,
      input.scope.worldId,
      input.scope.worldlineId,
      entry.id,
      entry.accountId,
      entry.kind,
      entry.direction,
      entry.amountMinor,
      entry.category,
      entry.memo,
      entry.projectId,
      entry.recordId,
      entry.sourceEventId,
      entry.occurredAt,
      entry.idempotencyKey,
    ],
  );
  return {
    status: "committed",
    commandGroupId: input.commandGroupId,
    entry,
    cash: deriveCashPosition(account, [...ledger, entry]),
    eventKind: input.eventKind,
    ...(evidenceEvent ? { worldCursor: evidenceEvent.worldCursor } : {}),
  };
}

async function writeRecordEvidence(
  client: PoolClient,
  scope: ProjectScope,
  evidence: RecordEvidence,
  eventKind: string,
  eventId: string,
): Promise<{ eventId: string; recordId: string; worldCursor: { worldTick: number; worldOrdinal: number } }> {
  const worldline = await client.query<{
    head_tick: string | number;
    head_ordinal: string | number;
    calendar_id: string;
    display_time: string;
  }>(
    `SELECT worldline.head_tick, worldline.head_ordinal, world.calendar_id,
            COALESCE(world.settings->>'displayTime', '') AS display_time
     FROM worldlines AS worldline
     JOIN worlds AS world
       ON world.workspace_id = worldline.workspace_id
      AND world.id = worldline.world_id
     WHERE worldline.workspace_id = $1 AND worldline.world_id = $2 AND worldline.id = $3
     FOR UPDATE OF worldline`,
    [scope.workspaceId, scope.worldId, scope.worldlineId],
  );
  const head = worldline.rows[0];
  if (!head) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Record evidence does not match this worldline.");
  }
  const headTick = Number(head.head_tick);
  const headOrdinal = Number(head.head_ordinal);
  if (
    headTick !== evidence.expectedWorldCursor.worldTick
    || headOrdinal !== evidence.expectedWorldCursor.worldOrdinal
  ) {
    throw new ProjectFinanceCommandError("WRITE_CONFLICT", "The world cursor changed. Read it again before retrying.");
  }
  const record = await client.query<{ status: string }>(
    `SELECT status FROM records
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, evidence.recordId],
  );
  if (!record.rows[0] || record.rows[0].status === "archived") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Record evidence does not match a live Record.");
  }
  const scene = await client.query(
    `SELECT id FROM scenes
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND record_id = $4 AND id = $5`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, evidence.recordId, evidence.sceneId],
  );
  if (scene.rowCount !== 1) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Record evidence does not match a Scene.");
  }
  const policy = await client.query<{ id: string }>(
    `SELECT id FROM visibility_policies
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND record_id = $4 AND policy_kind = $5
     ORDER BY id
     LIMIT 1`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, evidence.recordId, evidence.visibility],
  );
  const policyId = policy.rows[0]?.id;
  if (!policyId) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Record evidence does not match a visibility policy.");
  }
  const recordHead = await client.query<{ record_version: string; next_record_ordinal: string }>(
    `SELECT record_version::text, next_record_ordinal::text
     FROM record_heads
     WHERE workspace_id = $1 AND record_id = $2
     FOR UPDATE`,
    [scope.workspaceId, evidence.recordId],
  );
  const headRow = recordHead.rows[0];
  if (!headRow) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Record evidence does not match a live Record.");
  }
  const nextTick = headTick;
  const nextOrdinal = headOrdinal + 1;
  const recordVersion = Number(headRow.record_version) + 1;
  const recordOrdinal = Number(headRow.next_record_ordinal);
  await client.query(
    `INSERT INTO events (
       workspace_id, world_id, worldline_id, record_id, scene_id, id,
       record_version, record_ordinal, batch_index, event_kind,
       actor_participant_id, speaker_name, content, payload,
       visibility_policy_id, world_tick, world_ordinal, calendar_id, display_time
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, 0, $9,
       NULL, '', '', '{}'::jsonb,
       $10, $11, $12, $13, $14
     )`,
    [
      scope.workspaceId,
      scope.worldId,
      scope.worldlineId,
      evidence.recordId,
      evidence.sceneId,
      eventId,
      recordVersion,
      recordOrdinal,
      eventKind,
      policyId,
      nextTick,
      nextOrdinal,
      head.calendar_id,
      head.display_time,
    ],
  );
  await client.query(
    `UPDATE record_heads
     SET record_version = $3,
         next_record_ordinal = $4,
         last_event_id = $5,
         last_world_tick = $6,
         last_world_ordinal = $7,
         updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1 AND record_id = $2`,
    [scope.workspaceId, evidence.recordId, recordVersion, recordOrdinal + 1, eventId, nextTick, nextOrdinal],
  );
  await client.query(
    `UPDATE worldlines
     SET head_tick = $4, head_ordinal = $5, updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, nextTick, nextOrdinal],
  );
  return {
    eventId,
    recordId: evidence.recordId,
    worldCursor: { worldTick: nextTick, worldOrdinal: nextOrdinal },
  };
}

function advanceEvidence(
  evidence: RecordEvidence | null,
  cursor: { worldTick: number; worldOrdinal: number } | null,
): RecordEvidence | null {
  if (!evidence || !cursor) return evidence;
  return { ...evidence, expectedWorldCursor: cursor };
}

async function defaultAccountId(client: PoolClient, scope: ProjectScope): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM finance_accounts
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND status = 'active'
     ORDER BY id
     LIMIT 2`,
    [scope.workspaceId, scope.worldId, scope.worldlineId],
  );
  if (result.rows.length !== 1) {
    throw new ProjectFinanceCommandError("FINANCE_ACCOUNT_NOT_FOUND", "The finance account is not available.");
  }
  return result.rows[0]!.id;
}

async function requireActiveProject(client: PoolClient, scope: ProjectScope, projectId: string): Promise<void> {
  const project = await client.query<{ status: string }>(
    `SELECT status FROM projects
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, projectId],
  );
  if (!project.rows[0]) {
    throw new ProjectFinanceCommandError("PROJECT_NOT_FOUND", "The project is not available.");
  }
  if (project.rows[0].status !== "planned" && project.rows[0].status !== "active") {
    throw new ProjectFinanceCommandError("PROJECT_NOT_ACTIVE", "The project cannot accept this obligation.");
  }
}

function nextObligationOutstanding(
  kind: "loan" | "presale" | "revenue_share",
  settlementKind: "repayment" | "draw" | "share",
  outstanding: number,
  _principal: number,
  amount: number,
): number {
  if (settlementKind === "draw") {
    if (kind === "revenue_share") {
      throw new ProjectFinanceCommandError("COMMAND_INVALID", "A revenue share cannot be drawn as income.");
    }
    return outstanding;
  }
  if (settlementKind === "repayment") {
    if (kind !== "loan") {
      throw new ProjectFinanceCommandError("COMMAND_INVALID", "Only a loan can be repaid.");
    }
    if (amount > outstanding) {
      throw new ProjectFinanceCommandError("COMMAND_INVALID", "Repayment exceeds the outstanding obligation.");
    }
    return outstanding - amount;
  }
  if (kind !== "revenue_share") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Only a revenue share can post a share settlement.");
  }
  return outstanding;
}
