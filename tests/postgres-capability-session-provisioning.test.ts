/**
 * M5 会话密钥 provisioning 边界（0053 修订）——空槽首写攻击回归。
 *
 * 移植 Iris 的独立证据：full-migration disposable PG17 中，ws_demo 初始无
 * purpose='session' 行；runtime 角色曾可调 realm_capability_session_key_ensure
 * 用自选字节占领密钥槽，进而伪造任意 actor 证明拿到 owner。本文件钉住修复：
 * runtime 不再有任何 key provisioning/bootstrap 入口；唯一首写权威 =
 * provisioning 连接（admin/owner）；缺 key 一律 fail-closed。
 *
 * 只走官方 scratch runner（全链 0001–0053，一次性 PG）；攻击面在独立库
 * （自建自拆），provision 流程用 runner 提供的 realm_dev。
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import {
  installTestSessionSecret,
  sessionProofFor,
  TEST_CAPABILITY_SESSION_SECRET,
} from "./helpers/session-proof.ts";
import { resetSessionSecretCache } from "../modules/identity/session-secret.ts";

installTestSessionSecret();
// 本文件 provision 子进程用 TEST_CAPABILITY_SESSION_SECRET 写库——证明
// 必须用同值签名（强制覆盖 runner 注入的会话密钥）。
process.env.REALM_SESSION_SECRET = TEST_CAPABILITY_SESSION_SECRET;
resetSessionSecretCache();

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const WS = "ws_demo";

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("provisioning tests require a loopback PostgreSQL host.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createScratchDatabase(t: test.TestContext, label: string) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_capsess_${label}_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const { readdir, readFile } = await import("node:fs/promises");
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
  const { seedPostgresDemo } = await import("../database/postgres/public.ts");
  await seedPostgresDemo(ownerPool);
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  t.after(async () => {
    await ownerPool.end();
    await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await maintenance.end();
  });
  return { ownerPool, runtimeUrl: runtimeUrl.href, databaseName };
}

async function withRuntimeTx(
  runtime: pg.Pool,
  workspaceId: string,
  fn: (client: pg.PoolClient) => Promise<unknown>,
): Promise<void> {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('realm.workspace_id', $1, true)", [workspaceId]);
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

test(
  "empty session-key slot: runtime caller cannot claim the slot, forge a proof, or gain owner",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimeUrl } = await createScratchDatabase(t, "emptyslot");
    const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 2 });
    const attacker = `principal_attacker_${randomUUID().replaceAll("-", "")}`;
    const worldId = `world_poison_${randomUUID().replaceAll("-", "")}`;
    const worldlineId = `worldline_poison_${randomUUID().replaceAll("-", "")}`;
    try {
      await ownerPool.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, 'attacker')`,
        [WS, attacker],
      );
      await ownerPool.query(
        `INSERT INTO worlds (workspace_id, id, name, status, calendar_id)
         VALUES ($1, $2, $3, 'active', 'native_calendar')`,
        [WS, worldId, "poison fixture"],
      );
      await ownerPool.query(
        `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
         VALUES ($1, $2, $3, 'line', 'active', 0, 0)`,
        [WS, worldId, worldlineId],
      );

      // 攻击者自选 32 字节试图占领密钥槽（当前实现下的既有 API）。
      const attackerKey = randomBytes(32);
      let bootstrapError: unknown;
      try {
        await withRuntimeTx(runtime, WS, async (client) => {
          await client.query(
            `SELECT realm_capability_session_key_ensure($1, $2)`,
            [WS, attackerKey],
          );
        });
      } catch (error) {
        bootstrapError = error;
      }
      assert.ok(
        bootstrapError,
        "runtime 不得存在任何可调用的 key provisioning/bootstrap 入口",
      );

      // 伪造证明 + genesis  owner 尝试：无论密钥槽状态如何都必须失败。
      const payload = `${attacker}.${Date.now() + 60_000}`;
      const { createHmac } = await import("node:crypto");
      const forged = `${payload}.${createHmac("sha256", attackerKey).update(payload).digest("hex")}`;
      let grantError: unknown;
      try {
        await withRuntimeTx(runtime, WS, async (client) => {
          await client.query(
            `SELECT membership_capability_grant($1, 'genesis_creator', $2, $3, $4, $5, 'owner')`,
            [forged, WS, worldId, worldlineId, attacker],
          );
        });
      } catch (error) {
        grantError = error;
      }
      assert.ok(grantError, "伪造证明的 grant 必须被拒");

      // admin 读回：零密钥行、零 membership 副作用。
      const keys = await ownerPool.query(
        `SELECT count(*)::int AS count FROM realm_capability_keys
         WHERE workspace_id = $1 AND purpose = 'session'`,
        [WS],
      );
      assert.equal(keys.rows[0]!.count, 0, "攻击不得留下会话密钥行");
      const memberships = await ownerPool.query(
        `SELECT count(*)::int AS count FROM player_world_memberships
         WHERE workspace_id = $1 AND world_id = $2`,
        [WS, worldId],
      );
      assert.equal(memberships.rows[0]!.count, 0, "攻击不得留下 membership 行");
    } finally {
      await runtime.end();
    }
  },
);

test(
  "effective ACL: runtime/PUBLIC/control have no key-management surface; missing key fails closed",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimeUrl } = await createScratchDatabase(t, "acl");
    const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      const surface = await ownerPool.query(`
        SELECT
          to_regprocedure('realm_capability_session_key_ensure(text,bytea)') IS NULL AS ensure_gone,
          has_table_privilege('realm_runtime', 'realm_capability_keys', 'SELECT') AS runtime_select,
          has_table_privilege('realm_runtime', 'realm_capability_keys', 'INSERT') AS runtime_insert,
          has_table_privilege('realm_control', 'realm_capability_keys', 'SELECT') AS control_select
      `);
      assert.deepEqual(surface.rows[0], {
        ensure_gone: true,
        runtime_select: false,
        runtime_insert: false,
        control_select: false,
      }, "密钥表与 provisioning 入口对一切应用角色 fail-closed");
      // PUBLIC 不是角色（has_table_privilege 不接受）；直接钉 ACL 授予者清单。
      const acl = await ownerPool.query(
        `SELECT relacl::text AS acl FROM pg_class WHERE relname = 'realm_capability_keys'`,
      );
      const grantees = [...String(acl.rows[0]?.acl ?? "").matchAll(/(?:^|,)("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)=/g)]
        .map((match) => match[1]);
      assert.ok(
        grantees.includes("realm_capability"),
        "realm_capability 必须持有密钥表窄授权",
      );
      assert.ok(
        grantees.every((grantee) => ["postgres", "realm_capability"].includes(grantee)),
        `密钥表 ACL 不得含 PUBLIC/其他角色，实际：${grantees}`,
      );

      // 缺 key：合法形态证明也拿不到任何写入（fail-closed）。
      const newcomer = `principal_acl_${randomUUID().replaceAll("-", "")}`;
      await ownerPool.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, 'acl probe')`,
        [WS, newcomer],
      );
      await assert.rejects(
        withRuntimeTx(runtime, WS, async (client) => {
          await client.query(
            `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
            [sessionProofFor(newcomer), WS, "world_ember_coast", newcomer],
          );
        }),
        (error: unknown) => error instanceof Error
          && error.message.includes("CAPABILITY_SESSION_KEY_MISSING"),
      );
      const memberships = await ownerPool.query(
        `SELECT count(*)::int AS count FROM player_world_memberships
         WHERE workspace_id = $1 AND world_id = 'world_ember_coast'
           AND principal_id = $2`,
        [WS, newcomer],
      );
      assert.equal(memberships.rows[0]!.count, 0, "缺 key 时不得留下 membership 行");
    } finally {
      await runtime.end();
    }
  },
);

test(
  "provisioner script: trusted admin connection provisions, idempotent, mismatch fails closed, fallback refused",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimeUrl, databaseName } = await createScratchDatabase(t, "provision");
    const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 2 });
    const scriptPath = fileURLToPath(
      new URL("../scripts/local-provision-capability-session.mjs", import.meta.url),
    );
    const runProvision = (extraEnv: Record<string, string>, omitDatabaseUrl = false) =>
      new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", scriptPath],
          {
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
              ...(omitDatabaseUrl
                ? {}
                : {
                  DATABASE_URL: (() => {
                    const url = new URL(requireLoopbackUrl(adminConnectionString!).href);
                    url.pathname = `/${databaseName}`;
                    return url.href;
                  })(),
                }),
              ...extraEnv,
            } as unknown as NodeJS.ProcessEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("exit", (code: number | null) => resolvePromise({ code, stderr }));
      });

    try {
      // 未 provision 前：合法形态证明也被拒（fail-closed）。
      await assert.rejects(
        withRuntimeTx(runtime, WS, async (client) => {
          await client.query(
            `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
            [sessionProofFor("principal_demo_player"), WS, "world_ember_coast", "principal_demo_player"],
          );
        }),
        (error: unknown) => error instanceof Error
          && error.message.includes("CAPABILITY_SESSION_KEY_MISSING"),
      );

      // provision（经环境变量传入测试密钥；值不进日志）。
      const first = await runProvision({ REALM_SESSION_SECRET: TEST_CAPABILITY_SESSION_SECRET });
      assert.equal(first.code, 0, `provision 必须成功: ${first.stderr}`);
      assert.ok(!first.stderr.includes(TEST_CAPABILITY_SESSION_SECRET), "输出不得含密钥值");

      // provision 后：合法证明可写（creator owner / 默认 player 路径由此恢复）。
      await withRuntimeTx(runtime, WS, async (client) => {
        await client.query(
          `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
          [sessionProofFor("principal_demo_player"), WS, "world_ember_coast", "principal_demo_player"],
        );
      });

      // 幂等：同值重复 provision 成功。
      const second = await runProvision({ REALM_SESSION_SECRET: TEST_CAPABILITY_SESSION_SECRET });
      assert.equal(second.code, 0, "同值重复 provision 必须幂等成功");

      // 分歧：不同值 fail-closed 非零退出，且库内密钥不被替换。
      const divergent = `test-divergent-${randomUUID().replaceAll("-", "")}`;
      const third = await runProvision({ REALM_SESSION_SECRET: divergent });
      assert.notEqual(third.code, 0, "密钥分歧必须 fail-closed");
      assert.ok(!third.stderr.includes(divergent), "错误输出不得含密钥值");
      const keyRow = await ownerPool.query(
        `SELECT count(*)::int AS count FROM realm_capability_keys
         WHERE workspace_id = $1 AND purpose = 'session' AND status = 'active'`,
        [WS],
      );
      assert.equal(keyRow.rows[0]!.count, 1, "分歧不得新增/替换密钥行");

      // 兜底拒绝①：env 显式给公知开发值 → 拒绝。
      const devFallbackRun = await runProvision({
        REALM_SESSION_SECRET: "realm-local-development-only",
      });
      assert.notEqual(
        devFallbackRun.code,
        0,
        "公知开发兜底值（即使经 env）不得用于 provision",
      );
      // 兜底拒绝②：无 env 且密钥文件无法创建（REALM_DATA_HOME 指向普通文件）
      // → 创建失败 fail-closed，绝不落回开发兜底常量。
      const blockerFile = join(mkdtempSync(join(tmpdir(), "realm-capsession-block-")), "occupant");
      const { writeFileSync: writeBlocker } = await import("node:fs");
      writeBlocker(blockerFile, "occupied");
      const fallbackRun = await runProvision({
        REALM_DATA_HOME: blockerFile,
        HOME: blockerFile,
      });
      assert.notEqual(
        fallbackRun.code,
        0,
        "密钥文件创建失败时 provision 必须 fail-closed（不得用开发兜底常量）",
      );
    } finally {
      await runtime.end();
    }
  },
);

test(
  "provisioner script: explicit DATABASE_URL required (no silent realm_dev fallback); fresh install creates the install key atomically",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const { ownerPool, runtimeUrl, databaseName } = await createScratchDatabase(t, "freshboot");
    const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    const scriptPath = fileURLToPath(
      new URL("../scripts/local-provision-capability-session.mjs", import.meta.url),
    );
    const runProvision = (extraEnv: Record<string, string>, omitDatabaseUrl = false) =>
      new Promise<{ code: number | null; stderr: string }>((resolvePromise) => {
        const child = spawn(
          process.execPath,
          ["--experimental-strip-types", scriptPath],
          {
            env: {
              PATH: process.env.PATH ?? "",
              HOME: process.env.HOME ?? "",
              ...(omitDatabaseUrl
                ? {}
                : {
                  DATABASE_URL: (() => {
                    const url = new URL(requireLoopbackUrl(adminConnectionString!).href);
                    url.pathname = `/${databaseName}`;
                    return url.href;
                  })(),
                }),
              ...extraEnv,
            } as unknown as NodeJS.ProcessEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("exit", (code: number | null) => resolvePromise({ code, stderr }));
      });

    const freshHome = mkdtempSync(join(tmpdir(), "realm-capsession-fresh-"));
    t.after(() => rmSync(freshHome, { recursive: true, force: true }));
    try {
      // 缺 DATABASE_URL：连连接都不允许发生，更不得默认指向 realm_dev。
      const missing = await runProvision({ REALM_SESSION_SECRET: TEST_CAPABILITY_SESSION_SECRET }, true);
      assert.notEqual(missing.code, 0, "缺显式 DATABASE_URL 必须失败");
      assert.match(missing.stderr, /DATABASE_URL/, "错误必须指明缺少显式 DATABASE_URL");
      assert.ok(!missing.stderr.includes(TEST_CAPABILITY_SESSION_SECRET), "输出不得含密钥值");

      // 全新安装：无 env 密钥、无文件——可信 setup 原子创建 0600/0700 密钥文件，
      // 然后 provision 全部 workspace；输出只含状态不含值。
      const fresh = await runProvision({ REALM_DATA_HOME: freshHome });
      assert.equal(fresh.code, 0, `全新安装 provision 必须成功：${fresh.stderr}`);
      assert.match(fresh.stderr, /provisioned|created|session/i);
      const secretPath = join(freshHome, "secure", "session-secret");
      const { existsSync, statSync, readFileSync } = await import("node:fs");
      assert.ok(existsSync(secretPath), "安装级密钥文件必须被创建");
      assert.equal(statSync(join(freshHome, "secure")).mode & 0o777, 0o700);
      assert.equal(statSync(secretPath).mode & 0o777, 0o600);
      const createdSecret = readFileSync(secretPath, "utf8").trim();
      assert.ok(createdSecret.length >= 32);
      assert.notEqual(createdSecret, "realm-local-development-only");
      // provision 的值 = 文件值 = 运行时 sessionSecret() 读取值（同密钥两面）。
      const { sessionSecret, resetSessionSecretCache } = await import("../modules/identity/session-secret.ts");
      const savedHome = process.env.REALM_DATA_HOME;
      const savedSecret = process.env.REALM_SESSION_SECRET;
      try {
        delete process.env.REALM_SESSION_SECRET;
        process.env.REALM_DATA_HOME = freshHome;
        resetSessionSecretCache();
        assert.equal(sessionSecret(), createdSecret, "运行时读取的必须是同一把安装密钥");
      } finally {
        if (savedSecret === undefined) delete process.env.REALM_SESSION_SECRET;
        else process.env.REALM_SESSION_SECRET = savedSecret;
        if (savedHome === undefined) delete process.env.REALM_DATA_HOME;
        else process.env.REALM_DATA_HOME = savedHome;
        resetSessionSecretCache();
      }
      // 库里 provisioning 的密钥副本与文件一致（只比对布尔，不读值）。
      const match = await ownerPool.query(
        `SELECT (key = $1) AS matches FROM realm_capability_keys
         WHERE workspace_id = $2 AND kid = 'session-primary' AND purpose = 'session'`,
        [Buffer.from(createdSecret, "utf8"), WS],
      );
      assert.equal(match.rows[0]?.matches, true, "DB 副本必须等于安装密钥");
      // 幂等重跑。
      const again = await runProvision({ REALM_DATA_HOME: freshHome });
      assert.equal(again.code, 0, "同值重复 provision 幂等");
      // 运行时 grant 恢复：provision 后 join_player 对有效证明成功。
      const principal = `principal_fresh_${randomUUID().replaceAll("-", "")}`;
      await ownerPool.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name) VALUES ($1, $2, 'fresh')`,
        [WS, principal],
      );
      const { createHmac } = await import("node:crypto");
      const payload = `${principal}.${Date.now() + 60_000}`;
      const proof = `${payload}.${createHmac("sha256", createdSecret).update(payload).digest("hex")}`;
      await withRuntimeTx(runtime, WS, async (client) => {
        await client.query(
          `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
          [proof, WS, "world_ember_coast", principal],
        );
      });
      const row = await ownerPool.query(
        `SELECT role FROM player_world_memberships
         WHERE workspace_id = $1 AND world_id = 'world_ember_coast' AND principal_id = $2`,
        [WS, principal],
      );
      assert.equal(row.rows[0]?.role, "player", "provision 后合法证明路径恢复可用");
    } finally {
      await runtime.end();
    }
  },
);

