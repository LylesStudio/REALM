import assert from "node:assert/strict";
import pg from "pg";
import test from "node:test";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";
const TABLES = [
  "projects",
  "project_milestones",
  "project_story_links",
  "budget_allocations",
  "finance_accounts",
  "ledger_entries",
  "project_finance_command_groups",
] as const;

test(
  "0062 installs Project/Finance tables with forced RLS, scoped constraints, and least privilege",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async () => {
    const owner = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    try {
      const relationRows = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class AS c
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [TABLES],
      );
      assert.deepEqual(relationRows.rows, [...TABLES].sort().map((relname) => ({
        relname,
        relrowsecurity: true,
        relforcerowsecurity: true,
      })));

      const trigger = await owner.query<{ tgname: string }>(
        `SELECT tgname
         FROM pg_trigger
         WHERE tgrelid = 'ledger_entries'::regclass
           AND tgname = 'ledger_entries_append_only_guard'`,
      );
      assert.equal(trigger.rowCount, 1);

      const constraints = await owner.query<{ conname: string }>(
        `SELECT conname
         FROM pg_constraint
         WHERE conname = ANY($1::text[])
         ORDER BY conname`,
        [[
          "projects_worldline_fk",
          "project_milestones_project_fk",
          "project_milestones_completion_event_fk",
          "project_story_links_story_fk",
          "budget_allocations_project_fk",
          "ledger_entries_account_fk",
          "ledger_entries_source_event_fk",
          "project_finance_command_groups_source_record_fk",
          "ledger_entries_kind_direction_check",
        ]],
      );
      assert.deepEqual(
        constraints.rows.map((row) => row.conname),
        [
          "budget_allocations_project_fk",
          "ledger_entries_account_fk",
          "ledger_entries_kind_direction_check",
          "ledger_entries_source_event_fk",
          "project_finance_command_groups_source_record_fk",
          "project_milestones_completion_event_fk",
          "project_milestones_project_fk",
          "project_story_links_story_fk",
          "projects_worldline_fk",
        ],
      );

      const privileges = await owner.query<{
        ledgerSelect: boolean;
        ledgerInsert: boolean;
        ledgerUpdate: boolean;
        ledgerDelete: boolean;
        accountOpeningUpdate: boolean;
        accountStatusUpdate: boolean;
        commandGroupUpdate: boolean;
      }>(
        `SELECT
           has_table_privilege('realm_runtime', 'public.ledger_entries', 'SELECT') AS "ledgerSelect",
           has_table_privilege('realm_runtime', 'public.ledger_entries', 'INSERT') AS "ledgerInsert",
           has_table_privilege('realm_runtime', 'public.ledger_entries', 'UPDATE') AS "ledgerUpdate",
           has_table_privilege('realm_runtime', 'public.ledger_entries', 'DELETE') AS "ledgerDelete",
           has_column_privilege('realm_runtime', 'public.finance_accounts', 'opening_balance_minor', 'UPDATE') AS "accountOpeningUpdate",
           has_column_privilege('realm_runtime', 'public.finance_accounts', 'status', 'UPDATE') AS "accountStatusUpdate",
           has_column_privilege('realm_runtime', 'public.project_finance_command_groups', 'state', 'UPDATE') AS "commandGroupUpdate"`,
      );
      assert.deepEqual(privileges.rows[0], {
        ledgerSelect: true,
        ledgerInsert: true,
        ledgerUpdate: false,
        ledgerDelete: false,
        accountOpeningUpdate: false,
        accountStatusUpdate: true,
        commandGroupUpdate: true,
      });

      const counts = await owner.query<{ tableName: string; rowCount: string }>(
        `SELECT table_name AS "tableName", table_rows::text AS "rowCount"
         FROM (
           SELECT unnest($1::text[]) AS table_name
         ) AS names
         CROSS JOIN LATERAL (
           SELECT CASE names.table_name
             WHEN 'projects' THEN (SELECT count(*) FROM projects)
             WHEN 'project_milestones' THEN (SELECT count(*) FROM project_milestones)
             WHEN 'project_story_links' THEN (SELECT count(*) FROM project_story_links)
             WHEN 'budget_allocations' THEN (SELECT count(*) FROM budget_allocations)
             WHEN 'finance_accounts' THEN (SELECT count(*) FROM finance_accounts)
             WHEN 'ledger_entries' THEN (SELECT count(*) FROM ledger_entries)
             WHEN 'project_finance_command_groups' THEN (SELECT count(*) FROM project_finance_command_groups)
           END AS table_rows
         ) AS rows
         ORDER BY table_name`,
        [TABLES],
      );
      assert.equal(counts.rows.length, TABLES.length);
      assert.ok(
        counts.rows.every((row) => row.rowCount === "0"),
        `Project/Finance scratch data leaked: ${JSON.stringify(counts.rows)}`,
      );
    } finally {
      await owner.end();
    }
  },
);

test(
  "0065 installs funding obligations with forced RLS and an append-only settlement ledger",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async () => {
    const owner = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    try {
      const relations = await owner.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class AS c
         JOIN pg_namespace AS n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
         ORDER BY c.relname`,
        [["obligations", "obligation_settlements"]],
      );
      assert.deepEqual(relations.rows, [
        { relname: "obligation_settlements", relrowsecurity: true, relforcerowsecurity: true },
        { relname: "obligations", relrowsecurity: true, relforcerowsecurity: true },
      ]);
      const trigger = await owner.query(
        `SELECT 1 FROM pg_trigger
         WHERE tgrelid = 'obligation_settlements'::regclass
           AND tgname = 'obligation_settlements_append_only_guard'`,
      );
      assert.equal(trigger.rowCount, 1);
      const privileges = await owner.query<{
        obligationUpdate: boolean;
        settlementInsert: boolean;
        settlementUpdate: boolean;
        settlementDelete: boolean;
      }>(
        `SELECT
           has_table_privilege('realm_runtime', 'public.obligations', 'UPDATE') AS "obligationUpdate",
           has_table_privilege('realm_runtime', 'public.obligation_settlements', 'INSERT') AS "settlementInsert",
           has_table_privilege('realm_runtime', 'public.obligation_settlements', 'UPDATE') AS "settlementUpdate",
           has_table_privilege('realm_runtime', 'public.obligation_settlements', 'DELETE') AS "settlementDelete"`,
      );
      assert.deepEqual(privileges.rows[0], {
        obligationUpdate: true,
        settlementInsert: true,
        settlementUpdate: false,
        settlementDelete: false,
      });
    } finally {
      await owner.end();
    }
  },
);
