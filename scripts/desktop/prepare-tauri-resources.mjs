#!/usr/bin/env node
/**
 * Prepare the private resource tree consumed by a packaged Tauri desktop app.
 *
 * The tree is intentionally ignored by Git. It is assembled from the current
 * production build and explicitly supplied runtime binaries; no .env, database,
 * logs, provider key, or user data is copied.
 *
 * Usage:
 *   REALM_TAURI_NODE=/path/to/node \
 *   REALM_TAURI_PG_ROOT=/path/to/postgresql \
 *   REALM_TAURI_PG_LIB=/path/to/extra/libs \
 *   node scripts/desktop/prepare-tauri-resources.mjs linux
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const target = process.argv[2] ?? process.env.REALM_TAURI_TARGET ?? "linux";
const tags = {
  linux: "linux-x64",
  windows: "win-x64",
  macos: process.env.REALM_TAURI_ARCH === "x64" ? "darwin-x64" : "darwin-arm64",
};
const tag = tags[target];
if (!tag) throw new Error(`unsupported Tauri resource target: ${target}`);

const outputRoot = resolve(
  process.env.REALM_TAURI_RESOURCE_ROOT ?? join(projectRoot, ".tauri-resources", target),
);
const realmRoot = join(outputRoot, "realm");
const appRoot = join(realmRoot, "app");
const runtimeRoot = join(realmRoot, "runtime", "node", tag);
const pgOutputRoot = join(realmRoot, "pgsql", tag);

function requirePath(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
}

function copy(source, destination) {
  requirePath(source, `resource source`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: false });
}

function resolvePgRoot(input) {
  const candidates = [input, join(input, "17")];
  return candidates.find((candidate) => existsSync(join(candidate, "bin", "postgres"))) ?? null;
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(realmRoot, { recursive: true });

// Runtime app sources required by seed/migration scripts and vinext start.
for (const relative of [
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
  "package-lock.json",
  "tsconfig.json",
  "next.config.ts",
  "next-env.d.ts",
  "vite.config.ts",
  "postcss.config.mjs",
]) {
  copy(resolve(projectRoot, relative), join(appRoot, relative));
}
requirePath(resolve(projectRoot, "dist"), "production dist (run npm run build first)");
requirePath(resolve(projectRoot, "node_modules/vinext"), "production vinext dependency");
copy(resolve(projectRoot, "dist"), join(appRoot, "dist"));
copy(resolve(projectRoot, "node_modules"), join(appRoot, "node_modules"));
copy(resolve(projectRoot, "launcher"), join(realmRoot, "launcher"));

// Drop dev-only packages inside the staging tree, never in the working tree.
// This keeps the installed bundle smaller and prevents test tooling from
// becoming part of the desktop runtime.
const prune = spawnSync("npm", ["prune", "--omit=dev", "--ignore-scripts", "--prefix", appRoot], {
  cwd: projectRoot,
  stdio: "inherit",
});
if (prune.status !== 0) {
  throw new Error(`npm prune for Tauri resources failed with exit ${prune.status ?? "null"}`);
}

// Bundled Node is required for a zero-Node desktop install. The caller chooses
// the audited target runtime; defaulting to the current Node is explicit and
// useful for local Linux preview builds.
const nodeSource = resolve(process.env.REALM_TAURI_NODE ?? process.execPath);
requirePath(nodeSource, "REALM_TAURI_NODE");
const nodeDestination = target === "windows"
  ? join(runtimeRoot, "node.exe")
  : join(runtimeRoot, "bin", "node");
copy(nodeSource, nodeDestination);

// PostgreSQL root may be either <root> or <root>/17. Preserve bin/lib/share
// under the layout expected by launcher/realm-launcher.mjs.
const requestedPgRoot = resolve(
  process.env.REALM_TAURI_PG_ROOT ?? join(homedir(), ".local", "realm-pgsql"),
);
const pgRoot = resolvePgRoot(requestedPgRoot);
if (!pgRoot) {
  throw new Error(
    `REALM_TAURI_PG_ROOT must contain bin/postgres (or 17/bin/postgres): ${requestedPgRoot}`,
  );
}
for (const relative of ["bin", "lib"]) {
  copy(join(pgRoot, relative), join(pgOutputRoot, relative));
}
const shareCandidates = [
  join(pgRoot, "share"),
  join(dirname(pgRoot), "share"),
];
const shareRoot = shareCandidates.find((candidate) => existsSync(candidate));
if (!shareRoot) throw new Error(`PostgreSQL share directory is missing near: ${pgRoot}`);
copy(shareRoot, join(pgOutputRoot, "share"));

const extraLib = process.env.REALM_TAURI_PG_LIB
  ? resolve(process.env.REALM_TAURI_PG_LIB)
  : join(dirname(pgRoot), "lib-only");
if (existsSync(extraLib)) copy(extraLib, join(pgOutputRoot, "lib"));

const manifest = {
  schema: 1,
  target,
  platformTag: tag,
  nodeVersion: process.versions.node,
  app: "app",
  launcher: "launcher",
  postgres: `pgsql/${tag}`,
  generatedFrom: "working tree; no user data included",
};
writeFileSync(join(realmRoot, "resource-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
console.log(`prepared Tauri ${target} resources at ${outputRoot}`);
