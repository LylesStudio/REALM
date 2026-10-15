import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { POST as financeCommandPOST } from "../app/api/bridge/v1/finance/commands/route.ts";
import { POST as projectCommandPOST } from "../app/api/bridge/v1/projects/commands/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createPostgresProjectFinanceCommandStore } from "../database/postgres/project-finance-command-repository.ts";
import { createProjectFinanceCommandService } from "../modules/application/project-finance-command.ts";
import { createSessionValue } from "../modules/identity/auth.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const SCOPE = {
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
} as const;

test(
  "project finance expense command appends one ledger row and replays safely",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const admin = new pg.Pool({ connectionString: adminConnectionString! });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString! });
    const suffix = randomUUID().replaceAll("-", "");
    const accountId = `account_cmd_${suffix}`;
    const projectId = `project_cmd_${suffix}`;
    const milestoneId = `milestone_cmd_${suffix}`;
    const idempotencyKey = `expense_${suffix}`;
    const incomeKey = `income_${suffix}`;
    const milestoneKey = `milestone_${suffix}`;
    const budgetKey = `budget_${suffix}`;
    t.after(async () => {
      await endSharedRuntimePools();
      // Append-only ledger 仍需从 scratch 库清理；只在 disposable 测试库的
      // cleanup 事务中临时关闭 user triggers，绝不进入生产写路径。
      const cleanup = await admin.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query("SET LOCAL session_replication_role = replica");
        await cleanup.query(
          `DELETE FROM ledger_entries
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND account_id = $4`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, accountId],
        );
        await cleanup.query(
          `DELETE FROM project_finance_command_groups
           WHERE workspace_id = $1 AND worldline_id = $2
             AND idempotency_key IN ($3, $4, $5, $6, $7)`,
          [SCOPE.workspaceId, SCOPE.worldlineId, idempotencyKey, `${idempotencyKey}_route`, incomeKey, milestoneKey, budgetKey],
        );
        await cleanup.query(
          `DELETE FROM project_story_links
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND project_id = $4`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
        );
        await cleanup.query(
          `DELETE FROM budget_allocations
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND project_id = $4`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
        );
        await cleanup.query(
          `DELETE FROM project_milestones
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND project_id = $4`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
        );
        await cleanup.query(
          `DELETE FROM projects
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
        );
        await cleanup.query(
          `DELETE FROM finance_accounts
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = $4`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, accountId],
        );
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK");
        throw error;
      } finally {
        cleanup.release();
      }
      await Promise.all([admin.end(), runtime.end()]);
    });

    await admin.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 100000)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, accountId],
    );
    await admin.query(
      `INSERT INTO projects (
         workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, version
       ) VALUES ($1, $2, $3, $4, 'production', 'active', 'production', 'Command project', 'JPY', 1)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
    );
    await admin.query(
      `INSERT INTO project_milestones (
         workspace_id, world_id, worldline_id, id, project_id, sequence, title, status
       ) VALUES ($1, $2, $3, $4, $5, 1, 'Rehearsal', 'active')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, milestoneId, projectId],
    );

    const service = createProjectFinanceCommandService({
      store: createPostgresProjectFinanceCommandStore(runtime),
    });
    const committed = await service.recordExpense({
      scope: SCOPE,
      accountId,
      amountMinor: 12_000,
      category: "venue",
      memo: "Venue deposit",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey,
      expectedBalanceMinor: 100_000,
    });
    assert.equal(committed.status, "committed");
    assert.equal(committed.cash.balanceMinor, 88_000);
    const replayed = await service.recordExpense({
      scope: SCOPE,
      accountId,
      amountMinor: 12_000,
      category: "venue",
      memo: "Venue deposit",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey,
      expectedBalanceMinor: 100_000,
    });
    assert.equal(replayed.status, "replayed");
    assert.equal(replayed.entry.id, committed.entry.id);

    const count = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries
       WHERE workspace_id = $1 AND account_id = $2`,
      [SCOPE.workspaceId, accountId],
    );
    assert.equal(count.rows[0]?.n, 1);

    const cookie = `realm_session=${createSessionValue("principal_demo_player")}`;
    const response = await financeCommandPOST(new Request(
      `http://localhost/api/bridge/v1/finance/commands?worldId=${SCOPE.worldId}`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": `${idempotencyKey}_route`,
        },
        body: JSON.stringify({
          command: "record_expense",
          accountId,
          amountMinor: 1_000,
          category: "venue",
          memo: "Route deposit",
          occurredAt: "2026-10-17T00:00:00.000Z",
          expectedBalanceMinor: 88_000,
          balanceMinor: 1,
        }),
      },
    ));
    assert.equal(response.status, 200);
    const body = await response.json() as {
      ok?: boolean;
      data?: { status?: string; cash?: { balanceMinor?: number }; entry?: { amountMinor?: number } };
    };
    assert.equal(body.ok, true);
    assert.equal(body.data?.status, "committed");
    assert.equal(body.data?.cash?.balanceMinor, 87_000);
    assert.equal(body.data?.entry?.amountMinor, 1_000);
    assert.equal(JSON.stringify(body).includes("ws_demo"), false);

    const income = await service.recordIncome({
      scope: SCOPE,
      amountMinor: 5_000,
      category: "ticket",
      memo: "Presale",
      occurredAt: "2026-10-18T00:00:00.000Z",
      idempotencyKey: incomeKey,
      expectedBalanceMinor: 87_000,
    });
    assert.equal(income.status, "committed");
    assert.equal(income.cash.balanceMinor, 92_000);
    assert.equal(income.entry.accountId, accountId);

    const confirmed = await service.confirmMilestone({
      scope: SCOPE,
      projectId,
      milestoneId,
      expectedProjectVersion: 1,
      idempotencyKey: milestoneKey,
    });
    assert.equal(confirmed.status, "committed");
    assert.equal(confirmed.projectVersion, 2);
    const milestone = await admin.query<{ status: string }>(
      `SELECT status FROM project_milestones WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, milestoneId],
    );
    assert.equal(milestone.rows[0]?.status, "completed");

    const milestoneResponse = await projectCommandPOST(new Request(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${SCOPE.worldId}`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": milestoneKey,
        },
        body: JSON.stringify({
          command: "confirm_milestone",
          projectId,
          milestoneId,
          expectedProjectVersion: 1,
        }),
      },
    ));
    assert.equal(milestoneResponse.status, 200);
    const milestoneBody = await milestoneResponse.json() as { data?: { status?: string; projectVersion?: number } };
    assert.equal(milestoneBody.data?.status, "replayed");
    assert.equal(milestoneBody.data?.projectVersion, 2);

    const budgetResponse = await financeCommandPOST(new Request(
      `http://localhost/api/bridge/v1/finance/commands?worldId=${SCOPE.worldId}`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": budgetKey,
        },
        body: JSON.stringify({
          command: "allocate_budget",
          projectId,
          category: "venue",
          amountMinor: 300_000,
          expectedVersion: 0,
        }),
      },
    ));
    assert.equal(budgetResponse.status, 200);
    const budgetBody = await budgetResponse.json() as { data?: { version?: number; eventKind?: string } };
    assert.equal(budgetBody.data?.version, 1);
    assert.equal(budgetBody.data?.eventKind, "finance.budget.allocated");
    const allocation = await admin.query<{ amount_minor: string }>(
      `SELECT amount_minor::text FROM budget_allocations
       WHERE workspace_id = $1 AND project_id = $2 AND category = 'venue'`,
      [SCOPE.workspaceId, projectId],
    );
    assert.equal(allocation.rows[0]?.amount_minor, "300000");
  },
);
