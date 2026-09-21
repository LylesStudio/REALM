import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

/**
 * 批次 T11-C：临时数据库盘点维护工具（规范 §四/§五）。
 *
 * 用法：
 *   node --env-file-if-exists=.env.local scripts/db-maintenance-inventory.mjs
 *     [report]                        默认：只报告，零写操作
 *     --drop --name <exact> [...]     精确名称清理（可重复）
 *     --drop --prefix <realm_t…>      收窄前缀清理（必须比裸 realm_t 更长）
 *
 * 硬边界：
 * - 只盘点 realm_t%（PG 测试强制拆库的命名约定），其余数据库永不触碰；
 * - 清理目标必须命中盘点清单；realm_dev / 系统库 / 未知目标一律拒绝；
 * - 连接配置只从 DATABASE_URL 读取，输出永不包含连接串/用户名/密码。
 */

const TEMP_DATABASE_LIKE = "realm_t%";
const TEMP_DATABASE_NAME = /^realm_t[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*$/;
const BARE_PREFIX = "realm_t";
const FORBIDDEN_TARGETS = new Set([
  "realm_dev",
  "postgres",
  "template0",
  "template1",
]);

/** 开发库权威基线表（与 STATUS 清理核查口径一致；含 T11-B 新表）。 */
export const BASELINE_TABLES = Object.freeze([
  "worlds",
  "accounts",
  "record_first_nights",
  "action_receipts",
  "memory_snapshots",
  "world_entities",
  "graph_invalidation_events",
  "world_claims",
  "world_articles",
  "canon_proposals",
  "propagation_nodes",
  "propagation_routes",
  "information_campaigns",
  "information_packets",
  "propagation_exposures",
  "propagation_jobs",
  "semantic_conflict_evaluations",
]);

export class InventoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "InventoryError";
  }
}

/** 列出 realm_t% 临时库（稳定升序）。query: (text, params) => { rows }. */
export async function listTemporaryDatabases(query) {
  const result = await query(
    `SELECT datname FROM pg_database
      WHERE datname LIKE $1 AND NOT datistemplate
      ORDER BY datname ASC`,
    [TEMP_DATABASE_LIKE],
  );
  return result.rows.map((row) => row.datname);
}

/** 开发库基线计数：逐表 to_regclass 守卫，缺表记 null 不报错。 */
export async function collectBaselineCounts(
  query,
  tables = BASELINE_TABLES,
) {
  const counts = {};
  for (const table of tables) {
    const exists = await query(`SELECT to_regclass($1) AS reg`, [
      `public.${table}`,
    ]);
    if (!exists.rows[0]?.reg) {
      counts[table] = null;
      continue;
    }
    // 表名来自上方常量白名单（非用户输入），直接拼接安全。
    const counted = await query(
      `SELECT count(*)::int AS n FROM "public"."${table}"`,
    );
    counts[table] = counted.rows[0].n;
  }
  return counts;
}

/** 迁移台账最大版本（filename 零填充，字典序即版本序）。 */
export async function latestMigration(query) {
  const exists = await query(`SELECT to_regclass($1) AS reg`, [
    "public.realm_schema_migrations",
  ]);
  if (!exists.rows[0]?.reg) return null;
  const result = await query(
    `SELECT max(filename) AS latest FROM realm_schema_migrations`,
  );
  return result.rows[0]?.latest ?? null;
}

/**
 * 清理目标解析：只读盘点清单做闸门判定，不触库。
 * 返回排序后的目标数组；任何越界请求抛 InventoryError（零 DROP）。
 */
export function planDropTargets({ temporaryDatabases, names = [], prefix }) {
  const known = new Set(temporaryDatabases);
  const targets = new Set();
  for (const name of names) {
    if (FORBIDDEN_TARGETS.has(name) || !TEMP_DATABASE_NAME.test(name)) {
      throw new InventoryError(
        `refusing drop target "${name}": not a realm_t<批次> temporary database`,
      );
    }
    if (!known.has(name)) {
      throw new InventoryError(
        `refusing drop target "${name}": not present in the realm_t% inventory`,
      );
    }
    targets.add(name);
  }
  if (prefix !== undefined) {
    if (
      typeof prefix !== "string"
      || !prefix.startsWith(BARE_PREFIX)
      || prefix.length <= BARE_PREFIX.length
    ) {
      throw new InventoryError(
        `refusing drop prefix "${prefix}": must narrow beyond bare "${BARE_PREFIX}"`,
      );
    }
    const matched = temporaryDatabases.filter((name) =>
      name.startsWith(prefix),
    );
    if (matched.length === 0) {
      throw new InventoryError(
        `refusing drop prefix "${prefix}": matches nothing in the realm_t% inventory`,
      );
    }
    const malformed = matched.filter((name) => !TEMP_DATABASE_NAME.test(name));
    if (malformed.length > 0) {
      throw new InventoryError(
        `refusing drop prefix "${prefix}": inventory contains non-convention match ${malformed.join(", ")}`,
      );
    }
    for (const name of matched) targets.add(name);
  }
  if (targets.size === 0) {
    throw new InventoryError("drop requested without --name or --prefix");
  }
  return [...targets].sort();
}

/** 汇总报告（稳定键序，零 secret）。 */
export async function buildInventoryReport(query, databaseName) {
  const temporaryDatabases = await listTemporaryDatabases(query);
  const baseline = await collectBaselineCounts(query);
  const migration = await latestMigration(query);
  return {
    database: databaseName,
    temporaryDatabases,
    temporaryDatabaseCount: temporaryDatabases.length,
    baseline,
    latestMigration: migration,
  };
}

function parseArgs(argv) {
  const args = { drop: false, names: [], prefix: undefined };
  const rest = [...argv];
  if (rest[0] === "report") rest.shift();
  while (rest.length > 0) {
    const token = rest.shift();
    if (token === "--drop") {
      args.drop = true;
    } else if (token === "--name") {
      const value = rest.shift();
      if (!value) throw new InventoryError("--name requires a value");
      args.names.push(value);
    } else if (token === "--prefix") {
      const value = rest.shift();
      if (!value) throw new InventoryError("--prefix requires a value");
      args.prefix = value;
    } else {
      throw new InventoryError(`unknown argument: ${token}`);
    }
  }
  return args;
}

/** 已校验名称（TEMP_DATABASE_NAME）双引号包裹后 DROP。 */
async function dropDatabase(query, name) {
  await query(`DROP DATABASE "${name}"`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new InventoryError(
      "DATABASE_URL is required. Copy .env.example to .env.local.",
    );
  }
  const url = new URL(connectionString);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "::1"].includes(hostname)
  ) {
    throw new InventoryError(
      "db-maintenance-inventory accepts only a local loopback DATABASE_URL.",
    );
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const client = new pg.Client({ connectionString });
  await client.connect();
  const query = (text, params) => client.query(text, params);
  try {
    const report = await buildInventoryReport(query, databaseName);
    console.log(JSON.stringify(report, null, 2));
    if (args.drop) {
      const targets = planDropTargets({
        temporaryDatabases: report.temporaryDatabases,
        names: args.names,
        prefix: args.prefix,
      });
      const dropped = [];
      for (const name of targets) {
        await dropDatabase(query, name);
        dropped.push(name);
        console.log(`dropped ${name}`);
      }
      console.log(JSON.stringify({ dropped, droppedCount: dropped.length }));
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      import.meta.url === pathToFileURL(realpathSync(resolve(entry))).href
    );
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  main().catch((error) => {
    // 错误输出只含消息（连接串永不落日志）。
    console.error(
      `db-maintenance-inventory: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
