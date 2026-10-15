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
import {
  createPostgresGoalAssessmentJobQueue,
  GoalRuntimeRepositoryError,
} from "../database/postgres/public.ts";
import {
  reconcileGoalAssessmentJobsForCommittedEvents,
} from "../database/postgres/goal-runtime-materialization.ts";
import {
  goalAssessmentJobIdFor,
  goalInstanceIdFor,
} from "../modules/goals/public.ts";

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

test(
  "commitRelease enqueues durable Goal assessment jobs for active Goals in the same transaction",
  { skip: !adminConnectionString, timeout: 120_000 },
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
      // Goal runtime（0055）与 Record binding（0054/0057）：commitRelease 的
      // Goal assessment enqueue 依赖 goal_instances/goal_assessment_jobs。
      "0054_world_version_identity.sql",
      "0055_goal_runtime.sql",
      "0057_realmworld_record_binding.sql",
      "0060_goal_scope_terminal_lifecycle.sql",
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

    const goalScope = {
      workspaceId,
      worldId: ids.world,
      worldlineId: ids.worldline,
      recordId: ids.record,
    };
    const activeGoalId = goalInstanceIdFor(goalScope, "ack-tide");
    const secondActiveGoalId = goalInstanceIdFor(goalScope, "harbor-omen");
    const completedGoalId = goalInstanceIdFor(goalScope, "settled-past");

    // Record binding（records.world_version='1.2.0'）与世界创建身份
    //（worlds.world_version='9.9.9'）刻意分叉：claim 必须以 Record binding
    // 为准，绝不把 worlds.world_version 冒充 Record binding。
    await inWorkspace(pool, workspaceId, async (client) => {
      await client.query(
        "UPDATE worlds SET world_version = '9.9.9' WHERE workspace_id = $1 AND id = $2",
        [workspaceId, ids.world],
      );
      await client.query(
        "UPDATE records SET world_version = '1.2.0' WHERE workspace_id = $1 AND id = $2",
        [workspaceId, ids.record],
      );
      await client.query(
        `INSERT INTO goal_instances (
           workspace_id, world_id, worldline_id, record_id, id, goal_key,
           state, revision, progress, outcome, policy_version, completed_at
         ) VALUES
           ($1, $2, $3, $4, $5, 'ack-tide', 'active', 0, '{}'::jsonb, NULL, 'v1', NULL),
           ($1, $2, $3, $4, $6, 'harbor-omen', 'active', 0, '{}'::jsonb, NULL, 'v2', NULL),
           ($1, $2, $3, $4, $7, 'settled-past', 'completed', 1, '{}'::jsonb,
            '{"result":"done"}'::jsonb, 'v1', CURRENT_TIMESTAMP)`,
        [workspaceId, ids.world, ids.worldline, ids.record,
          activeGoalId, secondActiveGoalId, completedGoalId],
      );
    });

    // 同一 record id 的另一 Workspace 各有一个 active Goal：workspace 隔离
    // 不得串写（RLS + scope 谓词双重兜底）。
    const foreignWorkspaceId = `workspace_${randomUUID()}`;
    await seedRuntimeScope(pool, foreignWorkspaceId, ids);
    await inWorkspace(pool, foreignWorkspaceId, async (client) => {
      await client.query(
        `INSERT INTO goal_instances (
           workspace_id, world_id, worldline_id, record_id, id, goal_key,
           state, revision, progress, outcome, policy_version
         ) VALUES ($1, $2, $3, $4, $5, 'foreign-goal', 'active', 0, '{}'::jsonb, NULL, 'v1')`,
        [
          foreignWorkspaceId,
          ids.world,
          ids.worldline,
          ids.record,
          goalInstanceIdFor(
            { workspaceId: foreignWorkspaceId, worldId: ids.world, worldlineId: ids.worldline, recordId: ids.record },
            "foreign-goal",
          ),
        ],
      );
    });

    let sequence = 0;
    const dependenciesFor = (
      targetIds: { scene: string; visibility: string },
      onFormalEventsCommitted?: (
        client: pg.PoolClient,
        committed: {
          workspaceId: string;
          worldId: string;
          worldlineId: string;
          recordId: string;
          eventIds: readonly string[];
        },
      ) => Promise<void>,
    ): TurnRuntimeDependencies<
      CommandPayload,
      PlanBody,
      CandidateBody,
      ValidationBody,
      EventPayload,
      OutboxPayload
    > => ({
      repository: createPostgresRuntimeRepository<
        CommandPayload,
        PlanBody,
        CandidateBody,
        ValidationBody,
        EventPayload,
        OutboxPayload
      >({
        pool,
        workspaceId,
        mapFormalEvent({ draft }) {
          return {
            sceneId: targetIds.scene,
            visibilityPolicyId: targetIds.visibility,
            eventKind: "utterance.committed",
            speakerName: "塞娜",
            content: draft.payload.content,
          };
        },
        ...(onFormalEventsCommitted ? { onFormalEventsCommitted } : {}),
      }),
      planner: { async plan() { return { objective: "respond" }; } },
      drafter: { async draft() { return { text: "蜡封仍有余温。" }; } },
      validator: { async validate() { return { accepted: true }; } },
      releaseBuilder: {
        async build(context) {
          // 一批两条正式事件：每条都应触发每个 active Goal 的 durable job。
          const firstEventId = `${context.turnId}-event-a`;
          const secondEventId = `${context.turnId}-event-b`;
          return {
            formalEvents: [
              { eventId: firstEventId, kind: "utterance.committed", payload: { content: context.candidate.body.text } },
              { eventId: secondEventId, kind: "narration.committed", payload: { content: "潮声渐近。" } },
            ],
            outbox: [],
          };
        },
      },
      idFactory: () => `goal-runtime-${++sequence}`,
      clock: tickingClock(),
    });
    const goalEnqueueHook = async (
      client: pg.PoolClient,
      committed: {
        workspaceId: string;
        worldId: string;
        worldlineId: string;
        recordId: string;
        eventIds: readonly string[];
      },
    ) => {
      await reconcileGoalAssessmentJobsForCommittedEvents(client, committed);
    };
    const dependencies = dependenciesFor(
      { scene: ids.scene, visibility: ids.visibility },
      goalEnqueueHook,
    );

    const command: RuntimeCommand<CommandPayload> = {
      commandType: "player.utterance",
      recordId: ids.record,
      expectedRecordVersion: 0,
      idempotencyKey: "goal-enqueue-turn",
      actorId: null,
      payload: ["检查蜡封"],
    };
    const completed = await executeTurn(command, dependencies);
    assert.equal(completed.state, "completed");
    const committedEventIds = completed.release?.eventIds ?? [];
    assert.equal(committedEventIds.length, 2);

    const jobs = await inWorkspace(pool, workspaceId, async (client) => {
      const result = await client.query<{
        id: string;
        workspace_id: string;
        world_id: string;
        worldline_id: string;
        record_id: string;
        goal_instance_id: string;
        source_event_id: string;
        state: string;
      }>(
        `SELECT id, workspace_id, world_id, worldline_id, record_id,
                goal_instance_id, source_event_id, state
         FROM goal_assessment_jobs
         WHERE record_id = $1
         ORDER BY goal_instance_id, source_event_id`,
        [ids.record],
      );
      return result.rows;
    });
    // 2 个 active Goal × 2 条正式事件 = 4 条 durable job；completed Goal 无
    // job；source_event_id 必须是本次真实提交的事件 id。
    assert.equal(jobs.length, 4);
    for (const jobRow of jobs) {
      assert.equal(jobRow.workspace_id, workspaceId);
      assert.equal(jobRow.world_id, ids.world);
      assert.equal(jobRow.worldline_id, ids.worldline);
      assert.equal(jobRow.record_id, ids.record);
      assert.ok(committedEventIds.includes(jobRow.source_event_id));
      assert.ok(
        jobRow.goal_instance_id === activeGoalId
          || jobRow.goal_instance_id === secondActiveGoalId,
        "terminal Goal 不得获得 assessment job",
      );
      assert.equal(jobRow.state, "pending");
      assert.equal(
        jobRow.id,
        goalAssessmentJobIdFor(workspaceId, jobRow.goal_instance_id, jobRow.source_event_id),
        "job id 必须是确定性派生（稳定 dedupe）",
      );
    }

    // release replay（同幂等键同 fingerprint）：幂等早返回，不重复 enqueue。
    const replay = await executeTurn(command, dependencies);
    assert.equal(replay.turnId, completed.turnId);
    const jobsAfterReplay = await inWorkspace(pool, workspaceId, async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM goal_assessment_jobs WHERE record_id = $1",
        [ids.record],
      );
      return result.rows[0]!.count;
    });
    assert.equal(jobsAfterReplay, "4");

    // workspace/RLS mismatch must fail closed rather than treating the hidden
    // Goal set as an ordinary no-op.
    await assert.rejects(
      inWorkspace(pool, workspaceId, (client) =>
        reconcileGoalAssessmentJobsForCommittedEvents(client, {
          workspaceId: foreignWorkspaceId,
          worldId: ids.world,
          worldlineId: ids.worldline,
          recordId: ids.record,
          eventIds: [committedEventIds[0]!],
        }),
      ),
      (error: unknown) => error instanceof GoalRuntimeRepositoryError
        && error.code === "GOAL_SCOPE_MISMATCH",
    );

    // A pre-existing natural-key row with a non-derived id is corruption, not
    // an idempotent replay: the enqueue must abort instead of silently merging.
    const corruptedJobId = `corrupt-goal-job-${randomUUID()}`;
    await inWorkspace(pool, workspaceId, async (client) => {
      const result = await client.query(
        `UPDATE goal_assessment_jobs
         SET id = $1
         WHERE workspace_id = $2 AND goal_instance_id = $3 AND source_event_id = $4`,
        [corruptedJobId, workspaceId, activeGoalId, committedEventIds[0]],
      );
      assert.equal(result.rowCount, 1);
    });
    await assert.rejects(
      inWorkspace(pool, workspaceId, (client) =>
        reconcileGoalAssessmentJobsForCommittedEvents(client, {
          workspaceId,
          worldId: ids.world,
          worldlineId: ids.worldline,
          recordId: ids.record,
          eventIds: [committedEventIds[0]!],
        }),
      ),
      (error: unknown) => error instanceof GoalRuntimeRepositoryError
        && error.code === "GOAL_JOB_IDENTITY_CONFLICT",
    );
    await inWorkspace(pool, workspaceId, async (client) => {
      const result = await client.query(
        `UPDATE goal_assessment_jobs
         SET id = $1
         WHERE workspace_id = $2 AND goal_instance_id = $3 AND source_event_id = $4`,
        [
          goalAssessmentJobIdFor(workspaceId, activeGoalId, committedEventIds[0]!),
          workspaceId,
          activeGoalId,
          committedEventIds[0],
        ],
      );
      assert.equal(result.rowCount, 1);
    });

    // workspace 隔离：foreign Workspace 的同 id Record 不得被串写。
    const foreignJobs = await inWorkspace(pool, foreignWorkspaceId, async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM goal_assessment_jobs WHERE record_id = $1",
        [ids.record],
      );
      return result.rows[0]!.count;
    });
    assert.equal(foreignJobs, "0");

    // Record binding：claim 读出的 world_version 是 records.world_version
    //（'1.2.0'），不是 worlds.world_version（'9.9.9'）。
    const queue = createPostgresGoalAssessmentJobQueue({
      pool,
      workspaceId,
      leaseOwner: "goal-test-worker",
      leaseDurationMs: 30_000,
    });
    const claimed = await queue.claimNext({ now: new Date().toISOString() });
    assert.ok(claimed);
    assert.equal(claimed.worldVersion, "1.2.0");
    assert.ok(committedEventIds.includes(claimed.sourceEventId));

    // 无 Goal 的旧路径：commitRelease 不产生任何 job（hook 已接线）。
    const goalLessIds = {
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
    await seedRuntimeScope(pool, workspaceId, goalLessIds);
    const goalLessCommand: RuntimeCommand<CommandPayload> = {
      commandType: "player.utterance",
      recordId: goalLessIds.record,
      expectedRecordVersion: 0,
      idempotencyKey: "goal-less-turn",
      actorId: null,
      payload: ["无目标世界线"],
    };
    const goalLessDependencies = dependenciesFor(
      { scene: goalLessIds.scene, visibility: goalLessIds.visibility },
      goalEnqueueHook,
    );
    const goalLessCompleted = await executeTurn(goalLessCommand, goalLessDependencies);
    assert.equal(goalLessCompleted.state, "completed");
    const goalLessJobs = await inWorkspace(pool, workspaceId, async (client) => {
      const result = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM goal_assessment_jobs WHERE record_id = $1",
        [goalLessIds.record],
      );
      return result.rows[0]!.count;
    });
    assert.equal(goalLessJobs, "0");

    // 事务异常 fail-closed：hook 抛错 → 整个 release 回滚——无事件、无
    // job、head 不推进（不得在事务外补写）。
    const failingDependencies = dependenciesFor(
      { scene: goalLessIds.scene, visibility: goalLessIds.visibility },
      async () => {
        throw new Error("goal enqueue exploded");
      },
    );
    const failed = await executeTurn(
      {
        commandType: "player.utterance",
        recordId: goalLessIds.record,
        expectedRecordVersion: 1,
        idempotencyKey: "goal-enqueue-rollback",
        actorId: null,
        payload: ["必须整体回滚"],
      },
      failingDependencies,
    );
    assert.notEqual(failed.state, "completed");
    const rollbackState = await inWorkspace(pool, workspaceId, async (client) => {
      const events = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM events WHERE record_id = $1",
        [goalLessIds.record],
      );
      const jobsResult = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM goal_assessment_jobs WHERE record_id = $1",
        [goalLessIds.record],
      );
      const head = await client.query<{ record_version: string }>(
        "SELECT record_version::text AS record_version FROM record_heads WHERE workspace_id = $1 AND record_id = $2",
        [workspaceId, goalLessIds.record],
      );
      return {
        events: events.rows[0]!.count,
        jobs: jobsResult.rows[0]!.count,
        recordVersion: head.rows[0]!.record_version,
      };
    });
    // 首回合留下 2 条事件；失败回合零残留、head 停在 1。
    assert.deepEqual(rollbackState, { events: "2", jobs: "0", recordVersion: "1" });
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
    await client.query(
      "INSERT INTO workspaces (id, name) VALUES ($1, 'Repository Test') ON CONFLICT (id) DO NOTHING",
      [workspaceId],
    );
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
