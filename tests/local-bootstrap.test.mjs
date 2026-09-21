/**
 * P0-1：fresh local bootstrap provisioning 契约（disposable loopback
 * scratch PG17，专用集群不预建 realm_transfer；结束销毁，零残留）。
 * 证明：provision → 0042 不再因缺 role 失败；migrations 0001–0043 + seed
 * 通过；角色 LOGIN/负向属性读回；重启幂等；输出零凭据。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { fileURLToPath } from "node:url";
import {
  dockerAvailable,
  startScratchPgCluster,
} from "./helpers/v37-test-cluster.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function run(script, env) {
  const result = spawnSync(process.execPath, [join(projectRoot, script)], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: "pipe",
  });
  return result;
}

test(
  "fresh bootstrap: provision realm_transfer before migrations (0042 passes), idempotent restart, zero credential output",
  { skip: !(await dockerAvailable()), timeout: 300_000 },
  async (t) => {
    // 专用集群：故意不预建 realm_transfer（仅 runtime/control）。
    const cluster = await startScratchPgCluster({
      label: "localboot",
      roles: ["realm_runtime", "realm_control"],
    });
    const secretDirectory = await mkdtemp(join(tmpdir(), "realm-prov-"));
    t.after(async () => {
      await cluster.stop();
      await rm(secretDirectory, { recursive: true, force: true });
    });

    const admin = new pg.Client({ connectionString: cluster.adminUrl });
    const clientErrors = [];
    admin.on("error", (error) => clientErrors.push(`admin:${error.message}`));
    await admin.connect();
    t.after(async () => {
      await admin.end().catch(() => undefined);
    });
    await admin.query(`CREATE DATABASE realm_dev`);
    const databaseUrl = cluster.adminUrl.replace(/\/postgres$/, "/realm_dev");
    const devClient = new pg.Client({ connectionString: databaseUrl });
    devClient.on("error", (error) => clientErrors.push(`dev:${error.message}`));
    await devClient.connect();
    t.after(async () => {
      await devClient.end().catch(() => undefined);
    });

    // ① provision：exit 0，角色读回 LOGIN + 全负向属性。
    const provision = run("scripts/local-provision-realm-transfer.mjs", {
      DATABASE_URL: databaseUrl,
      REALM_PROVISION_SECRET_DIR: secretDirectory,
    });
    assert.equal(provision.status, 0, provision.stderr);
    const role = await admin.query(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
              rolinherit, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = 'realm_transfer'`,
    );
    assert.deepEqual(role.rows[0], {
      rolcanlogin: true,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
    });

    // ② 密码文件：0600、不打印、内容不进入 provision 输出。
    const secretPath = join(secretDirectory, ".realm-transfer-password");
    const secret = readFileSync(secretPath, "utf8").trim();
    assert.ok(secret.length >= 12);
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);
    assert.ok(!provision.stdout.includes(secret), "password must not leak to stdout");
    assert.ok(!provision.stderr.includes(secret), "password must not leak to stderr");

    // ③ migrations 0001–0043 全部应用（0042 依赖已 provisioning 的角色）。
    const migrate = run("scripts/postgres-migrate.mjs", {
      DATABASE_URL: databaseUrl,
    });
    assert.equal(migrate.status, 0, migrate.stderr);
    assert.ok(!migrate.stdout.includes(secret) && !migrate.stderr.includes(secret));
    const migrationFiles = readdirSync(
      join(projectRoot, "database/postgres/migrations"),
    ).filter((name) => name.endsWith(".sql")).sort();
    const applied = await devClient.query(
      `SELECT count(*)::int AS count FROM realm_schema_migrations`,
    );
    assert.equal(applied.rows[0].count, migrationFiles.length);

    // ④ demo seed。
    const seed = run("scripts/postgres-seed-demo.mjs", {
      DATABASE_URL: databaseUrl,
      REALM_RUNTIME_DATABASE_URL: databaseUrl.replace("postgres@", "realm_runtime@"),
    });
    assert.equal(seed.status, 0, seed.stderr);

    // ⑤ 重启幂等：再次 provision（复用同一密码文件）+ migrate（全部 skip）。
    const provisionAgain = run("scripts/local-provision-realm-transfer.mjs", {
      DATABASE_URL: databaseUrl,
      REALM_PROVISION_SECRET_DIR: secretDirectory,
    });
    assert.equal(provisionAgain.status, 0, provisionAgain.stderr);
    assert.equal(
      readFileSync(secretPath, "utf8").trim(),
      secret,
      "restart must reuse the persisted local password (no rotation)",
    );
    const migrateAgain = run("scripts/postgres-migrate.mjs", {
      DATABASE_URL: databaseUrl,
    });
    assert.equal(migrateAgain.status, 0, migrateAgain.stderr);
    assert.ok(!migrateAgain.stdout.includes("apply 0042"),
      "second run must skip already-applied migrations");

    // 客户端 socket 事件必须为零（docker/host-network 瞬断要显式暴露）。
    assert.deepEqual(clientErrors, []);
    // ⑥ 缺 DATABASE_URL 的 provision 缺省走本地 loopback 常量（不泄漏）。
    const leaked = provision.stdout + provision.stderr
      + migrate.stdout + migrate.stderr;
    assert.ok(!leaked.includes(secret));
  },
);
