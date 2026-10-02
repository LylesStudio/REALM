import { createHash } from "node:crypto";
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
const runtimeContractMigration = readProjectFile(
  "database/postgres/migrations/0001_runtime_contract.sql",
);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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

test("migration checksums are line-ending stable and historical exceptions stay narrow", () => {
  assert.match(runner, /LEGACY_MIGRATION_CHECKSUMS/);
  assert.match(runner, /normalizedSql\.replace\(\/\\n\/g, "\\r\\n"\)/);
  assert.match(runner, /acceptedLineEnding/);
  assert.match(runner, /acceptedHistorical/);
  assert.equal(
    sha256(runtimeContractMigration),
    "0f7245e65b776f54163f0e9cede44fe0f20df21cbb54108865f670f94265c679",
  );
  assert.equal(
    sha256(runtimeContractMigration.replace(/\n/g, "\r\n")),
    "62f4b0802be301f3fbc26c325a44564ca3298ecbb1111c616e65d1100e75d84e",
  );
  assert.match(runner, /0014_scene_crystallization_grants\.sql/);
  assert.match(
    runner,
    /d339e9d58db0e118a5361fa4c401367c7a5a4c95f349e95372962fdc5e754d46/,
  );
  assert.match(runner, /reapply: true/);
  assert.match(runner, /ledger converged to current SQL/);
  assert.match(runner, /0015_account_ui_language\.sql/);
  assert.match(
    runner,
    /68d3786e29566d8bc3810ae498f9c31a81039808e1335823f1fdd7836c70e603/,
  );
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
  assert.match(runner, /legacyChecksums\.current === checksum/);
  assert.match(runner, /Applied migration was modified/);
});

test("local lifecycle checks both project ownership and socket readiness", () => {
  assert.match(lifecycle, /pg_ctl/);
  assert.match(lifecycle, /pg_isready/);
  assert.match(lifecycle, /127\.0\.0\.1/);
  assert.match(lifecycle, /outside this project cluster/);
});
