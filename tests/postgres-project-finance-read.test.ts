import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import {
  createPostgresWorkbenchProjection,
} from "../database/postgres/public.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import { GET as workbenchGET } from "../app/api/bridge/v1/workbench/route.ts";
import { GET as projectsGET } from "../app/api/bridge/v1/projects/route.ts";
import { GET as projectDetailGET } from "../app/api/bridge/v1/projects/detail/route.ts";
import { GET as financeSummaryGET } from "../app/api/bridge/v1/finance/summary/route.ts";
import { GET as financeLedgerGET } from "../app/api/bridge/v1/finance/ledger/route.ts";
import {
  decodeLedgerCursor,
} from "../modules/application/project-finance-read.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const SCOPE = {
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
} as const;

test(
  "project finance read projection returns scoped workbench and opaque ledger pages",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const admin = new pg.Pool({ connectionString: adminConnectionString! });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString! });
    const suffix = randomUUID().replaceAll("-", "");
    const projectId = `project_read_${suffix}`;
    const milestoneId = `milestone_read_${suffix}`;
    const linkId = `link_read_${suffix}`;
    const allocationId = `allocation_read_${suffix}`;
    const accountId = `account_read_${suffix}`;
    const incomeId = `ledger_income_${suffix}`;
    const expenseId = `ledger_expense_${suffix}`;

    t.after(async () => {
      await endSharedRuntimePools();
      // ledger_entries 是 append-only；cleanup 只在 disposable scratch 的
      // 单连接事务中临时关闭 user triggers，避免污染后续 PG tests。
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
      `INSERT INTO projects (
         workspace_id, world_id, worldline_id, id, kind, status, stage,
         title, currency, version, deadline
       ) VALUES ($1, $2, $3, $4, 'production', 'active', 'production',
                 '只读投影验收项目', 'JPY', 2, '2026-12-01')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
    );
    await admin.query(
      `INSERT INTO project_milestones (
         workspace_id, world_id, worldline_id, id, project_id,
         sequence, title, status, due_on
       ) VALUES ($1, $2, $3, $4, $5, 1, '首个可验证节点', 'active', '2026-11-01')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, milestoneId, projectId],
    );
    await admin.query(
      `INSERT INTO project_story_links (
         workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind
       ) VALUES ($1, $2, $3, $4, $5, 'story_silent_bell', 'primary')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, linkId, projectId],
    );
    await admin.query(
      `INSERT INTO budget_allocations (
         workspace_id, world_id, worldline_id, id, project_id,
         category, amount_minor, currency, version
       ) VALUES ($1, $2, $3, $4, $5, 'venue', 150000, 'JPY', 1)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, allocationId, projectId],
    );
    await admin.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status,
         opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 100000)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, accountId],
    );
    await admin.query(
      `INSERT INTO ledger_entries (
         workspace_id, world_id, worldline_id, id, account_id,
         kind, direction, amount_minor, currency, category, memo,
         project_id, occurred_at, idempotency_key
       ) VALUES
         ($1, $2, $3, $4, $5, 'income', 'income', 50000, 'JPY',
          'sponsor', '赞助入账', $6, '2026-10-15T00:00:00Z', $7),
         ($1, $2, $3, $8, $5, 'expense', 'expense', 20000, 'JPY',
          'venue', '场地定金', $6, '2026-10-16T00:00:00Z', $9)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        incomeId,
        accountId,
        projectId,
        `key_${suffix}_income`,
        expenseId,
        `key_${suffix}_expense`,
      ],
    );

    const projection = createPostgresWorkbenchProjection(runtime);
    const snapshot = await projection.loadWorkbench(SCOPE);
    const project = snapshot.projects.find((item) => item.id === projectId);
    assert.ok(project);
    assert.deepEqual(project?.budgetUsage, {
      budgetedMinor: 150000,
      spentMinor: 20000,
      remainingMinor: 130000,
      allocationCount: 1,
    });
    assert.deepEqual(project?.milestoneSummary, {
      planned: 0,
      active: 1,
      completed: 0,
      cancelled: 0,
    });
    assert.equal(project?.storyCount, 1);
    // The seeded story is shared by the scratch suite; other PG tests may add
    // records to it before this read test.  Assert visibility, not global count.
    assert.ok((project?.recordCount ?? 0) >= 1);
    assert.equal(snapshot.finance.cash.openingBalanceMinor, 100000);
    assert.equal(snapshot.finance.cash.incomeMinor, 50000);
    assert.equal(snapshot.finance.cash.expenseMinor, 20000);
    assert.equal(snapshot.finance.cash.balanceMinor, 130000);

    const detail = await projection.loadProject(SCOPE, projectId);
    assert.equal(detail?.stories[0]?.records[0]?.id, "record_first_watch");
    assert.equal(detail?.milestones[0]?.id, milestoneId);

    const firstPage = await projection.loadLedger(SCOPE, {
      projectId,
      direction: null,
      after: null,
      limit: 1,
    });
    assert.equal(firstPage.page.entries.length, 1);
    assert.equal(firstPage.page.hasMore, true);
    assert.ok(firstPage.page.nextCursor);
    const encoded = encodeURIComponent(JSON.stringify(firstPage.page.nextCursor));
    assert.deepEqual(decodeLedgerCursor(encoded), firstPage.page.nextCursor);

    const secondPage = await projection.loadLedger(SCOPE, {
      projectId,
      direction: null,
      after: firstPage.page.nextCursor,
      limit: 1,
    });
    assert.equal(secondPage.page.entries.length, 1);
    assert.equal(secondPage.page.hasMore, false);

    const cookie = `realm_session=${createSessionValue("principal_demo_player")}`;
    const routeRequests = [
      [workbenchGET, `http://localhost/api/bridge/v1/workbench?worldId=${SCOPE.worldId}`],
      [projectsGET, `http://localhost/api/bridge/v1/projects?worldId=${SCOPE.worldId}`],
      [projectDetailGET, `http://localhost/api/bridge/v1/projects/detail?worldId=${SCOPE.worldId}&projectId=${projectId}`],
      [financeSummaryGET, `http://localhost/api/bridge/v1/finance/summary?worldId=${SCOPE.worldId}`],
      [financeLedgerGET, `http://localhost/api/bridge/v1/finance/ledger?worldId=${SCOPE.worldId}&projectId=${projectId}&limit=1`],
    ] as const;
    for (const [handler, url] of routeRequests) {
      const response = await handler(new Request(url, { headers: { cookie } }));
      assert.equal(response.status, 200, `${url} should be readable`);
      const body = await response.json() as { ok?: boolean; meta?: { projectionVersion?: number } };
      assert.equal(body.ok, true);
      assert.equal(body.meta?.projectionVersion, 1);
    }
  },
);
