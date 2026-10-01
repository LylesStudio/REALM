import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("Capability-boundary tests require a loopback PostgreSQL host.");
  }
  return url;
}

test(
  "realm_runtime cannot promote or create owner memberships with direct SQL",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async () => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const runtimeUrl = requireLoopbackUrl(runtimeConnectionString!);
    const admin = new pg.Pool({ connectionString: adminUrl.href, max: 1 });
    const runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const principalId = `principal_cap_${suffix}`;
    const insertedPrincipalId = `principal_cap_insert_${suffix}`;
    const displayName = `Capability ${suffix}`;
    let client: pg.PoolClient | undefined;

    try {
      await admin.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ('ws_demo', $1, $2), ('ws_demo', $3, $4)`,
        [principalId, displayName, insertedPrincipalId, `Capability insert ${suffix}`],
      );
      await admin.query(
        `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
         VALUES ('ws_demo', 'world_ember_coast', $1, 'player')`,
        [principalId],
      );

      client = await runtime.connect();
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('realm.workspace_id', $1, true)",
        ["ws_demo"],
      );

      let updateAffectedRows = 0;
      let updateRejected = false;
      try {
        const result = await client.query(
          `UPDATE player_world_memberships
           SET role = 'owner'
           WHERE workspace_id = 'ws_demo'
             AND world_id = 'world_ember_coast'
             AND principal_id = $1`,
          [principalId],
        );
        updateAffectedRows = result.rowCount ?? 0;
      } catch {
        updateRejected = true;
      } finally {
        await client.query("ROLLBACK");
      }

      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('realm.workspace_id', $1, true)",
        ["ws_demo"],
      );
      let insertAffectedRows = 0;
      let insertRejected = false;
      try {
        const result = await client.query(
          `INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role)
           VALUES ('ws_demo', 'world_ember_coast', $1, 'owner')`,
          [insertedPrincipalId],
        );
        insertAffectedRows = result.rowCount ?? 0;
      } catch {
        insertRejected = true;
      } finally {
        await client.query("ROLLBACK");
      }

      assert.deepEqual(
        {
          updateAllowedRows: updateRejected ? 0 : updateAffectedRows,
          insertAllowedRows: insertRejected ? 0 : insertAffectedRows,
        },
        { updateAllowedRows: 0, insertAllowedRows: 0 },
        "runtime direct SQL must not promote or create owner memberships",
      );
      const membership = await admin.query(
        `SELECT role FROM player_world_memberships
         WHERE workspace_id = 'ws_demo'
           AND world_id = 'world_ember_coast'
           AND principal_id = $1`,
        [principalId],
      );
      assert.equal(membership.rows[0]?.role, "player");
      const insertedMembership = await admin.query(
        `SELECT role FROM player_world_memberships
         WHERE workspace_id = 'ws_demo'
           AND world_id = 'world_ember_coast'
           AND principal_id = $1`,
        [insertedPrincipalId],
      );
      assert.equal(insertedMembership.rowCount, 0);
    } finally {
      client?.release();
      await runtime.end();
      await admin.end();
    }
  },
);

// ---- 0053 机制矩阵：mint/apply 是 DB 内部子操作（runtime 无 EXECUTE），
// 机制用例经 admin 池驱动；合法路径证明 = 应用会话签名密钥的测试副本。 ----

import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";

installTestSessionSecret();

const WS = "ws_demo";

async function withTx(pool: pg.Pool, workspaceId: string, fn: (client: pg.PoolClient) => Promise<unknown>): Promise<void> {
  const client = await pool.connect();
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

async function expectCapabilityError(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.ok(message.includes(code), `expected ${code}, got ${message}`);
    return true;
  });
}

function mintSql(): string {
  return `SELECT membership_capability_mint($1, 'join_player', $2, $3, NULL, $4, 'player', 30000) AS token`;
}

test(
  "capability mechanics: replay stable code, rollback-retry, tamper, expiry, cross-workspace, kid lifecycle",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 60_000 },
  async () => {
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const principal = `principal_cap_mech_${suffix}`;
    try {
      await admin.query(
        `INSERT INTO accounts (workspace_id, principal_id, display_name)
         VALUES ($1, $2, $3)`,
        [WS, principal, `Capability mech ${suffix}`],
      );
      await seedCapabilitySessionKey(admin, WS);
      const proof = sessionProofFor(principal);

      // 首次成功 + 重放（稳定 CAPABILITY_REPLAY，非内部约束名）。
      let token = "";
      await withTx(admin, WS, async (client) => {
        // 组合入口（含会话证明）：合法 join_player 成功。
        await client.query(
          `SELECT membership_capability_grant($1, 'join_player', $2, $3, NULL, $4, 'player')`,
          [proof, WS, "world_ember_coast", principal],
        );
      });
      // 取一张票据（admin 侧 mint 机制测试）再分别 apply。
      await withTx(admin, WS, async (client) => {
        const result = await client.query(
          mintSql(),
          [proof, WS, "world_ember_coast", principal],
        );
        token = result.rows[0].token as string;
      });
      await withTx(admin, WS, async (client) => {
        await client.query(`SELECT membership_capability_apply($1)`, [token]);
      });
      await expectCapabilityError(
        withTx(admin, WS, (client) =>
          client.query(`SELECT membership_capability_apply($1)`, [token])),
        "CAPABILITY_REPLAY",
      );

      // 回滚后重试：写事务回滚 → nonce 消费回滚 → 同票据可再用。
      let retryToken = "";
      await withTx(admin, WS, async (client) => {
        const result = await client.query(mintSql(), [proof, WS, "world_ember_coast", principal]);
        retryToken = result.rows[0].token as string;
      });
      {
        const client = await admin.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT set_config('realm.workspace_id', $1, true)", [WS]);
          await client.query(`SELECT membership_capability_apply($1)`, [retryToken]);
          await client.query("ROLLBACK");
        } finally {
          client.release();
        }
      }
      await withTx(admin, WS, async (client) => {
        await client.query(`SELECT membership_capability_apply($1)`, [retryToken]);
      });

      // 篡改：payload 改 role → CAPABILITY_SIGNATURE_MISMATCH。
      const parts: string[] = retryToken.split(".");
      const payload = JSON.parse(Buffer.from(parts[5], "base64").toString("utf8"));
      payload.role = "owner";
      parts[5] = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
      await expectCapabilityError(
        withTx(admin, WS, (client) =>
          client.query(`SELECT membership_capability_apply($1)`, [parts.join(".")])),
        "CAPABILITY_SIGNATURE_MISMATCH",
      );

      // 过期：mint ttl=1000ms，等待后 CAPABILITY_EXPIRED。
      let expiredToken = "";
      await withTx(admin, WS, async (client) => {
        const result = await client.query(
          `SELECT membership_capability_mint($1, 'join_player', $2, $3, NULL, $4, 'player', 1000) AS token`,
          [proof, WS, "world_ember_coast", principal],
        );
        expiredToken = result.rows[0].token as string;
      });
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await expectCapabilityError(
        withTx(admin, WS, (client) =>
          client.query(`SELECT membership_capability_apply($1)`, [expiredToken])),
        "CAPABILITY_EXPIRED",
      );

      // 跨 workspace：另一 workspace GUC 下 apply 本 workspace 票据。
      const otherWs = `ws_cap_${suffix}`;
      await admin.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [otherWs, `cap ${suffix}`],
      );
      await expectCapabilityError(
        withTx(admin, otherWs, (client) =>
          client.query(`SELECT membership_capability_apply($1)`, [retryToken])),
        "CAPABILITY_",
      );

      // kid 生命周期：unknown → retired（窗口内可用）→ revoked（拒绝）。
      let liveToken = "";
      await withTx(admin, WS, async (client) => {
        const result = await client.query(mintSql(), [proof, WS, "world_ember_coast", principal]);
        liveToken = result.rows[0].token as string;
      });
      const forged = [...liveToken.split(".")];
      forged[1] = `kid_unknown_${suffix}`;
      await expectCapabilityError(
        withTx(admin, WS, (client) =>
          client.query(`SELECT membership_capability_apply($1)`, [forged.join(".")])),
        "CAPABILITY_UNKNOWN_KID",
      );
      const liveKid = liveToken.split(".")[1];
      await admin.query(
        `UPDATE realm_capability_keys SET status = 'retired' WHERE workspace_id = $1 AND kid = $2`,
        [WS, liveKid],
      );
      // retired 在窗口内仍可验（轮换宽限）。
      await withTx(admin, WS, async (client) => {
        await client.query(`SELECT membership_capability_apply($1)`, [liveToken]);
      });
      await admin.query(
        `UPDATE realm_capability_keys SET status = 'revoked' WHERE workspace_id = $1 AND kid = $2`,
        [WS, liveKid],
      );
      let revokedPathToken = "";
      await withTx(admin, WS, async (client) => {
        const result = await client.query(mintSql(), [proof, WS, "world_ember_coast", principal]);
        revokedPathToken = result.rows[0].token as string;
      });
      assert.ok(revokedPathToken.split(".")[1] !== liveKid, "revoked 后 mint 必须换 kid");
    } finally {
      await admin.end();
    }
  },
);
