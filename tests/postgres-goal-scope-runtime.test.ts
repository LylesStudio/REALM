import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import test from "node:test";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import {
  materializeGoalInstances,
  retryGoalInstance,
} from "../database/postgres/goal-runtime-materialization.ts";
import { loadGoalScopeCommittedEvents } from "../database/postgres/goal-scope-evidence.ts";
import {
  createPostgresGoalAssessmentJobQueue,
  type GoalAssessmentEnqueueInput,
} from "../database/postgres/goal-assessment-job-queue.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import {
  runGoalAssessmentOnce,
  type GoalAssessmentDecision,
} from "../modules/goals/assessment-worker.ts";
import {
  goalInstanceIdFor,
  type GoalDefinition,
  type GoalRuntimeScope,
  type GoalStoryScope,
  type GoalWorldlineScope,
} from "../modules/goals/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";

const WS = POSTGRES_DEMO_IDS.workspace;
const WORLD = POSTGRES_DEMO_IDS.world;
const WORLDLINE = POSTGRES_DEMO_IDS.worldline;
const STORY = POSTGRES_DEMO_IDS.story;

function now(): string {
  return new Date().toISOString();
}

function recordScope(recordId: string): GoalRuntimeScope {
  return { kind: "record", workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE, recordId };
}

test(
  "migration 0060 installs goal scope columns, constraints, indexes and the terminal guard",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async () => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    try {
      const columns = await ownerPool.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'goal_instances'
           AND column_name IN ('scope_kind', 'story_id', 'attempt', 'supersedes_instance_id', 'record_id')`,
      );
      const byName = new Map(columns.rows.map((row) => [row.column_name, row.is_nullable]));
      assert.equal(byName.get("scope_kind"), "NO");
      assert.equal(byName.get("attempt"), "NO");
      assert.equal(byName.get("record_id"), "YES");
      assert.equal(byName.get("story_id"), "YES");
      assert.equal(byName.get("supersedes_instance_id"), "YES");

      const constraints = await ownerPool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'goal_instances'::regclass
           AND conname IN (
             'goal_instances_scope_kind_check',
             'goal_instances_scope_anchor_check',
             'goal_instances_attempt_check',
             'goal_instances_supersedes_fk',
             'goal_instances_state_check'
           )`,
      );
      assert.deepEqual(
        constraints.rows.map((row) => row.conname).sort(),
        [
          "goal_instances_attempt_check",
          "goal_instances_scope_anchor_check",
          "goal_instances_scope_kind_check",
          "goal_instances_state_check",
          "goal_instances_supersedes_fk",
        ],
      );

      const indexes = await ownerPool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'goal_instances'
           AND indexname IN (
             'goal_instances_scope_goal_attempt_key',
             'goal_instances_scope_single_active_key'
           )`,
      );
      assert.deepEqual(
        indexes.rows.map((row) => row.indexname).sort(),
        ["goal_instances_scope_goal_attempt_key", "goal_instances_scope_single_active_key"],
      );

      const legacy = await ownerPool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
         WHERE conrelid = 'goal_instances'::regclass
           AND conname = 'goal_instances_workspace_id_record_id_goal_key_key'`,
      );
      assert.equal(legacy.rowCount, 0);

      const trigger = await ownerPool.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger
         WHERE tgrelid = 'goal_instances'::regclass
           AND tgname = 'goal_instances_terminal_immutable_guard'`,
      );
      assert.equal(trigger.rowCount, 1);
    } finally {
      await ownerPool.end();
    }
  },
);

test(
  "all three scope kinds materialize with deterministic ids and exactly one anchor",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalKey = `test.scope.${suffix}`;
    const storyScope: GoalStoryScope = {
      kind: "story", workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE, storyId: STORY,
    };
    const worldlineScope: GoalWorldlineScope = {
      kind: "worldline", workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE,
    };
    t.after(async () => {
      await ownerPool.query(
        `DELETE FROM goal_instances WHERE workspace_id = $1 AND goal_key = $2`,
        [WS, goalKey],
      );
      await runtimePool.end();
      await ownerPool.end();
    });

    const ids = await withWorkspaceTransaction(runtimePool, WS, async (client) => {
      const recordIds = await materializeGoalInstances(client, recordScope(POSTGRES_DEMO_IDS.record), [
        { goalKey, policyVersion: "v1" },
      ]);
      const storyIds = await materializeGoalInstances(client, storyScope, [
        { goalKey, policyVersion: "v1" },
      ]);
      const worldlineIds = await materializeGoalInstances(client, worldlineScope, [
        { goalKey, policyVersion: "v1" },
      ]);
      return { recordIds, storyIds, worldlineIds };
    });

    assert.deepEqual(ids.recordIds, [goalInstanceIdFor(recordScope(POSTGRES_DEMO_IDS.record), goalKey)]);
    assert.deepEqual(ids.storyIds, [goalInstanceIdFor(storyScope, goalKey)]);
    assert.deepEqual(ids.worldlineIds, [goalInstanceIdFor(worldlineScope, goalKey)]);
    assert.notEqual(ids.recordIds[0], ids.storyIds[0]);
    assert.notEqual(ids.storyIds[0], ids.worldlineIds[0]);

    const rows = await ownerPool.query<{
      id: string;
      scope_kind: string;
      record_id: string | null;
      story_id: string | null;
      attempt: number;
      supersedes_instance_id: string | null;
    }>(
      `SELECT id, scope_kind, record_id, story_id, attempt, supersedes_instance_id
       FROM goal_instances WHERE workspace_id = $1 AND goal_key = $2
       ORDER BY scope_kind`,
      [WS, goalKey],
    );
    assert.deepEqual(rows.rows, [
      {
        id: ids.recordIds[0],
        scope_kind: "record",
        record_id: POSTGRES_DEMO_IDS.record,
        story_id: null,
        attempt: 1,
        supersedes_instance_id: null,
      },
      {
        id: ids.storyIds[0],
        scope_kind: "story",
        record_id: null,
        story_id: STORY,
        attempt: 1,
        supersedes_instance_id: null,
      },
      {
        id: ids.worldlineIds[0],
        scope_kind: "worldline",
        record_id: null,
        story_id: null,
        attempt: 1,
        supersedes_instance_id: null,
      },
    ]);

    // 恰好一个锚：story 行携带 record_id 违反 scope anchor CHECK。
    await assert.rejects(
      ownerPool.query(
        `INSERT INTO goal_instances (
           workspace_id, world_id, worldline_id, record_id, story_id, scope_kind,
           id, goal_key, policy_version
         ) VALUES ($1, $2, $3, $4, $5, 'story', $6, $7, 'v1')`,
        [WS, WORLD, WORLDLINE, POSTGRES_DEMO_IDS.record, STORY, `goal_bad_${suffix}`, `${goalKey}.bad`],
      ),
      /goal_instances_scope_anchor_check/,
    );
    // worldline 行携带 story 锚同样违反 CHECK。
    await assert.rejects(
      ownerPool.query(
        `INSERT INTO goal_instances (
           workspace_id, world_id, worldline_id, record_id, story_id, scope_kind,
           id, goal_key, policy_version
         ) VALUES ($1, $2, $3, NULL, $4, 'worldline', $5, $6, 'v1')`,
        [WS, WORLD, WORLDLINE, STORY, `goal_bad2_${suffix}`, `${goalKey}.bad2`],
      ),
      /goal_instances_scope_anchor_check/,
    );
  },
);

test(
  "goal instances stay workspace-isolated under FORCE RLS",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalKey = `test.rls.${suffix}`;
    const scope = recordScope(POSTGRES_DEMO_IDS.record);
    t.after(async () => {
      await ownerPool.query(
        `DELETE FROM goal_instances WHERE workspace_id = $1 AND goal_key = $2`,
        [WS, goalKey],
      );
      await runtimePool.end();
      await ownerPool.end();
    });

    const [id] = await withWorkspaceTransaction(runtimePool, WS, (client) =>
      materializeGoalInstances(client, scope, [{ goalKey, policyVersion: "v1" }]),
    );

    // 未设置 workspace GUC：RLS 下零行。
    const unscoped = await runtimePool.query(
      `SELECT id FROM goal_instances WHERE id = $1`,
      [id],
    );
    assert.equal(unscoped.rowCount, 0);

    // 其他 workspace 的 GUC：同样零行。
    const foreign = await withWorkspaceTransaction(runtimePool, "ws_other", (client) =>
      client.query(`SELECT id FROM goal_instances WHERE id = $1`, [id]),
    );
    assert.equal(foreign.rowCount, 0);

    // 正确 workspace：可见。
    const scoped = await withWorkspaceTransaction(runtimePool, WS, (client) =>
      client.query(`SELECT id FROM goal_instances WHERE id = $1`, [id]),
    );
    assert.equal(scoped.rowCount, 1);
  },
);

test(
  "terminal instances are immutable, retry opens a new attempt, and a single active attempt is enforced",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const goalKey = `test.retry.${suffix}`;
    const scope = recordScope(POSTGRES_DEMO_IDS.record);
    t.after(async () => {
      // supersedes 自引用 FK 为 ON DELETE CASCADE：删除首个 attempt 级联清掉重试行。
      await ownerPool.query(
        `DELETE FROM goal_instances WHERE workspace_id = $1 AND goal_key = $2`,
        [WS, goalKey],
      );
      await runtimePool.end();
      await ownerPool.end();
    });

    const [firstId] = await withWorkspaceTransaction(runtimePool, WS, (client) =>
      materializeGoalInstances(client, scope, [{ goalKey, policyVersion: "v1" }]),
    );

    // active 时拒绝重试（单 active 约束的引擎侧守卫）。
    await assert.rejects(
      withWorkspaceTransaction(runtimePool, WS, (client) =>
        retryGoalInstance(client, scope, { goalKey, policyVersion: "v1", retryable: true }),
      ),
      (error: unknown) => (error as { code?: string }).code === "GOAL_RETRY_ACTIVE_EXISTS",
    );
    // 内容未声明 retryable 时拒绝重试。
    await assert.rejects(
      withWorkspaceTransaction(runtimePool, WS, (client) =>
        retryGoalInstance(client, scope, { goalKey, policyVersion: "v1" }),
      ),
      (error: unknown) => (error as { code?: string }).code === "GOAL_RETRY_NOT_ALLOWED",
    );

    // 终态化首个 attempt（active → terminal 是唯一允许的方向）。
    await ownerPool.query(
      `UPDATE goal_instances
       SET state = 'failed', revision = 1, outcome = '{"why":"test"}'::jsonb,
           completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND id = $2`,
      [WS, firstId],
    );

    // 终态不可变：state/progress 一律拒绝再写。
    await assert.rejects(
      ownerPool.query(
        `UPDATE goal_instances SET state = 'active'
         WHERE workspace_id = $1 AND id = $2`,
        [WS, firstId],
      ),
      /terminal goal instances are immutable/,
    );
    await assert.rejects(
      ownerPool.query(
        `UPDATE goal_instances SET progress = '{"clues":9}'::jsonb
         WHERE workspace_id = $1 AND id = $2`,
        [WS, firstId],
      ),
      /terminal goal instances are immutable/,
    );
    await assert.rejects(
      ownerPool.query(
        `UPDATE goal_instances SET policy_version = 'v2'
         WHERE workspace_id = $1 AND id = $2`,
        [WS, firstId],
      ),
      /terminal goal instances are immutable/,
    );
    await assert.rejects(
      ownerPool.query(
        `UPDATE goal_instances SET updated_at = updated_at + INTERVAL '1 second'
         WHERE workspace_id = $1 AND id = $2`,
        [WS, firstId],
      ),
      /terminal goal instances are immutable/,
    );

    // 重试：新 attempt、新确定性 id、supersedes 指向终态实例。
    const secondId = await withWorkspaceTransaction(runtimePool, WS, (client) =>
      retryGoalInstance(client, scope, { goalKey, policyVersion: "v1", retryable: true }),
    );
    assert.equal(secondId, goalInstanceIdFor(scope, goalKey, 2));
    assert.notEqual(secondId, firstId);

    const attempts = await ownerPool.query<{
      id: string;
      state: string;
      attempt: number;
      supersedes_instance_id: string | null;
    }>(
      `SELECT id, state, attempt, supersedes_instance_id
       FROM goal_instances WHERE workspace_id = $1 AND goal_key = $2
       ORDER BY attempt`,
      [WS, goalKey],
    );
    assert.deepEqual(attempts.rows, [
      { id: firstId, state: "failed", attempt: 1, supersedes_instance_id: null },
      { id: secondId, state: "active", attempt: 2, supersedes_instance_id: firstId },
    ]);

    // 同 scope+goalKey 只能一个 active：并发/错误路径的 DB 兜底。
    await assert.rejects(
      ownerPool.query(
        `INSERT INTO goal_instances (
           workspace_id, world_id, worldline_id, record_id, scope_kind,
           id, goal_key, policy_version, attempt
         ) VALUES ($1, $2, $3, $4, 'record', $5, $6, 'v1', 3)`,
        [WS, WORLD, WORLDLINE, POSTGRES_DEMO_IDS.record, `goal_dup_${suffix}`, goalKey],
      ),
      /goal_instances_scope_single_active_key/,
    );

    // 再次重试仍被拒绝：最新 attempt 是 active。
    await assert.rejects(
      withWorkspaceTransaction(runtimePool, WS, (client) =>
        retryGoalInstance(client, scope, { goalKey, policyVersion: "v1", retryable: true }),
      ),
      (error: unknown) => (error as { code?: string }).code === "GOAL_RETRY_ACTIVE_EXISTS",
    );
  },
);

async function createRecordFixture(
  ownerPool: pg.Pool,
  suffix: string,
  label: "b" | "c",
): Promise<{ recordId: string; sceneId: string; policyId: string; eventIds: string[] }> {
  const recordId = `record_goal_scope_${label}_${suffix}`;
  const sceneId = `scene_goal_scope_${label}_${suffix}`;
  const policyId = `policy_goal_scope_${label}_${suffix}`;
  const opening = await ownerPool.query<{
    world_tick: string;
    calendar_id: string;
    display_time: string;
  }>(
    `SELECT world_tick, calendar_id, display_time FROM events
     WHERE workspace_id = $1 AND id = $2`,
    [WS, POSTGRES_DEMO_IDS.openingEvent],
  );
  const baseTick = Number(opening.rows[0]!.world_tick);
  const calendarId = opening.rows[0]!.calendar_id;
  const displayTime = opening.rows[0]!.display_time;
  const maxOrdinal = await ownerPool.query<{ max: string | null }>(
    `SELECT MAX(world_ordinal) AS max FROM events
     WHERE workspace_id = $1 AND worldline_id = $2 AND world_tick = $3`,
    [WS, WORLDLINE, baseTick],
  );
  let nextWorldOrdinal = Number(maxOrdinal.rows[0]?.max ?? 0) + 1;

  await ownerPool.query(
    `INSERT INTO records (
       workspace_id, world_id, worldline_id, story_id, id, title, status,
       start_tick, start_ordinal
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, 0)`,
    [WS, WORLD, WORLDLINE, STORY, recordId, `Goal scope fixture ${label}`, baseTick],
  );
  await ownerPool.query(
    `INSERT INTO scenes (
       workspace_id, world_id, worldline_id, record_id, id, title, status,
       location, objective, start_tick, start_ordinal
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active', '', '', $7, 0)`,
    [WS, WORLD, WORLDLINE, recordId, sceneId, `Goal scope scene ${label}`, baseTick],
  );
  await ownerPool.query(
    `INSERT INTO visibility_policies (
       workspace_id, world_id, worldline_id, record_id, id,
       policy_key, policy_version, policy_kind
     ) VALUES ($1, $2, $3, $4, $5, 'public', 1, 'public')`,
    [WS, WORLD, WORLDLINE, recordId, policyId],
  );
  const kinds = label === "b"
    ? ["narration.committed", "action.transaction.committed", "system.correction.committed"]
    : ["narration.committed", "utterance.committed"];
  const eventIds: string[] = [];
  for (const [index, kind] of kinds.entries()) {
    const eventId = `event_goal_scope_${label}_${index}_${suffix}`;
    await ownerPool.query(
      `INSERT INTO events (
         workspace_id, world_id, worldline_id, record_id, scene_id, id,
         record_version, record_ordinal, batch_index, event_kind,
         actor_participant_id, speaker_name, content, payload,
         visibility_policy_id, world_tick, world_ordinal, calendar_id,
         display_time, recorded_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, 0, $9,
         NULL, '', $10, '{}'::jsonb,
         $11, $12, $13, $14,
         $15, CURRENT_TIMESTAMP
       )`,
      [
        WS, WORLD, WORLDLINE, recordId, sceneId, eventId,
        index + 1, index + 1, kind,
        `fixture ${label} event ${index}`,
        policyId, baseTick, nextWorldOrdinal, calendarId,
        displayTime,
      ],
    );
    nextWorldOrdinal += 1;
    eventIds.push(eventId);
  }
  await ownerPool.query(
    `INSERT INTO record_heads (
       workspace_id, world_id, worldline_id, record_id, record_version,
       next_record_ordinal, last_event_id, last_world_tick, last_world_ordinal
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      WS, WORLD, WORLDLINE, recordId, kinds.length, kinds.length + 1,
      eventIds[eventIds.length - 1]!, baseTick, nextWorldOrdinal - 1,
    ],
  );
  // fixture 事件占用了 worldline 级 world_ordinal：必须单调推进
  // worldlines.head_ordinal，否则 settle 的 goal.transition 事件
  // （head_ordinal+1）会撞 UNIQUE (workspace_id, worldline_id, world_tick,
  // world_ordinal)。
  await ownerPool.query(
    `UPDATE worldlines
     SET head_ordinal = GREATEST(head_ordinal, $4)
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [WS, WORLD, WORLDLINE, nextWorldOrdinal - 1],
  );
  return { recordId, sceneId, policyId, eventIds };
}

