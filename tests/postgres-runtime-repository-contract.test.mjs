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

const migration = readProjectFile(
  "database/postgres/migrations/0003_runtime_repository.sql",
);
const securityMigration = readProjectFile(
  "database/postgres/migrations/0004_runtime_security_hardening.sql",
);
const adapter = readProjectFile("database/postgres/runtime-repository.ts");
const canonicalMigration = migration.toLowerCase().replace(/\s+/g, " ");
const canonicalSecurityMigration = securityMigration
  .toLowerCase()
  .replace(/\s+/g, " ");

test("runtime repository migration persists application revisions and full checkpoints", () => {
  assert.match(canonicalMigration, /add column if not exists revision bigint not null default 0/);
  assert.match(canonicalMigration, /add column if not exists run_checkpoint jsonb not null/);
  assert.match(canonicalMigration, /add column if not exists failure_history jsonb not null/);
  assert.match(canonicalMigration, /add column if not exists transition_history jsonb not null/);
  assert.match(canonicalMigration, /add column if not exists release_receipt jsonb/);
  assert.match(canonicalMigration, /turn_runs_revision_check check \(revision >= 0\)/);
  assert.match(
    canonicalMigration,
    /cannot upgrade non-empty legacy turn_runs/,
  );
  assert.match(
    canonicalMigration,
    /add column if not exists run_checkpoint jsonb not null,/,
  );
  assert.doesNotMatch(
    canonicalMigration,
    /run_checkpoint jsonb not null default/,
  );
  assert.match(canonicalMigration, /run_checkpoint \? 'turnid'/);
  assert.match(canonicalMigration, /alter column run_checkpoint drop default/);
  assert.doesNotMatch(adapter, /\bxmin\b/i);
});

test("release and Outbox CHECK constraints reject partial NULL shapes", () => {
  assert.match(
    canonicalMigration,
    /release_receipt is not null and release_fingerprint is not null and length\(btrim\(release_fingerprint\)\) > 0/,
  );
  assert.match(
    canonicalMigration,
    /last_error_code is not null and last_error_message is not null and last_error_at is not null and length\(btrim\(last_error_code\)\) > 0 and length\(btrim\(last_error_message\)\) > 0/,
  );
  assert.match(
    canonicalMigration,
    /when state = 'dispatching'.*then 'delivering'.*when state = 'dispatching' then 'retryable'/,
  );
  assert.match(
    canonicalMigration,
    /when state = 'published' then 'delivered'/,
  );
  assert.match(
    canonicalMigration,
    /when state = 'dead_letter' then 'failed'/,
  );
  assert.match(
    canonicalMigration,
    /state in \('pending', 'delivering', 'retryable', 'delivered', 'failed'\)/,
  );
  assert.doesNotMatch(
    canonicalMigration.match(/add constraint outbox_state_check check \((.*?)\);/)?.[1] ?? "",
    /dispatching|published|dead_letter/,
  );
});

test("Scene visibility policies are bound to the committed Event Scene", () => {
  assert.match(
    canonicalSecurityMigration,
    /policy\.policy_kind = 'scene'/,
  );
  assert.match(
    canonicalSecurityMigration,
    /policy\.scene_id is distinct from event\.scene_id/,
  );
  assert.match(
    canonicalSecurityMigration,
    /policy_scene_id is distinct from new\.scene_id/,
  );
  assert.match(
    canonicalSecurityMigration,
    /create trigger events_scene_visibility_guard before insert on events/,
  );
});

test("realm_runtime is reconciled to adapter-only append and head privileges", () => {
  assert.match(
    canonicalSecurityMigration,
    /revoke all privileges on workspaces, worlds, worldlines, stories, records, scenes/,
  );
  assert.match(
    canonicalSecurityMigration,
    /from realm_runtime/,
  );
  assert.match(
    canonicalSecurityMigration,
    /grant insert \(.*\) on events to realm_runtime/,
  );
  assert.match(
    canonicalSecurityMigration,
    /grant insert \(.*\) on observations to realm_runtime/,
  );
  assert.match(
    canonicalSecurityMigration,
    /grant update \( record_version, next_record_ordinal, last_event_id, last_world_tick, last_world_ordinal, updated_at \) on record_heads to realm_runtime/,
  );
  assert.match(
    canonicalSecurityMigration,
    /grant select on worlds, worldlines, stories, records, scenes, character_definitions, character_continuities, character_instances, player_world_memberships, participants, visibility_policies, visibility_policy_audiences, command_inbox, turn_runs, record_heads, events, outbox to realm_runtime/,
  );
  assert.doesNotMatch(canonicalSecurityMigration, /grant delete .*realm_runtime/);
  assert.doesNotMatch(
    canonicalSecurityMigration,
    /grant (?:select|insert|update|delete).* on workspaces to realm_runtime/,
  );
});

test("every repository operation is workspace-scoped inside a transaction", () => {
  assert.match(adapter, /await client\.query\("BEGIN"\)/);
  assert.match(adapter, /SELECT set_config\('realm\.workspace_id', \$1, true\)/);
  assert.match(adapter, /await client\.query\("COMMIT"\)/);
  assert.match(adapter, /await client\.query\("ROLLBACK"\)/);
  assert.match(adapter, /WHERE workspace_id = \$1/g);
  assert.doesNotMatch(adapter, /SET LOCAL realm\.workspace_id = \$1/);
});

test("formal release uses the documented lock order and one transaction", () => {
  const headLock = adapter.indexOf("FROM record_heads");
  const worldlineLock = adapter.indexOf("FROM worldlines");
  const eventInsert = adapter.indexOf("INSERT INTO events");
  const observationInsert = adapter.indexOf("INSERT INTO observations");
  const outboxInsert = adapter.indexOf("INSERT INTO outbox");
  const completion = adapter.indexOf("run.state = \"completed\"");

  assert.ok(headLock >= 0 && worldlineLock > headLock);
  assert.ok(eventInsert > worldlineLock);
  assert.ok(observationInsert > eventInsert);
  assert.ok(outboxInsert > observationInsert);
  assert.ok(completion > outboxInsert);
  assert.match(adapter, /FOR UPDATE/);
});

test("formal Event mapping supplies visibility, Scene, world cursor and observations", () => {
  assert.match(adapter, /mapFormalEvent/);
  assert.match(adapter, /visibilityPolicyId/);
  assert.match(adapter, /sceneId/);
  assert.match(adapter, /allocateWorldCursors/);
  assert.match(adapter, /observations\?: readonly PostgresObservationDraft\[\]/);
  assert.match(adapter, /availableFrom/);
});

test("arbitrary Runtime JsonValue payloads are stored in object envelopes", () => {
  assert.match(adapter, /const RUNTIME_PAYLOAD_KEY/);
  assert.match(
    adapter,
    /\[RUNTIME_PAYLOAD_KEY\]: input\.command\.payload/,
  );
  assert.match(adapter, /runtimeEnvelope\(item\.draft\.payload/);
  assert.match(adapter, /runtimePayload<TEvent>\(row\.payload\)/);
});

test("Runtime projections retain but ignore legacy Event and Outbox rows", () => {
  assert.match(
    adapter,
    /FROM events[\s\S]*AND turn_run_id IS NOT NULL[\s\S]*ORDER BY record_ordinal/,
  );
  assert.match(
    adapter,
    /WHERE workspace_id = \$1 AND id = \$2[\s\S]*AND turn_run_id IS NOT NULL/,
  );
  assert.match(
    adapter,
    /WHERE workspace_id = \$1[\s\S]*AND turn_run_id IS NOT NULL[\s\S]*ORDER BY id/,
  );
});
