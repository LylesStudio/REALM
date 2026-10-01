/**
 * 账户名 + 可选密码登录 PG 测试（migration 0051，scratch；串行由 runner 保证）。
 * 覆盖：既有账号 password_hash 默认 NULL；新账户首次创建可写密码；
 * 无密码账户仅空密码通过；有密码账户严格校验；错误不泄露存在性；
 * 设置/修改/清除密码语义；RLS 跨 workspace 隔离；realm_runtime 最小权限。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";
installTestSessionSecret();
import {
  AccountAuthError,
  createPostgresAccountRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { principalIdForDisplayName } from "../modules/identity/auth.ts";

const adminConnectionString = process.env.DATABASE_URL;
const WS = "ws_demo";
// 老账户行的 principal 必须与登录路径同源（displayName 派生）。
const LEGACY_PRINCIPAL = principalIdForDisplayName("老账户");

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

test(
  "account password: legacy NULL + first-create + strict verify + set/clear + RLS",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_acctpw_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const runtimeUrl = new URL(adminUrl);
    runtimeUrl.pathname = `/${databaseName}`;
    runtimeUrl.username = "realm_runtime";
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
    t.after(async () => {
      await ownerPool.end();
      await runtimePool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    await seedCapabilitySessionKey(ownerPool, WS);

    // 迁移后既有账号 password_hash 默认 NULL（零改写）。
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, '老账户')`,
      [WS, LEGACY_PRINCIPAL],
    );
    const legacy = await ownerPool.query(
      `SELECT password_hash FROM accounts WHERE workspace_id = $1 AND principal_id = $2`,
      [WS, LEGACY_PRINCIPAL],
    );
    assert.equal(legacy.rows[0]!.password_hash, null, "既有账号必须 NULL（无密码）");

    const accounts = createPostgresAccountRepository(runtimePool);
    const raceSelects = { count: 0 };
    let releaseRace!: () => void;
    const raceBarrier = new Promise<void>((resolve) => { releaseRace = resolve; });
    const racePool = new Proxy(runtimePool, {
      get(target, property) {
        if (property !== "connect") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty !== "query") {
                const value = Reflect.get(clientTarget, clientProperty, clientTarget);
                return typeof value === "function" ? value.bind(clientTarget) : value;
              }
              return async (sql: string, values?: unknown[]) => {
                const result = await clientTarget.query(sql, values as never);
                const normalizedSql = sql.toLowerCase().replaceAll(/\s+/g, " ");
                if (
                  normalizedSql.includes("from accounts")
                  && normalizedSql.includes("where workspace_id = $1 and principal_id = $2")
                  && result.rowCount === 0
                  && values?.[1] === principalIdForDisplayName("同名并发首登")
                ) {
                  raceSelects.count += 1;
                  if (raceSelects.count === 2) releaseRace();
                  await raceBarrier;
                }
                return result;
              };
            },
          });
        };
      },
    }) as typeof runtimePool;
    const racedAccounts = createPostgresAccountRepository(racePool);
    const raceResults = await Promise.allSettled([
      racedAccounts.loginWithCredentials(WS, "同名并发首登", "首个密码A"),
      racedAccounts.loginWithCredentials(WS, "同名并发首登", "首个密码B"),
    ]);
    assert.equal(raceSelects.count, 2, "both requests must observe the account as absent first");
    assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1);
    const raceWinnerPassword = raceResults[0]?.status === "fulfilled" ? "首个密码A" : "首个密码B";
    const raceLoserPassword = raceWinnerPassword === "首个密码A" ? "首个密码B" : "首个密码A";
    await racedAccounts.loginWithCredentials(WS, "同名并发首登", raceWinnerPassword);
    await assert.rejects(
      racedAccounts.loginWithCredentials(WS, "同名并发首登", raceLoserPassword),
      AccountAuthError,
    );

    // 无密码账户：空密码通过；非空密码拒绝（绝不静默设置）。
    const legacyLogin = await accounts.loginWithCredentials(WS, "老账户", "");
    assert.equal(legacyLogin.principalId, LEGACY_PRINCIPAL);
    await assert.rejects(
      accounts.loginWithCredentials(WS, "老账户", "某密码"),
      (error: unknown) => {
        assert.ok(error instanceof AccountAuthError);
        assert.equal(error.message, "账户名或密码不正确。", "错误不得泄露账户密码状态");
        return true;
      },
    );
    // 拒绝后密码仍为 NULL（未被登录路径写入）。
    const after = await ownerPool.query(
      `SELECT password_hash FROM accounts WHERE workspace_id = $1 AND principal_id = $2`,
      [WS, LEGACY_PRINCIPAL],
    );
    assert.equal(after.rows[0]!.password_hash, null);

    // 新账户首次创建：空密码 → NULL；带密码 → hash 落库且格式合规。
    const firstLogin = await accounts.loginWithCredentials(WS, "新账户甲", "");
    await accounts.ensureDefaultWorldMembership(WS, firstLogin.principalId, sessionProofFor(firstLogin.principalId));
    const defaultMembership = await ownerPool.query(
      `SELECT role FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [WS, "world_ember_coast", firstLogin.principalId],
    );
    assert.equal(defaultMembership.rows[0]?.role, "player", "首次登录不能自动获得默认世界 owner 权限");
    await accounts.ensureDefaultWorldMembership(WS, "principal_demo_player", sessionProofFor("principal_demo_player"));
    const existingOwnerMembership = await ownerPool.query(
      `SELECT role FROM player_world_memberships
       WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
      [WS, "world_ember_coast", "principal_demo_player"],
    );
    assert.equal(existingOwnerMembership.rows[0]?.role, "owner", "幂等登录不得改写已存在的 owner 决策");
    await accounts.loginWithCredentials(WS, "新账户乙", "灯塔口令");
    const rows = await ownerPool.query(
      `SELECT principal_id, password_hash FROM accounts
       WHERE workspace_id = $1 AND display_name IN ('新账户甲', '新账户乙')`,
      [WS],
    );
    const byName = Object.fromEntries(rows.rows.map((row) => [row.principal_id, row.password_hash]));
    const plainId = rows.rows.find((row) => row.password_hash === null);
    assert.ok(plainId, "空密码新账户 password_hash 为 NULL");
    const hashed = Object.values(byName).find((value) => typeof value === "string");
    assert.ok(typeof hashed === "string" && hashed.startsWith("scrypt$"));
    assert.ok(!hashed!.includes("灯塔口令"), "hash 不含明文");

    // 有密码账户：正确通过、错误拒绝（统一错误）。
    const good = await accounts.loginWithCredentials(WS, "新账户乙", "灯塔口令");
    assert.ok(good.principalId.startsWith("principal_"));
    await assert.rejects(accounts.loginWithCredentials(WS, "新账户乙", "错误口令"), AccountAuthError);
    await assert.rejects(accounts.loginWithCredentials(WS, "新账户乙", ""), AccountAuthError);

    // 不存在的账户名 + 任意密码：创建新账户（昵称即身份语义不变）。
    const created = await accounts.loginWithCredentials(WS, "全新的人", "任意");
    assert.ok(created.principalId.startsWith("principal_"));

    // 设置密码：无密码账户可直接设置；有密码账户必须校验旧密码。
    await accounts.setAccountPassword(WS, LEGACY_PRINCIPAL, {
      currentPassword: "",
      newPassword: "新设的密码",
    });
    await assert.rejects(
      accounts.loginWithCredentials(WS, "老账户", ""),
      AccountAuthError,
      "设置后空密码不再通过",
    );
    await accounts.loginWithCredentials(WS, "老账户", "新设的密码");
    await assert.rejects(
      accounts.setAccountPassword(WS, LEGACY_PRINCIPAL, {
        currentPassword: "错旧密码",
        newPassword: "另一个密码",
      }),
      AccountAuthError,
    );
    await accounts.setAccountPassword(WS, LEGACY_PRINCIPAL, {
      currentPassword: "新设的密码",
      newPassword: "另一个密码",
    });
    await accounts.loginWithCredentials(WS, "老账户", "另一个密码");

    // 明确清除：需校验当前密码；清除后空密码通过。
    await assert.rejects(
      accounts.clearAccountPassword(WS, LEGACY_PRINCIPAL, { currentPassword: "错" }),
      AccountAuthError,
    );
    await accounts.clearAccountPassword(WS, LEGACY_PRINCIPAL, { currentPassword: "另一个密码" });
    await accounts.loginWithCredentials(WS, "老账户", "");

    // RLS：另一 workspace 看不到账户行。
    await ownerPool.query(`INSERT INTO workspaces (id, name) VALUES ('ws_other_pw', 'other')`);
    const otherView = await runtimePool.connect();
    try {
      await otherView.query("BEGIN");
      await otherView.query(`SELECT set_config('realm.workspace_id', 'ws_other_pw', true)`);
      const visible = await otherView.query(
        `SELECT count(*)::int AS count FROM accounts WHERE workspace_id = $1`,
        [WS],
      );
      assert.equal(visible.rows[0]!.count, 0, "跨 workspace 账户不可见");
      await otherView.query("ROLLBACK");
    } finally {
      otherView.release();
    }

    // realm_runtime 无 DELETE（最小权限）。
    await assert.rejects(
      runtimePool.query(`DELETE FROM accounts WHERE workspace_id = $1`, [WS]),
    );
  },
);