test(
  "story and worldline scope evidence aggregate committed events across records",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    // events 是 append-only：fixture 的事件/Record 行保留在 scratch 库中
    // （scratch 集群整体销毁）；断言全部设计为对其它套件数据稳健。
    const fixtureB = await createRecordFixture(ownerPool, suffix, "b");
    const fixtureC = await createRecordFixture(ownerPool, suffix, "c");
    t.after(async () => {
      await runtimePool.end();
      await ownerPool.end();
    });

    await withWorkspaceTransaction(runtimePool, WS, async (client) => {
      // record scope：精确到单 Record、record_ordinal 序。
      const recordEvents = await loadGoalScopeCommittedEvents(
        client,
        recordScope(fixtureB.recordId),
      );
      assert.deepEqual(recordEvents.map((event) => event.eventId), fixtureB.eventIds);
      assert.ok(recordEvents.every((event) => event.recordId === fixtureB.recordId));

      const storyScope: GoalStoryScope = {
        kind: "story", workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE, storyId: STORY,
      };
      // story scope：显式成员清单 → 精确读取。
      const explicit = await loadGoalScopeCommittedEvents(client, storyScope, {
        memberRecordIds: [fixtureC.recordId],
      });
      assert.deepEqual(explicit.map((event) => event.eventId), fixtureC.eventIds);

      // story scope：显式空清单 → 零证据，绝不退化为整条 worldline。
      assert.deepEqual(
        await loadGoalScopeCommittedEvents(client, storyScope, { memberRecordIds: [] }),
        [],
      );

      // story scope：默认经 records.story_id 解析成员（demo record + 两个
      // fixture record），与 live SQL 期望一致。
      const resolved = await loadGoalScopeCommittedEvents(client, storyScope);
      const expected = await client.query<{ id: string }>(
        `SELECT event.id FROM events AS event
         JOIN records AS record
           ON record.workspace_id = event.workspace_id
          AND record.world_id = event.world_id
          AND record.worldline_id = event.worldline_id
          AND record.id = event.record_id
         WHERE event.workspace_id = $1 AND event.world_id = $2
           AND event.worldline_id = $3
           AND record.story_id = $4 AND record.status <> 'archived'
         ORDER BY event.world_tick, event.world_ordinal, event.record_id, event.record_ordinal, event.id`,
        [WS, WORLD, WORLDLINE, STORY],
      );
      assert.deepEqual(
        resolved.map((event) => event.eventId),
        expected.rows.map((row) => row.id),
      );
      for (const id of [...fixtureB.eventIds, ...fixtureC.eventIds]) {
        assert.ok(resolved.some((event) => event.eventId === id));
      }

      // worldline scope：跨全部 Record 聚合，(world_tick, world_ordinal)
      // 确定性单调。
      const worldlineScope: GoalWorldlineScope = {
        kind: "worldline", workspaceId: WS, worldId: WORLD, worldlineId: WORLDLINE,
      };
      const worldlineEvents = await loadGoalScopeCommittedEvents(client, worldlineScope);
      for (const id of [...fixtureB.eventIds, ...fixtureC.eventIds]) {
        assert.ok(worldlineEvents.some((event) => event.eventId === id));
      }
      for (let index = 1; index < worldlineEvents.length; index += 1) {
        const previous = worldlineEvents[index - 1]!;
        const current = worldlineEvents[index]!;
        assert.ok(
          previous.worldTick < current.worldTick
            || (previous.worldTick === current.worldTick
              && previous.worldOrdinal <= current.worldOrdinal),
          "worldline evidence order must be deterministic",
        );
      }
    });
  },
);

