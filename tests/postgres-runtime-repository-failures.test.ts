import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  RuntimeConcurrencyError,
  executeTurn,
  type RuntimeCommand,
  type RuntimeRepository,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/public.ts";

type CommandPayload = { mode: "valid" | "invalid-observer"; text: string };
type PlanBody = { objective: string };
type CandidateBody = { text: string };
type ValidationBody = { accepted: boolean };
type EventPayload = { content: string };
type OutboxPayload = { eventId: string };
type Repository = RuntimeRepository<
  CommandPayload,
  PlanBody,
  CandidateBody,
  ValidationBody,
  EventPayload,
  OutboxPayload
>;

const adminConnectionString = process.env.DATABASE_URL;

test(
  "PostgreSQL recovery fences preserve atomic state under loss, stale writers, mapping failure and Outbox retries",
  { skip: !adminConnectionString },
  async (t) => {
    const database = await createTemporaryDatabase(adminConnectionString!);
    t.after(database.dispose);
    const { pool, workspaceId, ids } = database;

    let sequence = 0;
    const baseRepository: Repository = createPostgresRuntimeRepository({
      pool,
      workspaceId,
      mapFormalEvent({ draft, run, worldCursor }) {
        return {
          sceneId: ids.scene,
          visibilityPolicyId: ids.visibility,
          eventKind: "utterance.committed",
          content: draft.payload.content,
          observations: [
            {
              observationId: `${draft.eventId}-observation`,
              observerCharacterInstanceId:
                run.command.payload.mode === "invalid-observer"
                  ? "unknown-character-instance"
                  : ids.instance,
              dedupeKey: `${draft.eventId}:direct`,
              kind: "direct",
              content: draft.payload.content,
              availableFrom: worldCursor,
            },
          ],
        };
      },
    });
    let loseReleaseResponse = true;
    const responseLossRepository: Repository = {
      ...baseRepository,
      async commitRelease(input) {
        const completed = await baseRepository.commitRelease(input);
        if (loseReleaseResponse) {
          loseReleaseResponse = false;
          throw new Error("simulated response loss after COMMIT");
        }
        return completed;
      },
    };

    const dependencies = (
      repository: Repository,
    ): TurnRuntimeDependencies<
      CommandPayload,
      PlanBody,
      CandidateBody,
      ValidationBody,
      EventPayload,
      OutboxPayload
    > => ({
      repository,
      planner: { async plan() { return { objective: "respond" }; } },
      drafter: { async draft(context) { return { text: context.command.payload.text }; } },
      validator: { async validate() { return { accepted: true }; } },
      releaseBuilder: {
        async build(context) {
          const eventId = `${context.turnId}-event`;
          return {
            formalEvents: [
              {
                eventId,
                kind: "utterance.committed",
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
      idFactory: () => `failure-runtime-${++sequence}`,
      clock: tickingClock(),
    });
    const command = (
      idempotencyKey: string,
      expectedRecordVersion: number,
      mode: CommandPayload["mode"] = "valid",
    ): RuntimeCommand<CommandPayload> => ({
      commandType: "player.utterance",
      recordId: ids.record,
      expectedRecordVersion,
      idempotencyKey,
      actorId: null,
      payload: { mode, text: `message:${idempotencyKey}` },
    });

    // The fixture includes one legacy Event with no Turn. It is canonical
    // database history but outside this RuntimeRepository projection.
    assert.deepEqual(await baseRepository.listCommittedEvents(ids.record), []);

    const completedAfterLostResponse = await executeTurn(
      command("response-loss", 1),
      dependencies(responseLossRepository),
    );
    assert.equal(completedAfterLostResponse.state, "completed");
    assert.equal(completedAfterLostResponse.failures.length, 0);
    assert.equal(completedAfterLostResponse.release?.recordVersion, 2);
    assert.equal((await baseRepository.listCommittedEvents(ids.record)).length, 1);

    const beforeRejectedWrites = await counts(pool, workspaceId, ids.record);
    assert.deepEqual(beforeRejectedWrites, {
      events: 2,
      observations: 1,
      outbox: 1,
      version: 2,
      nextOrdinal: 2,
    });

    const stale = await executeTurn(
      command("stale-writer", 1),
      dependencies(baseRepository),
    );
    assert.equal(stale.state, "failed");
    assert.equal(stale.currentFailure?.code, "RECORD_VERSION_CONFLICT");
    assert.deepEqual(
      await counts(pool, workspaceId, ids.record),
      beforeRejectedWrites,
    );

    const invalidObservation = await executeTurn(
      command("invalid-observer", 2, "invalid-observer"),
      dependencies(baseRepository),
    );
    assert.equal(invalidObservation.state, "failed");
    assert.equal(invalidObservation.currentFailure?.code, "TURN_STEP_FAILED");
    assert.deepEqual(
      await counts(pool, workspaceId, ids.record),
      beforeRejectedWrites,
      "Event insertion, Observation failure, heads and Outbox must roll back together",
    );

    const [pending] = await baseRepository.listOutboxMessages();
    assert.ok(pending);
    const firstClaim = await baseRepository.claimOutbox({
      messageId: pending.messageId,
      expectedRevision: pending.revision,
      leaseOwner: "projector-a",
      leaseExpiresAt: "2026-08-13T08:00:20.000Z",
      now: "2026-08-13T08:00:00.000Z",
    });
    const retryable = await baseRepository.settleOutbox({
      messageId: pending.messageId,
      expectedRevision: firstClaim.revision,
      outcome: "retryable",
      leaseOwner: "projector-a",
      now: "2026-08-13T08:00:01.000Z",
      retryAt: "2026-08-13T08:01:00.000Z",
      failure: {
        code: "PROJECTOR_BUSY",
        message: "The local projector is busy.",
        occurredAt: "2026-08-13T08:00:01.000Z",
      },
    });
    await assert.rejects(
      baseRepository.claimOutbox({
        messageId: pending.messageId,
        expectedRevision: retryable.revision,
        leaseOwner: "projector-early",
        leaseExpiresAt: "2026-08-13T08:00:50.000Z",
        now: "2026-08-13T08:00:30.000Z",
      }),
      RuntimeConcurrencyError,
    );
    const reclaimed = await baseRepository.claimOutbox({
      messageId: pending.messageId,
      expectedRevision: retryable.revision,
      leaseOwner: "projector-b",
      leaseExpiresAt: "2026-08-13T08:01:20.000Z",
      now: "2026-08-13T08:01:00.000Z",
    });
    const delivered = await baseRepository.settleOutbox({
      messageId: pending.messageId,
      expectedRevision: reclaimed.revision,
      outcome: "delivered",
      leaseOwner: "projector-b",
      now: "2026-08-13T08:01:01.000Z",
    });
    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.attempts, 2);
    assert.equal(delivered.lastFailure, undefined);

    const foreign = createPostgresRuntimeRepository({
      pool,
      workspaceId: `foreign_${randomUUID()}`,
      mapFormalEvent() { throw new Error("not reached"); },
    });
    assert.equal(await foreign.loadRecordHead(ids.record), null);
    assert.deepEqual(await foreign.listCommittedEvents(ids.record), []);
    assert.deepEqual(await foreign.listOutboxMessages(), []);
  },
);

function tickingClock() {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 13, 7, 0, second++)).toISOString();
}

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  return url;
}

function quoteDatabase(value: string): string {
  if (!/^realm_repository_failure_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}

async function createTemporaryDatabase(connectionString: string) {
  const adminUrl = requireLoopbackUrl(connectionString);
  const name = `realm_repository_failure_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteDatabase(name)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${name}`;
  const owner = new pg.Client({ connectionString: ownerUrl.href });
  await owner.connect();
  for (const filename of [
    "0001_runtime_contract.sql",
    "0002_runtime_contract_hardening.sql",
    "0003_runtime_repository.sql",
  ]) {
    const sql = await readFile(
      new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
      "utf8",
    );
    await owner.query("BEGIN");
    try {
      await owner.query(sql);
      await owner.query("COMMIT");
    } catch (error) {
      await owner.query("ROLLBACK");
      throw error;
    }
  }

  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const pool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
  const identity = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(`
    SELECT current_user, role.rolsuper, role.rolbypassrls
    FROM pg_roles AS role WHERE role.rolname = current_user
  `);
  assert.deepEqual(identity.rows[0], {
    current_user: "realm_runtime",
    rolsuper: false,
    rolbypassrls: false,
  });

  const workspaceId = `workspace_${randomUUID()}`;
  const ids = {
    world: `world_${randomUUID()}`,
    worldline: `worldline_${randomUUID()}`,
    story: `story_${randomUUID()}`,
    record: `record_${randomUUID()}`,
    scene: `scene_${randomUUID()}`,
    definition: `definition_${randomUUID()}`,
    continuity: `continuity_${randomUUID()}`,
    instance: `instance_${randomUUID()}`,
    visibility: `visibility_${randomUUID()}`,
    legacyEvent: `legacy_${randomUUID()}`,
  };
  await seed(pool, workspaceId, ids);

  return {
    pool,
    workspaceId,
    ids,
    async dispose() {
      await pool.end();
      await owner.end();
      await maintenance.query(`DROP DATABASE ${quoteDatabase(name)} WITH (FORCE)`);
      await maintenance.end();
    },
  };
}

async function workspaceTransaction<T>(
  pool: pg.Pool,
  workspaceId: string,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
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

async function counts(pool: pg.Pool, workspaceId: string, recordId: string) {
  return workspaceTransaction(pool, workspaceId, async (client) => {
    const result = await client.query(`
      SELECT
        (SELECT count(*)::int FROM events WHERE record_id = $1) AS events,
        (SELECT count(*)::int FROM observations WHERE record_id = $1) AS observations,
        (SELECT count(*)::int FROM outbox WHERE record_id = $1) AS outbox,
        head.record_version AS version,
        head.next_record_ordinal AS "nextOrdinal"
      FROM record_heads AS head
      WHERE head.record_id = $1
    `, [recordId]);
    const row = result.rows[0]!;
    return {
      events: row.events,
      observations: row.observations,
      outbox: row.outbox,
      version: Number(row.version),
      nextOrdinal: Number(row.nextOrdinal),
    };
  });
}

async function seed(
  pool: pg.Pool,
  workspaceId: string,
  ids: Record<string, string>,
) {
  await workspaceTransaction(pool, workspaceId, async (client) => {
    await client.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Failure Test')", [workspaceId]);
    await client.query("INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ($1, $2, 'World', 'calendar')", [workspaceId, ids.world]);
    await client.query("INSERT INTO worldlines (workspace_id, world_id, id, label, head_tick, head_ordinal) VALUES ($1, $2, $3, 'Origin', 100, 0)", [workspaceId, ids.world, ids.worldline]);
    await client.query("INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, 'Story', 0, 0)", [workspaceId, ids.world, ids.worldline, ids.story]);
    await client.query("INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Record', 0, 0)", [workspaceId, ids.world, ids.worldline, ids.story, ids.record]);
    await client.query("INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Scene', 0, 0)", [workspaceId, ids.world, ids.worldline, ids.record, ids.scene]);
    await client.query("INSERT INTO character_definitions (workspace_id, world_id, id, display_name) VALUES ($1, $2, $3, 'Witness')", [workspaceId, ids.world, ids.definition]);
    await client.query("INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, born_tick, born_ordinal) VALUES ($1, $2, $3, $4, $5, 'witness', 0, 0)", [workspaceId, ids.world, ids.worldline, ids.definition, ids.continuity]);
    await client.query("INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal) VALUES ($1, $2, $3, $4, $5, $6, 'ai', 0, 0, 0, 0)", [workspaceId, ids.world, ids.worldline, ids.record, ids.continuity, ids.instance]);
    await client.query("INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_kind) VALUES ($1, $2, $3, $4, $5, 'public', 'public')", [workspaceId, ids.world, ids.worldline, ids.record, ids.visibility]);
    await client.query(`
      INSERT INTO events (
        workspace_id, world_id, worldline_id, record_id, scene_id, id,
        record_version, record_ordinal, batch_index, event_kind,
        payload, visibility_policy_id, world_tick, world_ordinal,
        calendar_id, turn_run_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 1, 0, 0, 'narration.committed',
        '{}'::jsonb, $7, 99, 0, 'calendar', NULL
      )
    `, [workspaceId, ids.world, ids.worldline, ids.record, ids.scene, ids.legacyEvent, ids.visibility]);
    await client.query("INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal, last_event_id, last_world_tick, last_world_ordinal) VALUES ($1, $2, $3, $4, 1, 1, $5, 99, 0)", [workspaceId, ids.world, ids.worldline, ids.record, ids.legacyEvent]);
  });
}
