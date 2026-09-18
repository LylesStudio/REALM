import assert from "node:assert/strict";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildDatabaseEnvironment,
  chooseDatabasePlan,
  chooseDockerPort,
  chooseWebPort,
  mergeEnvText,
  parseNodeVersion,
  versionAtLeast,
} from "../scripts/setup-web.mjs";

 test("Node version gate accepts 22.13 and rejects older versions", () => {
  assert.deepEqual(parseNodeVersion("v22.13.0"), [22, 13, 0]);
  assert.equal(versionAtLeast("22.13.0", [22, 13, 0]), true);
  assert.equal(versionAtLeast("22.12.9", [22, 13, 0]), false);
  assert.equal(versionAtLeast("21.99.0", [22, 13, 0]), false);
});

test("database plan prefers an already complete local toolchain", () => {
  assert.deepEqual(
    chooseDatabasePlan({ platform: "darwin", localPostgresBin: "/brew/bin", localPgVector: true, dockerReady: true }),
    { mode: "local", pgBin: "/brew/bin", install: [] },
  );
});

test("database plan falls back to Docker when local pgvector is missing", () => {
  assert.deepEqual(
    chooseDatabasePlan({ platform: "win32", localPostgresBin: null, localPgVector: false, dockerReady: true }),
    { mode: "docker", pgBin: null, install: [] },
  );
});

test("macOS plan offers Homebrew install and Windows plan offers Docker Desktop", () => {
  assert.equal(
    chooseDatabasePlan({ platform: "darwin", localPostgresBin: null, localPgVector: false, dockerReady: false, brew: true }).install[0].command,
    "brew",
  );
  assert.equal(
    chooseDatabasePlan({ platform: "win32", localPostgresBin: null, localPgVector: false, dockerReady: false, winget: true }).install[0].command,
    "winget",
  );
});

test("Docker environment is loopback-only and has no password in URLs", () => {
  const env = buildDatabaseEnvironment("docker", { database: "realm_local", port: 55432 });
  assert.equal(env.REALM_POSTGRES_MODE, "docker");
  assert.equal(env.REALM_POSTGRES_DOCKER_IMAGE, "pgvector/pgvector:pg17");
  assert.equal(env.REALM_POSTGRES_DOCKER_NAME, "realm-postgres");
  for (const key of ["DATABASE_URL", "REALM_RUNTIME_DATABASE_URL", "REALM_TRANSFER_DATABASE_URL"]) {
    const url = new URL(env[key]);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.port, "55432");
    assert.equal(url.password, "");
  }
});

test("Docker port selection skips an occupied loopback port", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const occupied = server.address().port;
  try {
    assert.equal(await chooseDockerPort(occupied), occupied + 10);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Web port selection skips an occupied port by one", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const occupied = server.address().port;
  try {
    assert.equal(await chooseWebPort(occupied), occupied + 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("mergeEnvText preserves comments and replaces one key without duplicates", () => {
  const merged = mergeEnvText("# keep\nPORT=9999\n", { PORT: "10009", HOST_BIND: "127.0.0.1" });
  assert.match(merged, /^# keep/m);
  assert.equal((merged.match(/^PORT=/gm) ?? []).length, 1);
  assert.match(merged, /^PORT=10009$/m);
  assert.match(merged, /^HOST_BIND=127\.0\.0\.1$/m);
});

test("Node-less wrappers offer explicit package-manager installation paths", () => {
  const unix = readFileSync(new URL("../scripts/setup-web.sh", import.meta.url), "utf8");
  const windows = readFileSync(new URL("../scripts/setup-web.ps1", import.meta.url), "utf8");
  assert.match(unix, /brew install node@22/);
  assert.match(unix, /setup-web\.mjs/);
  assert.match(windows, /OpenJS\.NodeJS\.LTS/);
  assert.match(windows, /setup-web\.mjs/);
});

test("local postgres has an explicit Docker mode with pinned pgvector image and loopback publish", () => {
  const source = readFileSync(new URL("../scripts/local-postgres.mjs", import.meta.url), "utf8");
  assert.match(source, /REALM_POSTGRES_MODE === "docker"/);
  assert.match(source, /pgvector\/pgvector:pg17/);
  assert.match(source, /POSTGRES_HOST_AUTH_METHOD=trust/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /unless-stopped/);
  const migration = readFileSync(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8");
  assert.match(migration, /dockerLocal/);
  assert.match(migration, /Refusing to migrate a PostgreSQL server outside loopback/);
});
