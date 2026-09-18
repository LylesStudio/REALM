/**
 * Article qualification G1——0041 隔离应用验证（plan v10 §7 G1）。
 * 全部在 loopback 临时库（finally DROP；绝不触碰共享 realm_test）：
 * DB-A（真实 scripts/postgres-migrate.mjs 应用 0001–0041 全链）：
 *   ① pgcrypto 扩展、两表、复合 FK、全部具名 CHECK、append-only 触发器、
 *      FORCE RLS + policy、realm_runtime 最小 grants 实查；
 *   ② 台账含 0041 且 checksum = 文件 sha256；重复应用全部 skip；
 *   ③ realm_runtime/owner 行为探针（namespace CHECK 拒绝、append-only
 *      触发器拒绝 UPDATE、runtime DELETE permission denied）；
 *   ④ 篡改台账 checksum → runner fail-closed（Applied migration was modified）。
 * DB-B（手工复刻 runner per-file transaction 语义）：
 *   ⑤ 0001–0040 逐文件应用后，0041 SQL + 失败语句同一事务 → ROLLBACK，
 *      两表/台账零残留。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { seedPostgresDemo } from "../database/postgres/public.ts";

const execFileAsync = promisify(execFile);
const adminConnectionString = process.env.DATABASE_URL;

const MIGRATION_0041 = "0041_article_qualification_and_import_entries.sql";
const ZERO_HASH = "0".repeat(64);
const ONE_HASH = "1".repeat(64);
const FF_HASH = "f".repeat(64);

function requireLoopbackUrl(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("migration isolation tests are restricted to loopback.");
  }
  return url;
}

function runRunner(databaseUrl) {
  return execFileAsync(
    process.execPath,
    ["scripts/postgres-migrate.mjs"],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

async function createTempDatabase(t, label) {
  const adminUrl = requireLoopbackUrl(adminConnectionString);
  const databaseName = `realm_aq_${label}_${randomUUID().replaceAll("-", "").slice(0, 14)}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });
  t.after(async () => {
    await runtimePool.end().catch(() => undefined);
    await ownerPool.end().catch(() => undefined);
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
    await maintenance.end();
  });
  return { databaseName, ownerUrl, ownerPool, runtimePool };
}

test(
  "G1 DB-A: 0041 applies via the real runner; schema/grants/ledger/idempotency/checksum hold",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const { ownerUrl, ownerPool, runtimePool } = await createTempDatabase(t, "miga");

    const migration0041 = await readFile(
      new URL(`../database/postgres/migrations/${MIGRATION_0041}`, import.meta.url),
      "utf8",
    );
    const checksum0041 = createHash("sha256").update(migration0041).digest("hex");

    const firstRun = await runRunner(ownerUrl.href);
    assert.match(
      firstRun.stdout,
      new RegExp(`apply ${MIGRATION_0041.replace(".", "\\.")}`),
    );

    // ---- ① schema 实查 ----
    const extension = await ownerPool.query(
      "SELECT extversion FROM pg_extension WHERE extname = 'pgcrypto'",
    );
    assert.equal(extension.rowCount, 1, "pgcrypto 必须启用");
    for (const table of ["article_qualifications", "article_import_entries"]) {
      const reg = await ownerPool.query("SELECT to_regclass($1) AS reg", [`public.${table}`]);
      assert.ok(reg.rows[0].reg, `${table} 必须存在`);
      const rls = await ownerPool.query(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass",
        [`public.${table}`],
      );
      assert.deepEqual(
        [rls.rows[0].relrowsecurity, rls.rows[0].relforcerowsecurity],
        [true, true],
        `${table} 必须 ENABLE+FORCE RLS`,
      );
      const policy = await ownerPool.query(
        "SELECT polname FROM pg_policy WHERE polrelid = $1::regclass",
        [`public.${table}`],
      );
      assert.deepEqual(policy.rows.map((row) => row.polname), ["realm_workspace_isolation"]);
    }
    const constraints = await ownerPool.query(
      `SELECT conname FROM pg_constraint
       WHERE conrelid IN ('public.article_qualifications'::regclass,
                          'public.article_import_entries'::regclass)`,
    );
    const constraintNames = new Set(constraints.rows.map((row) => row.conname));
    for (const name of [
      "aq_workspace_fk", "aq_article_fk", "aq_provenance_check",
      "aq_status_check", "aq_qualified_provenance_check", "aq_identity_check",
      "aq_cursor_check", "aq_hash_check",
      "aie_workspace_fk", "aie_article_fk", "aie_source_kind_check",
      "aie_identity_kind_check", "aie_ordinal_check", "aie_hash_check",
      "aie_namespace_check", "aie_identity_check",
    ]) {
      assert.ok(constraintNames.has(name), `缺约束 ${name}`);
    }
    const triggers = await ownerPool.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgrelid IN ('public.article_qualifications'::regclass,
                         'public.article_import_entries'::regclass)
         AND NOT tgisinternal`,
    );
    const triggerNames = new Set(triggers.rows.map((row) => row.tgname));
    assert.ok(triggerNames.has("article_qualifications_append_only_guard"));
    assert.ok(triggerNames.has("article_import_entries_append_only_guard"));

    // realm_runtime 最小授权：SELECT/INSERT 有，UPDATE/DELETE 无。
    for (const table of ["article_qualifications", "article_import_entries"]) {
      for (const [privilege, expected] of [
        ["SELECT", true], ["INSERT", true], ["UPDATE", false], ["DELETE", false],
      ]) {
        const grant = await ownerPool.query(
          "SELECT has_table_privilege('realm_runtime', $1, $2) AS ok",
          [table, privilege],
        );
        assert.equal(grant.rows[0].ok, expected, `${table} ${privilege} 授权错误`);
      }
    }

    // ---- ② 台账 checksum ----
    const ledger = await ownerPool.query(
      "SELECT checksum FROM realm_schema_migrations WHERE filename = $1",
      [MIGRATION_0041],
    );
    assert.equal(ledger.rowCount, 1, "台账必须含 0041");
    assert.equal(ledger.rows[0].checksum, checksum0041, "台账 checksum 必须匹配文件 sha256");

    // ---- ③ 行为探针 ----
    await seedPostgresDemo(ownerPool);
    const ws = "ws_demo";
    await ownerPool.query(
      `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body)
       VALUES ($1, 'world_ember_coast', 'worldline_origin', 'article_aq_probe', '探针', '探针正文')`,
      [ws],
    );
    // realm_runtime 插入 namespace ≠ bundle hash → aie_namespace_check 拒绝。
    // set_config 是会话级：必须固定同一连接（pool 逐 query 换连接会丢设置）。
    const runtimeClient = await runtimePool.connect();
    try {
      await runtimeClient.query("SELECT set_config('realm.workspace_id', $1, false)", [ws]);
      await assert.rejects(
        runtimeClient.query(
          `INSERT INTO article_import_entries (
             workspace_id, world_id, worldline_id, article_id, id,
             source_kind, source_namespace, stable_entry_identity, identity_kind,
             entry_uid, entry_ordinal, normalized_name,
             bundle_content_hash, entry_content_hash
           ) VALUES (
             $1, 'world_ember_coast', 'worldline_origin', 'article_aq_probe', 'aie_probe_bad',
             'tavern_worldbook', $2, '0', 'file_exact',
             NULL, 0, '探针', $3, $4
           )`,
          [ws, FF_HASH, ZERO_HASH, ONE_HASH],
        ),
        (error) => error instanceof Error && /aie_namespace_check/.test(error.message),
      );
      // realm_runtime UPDATE/DELETE 直接 permission denied（grant 最小面）。
      await assert.rejects(
        runtimeClient.query(
          `DELETE FROM article_qualifications WHERE workspace_id = $1`,
          [ws],
        ),
        (error) => error instanceof Error && /permission denied/.test(error.message),
      );
    } finally {
      await runtimeClient
        .query("SELECT set_config('realm.workspace_id', '', false)")
        .catch(() => undefined);
      runtimeClient.release();
    }
    // append-only 触发器：owner（superuser，绕 RLS）UPDATE 也被触发器拒绝。
    await ownerPool.query(
      `INSERT INTO article_qualifications (
         workspace_id, world_id, worldline_id, article_id, id, seq,
         provenance_kind, status, content_hash
       ) VALUES (
         $1, 'world_ember_coast', 'worldline_origin', 'article_aq_probe',
         'aq_probe_1', 1, 'tavern_import', 'pending_review', 'probehash'
       )`,
      [ws],
    );
    await assert.rejects(
      ownerPool.query(
        `UPDATE article_qualifications SET status = 'rejected'
         WHERE workspace_id = $1 AND id = 'aq_probe_1'`,
        [ws],
      ),
      (error) => error instanceof Error && /append-only/.test(error.message),
    );

    // ---- ②b 重复应用幂等 skip ----
    const secondRun = await runRunner(ownerUrl.href);
    assert.match(
      secondRun.stdout,
      new RegExp(`skip  ${MIGRATION_0041.replace(".", "\\.")}`),
    );
    assert.doesNotMatch(secondRun.stdout, /apply /);

    // ---- ④ 台账篡改 → fail-closed ----
    await ownerPool.query(
      "UPDATE realm_schema_migrations SET checksum = $2 WHERE filename = $1",
      [MIGRATION_0041, ZERO_HASH],
    );
    await assert.rejects(
      runRunner(ownerUrl.href),
      (error) => error instanceof Error
        && /Applied migration was modified/.test(String(error.stderr ?? error.message)),
    );
  },
);

test(
  "G1 DB-B: a failing 0041 file rolls back as one transaction with zero residue",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const { ownerPool } = await createTempDatabase(t, "migb");

    // 手工复刻 runner 语义：逐文件应用 0001–0040（不含 0041）。
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    const filenames = (await readdir(migrationDir))
      .filter((name) => name.endsWith(".sql") && !/^004[123]_/.test(name))
      .sort();
    for (const filename of filenames) {
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    const before = await ownerPool.query(
      "SELECT to_regclass('public.article_qualifications') AS reg",
    );
    assert.equal(before.rows[0].reg, null);
    // runner 会先自建台账表（独立事务）；手工复刻同一前置。
    await ownerPool.query(`
      CREATE TABLE IF NOT EXISTS realm_schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // per-file transaction：0041 SQL + 失败语句同一事务 → 整体 ROLLBACK。
    const migration0041 = await readFile(new URL(MIGRATION_0041, migrationDir), "utf8");
    const client = await ownerPool.connect();
    try {
      await client.query("BEGIN");
      try {
        await client.query(migration0041);
        await client.query("SELECT * FROM relation_that_does_not_exist");
        await client.query(
          "INSERT INTO realm_schema_migrations (filename, checksum) VALUES ($1, $2)",
          [MIGRATION_0041, ZERO_HASH],
        );
        await client.query("COMMIT");
        assert.fail("失败语句必须触发回滚分支");
      } catch {
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }

    const after = await ownerPool.query(
      `SELECT to_regclass('public.article_qualifications') AS aq,
              to_regclass('public.article_import_entries') AS aie,
              (SELECT count(*)::int FROM realm_schema_migrations WHERE filename = $1) AS ledger`,
      [MIGRATION_0041],
    );
    assert.equal(after.rows[0].aq, null, "0041 失败回滚不得留下 article_qualifications");
    assert.equal(after.rows[0].aie, null, "0041 失败回滚不得留下 article_import_entries");
    assert.equal(after.rows[0].ledger, 0, "0041 失败回滚不得留下台账行");
  },
);
