/**
 * macOS desktop distribution contract tests.
 * Static checks do not replace macOS runner or clean-Mac installation evidence.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildChildEnv,
  envHasSecretValues,
  platformTag,
  resolveDataHome,
  resolveNodeBinary,
  resolvePgBin,
} from "../launcher/realm-launcher.mjs";
import {
  PACKAGE_APP_PATHS,
  PACKAGE_EXCLUDES,
  validateArchTag,
} from "../scripts/desktop/bundle-macos.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const inventoryPath = resolve(projectRoot, "installer/macos/inventory.json");
const workflowPath = resolve(projectRoot, ".github/workflows/desktop-macos.yml");
const packageScriptPath = resolve(projectRoot, "scripts/desktop/package-macos.sh");
const postgresBuildScriptPath = resolve(
  projectRoot,
  "installer/macos/build-postgresql-and-pgvector.sh",
);
const bundleScriptPath = resolve(projectRoot, "scripts/desktop/bundle-macos.mjs");
const dmgScriptPath = resolve(projectRoot, "scripts/desktop/make-macos-dmg.mjs");
const launcherScriptPath = resolve(projectRoot, "launcher/realm-launcher.mjs");
const localPostgresScriptPath = resolve(projectRoot, "scripts/local-postgres.mjs");

test("macOS data root uses Application Support and explicit override wins", () => {
  assert.equal(
    resolveDataHome({ REALM_DATA_HOME: "/tmp/explicit-realm" }, "darwin"),
    "/tmp/explicit-realm",
  );
  assert.ok(
    resolveDataHome({}, "darwin").endsWith(join("Library", "Application Support", "REALM")),
  );
  assert.equal(platformTag("darwin", "arm64"), "darwin-arm64");
  assert.equal(platformTag("darwin", "x64"), "darwin-x64");
  assert.equal(platformTag("darwin", "ia32"), null);
  assert.equal(platformTag("linux", "x64"), "linux-x64");
});

test("macOS bundled runtime paths are architecture-specific", async () => {
  const home = await mkdtemp(join(tmpdir(), "realm-macos-paths-"));
  try {
    const nodePath = join(home, "runtime", "node", "darwin-arm64", "bin", "node");
    const pgBin = join(home, "pgsql", "darwin-arm64", "bin");
    await mkdir(join(home, "runtime", "node", "darwin-arm64", "bin"), { recursive: true });
    await mkdir(pgBin, { recursive: true });
    await writeFile(nodePath, "", { mode: 0o755 });
    await writeFile(join(pgBin, ".keep"), "", { mode: 0o600 });
    assert.equal(resolveNodeBinary(home, "darwin", "arm64"), nodePath);
    assert.equal(resolvePgBin(home, "darwin", "arm64"), pgBin);
    assert.equal(
      resolvePgBin(home, "darwin", "x64", { REALM_POSTGRES_BIN: "/custom/pg/bin" }),
      "/custom/pg/bin",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("macOS child environment keeps loopback and bundled library boundaries", () => {
  const env = buildChildEnv({
    platform: "darwin",
    dataHome: "/Users/demo/Library/Application Support/REALM",
    pgBin: "/Applications/REALM.app/Contents/Resources/pgsql/darwin-arm64/bin",
    appPort: 9999,
    pgPort: 55432,
    environment: {
      PATH: "/usr/bin",
      HOME: "/Users/demo",
      OPENAI_API_KEY: "must-not-cross",
      DATABASE_URL: "postgresql://private.example/secret",
    },
  });
  assert.equal(
    env.DYLD_LIBRARY_PATH,
    "/Applications/REALM.app/Contents/Resources/pgsql/darwin-arm64/lib",
  );
  assert.equal(env.REALM_DATA_HOME, "/Users/demo/Library/Application Support/REALM");
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("DATABASE_URL" in env && env.DATABASE_URL.includes("private.example"), false);
  for (const name of ["DATABASE_URL", "REALM_RUNTIME_DATABASE_URL", "REALM_TRANSFER_DATABASE_URL"]) {
    const url = new URL(env[name]);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.password, "");
  }
  assert.equal(envHasSecretValues(env), false);
});

test("macOS bundle allowlist and production runtime entries are present", () => {
  for (const relative of PACKAGE_APP_PATHS) {
    assert.ok(existsSync(resolve(projectRoot, relative)), `allowlist path missing: ${relative}`);
  }
  for (const entry of [".env.local", ".local", "tests", "docs", "node_modules", "dist"]) {
    assert.ok(PACKAGE_EXCLUDES.includes(entry), `exclude list missing: ${entry}`);
  }
  for (const excluded of PACKAGE_EXCLUDES) {
    assert.equal(PACKAGE_APP_PATHS.includes(excluded), false, `allowlist overlap: ${excluded}`);
  }
  assert.equal(validateArchTag("darwin-arm64"), "darwin-arm64");
  assert.equal(validateArchTag("darwin-x64"), "darwin-x64");
  assert.throws(() => validateArchTag("win-x64"), /unsupported macOS architecture/);
});

test("macOS inventory pins both Node archives, PostgreSQL source, and pgvector commit", () => {
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  for (const tag of ["darwin-arm64", "darwin-x64"]) {
    const artifact = inventory.node.artifacts[tag];
    assert.match(artifact.url, /^https:\/\//);
    assert.match(artifact.url, new RegExp(`node-v${inventory.node.version}-${tag}\\.tar\\.gz$`));
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
  }
  assert.match(inventory.postgresql.url, /^https:\/\//);
  assert.match(inventory.postgresql.sha256, /^[0-9a-f]{64}$/);
  assert.equal(inventory.postgresql.version, "17.11");
  assert.equal(inventory.pgvector.tag, "v0.8.6");
  assert.match(inventory.pgvector.commit, /^[0-9a-f]{40}$/);
  assert.doesNotMatch(JSON.stringify(inventory), /TODO|REPLACE_ME|PLACEHOLDER|CHANGEME/i);
});

test("macOS workflow delegates to the one-click pipeline for both architectures", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const pipeline = readFileSync(packageScriptPath, "utf8");
  const packageManifest = JSON.parse(readFileSync(resolve(projectRoot, "package.json"), "utf8"));
  assert.equal(packageManifest.scripts["desktop:macos:package"], "bash scripts/desktop/package-macos.sh");
  assert.notEqual(statSync(packageScriptPath).mode & 0o111, 0, "one-click script must be executable");
  for (const marker of [
    "macos-14",
    "macos-15-intel",
    "darwin-arm64",
    "darwin-x64",
    "package-macos.sh",
    "upload-artifact",
  ]) {
    assert.ok(workflow.includes(marker), `workflow missing: ${marker}`);
  }
  for (const marker of [
    "npm ci --ignore-scripts",
    "npm run build",
    "npm prune --omit=dev --ignore-scripts",
    "build-postgresql-and-pgvector.sh",
    "audit-runtime.sh",
    "bundle-macos.mjs",
    "--check",
    "make-macos-dmg.mjs",
    "npm sbom",
    "worktree add --detach",
    "fresh-data smoke launcher failed",
    "fresh-data smoke left an instance lock",
    "fresh-data smoke did not initialize PG_VERSION",
  ]) {
    assert.ok(pipeline.includes(marker), `one-click pipeline missing: ${marker}`);
  }
  assert.doesNotMatch(workflow, /secrets\./, "workflow must not read secrets");
  assert.doesNotMatch(pipeline, /secrets\./, "pipeline must not read secrets");
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.ok(
    pipeline.indexOf("npm ci --ignore-scripts")
      < pipeline.indexOf("npm run build")
      && pipeline.indexOf("npm run build")
      < pipeline.indexOf("npm prune --omit=dev --ignore-scripts")
      && pipeline.indexOf("npm prune --omit=dev --ignore-scripts")
      < pipeline.indexOf("bundle-macos.mjs")
      && pipeline.indexOf("bundle-macos.mjs")
      < pipeline.indexOf("--check")
      && pipeline.indexOf("--check")
      < pipeline.indexOf("make-macos-dmg.mjs"),
    "one-click pipeline order must be install → build → prune → bundle → smoke → DMG",
  );
});

test("macOS PostgreSQL packaging rewrites every Mach-O dependency", () => {
  const source = readFileSync(postgresBuildScriptPath, "utf8");
  assert.match(source, /WORK_DIR="\$\(cd "\$WORK_DIR" && pwd -P\)"/);
  assert.match(source, /find "\$PG_ROOT\/bin" "\$PG_ROOT\/lib" -type f/);
  assert.match(source, /install_name_tool -change "\$dependency"/);
  assert.match(source, /contrib\/pgcrypto/);
  assert.match(source, /codesign --force --sign - --timestamp=none/);
  assert.match(source, /OPENSSL_ROOT/);
  assert.match(source, /--without-openssl/);
  assert.match(source, /OPENSSL_ROOT="\$\(cd "\$OPENSSL_ROOT" && pwd -P\)"/);
  assert.match(source, /libcrypto\.3\.dylib/);
  assert.match(source, /CPPFLAGS="-I\$OPENSSL_ROOT\/include"/);
  assert.match(source, /LIBS="-lcrypto -lz"/);
  assert.match(source, /\|\*\/openssl@3\/\*\)/);
  assert.match(source, /PG_CONFIG="\$PG_ROOT\/bin\/pg_config"/);
  assert.match(source, /"\$PG_ROOT"\/bin\/\*\) runtime_rpath="@loader_path\/\.\.\/lib"/);
  assert.match(source, /"\$PG_ROOT"\/lib\/postgresql\/\*\) runtime_rpath="@loader_path\/\.\."/);
});

test("macOS app shell forwards diagnostic arguments and never stores data in the bundle", () => {
  const source = readFileSync(bundleScriptPath, "utf8");
  assert.match(source, /join\(contentsRoot, "MacOS", "REALM"\)/);
  assert.match(source, /Info\.plist/);
  assert.match(source, /\$@/);
  assert.match(source, /--home/);
  assert.match(source, /--retry-all-errors/);
  assert.match(source, /--retry-max-time/);
  const dmgScript = readFileSync(dmgScriptPath, "utf8");
  assert.match(dmgScript, /hdiutil/);
  assert.match(dmgScript, /-format.*UDZO/s);
  assert.match(source, /THIRDPARTY-LICENSES\.txt/);
  assert.match(source, /No model credentials are included/);
  assert.doesNotMatch(source, /REALM_TRANSFER_PASSWORD|OPENAI_API_KEY|DATABASE_URL=/);
});

test("macOS launcher canonicalizes symlinked paths before direct-run detection", () => {
  const source = readFileSync(launcherScriptPath, "utf8");
  assert.match(source, /realpathSync\(left\) === realpathSync\(right\)/);
  assert.match(source, /sameFile\(process\.argv\[1\], fileURLToPath\(import\.meta\.url\)\)/);
  assert.match(source, /output\.slice\(-4_000\)/);
  assert.match(source, /PostgreSQL server log:/);
});

test("local PostgreSQL startup includes the server log when pg_ctl fails", () => {
  const source = readFileSync(localPostgresScriptPath, "utf8");
  assert.match(source, /function startServer\(\)/);
  assert.match(source, /readFileSync\(logPath, "utf8"\)/);
  assert.match(source, /PostgreSQL server log:/);
});

test("local PostgreSQL shortens overlong macOS Unix socket paths", () => {
  const source = readFileSync(localPostgresScriptPath, "utf8");
  assert.match(source, /complete Unix socket path to 103 bytes/);
  assert.match(source, /realm-pg-\$\{port\}/);
  assert.match(source, /requestedSocketDirectory\.length \+ 1 \+ socketFileName\.length <= 103/);
  assert.match(source, /function shellQuote\(value\)/);
  assert.match(source, /-k \$\{shellQuote\(socketDirectory\)\}/);
});
