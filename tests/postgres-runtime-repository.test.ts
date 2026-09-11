import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createCommandFingerprint,
  executeTurn,
  type JsonValue,
  type RuntimeCommand,
  type RuntimeRepository,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/public.ts";

type CommandPayload = readonly JsonValue[];
type PlanBody = { objective: string };
type CandidateBody = { text: string };
type ValidationBody = { accepted: boolean };
type EventPayload = { content: string };
type OutboxPayload = { eventId: string };

const adminConnectionString = process.env.DATABASE_URL;

test(
  "realm_runtime executes a recoverable Turn with atomic Event, Observation, heads and Outbox",
  { skip: !adminConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_repository_test_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const owner = new pg.Client({ connectionString: ownerUrl.href });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const pool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });

    t.after(async () => {
      await pool.end();
      await owner.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

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

    const identity = await pool.query<{
      current_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`
      SELECT current_user, role.rolsuper, role.rolbypassrls
      FROM pg_roles AS role
      WHERE role.rolname = current_user
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
    };
    await seedRuntimeScope(pool, workspaceId, ids);

    // Forced RLS denies a connection that has not established its Workspace.
    assert.equal(
      Number((await pool.query("SELECT count(*) AS count FROM records")).rows[0]!.count),
      0,
    );

    let sequence = 0;
    const repository: RuntimeRepository<
      CommandPayload,
      PlanBody,
      CandidateBody,
      ValidationBody,
      EventPayload,
      OutboxPayload
    > = createPostgresRuntimeRepository({
      pool,
      workspaceId,
      mapFormalEvent({ draft, worldCursor }) {
        return {
          sceneId: ids.scene,
          visibilityPolicyId: ids.visibility,
          eventKind: "utterance.committed",
          speakerName: "塞娜",
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
    const dependencies: TurnRuntimeDependencies<
      CommandPayload,
      PlanBody,
      CandidateBody,
      ValidationBody,
      EventPayload,
      OutboxPayload
    > = {
      repository,
      planner: { async plan() { return { objective: "respond" }; } },
      drafter: { async draft() { return { text: "蜡封仍有余温。" }; } },
      validator: { async validate() { return { accepted: true }; } },
      releaseBuilder: {
        async build(context) {
          const eventId = `${context.turnId}-event`;
          return {
            formalEvents: [
              { eventId, kind: "utterance.committed", payload: { content: context.candidate.body.text } },
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
      idFactory: () => `runtime-${++sequence}`,
      clock: tickingClock(),
    };
    const command: RuntimeCommand<CommandPayload> = {
      commandType: "player.utterance",
      recordId: ids.record,
      expectedRecordVersion: 0,
      idempotencyKey: "inspect-seal",
      actorId: null,
      // An array proves the adapter preserves the full JsonValue port.
      payload: ["检查蜡封", 1, true],
    };

    const completed = await executeTurn(command, dependencies);
    assert.equal(completed.state, "completed");
    assert.equal(completed.release?.recordVersion, 1);
    assert.deepEqual(await repository.loadRecordHead(ids.record), {
      recordId: ids.record,
      version: 1,
      nextOrdinal: 8,
    });
    assert.equal((await repository.listCommittedEvents(ids.record)).length, 1);
    assert.equal((await repository.listOutboxMessages()).length, 1);

    const duplicate = await executeTurn(command, dependencies);
    assert.equal(duplicate.turnId, completed.turnId);
    assert.equal((await repository.listCommittedEvents(ids.record)).length, 1);

    const committedRows = await inWorkspace(pool, workspaceId, async (client) => {
      const events = await client.query("SELECT count(*)::int AS count FROM events WHERE record_id = $1", [ids.record]);
      const observations = await client.query("SELECT count(*)::int AS count FROM observations WHERE record_id = $1", [ids.record]);
      const worldline = await client.query("SELECT head_tick, head_ordinal FROM worldlines WHERE id = $1", [ids.worldline]);
      const commandRow = await client.query("SELECT payload, state FROM command_inbox WHERE id = $1", [completed.turnId]);
      return { events, observations, worldline, commandRow };
    });
    assert.equal(committedRows.events.rows[0]!.count, 1);
    assert.equal(committedRows.observations.rows[0]!.count, 1);
    assert.deepEqual(committedRows.worldline.rows[0], {
      head_tick: "100",
      head_ordinal: "1",
    });
    assert.equal(committedRows.commandRow.rows[0]!.state, "completed");
    assert.deepEqual(
      committedRows.commandRow.rows[0]!.payload.__realmRuntimePayload,
      command.payload,
    );

    const foreignRepository = createPostgresRuntimeRepository({
      pool,
      workspaceId: `foreign_${randomUUID()}`,
      mapFormalEvent() {
        throw new Error("not reached");
      },
    });
    assert.equal(await foreignRepository.loadTurn(completed.turnId), null);
    assert.equal(await foreignRepository.loadRecordHead(ids.record), null);

    // Checkpoint reconstruction is independent of process memory.
    const reloadedRepository = createPostgresRuntimeRepository<
      CommandPayload,
      PlanBody,
      CandidateBody,
      ValidationBody,
      EventPayload,
      OutboxPayload
    >({
      pool,
      workspaceId,
      mapFormalEvent() {
        throw new Error("completed Turn must not remap events");
      },
    });
    assert.deepEqual(
      await reloadedRepository.loadTurn(completed.turnId),
      completed,
    );

    const acceptedCommand: RuntimeCommand<CommandPayload> = {
      ...command,
      expectedRecordVersion: 1,
      idempotencyKey: "recovery-checkpoint",
      payload: ["等待回应"],
    };
    const accepted = await repository.acceptCommand({
      turnId: "interrupted-turn",
      command: acceptedCommand,
      commandFingerprint: createCommandFingerprint(acceptedCommand),
      now: "2026-08-13T06:00:00.000Z",
    });
    const planning = await repository.advanceTurn({
      turnId: accepted.run.turnId,
      expectedRevision: accepted.run.revision,
      expectedState: "accepted",
      nextState: "planning",
      now: "2026-08-13T06:00:01.000Z",
    });
    assert.equal((await reloadedRepository.loadTurn(planning.turnId))?.state, "planning");
  },
);

function tickingClock() {
  let second = 0;
  return () => new Date(Date.UTC(2026, 7, 13, 5, 0, second++)).toISOString();
}

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^realm_repository_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}

async function inWorkspace<T>(
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

async function seedRuntimeScope(
  pool: pg.Pool,
  workspaceId: string,
  ids: Record<string, string>,
): Promise<void> {
  await inWorkspace(pool, workspaceId, async (client) => {
    await client.query("INSERT INTO workspaces (id, name) VALUES ($1, 'Repository Test')", [workspaceId]);
    await client.query(
      "INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ($1, $2, 'Test World', 'test-calendar')",
      [workspaceId, ids.world],
    );
    await client.query(
      "INSERT INTO worldlines (workspace_id, world_id, id, label, head_tick, head_ordinal) VALUES ($1, $2, $3, 'Origin', 100, 0)",
      [workspaceId, ids.world, ids.worldline],
    );
    await client.query(
      "INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, 'Story', 'active', 0, 0)",
      [workspaceId, ids.world, ids.worldline, ids.story],
    );
    await client.query(
      "INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Record', 'active', 0, 0)",
      [workspaceId, ids.world, ids.worldline, ids.story, ids.record],
    );
    await client.query(
      "INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Scene', 'active', 0, 0)",
      [workspaceId, ids.world, ids.worldline, ids.record, ids.scene],
    );
    await client.query(
      "INSERT INTO character_definitions (workspace_id, world_id, id, display_name) VALUES ($1, $2, $3, 'Witness')",
      [workspaceId, ids.world, ids.definition],
    );
    await client.query(
      "INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, born_tick, born_ordinal) VALUES ($1, $2, $3, $4, $5, 'witness', 0, 0)",
      [workspaceId, ids.world, ids.worldline, ids.definition, ids.continuity],
    );
    await client.query(
      "INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal) VALUES ($1, $2, $3, $4, $5, $6, 'ai', 0, 0, 0, 0)",
      [workspaceId, ids.world, ids.worldline, ids.record, ids.continuity, ids.instance],
    );
    await client.query(
      "INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_kind) VALUES ($1, $2, $3, $4, $5, 'public', 'public')",
      [workspaceId, ids.world, ids.worldline, ids.record, ids.visibility],
    );
    await client.query(
      "INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal) VALUES ($1, $2, $3, $4, 0, 7)",
      [workspaceId, ids.world, ids.worldline, ids.record],
    );
  });
}
