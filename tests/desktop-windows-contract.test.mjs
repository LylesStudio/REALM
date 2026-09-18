/**
 * Windows 安装链 Linux 契约测试（结构性；Windows 编译/安装/真机未执行，
 * 不以此替代 windows-latest 构建结果）。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  acquireLock,
  buildChildEnv,
  envHasSecretValues,
  portCandidates,
  releaseLock,
  resolveDataHome,
} from "../launcher/realm-launcher.mjs";
import {
  PACKAGE_APP_PATHS,
  PACKAGE_EXCLUDES,
} from "../scripts/desktop/bundle-windows.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("REALM_DATA_HOME path projection: explicit override, Windows LOCALAPPDATA, posix default", () => {
  assert.equal(
    resolveDataHome({ REALM_DATA_HOME: "D:\\RealmData" }, "win32"),
    "D:\\RealmData",
  );
  assert.equal(
    resolveDataHome({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32"),
    resolve("C:\\Users\\u\\AppData\\Local", "REALM"),
  );
  assert.ok(
    resolveDataHome({}, "linux").endsWith(join(".local", "share", "REALM")),
    "posix 默认 ~/.local/share/REALM",
  );
});

test("child env carries full bootstrap contract, no secret values, loopback URLs", () => {
  const parentEnvironment = {
    ...process.env,
    PATH: process.env.PATH ?? "",
    OPENAI_API_KEY: "fake-api-key-must-not-cross-boundary",
    DATABASE_URL: "postgresql://user:password@example.invalid/secret",
  };
  const env = buildChildEnv({
    dataHome: join(tmpdir(), "realm-env-test"),
    pgBin: "",
    appPort: 9999,
    pgPort: 55432,
    environment: parentEnvironment,
  });
  assert.equal(env.HOST_BIND, "127.0.0.1");
  assert.equal(env.PORT, "9999");
  assert.equal(env.REALM_DATA_HOME, join(tmpdir(), "realm-env-test"));
  assert.equal("REALM_POSTGRES_BIN" in env, false, "开发模式不得注入空 pgBin 覆盖默认");
  assert.equal(env.REALM_POSTGRES_PORT, "55432");
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("DATABASE_URL" in env && env.DATABASE_URL.includes("password"), false);
  for (const name of ["DATABASE_URL", "REALM_RUNTIME_DATABASE_URL", "REALM_TRANSFER_DATABASE_URL"]) {
    const url = new URL(env[name]);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "55432");
    assert.equal(url.password, "", "连接串不得内嵌密码");
  }
  assert.equal(envHasSecretValues(env), false, "child env 不得携带 secret 形态");
  const bundled = buildChildEnv({
    dataHome: join(tmpdir(), "realm-env-test"),
    pgBin: "C:\\REALM\\pgsql\\bin",
    appPort: 9999,
    pgPort: 55432,
  });
  assert.equal(bundled.REALM_POSTGRES_BIN, "C:\\REALM\\pgsql\\bin");
});

test("single-instance lock: active rejection, stale reclaim, corrupt reclaim, release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realm-lock-"));
  try {
    const first = acquireLock(directory);
    assert.throws(
      () => acquireLock(directory),
      /already running/,
      "活跃实例必须给清晰错误",
    );
    releaseLock(first);
    // stale：写入不存在的 pid（dead），可回收。
    await writeFile(
      join(directory, "realm.lock"),
      `${JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    const reclaimed = acquireLock(directory);
    releaseLock(reclaimed);
    // corrupt：非 JSON lock，按 stale 回收。
    await writeFile(join(directory, "realm.lock"), "not-json", { mode: 0o600 });
    const second = acquireLock(directory);
    releaseLock(second);
    assert.equal(existsSync(join(directory, "realm.lock")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("port candidates step by 10 from the preferred port", () => {
  assert.deepEqual(portCandidates(9999, 3), [9999, 10009, 10019]);
});

test("package allowlist covers app runtime and excludes every private/sensitive path", () => {
  for (const relative of PACKAGE_APP_PATHS) {
    assert.ok(existsSync(resolve(projectRoot, relative)), `allowlist 路径缺失: ${relative}`);
  }
  const mustExclude = [
    ".env.local",
    ".local",
    "tests",
    "docs",
    "STATUS.md",
    "AGENT.md",
    "node_modules",
    "coverage",
  ];
  for (const entry of mustExclude) {
    assert.ok(PACKAGE_EXCLUDES.includes(entry), `排除清单缺少: ${entry}`);
  }
  // 排除项不得与 app allowlist 重叠（误放行）。
  for (const excluded of PACKAGE_EXCLUDES) {
    assert.ok(
      !PACKAGE_APP_PATHS.includes(excluded),
      `allowlist 与排除清单冲突: ${excluded}`,
    );
  }
});

test("inventory pins real versions and hashes (no placeholders)", () => {
  const inventory = JSON.parse(
    readFileSync(resolve(projectRoot, "installer/windows/inventory.json"), "utf8"),
  );
  for (const [name, entry] of [["node", inventory.node], ["postgresql", inventory.postgresql]]) {
    assert.match(entry.version, /^\d+\.\d+/, `${name} version`);
    assert.match(entry.url, /^https:\/\//, `${name} url 必须 https`);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/, `${name} sha256`);
  }
  assert.match(inventory.pgvector.tag, /^v\d+\.\d+\.\d+$/);
  assert.match(inventory.pgvector.commit, /^[0-9a-f]{40}$/);
  assert.doesNotMatch(JSON.stringify(inventory), /TODO|REPLACE_ME|PLACEHOLDER|CHANGEME/i);
});

test("desktop workflow contains required steps, no secrets, windows-latest", () => {
  const workflow = readFileSync(
    resolve(projectRoot, ".github/workflows/desktop-windows.yml"),
    "utf8",
  );
  assert.match(workflow, /runs-on: windows-latest/);
  for (const step of [
    "build-pgvector.ps1",
    "npm ci --ignore-scripts",
    "npm run build",
    "npm prune --omit=dev --ignore-scripts",
    "bundle-windows.mjs",
    "realm-launcher.mjs",
    "--check",
    "makensis",
    "upload-artifact",
  ]) {
    assert.ok(workflow.includes(step), `workflow 缺步骤: ${step}`);
  }
  assert.doesNotMatch(workflow, /secrets\./, "workflow 不得读取 secrets");
  // pgvector 编译必须先有 PG 二进制（顺序契约）。
  assert.ok(
    workflow.indexOf("Prepare PostgreSQL binaries") < workflow.indexOf("Compile pgvector"),
    "PG 二进制准备必须先于 pgvector 编译",
  );
  assert.ok(
    workflow.indexOf("Compile pgvector") < workflow.indexOf("Assemble bundle"),
    "pgvector 编译必须先于 bundle 组装",
  );
  assert.ok(
    workflow.includes("runtime\\node\\win-x64\\node.exe"),
    "Windows smoke 必须使用 bundled Node",
  );
  assert.match(workflow, /Copy-Item -Recurse -Force/);
});

test("NSIS script marks unsigned preview, keeps user data, no PATH mutation", () => {
  const nsi = readFileSync(resolve(projectRoot, "installer/windows/realm.nsi"), "utf8");
  assert.match(nsi, /unsigned preview/i);
  assert.match(nsi, /%LOCALAPPDATA%\\REALM/, "必须提示数据目录保留位置");
  assert.match(nsi, /win-x64\\node\.exe/, "快捷方式必须指向 bundled node");
  assert.doesNotMatch(nsi, /WriteRegStr.*(PATH|Path)/i, "不得写系统 PATH");
  assert.match(nsi, /UninstallString/);
});

test("pgvector build script pins tag/commit and rejects third-party binaries", () => {
  const script = readFileSync(
    resolve(projectRoot, "installer/windows/build-pgvector.ps1"),
    "utf8",
  );
  assert.match(script, /rev-parse HEAD/, "必须校验克隆出的 commit 与 pin 一致");
  assert.match(script, /nmake \/F Makefile\.win/, "必须用 MSVC nmake 从源码编译");
  assert.match(script, /vcvars64\.bat/);
});
