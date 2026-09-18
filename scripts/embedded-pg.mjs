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
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

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

function verifyBundle(binDir) {
  const missing = REQUIRED_BINARIES.filter(
    (name) => !existsSync(join(binDir, executableName(name))),
  );
  if (missing.length > 0) {
    fail(`bundle incomplete, missing: ${missing.join(", ")}`);
  }
  if (!existsSync(join(binDir, "..", "share", "postgresql", "extension", "vector.control"))) {
    fail("bundle incomplete: pgvector extension control file missing");
  }
  const probe = spawnSync(join(binDir, executableName("postgres")), ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LD_LIBRARY_PATH: "" },
  });
  if (probe.status !== 0) {
    fail(`bin/postgres --version failed: ${(probe.stderr || "").trim() || "unknown error"}`);
  }
  return probe.stdout.trim();
}

function install({ artifact, dir }) {
  const target = resolve(dir ?? DEFAULT_DIR);
  if (!artifact) fail("install requires --artifact <tarball>");
  if (!existsSync(artifact)) fail(`artifact not found: ${artifact}`);
  if (existsSync(target) && readdirSync(target).length > 0) {
    fail(`target directory already exists and is not empty: ${target}\n` +
      " refusing to overwrite; remove it explicitly if you want a fresh install.");
  }

  const scratch = mkdtempSync(join(tmpdir(), "realm-embedded-pg-"));
  try {
    const unpack = spawnSync("tar", ["-xzf", resolve(artifact), "-C", scratch], {
      stdio: "inherit",
    });
    if (unpack.status !== 0) fail("failed to extract artifact");
    const version = verifyBundle(join(scratch, "bin"));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(scratch, target, { recursive: true });
    console.log(`embedded PostgreSQL installed to ${target}`);
    console.log(`  ${version} + pgvector`);
    console.log("wire it up with:");
    console.log(`  export REALM_POSTGRES_BIN=${join(target, "bin")}`);
    console.log("then run scripts/setup-web.mjs (or scripts/local-postgres.mjs start)");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function info({ dir }) {
  const target = resolve(dir ?? DEFAULT_DIR);
  if (!existsSync(join(target, "bin"))) fail(`not installed at ${target}`);
  const version = verifyBundle(join(target, "bin"));
  console.log(`dir: ${target}`);
  console.log(version);
}

const { action, options } = parseArgs(process.argv.slice(2));
if (action === "install") install(options);
else if (action === "info") info(options);
else fail("usage: node scripts/embedded-pg.mjs {install --artifact <tarball> [--dir <path>] | info}");
