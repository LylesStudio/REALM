/**
 * M5 capability actor/scope 边界验收（0053 会话证明锚定版）。
 * 移植自 Iris 的独立 RED 证据（全链 0001–0053 disposable PG17）：
 * 修复前这些断言失败并可读回持久化行；修复后必须 GREEN。
 *
 * 覆盖：
 * 1. 可调用面：runtime 仅有组合入口 grant 的 EXECUTE（mint/apply 无）。
 * 2. 无有效会话证明的 runtime SQL 不得为自选 principal 指派创世 owner。
 * 3. worldline 属于另一 world 的创世调用必须拒绝。
 * 4. 会话矩阵：缺失/伪造/actor 不符/过期证明一律 fail-closed；
 *    证明 principal 与调用 principal 不一致即拒。
 * 5. stance 冒名：持自己证明不得改他人 membership 行。
 * 6. join 冒名：持自己证明不得为他人创建 membership。
 * 每次攻击后用 admin 连接读回，断言零持久化副作用。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";

installTestSessionSecret();

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const WS = "ws_demo";

function unique(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function withRuntimeTx(
  runtime: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<unknown>,
): Promise<void> {
  const client = await runtime.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('realm.workspace_id', $1, true)", [WS]);
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedWorld(admin: pg.Pool, worldId: string, worldlineId: string, name: string): Promise<void> {
  await admin.query(
    `INSERT INTO worlds (workspace_id, id, name, status, calendar_id)
     VALUES ($1, $2, $3, 'active', 'native_calendar')`,
    [WS, worldId, name],
  );
  await admin.query(
    `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
     VALUES ($1, $2, $3, 'Acceptance line', 'active', 0, 0)`,
    [WS, worldId, worldlineId],
  );
}

async function membershipRole(admin: pg.Pool, worldId: string, principalId: string): Promise<string | null> {
  const result = await admin.query<{ role: string }>(
    `SELECT role FROM player_world_memberships
     WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
    [WS, worldId, principalId],
  );
  return result.rows[0]?.role ?? null;
}

test(
  "runtime can execute only the composite membership capability entry",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async () => {
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    try {
      const result = await admin.query(`
        SELECT
          has_function_privilege('realm_runtime', 'membership_capability_mint(text,text,text,text,text,text,text,integer)', 'EXECUTE') AS mint_exec,
          has_function_privilege('realm_runtime', 'membership_capability_apply(text)', 'EXECUTE') AS apply_exec,
          has_function_privilege('realm_runtime', 'membership_capability_grant(text,text,text,text,text,text,text,integer)', 'EXECUTE') AS grant_exec,
          has_function_privilege('realm_runtime', 'realm_capability_session_actor(text,text)', 'EXECUTE') AS verifier_exec,
          has_table_privilege('realm_runtime', 'realm_capability_keys', 'SELECT') AS key_read
      `);
      assert.deepEqual(result.rows[0], {
        mint_exec: false,
        apply_exec: false,
        grant_exec: true,
        verifier_exec: false,
        key_read: false,
      }, "runtime 只能调组合入口，且永远读不到密钥表");
    } finally {
      await admin.end();
    }
  },
);

test(
  "runtime SQL without a verified session proof cannot appoint a caller-selected first owner",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async () => {
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const attacker = unique("principal_attacker");
    const victim = unique("principal_victim");
    const worldId = unique("world_actor");
    const worldlineId = unique("worldline_actor");
    try {
      await admin.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, 'attacker'), ($1, $3, 'victim')`,
        [WS, attacker, victim],
      );
      await seedWorld(admin, worldId, worldlineId, "actor spoof fixture");
      await seedCapabilitySessionKey(admin, WS);

      // 攻击者持自己的有效证明，试图让 victim 成为 owner（actor 不符即拒）。
      let actorProofError: unknown;
      await withRuntimeTx(runtime, async (client) => {
        try {
          await client.query(
            `SELECT membership_capability_grant($1, 'genesis_creator', $2, $3, $4, $5, 'owner')`,
            [sessionProofFor(attacker), WS, worldId, worldlineId, victim],
          );
        } catch (error) {
          actorProofError = error;
          throw error;
        }
      }).catch((error: unknown) => {
        actorProofError = error;
      });
      // 无证明直调同样拒绝。
      let noProofError: unknown;
      try {
        await withRuntimeTx(runtime, (client) => client.query(
          `SELECT membership_capability_grant('', 'genesis_creator', $1, $2, $3, $4, 'owner')`,
          [WS, worldId, worldlineId, victim],
        ));
      } catch (error) {
        noProofError = error;
      }
      assert.ok(actorProofError, "actor 不符的调用必须被拒");
      assert.ok(
        String((actorProofError as Error).message).includes("CAPABILITY_ACTOR_MISMATCH"),
        `期望 CAPABILITY_ACTOR_MISMATCH，得到 ${(actorProofError as Error)?.message}`,
      );
      assert.ok(noProofError, "无证明调用必须被拒");
      assert.equal(await membershipRole(admin, worldId, victim), null, "攻击不得留下持久化行");
      assert.equal(await membershipRole(admin, worldId, attacker), null, "攻击不得留下持久化行");
      // 合法对照：真实创建者持自己的证明可以拿到 owner。
      await withRuntimeTx(runtime, (client) => client.query(
        `SELECT membership_capability_grant($1, 'genesis_creator', $2, $3, $4, $5, 'owner')`,
        [sessionProofFor(attacker), WS, worldId, worldlineId, attacker],
      ));
      assert.equal(await membershipRole(admin, worldId, attacker), "owner");
    } finally {
      await runtime.end();
      await admin.end();
    }
  },
);

test(
  "genesis capability rejects a worldline belonging to another world",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async () => {
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const principal = unique("principal_worldline");
    const worldA = unique("worldline_world_a");
    const worldB = unique("worldline_world_b");
    const lineA = unique("worldline_a");
    const lineB = unique("worldline_b");
    try {
      await admin.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, 'worldline test')`,
        [WS, principal],
      );
      await seedWorld(admin, worldA, lineA, "worldline scope A");
      await seedWorld(admin, worldB, lineB, "worldline scope B");
      await seedCapabilitySessionKey(admin, WS);

      let scopeError: unknown;
      try {
        await withRuntimeTx(runtime, (client) => client.query(
          `SELECT membership_capability_grant($1, 'genesis_creator', $2, $3, $4, $5, 'owner')`,
          [sessionProofFor(principal), WS, worldA, lineB, principal],
        ));
      } catch (error) {
        scopeError = error;
      }
      assert.ok(scopeError, "错配 worldline 必须拒绝");
      assert.ok(
        String((scopeError as Error).message).includes("CAPABILITY_WORLDLINE_MISMATCH"),
        `期望 CAPABILITY_WORLDLINE_MISMATCH，得到 ${(scopeError as Error)?.message}`,
      );
      assert.equal(await membershipRole(admin, worldA, principal), null);
      // 合法对照：匹配 worldline 放行。
      await withRuntimeTx(runtime, (client) => client.query(
        `SELECT membership_capability_grant($1, 'genesis_creator', $2, $3, $4, $5, 'owner')`,
        [sessionProofFor(principal), WS, worldA, lineA, principal],
      ));
      assert.equal(await membershipRole(admin, worldA, principal), "owner");
    } finally {
      await runtime.end();
      await admin.end();
    }
  },
);

test(
  "session proof matrix: missing / forged / expired proofs and cross-actor stance+join are rejected",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async () => {
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const self = unique("principal_self");
    const other = unique("principal_other");
    const worldId = unique("world_matrix");
    const worldlineId = unique("worldline_matrix");
    try {
      await admin.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, 'self'), ($1, $3, 'other')`,
        [WS, self, other],
      );
      await seedWorld(admin, worldId, worldlineId, "proof matrix world");
      await seedCapabilitySessionKey(admin, WS);
      // other 先合法持有 player membership。
      await withRuntimeTx(runtime, (client) => client.query(
        `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
        [sessionProofFor(other), WS, "world_ember_coast", other],
      ));

      // 伪造证明（错误密钥签名）。
      const forged = `${self}.${Date.now() + 60_000}.${"0".repeat(64)}`;
      await assert.rejects(
        withRuntimeTx(runtime, (client) => client.query(
          `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
          [forged, WS, "world_ember_coast", self],
        )),
        (error: unknown) => error instanceof Error
          && error.message.includes("CAPABILITY_SESSION_PROOF_INVALID"),
      );

      // 过期证明。
      const { createHmac } = await import("node:crypto");
      const { sessionSecret } = await import("../modules/identity/session-secret.ts");
      const expiredAt = Date.now() - 1_000;
      const expiredPayload = `${self}.${expiredAt}`;
      const expired = `${expiredPayload}.${createHmac("sha256", sessionSecret()).update(expiredPayload).digest("hex")}`;
      await assert.rejects(
        withRuntimeTx(runtime, (client) => client.query(
          `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
          [expired, WS, "world_ember_coast", self],
        )),
        (error: unknown) => error instanceof Error
          && error.message.includes("CAPABILITY_SESSION_EXPIRED"),
      );

      // stance 冒名：self 的证明不得改 other 的行。
      await assert.rejects(
        withRuntimeTx(runtime, (client) => client.query(
          `SELECT membership_capability_grant($1, 'stance_self', $2, $3, NULL, $4, 'observer')`,
          [sessionProofFor(self), WS, "world_ember_coast", other],
        )),
        (error: unknown) => error instanceof Error
          && error.message.includes("CAPABILITY_ACTOR_MISMATCH"),
      );

      // join 冒名：self 的证明不得为 other 建 membership。
      const otherWorld = unique("world_force_join");
      await seedWorld(admin, otherWorld, unique("worldline_fj"), "force join world");
      await assert.rejects(
        withRuntimeTx(runtime, (client) => client.query(
          `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
          [sessionProofFor(self), WS, otherWorld, other],
        )),
        (error: unknown) => error instanceof Error
          && error.message.includes("CAPABILITY_ACTOR_MISMATCH"),
      );

      assert.equal(await membershipRole(admin, "world_ember_coast", self), null);
      assert.equal(
        await membershipRole(admin, "world_ember_coast", other),
        "player",
        "合法 join 不受影响",
      );
      assert.equal(await membershipRole(admin, otherWorld, other), null);
    } finally {
      await runtime.end();
      await admin.end();
    }
  },
);

test(
  "import bootstrap owner membership is an operator-bound controlled path (not capability issuance)",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async () => {
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    try {
      // realm_runtime 对导入受控函数零 EXECUTE（bootstrap 不走 capability 通道，
      // 也不向 runtime 开放）。
      const privileges = await admin.query(`
        SELECT has_function_privilege(
          'realm_runtime',
          'realm_import_begin_bootstrap(text,text,bigint,text,jsonb)',
          'EXECUTE'
        ) AS runtime_exec
      `);
      assert.equal(privileges.rows[0]?.runtime_exec, false);
      // 函数体审计锚：bootstrap 的 owner membership 只写 job_operator（来自
      // 任务台账），不读包内容 principal。
      const { readFile } = await import("node:fs/promises");
      const sql = await readFile(
        new URL("../database/postgres/migrations/0042_realm_transfer_and_import_jobs.sql", import.meta.url),
        "utf8",
      );
      const bootstrap = sql.slice(
        sql.indexOf("FUNCTION realm_import_begin_bootstrap"),
        sql.indexOf("$realm_import_begin_bootstrap$;"),
      );
      assert.ok(
        bootstrap.includes("VALUES (p_workspace_id, p_world_id, job_operator, 'owner', true, true)"),
        "bootstrap owner 行必须绑定 job_operator",
      );
      assert.ok(
        !/p_world_row[^;]*principal/i.test(bootstrap),
        "包内容不得驱动 membership principal",
      );
    } finally {
      await admin.end();
    }
  },
);
