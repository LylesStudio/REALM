/**
 * 批次 T10-B18-A：Drizzle/D1 历史迁移 archive 围栏（post-retirement 形态）。
 *
 * 本文件在 T10-B15-A 时守「保留原位」、T10-B16-A 起承担 legacy script/
 * inactive 文案指定锚点（历史形态见 Git）；T10-B18-A 执行退役后同步为
 * post-retirement 形态——archive 位于 docs/archive/d1-drizzle/（整体
 * git mv，内容零改写），原 drizzle/、drizzle.config.ts、db 三件套与
 * legacy tooling 已移除。
 *
 * 锚定纪律不变：存在性/关键头部/journal tags 实锚，不生成 hash 伪证据，
 * 不做全仓 "drizzle" 字符串禁用（历史文档/测试字样合法）。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const ARCHIVE_DIR = "docs/archive/d1-drizzle";

const ARCHIVE_SQL = [
  "0000_orange_triathlon.sql",
  "0001_cynical_khan.sql",
  "0002_chunky_spirit.sql",
];
const ARCHIVE_META = [
  "0000_snapshot.json",
  "0001_snapshot.json",
  "0002_snapshot.json",
  "_journal.json",
];
const REMOVED_PATHS = [
  "drizzle/0000_orange_triathlon.sql",
  "drizzle/0001_cynical_khan.sql",
  "drizzle/0002_chunky_spirit.sql",
  "drizzle/meta/_journal.json",
  "drizzle.config.ts",
  "db/index.ts",
  "db/schema.ts",
  "db/d1-legacy-types.d.ts",
];
const PG_MIGRATION_DIR = "database/postgres/migrations";
const PG_ONLY_CONSTRUCT = /CREATE POLICY|ENABLE ROW LEVEL SECURITY|GRANT\s+\w+\s+ON|realm_runtime/i;

test(
  "the archive unit is complete at its post-retirement location; original paths are gone",
  { skip: !existsSync(join(projectRoot, ARCHIVE_DIR)) },
  () => {
  for (const name of ARCHIVE_SQL) {
    assert.ok(existsSync(join(projectRoot, ARCHIVE_DIR, name)), `${ARCHIVE_DIR}/${name} 应在位`);
  }
  for (const name of ARCHIVE_META) {
    assert.ok(existsSync(join(projectRoot, ARCHIVE_DIR, "meta", name)), `meta/${name} 应在位`);
  }
  assert.ok(existsSync(join(projectRoot, ARCHIVE_DIR, "README.md")), "archive README 应在位");
  for (const path of REMOVED_PATHS) {
    assert.ok(!existsSync(join(projectRoot, path)), `${path} 应已被 T10-B18-A 移除`);
  }
});

test("legacy tooling is retired from package records (post-retirement designated anchor)", () => {
  // 批次 T10-B18-A：本用例继续承担指定锚点，形态由「存在」翻为「退役后
  // 不存在」——legacy script、drizzle 依赖、db/index inactive 入口已消失；
  // 「无 db:generate」负断言保持（与存废无关）。
  const packageJson = readFileSync(join(projectRoot, "package.json"), "utf8");
  assert.doesNotMatch(packageJson, /"db:d1:legacy:generate"/);
  assert.doesNotMatch(packageJson, /"db:generate"/);
  assert.doesNotMatch(packageJson, /"drizzle-orm":/);
  assert.doesNotMatch(packageJson, /"drizzle-kit":/);
  const lock = readFileSync(join(projectRoot, "package-lock.json"), "utf8");
  assert.doesNotMatch(lock, /node_modules\/drizzle-(orm|kit)/);
  assert.ok(!existsSync(join(projectRoot, "db/index.ts")), "db/index.ts 应已删除");
});

test(
  "archive provenance chain is intact, SQLite-only, and carries config provenance",
  { skip: !existsSync(join(projectRoot, ARCHIVE_DIR)) },
  () => {
  const journal = JSON.parse(
    readFileSync(join(projectRoot, ARCHIVE_DIR, "meta", "_journal.json"), "utf8"),
  );
  assert.equal(journal.dialect, "sqlite");
  assert.deepEqual(
    journal.entries.map((entry) => entry.tag),
    ARCHIVE_SQL.map((name) => name.replace(/\.sql$/, "")),
  );
  for (const name of ARCHIVE_META.filter((entry) => entry.endsWith("_snapshot.json"))) {
    const snapshot = JSON.parse(
      readFileSync(join(projectRoot, ARCHIVE_DIR, "meta", name), "utf8"),
    );
    assert.equal(snapshot.dialect, "sqlite", `${name} dialect 应为 sqlite`);
  }
  const heads = [
    /CREATE TABLE `character_definitions`/,
    /CREATE TABLE `prototype_turn_commits`/,
    /ALTER TABLE `events` ADD `visibility_payload`/,
  ];
  ARCHIVE_SQL.forEach((name, index) => {
    const sql = readFileSync(join(projectRoot, ARCHIVE_DIR, name), "utf8");
    assert.match(sql, heads[index], `${name} 关键头部缺失`);
    assert.match(sql, /-->\s*statement-breakpoint/, `${name} 应保留 drizzle-kit sqlite 签名`);
    assert.doesNotMatch(sql, PG_ONLY_CONSTRUCT, `${name} 出现 PG 专有构造`);
  });
  // config provenance 入 README：全文要点齐全，且明确标注不可据此重建。
  const readme = readFileSync(join(projectRoot, ARCHIVE_DIR, "README.md"), "utf8");
  assert.match(readme, /drizzle\.config\.ts provenance/);
  assert.match(readme, /\.\/db\/schema\.ts/);
  assert.match(readme, /out: "\.\/drizzle"/);
  assert.match(readme, /dialect: "sqlite"/);
  assert.match(readme, /drizzle-kit generate/);
  assert.match(readme, /不要/);
});

test("PostgreSQL authoritative migrations stay complete and archive-free", () => {
  const directory = join(projectRoot, PG_MIGRATION_DIR);
  const files = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  assert.deepEqual(
    files.map((name) => name.slice(0, 4)),
    Array.from({ length: 53 }, (_, index) => String(index + 1).padStart(4, "0")),
    "PG migrations 0001–0053 应连续齐全；0048–0050 负责场景图，0051 账户密码，0052 场景图队列 lease fencing、0053 membership capability。",
  );
  for (const name of files) {
    const sql = readFileSync(join(directory, name), "utf8");
    assert.doesNotMatch(sql, /-->\s*statement-breakpoint/, `${name} 混入 drizzle 签名`);
  }
  const runner = readFileSync(join(projectRoot, "scripts/postgres-migrate.mjs"), "utf8");
  assert.match(runner, /database\/postgres\/migrations/);
  assert.doesNotMatch(runner, /drizzle\/|archive\/d1-drizzle/);
});
