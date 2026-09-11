#!/usr/bin/env node
/**
 * v37 §E.2：realm_transfer provisioning（唯一创建/管理 LOGIN 与凭据的入口；
 * migration 0042 永不触碰 LOGIN/NOLOGIN/PASSWORD）。
 *
 * 执行序：
 * ① 预检：SHOW shared_preload_libraries（含审计库 → no-go）+ pg_extension
 *    探测 pgaudit/pg_stat_statements（存在 → no-go）+ 三项 GUC 原值记录；
 * ② session gate：SET log_statement='none'、log_min_duration_statement=-1、
 *    log_min_error_statement='PANIC'（任一失败即中止，绝不执行 password DDL）；
 * ③ 同事务紧邻执行：角色不存在 → CREATE ROLE realm_transfer LOGIN <负向属性>；
 *    已存在 → ALTER ROLE … WITH LOGIN <负向属性>；密码设置：escapeLiteral()
 *    纯函数（' → ''）构造 ALTER ROLE … PASSWORD '<escaped>'（PG 工具语句无
 *    bind 参数）；BEGIN/COMMIT 包裹，失败整体回滚非零退出；密码仅从
 *    REALM_TRANSFER_PASSWORD env 读入进程内存；不打印、不写日志/文件；
 * ④ finally 恢复三项 GUC 原值（连接异常则 session 随连接销毁失效）。
 *
 * 威胁模型（受信单操作者窗口例外）：ALTER ROLE … PASSWORD '<literal>' 执行
 * 窗口内同实例其他 superuser 可经 pg_stat_activity 读到 query 文本——本地
 * 单操作者、实例空闲时执行；不接受该窗口则整项 no-go（发布闸门清单）。
 *
 * 用法：REALM_TRANSFER_PASSWORD=… node scripts/provision-realm-transfer.mjs
 *（DATABASE_URL 为 migration admin；连接串永不打印）。
 */
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
const password = process.env.REALM_TRANSFER_PASSWORD;

function fail(message) {
  console.error(`provision-realm-transfer: ${message}`);
  process.exit(1);
}

if (!connectionString) fail("DATABASE_URL is required.");
if (!password || password.length < 12) {
  fail("REALM_TRANSFER_PASSWORD is required (min 12 chars, env-only).");
}
const url = new URL(connectionString);
const host = url.hostname.replace(/^\[|\]$/g, "");
if (!["postgres:", "postgresql:"].includes(url.protocol)
  || !["127.0.0.1", "localhost", "::1"].includes(host)) {
  fail("provisioning accepts only a loopback DATABASE_URL.");
}

/** 纯函数 escapeLiteral（' → ''）。 */
function escapeLiteral(value) {
  return value.replaceAll("'", "''");
}

const NEGATIVE_ATTRS =
  "NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS";

const client = new pg.Client({ connectionString, ssl: false });
await client.connect().catch((error) => fail(`connect failed: ${error.message}`));

const GUC_NAMES = [
  "log_statement",
  "log_min_duration_statement",
  "log_min_error_statement",
];
const originalGucs = new Map();
let gucsGated = false;
try {
  // ① 预检。
  const preload = await client.query("SHOW shared_preload_libraries");
  const preloadValue = String(preload.rows[0]?.shared_preload_libraries ?? "");
  if (/pgaudit|pg_stat_statements/i.test(preloadValue)) {
    fail("shared_preload_libraries contains an audit extension; no-go.");
  }
  const extensions = await client.query(
    "SELECT extname FROM pg_extension WHERE extname IN ('pgaudit', 'pg_stat_statements')",
  );
  if (extensions.rowCount > 0) {
    fail("audit extension present (pgaudit/pg_stat_statements); no-go.");
  }
  for (const name of GUC_NAMES) {
    const value = await client.query(`SHOW ${name}`);
    originalGucs.set(name, String(Object.values(value.rows[0])[0]));
  }

  // ② session gate（任一失败即中止，绝不执行 password DDL）。
  await client.query("SET log_statement = 'none'");
  await client.query("SET log_min_duration_statement = -1");
  await client.query("SET log_min_error_statement = 'PANIC'");
  gucsGated = true;

  // ③ 同事务紧邻执行。
  await client.query("BEGIN");
  try {
    const role = await client.query(
      "SELECT rolname FROM pg_roles WHERE rolname = 'realm_transfer'",
    );
    if (role.rowCount === 0) {
      await client.query(
        `CREATE ROLE realm_transfer LOGIN ${NEGATIVE_ATTRS}`,
      );
    } else {
      await client.query(
        `ALTER ROLE realm_transfer WITH LOGIN ${NEGATIVE_ATTRS}`,
      );
    }
    await client.query(
      `ALTER ROLE realm_transfer PASSWORD '${escapeLiteral(password)}'`,
    );
    // 读回（同事务）：LOGIN 保持、负向属性收敛。
    const readback = await client.query(
      `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
              rolinherit, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = 'realm_transfer'`,
    );
    const state = readback.rows[0];
    if (!state || state.rolcanlogin !== true
      || state.rolsuper || state.rolcreatedb || state.rolcreaterole
      || state.rolinherit || state.rolreplication || state.rolbypassrls) {
      throw new Error("realm_transfer role readback mismatch");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
  // 成功输出不含任何凭据/连接信息。
  console.log("realm_transfer provisioned (LOGIN, negative attributes, password set).");
} catch (error) {
  fail(`provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  // ④ 恢复三项 GUC 原值（连接异常则 session 随连接销毁失效）。
  if (gucsGated) {
    for (const [name, value] of originalGucs) {
      await client.query(`SET ${name} = '${value.replaceAll("'", "''")}'`)
        .catch(() => undefined);
    }
  }
  await client.end().catch(() => undefined);
}
