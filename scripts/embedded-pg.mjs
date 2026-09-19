#!/usr/bin/env node
/**
 * REALM 嵌入式 PostgreSQL 管理器。
 *
 * 将 scripts/embedded-pg/Dockerfile.linux-x64 构建出的可重定位构件安装到
 * 用户目录（默认 ~/.local/realm-pgsql/17.10），安装后即可作为普通本地
 * PostgreSQL 使用：setup-web 的候选探测、local-postgres.mjs 的
 * REALM_POSTGRES_BIN 都认这个目录。
 *
 * 用法：
 *   node scripts/embedded-pg.mjs install --artifact <tarball> [--dir <path>]
 *   node scripts/embedded-pg.mjs info [--dir <path>]
 *
 * 设计约束：
 * - 只写用户目录，不提升权限，不碰系统包管理器；
 * - 安装前校验构件完整性（postgres/initdb/pg_ctl/psql/createdb/pg_isready
 *   可执行 + share/postgresql/extension/vector.control 存在 +
 *   bin/postgres --version 可运行）；
 * - 目录已存在时拒绝覆盖（先由用户显式删除，避免误毁数据目录）。
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

const DEFAULT_VERSION = "17.10";
const DEFAULT_DIR = join(homedir(), ".local", "realm-pgsql", DEFAULT_VERSION);
const REQUIRED_BINARIES = [
  "postgres",
  "initdb",
  "pg_ctl",
  "psql",
  "createdb",
  "pg_isready",
  "pg_config",
];

function fail(message) {
  console.error(`embedded-pg: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [action, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--artifact") options.artifact = rest[++index];
    else if (arg === "--dir") options.dir = rest[++index];
    else fail(`unknown argument: ${arg}`);
  }
  return { action, options };
}

function executableName(name) {
  return platform() === "win32" ? `${name}.exe` : name;
}

// 与 setup-web.mjs 同规则：Windows 上 .cmd/.bat shim 也算数。
function resolveExecutablePath(binDir, name) {
  if (platform() !== "win32") {
    const path = join(binDir, name);
    return existsSync(path) ? path : null;
  }
  for (const candidate of [`${name}.exe`, `${name}.cmd`, `${name}.bat`]) {
    const path = join(binDir, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

// 校验构件完整性；不合格抛 Error（调用方决定 fail 还是清理后重试）。
function verifyBundle(binDir) {
  const missing = REQUIRED_BINARIES.filter(
    (name) => resolveExecutablePath(binDir, name) === null,
  );
  if (missing.length > 0) {
    throw new Error(`bundle incomplete, missing: ${missing.join(", ")}`);
  }
  // zonkyio 布局平台差异：Windows 是 share/extension，Linux/macOS 是
  // share/postgresql/extension——校验要按平台找 vector.control。
  const shareExtensionDir = platform() === "win32"
    ? join("share", "extension")
    : join("share", "postgresql", "extension");
  if (!existsSync(join(binDir, "..", shareExtensionDir, "vector.control"))) {
    throw new Error("bundle incomplete: pgvector extension control file missing");
  }
  const probe = spawnSync(join(binDir, executableName("postgres")), ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LD_LIBRARY_PATH: "" },
  });
  if (probe.status !== 0) {
    throw new Error(`postgres --version probe failed: ${(probe.stderr ?? "").trim() || probe.status}`);
  }
  return probe.stdout.trim();
}

// 核心装包：解包到目标 → 完整性校验。失败抛异常并清理半成品。
// 注意：必须 tar 直接解到目标——Node cpSync 会把相对符号链接改写成
// 指向源目录的绝对链接，scratch 一删链接即断（实测踩过）。
function installFresh({ artifact, target }) {
  if (!existsSync(artifact)) throw new Error(`artifact not found: ${artifact}`);
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`target directory already exists and is not empty: ${target}\n` +
      " refusing to overwrite; remove it explicitly if you want a fresh install.");
  }
  mkdirSync(target, { recursive: true });
  const unpack = spawnSync("tar", ["-xzf", resolve(artifact), "-C", target], {
    stdio: "inherit",
  });
  if (unpack.status !== 0) {
    rmSync(target, { recursive: true, force: true });
    throw new Error("failed to extract artifact");
  }
  try {
    return verifyBundle(join(target, "bin"));
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function install({ artifact, dir }) {
  const target = resolve(dir ?? DEFAULT_DIR);
  if (!artifact) fail("install requires --artifact <tarball>");
  try {
    const version = installFresh({ artifact, target });
    console.log(`embedded PostgreSQL installed to ${target}`);
    console.log(`  ${version} + pgvector`);
    console.log("wire it up with:");
    console.log(`  export REALM_POSTGRES_BIN=${join(target, "bin")}`);
    console.log("then run scripts/setup-web.mjs (or scripts/local-postgres.mjs start)");
  } catch (error) {
    fail(error.message);
  }
}

// 已装版本号（如 "17.10"）；未装或损坏返回 null。
function installedVersion(dir) {
  const target = resolve(dir ?? DEFAULT_DIR);
  const binDir = join(target, "bin");
  if (resolveExecutablePath(binDir, "postgres") === null) return null;
  // 与 verifyBundle 同规则的平台感知布局检查。
  const shareExtensionDir = platform() === "win32"
    ? join("share", "extension")
    : join("share", "postgresql", "extension");
  if (!existsSync(join(target, shareExtensionDir, "vector.control"))) {
    return null;
  }
  const probe = spawnSync(resolveExecutablePath(binDir, "postgres"), ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LD_LIBRARY_PATH: "" },
  });
  if (probe.status !== 0) return null;
  return probe.stdout.match(/(\d+\.\d+)/)?.[1] ?? null;
}

// 安全升级：先备份式搬移旧安装，装新版，失败回滚。只换二进制，数据目录不动。
function upgrade({ artifact, dir }) {
  const target = resolve(dir ?? DEFAULT_DIR);
  if (!artifact) fail("upgrade requires --artifact <tarball>");
  if (!existsSync(artifact)) fail(`artifact not found: ${artifact}`);
  if (!existsSync(target)) fail(`nothing installed at ${target}; use install instead`);
  // 运行中拒绝：无法安全替换正在被使用的二进制。
  const pgCtl = resolveExecutablePath(join(target, "bin"), "pg_ctl");
  if (pgCtl) {
    const dataDir = process.env.REALM_POSTGRES_DATA_DIR
      ?? join(homedir(), ".local", "realm-pgsql", "data");
    const status = spawnSync(pgCtl, ["-D", dataDir, "status"], { stdio: "ignore" });
    if (status.status === 0) {
      fail(`PostgreSQL is running (data: ${dataDir}); stop it first (scripts/local-postgres.mjs stop)`);
    }
  }
  const backup = `${target}.bak`;
  rmSync(backup, { recursive: true, force: true });
  renameSync(target, backup);
  try {
    const version = installFresh({ artifact, target });
    console.log(`embedded PostgreSQL upgraded to ${version} + pgvector at ${target}`);
    console.log("data directory untouched (it lives outside the binary directory).");
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    renameSync(backup, target);
    fail(`upgrade failed, rolled back to the previous install: ${error.message}`);
  }
  rmSync(backup, { recursive: true, force: true });
}

function info({ dir }) {
  const target = resolve(dir ?? DEFAULT_DIR);
  if (!existsSync(join(target, "bin"))) fail(`not installed at ${target}`);
  const version = verifyBundle(join(target, "bin"));
  console.log(`dir: ${target}`);
  console.log(version);
}

// 纯版本号输出（供安装器做版本比较）；未安装时非零退出、无输出。
function version({ dir }) {
  const found = installedVersion(dir);
  if (!found) fail(`not installed at ${resolve(dir ?? DEFAULT_DIR)}`);
  console.log(found);
}

const { action, options } = parseArgs(process.argv.slice(2));
try {
  if (action === "install") install(options);
  else if (action === "upgrade") upgrade(options);
  else if (action === "info") info(options);
  else if (action === "version") version(options);
  else throw new Error("usage: node scripts/embedded-pg.mjs {install|upgrade --artifact <tarball> [--dir <path>] | info | version}");
} catch (error) {
  fail(error.message);
}
