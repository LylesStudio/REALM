import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function readProjectFile(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const runner = readProjectFile("scripts/postgres-migrate.mjs");
const lifecycle = readProjectFile("scripts/local-postgres.mjs");

test("migration connections cannot override the validated loopback endpoint", () => {
  assert.match(runner, /databaseUrl\.searchParams/);
  assert.match(runner, /query parameters are disabled/);
  assert.match(runner, /host: hostname/);
  assert.match(runner, /ssl: false/);
  assert.doesNotMatch(runner, /new pg\.Client\(\{ connectionString \}\)/);
  assert.ok(
    runner.indexOf("inet_server_addr()") <
      runner.indexOf("CREATE TABLE IF NOT EXISTS realm_schema_migrations"),
  );
});

test("each migration and its ledger receipt share one locked transaction", () => {
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /await client\.query\("BEGIN"\)/);
  assert.match(runner, /await client\.query\(sql\)/);
  assert.match(runner, /INSERT INTO realm_schema_migrations/);
  assert.match(runner, /await client\.query\("COMMIT"\)/);
  assert.match(runner, /await client\.query\("ROLLBACK"\)/);
});

test("only the known 0030 checkpoint checksum has a compatibility exception", () => {
  assert.match(runner, /LEGACY_MIGRATION_CHECKSUMS/);
  assert.match(runner, /0030_character_instance_state\.sql/);
  assert.match(
    runner,
    /a36800b96089a0742f47f1415fd2f202607d6e260f3f65ee11e5d9f0bc780837/,
  );
  assert.match(
    runner,
    /1d8cbb9a63de8f1570c20430604a02f45efb5b560a28e1f2e5784a2a9d5ec56c/,
  );
  assert.match(runner, /0035_keen_insight_concrete_discovery\.sql/);
  assert.match(
    runner,
    /89e694af2c732a27f3e31c7aafcebc8efc4586094c686a6cc0e4576c4deba361/,
  );
  assert.match(runner, /legacyChecksums\.current !== checksum/);
  assert.match(runner, /Applied migration was modified/);
});

test("local lifecycle checks both project ownership and socket readiness", () => {
  assert.match(lifecycle, /pg_ctl/);
  assert.match(lifecycle, /pg_isready/);
  assert.match(lifecycle, /127\.0\.0\.1/);
  assert.match(lifecycle, /outside this project cluster/);
});
