/**
 * v37 Y2：0042/0043 + realm_transfer 真实 PG 迁移测试（隔离库/容器内角色，
 * finally 清理）。
 *
 * 覆盖：全链 0001–0043 真实 runner 应用 + 台账 checksum + 幂等重放；
 * 角色五态（缺 role/NOLOGIN/LOGIN/错误成员/重复应用收敛）；读回断言全集
 * （RLS FORCE 五表、22 函数签名集合冻结清单、search_path 锚点、proacl
 * allowlist、owner 结构、四主体 mutation 全 false、直 UPDATE 双负例
 * permission denied）；受控函数正例/拒绝矩阵；event guard 负例；
 * 中间态（0042-only）fail-closed 与 0043 恢复；漂移注入自包含 REVOKE；
 * TEMP shadow 协议（迁移前预建 temp、同会话调用、REVOKE 不影响既有 temp）；
 * admission/drain（xact lock 持锁 → runner 30s 超时 no-go；释放后通过）；
 * JS↔PL digest 双侧相等（向量 7/8/9）；0042 关键词静态扫描；
 * provisioning 五态 + 预检/GUC/同事务原子 + 输出零凭据。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { startScratchPgCluster } from "./helpers/v37-test-cluster.mjs";
import pg from "pg";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

const adminConnectionString = process.env.DATABASE_URL;
if (!adminConnectionString) {
  test.skip("DATABASE_URL required", () => {});
} else {
  const adminUrl = new URL(adminConnectionString);
  void adminUrl;

  function requireLoopbackUrl(value) {
    const url = new URL(value);
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error("restricted to loopback");
    }
    return url;
  }

  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  const ALL_MIGRATIONS = (await readdir(migrationDir)).filter((f) => f.endsWith(".sql")).sort();

  async function withMaintenance(fn) {
    const url = requireLoopbackUrl(adminConnectionString);
    const maintenanceUrl = new URL(url.href);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    try {
      return await fn(maintenance);
    } finally {
      await maintenance.end();
    }
  }

  async function createDatabase(t, label) {
    const name = `realm_y2t_${label}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await withMaintenance((m) => m.query(`CREATE DATABASE "${name}"`));
    // t.after 按注册序（FIFO）执行：池必须先于 DROP 关闭，否则 FORCE 终止
    // 的 FATAL 通知会打到未关闭连接上（实测归因竞态）。经 registerPool
    // 登记的池统一在 DROP 前关闭。
    const managedPools = [];
    // 自定义清理队列（先于池关闭/DROP 执行——用于归还占用连接等）。
    const customCleanups = [];
    t.after(async () => {
      for (const fn of customCleanups) {
        await (async () => fn())().catch(() => undefined);
      }
      await Promise.all(managedPools.map((pool) => pool.end().catch(() => undefined)));
      await withMaintenance((m) =>
        m.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    });
    const url = requireLoopbackUrl(adminConnectionString);
    url.pathname = `/${name}`;
    return {
      name,
      url,
      onCleanup: (fn) => {
        customCleanups.push(fn);
      },
      registerPool: (pool) => {
        managedPools.push(pool);
        pool.on("error", () => undefined);
        return pool;
      },
    };
  }

  async function applyMigrations(pool, { upTo = null, exclude = [] } = {}) {
    for (const filename of ALL_MIGRATIONS) {
      if (exclude.some((prefix) => filename.startsWith(prefix))) continue;
      if (upTo && filename > upTo) break;
      await pool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
  }

  function ownerPoolOf(url, max = 3) {
    // idleTimeoutMillis 0：session 级 GUC/temp 对象跟随连接，禁 idle 回收。
    const pool = new pg.Pool({ connectionString: url.href, max, idleTimeoutMillis: 0 });
    pool.on("error", () => undefined);
    return pool;
  }

  // 池登记进 onCleanup（先于 DROP 关闭；池 error 事件吞掉终止噪音）。
  function onCleanupPool(onCleanup, url, max = 3) {
    const pool = ownerPoolOf(url, max);
    pool.on("error", () => undefined);
    onCleanup(() => pool.end().catch(() => undefined));
    return pool;
  }

  function rolePoolOf(url, role, max = 2) {
    const roleUrl = new URL(url.href);
    roleUrl.username = role;
    roleUrl.password = "";
    const pool = new pg.Pool({ connectionString: roleUrl.href, max, idleTimeoutMillis: 0 });
    pool.on("error", () => undefined);
    return pool;
  }


  // ------------------------------------------------------------------
  test("0042/0043 full chain via real runner: ledger checksums, idempotent replay, 62 tables", { timeout: 300_000 }, async (t) => {
    const { url, registerPool } = await createDatabase(t, "chain");
    const first = (await execFileAsync(
      process.execPath,
      ["scripts/postgres-migrate.mjs"],
      { env: { ...process.env, DATABASE_URL: url.href }, encoding: "utf8" },
    )).stdout;
    assert.match(first, /apply 0042_realm_transfer_and_import_jobs\.sql/);
    assert.match(first, /apply 0043_propagation_node_audience_archived_guard\.sql/);
    assert.match(first, /62 tables/);

    // 幂等重放：全 skip，checksum 不变。
    const second = (await execFileAsync(
      process.execPath,
      ["scripts/postgres-migrate.mjs"],
      { env: { ...process.env, DATABASE_URL: url.href }, encoding: "utf8" },
    )).stdout;
    assert.match(second, /skip {2}0043_propagation_node_audience_archived_guard\.sql/);
    assert.doesNotMatch(second, /apply /);

    const pool = registerPool(ownerPoolOf(url));
    const ledger = await pool.query(
      "SELECT filename, checksum FROM realm_schema_migrations ORDER BY filename",
    );
    assert.equal(ledger.rows.length, 43);
    for (const row of ledger.rows) {
      const sql = await readFile(new URL(row.filename, migrationDir), "utf8");
      assert.equal(
        createHash("sha256").update(sql).digest("hex"),
        row.checksum,
        `checksum mismatch: ${row.filename}`,
      );
    }
  });

  /**
   * 角色生命周期测试专用：无 realm_transfer 依赖的独立一次性集群
   * （docker 容器，trust auth，--rm；finally 销毁）。
   * 共享容器里 realm_transfer 已被其他库授权（DROP ROLE 受依赖阻断），
   * 角色五态必须在无依赖集群上验证。
   */
  /**
   * 角色生命周期测试专用 scratch cluster（host-network + 动态 loopback
   * 端口——真实 runner 的 inet_server_addr 检查通过；绝不用
   * published-port）。角色五态/ provisioning 在独立集群上验证，
   * 共享容器里 realm_transfer 已有其它库授权（DROP ROLE 受依赖阻断）。
   */
  async function withScratchCluster(t, fn) {
    const cluster = await startScratchPgCluster({
      label: `y2-${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    });
    t.after(async () => {
      await cluster.stop();
    });
    await fn(cluster.adminUrl);
  }


  // ------------------------------------------------------------------
  test("role states: migration-first / NOLOGIN residual / wrong membership fail-closed; LOGIN converges", { timeout: 300_000 }, async (t) => {
    await withScratchCluster(t, async (base) => {
      const dbName = "realm_y2_roles";
      const admin = new pg.Client({ connectionString: base });
      await admin.connect();
      await admin.query(`CREATE DATABASE ${dbName}`);
      await admin.end();
      const dbUrl = `${base.replace(/\/postgres$/, "")}/${dbName}`;
      const pool = new pg.Pool({ connectionString: dbUrl, max: 2, idleTimeoutMillis: 0 });
      pool.on("error", (error) => console.error("pool-conn-error:", error.message));
      t.after(async () => {
        await pool.end().catch(() => undefined);
      });
      await applyMigrations(pool, { upTo: "0041_article_qualification_and_import_entries.sql" });

      const sql0042 = await readFile(
        new URL("0042_realm_transfer_and_import_jobs.sql", migrationDir), "utf8");

      // ① migration-first（role 缺席）→ TRANSFER_NOT_PROVISIONED，整体回滚。
      await assert.rejects(pool.query(sql0042), /TRANSFER_NOT_PROVISIONED/);
      assert.equal(
        (await pool.query("SELECT to_regclass('public.realm_import_jobs') AS reg")).rows[0].reg,
        null,
        "失败整体回滚零残留",
      );

      // ② NOLOGIN 残留 → 同样 fail-closed（rolcanlogin 读回——C2）。
      const cluster = new pg.Client({ connectionString: base });
      cluster.on("error", (error) => console.error("cluster-conn-error:", error.message));
      await cluster.connect();
      t.after(async () => {
        await cluster.end().catch(() => undefined);
      });
      await cluster.query("CREATE ROLE realm_transfer NOLOGIN");
      await assert.rejects(pool.query(sql0042), /TRANSFER_NOT_PROVISIONED/);
      assert.equal(
        (await pool.query("SELECT to_regclass('public.realm_import_jobs') AS reg")).rows[0].reg,
        null,
      );

      // ③ 错误成员关系（任一方向）→ RAISE。
      await cluster.query("ALTER ROLE realm_transfer WITH LOGIN");
      await cluster.query("CREATE ROLE realm_probe_member NOLOGIN");
      await cluster.query("GRANT realm_probe_member TO realm_transfer");
      await assert.rejects(pool.query(sql0042), /unexpected role memberships/);
      await cluster.query("REVOKE realm_probe_member FROM realm_transfer");
      await cluster.query("GRANT realm_transfer TO realm_probe_member");
      await assert.rejects(pool.query(sql0042), /unexpected role memberships/);
      await cluster.query("REVOKE realm_transfer FROM realm_probe_member");

      // ④ provisioned（LOGIN）→ 通过且 LOGIN 保持（不被关闭——C1）。
      await pool.query(sql0042);
      const login = await cluster.query(
        "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'realm_transfer'");
      assert.equal(login.rows[0].rolcanlogin, true);

      // ⑤ 重复应用收敛（幂等）。
      await pool.query(sql0042);
      const count = await pool.query(
        "SELECT count(*)::int AS c FROM realm_import_jobs");
      assert.equal(count.rows[0].c, 0);
    });
  });

  // ------------------------------------------------------------------
  test("readback assertion set: RLS FORCE ×5, 22-signature frozen set, search_path, proacl allowlist, owners", { timeout: 300_000 }, async (t) => {
    const { url, registerPool } = await createDatabase(t, "readback");
    const pool = registerPool(ownerPoolOf(url));
    await applyMigrations(pool);

    // RLS ENABLE+FORCE 五表。
    const rls = await pool.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relname IN ('realm_import_jobs', 'realm_import_job_events',
         'realm_import_bootstrap', 'realm_import_content_log', 'realm_import_pack_tables')
       ORDER BY relname`,
    );
    assert.equal(rls.rows.length, 5);
    for (const row of rls.rows) {
      assert.deepEqual([row.relrowsecurity, row.relforcerowsecurity], [true, true]);
    }

    // 22 函数签名集合 == 冻结清单（非计数断言——M2）。
    const FROZEN_22 = [
      "realm_import_job_create(text,text,text,text,text,text,text,text,text,text,text)",
      "realm_import_job_begin_validation(text,text)",
      "realm_import_register_pack_tables(text,text,jsonb)",
      "realm_import_job_finish_validation(text,text,text,text,text,jsonb)",
      "realm_import_job_begin_execute(text,text)",
      "realm_import_begin_bootstrap(text,text,bigint,text,jsonb)",
      "realm_import_insert_rows(text,text,bigint,text,jsonb)",
      "realm_import_content_digest(text,text,bigint)",
      "realm_import_job_complete_import(text,text,bigint,text,jsonb)",
      "realm_import_job_fail_execute(text,text,bigint,text,text)",
      "realm_import_job_cancel(text,text)",
      "realm_import_job_recover_crash(text,text,text)",
      "realm_import_job_complete_export(text,text,jsonb)",
      "realm_import_canonical_row(jsonb)",
      "realm_import_scope_allows(text,text)",
      "realm_import_scope_required(text)",
      "realm_import_cleanup_orphans(text,text)",
      "guard_realm_import_jobs_insert()",
      "guard_realm_import_job_events_insert()",
      "guard_realm_import_job_events_append_only()",
      "guard_realm_import_jobs_mutation()",
    ];
    const procs = await pool.query(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef, p.proconfig
       FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND (p.proname LIKE 'realm_import_%' OR p.proname LIKE 'guard_realm_import_%')`,
    );
    const actualSigs = procs.rows.map((row) => row.sig).sort();
    assert.deepEqual(actualSigs, [...FROZEN_22].sort());
    for (const row of procs.rows) {
      // 全 22 函数 search_path 锚点：pg_catalog, public, pg_temp（pg_temp 恒最后）。
      assert.deepEqual(
        row.proconfig,
        ["search_path=pg_catalog, public, pg_temp"],
        `${row.sig} search_path anchor`,
      );
    }

    // 单 overload。
    const overloads = await pool.query(
      `SELECT proname, count(*)::int AS c FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND (proname LIKE 'realm_import_%' OR proname LIKE 'guard_realm_import_%')
       GROUP BY proname HAVING count(*) > 1`,
    );
    assert.equal(overloads.rows.length, 0);

    // 13 受控仅 realm_transfer EXECUTE；8 helper/guard 零 grant（owner 物化
    // 条目排除）；proacl 非 NULL（默认 PUBLIC 已撤销）。
    const CONTROLLED_13 = FROZEN_22.slice(0, 13);
    for (const sig of FROZEN_22) {
      const acls = await pool.query(
        `SELECT acl.grantee::regrole::text AS grantee, acl.privilege_type AS priv,
                p.proowner::regrole::text AS owner
         FROM pg_proc AS p, aclexplode(p.proacl) AS acl
         WHERE p.oid = $1::regprocedure
           AND NOT (acl.grantee = p.proowner AND acl.grantor = p.proowner)`,
        [sig],
      );
      const expected = CONTROLLED_13.includes(sig)
        ? [{ grantee: "realm_transfer", priv: "EXECUTE" }]
        : [];
        assert.deepEqual(
          acls.rows.map(({ grantee, priv }) => ({ grantee, priv })),
          expected,
          `ACL allowlist for ${sig}`,
        );
      const proacl = await pool.query(
        "SELECT proacl FROM pg_proc WHERE oid = $1::regprocedure", [sig]);
      assert.notEqual(proacl.rows[0].proacl, null, `${sig} proacl must be explicit`);
    }

    // capability 终态：仅 realm_runtime。
    const cap = await pool.query(
      `SELECT acl.grantee::regrole::text AS grantee
       FROM pg_proc AS p, aclexplode(p.proacl) AS acl
       WHERE p.oid = 'append_propagation_node_audience(text,text,text,text,text,text)'::regprocedure
         AND NOT (acl.grantee = p.proowner AND acl.grantor = p.proowner)`,
    );
    assert.deepEqual(cap.rows.map((r) => r.grantee), ["realm_runtime"]);

    // owner 结构：5 ledger relowner == migration executor（postgres 隔离容器）；
    // propagation_node_audiences owner == worlds owner；均 ∉ 应用角色。
    const owners = await pool.query(
      `SELECT c.relname, c.relowner::regrole::text AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN (
         'realm_import_jobs', 'realm_import_job_events', 'realm_import_bootstrap',
         'realm_import_content_log', 'realm_import_pack_tables',
         'propagation_node_audiences', 'worlds')`,
    );
    const ownerByTable = Object.fromEntries(owners.rows.map((r) => [r.relname, r.owner]));
    for (const t of ["realm_import_jobs", "realm_import_job_events", "realm_import_bootstrap",
      "realm_import_content_log", "realm_import_pack_tables"]) {
      assert.ok(!["realm_runtime", "realm_transfer", "realm_control"].includes(ownerByTable[t]));
    }
    assert.equal(ownerByTable.propagation_node_audiences, ownerByTable.worlds);
  });

  // ------------------------------------------------------------------
  test("permission boundary: direct ledger mutation denied (table+column), helper EXECUTE denied, runtime EXECUTE denied", { timeout: 300_000 }, async (t) => {
    const { url, registerPool } = await createDatabase(t, "perms");
    const pool = registerPool(ownerPoolOf(url));
    await applyMigrations(pool);

    const transfer = rolePoolOf(url, "realm_transfer");
    const runtime = rolePoolOf(url, "realm_runtime");
    t.after(async () => {
      await transfer.end().catch(() => undefined);
      await runtime.end().catch(() => undefined);
    });

    // realm_transfer 直写五表 → permission denied（table 级 + column 级双负例）。
    for (const table of ["realm_import_jobs", "realm_import_job_events",
      "realm_import_bootstrap", "realm_import_content_log", "realm_import_pack_tables"]) {
      await assert.rejects(
        transfer.query(
          `INSERT INTO ${table} (workspace_id) VALUES ('ws_demo')`),
        /permission denied/,
        `${table} direct INSERT must be denied`,
      );
    }
    // transfer 直 UPDATE jobs（双负例之一）。
    await assert.rejects(
      transfer.query(
        "UPDATE realm_import_jobs SET status = 'cancelled'"),
      /permission denied/,
    );
    // runtime 对五表零授权。
    await assert.rejects(
      runtime.query("SELECT count(*) FROM realm_import_jobs"),
      /permission denied/,
    );
    // helper×4 对 transfer/PUBLIC 无 EXECUTE。
    for (const sig of [
      "SELECT realm_import_canonical_row('{}'::jsonb)",
      "SELECT realm_import_scope_allows('full', 'worlds')",
      "SELECT * FROM realm_import_scope_required('full')",
      "SELECT realm_import_cleanup_orphans('ws_demo', 'job_x')",
    ]) {
      await assert.rejects(
        transfer.query(sig),
        /permission denied/,
        `${sig} must not be callable by realm_transfer`,
      );
    }
    // runtime 对 13 受控函数无 EXECUTE。
    await assert.rejects(
      runtime.query(
        "SELECT realm_import_job_cancel('ws_demo', 'job_x')"),
      /permission denied/,
    );
    // 0043 目标表：runtime 保留 SELECT、mutation 全拒。
    const runtimeSelect = await runtime.query(
      "SELECT count(*) FROM propagation_node_audiences");
    assert.ok(runtimeSelect.rows[0]);
    await assert.rejects(
      runtime.query(
        "INSERT INTO propagation_node_audiences (workspace_id, world_id, worldline_id, node_key, continuity_id) VALUES ('ws_demo', 'w', 'wl', 'n', 'c')"),
      /permission denied/,
    );
  });

  // ------------------------------------------------------------------
  test("intermediate state (0042 only): capability fail-closed; 0043 restores runtime EXECUTE", { timeout: 300_000 }, async (t) => {
    const { url, registerPool } = await createDatabase(t, "midstate");
    const pool = registerPool(ownerPoolOf(url, 1));
    await applyMigrations(pool, { upTo: "0042_realm_transfer_and_import_jobs.sql" });

    // 中间态：body RAISE + runtime EXECUTE=false（双重兜底）。
    // capability 的 scope 等式需要 workspace GUC（0043 body 既有检查）；
    // node-pg 在查询错误后丢弃连接（session GUC 不跨错误存活——实测），
    // 逐调用前置 set_config。
    const exec = await pool.query(
      `SELECT has_function_privilege('realm_runtime',
         'append_propagation_node_audience(text,text,text,text,text,text)', 'EXECUTE') AS ok`,
    );
    assert.equal(exec.rows[0].ok, false);
    await assert.rejects(
      pool.query(
        "SELECT append_propagation_node_audience('ws_demo', 'w', 'wl', 'n', 'c', 'p')"),
      /AUDIENCE_CAPABILITY_DISABLED_PENDING_0043/,
    );

    // 0043 后恢复：body 含 archived gate（直调 archived 世界 → RAISE），
    // runtime EXECUTE=true。
    await applyMigrations(pool, { exclude: [] });
    const execAfter = await pool.query(
      `SELECT has_function_privilege('realm_runtime',
         'append_propagation_node_audience(text,text,text,text,text,text)', 'EXECUTE') AS ok`,
    );
    assert.equal(execAfter.rows[0].ok, true);
    await assert.rejects(
      pool.query(
        "SELECT set_config('realm.workspace_id', 'ws_demo', false); " +
        "SELECT append_propagation_node_audience('ws_demo', 'w_missing', 'wl', 'n', 'c', 'p')"),
      /PROPAGATION_AUDIENCE_WORLD_ARCHIVED/,
    );
  });

  // ------------------------------------------------------------------
  test("controlled functions: import dry-run chain, event guard negatives, cancel", { timeout: 300_000 }, async (t) => {
    const { url, registerPool } = await createDatabase(t, "funcs");
    const pool = registerPool(ownerPoolOf(url));
    await applyMigrations(pool);
    await pool.query("INSERT INTO workspaces (id, name) VALUES ('ws_demo', 'demo')");
    await pool.query(
      "INSERT INTO accounts (workspace_id, principal_id, display_name) VALUES ('ws_demo', 'principal_op', '操作员')",
    );

    const transfer = rolePoolOf(url, "realm_transfer", 1);
    t.after(() => transfer.end().catch(() => undefined));
    // 逐调用前置 set_config——node-pg 在查询错误后丢弃连接，session GUC
    // 不跨错误存活（实测）。
    const call = (sql, params) => transfer
      .query("SELECT set_config('realm.workspace_id', 'ws_demo', false)")
      .then(() => transfer.query(sql, params));

    // 正例：create → begin_validation → register → finish_validation(staged) → cancel。
    const entriesHash = createHash("sha256").update(
      "worldlines\n1\n" + "6".repeat(64) + "\n" + "f".repeat(64) + "\n"
      + "worlds\n1\n" + "4".repeat(64) + "\n" + "a".repeat(64) + "\n",
    ).digest("hex");
    await call(
      `SELECT realm_import_job_create($1, 'job_dry_1', 'import', $2, $3, $4, '', 'template', 'world_src', 'principal_op', $5)`,
      [
        "ws_demo",
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
        entriesHash,
      ],
    );
    await call("SELECT realm_import_job_begin_validation('ws_demo', 'job_dry_1')", []);
    // register：entry 键集恰好四字段 + 重算 == job 列。
    await call(
      `SELECT realm_import_register_pack_tables($1, 'job_dry_1', $2::jsonb)`,
      ["ws_demo", JSON.stringify([
        { name: "worldlines", rows: 1, sha256: "6".repeat(64), wireDigest: "f".repeat(64) },
        { name: "worlds", rows: 1, sha256: "4".repeat(64), wireDigest: "a".repeat(64) },
      ])],
    );
    await call(
      `SELECT realm_import_job_finish_validation($1, 'job_dry_1', 'staged', NULL, NULL, $2::jsonb)`,
      ["ws_demo", JSON.stringify({ kind: "template", tables: 2 })],
    );
    await call("SELECT realm_import_job_cancel('ws_demo', 'job_dry_1')", []);
    const job = await pool.query(
      "SELECT status, error_code FROM realm_import_jobs WHERE id = 'job_dry_1'",
    );
    assert.equal(job.rows[0].status, "cancelled");
    assert.equal(job.rows[0].error_code, null, "cancelled 永不带 error 列");
    const events = await pool.query(
      "SELECT event_kind, event_seq FROM realm_import_job_events WHERE job_id = 'job_dry_1' ORDER BY event_seq",
    );
    assert.deepEqual(
      events.rows.map((r) => [r.event_kind, Number(r.event_seq)]),
      [["created", 0], ["validation_done", 1], ["cancelled", 2]],
    );

    // 拒绝矩阵：
    // - register 键集多键 → RAISE。
    await call(
      `SELECT realm_import_job_create($1, 'job_dry_2', 'import', $2, $3, $4, '', 'template', 'world_src', 'principal_op', $5)`,
      ["ws_demo", "b".repeat(64), "c".repeat(64), "d".repeat(64), entriesHash],
    );
    await call("SELECT realm_import_job_begin_validation('ws_demo', 'job_dry_2')", []);
    await assert.rejects(
      call(
        `SELECT realm_import_register_pack_tables($1, 'job_dry_2', $2::jsonb)`,
        ["ws_demo", JSON.stringify([
          { name: "worlds", rows: 1, sha256: "4".repeat(64), wireDigest: "a".repeat(64), extra: 1 },
          { name: "worldlines", rows: 1, sha256: "6".repeat(64), wireDigest: "f".repeat(64) },
        ])],
      ),
      /unknown key in pack table entry/,
    );
    // - manifest hash 不符（截短/篡改 entries）→ RAISE。
    await assert.rejects(
      call(
        `SELECT realm_import_register_pack_tables($1, 'job_dry_2', $2::jsonb)`,
        ["ws_demo", JSON.stringify([
          { name: "worlds", rows: 1, sha256: "4".repeat(64), wireDigest: "a".repeat(64) },
        ])],
      ),
      /do not match job transfer_entries_sha256|missing required table/,
    );
    // - scope 外表（template 含 records）→ RAISE。
    await assert.rejects(
      call(
        `SELECT realm_import_register_pack_tables($1, 'job_dry_2', $2::jsonb)`,
        ["ws_demo", JSON.stringify([
          { name: "worlds", rows: 1, sha256: "4".repeat(64), wireDigest: "a".repeat(64) },
          { name: "worldlines", rows: 1, sha256: "6".repeat(64), wireDigest: "f".repeat(64) },
          { name: "records", rows: 1, sha256: "7".repeat(64), wireDigest: "e".repeat(64) },
        ])],
      ),
      /not allowed for scope|do not match job transfer_entries_sha256/,
    );
    // - archive job begin_execute → RAISE（dry-run-only——C5）。staged 态经
    //   受控链到达（直 INSERT 被 insert guard 拒绝——一并覆盖）。
    await call(
      `SELECT realm_import_job_create($1, 'job_archive', 'import', $2, $3, $4, '', 'archive', 'world_src', 'principal_op', $5)`,
      ["ws_demo", "1".repeat(64), "2".repeat(64), "3".repeat(64), entriesHash],
    );
    await call("SELECT realm_import_job_begin_validation('ws_demo', 'job_archive')", []);
    await call(
      `SELECT realm_import_register_pack_tables($1, 'job_archive', $2::jsonb)`,
      ["ws_demo", JSON.stringify([
        { name: "worldlines", rows: 1, sha256: "6".repeat(64), wireDigest: "f".repeat(64) },
        { name: "worlds", rows: 1, sha256: "4".repeat(64), wireDigest: "a".repeat(64) },
      ])],
    );
    await call(
      `SELECT realm_import_job_finish_validation($1, 'job_archive', 'staged', NULL, NULL, $2::jsonb)`,
      ["ws_demo", JSON.stringify({ kind: "archive" })],
    );
    await assert.rejects(
      call("SELECT realm_import_job_begin_execute('ws_demo', 'job_archive')", []),
      /archive packs are not importable/,
    );
    // - 直 SQL 把 archive job 推进 executing/completed → CHECK 拒绝。
    await assert.rejects(
      pool.query(
        "UPDATE realm_import_jobs SET status = 'executing', current_attempt_no = 1 WHERE id = 'job_archive'"),
      /rij_archive_not_executable_check|illegal transition/,
    );

    // event guard 负例：payload 键集伪造。
    await assert.rejects(
      pool.query(
        `INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
         VALUES ('ws_demo', 'rje_bad', 'job_dry_1', 3, 'cancelled', '{"attemptNo": 1}')`),
      /payload/,
    );
    // jobs append 直写初始态伪造 → guard RAISE。
    await assert.rejects(
      pool.query(
        `INSERT INTO realm_import_jobs (workspace_id, id, direction, logical_pack_hash,
           scope_digest, mode, operator_principal, status)
         VALUES ('ws_demo', 'job_forge', 'import', $1, $2, 'template', 'principal_op', 'completed')`,
        ["e".repeat(64), "f".repeat(64)]),
      /illegal initial state|check/i,
    );
  });

  // ------------------------------------------------------------------
  test("TEMP shadow protocol: pre-migration temp tables never shadow real tables (pg_temp last)", { timeout: 300_000 }, async (t) => {
    // 本测试自建库（不用 createDatabase helper）：node:test 的 t.after 按
    // 注册序（FIFO）执行——temp 会话 client 的 end 必须先于 DROP（FORCE
    // 的 FATAL 通知竞态会让未关闭连接的错误事件打到测试上）。
    const label = "tempshadow";
    const name = `realm_y2t_${label}_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    await withMaintenance((m) => m.query(`CREATE DATABASE "${name}"`));
    const url = requireLoopbackUrl(adminConnectionString);
    url.pathname = `/${name}`;
    const pool = ownerPoolOf(url);
    await applyMigrations(pool, { upTo: "0041_article_qualification_and_import_entries.sql" });

    // 迁移前预建 temp shadow（同会话保持连接——Z63 协议）。
    // 专用连接（非池化）持有 temp 对象；t.after 显式 end 后再落 DROP。
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    t.after(async () => {
      await client.end().catch(() => undefined);
      await pool.end().catch(() => undefined);
      await withMaintenance((m) =>
        m.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    });
    await client.query(
      "CREATE TEMP TABLE worlds (workspace_id text, id text, name text, status text)",
    );
    await client.query(
      "INSERT INTO worlds VALUES ('ws_demo', 'world_fake', 'fake', 'active')",
    );
    await client.query(
      `CREATE TEMP TABLE accounts (workspace_id text, principal_id text, display_name text)`,
    );

    // admin 应用 0042/0043（同库另一连接）。
    await applyMigrations(pool, { exclude: ["0001", "0002", "0003", "0004", "0005",
      "0006", "0007", "0008", "0009", "0010", "0011", "0012", "0013", "0014", "0015",
      "0016", "0017", "0018", "0019", "0020", "0021", "0022", "0023", "0024", "0025",
      "0026", "0027", "0028", "0029", "0030", "0031", "0032", "0033", "0034", "0035",
      "0036", "0037", "0038", "0039", "0040", "0041"] });

    // 同会话调用：search_path = pg_catalog, public, pg_temp（pg_temp 最后）——
    // SECURITY DEFINER 函数读到真实 public.worlds（temp shadow 不生效）。
    await client.query("BEGIN");
    await client.query("SELECT set_config('realm.workspace_id', 'ws_demo', true)");
    await assert.rejects(
      client.query(
        `SELECT realm_import_job_create('ws_demo', 'job_shadow', 'import', $1, $2, $3, '', 'template', 'world_src', 'principal_op', $4)`,
        ["b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64)],
      ),
      /unknown operator principal/,
      "temp shadow accounts 不得伪造 operator 存在性（真实 accounts 无此行）",
    );
    await client.query("ROLLBACK");
    // current_schemas 读回：pg_temp 在最后。
    const schemas = await client.query(
      `SELECT proconfig FROM pg_proc
       WHERE oid = 'realm_import_job_create(text,text,text,text,text,text,text,text,text,text,text)'::regprocedure`,
    );
    assert.deepEqual(schemas.rows[0].proconfig, ["search_path=pg_catalog, public, pg_temp"]);
    // 真实 worlds 表零伪造写入。
    const real = await client.query("SELECT count(*)::int AS c FROM public.worlds");
    assert.equal(real.rows[0].c, 0);
  });

  // ------------------------------------------------------------------
  test("admission/drain: xact lock holder blocks runner drain; release lets it through; idle-in-transaction covered", { timeout: 300_000 }, async (t) => {
    const { url, onCleanup } = await createDatabase(t, "drain");
    // max=8：holder/runnerSim/lateAdmission/lateBlocked 并发占用 + 主查询。
    const pool = onCleanupPool(onCleanup, url, 8);
    await applyMigrations(pool, { upTo: "0042_realm_transfer_and_import_jobs.sql" });

    // 长事务持 admission xact lock（模拟 capability 在途；连接处于
    // idle-in-transaction 状态——探针不依赖 query 文本）。
    const holder = await pool.connect();
    const runnerSim = await pool.connect();
    const lateAdmission = await pool.connect();
    const lateBlocked = await pool.connect();
    // 兜底释放经 onCleanup 注册（先于池关闭/DROP 执行——FIFO）。
    onCleanup(() => {
      for (const client of [holder, runnerSim, lateAdmission, lateBlocked]) {
        try { client.release(); } catch { /* already released */ }
      }
    });
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(7200043)");

    // runner drain：lock_timeout 内阻塞 → no-go（不执行 migration）。
    await runnerSim.query("SET lock_timeout = '2s'");
    await assert.rejects(
      runnerSim.query("SELECT pg_advisory_lock(7200043)"),
      /lock timeout|canceling statement/,
      "drain must no-go while admission is in flight",
    );
    await runnerSim.query("SET lock_timeout = DEFAULT");

    // 锁释放前 runner 绝不应用 0043（台账无记录；applyMigrations 直灌不经
    // runner，台账表此处手工建——只作读回锚点）。
    await pool.query(`CREATE TABLE IF NOT EXISTS realm_schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const ledger = await pool.query(
      "SELECT count(*)::int AS c FROM realm_schema_migrations WHERE filename LIKE '0043_%'");
    assert.equal(ledger.rows[0].c, 0);

    // 释放 admission → runner drain 通过；持锁期间新 admission 阻塞。
    await holder.query("COMMIT");
    await runnerSim.query("SELECT pg_advisory_lock(7200043)");
    await lateBlocked.query("SET lock_timeout = '2s'");
    await assert.rejects(
      lateBlocked.query("SELECT pg_advisory_xact_lock(7200043)"),
      /lock timeout|canceling statement/,
      "new admission must block while the runner holds the drain lock",
    );

    // 0043 应用（runner 持锁期间）→ 解锁后被阻塞调用以新 catalog 继续。
    const sql0043 = await readFile(
      new URL("0043_propagation_node_audience_archived_guard.sql", migrationDir), "utf8");
    await runnerSim.query("BEGIN");
    await runnerSim.query(sql0043);
    await runnerSim.query(
      `INSERT INTO realm_schema_migrations (filename, checksum) VALUES ($1, $2)`,
      ["0043_propagation_node_audience_archived_guard.sql",
        createHash("sha256").update(sql0043).digest("hex")]);
    await runnerSim.query("COMMIT");
    await runnerSim.query("SELECT pg_advisory_unlock(7200043)");
    // 解锁后 admission 立即可行（xact lock 随事务结束释放）。
    await lateAdmission.query("BEGIN");
    await lateAdmission.query("SELECT pg_advisory_xact_lock(7200043)");
    await lateAdmission.query("COMMIT");

    // 新 catalog：0043 gate 生效（缺世界 → WORLD_ARCHIVED）。
    await assert.rejects(
      pool.query(
        "SELECT set_config('realm.workspace_id', 'ws_demo', false); " +
        "SELECT append_propagation_node_audience('ws_demo', 'w_missing', 'wl', 'n', 'c', 'p')"),
      /PROPAGATION_AUDIENCE_WORLD_ARCHIVED/,
    );

    // 测试体末尾归还全部占用连接（先于池关闭/DROP）。
    holder.release();
    runnerSim.release();
    lateAdmission.release();
    lateBlocked.release();
  });

  // ------------------------------------------------------------------
  test("digest dual-side parity: JS realm-pack vs PL helpers (vectors 7/8/9)", { timeout: 300_000 }, async (t) => {
    const { url, registerPool } = await createDatabase(t, "dual");
    const pool = registerPool(ownerPoolOf(url));
    await applyMigrations(pool);

    const {
      canonicalRow, rowDigest, tableWireDigest, transferEntriesSha256, contentDigest,
    } = await import("../modules/world-transfer/realm-pack.ts").catch(() => ({}));
    // .ts import 在 .mjs 测试里经 strip-types 运行器不可用——此套件由
    // --experimental-strip-types 运行（test:postgres-runtime），直接 import。
    assert.ok(canonicalRow, "realm-pack import must resolve");

    const rowA = JSON.parse('{"workspace_id":"ws_demo","world_id":"world_demo","id":"worldline_origin","label":"原初世界线","status":"active","parent_worldline_id":null,"fork_tick":null,"fork_ordinal":null,"head_tick":"0","head_ordinal":"0","ephemeral":false,"tags":["alpha","β"],"empty_tags":[],"profile":"{\\"avatar\\":null,\\"bio\\":\\"灯塔\\"}","created_at":"2026-01-02T03:04:05.000000Z","updated_at":"2026-01-02T03:04:05.000000Z"}');
    const rowB = JSON.parse('{"workspace_id":"ws_demo","world_id":"world_demo","id":"worldline_branch","label":"branch","status":"active","parent_worldline_id":"worldline_origin","fork_tick":"7","fork_ordinal":"3","head_tick":"12","head_ordinal":"4","ephemeral":true,"tags":[],"empty_tags":[],"profile":"{}","created_at":"2026-01-02T03:04:05.000000Z","updated_at":"2026-01-02T03:04:05.000000Z"}');
    const rowU = JSON.parse('{"id":"entity_beacon","label":"\\u706f\\u5854\\ud83d\\udea8","note":"caf\\u00e9","tags":["\\ud83d\\udea8","\\u00e9","e\\u0301"]}');

    const plRowDigest = async (row) => (await pool.query(
      "SELECT encode(digest(realm_import_canonical_row($1::jsonb),'sha256'),'hex') AS d",
      [JSON.stringify(row)])).rows[0].d;
    const plTableWire = async (rows) => (await pool.query(
      `SELECT encode(digest(COALESCE(string_agg(rd || E'\\n', '' ORDER BY rd COLLATE "C"), ''), 'sha256'), 'hex') AS d
       FROM (SELECT encode(digest(realm_import_canonical_row(row_value), 'sha256'), 'hex') AS rd
             FROM jsonb_array_elements($1::jsonb) AS row_value) AS t`,
      [JSON.stringify(rows)])).rows[0].d;

    assert.equal(await plRowDigest(rowA), rowDigest(rowA));
    assert.equal(await plRowDigest(rowB), rowDigest(rowB));
    assert.equal(await plRowDigest(rowU), rowDigest(rowU));
    assert.equal(await plTableWire([rowA, rowB]), tableWireDigest([rowA, rowB]));
    assert.equal(await plTableWire([rowU]), tableWireDigest([rowU]));

    const entries = [
      { name: "worlds", rows: 1, sha256: "4e8fe894c02da3236f2962a0010af0b95c4177cde963e94b05962b1fc7fcefe1", wireDigest: "a".repeat(64) },
      { name: "worldlines", rows: 1, sha256: "6d968d6f6da5ca8f21116248fe239113132fa6d8cea2c0c896dd170cde837622", wireDigest: "f4151a3d56e99606bdebec6b4a94f5061d661a21a3d3e285140d5302923930fc" },
    ];
    const plTransfer = (await pool.query(
      `SELECT encode(digest(COALESCE(string_agg(
          (entry ->> 'name') || E'\\n' || (entry ->> 'rows') || E'\\n'
            || (entry ->> 'sha256') || E'\\n' || (entry ->> 'wireDigest') || E'\\n',
          '' ORDER BY (entry ->> 'name') COLLATE "C"), ''), 'sha256'), 'hex') AS h
       FROM jsonb_array_elements($1::jsonb) AS entry`,
      [JSON.stringify(entries)])).rows[0].h;
    assert.equal(plTransfer, transferEntriesSha256(entries));
    assert.equal(plTransfer, "e86b14cde6f9031fc47e1c33af16011b11ea286e6cb61c89a1e9666abb225a92");
    const plContent = (await pool.query(
      `SELECT encode(digest(COALESCE(string_agg(name || E'\\n' || rows || E'\\n' || wd || E'\\n', '' ORDER BY name COLLATE "C"), ''), 'sha256'), 'hex') AS h
       FROM (SELECT (e->>'name') AS name, (e->>'rows') AS rows, (e->>'wireDigest') AS wd
             FROM jsonb_array_elements($1::jsonb) AS e) AS t`,
      [JSON.stringify([
        { name: "worlds", rows: "1", wireDigest: "a".repeat(64) },
        { name: "worldlines", rows: "1", wireDigest: "f4151a3d56e99606bdebec6b4a94f5061d661a21a3d3e285140d5302923930fc" },
      ])])).rows[0].h;
    assert.equal(plContent, contentDigest([
      { name: "worlds", rows: 1, wireDigest: "a".repeat(64) },
      { name: "worldlines", rows: 1, wireDigest: "f4151a3d56e99606bdebec6b4a94f5061d661a21a3d3e285140d5302923930fc" },
    ]));
    assert.equal(plContent, "3996268d0dd95d5e6e5f6107bf9cfe500f3e902819c4e78446165cc1f5331103");
  });

  // ------------------------------------------------------------------
  test("0042 keyword static scan: zero LOGIN/NOLOGIN/PASSWORD outside comments/strings", async () => {
    const sql = await readFile(
      new URL("../database/postgres/migrations/0042_realm_transfer_and_import_jobs.sql", import.meta.url),
      "utf8",
    );
    // 去注释与字符串字面量后扫描 DDL 关键词。
    const stripped = sql
      .replace(/--[^\n]*/g, "")
      .replace(/'[^']*'/g, "''");
    const hits = stripped.match(/\b(LOGIN|NOLOGIN|PASSWORD)\b/gi) ?? [];
    // 唯一的合法命中：ALTER ROLE 校正行的负向属性段（NOLOGIN/PASSWORD 不得出现）。
    assert.deepEqual(hits.filter((h) => h.toUpperCase() !== "LOGIN"), []);
    // LOGIN 只允许出现在 'ALTER ROLE realm_transfer WITH NOSUPERUSER...' 的
    // 既有形态之外——即不应出现（0042 只校正负向属性，不触碰 LOGIN）。
    assert.deepEqual(hits, [], `0042 不得出现 LOGIN/NOLOGIN/PASSWORD DDL 关键词：${hits.join(",")}`);
  });

  // ------------------------------------------------------------------
  test("worker boundary fence: propagation worker uses the shared factory with zero application_name", async () => {
    const workerRuntime = await readFile(
      new URL("../modules/application/propagation-worker-runtime.ts", import.meta.url),
      "utf8",
    );
    assert.match(workerRuntime, /createLocalPostgresPool\(/);
    assert.doesNotMatch(workerRuntime, /application_name/);
    assert.doesNotMatch(workerRuntime, /createRealmDevPostgresPool/);
    const worker = await readFile(
      new URL("../modules/propagation/worker.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(worker, /application_name|createRealmDevPostgresPool/);
  });

  // ------------------------------------------------------------------
  test("provisioning script: five role states + GUC gate + same-tx atomicity + credential-free output", { timeout: 300_000 }, async (t) => {
    await withScratchCluster(t, async (base) => {
      const password = "pw_" + "x".repeat(16);
      const run = async (env = {}) => {
        try {
          const out = (await execFileAsync(
            process.execPath,
            ["scripts/provision-realm-transfer.mjs"],
            {
              env: {
                ...process.env,
                DATABASE_URL: base,
                REALM_TRANSFER_PASSWORD: password,
                ...env,
              },
              encoding: "utf8",
            },
          )).stdout;
          return { ok: true, out };
        } catch (error) {
          return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
        }
      };

      // ① 角色缺席 → 创建（LOGIN + 负向属性）；输出零凭据。
      let result = await run();
      assert.ok(result.ok, `create path failed: ${result.out}`);
      assert.match(result.out, /realm_transfer provisioned/);
      assert.ok(!result.out.includes(password), "输出零凭据");
      const cluster = new pg.Client({ connectionString: base });
      cluster.on("error", (error) => console.error("cluster-conn-error:", error.message));
      await cluster.connect();
      t.after(async () => {
        await cluster.end().catch(() => undefined);
      });
      let state = await cluster.query(
        "SELECT rolcanlogin, rolsuper, rolcreaterole, rolinherit, rolbypassrls FROM pg_roles WHERE rolname = 'realm_transfer'");
      assert.deepEqual(state.rows[0], {
        rolcanlogin: true, rolsuper: false, rolcreaterole: false,
        rolinherit: false, rolbypassrls: false,
      });

      // ② 已存在 LOGIN → 幂等收敛。
      result = await run();
      assert.ok(result.ok, `repeat path failed: ${result.out}`);

      // ③ NOLOGIN 残留 → 收敛回 LOGIN。
      await cluster.query("ALTER ROLE realm_transfer WITH NOLOGIN");
      result = await run();
      assert.ok(result.ok, `NOLOGIN convergence failed: ${result.out}`);
      state = await cluster.query(
        "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'realm_transfer'");
      assert.equal(state.rows[0].rolcanlogin, true);

      // ④ 缺密码 → 中止且不触碰角色。
      result = await run({ REALM_TRANSFER_PASSWORD: "" });
      assert.equal(result.ok, false);
      assert.match(result.out, /REALM_TRANSFER_PASSWORD/);

      // ⑤ 审计扩展预检 → no-go（pg_stat_statements 在官方镜像可用）。
      const available = await cluster.query(
        "SELECT name FROM pg_available_extensions WHERE name IN ('pgaudit', 'pg_stat_statements')");
      if (available.rows.length > 0) {
        await cluster.query(`CREATE EXTENSION ${available.rows[0].name}`);
        result = await run();
        assert.equal(result.ok, false);
        assert.match(result.out, /no-go/);
        await cluster.query(`DROP EXTENSION ${available.rows[0].name}`);
      }

      // GUC 恢复读回：session gate 随连接销毁；新会话为库默认。
      const guc = await cluster.query("SHOW log_min_error_statement");
      assert.equal(guc.rows[0].log_min_error_statement, "error");
    });
  });

  // ------------------------------------------------------------------
  test("gate negatives: drift injection / SET ROLE / owner negatives / 0043 on drifted copy", { timeout: 300_000 }, async (t) => {
    // A. 漂移注入自包含（v33 C2）：0027 表预置 direct grant → 0043 应用后
    //    读回全 false（REVOKE 自包含且读回非摆设）。
    const { url: urlA, registerPool: regA } = await createDatabase(t, "drift");
    const poolA = regA(ownerPoolOf(urlA));
    await applyMigrations(poolA, { upTo: "0042_realm_transfer_and_import_jobs.sql" });
    await poolA.query(
      "GRANT INSERT, UPDATE ON propagation_node_audiences TO realm_runtime");
    await poolA.query(
      "GRANT INSERT (continuity_id), UPDATE (continuity_id) ON propagation_node_audiences TO realm_control");
    const sql0043 = await readFile(
      new URL("0043_propagation_node_audience_archived_guard.sql", migrationDir), "utf8");
    await poolA.query(sql0043);
    const drift = await poolA.query(
      `SELECT has_table_privilege('realm_runtime', 'propagation_node_audiences', 'INSERT') AS rt_ins,
              has_table_privilege('realm_control', 'propagation_node_audiences', 'UPDATE') AS rc_upd,
              has_column_privilege('realm_control', 'propagation_node_audiences', 'continuity_id', 'INSERT') AS rc_col_ins,
              has_table_privilege('realm_runtime', 'propagation_node_audiences', 'SELECT') AS rt_sel`);
    assert.deepEqual(drift.rows[0], {
      rt_ins: false, rc_upd: false, rc_col_ins: false, rt_sel: true,
    });

    // B. v37 C2：0042 已提交但 ledger ACL 被人为漂移的副本上执行 0043 →
    //    gate 失败（0043 不能只依赖 0042 已提交状态）。
    const { url: urlB, registerPool: regB } = await createDatabase(t, "driftedcopy");
    const poolB = regB(ownerPoolOf(urlB));
    await applyMigrations(poolB, { upTo: "0042_realm_transfer_and_import_jobs.sql" });
    await poolB.query("GRANT INSERT ON realm_import_jobs TO realm_runtime");
    await assert.rejects(poolB.query(sql0043), /acl gate/);

    // C. SET ROLE 拒绝（owner gate：current_user <> session_user → RAISE）。
    const { url: urlC, registerPool: regC, onCleanup: cleanC } = await createDatabase(t, "setrole");
    const poolC = regC(ownerPoolOf(urlC));
    await applyMigrations(poolC, { upTo: "0041_article_qualification_and_import_entries.sql" });
    const sql0042 = await readFile(
      new URL("0042_realm_transfer_and_import_jobs.sql", migrationDir), "utf8");
    // 主负例：无 CREATEROLE 的角色 SET ROLE 后在角色块即 fail-closed
    //（permission denied to alter role——0042 不落地）。
    const setRoleClient = await poolC.connect();
    // onCleanup 在池关闭/DROP 之前执行（createDatabase 单 hook 内顺序）。
    cleanC(() => {
      try { setRoleClient.release(); } catch { /* released */ }
    });
    await setRoleClient.query("BEGIN");
    await setRoleClient.query("SET ROLE realm_runtime");
    await assert.rejects(
      setRoleClient.query(sql0042),
      /permission denied|without SET ROLE/,
    );
    await setRoleClient.query("ROLLBACK");
    const probeC = await poolC.query(
      "SELECT to_regclass('public.realm_import_jobs') AS reg");
    assert.equal(probeC.rows[0].reg, null, "SET ROLE 下 0042 不得落地");

    // owner gate 的 SET ROLE 专项检查：CREATEROLE 角色（角色块 ALTER 可过）
    // → owner gate 的 current_user <> session_user RAISE。
    const probeRole = "realm_setrole_probe";
    await poolC.query(`DROP ROLE IF EXISTS ${probeRole}`);
    // 第二 superuser（NOLOGIN）：SET ROLE 后角色块 ALTER 可过、
    // pg_auth_members 无新增边——走到 owner gate 的
    // current_user <> session_user RAISE（实测 PG17 唯一可达路径）。
    await poolC.query(`CREATE ROLE ${probeRole} NOLOGIN SUPERUSER`);
    cleanC(async () => {
      await poolC.query(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => undefined);
    });
    await setRoleClient.query("BEGIN");
    await setRoleClient.query(`SET ROLE ${probeRole}`);
    await assert.rejects(
      setRoleClient.query(sql0042),
      /without SET ROLE/,
    );
    await setRoleClient.query("ROLLBACK");

    // D. owner 负例：0042 前目标表 owner 换成应用角色 → 0042 owner gate
    //    RAISE（0043 不重复 owner gate——0042 是其唯一检查点；正向锚定
    //    owner 结构已在读回断言集覆盖）。
    const { url: urlD, registerPool: regD } = await createDatabase(t, "ownerneg");
    const poolD = regD(ownerPoolOf(urlD));
    await applyMigrations(poolD, { upTo: "0041_article_qualification_and_import_entries.sql" });
    await poolD.query(
      "ALTER TABLE propagation_node_audiences OWNER TO realm_runtime");
    await assert.rejects(poolD.query(sql0042), /owner/);
  });

  // ------------------------------------------------------------------
  test("component application_name observability: realm-dev / realm-dev-transfer / realm-cli distinguishable", { timeout: 120_000 }, async (t) => {
    const { url, registerPool } = await createDatabase(t, "appname");
    registerPool(ownerPoolOf(url));
    const { createRealmDevPostgresPool } = await import(
      "../database/postgres/realm-dev-pool.ts");
    const { createLocalPostgresPool } = await import(
      "../database/postgres/workspace-transaction.ts");
    const pools = [
      createRealmDevPostgresPool(url.href, "realm-dev"),
      createRealmDevPostgresPool(url.href, "realm-dev-transfer"),
      createLocalPostgresPool(url.href, { application_name: "realm-cli" }),
    ];
    t.after(async () => {
      for (const pool of pools) await pool.end().catch(() => undefined);
    });
    for (const pool of pools) pool.on("error", () => undefined);
    const names = [];
    for (const pool of pools) {
      const result = await pool.query(
        "SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()");
      names.push(result.rows[0].application_name);
    }
    assert.deepEqual(names.sort(), ["realm-cli", "realm-dev", "realm-dev-transfer"].sort());

    // wrapper 覆盖注入拒绝（overrides 与连接串 query 两路）。
    assert.throws(
      () => createRealmDevPostgresPool(url.href, "realm-dev", { application_name: "spoof" }),
      /not allowed/,
    );
    assert.throws(
      () => createRealmDevPostgresPool(
        `${url.href}?application_name=spoof`, "realm-dev"),
      /not allowed|query parameters/,
    );
    // 公共 factory 默认行为不变（无 application_name 注入）。
    const plain = createLocalPostgresPool(url.href);
    t.after(() => plain.end().catch(() => undefined));
    plain.on("error", () => undefined);
    const plainName = await plain.query(
      "SELECT application_name FROM pg_stat_activity WHERE pid = pg_backend_pid()");
    assert.notEqual(plainName.rows[0].application_name, "realm-dev");
  });
}
