/**
 * record 交付投影 baseline 曲线（一次性脚本，不入测试门）。
 * 场景：demo record + N 条合成事件（N ∈ 100/500/1000，每档独立临时库），
 * loadForPlayer 全投影的耗时/查询数/payload 字节。当前行为为全量
 * EVENTS_SQL 投影（无增量协议）——本脚本只测量 before 基线，不改生产。
 *
 * 用法：DATABASE_URL=postgresql://<role>@127.0.0.1:<port>/postgres \
 *   node scripts/record-projection-baseline.mjs
 * 输出：stdout 为 machine-readable JSON（含 human summary 字段）；
 * 不打印连接串/端口/用户名/错误原文。
 */
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import {
  createPostgresDeliveryProjectionRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import {
  assertLoopbackDatabaseUrl,
  createCountingPool,
  safeErrorCategory,
  summarizeDurations,
} from "./baseline-common.mjs";

const RUNS_PER_SCALE = 20;
const SCALES = [100, 500, 1000];

const connectionString = assertLoopbackDatabaseUrl(process.env.DATABASE_URL);
const maintenanceUrl = new URL(connectionString.href);
maintenanceUrl.pathname = "/postgres";
const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
await maintenance.connect();

const createdDatabases = [];

async function runScale(eventTarget) {
  const databaseName = `realm_proj_perf_${Math.random().toString(36).slice(2, 10)}`;
  createdDatabases.push(databaseName);
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  const dbUrl = new URL(connectionString.href);
  dbUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: dbUrl.href, max: 2 });
  const counting = createCountingPool(pool);
  try {
    // ---- setup（迁移 + seed + 合成事件；与 measured 查询严格分开）----
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await counting.pool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(counting.pool);

    const meta = await counting.pool.query(
      `SELECT record.world_id, record.worldline_id, scene.id AS scene_id,
              policy.id AS policy_id, world.calendar_id
       FROM records AS record
       JOIN worlds AS world ON world.workspace_id = record.workspace_id AND world.id = record.world_id
       JOIN LATERAL (SELECT id FROM scenes WHERE workspace_id = record.workspace_id AND record_id = record.id ORDER BY start_tick ASC LIMIT 1) AS scene ON true
       JOIN LATERAL (SELECT id FROM visibility_policies WHERE workspace_id = record.workspace_id AND record_id = record.id LIMIT 1) AS policy ON true
       WHERE record.workspace_id = $1 AND record.id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.recordId],
    );
    const ctx = meta.rows[0];
    const existing = await counting.pool.query(
      `SELECT count(*)::int AS count, COALESCE(max(record_ordinal), 0)::int AS max_ordinal,
              COALESCE(max(world_ordinal), 0)::int AS max_world_ordinal
       FROM events WHERE workspace_id = $1 AND record_id = $2`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.recordId],
    );
    const baseOrdinal = existing.rows[0].max_ordinal;
    const baseWorldOrdinal = existing.rows[0].max_world_ordinal;
    const seedEvents = existing.rows[0].count;
    const toInsert = Math.max(0, eventTarget - seedEvents);
    const BATCH = 250;
    for (let offset = 0; offset < toInsert; offset += BATCH) {
      const values = [];
      const upper = Math.min(offset + BATCH, toInsert);
      for (let index = offset + 1; index <= upper; index += 1) {
        values.push(`('${LOCAL_RECORD_SCOPE.workspaceId}', '${ctx.world_id}', '${ctx.worldline_id}', '${LOCAL_RECORD_SCOPE.recordId}', '${ctx.scene_id}', 'event_perf_${index}', 2, ${baseOrdinal + index}, ${index}, 'narration.committed', NULL, '旁白', '性能合成事件', '{}'::jsonb, '${ctx.policy_id}', 17, ${baseWorldOrdinal + index}, '${ctx.calendar_id}', '测试')`);
      }
      await counting.pool.query(
        `INSERT INTO events (workspace_id, world_id, worldline_id, record_id, scene_id, id, record_version, record_ordinal, batch_index, event_kind, actor_participant_id, speaker_name, content, payload, visibility_policy_id, world_tick, world_ordinal, calendar_id, display_time) VALUES ${values.join(",")}`,
      );
    }
    const setupQueries = counting.state.queries;

    // ---- measured（warm runs；建库/迁移/编译不在此列）----
    const projection = createPostgresDeliveryProjectionRepository(counting.pool);
    // 首轮 warm-up（不计入）：让连接/计划稳定。
    await projection.loadForPlayer(LOCAL_RECORD_SCOPE);
    const durations = [];
    let measuredQueries = 0;
    let payloadBytes = 0;
    let actualEvents = 0;
    for (let run = 0; run < RUNS_PER_SCALE; run += 1) {
      const before = counting.state.queries;
      const start = performance.now();
      const snapshot = await projection.loadForPlayer(LOCAL_RECORD_SCOPE);
      durations.push(performance.now() - start);
      measuredQueries += counting.state.queries - before;
      actualEvents = snapshot.events.length;
      payloadBytes = Buffer.byteLength(JSON.stringify(snapshot));
    }
    return {
      targetEvents: eventTarget,
      actualEvents,
      runs: RUNS_PER_SCALE,
      setupQueries,
      warmupRuns: 1,
      measuredQueriesTotal: measuredQueries,
      queriesPerRun: Number((measuredQueries / RUNS_PER_SCALE).toFixed(2)),
      payloadBytes,
      ...summarizeDurations(durations),
    };
  } finally {
    await pool.end();
  }
}

try {
  const scales = [];
  for (const scale of SCALES) {
    scales.push(await runScale(scale));
  }
  const report = {
    scenario: "record-projection-loadForPlayer",
    behavior: "full-projection: EVENTS_SQL 全量扫描 + 内存投影（无增量协议）",
    runsPerScale: RUNS_PER_SCALE,
    scales,
  };
  console.log(JSON.stringify(report, null, 2));
  for (const scale of scales) {
    console.error(
      `[summary] events=${scale.actualEvents} runs=${scale.runs} `
      + `queries/run=${scale.queriesPerRun} payload=${scale.payloadBytes}B `
      + `avg=${scale.avgMs}ms p50=${scale.p50Ms}ms p95=${scale.p95Ms}ms`,
    );
  }
} catch (error) {
  console.error(`[baseline] failed: ${safeErrorCategory(error)}`);
  process.exitCode = 1;
} finally {
  for (const databaseName of createdDatabases) {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
  }
  await maintenance.end();
}
