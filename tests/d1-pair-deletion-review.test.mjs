/**
 * D1 pair 删除后围栏（post-retirement 形态）。
 *
 * 本文件在 T10-B13-A 时是「pair 删除资格评审」（历史形态见 Git 记录）；
 * T10-B14-A 执行 pair 删除后转为「删除后纪事」；T10-B18-A tooling 退役
 * 执行后再次同步——deferred 五件套（db 三件套 + drizzle.config + 原
 * drizzle/ 路径）已移除/归档，本测试守：pair 与退役链零残留引用、
 * archive/portable types/Core contract 保留、package 记录无 legacy tooling。
 *
 * 与 tests/d1-retirement-review.test.mjs 同源的 import/export/require 语句
 * 解析（行首锚定，注释/文档/字符串里的字样不命中），不做全仓字符串禁用。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs"]);
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".vinext",
  ".local",
  ".playwright",
  "dist",
]);
// db/ 已随 T10-B18-A 整体退役（目录不复存在），扫描面不再包含它。
const SCAN_DIRS = ["app", "modules", "database", "scripts", "tests"];

const DELETED_PAIR = ["db/record-store.ts", "db/story-record-repository.ts"];
/** pair 的 import specifier 形态（@/ 别名、相对路径、db/ 内部 ./ 引用）。 */
const PAIR_SPECIFIER = /(?:^|\/)(?:db\/)?(?:record-store|story-record-repository)(?:\.ts)?$/;
/** 批次 T10-B18-A：deferred 五件套已退役——不存在是退役后预期。 */
const RETIRED_PATHS = [
  "db/index.ts",
  "db/schema.ts",
  "db/d1-legacy-types.d.ts",
  "drizzle.config.ts",
  "drizzle/0000_orange_triathlon.sql",
  "drizzle/0001_cynical_khan.sql",
  "drizzle/0002_chunky_spirit.sql",
];
const RETIRED_DB_SPECIFIER =
  /^@\/db(?:\/(?:index|schema|d1-legacy-types)(?:\.(?:ts|d\.ts))?)?$|(?:^|\/)db\/(?:index|schema|d1-legacy-types)(?:\.(?:ts|d\.ts))?$/;
const RETAINED_FILES = [
  "docs/archive/d1-drizzle/0000_orange_triathlon.sql",
  "docs/archive/d1-drizzle/meta/_journal.json",
  "modules/application/legacy-record-projection-types.ts",
];
// Clean-up Iteration（docs/development/CLEANUP-ITERATION.md §三）：orphan
// Core story-record 模块（零生产导入的 compatibility adapter）已安全删除，
// 取代 T10 时期「保留 Core 契约」的时点结论。
const REMOVED_ORPHAN = "modules/story-record/public.ts";

function collectSources(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
        files.push(path);
      }
    }
  };
  walk(directory);
  return files;
}

function collectAllSources() {
  const files = SCAN_DIRS.flatMap((dir) => collectSources(join(projectRoot, dir)));
  for (const entry of readdirSync(projectRoot, { withFileTypes: true })) {
    if (entry.isFile() && SOURCE_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      files.push(join(projectRoot, entry.name));
    }
  }
  return files;
}

/** import/export 必须出现在行首——注释里的 "import" 字样不构成语句。 */
function extractReferences(source) {
  const references = [];
  const statement =
    /^[ \t]*(import|export)[ \t]+(type[ \t]+)?[\s\S]*?\sfrom\s+["']([^"']+)["']|^[ \t]*import[ \t]+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/gm;
  for (const match of source.matchAll(statement)) {
    references.push({
      specifier: match[3] ?? match[4] ?? match[5],
      typeOnly: Boolean(match[2]),
    });
  }
  return references;
}

const references = collectAllSources().flatMap((file) =>
  extractReferences(readFileSync(file, "utf8")).map((reference) => ({
    file: relative(projectRoot, file),
    ...reference,
  })),
);

test("the deleted pair and retired deferred files are gone; archive, portable types and Core stay", () => {
  for (const path of [...DELETED_PAIR, ...RETIRED_PATHS]) {
    assert.ok(!existsSync(join(projectRoot, path)), `${path} 应已删除/退役`);
  }
  for (const path of RETAINED_FILES) {
    assert.ok(existsSync(join(projectRoot, path)), `${path} 应保留`);
  }
});

test("the deleted pair has zero import references across the whole scan surface", () => {
  // 任何对 pair 路径的 import/export/require 语句（含 db/ 内部残留、
  // @/ 别名、type-only）都是漂移——按语句中的 specifier 形态匹配。
  const offenders = [];
  for (const reference of references) {
    if (PAIR_SPECIFIER.test(reference.specifier)) {
      offenders.push(`${reference.file} -> ${reference.specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the retired db/ legacy trio has zero import references across the whole scan surface", () => {
  // 批次 T10-B18-A：deferred 三件套已删除，任何对 @/db、db/index、
  // db/schema、d1-legacy-types 的 import/export/require 语句（含悬挂
  // 引用、type-only）都是漂移——按语句中的 specifier 形态匹配。
  const offenders = [];
  for (const reference of references) {
    if (RETIRED_DB_SPECIFIER.test(reference.specifier)) {
      offenders.push(`${reference.file} -> ${reference.specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("orphan Core story-record module is gone and nothing references it", () => {
  // Clean-up Iteration：orphan 删除后不得再出现对它的 import/export。
  assert.ok(
    !existsSync(join(projectRoot, REMOVED_ORPHAN)),
    "modules/story-record/public.ts 应已删除（orphan compatibility adapter）",
  );
  const offenders = references.filter((reference) =>
    /(?:^|\/)story-record\/public(?:\.ts)?$/.test(reference.specifier)
  );
  assert.deepEqual(offenders.map((reference) =>
    `${reference.file} -> ${reference.specifier}`
  ), []);
});

test("package records no longer carry the legacy tooling", () => {
  // 批次 T10-B18-A：legacy script 与 drizzle 依赖已移除；「无 db:generate」
  // 负断言保持（与存废无关）。
  const packageJson = readFileSync(join(projectRoot, "package.json"), "utf8");
  assert.doesNotMatch(packageJson, /"db:d1:legacy:generate"/);
  assert.doesNotMatch(packageJson, /"db:generate"/);
  assert.doesNotMatch(packageJson, /"drizzle-orm":/);
  assert.doesNotMatch(packageJson, /"drizzle-kit":/);
  assert.ok(!existsSync(join(projectRoot, "db/index.ts")), "db/index.ts 应已删除");
});
