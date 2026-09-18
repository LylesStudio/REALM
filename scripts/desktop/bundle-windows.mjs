#!/usr/bin/env node
/**
 * Windows x64 打包组装（CI 于 windows-latest 执行；组装逻辑可在 Linux 运行，
 * 但 NSIS/pgvector MSVC 编译只在 Windows runner 执行——契约测试只验证
 * allowlist/排除清单与脚本结构，不伪造 Windows 结果）。
 *
 * 步骤：下载并校验 Node/PG 官方包（sha256 必须匹配 inventory）→
 * 组装 bundle 目录（runtime/node、pgsql、app、launcher、NOTICE）。
 * pgvector 的 MSVC 编译由 installer/windows/build-pgvector.ps1 完成
 * （本脚本只负责把产物 vector.dll/control/sql 装入 pgsql）。
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const inventory = JSON.parse(
  readFileSync(resolve(projectRoot, "installer/windows/inventory.json"), "utf8"),
);

/**
 * 打包排除清单（私有/敏感/开发面；契约测试断言这些路径绝不进 bundle）。
 * 相对 projectRoot 的路径或文件名模式。
 */
export const PACKAGE_EXCLUDES = [
  ".env.local",
  ".env",
  ".local",
  ".next",
  ".vinext",
  ".playwright",
  ".public-release",
  "release-staging",
  "dist",
  "coverage",
  "node_modules",
  "tests",
  "docs",
  "STATUS.md",
  "AGENT.md",
  "CHANGELOG.md",
  "tsconfig.tsbuildinfo",
  "installer",
  "launcher-src",
];

/** app 代码 allowlist（相对 projectRoot；逐文件复制，不用目录全拷贝）。 */
export const PACKAGE_APP_PATHS = [
  "app",
  "modules",
  "database/postgres",
  "public",
  "scripts/dev-server.mjs",
  "scripts/local-postgres.mjs",
  "scripts/local-provision-realm-transfer.mjs",
  "scripts/postgres-migrate.mjs",
  "scripts/postgres-seed-demo.mjs",
  "scripts/provision-realm-transfer.mjs",
  "package.json",
  "tsconfig.json",
  "next.config.ts",
  "next-env.d.ts",
  "vite.config.ts",
  "postcss.config.mjs",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
];

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function download(url, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const result = spawnSync(
    process.platform === "win32" ? "curl.exe" : "curl",
    ["-fsSL", "-o", destination, url],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`download failed: ${url}`);
}

function verifyHash(path, expected, label) {
  const actual = sha256File(path);
  if (actual !== expected) {
    throw new Error(`${label} sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function copyAppTree(bundleRoot) {
  for (const relative of PACKAGE_APP_PATHS) {
    const source = resolve(projectRoot, relative);
    if (!existsSync(source)) throw new Error(`app path missing: ${relative}`);
    cpSync(source, join(bundleRoot, "app", relative), { recursive: true });
  }
  // 生产依赖树（调用方已先行执行 npm ci --omit=dev --ignore-scripts）。
  cpSync(resolve(projectRoot, "node_modules"), join(bundleRoot, "app", "node_modules"), {
    recursive: true,
  });
  // 构建产物（调用方已先行执行 npm run build）。
  cpSync(resolve(projectRoot, "dist"), join(bundleRoot, "app", "dist"), { recursive: true });
  // launcher（打包形态下由 bundled Node 运行）。
  cpSync(
    resolve(projectRoot, "launcher"),
    join(bundleRoot, "launcher"),
    { recursive: true },
  );
}

function assembleBundle(options) {
  const work = options.workDirectory;
  const bundleRoot = join(work, "REALM");
  rmSync(bundleRoot, { recursive: true, force: true });
  mkdirSync(bundleRoot, { recursive: true });

  // runtime/node/win-x64
  const nodeZip = join(work, "node.zip");
  download(inventory.node.url, nodeZip);
  verifyHash(nodeZip, inventory.node.sha256, "node");
  execFileSync("tar", ["-xf", nodeZip, "-C", work]);
  mkdirSync(join(bundleRoot, "runtime", "node"), { recursive: true });
  cpSync(
    join(work, `node-v${inventory.node.version}-win-x64`),
    join(bundleRoot, "runtime", "node", "win-x64"),
    { recursive: true },
  );

  // pgsql（含 CI 已编译装入的 pgvector）。
  const pgZip = join(work, "postgresql.zip");
  download(inventory.postgresql.url, pgZip);
  verifyHash(pgZip, inventory.postgresql.sha256, "postgresql");
  execFileSync("tar", ["-xf", pgZip, "-C", work]);
  const bundledPgRoot = join(bundleRoot, "pgsql", "win-x64");
  cpSync(join(work, "pgsql"), bundledPgRoot, { recursive: true });
  // pgvector 产物（由 build-pgvector.ps1 先行编译到 work/vector）。
  const vectorBuild = join(work, "vector");
  if (!existsSync(join(vectorBuild, "vector.dll"))) {
    throw new Error("pgvector build output missing (run installer/windows/build-pgvector.ps1 first)");
  }
  cpSync(join(vectorBuild, "vector.dll"), join(bundledPgRoot, "lib", "vector.dll"));
  for (const file of readdirSync(join(vectorBuild, "extension"))) {
    cpSync(
      join(vectorBuild, "extension", file),
      join(bundledPgRoot, "share", "extension", file),
    );
  }

  copyAppTree(bundleRoot);
  writeFileSync(
    join(bundleRoot, "NOTICE.txt"),
    [
      "REALM unsigned preview bundle",
      `Node.js ${inventory.node.version} (${inventory.node.license})`,
      `PostgreSQL ${inventory.postgresql.version} (${inventory.postgresql.license})`,
      `pgvector ${inventory.pgvector.tag} (${inventory.pgvector.license})`,
      "",
    ].join("\n"),
    "utf8",
  );
  return bundleRoot;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const workDirectory = process.argv[2] ?? resolve(projectRoot, ".public-release", "windows");
  try {
    const bundleRoot = assembleBundle({ workDirectory });
    console.log(`bundle assembled at ${bundleRoot}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
