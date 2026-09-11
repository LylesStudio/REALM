import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  executeTurn,
  type RuntimeCommand,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/public.ts";
import { createPostgresDeliveryProjectionRepository } from "../database/postgres/public.ts";

const connectionString = process.env.DATABASE_URL;

type CommandPayload = { text: string };
type PlanPayload = { objective: string };
type CandidatePayload = { text: string };
type ValidationPayload = { accepted: boolean };
type EventPayload = { content: string };
type OutboxPayload = { eventId: string };

test(
  "repository migrations reject unsafe legacy Turns, normalize Outbox, bind Scenes and preserve least-privilege operation",
  { skip: !connectionString },
  async (t) => {
    const fixture = await createFixture(connectionString!);
    t.after(fixture.dispose);
    const { owner, runtimePool, workspaceId, ids } = fixture;

    await applyMigration(owner, "0001_runtime_contract.sql");
    await applyMigration(owner, "0002_runtime_contract_hardening.sql");
    await seedLegacyFixture(owner, workspaceId, ids);

    await assert.rejects(
      applyMigration(owner, "0003_runtime_repository.sql"),
      /cannot upgrade non-empty legacy turn_runs/,
    );
    assert.equal(
      await columnExists(owner, "turn_runs", "run_checkpoint"),
      false,
      "the failed migration must roll back every schema change",
    );

    await owner.query("DELETE FROM turn_runs WHERE id = $1", [ids.legacyTurn]);
    await applyMigration(owner, "0003_runtime_repository.sql");
    await verifyTurnCheckpointContract(owner, workspaceId, ids);
    await verifyOutboxNormalization(owner, workspaceId);

    await insertMismatchedSceneEvent(owner, workspaceId, ids, "preflight");
    await assert.rejects(
      applyMigration(owner, "0004_runtime_security_hardening.sql"),
      /visibility policy for another Scene/,
    );
    await owner.query("ALTER TABLE events DISABLE TRIGGER events_append_only_guard");
    await owner.query("DELETE FROM events WHERE id = $1", [ids.mismatchPreflight]);
    await owner.query("ALTER TABLE events ENABLE TRIGGER events_append_only_guard");
    await applyMigration(owner, "0004_runtime_security_hardening.sql");

    // Every migration remains safe to apply directly again after convergence.
    await applyMigration(owner, "0003_runtime_repository.sql");
    await applyMigration(owner, "0004_runtime_security_hardening.sql");

    // Batch Q: delivery projection resolves the owner's ui_language via
    // accounts (0012) — the verify paths below run those projections, so the
    // accounts table and its least-privilege grants must exist first.
    await applyMigration(owner, "0012_accounts.sql");
    await applyMigration(owner, "0013_membership_insert_grant.sql");
    await applyMigration(owner, "0014_scene_crystallization_grants.sql");
    await applyMigration(owner, "0015_account_ui_language.sql");
    // v37：gateRecordActive 的 records FOR UPDATE 依赖 0037 列级 UPDATE 授权（Z14）。
    await applyMigration(owner, "0037_record_archive_grant.sql");

    await verifyRuntimePrivileges(owner);
    await verifySceneGuard(runtimePool, workspaceId, ids);
    await verifyLegacyOutboxProjection(runtimePool, workspaceId);
    await verifyDeliveryProjection(runtimePool, workspaceId, ids);
    await verifyRepositoryStillOperates(runtimePool, workspaceId, ids);
  },
);

