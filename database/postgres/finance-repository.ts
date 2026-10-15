import type { PoolClient, QueryResultRow } from "pg";
import {
  normalizeFinanceAccount,
  normalizeLedgerEntry,
  type FinanceAccount,
  type LedgerEntry,
} from "../../modules/finance/public.ts";
import {
  ProjectFinanceReadError,
  type LedgerPageRead,
  type LedgerQuery,
} from "../../modules/application/project-finance-read.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";
import type { ProjectScope } from "../../modules/projects/public.ts";

const MAX_PROJECTION_ENTRIES = 10_000;

export interface FinanceRepositoryRead {
  accounts: readonly FinanceAccount[];
  entries: readonly LedgerEntry[];
}

export interface FinanceRepository {
  read(scope: ProjectScope): Promise<FinanceRepositoryRead>;
  readPage(scope: ProjectScope, query: LedgerQuery): Promise<LedgerPageRead>;
}

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

export function createPostgresFinanceRepository(
  database: WorkspaceDatabase,
): FinanceRepository {
  return {
    async read(scope) {
      try {
        return await withWorkspaceTransaction(
          database,
          scope.workspaceId,
          async (client) => {
            const accounts = await readAccounts(client, scope);
            const result = await client.query<LedgerRow>(
              `SELECT workspace_id, world_id, worldline_id, id,
                      account_id, kind, direction, amount_minor, currency,
                      category, memo, project_id, source_record_id,
                      source_event_id, occurred_at::text AS occurred_at,
                      idempotency_key
               FROM ledger_entries
               WHERE workspace_id = $1
                 AND world_id = $2
                 AND worldline_id = $3
               ORDER BY occurred_at ASC, id ASC
               LIMIT $4`,
              [scope.workspaceId, scope.worldId, scope.worldlineId, MAX_PROJECTION_ENTRIES + 1],
            );
            if (result.rows.length > MAX_PROJECTION_ENTRIES) {
              throw new ProjectFinanceReadError(
                "PROJECT_FINANCE_READ_FAILED",
                "The finance projection exceeds its bounded read window.",
              );
            }
            return {
              accounts,
              entries: result.rows.map((row) => normalizeLedgerRow(row)),
            };
          },
          { readOnly: true },
        );
      } catch (error) {
        if (error instanceof ProjectFinanceReadError) throw error;
        throw new ProjectFinanceReadError(
          "PROJECT_FINANCE_READ_FAILED",
          "Finance facts could not be read.",
        );
      }
    },

    async readPage(scope, query) {
      try {
        return await withWorkspaceTransaction(
          database,
          scope.workspaceId,
          async (client) => {
            const result = await client.query<LedgerRow>(
              `SELECT workspace_id, world_id, worldline_id, id,
                      account_id, kind, direction, amount_minor, currency,
                      category, memo, project_id, source_record_id,
                      source_event_id, occurred_at::text AS occurred_at,
                      idempotency_key
               FROM ledger_entries
               WHERE workspace_id = $1
                 AND world_id = $2
                 AND worldline_id = $3
                 AND ($4::text IS NULL OR project_id = $4)
                 AND ($5::text IS NULL OR direction = $5)
                 AND (
                   $6::timestamptz IS NULL
                   OR (occurred_at, id) > ($6::timestamptz, $7::text)
                 )
               ORDER BY occurred_at ASC, id ASC
               LIMIT $8`,
              [
                scope.workspaceId,
                scope.worldId,
                scope.worldlineId,
                query.projectId,
                query.direction,
                query.after?.occurredAt ?? null,
                query.after?.id ?? null,
                query.limit + 1,
              ],
            );
            const hasMore = result.rows.length > query.limit;
            const visibleRows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
            const entries = visibleRows.map((row) => normalizeLedgerRow(row));
            const last = entries[entries.length - 1];
            return {
              entries,
              hasMore,
              nextCursor: hasMore && last
                ? { occurredAt: last.occurredAt, id: last.id }
                : null,
            };
          },
          { readOnly: true },
        );
      } catch (error) {
        if (error instanceof ProjectFinanceReadError) throw error;
        throw new ProjectFinanceReadError(
          "PROJECT_FINANCE_READ_FAILED",
          "Finance ledger could not be read.",
        );
      }
    },
  };
}

async function readAccounts(
  client: PoolClient,
  scope: ProjectScope,
): Promise<readonly FinanceAccount[]> {
  const result = await client.query<AccountRow>(
    `SELECT workspace_id, world_id, worldline_id, id,
            currency, status, opening_balance_minor
     FROM finance_accounts
     WHERE workspace_id = $1
       AND world_id = $2
       AND worldline_id = $3
     ORDER BY created_at ASC, id ASC`,
    [scope.workspaceId, scope.worldId, scope.worldlineId],
  );
  return result.rows.map((row) => {
    try {
      return normalizeFinanceAccount({
        workspaceId: row.workspace_id,
        worldId: row.world_id,
        worldlineId: row.worldline_id,
        id: row.id,
        currency: row.currency,
        status: row.status,
        openingBalanceMinor: safeInteger(row.opening_balance_minor),
      });
    } catch {
      throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Finance account row is invalid.");
    }
  });
}

function normalizeLedgerRow(row: LedgerRow): LedgerEntry {
  try {
    return normalizeLedgerEntry({
      workspaceId: row.workspace_id,
      worldId: row.world_id,
      worldlineId: row.worldline_id,
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      direction: row.direction,
      amountMinor: safeInteger(row.amount_minor),
      currency: row.currency,
      category: row.category,
      memo: row.memo,
      projectId: row.project_id,
      recordId: row.source_record_id,
      sourceEventId: row.source_event_id,
      occurredAt: row.occurred_at,
      idempotencyKey: row.idempotency_key,
    });
  } catch {
    throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Ledger row is invalid.");
  }
}

function safeInteger(value: string | number): number {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Finance amount is outside the safe integer range.");
  }
  return normalized;
}