test(
  "settle applies failed/settled terminals, replays duplicates, and stably rejects late results",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeConnectionString!, max: 2 });
    const suffix = randomUUID().replaceAll("-", "");
    const fixture = await createRecordFixture(ownerPool, suffix, "b");
    const goalKey = `test.terminal.${suffix}`;
    const scope = recordScope(fixture.recordId);
    const goalInstanceId = goalInstanceIdFor(scope, goalKey);
    const leaseOwner = `test-worker-${suffix}`;
    t.after(async () => {
      await ownerPool.query(
        `DELETE FROM goal_instances WHERE workspace_id = $1 AND goal_key = $2`,
        [WS, goalKey],
      );
      await runtimePool.end();
      await ownerPool.end();
    });

    // 确定性失败 rubric：任一 action.transaction.committed 即 failed。
    const definition: GoalDefinition = {
      goalKey,
      policyVersion: "v1",
      mode: "deterministic",
      visible: true,
      rubric: {
        kind: "event_count",
        eventKind: "narration.committed",
        progressKey: "narrations",
        threshold: 99,
        failure: {
          eventKind: "action.transaction.committed",
          progressKey: "losses",
          threshold: 1,
        },
      },
      outcome: { result: "lost" },
    };

    await withWorkspaceTransaction(runtimePool, WS, (client) =>
      materializeGoalInstances(client, scope, [{ goalKey, policyVersion: "v1" }]),
    );
    const queue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: WS,
      leaseOwner,
      leaseDurationMs: 30_000,
    });
    const enqueueInput = (jobId: string, sourceEventId: string): GoalAssessmentEnqueueInput => ({
      jobId,
      workspaceId: WS,
      worldId: WORLD,
      worldlineId: WORLDLINE,
      recordId: fixture.recordId,
      goalInstanceId,
      sourceEventId,
    });

    // job1：deterministic 失败条件满足 → failed 终态 + 正式事件 + 台账。
    const jobId1 = `goal_job_t1_${suffix}`;
    assert.equal(await queue.enqueue(enqueueInput(jobId1, fixture.eventIds[0]!)), "inserted");
    const report = await runGoalAssessmentOnce({
      repository: queue,
      resolveDefinition: async () => definition,
      now: now(),
    });
    assert.deepEqual(report, { kind: "settled", status: "accepted" });

    const instance = await ownerPool.query<{
      state: string;
      revision: string;
      completed_at: Date | null;
    }>(
      `SELECT state, revision, completed_at FROM goal_instances
       WHERE workspace_id = $1 AND id = $2`,
      [WS, goalInstanceId],
    );
    assert.equal(instance.rows[0]?.state, "failed");
    assert.equal(Number(instance.rows[0]?.revision), 1);
    assert.ok(instance.rows[0]?.completed_at instanceof Date);

    const transitionEvent = await ownerPool.query<{ content: string; event_kind: string }>(
      `SELECT content, event_kind FROM events
       WHERE workspace_id = $1 AND id = $2`,
      [WS, `goal-transition:${jobId1}:1`],
    );
    assert.equal(transitionEvent.rows[0]?.event_kind, "goal.transition.committed");
    assert.equal(transitionEvent.rows[0]?.content, `Goal ${goalKey} failed`);

    const transitionCount = async (): Promise<number> => {
      const result = await ownerPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM events
         WHERE workspace_id = $1 AND record_id = $2
           AND event_kind = 'goal.transition.committed'`,
        [WS, fixture.recordId],
      );
      return Number(result.rows[0]!.count);
    };
    assert.equal(await transitionCount(), 1);

    // job2：同一逻辑 transition 的幂等 replay（同终态 + 同 revision）→
    // applied，零新事件，实例不变。
    const jobId2 = `goal_job_t2_${suffix}`;
    assert.equal(await queue.enqueue(enqueueInput(jobId2, fixture.eventIds[1]!)), "inserted");
    const replayClaim = await queue.claimNext({ now: now() });
    assert.ok(replayClaim);
    assert.equal(replayClaim.jobId, jobId2);
    const replayDecision: GoalAssessmentDecision = {
      status: "accepted",
      source: "deterministic",
      policyVersion: "v1",
      observedHead: { recordVersion: 4, ordinal: 4 },
      transition: {
        from: "active",
        to: "failed",
        revision: 1,
        progress: { narrations: 1, losses: 1 },
        outcome: { result: "lost" },
        evidenceEventIds: [fixture.eventIds[1]!],
        evidenceHead: { recordVersion: 2, ordinal: 2 },
        evidenceSnapshotHash: "replay-hash",
        policyVersion: "v1",
      },
      evidence: {
        progress: { narrations: 1, losses: 1 },
        evidenceEventIds: [fixture.eventIds[1]!],
        evidenceHead: { recordVersion: 2, ordinal: 2 },
        evidenceSnapshotHash: "replay-hash",
      },
      result: { kind: "transition", decision: "fail" },
    };
    assert.equal(
      await queue.settle({ job: replayClaim, decision: replayDecision, now: now() }),
      "applied",
    );
    assert.equal(await transitionCount(), 1);
    const replayJob = await ownerPool.query<{ state: string }>(
      `SELECT state FROM goal_assessment_jobs WHERE workspace_id = $1 AND id = $2`,
      [WS, jobId2],
    );
    assert.equal(replayJob.rows[0]?.state, "completed");
    const replayAssessment = await ownerPool.query<{ status: string }>(
      `SELECT status FROM goal_assessments
       WHERE workspace_id = $1 AND assessment_job_id = $2`,
      [WS, jobId2],
    );
    assert.equal(replayAssessment.rows[0]?.status, "accepted");

    // job3：迟到的冲突结果（completed）→ 稳定拒绝，终态不翻转。
    const jobId3 = `goal_job_t3_${suffix}`;
    assert.equal(await queue.enqueue(enqueueInput(jobId3, fixture.eventIds[2]!)), "inserted");
    const conflictClaim = await queue.claimNext({ now: now() });
    assert.ok(conflictClaim);
    const conflictDecision: GoalAssessmentDecision = {
      ...replayDecision,
      transition: { ...replayDecision.transition, to: "completed" },
      result: { kind: "transition", decision: "complete" },
    };
    assert.equal(
      await queue.settle({ job: conflictClaim, decision: conflictDecision, now: now() }),
      "applied",
    );
    const conflictJob = await ownerPool.query<{ state: string; last_error_code: string | null }>(
      `SELECT state, last_error_code FROM goal_assessment_jobs
       WHERE workspace_id = $1 AND id = $2`,
      [WS, jobId3],
    );
    assert.equal(conflictJob.rows[0]?.state, "completed");
    assert.equal(conflictJob.rows[0]?.last_error_code, "GOAL_ALREADY_TERMINAL");
    const conflictAssessment = await ownerPool.query<{ status: string; result: { code?: string } }>(
      `SELECT status, result FROM goal_assessments
       WHERE workspace_id = $1 AND assessment_job_id = $2`,
      [WS, jobId3],
    );
    assert.equal(conflictAssessment.rows[0]?.status, "rejected");
    assert.equal(conflictAssessment.rows[0]?.result.code, "GOAL_ALREADY_TERMINAL");

    // 终态未被任何迟到结果翻转。
    const finalInstance = await ownerPool.query<{ state: string; revision: string }>(
      `SELECT state, revision FROM goal_instances
       WHERE workspace_id = $1 AND id = $2`,
      [WS, goalInstanceId],
    );
    assert.equal(finalInstance.rows[0]?.state, "failed");
    assert.equal(Number(finalInstance.rows[0]?.revision), 1);
    assert.equal(await transitionCount(), 1);
  },
);
