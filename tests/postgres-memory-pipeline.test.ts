import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresCharacterMemoryRepository,
  createPostgresDeliveryProjectionRepository,
  createPostgresActionAffordanceCatalog,
  createPostgresRuntimeRepository,
  seedPostgresDemo,
  withWorkspaceTransaction,
} from "../database/postgres/public.ts";
import {
  createCharacterMemoryService,
} from "../modules/memory/public.ts";
import { createMemorySyncScheduler } from "../modules/memory/pipeline.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import { createLocalM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import {
  createDeterministicActionResolver,
  type ActionTransaction,
} from "../modules/actions/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

/** 与 runtime-repository commitRelease 写入形态一致的测试 observation。 */
interface ObservationSeed {
  id: string;
  observer: string;
  content: string;
  occurredOrdinal: number;
}

const TICK = 17_121_219;

async function insertObservation(
  pool: pg.Pool,
  seed: ObservationSeed,
): Promise<void> {
  await pool.query(
    `INSERT INTO observations (
       workspace_id, world_id, worldline_id, record_id,
       observer_character_instance_id, source_event_id, id,
       dedupe_key, observation_kind, content, fidelity,
       occurred_tick, occurred_ordinal,
       available_from_tick, available_from_ordinal, learned_at, metadata
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, 'direct', $9, 1.0,
       $10, $11, $10, $11, CURRENT_TIMESTAMP, '{}'::jsonb
     )`,
    [
      POSTGRES_DEMO_IDS.workspace,
      POSTGRES_DEMO_IDS.world,
      POSTGRES_DEMO_IDS.worldline,
      POSTGRES_DEMO_IDS.record,
      seed.observer,
      POSTGRES_DEMO_IDS.openingEvent,
      seed.id,
      `dedupe-${seed.id}`,
      seed.content,
      TICK,
      seed.occurredOrdinal,
    ],
  );
}

