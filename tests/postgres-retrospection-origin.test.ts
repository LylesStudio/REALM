/**
 * 批次 T12-A——重演起点语义与隔离（T12 设计记录 §一）。
 * 真实临时 PG 库（t.after 强制拆库，迁移 0001–0040 全链）：
 * 源 Record 推进到非初始状态（场景流转 + 游标推进 + settings 推进）后
 * duplicate——新 Record 必须从源自身 start 起点开始（游标/首个 scene/
 * tension/objective/weather/display_time 快照），不等于源最新状态；两
 * Record 后续推进相互隔离；archived 源 fail-closed。零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresSceneCrystallizationStore,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createPostgresLibraryService } from "../modules/application/library-service.ts";

const adminConnectionString = process.env.DATABASE_URL;

const MIGRATIONS = [
  "0001_runtime_contract.sql",
  "0002_runtime_contract_hardening.sql",
  "0003_runtime_repository.sql",
  "0004_runtime_security_hardening.sql",
  "0005_hybrid_memory.sql",
  "0006_action_state_ledger.sql",
  "0007_dynamic_visibility_policies.sql",
  "0008_record_timeline_kind.sql",
  "0009_memory_m3_completion.sql",
  "0010_world_governance.sql",
  "0011_worldline_merge_semantic_propagation_jobs.sql",
  "0012_accounts.sql",
  "0013_membership_insert_grant.sql",
  "0014_scene_crystallization_grants.sql",
  "0015_account_ui_language.sql",
  "0016_world_files.sql",
  "0017_account_last_opened.sql",
  "0018_account_last_opened_fk_set_null.sql",
  "0019_record_first_nights.sql",
  "0020_record_self_play_sessions.sql",
  "0021_world_admin.sql",
  "0022_worldline_merge_grants.sql",
  "0023_library_runtime_grants.sql",
  "0024_graph_invalidation_events.sql",
  "0025_propagation_topology_semantic_scope.sql",
  "0026_canon_security_audience.sql",
  "0027_propagation_node_audiences.sql",
  "0028_propagation_node_audiences_owner_append.sql",
  "0029_record_scene_tension.sql",
  "0030_character_instance_state.sql",
  "0031_keen_insight_discovery.sql",
  "0032_character_activity_grants.sql",
  "0033_base_skill_metadata_grant.sql",
  "0034_revoke_broad_skill_metadata_grant.sql",
  "0035_keen_insight_concrete_discovery.sql",
  "0036_keen_insight_location_context.sql",
  "0037_record_archive_grant.sql",
  "0038_remove_base_skill_hidden_clue.sql",
  "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
];

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  recordId: POSTGRES_DEMO_IDS.record,
};

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

test(
  "T12-A: retrospection starts from the source record origin and stays isolated",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t12_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });

    t.after(async () => {
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of MIGRATIONS) {
      const sql = await readFile(
        new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await ownerPool.query(sql);
    }
    await seedPostgresDemo(ownerPool);

    // 源 Record 的起点（DB 实读，不硬编码）。
    const originRow = await ownerPool.query(
      `SELECT start_tick::text AS tick, start_ordinal::text AS ordinal
       FROM records WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.recordId],
    );
    const originTick = Number(originRow.rows[0].tick);
    const originOrdinal = Number(originRow.rows[0].ordinal);

    // 推进源 Record 到非初始状态：场景流转行 + 游标推进 + 世界级 settings
    // 推进（模拟结晶效果：location/objective/tension/weather/display_time 全部变化）。
    await ownerPool.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, tension, weather, display_time,
         start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, '灯塔值房', 'active',
         '灯塔值房', '查明钟鸣来源', '风暴将至', '暴雪', '雪夜·三更',
         $6::bigint, $7::bigint)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.recordId,
        newId("scene"),
        originTick + 10,
        1,
      ],
    );
    await ownerPool.query(
      `UPDATE record_heads
       SET last_world_tick = $3, last_world_ordinal = 1, record_version = 7
       WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, SCOPE.recordId, originTick + 10],
    );
    await ownerPool.query(
      `UPDATE worlds
       SET settings = settings || '{"weather":"暴雪","tension":"风暴将至","displayTime":"雪夜·三更"}'::jsonb
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );

    const service = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
    };
    const duplicated = await service.duplicateRecord(scope, SCOPE.recordId);

    // 1. 游标：新 worldline head / record start / record_heads 全部等于源
    //    自身 start 起点，而不是源推进后的头部。
    const retroRecord = await ownerPool.query(
      `SELECT worldline_id, start_tick::text AS start_tick,
              start_ordinal::text AS start_ordinal
       FROM records WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, duplicated.recordId],
    );
    const retroLine = retroRecord.rows[0].worldline_id as string;
    const retroHead = await ownerPool.query(
      `SELECT last_world_tick::text AS tick, last_world_ordinal::text AS ordinal
       FROM record_heads
       WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, duplicated.recordId],
    );
    const worldlineRow = (await ownerPool.query(
      `SELECT head_tick::text AS tick, head_ordinal::text AS ordinal
       FROM worldlines WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, retroLine],
    )).rows[0];
    assert.equal(Number(retroRecord.rows[0].start_tick), originTick, "record start_tick 必须是源起点");
    assert.equal(Number(retroRecord.rows[0].start_ordinal), originOrdinal, "record start_ordinal 必须是源起点");
    assert.equal(Number(retroHead.rows[0].tick), originTick, "record_heads 游标必须是源起点而非源最新");
    assert.equal(Number(retroHead.rows[0].ordinal), originOrdinal);
    assert.equal(Number(worldlineRow.tick), originTick, "worldline head 必须是源起点");
    assert.equal(Number(worldlineRow.ordinal), originOrdinal);
    assert.notEqual(Number(retroHead.rows[0].tick), originTick + 10, "不得继承源推进后的游标");

    // 2. 开场 scene：复制源首个 scene（起点），不是源推进后的场景。
    const retroScene = await ownerPool.query(
      `SELECT location, objective, tension, weather, display_time,
              start_tick::text AS tick, start_ordinal::text AS ordinal
       FROM scenes
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY start_tick ASC, start_ordinal ASC, created_at ASC
       LIMIT 1`,
      [SCOPE.workspaceId, duplicated.recordId],
    );
    const originScene = await ownerPool.query(
      `SELECT location, objective, tension, weather, display_time
       FROM scenes
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY start_tick ASC, start_ordinal ASC, created_at ASC
       LIMIT 1`,
      [SCOPE.workspaceId, SCOPE.recordId],
    );
    assert.equal(retroScene.rows[0].location, originScene.rows[0].location, "地点必须是源起点场景");
    assert.equal(retroScene.rows[0].objective, originScene.rows[0].objective, "目标必须是源起点场景");
    assert.equal(retroScene.rows[0].tension, originScene.rows[0].tension, "局势必须是源起点场景");
    assert.equal(retroScene.rows[0].display_time, originScene.rows[0].display_time, "世界时间必须是源起点场景");
    assert.notEqual(retroScene.rows[0].location, "灯塔值房", "不得继承源推进后的场景");
    assert.notEqual(retroScene.rows[0].objective, "查明钟鸣来源");
    assert.notEqual(retroScene.rows[0].tension, "风暴将至");
    assert.notEqual(retroScene.rows[0].display_time, "雪夜·三更", "不得继承源推进后的世界时间");
    assert.equal(Number(retroScene.rows[0].tick), originTick, "开场 scene 游标必须是源起点");

    // 3. weather 快照隔离：0039 后装配的 Record 落快照——推进世界 weather
    //    后，快照不随 settings 变化；projection 回退链不抢快照。
    //    用一个 0039 后装配的新 Record 证明端到端快照语义。
    const freshWorldline = `worldline_${newId("wl")}`;
    const freshStory = `story_${newId("st")}`;
    const freshRecord = `record_${newId("rc")}`;
    await ownerPool.query(
      `UPDATE worlds SET settings = settings || '{"weather":"初雪"}'::jsonb
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, 'fresh', 'active', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, freshWorldline],
    );
    await ownerPool.query(
      `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, 'fresh', 'active', '', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, freshWorldline, freshStory],
    );
    await ownerPool.query(
      `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal, timeline_kind)
       VALUES ($1, $2, $3, $4, $5, 'fresh', 'active', 0, 0, 'primary')`,
      [SCOPE.workspaceId, SCOPE.worldId, freshWorldline, freshStory, freshRecord],
    );
    await ownerPool.query(
      `INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal, last_world_tick, last_world_ordinal)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, freshWorldline, freshRecord],
    );
    // 0039 后装配路径（assembleDefaultRecord）落 weather 快照。
    await ownerPool.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, tension, weather, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, '开场', 'active', '雾港', '起航', '潮起', '初雪', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, freshWorldline, freshRecord, newId("scene")],
    );
    await ownerPool.query(
      `UPDATE worlds SET settings = settings || '{"weather":"暴雪"}'::jsonb
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    const snapshotCheck = await ownerPool.query(
      `SELECT weather FROM scenes WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, freshRecord],
    );
    assert.equal(snapshotCheck.rows[0].weather, "初雪", "scene weather 快照不随 settings 推进变化");

    // 4. 双向隔离：源继续推进不影响重演；重演推进不反向污染源。
    await ownerPool.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, tension, weather, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, '源新场景', 'active',
         '源新地点', '源新目标', '源新局势', '源新天气', $6::bigint, 1)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.recordId,
        newId("scene"),
        originTick + 20,
      ],
    );
    const retroSceneAfterSourceAdvance = await ownerPool.query(
      `SELECT count(*)::int AS c, max(location) AS loc FROM scenes
       WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, duplicated.recordId],
    );
    assert.equal(retroSceneAfterSourceAdvance.rows[0].c, 1, "源推进后重演 scene 不得变化");
    assert.notEqual(retroSceneAfterSourceAdvance.rows[0].loc, "源新地点");

    await ownerPool.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, tension, weather, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, '重演新场景', 'active',
         '重演新地点', '重演新目标', '重演新局势', '重演新天气', $6::bigint, 1)`,
      [
        SCOPE.workspaceId,
        duplicated.worldId,
        retroLine,
        duplicated.recordId,
        newId("scene"),
        originTick + 1,
      ],
    );
    const sourceSceneAfterRetroAdvance = await ownerPool.query(
      `SELECT count(*)::int AS c FROM scenes
       WHERE workspace_id = $1 AND record_id = $2 AND location = '重演新地点'`,
      [SCOPE.workspaceId, SCOPE.recordId],
    );
    assert.equal(sourceSceneAfterRetroAdvance.rows[0].c, 0, "重演推进不得反向写入源 Record");
    const sourceWorldlineScenes = await ownerPool.query(
      `SELECT count(*)::int AS c FROM scenes
       WHERE workspace_id = $1 AND worldline_id = $2 AND location = '重演新地点'`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    );
    assert.equal(sourceWorldlineScenes.rows[0].c, 0, "重演推进不得写入源世界线");

    // 5. fail-closed：archived 源 Record 不得 duplicate。
    await ownerPool.query(
      `UPDATE records SET status = 'archived'
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.recordId],
    );
    await assert.rejects(
      service.duplicateRecord(scope, SCOPE.recordId),
      /Record not found/,
      "archived 源 Record 必须 fail-closed",
    );
  },
);

test(
  "T12 review fix: display_time snapshot, weather/time-only scene flow, legacy fail-closed",
  { skip: !adminConnectionString, timeout: 120_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t12dt_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });

    t.after(async () => {
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of MIGRATIONS) {
      const sql = await readFile(
        new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await ownerPool.query(sql);
    }
    await seedPostgresDemo(ownerPool);

    const service = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
    };
    const projection = createPostgresDeliveryProjectionRepository(ownerPool);
    const runtimeScope = createPostgresRecordRuntimeScopeRepository(ownerPool);
    const crystallization = createPostgresSceneCrystallizationStore(ownerPool);

    // 起点世界级值（确定性）：装配将把它们落成首个 scene 的快照。
    await ownerPool.query(
      `UPDATE worlds SET settings = settings || '{"displayTime":"停战纪元17年·春","weather":"晴"}'::jsonb
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );

    // 独立世界线 + 故事（手工），Record 走 service.create 完整装配（含阵容）。
    const worldlineId = newId("worldline");
    const storyId = newId("story");
    await ownerPool.query(
      `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
       VALUES ($1, $2, $3, '修正验证线', 'active', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, worldlineId],
    );
    await ownerPool.query(
      `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
       VALUES ($1, $2, $3, $4, '修正验证故事', 'active', '', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, worldlineId, storyId],
    );
    await service.create(scope, {
      kind: "record",
      storyId,
      title: "修正验证记录",
    });
    const created = await ownerPool.query(
      `SELECT id FROM records WHERE workspace_id = $1 AND story_id = $2`,
      [SCOPE.workspaceId, storyId],
    );
    const recordId = created.rows[0].id as string;

    // 证据 1：源 Record 初始 scene 带 weather + display_time 快照。
    const initialScene = await ownerPool.query(
      `SELECT location, objective, tension, weather, display_time
       FROM scenes WHERE workspace_id = $1 AND record_id = $2
       ORDER BY start_tick ASC, start_ordinal ASC, created_at ASC LIMIT 1`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(initialScene.rows[0].weather, "晴", "初始 scene 必须落 weather 快照");
    assert.equal(initialScene.rows[0].display_time, "停战纪元17年·春", "初始 scene 必须落 display_time 快照");

    const calendarId = (await ownerPool.query(
      `SELECT calendar_id FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    )).rows[0].calendar_id as string;
    const publicPolicyId = (await ownerPool.query(
      `SELECT id FROM visibility_policies
       WHERE workspace_id = $1 AND record_id = $2 AND policy_kind = 'public'
       ORDER BY policy_version ASC, id ASC LIMIT 1`,
      [SCOPE.workspaceId, recordId],
    )).rows[0].id as string;
    const crystalScope = {
      workspaceId: SCOPE.workspaceId,
      worldId: SCOPE.worldId,
      worldlineId,
      recordId,
      calendarId,
      publicPolicyId,
    };

    // 证据 2：源 Record 推进到新 scene——location/objective/tension/weather/
    // displayTime 全部变化，world settings 同步推进。
    await crystallization.applyDelta(crystalScope, {
      location: "灯塔值房",
      objective: "查明钟鸣来源",
      tension: "风暴将至",
      weather: "暴雪",
      displayTime: "雪夜·三更",
    });
    const settingsAfterAdvance = await ownerPool.query(
      `SELECT settings->>'weather' AS weather, settings->>'displayTime' AS display_time
       FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    assert.equal(settingsAfterAdvance.rows[0].weather, "暴雪");
    assert.equal(settingsAfterAdvance.rows[0].display_time, "雪夜·三更");

    // 证据 3：duplicate 后新 Record 每个起点字段都等于源首个 scene，而不是
    // 源最新值/当前 world settings。
    const duplicated = await service.duplicateRecord(scope, recordId);
    const retroFirstScene = await ownerPool.query(
      `SELECT location, objective, tension, weather, display_time
       FROM scenes WHERE workspace_id = $1 AND record_id = $2
       ORDER BY start_tick ASC, start_ordinal ASC, created_at ASC LIMIT 1`,
      [SCOPE.workspaceId, duplicated.recordId],
    );
    assert.equal(retroFirstScene.rows[0].location, initialScene.rows[0].location);
    assert.equal(retroFirstScene.rows[0].objective, initialScene.rows[0].objective);
    assert.equal(retroFirstScene.rows[0].tension, initialScene.rows[0].tension);
    assert.equal(retroFirstScene.rows[0].weather, "晴", "重演起点天气必须是首个 scene 快照");
    assert.equal(retroFirstScene.rows[0].display_time, "停战纪元17年·春", "重演起点时间必须是首个 scene 快照");
    assert.notEqual(retroFirstScene.rows[0].weather, "暴雪");
    assert.notEqual(retroFirstScene.rows[0].display_time, "雪夜·三更");
    const retroProjection = await projection.loadDeliveryForPlayer({
      workspaceId: SCOPE.workspaceId,
      recordId: duplicated.recordId,
      principalId: POSTGRES_DEMO_IDS.principal,
    });
    assert.equal(retroProjection?.record.scene.weather, "晴", "projection 天气必须是起点快照");
    assert.equal(
      retroProjection?.record.world.timeCursor,
      "停战纪元17年·春",
      "projection 世界时间必须是起点快照而非当前 settings",
    );

    // 证据 4：只改 weather / 只改 displayTime 也必须各自产生新 scene 快照，
    // 且未变字段继承上一 scene 快照（先于 settings）。
    const sceneCountBefore = (await ownerPool.query(
      `SELECT count(*)::int AS c FROM scenes WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, recordId],
    )).rows[0].c as number;
    // 先把 settings 改成「污染值」：若快照继承错误地回退 settings 就会露馅。
    await ownerPool.query(
      `UPDATE worlds SET settings = settings || '{"displayTime":"污染·时间","weather":"污染·天气"}'::jsonb
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    );
    await crystallization.applyDelta(crystalScope, { weather: "微风" });
    const afterWeatherOnly = await ownerPool.query(
      `SELECT weather, display_time FROM scenes
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY start_tick DESC, start_ordinal DESC, id ASC LIMIT 1`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(
      (await ownerPool.query(
        `SELECT count(*)::int AS c FROM scenes WHERE workspace_id = $1 AND record_id = $2`,
        [SCOPE.workspaceId, recordId],
      )).rows[0].c,
      sceneCountBefore + 1,
      "只改 weather 必须产生新 scene 快照",
    );
    assert.equal(afterWeatherOnly.rows[0].weather, "微风");
    assert.equal(afterWeatherOnly.rows[0].display_time, "雪夜·三更", "未变字段继承上一 scene 快照而非 settings");
    const weatherOnlyProjection = await projection.loadDeliveryForPlayer({
      workspaceId: SCOPE.workspaceId,
      recordId,
      principalId: POSTGRES_DEMO_IDS.principal,
    });
    assert.equal(weatherOnlyProjection?.record.scene.weather, "微风");
    assert.equal(
      weatherOnlyProjection?.record.world.timeCursor,
      "雪夜·三更",
      "weather-only 流转后 projection 时间不得回退 settings 污染值",
    );

    await crystallization.applyDelta(crystalScope, { displayTime: "停战纪元17年·夏" });
    const afterTimeOnly = await ownerPool.query(
      `SELECT weather, display_time FROM scenes
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY start_tick DESC, start_ordinal DESC, id ASC LIMIT 1`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(
      (await ownerPool.query(
        `SELECT count(*)::int AS c FROM scenes WHERE workspace_id = $1 AND record_id = $2`,
        [SCOPE.workspaceId, recordId],
      )).rows[0].c,
      sceneCountBefore + 2,
      "只改 displayTime 必须产生新 scene 快照",
    );
    assert.equal(afterTimeOnly.rows[0].display_time, "停战纪元17年·夏");
    assert.equal(afterTimeOnly.rows[0].weather, "微风", "displayTime-only 流转不得污染 weather 快照");
    const timeOnlyProjection = await projection.loadDeliveryForPlayer({
      workspaceId: SCOPE.workspaceId,
      recordId,
      principalId: POSTGRES_DEMO_IDS.principal,
    });
    assert.equal(timeOnlyProjection?.record.world.timeCursor, "停战纪元17年·夏");
    assert.equal(timeOnlyProjection?.record.scene.weather, "微风");

    // 证据 5：双向隔离——源再推进不影响重演；重演推进不反向改写源快照。
    await crystallization.applyDelta(crystalScope, { location: "源新地点" });
    const retroScenesAfterSource = await ownerPool.query(
      `SELECT count(*)::int AS c FROM scenes WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, duplicated.recordId],
    );
    assert.equal(retroScenesAfterSource.rows[0].c, 1, "源推进后重演 scene 不得变化");
    const retroLine = (await ownerPool.query(
      `SELECT worldline_id FROM records WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, duplicated.recordId],
    )).rows[0].worldline_id as string;
    const retroPolicyId = (await ownerPool.query(
      `SELECT id FROM visibility_policies
       WHERE workspace_id = $1 AND record_id = $2 AND policy_kind = 'public'
       ORDER BY policy_version ASC, id ASC LIMIT 1`,
      [SCOPE.workspaceId, duplicated.recordId],
    )).rows[0].id as string;
    await crystallization.applyDelta(
      { ...crystalScope, worldlineId: retroLine, recordId: duplicated.recordId, publicPolicyId: retroPolicyId },
      { weather: "重演暴雪", displayTime: "重演·黎明" },
    );
    const sourceLatest = await ownerPool.query(
      `SELECT weather, display_time FROM scenes
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY start_tick DESC, start_ordinal DESC, id ASC LIMIT 1`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(sourceLatest.rows[0].weather, "微风", "重演推进不得反向改写源 scene 快照");
    assert.equal(sourceLatest.rows[0].display_time, "停战纪元17年·夏");
    const retroLatestProjection = await projection.loadDeliveryForPlayer({
      workspaceId: SCOPE.workspaceId,
      recordId: duplicated.recordId,
      principalId: POSTGRES_DEMO_IDS.principal,
    });
    assert.equal(retroLatestProjection?.record.scene.weather, "重演暴雪");
    assert.equal(retroLatestProjection?.record.world.timeCursor, "重演·黎明");

    // 证据 6：legacy retrospection（无快照行）不得回退 worlds.settings 的
    // 当前天气/时间——fail-closed 为空；primary 旧数据保留 settings 回退。
    async function insertLegacyRecord(timelineKind: string): Promise<string> {
      const legacyLine = newId("worldline");
      const legacyStory = newId("story");
      const legacyRecord = newId("record");
      await ownerPool.query(
        `INSERT INTO worldlines (workspace_id, world_id, id, label, status, head_tick, head_ordinal)
         VALUES ($1, $2, $3, 'legacy', 'active', 0, 0)`,
        [SCOPE.workspaceId, SCOPE.worldId, legacyLine],
      );
      await ownerPool.query(
        `INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal)
         VALUES ($1, $2, $3, $4, 'legacy', 'active', '', 0, 0)`,
        [SCOPE.workspaceId, SCOPE.worldId, legacyLine, legacyStory],
      );
      await ownerPool.query(
        `INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal, timeline_kind)
         VALUES ($1, $2, $3, $4, $5, 'legacy', 'active', 0, 0, $6)`,
        [SCOPE.workspaceId, SCOPE.worldId, legacyLine, legacyStory, legacyRecord, timelineKind],
      );
      await ownerPool.query(
        `INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal, last_world_tick, last_world_ordinal)
         VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
        [SCOPE.workspaceId, SCOPE.worldId, legacyLine, legacyRecord],
      );
      // 显式空快照：模拟 0039/0040 之前创建的 scene 行。
      await ownerPool.query(
        `INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, location, objective, tension, weather, display_time, start_tick, start_ordinal)
         VALUES ($1, $2, $3, $4, $5, 'legacy', 'active', '旧场景', '', '', '', '', 0, 0)`,
        [SCOPE.workspaceId, SCOPE.worldId, legacyLine, legacyRecord, newId("scene")],
      );
      await ownerPool.query(
        `INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind)
         VALUES ($1, $2, $3, $4, $5, 'public', 1, 'public')`,
        [SCOPE.workspaceId, SCOPE.worldId, legacyLine, legacyRecord, newId("policy")],
      );
      await ownerPool.query(
        `INSERT INTO participants (workspace_id, world_id, worldline_id, record_id, id, participant_kind, character_instance_id, principal_id, controller_mode, is_active, speaking_order)
         VALUES ($1, $2, $3, $4, $5, 'narrator', NULL, $6, 'human', true, 0)`,
        [SCOPE.workspaceId, SCOPE.worldId, legacyLine, legacyRecord, newId("participant"), POSTGRES_DEMO_IDS.principal],
      );
      return legacyRecord;
    }

    const legacyRetro = await insertLegacyRecord("retrospection");
    const legacyRetroProjection = await projection.loadDeliveryForPlayer({
      workspaceId: SCOPE.workspaceId,
      recordId: legacyRetro,
      principalId: POSTGRES_DEMO_IDS.principal,
    });
    assert.equal(legacyRetroProjection?.record.scene.weather, "", "无快照 retrospection 天气必须 fail-closed 为空");
    assert.equal(legacyRetroProjection?.record.world.timeCursor, "", "无快照 retrospection 时间不得显示当前 settings");
    const legacyRetroScope = await runtimeScope.resolve({
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: legacyRetro,
    });
    assert.equal(legacyRetroScope?.displayTime, "", "record-scope 无快照 retrospection displayTime 必须为空");
    assert.equal(legacyRetroScope?.brief.weather, "", "record-scope 无快照 retrospection weather 必须为空");

    const legacyPrimary = await insertLegacyRecord("primary");
    // primary 回退目标 = 当前 worlds.settings 实读值（此前演绎已推进过）。
    const currentSettings = (await ownerPool.query(
      `SELECT settings->>'weather' AS weather, settings->>'displayTime' AS display_time
       FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldId],
    )).rows[0];
    const legacyPrimaryProjection = await projection.loadDeliveryForPlayer({
      workspaceId: SCOPE.workspaceId,
      recordId: legacyPrimary,
      principalId: POSTGRES_DEMO_IDS.principal,
    });
    assert.equal(
      legacyPrimaryProjection?.record.scene.weather,
      currentSettings.weather,
      "primary 旧数据保留 worlds.settings 兼容回退",
    );
    assert.ok(currentSettings.weather.length > 0, "回退目标必须非空，防误断言空串");
    assert.equal(legacyPrimaryProjection?.record.world.timeCursor, currentSettings.display_time);
    const legacyPrimaryScope = await runtimeScope.resolve({
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      recordId: legacyPrimary,
    });
    assert.equal(legacyPrimaryScope?.displayTime, currentSettings.display_time);
    assert.equal(legacyPrimaryScope?.brief.weather, currentSettings.weather);
  },
);
