/**
 * D1/Drizzle tooling 退役执行后审计（post-retirement execution audit）。
 *
 * 本文件在 T10-B17-A 时是「退役资格评审」（待退役对象在位 + 零活动引用
 * 实锤，历史形态见 Git 记录与 STATUS/迭代日志）；T10-B18-A 经用户明确
 * 授权执行退役后转为执行后审计——退役对象不存在、archive 完整、
 * 零残留引用、保留项不动。
 *
 * import/export/require 语句解析（行首锚定）+ specifier 形态匹配双轨——
 * resolve 不到的路径也要命中；注释/文档/测试里的 drizzle 字样合法，
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
const SCAN_DIRS = ["app", "modules", "database", "scripts", "tests"];
const ARCHIVE_DIR = "docs/archive/d1-drizzle";

const RETIRED_PATHS = [
  "db/index.ts",
  "db/schema.ts",
  "db/d1-legacy-types.d.ts",
  "drizzle.config.ts",
  "drizzle/0000_orange_triathlon.sql",
  "drizzle/0001_cynical_khan.sql",
  "drizzle/0002_chunky_spirit.sql",
  "drizzle/meta/_journal.json",
];
const ARCHIVE_FILES = [
  "0000_orange_triathlon.sql",
  "0001_cynical_khan.sql",
  "0002_chunky_spirit.sql",
  "meta/0000_snapshot.json",
  "meta/0001_snapshot.json",
  "meta/0002_snapshot.json",
  "meta/_journal.json",
  "README.md",
];
/** 退役 D1 链的 specifier 形态（resolve 盲区覆盖）。 */
const RETIRED_SPECIFIER =
  /^@\/db(?:\/(?:index|schema|d1-legacy-types|record-store|story-record-repository)(?:\.(?:ts|d\.ts))?)?$|(?:^|\/)db\/(?:index|schema|d1-legacy-types|record-store|story-record-repository)(?:\.(?:ts|d\.ts))?$/;
const DRIZZLE_PACKAGES = ["drizzle-orm", "drizzle-kit"];

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

test("retired files, package script and drizzle dependencies are all gone", () => {
  for (const path of RETIRED_PATHS) {
    assert.ok(!existsSync(join(projectRoot, path)), `${path} 应已被 T10-B18-A 移除`);
  }
  const packageJson = readFileSync(join(projectRoot, "package.json"), "utf8");
  assert.doesNotMatch(packageJson, /"db:d1:legacy:generate"/);
  assert.doesNotMatch(packageJson, /"drizzle-orm":/);
  assert.doesNotMatch(packageJson, /"drizzle-kit":/);
  const lock = readFileSync(join(projectRoot, "package-lock.json"), "utf8");
  assert.doesNotMatch(lock, /node_modules\/drizzle-(orm|kit)/);
});

test("zero import references to the retired chain across the whole scan surface", () => {
  const offenders = [];
  for (const reference of references) {
    const { specifier } = reference;
    if (
      RETIRED_SPECIFIER.test(specifier)
      || DRIZZLE_PACKAGES.some(
        (name) => specifier === name || specifier.startsWith(`${name}/`),
      )
      || /(?:^|\/)drizzle(?:\/|$)/.test(specifier)
      || specifier.includes("archive/d1-drizzle")
    ) {
      offenders.push(`${reference.file} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the archive unit is complete at docs/archive/d1-drizzle", () => {
  for (const name of ARCHIVE_FILES) {
    assert.ok(
      existsSync(join(projectRoot, ARCHIVE_DIR, name)),
      `${ARCHIVE_DIR}/${name} 缺失，archive 单元不完整`,
    );
  }
  const journal = JSON.parse(
    readFileSync(join(projectRoot, ARCHIVE_DIR, "meta", "_journal.json"), "utf8"),
  );
  assert.equal(journal.dialect, "sqlite");
  assert.equal(journal.entries.length, 3);
  // archive 不得混入 PG 权威迁移目录。
  const pgFiles = readdirSync(join(projectRoot, "database/postgres/migrations"));
  for (const name of ARCHIVE_FILES.filter((entry) => entry.endsWith(".sql"))) {
    assert.ok(!pgFiles.includes(name), `${name} 不得出现在 PG migrations`);
  }
});

test("retained items stay intact: PG migrations, runner, Core contract and portable types", () => {
  const pgDir = join(projectRoot, "database/postgres/migrations");
  const files = readdirSync(pgDir).filter((name) => name.endsWith(".sql")).sort();
  assert.deepEqual(
    files.map((name) => name.slice(0, 4)),
    Array.from({ length: 51 }, (_, index) => String(index + 1).padStart(4, "0")),
    "PG migrations 0001–0038 应齐全（0024=T11-A2 账本、0025=T11-B 拓扑、0026/0027=T11-G 安全受众、0028=T11-I owner append、0029=Record 场景局势隔离、0030=Record 角色动态状态、0031=锐意洞察结果回填、0032=角色进退场权限、0033=基础技能 metadata 权限、0034=撤销过宽权限、0035=具体发现事实、0036=地点上下文、0037=Record 删除隐藏权限、0038=清理基础技能隐藏线索、0039/0040=场景天气/显示时间快照、0041=article qualification 账本与导入身份、0042=realm_transfer 角色校正+导入任务账本五表+受控函数、0043=node audience 归档闸门、0044=Record 分支 timeline kind、0045=大厅房间/成员表、0046=大厅房间绑定共享世界、0047=大厅房主在线租约、0048=场景图生成台账+world_files 图像类型扩展、0049=账号级场景图自动模式、0050=场景图自动请求队列、0051=账户密码哈希列）",
  );
  const runner = readFileSync(join(projectRoot, "scripts/postgres-migrate.mjs"), "utf8");
  assert.match(runner, /database\/postgres\/migrations/);
  assert.ok(
    existsSync(join(projectRoot, "modules/application/legacy-record-projection-types.ts")),
    "portable projection types 应保留",
  );
  // Clean-up Iteration：orphan Core story-record 模块已安全删除（零生产
  // 导入的 compat adapter），T10 时期的「保留 Core 契约」时点结论被取代。
  assert.ok(
    !existsSync(join(projectRoot, "modules/story-record/public.ts")),
    "orphan story-record/public.ts 应已删除",
  );
});
