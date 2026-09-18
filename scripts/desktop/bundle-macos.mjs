#!/usr/bin/env node
/**
 * macOS arm64/x64 bundle assembly.
 *
 * The bundle contains the production app, a target-architecture Node runtime,
 * a target-runner PostgreSQL + pgvector tree, and a tiny .app launcher. The
 * user's data remains outside the application bundle.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const inventory = JSON.parse(
  readFileSync(resolve(projectRoot, "installer/macos/inventory.json"), "utf8"),
);

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

export function validateArchTag(archTag) {
  if (!Object.hasOwn(inventory.node.artifacts, archTag)) {
    throw new Error(`unsupported macOS architecture tag: ${archTag}`);
  }
  return archTag;
}

function download(url, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const result = spawnSync(
    "curl",
    ["--http1.1", "--connect-timeout", "15", "--max-time", "120", "--retry-max-time", "120", "--retry", "4", "--retry-all-errors", "--retry-delay", "2", "-fsSL", "-o", destination, url],
    {
    stdio: "inherit",
    },
  );
  if (result.status !== 0) throw new Error(`download failed: ${url}`);
}

function verifyHash(path, expected, label) {
  const actual = sha256File(path);
  if (actual !== expected) {
    throw new Error(`${label} sha256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function copyAppTree(resourcesRoot) {
  for (const relative of PACKAGE_APP_PATHS) {
    const source = resolve(projectRoot, relative);
    if (!existsSync(source)) throw new Error(`app path missing: ${relative}`);
    cpSync(source, join(resourcesRoot, "app", relative), { recursive: true });
  }
  const productionNodeModules = resolve(projectRoot, "node_modules");
  const productionDist = resolve(projectRoot, "dist");
  if (!existsSync(productionNodeModules)) {
    throw new Error("production node_modules missing; run npm ci and npm prune --omit=dev first");
  }
  if (!existsSync(productionDist)) {
    throw new Error("production dist missing; run npm run build first");
  }
  cpSync(productionNodeModules, join(resourcesRoot, "app", "node_modules"), {
    recursive: true,
  });
  cpSync(productionDist, join(resourcesRoot, "app", "dist"), { recursive: true });
  cpSync(resolve(projectRoot, "launcher"), join(resourcesRoot, "launcher"), {
    recursive: true,
  });
}

function writeAppShell(contentsRoot, archTag) {
  const executable = join(contentsRoot, "MacOS", "REALM");
  const resources = "$HERE/../Resources";
  const script = `#!/bin/sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
exec "${resources}/runtime/node/${archTag}/bin/node" \\
  "${resources}/launcher/realm-launcher.mjs" \\
  --home "${resources}" \\
  "$@"
`;
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, script, { encoding: "utf8", mode: 0o755 });
  chmodSync(executable, 0o755);
  return executable;
}

function writeInfoPlist(contentsRoot) {
  const appVersion = inventory.app.version.split("-", 1)[0];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>REALM</string>
  <key>CFBundleExecutable</key>
  <string>REALM</string>
  <key>CFBundleIdentifier</key>
  <string>org.realm.character-runtime</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>REALM</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${appVersion}</string>
  <key>CFBundleVersion</key>
  <string>${appVersion}</string>
  <key>LSBackgroundOnly</key>
  <false/>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
</dict>
</plist>
`;
  writeFileSync(join(contentsRoot, "Info.plist"), plist, "utf8");
}

function writeNotices(resourcesRoot, archTag) {
  const notice = [
    "REALM unsigned preview bundle",
    `Application: REALM ${inventory.app.version} (${archTag})`,
    `Node.js ${inventory.node.version} (${inventory.node.license})`,
    `PostgreSQL ${inventory.postgresql.version} (${inventory.postgresql.license})`,
    `pgvector ${inventory.pgvector.tag} (${inventory.pgvector.license})`,
    "",
    "Runtime sources and hashes are recorded in installer/macos/inventory.json.",
    "No model credentials are included in this bundle.",
    "",
  ].join("\n");
  writeFileSync(join(resourcesRoot, "NOTICE.txt"), notice, "utf8");

  const thirdParty = [
    "REALM third-party runtime inventory",
    "",
    `Node.js ${inventory.node.version}: ${inventory.node.license}`,
    `PostgreSQL ${inventory.postgresql.version}: ${inventory.postgresql.license}`,
    "OpenSSL 3 (runner-provided openssl@3; Apache License 2.0)",
    `pgvector ${inventory.pgvector.tag}: ${inventory.pgvector.license}`,
    "npm production dependencies: see app/package.json and the CI-generated SBOM.",
    "",
  ].join("\n");
  writeFileSync(join(resourcesRoot, "THIRDPARTY-LICENSES.txt"), thirdParty, "utf8");
}

export function assembleBundle({ workDirectory, archTag }) {
  validateArchTag(archTag);
  const work = resolve(workDirectory);
  const bundleRoot = join(work, "REALM.app");
  const contentsRoot = join(bundleRoot, "Contents");
  const resourcesRoot = join(contentsRoot, "Resources");
  rmSync(bundleRoot, { recursive: true, force: true });
  mkdirSync(resourcesRoot, { recursive: true });

  const nodeArtifact = inventory.node.artifacts[archTag];
  const nodeArchive = join(work, `node-v${inventory.node.version}-${archTag}.tar.gz`);
  download(nodeArtifact.url, nodeArchive);
  verifyHash(nodeArchive, nodeArtifact.sha256, `node ${archTag}`);
  execFileSync("tar", ["-xzf", nodeArchive, "-C", work], { stdio: "inherit" });
  const nodeRoot = join(work, `node-v${inventory.node.version}-${archTag}`);
  const nodeBinary = join(nodeRoot, "bin", "node");
  if (!existsSync(nodeBinary)) throw new Error(`bundled Node binary missing: ${nodeBinary}`);
  cpSync(nodeRoot, join(resourcesRoot, "runtime", "node", archTag), {
    recursive: true,
  });

  const workPgRoot = join(work, "pgsql", archTag);
  const fallbackPgRoot = join(work, "pgsql");
  const pgRoot = existsSync(join(workPgRoot, "bin", "postgres"))
    ? workPgRoot
    : fallbackPgRoot;
  for (const relative of ["bin/postgres", "bin/initdb", "bin/pg_ctl", "lib", "share"]) {
    if (!existsSync(join(pgRoot, relative))) {
      throw new Error(`bundled PostgreSQL path missing: ${join(pgRoot, relative)}`);
    }
  }
  cpSync(pgRoot, join(resourcesRoot, "pgsql", archTag), { recursive: true });

  copyAppTree(resourcesRoot);
  writeInfoPlist(contentsRoot);
  writeAppShell(contentsRoot, archTag);
  writeNotices(resourcesRoot, archTag);

  return bundleRoot;
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const workDirectory = process.argv[2]
    ?? resolve(projectRoot, ".public-release", "macos");
  const archTag = process.argv[3]
    ?? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64");
  try {
    const bundleRoot = assembleBundle({ workDirectory, archTag });
    console.log(`bundle assembled at ${bundleRoot}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
