/**
 * T11-I-A：受众映射产品化的数据库授权契约。
 * RED 阶段先证明 0028 owner append function 尚不存在；实现后覆盖：
 * runtime 无直接 INSERT、owner add/duplicate、non-owner/inactive fail-closed。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
  seedPostgresDemoPropagationTopology,
} from "../database/postgres/public.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";

const adminConnectionString = process.env.DATABASE_URL;
const MIGRATIONS = [
  "0001_runtime_contract.sql",
  "0002_runtime_contract_hardening.sql",
  "0003_runtime_repository.sql",
  "0004_runtime_security_hardening.sql",
  "0005_hybrid_memory.sql",
  "0006_action_state_ledger.sql",
  "0007_dynamic_visibility_policies.sql",
  "0008_record_timeline_kind.sql",
  "0009_memory_m3_completion.sql",
  "0010_world_governance.sql",
  "0011_worldline_merge_semantic_propagation_jobs.sql",
  "0012_accounts.sql",
  "0013_membership_insert_grant.sql",
  "0014_scene_crystallization_grants.sql",
  "0015_account_ui_language.sql",
  "0016_world_files.sql",
  "0017_account_last_opened.sql",
  "0018_account_last_opened_fk_set_null.sql",
  "0019_record_first_nights.sql",
  "0020_record_self_play_sessions.sql",
  "0021_world_admin.sql",
  "0022_worldline_merge_grants.sql",
  "0023_library_runtime_grants.sql",
  "0024_graph_invalidation_events.sql",
  "0025_propagation_topology_semantic_scope.sql",
  "0026_canon_security_audience.sql",
  "0027_propagation_node_audiences.sql",
  "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
  "0028_propagation_node_audiences_owner_append.sql",
];

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  return url;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

test(
  "T11-I-A: runtime can only append node audiences through owner-checked function",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t11i_aud_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });

    t.after(async () => {
      await runtimePool.end();
      await ownerPool.end();
      await maintenance.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await maintenance.end();
    });

    for (const filename of MIGRATIONS) {
      const sql = await readFile(
        new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await ownerPool.query(sql);
    }
    await seedPostgresDemo(ownerPool);
    await seedPostgresDemoPropagationTopology(ownerPool);

    const directInsert = await ownerPool.query<{ allowed: boolean }>(
      `SELECT has_table_privilege(
         'realm_runtime', 'propagation_node_audiences', 'INSERT'
       ) AS allowed`,
    );
    assert.equal(directInsert.rows[0]?.allowed, false);
    const execute = await ownerPool.query<{ allowed: boolean }>(
      `SELECT has_function_privilege(
         'realm_runtime',
         'append_propagation_node_audience(text,text,text,text,text,text)',
         'EXECUTE'
       ) AS allowed`,
    );
    assert.equal(execute.rows[0]?.allowed, true);

    const append = (
      principalId: string,
      nodeKey = "harbor_tavern",
      continuityId = "continuity_scout",
    ) => withWorkspaceTransaction(
      runtimePool,
      POSTGRES_DEMO_IDS.workspace,
      async (client) => {
        const result = await client.query<{ appended: boolean }>(
          `SELECT append_propagation_node_audience(
             $1, $2, $3, $4, $5, $6
           ) AS appended`,
          [
            POSTGRES_DEMO_IDS.workspace,
            POSTGRES_DEMO_IDS.world,
            POSTGRES_DEMO_IDS.worldline,
            nodeKey,
            continuityId,
            principalId,
          ],
        );
        return result.rows[0]?.appended;
      },
    );

    assert.equal(await append(POSTGRES_DEMO_IDS.principal), true);
    assert.equal(await append(POSTGRES_DEMO_IDS.principal), false, "重复追加幂等");
    await assert.rejects(
      append("principal_not_owner"),
      /PROPAGATION_AUDIENCE_OWNER_REQUIRED/,
    );
    await assert.rejects(
      append(POSTGRES_DEMO_IDS.principal, "node_missing"),
      /PROPAGATION_AUDIENCE_NODE_NOT_FOUND/,
    );
    await assert.rejects(
      append(POSTGRES_DEMO_IDS.principal, "market_square", "continuity_missing"),
      /PROPAGATION_AUDIENCE_CONTINUITY_NOT_FOUND/,
    );

    await ownerPool.query(
      `UPDATE character_continuities
       SET status = 'ended'
       WHERE workspace_id = $1 AND id = 'continuity_scholar'`,
      [POSTGRES_DEMO_IDS.workspace],
    );
    await assert.rejects(
      append(POSTGRES_DEMO_IDS.principal, "market_square", "continuity_scholar"),
      /PROPAGATION_AUDIENCE_CONTINUITY_INACTIVE/,
    );

    const rows = await ownerPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM propagation_node_audiences`,
    );
    assert.equal(rows.rows[0]?.count, 1);
  },
);