async function countConclusions(pool: pg.Pool): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM memory_conclusions
     WHERE workspace_id = $1`,
    [POSTGRES_DEMO_IDS.workspace],
  );
  return result.rows[0]!.count;
}

// v37：gateRecordActive 的 records FOR UPDATE 依赖 0037 列级授权（Z14）——
// 临时库一律应用全链（原 era 列表废弃）。
const REPOSITORY_MIGRATIONS: readonly string[] = [];

// 与 postgres-local-record-application.test.ts 的应用层装配保持一致。
const APPLICATION_MIGRATIONS: readonly string[] = [];

async function createPipelineDatabase(
  t: test.TestContext,
  migrations: readonly string[],
  seedOptions?: { omniscientPlayerCharacter: boolean },
) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_mempipe_test_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const owner = new pg.Client({ connectionString: ownerUrl.href });
  await owner.connect();
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = "realm_runtime";
  runtimeUrl.password = "";
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });

  t.after(async () => {
    await runtimePool.end();
    await ownerPool.end();
    await owner.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  void migrations;
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await owner.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
  }
  await seedPostgresDemo(ownerPool, seedOptions);
  return { ownerPool, runtimePool };
}

test(
  "sync_turn extraction materializes observations once and stays idempotent under repeated triggers",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createPipelineDatabase(t, REPOSITORY_MIGRATIONS);
    const repository = createPostgresCharacterMemoryRepository(runtimePool);
    const memory = createCharacterMemoryService({ repository });

    const scoutObservations: ObservationSeed[] = [
      {
        id: "obs_t2_scout_1",
        observer: POSTGRES_DEMO_IDS.scoutInstance,
        content: "信使朝着防波堤北侧离开了。",
        occurredOrdinal: 2,
      },
      {
        id: "obs_t2_scout_2",
        observer: POSTGRES_DEMO_IDS.scoutInstance,
        content: "蜡封上带着淡淡的海盐味。",
        occurredOrdinal: 3,
      },
    ];
    const playerObservation: ObservationSeed = {
      id: "obs_t2_player_1",
      observer: POSTGRES_DEMO_IDS.playerInstance,
      content: "我注意到塞娜的视线一直停在信函上。",
      occurredOrdinal: 4,
    };
    for (const seed of [...scoutObservations, playerObservation]) {
      await insertObservation(ownerPool, seed);
    }
    // 推进世界线头，使 (TICK, 2..4) 的观察进入召回游标（模拟回合提交后
    // commitRelease 推进 worldline head 的效果）。
    await ownerPool.query(
      `UPDATE worldlines
       SET head_tick = $2, head_ordinal = 10
       WHERE workspace_id = $1 AND id = $3`,
      [
        POSTGRES_DEMO_IDS.workspace,
        TICK,
        POSTGRES_DEMO_IDS.worldline,
      ],
    );
    assert.equal(await countConclusions(ownerPool), 0);

    // 萃取前召回：纯查询，无物化可读，返回空。
    const beforeRecall = await memory.recall({
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: POSTGRES_DEMO_IDS.record,
      characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
      query: "信使离开的方向",
      limit: 5,
    });
    assert.deepEqual(beforeRecall, []);

    // sync_turn 萃取：三条 observations 全量物化。
    const scope = {
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: POSTGRES_DEMO_IDS.record,
    };
    const first = await repository.extractAuthorized(scope);
    assert.equal(first.materialized, 3);
    assert.equal(await countConclusions(ownerPool), 3);

    // 物化内容与 continuity 归属正确。
    const rows = await ownerPool.query<{
      source_observation_id: string;
      observer_continuity_id: string;
      content: string;
      embedding_model: string;
    }>(`
      SELECT source_observation_id, observer_continuity_id, content, embedding_model
      FROM memory_conclusions
      WHERE workspace_id = $1
      ORDER BY source_observation_id
    `, [POSTGRES_DEMO_IDS.workspace]);
    assert.deepEqual(
      rows.rows.map((row) => row.source_observation_id),
      ["obs_t2_player_1", "obs_t2_scout_1", "obs_t2_scout_2"],
    );
    assert.deepEqual(
      rows.rows.map((row) => row.observer_continuity_id),
      [
        POSTGRES_DEMO_IDS.playerContinuity,
        POSTGRES_DEMO_IDS.scoutContinuity,
        POSTGRES_DEMO_IDS.scoutContinuity,
      ],
    );
    assert.ok(rows.rows.every((row) => row.embedding_model === "realm-lexical-v1"));

    // 幂等：重复触发不产生重复 conclusions。
    const second = await repository.extractAuthorized(scope);
    assert.equal(second.materialized, 0);
    assert.equal(await countConclusions(ownerPool), 3);
    const duplicates = await ownerPool.query<{ count: number }>(`
      SELECT count(*)::int AS count
      FROM (
        SELECT observer_continuity_id, source_observation_id
        FROM memory_conclusions
        WHERE workspace_id = $1
        GROUP BY observer_continuity_id, source_observation_id
        HAVING count(*) > 1
      ) AS duplicated
    `, [POSTGRES_DEMO_IDS.workspace]);
    assert.equal(duplicates.rows[0]!.count, 0);

    // 萃取后召回可读：塞娜能召回自己的观察，且读不到玩家 continuities 的行。
    const recalled = await memory.recall({
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: POSTGRES_DEMO_IDS.record,
      characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
      query: "信使离开的方向",
      limit: 5,
    });
    assert.ok(recalled.some((item) => item.content.includes("防波堤北侧")));
    assert.ok(recalled.every((item) =>
      item.observerContinuityId === POSTGRES_DEMO_IDS.scoutContinuity
    ));
  },
);

test(
  "recall stays a READ ONLY pure query and never materializes pending observations",
  { skip: !adminConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createPipelineDatabase(t, REPOSITORY_MIGRATIONS);
    const repository = createPostgresCharacterMemoryRepository(runtimePool);
    const memory = createCharacterMemoryService({ repository });

    await insertObservation(ownerPool, {
      id: "obs_t2_pending",
      observer: POSTGRES_DEMO_IDS.scoutInstance,
      content: "未被萃取的观察不应出现在召回里。",
      occurredOrdinal: 2,
    });
    assert.equal(await countConclusions(ownerPool), 0);

    const scope = {
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: POSTGRES_DEMO_IDS.record,
      characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
      query: "未被萃取的观察",
      limit: 5,
    };
    assert.deepEqual(await memory.recall(scope), []);
    assert.deepEqual(await memory.recall(scope), []);
    assert.equal(await countConclusions(ownerPool), 0);

    // 召回走 BEGIN READ ONLY 事务：事务内任何写操作都会被 PG 拒绝。
    const zeroVector = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
    await assert.rejects(
      withWorkspaceTransaction(
        runtimePool,
        POSTGRES_DEMO_IDS.workspace,
        async (client) => {
          await client.query(
            `INSERT INTO memory_conclusions (
               workspace_id, world_id, worldline_id, observer_continuity_id,
               observed_entity_key, id, operation, memory_kind, content,
               keywords, semantic_embedding, embedding_model, fidelity,
               occurred_tick, occurred_ordinal,
               available_from_tick, available_from_ordinal
             ) VALUES (
               $1, $2, $3, $4, $4, 'mem_t2_readonly_probe', 'add', 'explicit',
               '只读事务内的写入必须失败', '{}'::text[], $5::vector,
               'realm-lexical-v1', 1.0, 0, 0, 0, 0
             )`,
            [
              POSTGRES_DEMO_IDS.workspace,
              POSTGRES_DEMO_IDS.world,
              POSTGRES_DEMO_IDS.worldline,
              POSTGRES_DEMO_IDS.scoutContinuity,
              zeroVector,
            ],
          );
        },
        { readOnly: true },
      ),
      /read-only/i,
    );
  },
);

test(
  "extraction failure never blocks or fails the turn submission",
  { skip: !adminConnectionString },
  async (t) => {
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    t.after(() => {
      console.warn = originalWarn;
    });

    const { ownerPool, runtimePool } = await createPipelineDatabase(
      t,
      APPLICATION_MIGRATIONS,
      { omniscientPlayerCharacter: false },
    );
    // 注入一个始终失败的萃取：回合提交必须照常完成。
    const memorySync = createMemorySyncScheduler({
      extract: () => Promise.reject(new Error("extraction offline")),
    });

    const repository = createPostgresRuntimeRepository<
      { text: string; visibility: TurnVisibilityPlan },
      M2TurnPlan,
      M2TurnCandidate,
      M2TurnValidation,
      {
        schemaVersion: 1;
        role: "player" | "character" | "narrator" | "system";
        speaker: string;
        participantId: string | null;
        content: string;
        segments: readonly SemanticSegment[];
        actionTransaction?: ActionTransaction;
      },
      { recordId: string; eventIds: readonly string[] }
    >({
      pool: runtimePool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      mapFormalEvent: mapLocalFormalEvent,
      allocateWorldCursors({ previous, eventCount }) {
        return Array.from({ length: eventCount }, (_, index) => ({
          tick: previous.tick,
          ordinal: previous.ordinal + index + 1,
          calendarId: previous.calendarId,
          display: "停战纪元17年 · 雾月12日 · 入夜",
        }));
      },
    });
    let sequence = 0;
    const service = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(runtimePool),
      actionCatalog: createPostgresActionAffordanceCatalog(runtimePool),
      memorySync,
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `mempipe-token-${++sequence}`,
        clock: () => new Date("2026-08-20T03:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-20T03:00:00.000Z"),
      idFactory: () => `mempipe-${++sequence}`,
      orchestrator: createLocalM2TurnOrchestrator({
        characters: [{
          characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
          participantId: POSTGRES_DEMO_IDS.scoutParticipant,
          displayName: "塞娜",
        }],
        actionResolver: createDeterministicActionResolver({
          allowStatefulReceipts: true,
        }),
      }),
    });

    const initial = await service.loadRecord();
    const committed = await service.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "先不要拆信，检查信使离开的方向。",
      idempotencyKey: "mempipe-extraction-failure",
      writeToken: initial.writeToken,
    });
    assert.equal(committed.disposition, "committed");
    assert.equal(committed.record.events.length, 4);

    // 等待后台萃取结束：失败只留日志，不落任何 conclusions。
    await memorySync.idle();
    assert.ok(
      warnings.some((line) => line.includes("extraction offline")),
      "萃取失败必须留下 warn 日志",
    );
    const observations = await ownerPool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM observations`,
    );
    assert.ok(observations.rows[0]!.count > 0, "回合提交照常写入 observations");
    assert.equal(await countConclusions(ownerPool), 0);
  },
);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^realm_mempipe_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
