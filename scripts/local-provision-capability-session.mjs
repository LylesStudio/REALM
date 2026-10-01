#!/usr/bin/env node
/**
 * M5（0053）capability 会话密钥 provisioning：把应用会话签名密钥的副本
 * 写入 realm_capability_keys（purpose='session'）。
 *
 * 信任边界：这是唯一的首写权威——runtime 没有任何 key provisioning/
 * bootstrap 入口；本脚本只接受 owner/provisioning 连接（DATABASE_URL，
 * loopback-only）+ 真实来源的会话密钥（REALM_SESSION_SECRET 或安装级
 * 0600 文件；开发兜底常量一律拒绝）。
 *
 * - 幂等：同值重复运行成功；分歧（库内现行值 ≠ 待写入值）fail-closed
 *   非零退出，绝不覆盖/轮换（轮换需运维显式流程）。
 * - 密钥值绝不打印/写日志/落命令行；输出只有安全状态行。
 * - 覆盖库内当前全部 workspace（新建 workspace 只发生在可信 bootstrap
 *   路径；新 workspace 加入后需重跑本脚本）。
 *
 * 运行（strip-types 用于 import TS 模块）：
 *   node --experimental-strip-types scripts/local-provision-capability-session.mjs
 * 顺序：postgres-migrate + seed 之后（需要 workspaces 与 keys 表存在）。
 */
import { createRequire } from "node:module";
import { ensureProvisionableSessionSecret } from "../modules/identity/session-secret.ts";

const require = createRequire(import.meta.url);
const pg = require("pg");

function fail(message) {
  console.error(`local-provision-capability-session: ${message}`);
  process.exit(1);
}

// 必须显式提供 owner/provisioning 连接（db:* 脚本经 .env.owner.local 注入）；
// 无默认值——不得静默指向任何共享库。
const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) {
  fail("an explicit loopback DATABASE_URL is required (no default; see .env.owner.local).");
}
try {
  const url = new URL(connectionString);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(host)) {
    fail("provisioning accepts only a loopback DATABASE_URL.");
  }
} catch (error) {
  fail(`invalid DATABASE_URL: ${error instanceof Error ? error.message : String(error)}`);
}

// env（合格）→ 0600 文件（合格）→ 原子创建安装级密钥（0700/0600）；
// 开发兜底常量与弱值一律拒绝；任何创建/权限失败 fail-closed。
const resolved = ensureProvisionableSessionSecret();
if (!resolved) {
  fail("no provisioning-grade session secret (env/0600 file/creatable install key); refusing the development fallback.");
}

const client = new pg.Client({ connectionString });
await client.connect();
try {
  const tables = await client.query(
    `SELECT to_regclass('public.realm_capability_keys') AS keys_table,
            to_regclass('public.workspaces') AS workspaces_table`,
  );
  if (!tables.rows[0]?.keys_table || !tables.rows[0]?.workspaces_table) {
    fail("realm_capability_keys/workspaces missing; run migrations and seed first.");
  }
  const workspaces = await client.query(`SELECT id FROM workspaces ORDER BY id`);
  if (workspaces.rows.length === 0) {
    fail("no workspaces found; run the demo seed first.");
  }
  for (const row of workspaces.rows) {
    // 同值幂等；分歧 fail-closed（只回读布尔，不读值）。
    const result = await client.query(
      `INSERT INTO realm_capability_keys (workspace_id, kid, key, purpose, status)
       VALUES ($1, 'session-primary', $2, 'session', 'active')
       ON CONFLICT (workspace_id, kid) DO NOTHING
       RETURNING kid`,
      [row.id, Buffer.from(resolved.secret, "utf8")],
    );
    if ((result.rowCount ?? 0) === 0) {
      const matches = await client.query(
        `SELECT (key = $2) AS matches FROM realm_capability_keys
         WHERE workspace_id = $1 AND kid = 'session-primary' AND purpose = 'session'`,
        [row.id, Buffer.from(resolved.secret, "utf8")],
      );
      if (matches.rows[0]?.matches !== true) {
        fail(`session key mismatch on an existing workspace (value never printed): ${row.id}`);
      }
    }
  }
  console.error(`local-provision-capability-session: provisioned ${workspaces.rows.length} workspace(s) from ${resolved.source} secret.`);
} finally {
  await client.end();
}
