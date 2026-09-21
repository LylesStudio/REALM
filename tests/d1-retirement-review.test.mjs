/**
 * D1 退役链围栏（post-retirement 形态）。
 *
 * 沿革（历史形态见 Git）：T10-B11-A 评审围栏 → T10-B12-A 类型提取 →
 * T10-B14-A pair 删除 → T10-B18-A tooling 退役执行。
 * 当前事实：db 三件套（index/schema/d1-legacy-types）与 drizzle.config.ts
 * 已删除，drizzle/ 已整体归档至 docs/archive/d1-drizzle/，legacy script 与
 * drizzle-orm/drizzle-kit 依赖已移除；delivery projection 类型唯一来源是
 * modules/application/legacy-record-projection-types.ts（纯类型）。
 *
 * import/export/require 语句解析（行首锚定）+ specifier 形态匹配双轨——
 * resolve 不到的路径也要命中；注释/文档/字符串里的 "d1"/"drizzle" 合法，
 * 不做全仓字符串禁用。
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
const PRODUCTION_DIRS = ["app", "modules", "database", "scripts"];

const RETIRED_PATHS = [
  "db/index.ts",
  "db/schema.ts",
  "db/d1-legacy-types.d.ts",
  "drizzle.config.ts",
];
const RETAINED_PATHS = [
  "docs/archive/d1-drizzle/0000_orange_triathlon.sql",
  "docs/archive/d1-drizzle/meta/_journal.json",
  "docs/archive/d1-drizzle/README.md",
  "modules/application/legacy-record-projection-types.ts",
];
/** Clean-up Iteration 删除的 orphan（零生产导入的 compat adapter）。 */
const REMOVED_ORPHAN = "modules/story-record/public.ts";
/** 已删除 pair（T10-B14-A）——不存在是删除后预期。 */
const DELETED_PAIR = ["db/record-store.ts", "db/story-record-repository.ts"];
/** 退役 D1 链的 specifier 形态（@/ 别名、相对路径、db/ 内部 ./ 引用）。 */
const RETIRED_SPECIFIER =
  /^@\/db(?:\/(?:index|schema|d1-legacy-types|record-store|story-record-repository)(?:\.(?:ts|d\.ts))?)?$|(?:^|\/)db\/(?:index|schema|d1-legacy-types|record-store|story-record-repository)(?:\.(?:ts|d\.ts))?$/;
const DRIZZLE_PACKAGES = ["drizzle-orm", "drizzle-kit"];
const PORTABLE_TYPES = "modules/application/legacy-record-projection-types.ts";

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

/** 全部源码：生产/工具目录 + tests/ + 根级配置文件。 */
function collectAllSources() {
  const files = PRODUCTION_DIRS.flatMap((dir) =>
    collectSources(join(projectRoot, dir)),
  );
  files.push(...collectSources(join(projectRoot, "tests")));
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

function isProductionPath(relativePath) {
  return PRODUCTION_DIRS.some((dir) => relativePath.startsWith(`${dir}/`));
}

test("retired D1 chain files are gone; archive, portable types and Core contract stay", () => {
  for (const path of [...RETIRED_PATHS, ...DELETED_PAIR]) {
    assert.ok(!existsSync(join(projectRoot, path)), `${path} 应已退役/删除`);
  }
  for (const path of RETAINED_PATHS) {
    assert.ok(existsSync(join(projectRoot, path)), `${path} 应保留`);
  }
  assert.ok(
    !existsSync(join(projectRoot, REMOVED_ORPHAN)),
    "orphan story-record/public.ts 应已删除（Clean-up Iteration）",
  );
});

test("zero import references to the retired D1 chain across the whole scan surface", () => {
  // specifier 形态轨：resolve 不到（已删/已卸载）也要命中——db 路径、
  // pair 路径、drizzle 包名、drizzle/ 目录与 archive 路径一律不得出现在
  // import/export/require 语句中。
  const offenders = [];
  for (const reference of references) {
    const { specifier } = reference;
    const hitsRetiredDb = RETIRED_SPECIFIER.test(specifier);
    const hitsDrizzlePackage = DRIZZLE_PACKAGES.some(
      (name) => specifier === name || specifier.startsWith(`${name}/`),
    );
    const hitsDrizzlePath =
      /(?:^|\/)drizzle(?:\/|$)/.test(specifier) || specifier.includes("archive/d1-drizzle");
    if (hitsRetiredDb || hitsDrizzlePackage || hitsDrizzlePath) {
      offenders.push(`${reference.file} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the portable projection-types module is the only production type source and stays pure", () => {
  const knownProductionConsumers = new Set([
    // 评审实锤的 delivery projection 生产消费方；新增生产引用方必须先进评审。
    "database/postgres/delivery-projection.ts",
    "modules/application/local-record-service.ts",
  ]);
  const seenProductionConsumers = new Set();
  const offenders = [];
  for (const reference of references) {
    const isPortable =
      reference.specifier.includes("legacy-record-projection-types");
    if (!isPortable) continue;
    if (!reference.typeOnly) {
      offenders.push(`${reference.file} -> ${reference.specifier}（必须 import type）`);
      continue;
    }
    if (isProductionPath(reference.file)) seenProductionConsumers.add(reference.file);
  }
  assert.deepEqual(offenders, []);
  assert.deepEqual(
    [...seenProductionConsumers].sort(),
    [...knownProductionConsumers].sort(),
  );

  // 纯度：新模块自身只允许 import type，且不得依赖 db/、drizzle、
  // database/postgres 或路由层——值导入即生产 runtime 边。
  const portableSource = readFileSync(join(projectRoot, PORTABLE_TYPES), "utf8");
  const selfReferences = extractReferences(portableSource);
  assert.ok(selfReferences.length > 0, "sanity: 新模块应有类型依赖");
  for (const reference of selfReferences) {
    assert.ok(reference.typeOnly, `新模块出现值导入：${reference.specifier}`);
    assert.doesNotMatch(
      reference.specifier,
      /db\/|drizzle|database\/postgres|app\/api|story-record\/public/,
    );
  }
});

test("package records no longer carry the legacy script or drizzle dependencies", () => {
  const packageJson = readFileSync(join(projectRoot, "package.json"), "utf8");
  assert.doesNotMatch(packageJson, /"db:d1:legacy:generate"/);
  assert.doesNotMatch(packageJson, /"db:generate"/);
  assert.doesNotMatch(packageJson, /"drizzle-orm":/);
  assert.doesNotMatch(packageJson, /"drizzle-kit":/);
});
