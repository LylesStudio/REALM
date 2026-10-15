import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { POST as projectCommandPOST } from "../app/api/bridge/v1/projects/commands/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createPostgresProjectFinanceCommandStore } from "../database/postgres/project-finance-command-repository.ts";
import {
  createProjectFinanceCommandService,
  ProjectFinanceCommandError,
} from "../modules/application/project-finance-command.ts";
import { createSessionValue } from "../modules/identity/auth.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";
const SCOPE = {
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
} as const;

test(
  "stage, evidenced ledger, combined rollback, and obligations read back from PostgreSQL",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const storyId = `story_evidence_${suffix}`;
    const recordId = `record_evidence_${suffix}`;
    const sceneId = `scene_evidence_${suffix}`;
    const policyId = `policy_evidence_${suffix}`;
    const accountId = `account_evidence_${suffix}`;
    const projectId = `project_evidence_${suffix}`;
    const milestoneId = `milestone_evidence_${suffix}`;
    const stageKey = `stage_${suffix}`;
    const expenseKey = `expense_evidence_${suffix}`;
    const plainKey = `expense_plain_${suffix}`;
    const applyKey = `apply_${suffix}`;
    const loanKey = `loan_${suffix}`;
    const repayKey = `repay_${suffix}`;
    const originalHead = await admin.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text
       FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId],
    );
    const savedTick = originalHead.rows[0]?.head_tick;
    const savedOrdinal = originalHead.rows[0]?.head_ordinal;
    assert.ok(savedTick !== undefined && savedOrdinal !== undefined);

    t.after(async () => {
      await endSharedRuntimePools();
      const cleanup = await admin.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query("SET LOCAL session_replication_role = replica");
        await cleanup.query(
          `UPDATE worldlines
           SET head_tick = $4, head_ordinal = $5
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, savedTick, savedOrdinal],
        );
        await cleanup.query(
          `DELETE FROM events
           WHERE workspace_id = $1 AND record_id = $2`,
          [SCOPE.workspaceId, recordId],
        );
        await cleanup.query(
          `DELETE FROM record_heads WHERE workspace_id = $1 AND record_id = $2`,
          [SCOPE.workspaceId, recordId],
        );
        await cleanup.query(
          `DELETE FROM visibility_policies WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, policyId],
        );
        await cleanup.query(
          `DELETE FROM scenes WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, sceneId],
        );
        await cleanup.query(
          `DELETE FROM obligation_settlements
           WHERE workspace_id = $1 AND obligation_id IN (
             SELECT id FROM obligations WHERE workspace_id = $1 AND project_id = $2
           )`,
          [SCOPE.workspaceId, projectId],
        );
        await cleanup.query(
          `DELETE FROM obligations WHERE workspace_id = $1 AND project_id = $2`,
          [SCOPE.workspaceId, projectId],
        );
        await cleanup.query(
          `DELETE FROM project_finance_command_groups
           WHERE workspace_id = $1 AND worldline_id = $2
             AND idempotency_key = ANY($3::text[])`,
          [SCOPE.workspaceId, SCOPE.worldlineId, [stageKey, expenseKey, plainKey, applyKey, loanKey, repayKey]],
        );
        await cleanup.query(
          `DELETE FROM ledger_entries
           WHERE workspace_id = $1 AND account_id = $2`,
          [SCOPE.workspaceId, accountId],
        );
        await cleanup.query(
          `DELETE FROM records WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, recordId],
        );
        await cleanup.query(
          `DELETE FROM stories WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, storyId],
        );
        await cleanup.query(
          `DELETE FROM project_milestones WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, milestoneId],
        );
        await cleanup.query(
          `DELETE FROM projects WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, projectId],
        );
        await cleanup.query(
          `DELETE FROM finance_accounts WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, accountId],
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
      `INSERT INTO stories (
         workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, 'Evidence story', 'active', '', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, storyId],
    );
    await admin.query(
      `INSERT INTO records (
         workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, 'Evidence record', 'active', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, storyId, recordId],
    );
    await admin.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, 'Evidence scene', 'active', '', '', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId, sceneId],
    );
    await admin.query(
      `INSERT INTO visibility_policies (
         workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind
       ) VALUES ($1, $2, $3, $4, $5, 'public', 1, 'public')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId, policyId],
    );
    await admin.query(
      `INSERT INTO record_heads (
         workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal
       ) VALUES ($1, $2, $3, $4, 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId],
    );
    await admin.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 100000)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, accountId],
    );
    await admin.query(
      `INSERT INTO projects (
         workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, version
       ) VALUES ($1, $2, $3, $4, 'production', 'active', 'planning', 'Evidence project', 'JPY', 1)`,
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
    const staged = await service.changeStage({
      scope: SCOPE,
      projectId,
      stage: "funding",
      expectedProjectVersion: 1,
      idempotencyKey: stageKey,
    });
    assert.equal(staged.projectVersion, 2);
    assert.equal(staged.worldCursor ?? null, null);
    const stageRow = await admin.query<{ stage: string; version: string }>(
      `SELECT stage, version::text FROM projects WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, projectId],
    );
    assert.equal(stageRow.rows[0]?.stage, "funding");
    assert.equal(stageRow.rows[0]?.version, "2");
    const stageReplay = await service.changeStage({
      scope: SCOPE,
      projectId,
      stage: "funding",
      expectedProjectVersion: 1,
      idempotencyKey: stageKey,
    });
    assert.equal(stageReplay.status, "replayed");
    const stageAfterReplay = await admin.query<{ version: string }>(
      `SELECT version::text FROM projects WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, projectId],
    );
    assert.equal(stageAfterReplay.rows[0]?.version, "2");

    const headBeforeEvent = await admin.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text
       FROM worldlines
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    );
    const evidence = {
      recordId,
      sceneId,
      visibility: "public" as const,
      expectedWorldCursor: {
        worldTick: Number(headBeforeEvent.rows[0]?.head_tick),
        worldOrdinal: Number(headBeforeEvent.rows[0]?.head_ordinal),
      },
    };
    const evidenced = await service.recordExpense({
      scope: SCOPE,
      accountId,
      amountMinor: 1_000,
      category: "venue",
      memo: "Evidenced deposit",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey: expenseKey,
      expectedBalanceMinor: 100_000,
      evidence,
    });
    assert.equal(evidenced.status, "committed");
    assert.equal(evidenced.worldCursor?.worldOrdinal, evidence.expectedWorldCursor.worldOrdinal + 1);
    const evidencedReplay = await service.recordExpense({
      scope: SCOPE,
      accountId,
      amountMinor: 1_000,
      category: "venue",
      memo: "Evidenced deposit",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey: expenseKey,
      expectedBalanceMinor: 100_000,
      evidence,
    });
    assert.equal(evidencedReplay.status, "replayed");
    const eventCount = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events
       WHERE workspace_id = $1 AND record_id = $2 AND event_kind = 'finance.expense.recorded'`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(eventCount.rows[0]?.n, 1);
    const ledgerCount = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE workspace_id = $1 AND account_id = $2`,
      [SCOPE.workspaceId, accountId],
    );
    assert.equal(ledgerCount.rows[0]?.n, 1);

    await service.recordExpense({
      scope: SCOPE,
      accountId,
      amountMinor: 500,
      category: "venue",
      memo: "Operator only",
      occurredAt: "2026-10-16T01:00:00.000Z",
      idempotencyKey: plainKey,
      expectedBalanceMinor: 99_000,
    });
    const eventsAfterPlain = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(eventsAfterPlain.rows[0]?.n, 1);

    const cookie = `realm_session=${createSessionValue("principal_demo_player")}`;
    const partial = await projectCommandPOST(new Request(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${SCOPE.worldId}`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": `partial_${suffix}`,
        },
        body: JSON.stringify({
          command: "change_stage",
          projectId,
          stage: "production",
          expectedProjectVersion: 2,
          recordId,
          sceneId,
        }),
      },
    ));
    assert.equal(partial.status, 422);
    const eventsAfterPartial = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(eventsAfterPartial.rows[0]?.n, 1);

    const headBeforeApply = await admin.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text
       FROM worldlines WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    );
    await assert.rejects(
      service.applyRecordProjectFinance({
        scope: SCOPE,
        idempotencyKey: applyKey,
        evidence: {
          recordId,
          sceneId,
          visibility: "public",
          expectedWorldCursor: {
            worldTick: Number(headBeforeApply.rows[0]?.head_tick),
            worldOrdinal: Number(headBeforeApply.rows[0]?.head_ordinal),
          },
        },
        actions: [
          {
            command: "confirm_milestone",
            projectId,
            milestoneId,
            expectedProjectVersion: 2,
          },
          {
            command: "record_expense",
            accountId,
            amountMinor: 200_000,
            category: "venue",
            memo: "Too expensive",
            occurredAt: "2026-10-16T02:00:00.000Z",
            expectedBalanceMinor: 98_500,
          },
        ],
      }),
      (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "INSUFFICIENT_FUNDS",
    );
    const milestone = await admin.query<{ status: string }>(
      `SELECT status FROM project_milestones WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, milestoneId],
    );
    assert.equal(milestone.rows[0]?.status, "active");
    const headAfterReject = await admin.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text
       FROM worldlines WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    );
    assert.deepEqual(headAfterReject.rows[0], headBeforeApply.rows[0]);
    const ledgerAfterReject = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE workspace_id = $1 AND account_id = $2`,
      [SCOPE.workspaceId, accountId],
    );
    assert.equal(ledgerAfterReject.rows[0]?.n, 2);

    const created = await service.createObligation({
      scope: SCOPE,
      idempotencyKey: loanKey,
      projectId,
      kind: "loan",
      principalMinor: 200_000,
    });
    assert.equal(created.outstandingMinor, 200_000);
    const ledgerAfterLoan = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE workspace_id = $1 AND account_id = $2`,
      [SCOPE.workspaceId, accountId],
    );
    assert.equal(ledgerAfterLoan.rows[0]?.n, 2);
    await assert.rejects(
      service.settleObligation({
        scope: SCOPE,
        idempotencyKey: repayKey,
        obligationId: created.obligationId,
        settlementKind: "repayment",
        amountMinor: 150_000,
        expectedOutstandingMinor: 200_000,
        expectedBalanceMinor: 98_500,
        accountId,
        category: "loan",
        memo: "Too big",
        occurredAt: "2026-10-16T03:00:00.000Z",
      }),
      (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "INSUFFICIENT_FUNDS",
    );
    const outstanding = await admin.query<{ outstanding_minor: string; settlements: number }>(
      `SELECT obligation.outstanding_minor::text,
              (SELECT count(*)::int FROM obligation_settlements AS settlement
               WHERE settlement.workspace_id = obligation.workspace_id
                 AND settlement.obligation_id = obligation.id) AS settlements
       FROM obligations AS obligation
       WHERE obligation.workspace_id = $1 AND obligation.id = $2`,
      [SCOPE.workspaceId, created.obligationId],
    );
    assert.equal(outstanding.rows[0]?.outstanding_minor, "200000");
    assert.equal(outstanding.rows[0]?.settlements, 0);
  },
);
