import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresAccountRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

test(
  "accounts find-or-create is idempotent and name-stable",
  { skip: !adminConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_auth_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const owner = new pg.Client({ connectionString: ownerUrl.href });
    await owner.connect();
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });

    t.after(async () => {
      await ownerPool.end();
      await owner.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of [
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
    "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
    ]) {
      const sql = await readFile(
        new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await owner.query(sql);
    }
    await seedPostgresDemo(ownerPool);

    const accounts = createPostgresAccountRepository(ownerPool);
    const first = await accounts.findOrCreate("ws_demo", "守夜人甲");
    assert.match(first.principalId, /^principal_[a-f0-9]{18}$/);

    // 同昵称复用同一 principal，不产生新行。
    const again = await accounts.findOrCreate("ws_demo", "守夜人甲");
    assert.equal(again.principalId, first.principalId);
    const rows = await ownerPool.query(
      `SELECT count(*)::int AS count FROM accounts WHERE display_name = '守夜人甲'`,
    );
    assert.equal(rows.rows[0].count, 1);

    // 不同昵称是不同身份；表不含任何凭据列。
    const other = await accounts.findOrCreate("ws_demo", "守夜人乙");
    assert.notEqual(other.principalId, first.principalId);

    // 界面语言：默认 zh-CN；保存后读回；非法值不落库（CHECK 约束）。
    assert.equal(first.uiLanguage, "zh-CN");
    await accounts.saveUiLanguage("ws_demo", first.principalId, "en");
    const relogged = await accounts.findByPrincipal("ws_demo", first.principalId);
    assert.equal(relogged?.uiLanguage, "en");
    await assert.rejects(
      ownerPool.query(
        `UPDATE accounts SET ui_language = 'fr' WHERE principal_id = $1`,
        [first.principalId],
      ),
    );
    // 非法值经仓储规整后按默认中文保存。
    await accounts.saveUiLanguage("ws_demo", first.principalId, "fr" as never);
    const normalized = await accounts.findByPrincipal("ws_demo", first.principalId);
    assert.equal(normalized?.uiLanguage, "zh-CN");
    // 受限 realm_runtime 角色可保存该列（0015 授权验证）。
    const runtimeUrlForLang = new URL(process.env.REALM_RUNTIME_DATABASE_URL!);
    runtimeUrlForLang.pathname = `/${databaseName}`;
    const runtimeLangPool = new pg.Pool({
      connectionString: runtimeUrlForLang.href,
      max: 1,
    });
    await createPostgresAccountRepository(runtimeLangPool).saveUiLanguage(
      "ws_demo",
      first.principalId,
      "ja",
    );
    await runtimeLangPool.end();
    const afterRuntime = await accounts.findByPrincipal("ws_demo", first.principalId);
    assert.equal(afterRuntime?.uiLanguage, "ja");

    // 登录即加入默认世界：membership 自动创建且幂等。
    await accounts.ensureDefaultWorldMembership("ws_demo", first.principalId);
    await accounts.ensureDefaultWorldMembership("ws_demo", first.principalId);
    const memberships = await ownerPool.query(
      `SELECT role, omniscient_player_character, can_view_dynamic_knowledge
       FROM player_world_memberships
       WHERE workspace_id = 'ws_demo'
         AND world_id = 'world_ember_coast'
         AND principal_id = $1`,
      [first.principalId],
    );
    assert.equal(memberships.rows.length, 1);
    assert.equal(memberships.rows[0].role, "owner");
    assert.equal(memberships.rows[0].omniscient_player_character, true);
    assert.equal(memberships.rows[0].can_view_dynamic_knowledge, true);
    const columns = await ownerPool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'accounts'`,
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name).sort(),
      // 0015 新增 ui_language（界面语言，非凭据）；
      // 0017 新增 last_world_id / last_record_id（账号级「最近打开」记忆）。
      [
        "created_at",
        "display_name",
        "last_record_id",
        "last_world_id",
        "principal_id",
        "ui_language",
        "workspace_id",
      ],
    );

    // 批次 S：账号级「最近打开」记忆。
    // 初始无记忆（NULL）→ findLastOpened 返回 null。
    assert.equal(await accounts.findLastOpened("ws_demo", first.principalId), null);
    await accounts.saveLastOpened(
      "ws_demo",
      first.principalId,
      "world_ember_coast",
      "record_first_watch",
    );
    assert.deepEqual(await accounts.findLastOpened("ws_demo", first.principalId), {
      worldId: "world_ember_coast",
      recordId: "record_first_watch",
    });
    // 悬空记录被 FK 拒绝（ON DELETE SET NULL 只覆盖删除路径）。
    await assert.rejects(
      accounts.saveLastOpened("ws_demo", first.principalId, "world_ember_coast", "record_missing"),
    );

    // 登录写入路径使用受限 realm_runtime 角色：验证 INSERT 授权真实存在。
    const runtimeEnv = process.env.REALM_RUNTIME_DATABASE_URL;
    assert.ok(runtimeEnv, "REALM_RUNTIME_DATABASE_URL is required");
    const runtimeUrl = new URL(runtimeEnv);
    runtimeUrl.pathname = `/${databaseName}`;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 1 });
    const runtimeAccounts = createPostgresAccountRepository(runtimePool);
    const runtimeAccount = await runtimeAccounts.findOrCreate(
      "ws_demo",
      "受限角色写入者",
    );
    await runtimeAccounts.ensureDefaultWorldMembership(
      "ws_demo",
      runtimeAccount.principalId,
    );
    const runtimeMembership = await ownerPool.query(
      `SELECT count(*)::int AS count
       FROM player_world_memberships
       WHERE workspace_id = 'ws_demo' AND principal_id = $1`,
      [runtimeAccount.principalId],
    );
    assert.equal(runtimeMembership.rows[0].count, 1);
    // 批次 S：受限 realm_runtime 角色可写「最近打开」两列（0017 列级授权验证）。
    await runtimeAccounts.saveLastOpened(
      "ws_demo",
      runtimeAccount.principalId,
      "world_ember_coast",
      "record_first_watch",
    );
    const runtimeMemory = await ownerPool.query(
      `SELECT last_world_id, last_record_id FROM accounts WHERE principal_id = $1`,
      [runtimeAccount.principalId],
    );
    assert.deepEqual(runtimeMemory.rows[0], {
      last_world_id: "world_ember_coast",
      last_record_id: "record_first_watch",
    });
    await runtimePool.end();
  },
);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^realm_auth_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