async function createFixture(databaseUrl: string) {
  const source = new URL(databaseUrl);
  const host = source.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("Migration hardening tests require loopback PostgreSQL.");
  }
  const databaseName = `realm_migration_hardening_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(source);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteDatabase(databaseName)}`);

  const ownerUrl = new URL(source);
  ownerUrl.pathname = `/${databaseName}`;
  const owner = new pg.Client({ connectionString: ownerUrl.href });
  await owner.connect();

  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });
  const workspaceId = `workspace_${randomUUID()}`;
  const ids = {
    world: `world_${randomUUID()}`,
    worldline: `worldline_${randomUUID()}`,
    story: `story_${randomUUID()}`,
    record: `record_${randomUUID()}`,
    sceneA: `scene_a_${randomUUID()}`,
    sceneB: `scene_b_${randomUUID()}`,
    policySceneA: `policy_scene_a_${randomUUID()}`,
    definition: `definition_${randomUUID()}`,
    continuity: `continuity_${randomUUID()}`,
    instance: `instance_${randomUUID()}`,
    principal: `principal_${randomUUID()}`,
    participant: `participant_${randomUUID()}`,
    legacyCommand: `legacy_command_${randomUUID()}`,
    legacyTurn: `legacy_turn_${randomUUID()}`,
    mismatchPreflight: `mismatch_preflight_${randomUUID()}`,
  };

  return {
    owner,
    runtimePool,
    workspaceId,
    ids,
    async dispose() {
      await runtimePool.end();
      await owner.end();
      await maintenance.query(
        `DROP DATABASE ${quoteDatabase(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    },
  };
}

async function applyMigration(client: pg.Client, filename: string) {
  const sql = await readFile(
    new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
    "utf8",
  );
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedLegacyFixture(
  owner: pg.Client,
  workspaceId: string,
  ids: Record<string, string>,
) {
  await owner.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Migration Test')", [workspaceId]);
  await owner.query(
    "INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ($1, $2, 'World', 'calendar')",
    [workspaceId, ids.world],
  );
  await owner.query(
    "INSERT INTO worldlines (workspace_id, world_id, id, label, head_tick, head_ordinal) VALUES ($1, $2, $3, 'Origin', 100, 0)",
    [workspaceId, ids.world, ids.worldline],
  );
  await owner.query(
    "INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, 'Story', 0, 0)",
    [workspaceId, ids.world, ids.worldline, ids.story],
  );
  await owner.query(
    "INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Record', 0, 0)",
    [workspaceId, ids.world, ids.worldline, ids.story, ids.record],
  );
  for (const [sceneId, ordinal] of [[ids.sceneA, 0], [ids.sceneB, 1]] as const) {
    await owner.query(
      "INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Scene', 0, $6)",
      [workspaceId, ids.world, ids.worldline, ids.record, sceneId, ordinal],
    );
  }
  await owner.query(
    "INSERT INTO character_definitions (workspace_id, world_id, id, display_name) VALUES ($1, $2, $3, 'Witness')",
    [workspaceId, ids.world, ids.definition],
  );
  await owner.query(
    "INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, born_tick, born_ordinal) VALUES ($1, $2, $3, $4, $5, 'witness', 0, 0)",
    [workspaceId, ids.world, ids.worldline, ids.definition, ids.continuity],
  );
  await owner.query(
    "INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal) VALUES ($1, $2, $3, $4, $5, $6, 'ai', 0, 0, 0, 0)",
    [workspaceId, ids.world, ids.worldline, ids.record, ids.continuity, ids.instance],
  );
  await owner.query(
    "INSERT INTO player_world_memberships (workspace_id, world_id, principal_id, role, omniscient_player_character, can_view_dynamic_knowledge) VALUES ($1, $2, $3, 'owner', true, true)",
    [workspaceId, ids.world, ids.principal],
  );
  await owner.query(
    "INSERT INTO participants (workspace_id, world_id, worldline_id, record_id, id, participant_kind, character_instance_id, principal_id, controller_mode, speaking_order) VALUES ($1, $2, $3, $4, $5, 'character', $6, $7, 'human', 0)",
    [
      workspaceId,
      ids.world,
      ids.worldline,
      ids.record,
      ids.participant,
      ids.instance,
      ids.principal,
    ],
  );
  await owner.query(
    "INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_kind, scene_id) VALUES ($1, $2, $3, $4, $5, 'scene-a', 'scene', $6)",
    [workspaceId, ids.world, ids.worldline, ids.record, ids.policySceneA, ids.sceneA],
  );
  await owner.query(
    "INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id) VALUES ($1, $2, $3, $4)",
    [workspaceId, ids.world, ids.worldline, ids.record],
  );
  await owner.query(
    `INSERT INTO command_inbox (
       workspace_id, world_id, worldline_id, record_id, id,
       idempotency_key, request_fingerprint, command_kind, payload,
       expected_record_version
     ) VALUES ($1, $2, $3, $4, $5, 'legacy', 'legacy', 'legacy', '{}'::jsonb, 0)`,
    [workspaceId, ids.world, ids.worldline, ids.record, ids.legacyCommand],
  );
  await owner.query(
    `INSERT INTO turn_runs (
       workspace_id, world_id, worldline_id, record_id, command_id, id
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      workspaceId,
      ids.world,
      ids.worldline,
      ids.record,
      ids.legacyCommand,
      ids.legacyTurn,
    ],
  );

  const outboxRows = [
    ["legacy-pending", "pending", null, null, null],
    ["legacy-pending-error", "pending", null, null, "PENDING_FAILED"],
    ["legacy-dispatching", "dispatching", "worker-a", "2099-01-01T00:00:00.000Z", null],
    ["legacy-dispatching-unleased", "dispatching", null, null, null],
    ["legacy-published", "published", "worker-old", "2099-01-01T00:00:00.000Z", "STALE_ERROR"],
    ["legacy-dead-letter", "dead_letter", null, null, null],
  ] as const;
  for (const [id, state, leaseOwner, leaseExpiresAt, errorCode] of outboxRows) {
    await owner.query(
      `INSERT INTO outbox (
         workspace_id, world_id, worldline_id, record_id, id,
         dedupe_key, topic, payload, state,
         lease_owner, lease_expires_at, last_error_code
       ) VALUES ($1, $2, $3, $4, $5, $5, 'legacy', '{}'::jsonb, $6, $7, $8, $9)`,
      [
        workspaceId,
        ids.world,
        ids.worldline,
        ids.record,
        id,
        state,
        leaseOwner,
        leaseExpiresAt,
        errorCode,
      ],
    );
  }
}

async function verifyTurnCheckpointContract(
  owner: pg.Client,
  workspaceId: string,
  ids: Record<string, string>,
) {
  const defaultValue = await owner.query<{ column_default: string | null }>(`
    SELECT column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'turn_runs'
      AND column_name = 'run_checkpoint'
  `);
  assert.equal(defaultValue.rows[0]?.column_default, null);
  await assert.rejects(
    owner.query(
      `INSERT INTO turn_runs (
         workspace_id, world_id, worldline_id, record_id, command_id, id,
         run_checkpoint
       ) VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`,
      [
        workspaceId,
        ids.world,
        ids.worldline,
        ids.record,
        ids.legacyCommand,
        `invalid_checkpoint_${randomUUID()}`,
      ],
    ),
    (error) => postgresCode(error) === "23514",
  );
}

async function verifyOutboxNormalization(owner: pg.Client, workspaceId: string) {
  const result = await owner.query<{
    id: string;
    state: string;
    lease_owner: string | null;
    published_at: Date | null;
    last_error_code: string | null;
    last_error_message: string | null;
    last_error_at: Date | null;
  }>(`
    SELECT id, state, lease_owner, published_at,
           last_error_code, last_error_message, last_error_at
    FROM outbox
    WHERE workspace_id = $1
    ORDER BY id
  `, [workspaceId]);
  const rows = new Map(result.rows.map((row) => [row.id, row]));

  assert.equal(rows.get("legacy-pending")?.state, "pending");
  assert.equal(rows.get("legacy-pending")?.last_error_code, null);
  assert.equal(rows.get("legacy-pending-error")?.state, "retryable");
  assert.equal(rows.get("legacy-pending-error")?.last_error_code, "PENDING_FAILED");
  assert.ok(rows.get("legacy-pending-error")?.last_error_message);
  assert.ok(rows.get("legacy-pending-error")?.last_error_at);
  assert.equal(rows.get("legacy-dispatching")?.state, "delivering");
  assert.equal(rows.get("legacy-dispatching")?.lease_owner, "worker-a");
  assert.equal(rows.get("legacy-dispatching-unleased")?.state, "retryable");
  assert.equal(rows.get("legacy-dispatching-unleased")?.lease_owner, null);
  assert.equal(rows.get("legacy-published")?.state, "delivered");
  assert.equal(rows.get("legacy-published")?.lease_owner, null);
  assert.equal(rows.get("legacy-published")?.last_error_code, null);
  assert.ok(rows.get("legacy-published")?.published_at);
  assert.equal(rows.get("legacy-dead-letter")?.state, "failed");
  assert.equal(
    rows.get("legacy-dead-letter")?.last_error_code,
    "LEGACY_OUTBOX_FAILURE",
  );

  await assert.rejects(
    owner.query(
      `INSERT INTO outbox (
         workspace_id, world_id, worldline_id, record_id, id,
         dedupe_key, topic, payload, state,
         last_error_code, last_error_message, last_error_at
       )
       SELECT workspace_id, world_id, worldline_id, id,
              'invalid-pending-failure', 'invalid-pending-failure',
              'invalid', '{}'::jsonb, 'pending',
              'ERROR', 'must not coexist with pending', CURRENT_TIMESTAMP
       FROM records WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId],
    ),
    (error) => postgresCode(error) === "23514",
  );
}

async function insertMismatchedSceneEvent(
  client: pg.Client,
  workspaceId: string,
  ids: Record<string, string>,
  suffix: string,
) {
  const eventId = suffix === "preflight"
    ? ids.mismatchPreflight
    : `mismatch_${suffix}_${randomUUID()}`;
  await client.query(
    `INSERT INTO events (
       workspace_id, world_id, worldline_id, record_id, scene_id, id,
       record_version, record_ordinal, batch_index, event_kind,
       payload, visibility_policy_id, world_tick, world_ordinal, calendar_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       99, 99, 0, 'narration.committed', '{}'::jsonb, $7, 200, 0, 'calendar'
     )`,
    [
      workspaceId,
      ids.world,
      ids.worldline,
      ids.record,
      ids.sceneB,
      eventId,
      ids.policySceneA,
    ],
  );
}

async function verifyRuntimePrivileges(owner: pg.Client) {
  const result = await owner.query<{
    workspace_select: boolean;
    workspace_insert: boolean;
    workspace_update: boolean;
    workspace_delete: boolean;
    event_select: boolean;
    event_insert_id: boolean;
    event_update_content: boolean;
    event_delete: boolean;
    observation_insert: boolean;
    observation_update: boolean;
    head_update_version: boolean;
    worldline_update_head: boolean;
    worldline_update_label: boolean;
    stories_select: boolean;
    scenes_select: boolean;
    definitions_select: boolean;
    continuities_select: boolean;
    instances_select: boolean;
    memberships_select: boolean;
    participants_select: boolean;
    observations_select: boolean;
  }>(`
    SELECT
      has_table_privilege('realm_runtime', 'workspaces', 'SELECT') AS workspace_select,
      has_table_privilege('realm_runtime', 'workspaces', 'INSERT') AS workspace_insert,
      has_table_privilege('realm_runtime', 'workspaces', 'UPDATE') AS workspace_update,
      has_table_privilege('realm_runtime', 'workspaces', 'DELETE') AS workspace_delete,
      has_table_privilege('realm_runtime', 'events', 'SELECT') AS event_select,
      has_column_privilege('realm_runtime', 'events', 'id', 'INSERT') AS event_insert_id,
      has_column_privilege('realm_runtime', 'events', 'content', 'UPDATE') AS event_update_content,
      has_table_privilege('realm_runtime', 'events', 'DELETE') AS event_delete,
      has_column_privilege('realm_runtime', 'observations', 'content', 'INSERT') AS observation_insert,
      has_column_privilege('realm_runtime', 'observations', 'content', 'UPDATE') AS observation_update,
      has_column_privilege('realm_runtime', 'record_heads', 'record_version', 'UPDATE') AS head_update_version,
      has_column_privilege('realm_runtime', 'worldlines', 'head_tick', 'UPDATE') AS worldline_update_head,
      has_column_privilege('realm_runtime', 'worldlines', 'label', 'UPDATE') AS worldline_update_label,
      has_table_privilege('realm_runtime', 'stories', 'SELECT') AS stories_select,
      has_table_privilege('realm_runtime', 'scenes', 'SELECT') AS scenes_select,
      has_table_privilege('realm_runtime', 'character_definitions', 'SELECT') AS definitions_select,
      has_table_privilege('realm_runtime', 'character_continuities', 'SELECT') AS continuities_select,
      has_table_privilege('realm_runtime', 'character_instances', 'SELECT') AS instances_select,
      has_table_privilege('realm_runtime', 'player_world_memberships', 'SELECT') AS memberships_select,
      has_table_privilege('realm_runtime', 'participants', 'SELECT') AS participants_select,
      has_table_privilege('realm_runtime', 'observations', 'SELECT') AS observations_select
  `);
  assert.deepEqual(result.rows[0], {
    workspace_select: false,
    workspace_insert: false,
    workspace_update: false,
    workspace_delete: false,
    event_select: true,
    event_insert_id: true,
    event_update_content: false,
    event_delete: false,
    observation_insert: true,
    observation_update: false,
    head_update_version: true,
    worldline_update_head: true,
    worldline_update_label: false,
    stories_select: true,
    scenes_select: true,
    definitions_select: true,
    continuities_select: true,
    instances_select: true,
    memberships_select: true,
    participants_select: true,
    observations_select: false,
  });
}

async function verifySceneGuard(
  runtimePool: pg.Pool,
  workspaceId: string,
  ids: Record<string, string>,
) {
  await assert.rejects(
    workspaceQuery(runtimePool, workspaceId, async (client) => {
      await client.query(
        `INSERT INTO events (
           workspace_id, world_id, worldline_id, record_id, scene_id, id,
           record_version, record_ordinal, batch_index, event_kind,
           payload, visibility_policy_id, world_tick, world_ordinal, calendar_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           100, 100, 0, 'narration.committed', '{}'::jsonb, $7, 201, 0, 'calendar'
         )`,
        [
          workspaceId,
          ids.world,
          ids.worldline,
          ids.record,
          ids.sceneB,
          `runtime_mismatch_${randomUUID()}`,
          ids.policySceneA,
        ],
      );
    }),
    /must belong to the Event Scene/,
  );
}

async function verifyLegacyOutboxProjection(
  runtimePool: pg.Pool,
  workspaceId: string,
) {
  const repository = createPostgresRuntimeRepository({
    pool: runtimePool,
    workspaceId,
    mapFormalEvent() {
      throw new Error("legacy Outbox projection must not map an Event");
    },
  });
  assert.deepEqual(await repository.listOutboxMessages(), []);
  assert.equal(await repository.loadOutboxMessage("legacy-pending"), null);

  const retained = await workspaceQuery(
    runtimePool,
    workspaceId,
    async (client) => {
      const result = await client.query(
        "SELECT count(*)::int AS count FROM outbox WHERE turn_run_id IS NULL",
      );
      return result.rows[0]?.count;
    },
  );
  assert.equal(retained, 6, "legacy Outbox rows remain in the compatibility plane");
}

async function verifyDeliveryProjection(
  runtimePool: pg.Pool,
  workspaceId: string,
  ids: Record<string, string>,
) {
  const repository = createPostgresDeliveryProjectionRepository(runtimePool);
  const projection = await repository.loadForPlayer({
    workspaceId,
    recordId: ids.record,
    principalId: ids.principal,
  });
  assert.ok(projection);
  assert.equal(projection.id, ids.record);
  assert.equal(projection.cast.length, 1);
  assert.equal(projection.cast[0]?.characterInstanceId, ids.instance);
  assert.deepEqual(projection.events, []);
}

async function verifyRepositoryStillOperates(
  runtimePool: pg.Pool,
  workspaceId: string,
  ids: Record<string, string>,
) {
  const repository = createPostgresRuntimeRepository<
    CommandPayload,
    PlanPayload,
    CandidatePayload,
    ValidationPayload,
    EventPayload,
    OutboxPayload
  >({
    pool: runtimePool,
    workspaceId,
    mapFormalEvent({ draft, worldCursor }) {
      return {
        sceneId: ids.sceneA,
        visibilityPolicyId: ids.policySceneA,
        eventKind: "narration.committed",
        content: draft.payload.content,
        observations: [
          {
            observationId: `${draft.eventId}-observation`,
            observerCharacterInstanceId: ids.instance,
            dedupeKey: `${draft.eventId}:direct`,
            kind: "direct",
            content: draft.payload.content,
            availableFrom: worldCursor,
          },
        ],
      };
    },
  });
  let id = 0;
  let second = 0;
  const dependencies: TurnRuntimeDependencies<
    CommandPayload,
    PlanPayload,
    CandidatePayload,
    ValidationPayload,
    EventPayload,
    OutboxPayload
  > = {
    repository,
    planner: { async plan() { return { objective: "respond" }; } },
    drafter: { async draft() { return { text: "The bell is silent." }; } },
    validator: { async validate() { return { accepted: true }; } },
    releaseBuilder: {
      async build(context) {
        const eventId = `${context.turnId}-event`;
        return {
          formalEvents: [
            {
              eventId,
              kind: "narration.committed",
              payload: { content: context.candidate.body.text },
            },
          ],
          outbox: [
            {
              messageId: `${context.turnId}-outbox`,
              dedupeKey: `${context.turnId}:projection`,
              topic: "record.event.committed",
              payload: { eventId },
            },
          ],
        };
      },
    },
    idFactory: () => `hardened-runtime-${++id}`,
    clock: () =>
      new Date(Date.UTC(2026, 7, 13, 10, 0, second++)).toISOString(),
  };
  const command: RuntimeCommand<CommandPayload> = {
    commandType: "player.utterance",
    recordId: ids.record,
    expectedRecordVersion: 0,
    idempotencyKey: "hardened-runtime-turn",
    actorId: null,
    payload: { text: "Listen." },
  };
  const completed = await executeTurn(command, dependencies);
  assert.equal(completed.state, "completed");
  assert.equal((await repository.listCommittedEvents(ids.record)).length, 1);
  const [pending] = await repository.listOutboxMessages();
  assert.ok(pending);
  const claimed = await repository.claimOutbox({
    messageId: pending.messageId,
    expectedRevision: pending.revision,
    leaseOwner: "local-projector",
    now: "2026-08-13T11:00:00.000Z",
    leaseExpiresAt: "2026-08-13T11:01:00.000Z",
  });
  const delivered = await repository.settleOutbox({
    messageId: claimed.messageId,
    expectedRevision: claimed.revision,
    outcome: "delivered",
    leaseOwner: "local-projector",
    now: "2026-08-13T11:00:30.000Z",
  });
  assert.equal(delivered.state, "delivered");
}

async function workspaceQuery<T>(
  pool: pg.Pool,
  workspaceId: string,
  operation: (client: pg.PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('realm.workspace_id', $1, true)", [workspaceId]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function columnExists(client: pg.Client, table: string, column: string) {
  const result = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
    ) AS exists
  `, [table, column]);
  return result.rows[0]?.exists ?? false;
}

function postgresCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}

function quoteDatabase(value: string) {
  if (!/^realm_migration_hardening_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database name.");
  }
  return `"${value}"`;
}
