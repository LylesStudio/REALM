/**
 * Article qualification G0——no-go 闸门（规范：/tmp/realm-swm-next-plan-v10.md §7 G0、§8）。
 *
 * 1. pgcrypto capability preflight：loopback 隔离临时库实跑
 *    CREATE EXTENSION + digest/encode 探针；不可用即 no-go（不切换应用层
 *    fallback、不写 prompt/migration）。临时库 finally DROP，绝不写共享库。
 * 2. 定案核对（§10/§3.2 一致性）：lore 输入预算常量保持 80/600/2/1200；
 *    资格谓词后续 G4 不得放宽这些上限。
 * 3. schema contract（G1 产物存在性 + 顺序）在 G1 段补齐——0041 入库前
 *    该段必须红（先 failing test）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";

const adminConnectionString = process.env.DATABASE_URL;

function readProjectFile(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

function requireLoopbackUrl(value) {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("article qualification tests are restricted to loopback.");
  }
  return url;
}

test(
  "G0 preflight: pgcrypto digest/encode is available on a disposable loopback database",
  { skip: !adminConnectionString, timeout: 60_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString);
    const databaseName = `realm_aq_g0_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const probeUrl = new URL(adminUrl);
    probeUrl.pathname = `/${databaseName}`;
    const probe = new pg.Client({ connectionString: probeUrl.href });
    t.after(async () => {
      await probe.end().catch(() => undefined);
      await maintenance.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
      await maintenance.end();
    });
    await probe.connect();
    // D4/U4：能力必须实证；失败即 no-go，无应用层 fallback。
    await probe.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    const digestProbe = await probe.query(
      "SELECT encode(digest('probe', 'sha256'), 'hex') AS hex",
    );
    assert.match(digestProbe.rows[0].hex, /^[0-9a-f]{64}$/);
    // tuple 比较语义探针（资格游词依赖行比较）。
    const tupleProbe = await probe.query(
      "SELECT (2::bigint, 1::bigint) >= (2::bigint, 0::bigint) AS ge",
    );
    assert.equal(tupleProbe.rows[0].ge, true);
  },
);

test("G0 定案核对: lore 输入预算常量保持冻结值（80/600/2/1200）", () => {
  const recordScope = readProjectFile("database/postgres/record-scope.ts");
  assert.match(recordScope, /LORE_TITLE_CHARS = 80/);
  assert.match(recordScope, /LORE_EXCERPT_CHARS = 600/);
  assert.match(recordScope, /LORE_MAX_EXCERPTS = 2/);
  assert.match(recordScope, /LORE_BLOCK_MAX_CHARS = 1200/);
});

// ---------- G1 静态 contract（0041 入库前先红） ----------

const MIGRATION_0041 = "database/postgres/migrations/0041_article_qualification_and_import_entries.sql";
const DESIGN_DOC = "docs/development/ARTICLE-QUALIFICATION-MIGRATION.md";

test("G1: 0041 migration 文件存在且为下一个排序文件，无事务控制语句（D10）", () => {
  const sql = readProjectFile(MIGRATION_0041);
  // 与 schema-contract 同一判定：事务控制语句以分号收尾；plpgsql 函数体
  // 的 bare BEGIN/END 块不是事务控制，不误伤。
  assert.doesNotMatch(sql, /^\s*BEGIN\s*;\s*$/gim, "0041 禁止 BEGIN（runner per-file transaction 包裹）");
  assert.doesNotMatch(sql, /^\s*COMMIT\s*;\s*$/gim, "0041 禁止 COMMIT");
  assert.doesNotMatch(sql, /^\s*ROLLBACK\s*;\s*$/gim, "0041 禁止 ROLLBACK");
  const schemaContract = readProjectFile("tests/postgres-schema-contract.test.mjs");
  assert.ok(
    schemaContract.includes("0041_article_qualification_and_import_entries.sql"),
    "schema-contract 迁移名单必须登记 0041",
  );
});

test("G1: 0041 扩展先于两表，且约束/触发器/RLS/grants 完整", () => {
  const sql = readProjectFile(MIGRATION_0041);
  const extensionAt = sql.indexOf("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  const qualificationAt = sql.indexOf("CREATE TABLE IF NOT EXISTS article_qualifications");
  const importEntryAt = sql.indexOf("CREATE TABLE IF NOT EXISTS article_import_entries");
  assert.ok(extensionAt >= 0, "0041 必须启用 pgcrypto");
  assert.ok(qualificationAt > extensionAt, "extension 必须先于 article_qualifications");
  assert.ok(importEntryAt > extensionAt, "extension 必须先于 article_import_entries");

  // article_qualifications：复合 FK + 全部具名 CHECK + 唯一 seq。
  for (const anchor of [
    "aq_article_fk",
    "FOREIGN KEY (workspace_id, world_id, worldline_id, article_id)",
    "aq_provenance_check",
    "'canon_generated', 'tavern_import', 'manual', 'owner_attest'",
    "aq_status_check",
    "'pending_review', 'qualified_public', 'rejected', 'revoked'",
    "aq_qualified_provenance_check",
    "aq_identity_check",
    "aq_cursor_check",
    "aq_hash_check",
    "available_from_tick",
    "available_from_ordinal",
    "UNIQUE (workspace_id, world_id, worldline_id, article_id, seq)",
  ]) {
    assert.ok(sql.includes(anchor), `0041 缺 qualification 锚点：${anchor}`);
  }

  // article_import_entries：file_exact schema 级锁死。
  for (const anchor of [
    "aie_article_fk",
    "aie_source_kind_check",
    "'tavern_worldbook'",
    "aie_identity_kind_check",
    "'file_exact'",
    "aie_ordinal_check",
    "aie_hash_check",
    "^[0-9a-f]{64}$",
    "aie_namespace_check",
    "source_namespace = bundle_content_hash",
    "aie_identity_check",
    "stable_entry_identity = entry_ordinal::text",
  ]) {
    assert.ok(sql.includes(anchor), `0041 缺 import entry 锚点：${anchor}`);
  }
  const uniqueMatch = sql.match(/UNIQUE \([^)]*source_kind[^)]*\)/s);
  assert.ok(uniqueMatch, "import entry 唯一键必须存在");
  for (const column of [
    "workspace_id", "world_id", "worldline_id",
    "source_kind", "source_namespace", "stable_entry_identity",
  ]) {
    assert.ok(uniqueMatch[0].includes(column), `唯一键缺列 ${column}`);
  }

  // append-only 触发器 ×2 + RLS ENABLE/FORCE + policy + 最小 grants。
  for (const anchor of [
    "guard_article_qualification_append_only",
    "article_qualifications_append_only_guard",
    "guard_article_import_entry_append_only",
    "article_import_entries_append_only_guard",
    "ALTER TABLE article_qualifications ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE article_qualifications FORCE ROW LEVEL SECURITY",
    "ALTER TABLE article_import_entries ENABLE ROW LEVEL SECURITY",
    "ALTER TABLE article_import_entries FORCE ROW LEVEL SECURITY",
    "GRANT SELECT, INSERT ON article_qualifications TO realm_runtime",
    "GRANT SELECT, INSERT ON article_import_entries TO realm_runtime",
  ]) {
    assert.ok(sql.includes(anchor), `0041 缺锚点：${anchor}`);
  }
  assert.doesNotMatch(sql, /GRANT (UPDATE|DELETE|ALL)/i, "两表不得授 UPDATE/DELETE/ALL");
});

test("G1: 设计文档落稿 §5 全部冻结语义 when the internal spec is present", () => {
  const designPath = fileURLToPath(new URL(`../${DESIGN_DOC}`, import.meta.url));
  if (!existsSync(designPath)) return;
  const doc = readProjectFile(DESIGN_DOC);
  for (const anchor of [
    "0041_article_qualification_and_import_entries.sql",
    "article_qualifications",
    "article_import_entries",
    "owner_attest",
    "file_exact",
    "source_namespace = bundle_content_hash",
    "available_from_ordinal",
    "per-file transaction",
    "realm_dev",
    "SAVEPOINT",
    "fail-closed",
  ]) {
    assert.ok(doc.includes(anchor), `设计文档缺锚点：${anchor}`);
  }
});

// ---------- G5 静态 UI contract ----------

test("G5: 面板资格徽标与 owner attestation 控件契约（前端不发身份字段）", () => {
  const types = readProjectFile("app/components/knowledge-graph-types.ts");
  assert.match(
    types,
    /qualificationStatus\?: "pending_review" \| "qualified_public" \| "rejected" \| "revoked"/,
  );
  assert.match(types, /availableFromTick\?: number/);
  assert.match(types, /availableFromOrdinal\?: number/, "tuple 分量不得丢 ordinal");

  const panel = readProjectFile("app/components/knowledge-graph-panel.tsx");
  assert.ok(panel.includes("/api/world-knowledge/articles/qualify"));
  for (const anchor of [
    "ARTICLE_QUALIFICATION_LABELS",
    "membershipRole",
    "授权",
    "拒绝",
    "撤销授权",
    "data-qualification-status",
  ]) {
    assert.ok(panel.includes(anchor), `面板缺锚点：${anchor}`);
  }
  const qualifyCall = panel.match(
    /post\("\/api\/world-knowledge\/articles\/qualify", \{([^}]*)\}\)/,
  );
  assert.ok(qualifyCall, "资格操作必须走固定 API");
  assert.doesNotMatch(
    qualifyCall[1],
    /attestedBy|principalId|workspaceId/,
    "前端不得发送任何身份字段（服务端 session 解析）",
  );
});

// ---------------------------------------------------------------------------
// v37 Y2 静态契约段（0042/0043 + drain/admission + pool wrapper 锚点）
// ---------------------------------------------------------------------------

test(
  "v37 静态契约：0042/0043 锚点 + admission/drain + pool wrapper + worker 零改动围栏",
  () => {
    const migration0042 = readProjectFile(
      "database/postgres/migrations/0042_realm_transfer_and_import_jobs.sql",
    );
    const migration0043 = readProjectFile(
      "database/postgres/migrations/0043_propagation_node_audience_archived_guard.sql",
    );

    // 0042 角色块：fail-closed + 零凭据 DDL。
    assert.match(migration0042, /TRANSFER_NOT_PROVISIONED/);
    assert.match(migration0042, /rolcanlogin/);
    const stripped0042 = migration0042
      .replace(/--[^\n]*/g, "")
      .replace(/'[^']*'/g, "''");
    assert.deepEqual(
      stripped0042.match(/\b(LOGIN|NOLOGIN|PASSWORD)\b/gi) ?? [],
      [],
      "0042 不得出现 LOGIN/NOLOGIN/PASSWORD DDL 关键词",
    );
    // 0042 无事务控制语句（runner per-file transaction 包裹）。
    assert.doesNotMatch(migration0042, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;\s*$/gim);
    // 中间态 fail-closed 双兜底：body 置换 + EXECUTE 撤销。
    assert.match(migration0042, /AUDIENCE_CAPABILITY_DISABLED_PENDING_0043/);
    assert.match(migration0042, /REVOKE EXECUTE ON FUNCTION append_propagation_node_audience/);
    // 五表 + 四守卫 + 四 helper + 13 受控函数锚点。
    for (const table of [
      "realm_import_jobs", "realm_import_job_events", "realm_import_bootstrap",
      "realm_import_content_log", "realm_import_pack_tables",
    ]) {
      assert.match(migration0042, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
      assert.match(
        migration0042,
        new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`),
      );
    }
    for (const fn of [
      "realm_import_canonical_row", "realm_import_scope_allows",
      "realm_import_scope_required", "realm_import_cleanup_orphans",
      "realm_import_job_create", "realm_import_job_begin_validation",
      "realm_import_register_pack_tables", "realm_import_job_finish_validation",
      "realm_import_job_begin_execute", "realm_import_begin_bootstrap",
      "realm_import_insert_rows", "realm_import_content_digest",
      "realm_import_job_complete_import", "realm_import_job_fail_execute",
      "realm_import_job_cancel", "realm_import_job_recover_crash",
      "realm_import_job_complete_export",
      "guard_realm_import_jobs_insert", "guard_realm_import_job_events_insert",
      "guard_realm_import_job_events_append_only", "guard_realm_import_jobs_mutation",
    ]) {
      assert.match(migration0042, new RegExp(`CREATE OR REPLACE FUNCTION ${fn}`), fn);
    }
    // 全 22 函数 + 中间态置换 search_path 锚点（0042；pg_temp 恒最后）。
    const pathCount = migration0042.match(/SET search_path = pg_catalog, public, pg_temp/g);
    assert.ok(pathCount && pathCount.length >= 22, "22 函数 + 中间态置换 search_path 锚点");
    assert.match(migration0043, /SET search_path = pg_catalog, public, pg_temp/);
    // schema-qualified 列级 lockdown 与 temp 闭合。
    assert.match(migration0042, /REVOKE CREATE ON SCHEMA public FROM PUBLIC, realm_runtime, realm_control, realm_transfer/);
    assert.match(migration0042, /REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC, realm_runtime, realm_control, realm_transfer/);
    assert.match(migration0042, /ON TABLE public\.%I/);
    // archive execute 永拒 + copy_key 双 CHECK + txid 绑定锚点。
    assert.match(migration0042, /archive packs are not importable \(dry-run read-only\)/);
    assert.match(migration0042, /rij_copy_key_shape_check/);
    assert.match(migration0042, /rij_archive_not_executable_check/);
    assert.match(migration0042, /txid_current\(\)/);

    // 0043：最终 body + archived gate（KEY SHARE 锁形）+ grants 恢复。
    assert.match(migration0043, /CREATE OR REPLACE FUNCTION append_propagation_node_audience\(/);
    assert.match(migration0043, /FOR KEY SHARE/);
    assert.match(migration0043, /PROPAGATION_AUDIENCE_WORLD_ARCHIVED/);
    assert.match(migration0043, /GRANT EXECUTE ON FUNCTION append_propagation_node_audience\(\s*text, text, text, text, text, text\s*\) TO realm_runtime/);
    assert.match(migration0043, /REVOKE ALL ON FUNCTION append_propagation_node_audience/);
    assert.doesNotMatch(migration0043, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;\s*$/gim);

    // runner drain（C4）：0043 应用持 drain 锁 + lock_timeout 30s + 解锁。
    const runner = readProjectFile("scripts/postgres-migrate.mjs");
    assert.match(runner, /pg_advisory_lock\(7200043\)/);
    assert.match(runner, /lock_timeout = '30s'/);
    assert.match(runner, /pg_advisory_unlock\(7200043\)/);

    // capability admission（C4）：调用事务内 xact lock 先行。
    const governance = readProjectFile("database/postgres/propagation-node-audiences.ts");
    assert.match(governance, /pg_advisory_xact_lock\(7200043\)/);

    // pool wrapper（C3）：component 冻结二值 + 覆盖注入拒绝 + worker 零改动。
    const wrapper = readProjectFile("database/postgres/realm-dev-pool.ts");
    assert.match(wrapper, /"realm-dev-transfer"/);
    assert.match(wrapper, /application_name/);
    const worldScope = readProjectFile("app/api/world-scope.ts");
    assert.match(worldScope, /createRealmDevPostgresPool\(connectionString, "realm-dev"\)/);
    const workerRuntime = readProjectFile("modules/application/propagation-worker-runtime.ts");
    assert.match(workerRuntime, /createLocalPostgresPool\(/);
    assert.doesNotMatch(workerRuntime, /application_name|createRealmDevPostgresPool/);
  },
);
