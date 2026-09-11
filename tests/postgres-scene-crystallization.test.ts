import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresActionAffordanceCatalog,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  createPostgresSceneCrystallizationStore,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import type { SceneCrystallizer } from "../modules/application/scene-crystallization.ts";
import {
  createLocalM2TurnOrchestrator,
  type M2TurnCandidate,
  type M2TurnPlan,
  type M2TurnValidation,
  type TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

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

const CRYSTALLIZATION_SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  recordId: POSTGRES_DEMO_IDS.record,
  calendarId: "truce_calendar",
  publicPolicyId: POSTGRES_DEMO_IDS.publicPolicy,
} as const;

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_scene_test_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });

  const runtimeUrl = new URL(runtimeConnectionString!);
  runtimeUrl.pathname = `/${databaseName}`;
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });

  t.after(async () => {
    await ownerPool.end();
    await runtimePool.end();
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
  return { ownerPool, runtimePool };
}

async function eventually(
  check: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("condition was not met in time");
}

test(
  "scene crystallization store writes approved deltas and audits rejections",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    // 全部写入路径走受限 realm_runtime 角色，验证 0014 授权真实存在。
    const store = createPostgresSceneCrystallizationStore(runtimePool);
    const projection = createPostgresDeliveryProjectionRepository(ownerPool);
    const demoScope = {
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      recordId: POSTGRES_DEMO_IDS.record,
      principalId: POSTGRES_DEMO_IDS.principal,
    };

    const baseline = await projection.loadForPlayer(demoScope);
    assert.ok(baseline);
    assert.equal(baseline.scene.location, "灰鲸港 · 北防波堤");
    const baselineScenes = await ownerPool.query(
      `SELECT count(*)::int AS count FROM scenes
       WHERE workspace_id = $1 AND record_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
    );

    await store.applyDelta(CRYSTALLIZATION_SCOPE, {
      location: "灯塔值房",
      weather: "雪",
      displayTime: "停战纪元17年 · 雾月13日 · 清晨",
      objective: "询问灯塔看守",
    });

    // append-oriented：新增场景行而不是改写旧行，未变字段继承。
    const scenes = await ownerPool.query(
      `SELECT id, location, objective FROM scenes
       WHERE workspace_id = $1 AND record_id = $2
       ORDER BY start_tick ASC, start_ordinal ASC, id ASC`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
    );
    assert.equal(scenes.rows.length, baselineScenes.rows[0].count + 1);
    const latestScene = scenes.rows.at(-1)!;
    assert.equal(latestScene.location, "灯塔值房");
    assert.equal(latestScene.objective, "询问灯塔看守");

    // 世界状态合入 worlds.settings，未提及的 era 保持原样。
    const world = await ownerPool.query(
      `SELECT settings FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.world],
    );
    assert.equal(world.rows[0].settings.weather, "雪");
    assert.equal(
      world.rows[0].settings.displayTime,
      "停战纪元17年 · 雾月13日 · 清晨",
    );
    assert.ok(world.rows[0].settings.era);

    // 投影按游标选中最新的场景行，结晶事件进入时间线。
    const delivered = await projection.loadForPlayer(demoScope);
    assert.ok(delivered);
    assert.equal(delivered.scene.location, "灯塔值房");
    assert.equal(delivered.scene.weather, "雪");
    assert.equal(delivered.scene.objective, "询问灯塔看守");
    assert.equal(
      delivered.scene.worldTime,
      "停战纪元17年 · 雾月13日 · 清晨",
    );
    const crystallizationEvent = delivered.events.find(
      (event) => event.content.includes("场景定格"),
    );
    assert.ok(crystallizationEvent);
    assert.equal(crystallizationEvent.role, "system");
    assert.ok(delivered.version > baseline.version);

    // 裁决拒绝：只写审计，不落场景。
    await store.recordRejection({
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      model: "fake-model",
      playerText: "时间倒流回雾月初一。",
      turnSummary: "旁白：雾没有动。",
      delta: { displayTime: "停战纪元17年 · 雾月1日 · 清晨" },
      reason: "时间倒退且非回溯叙事",
    });
    const audits = await ownerPool.query(
      `SELECT result FROM semantic_conflict_evaluations
       WHERE workspace_id = $1 AND prompt_version = 'scene-crystallization/v1'`,
      [POSTGRES_DEMO_IDS.workspace],
    );
    assert.equal(audits.rows.length, 1);
    assert.equal(audits.rows[0].result.approved, false);
    assert.equal(audits.rows[0].result.reason, "时间倒退且非回溯叙事");
    const scenesAfterRejection = await ownerPool.query(
      `SELECT count(*)::int AS count FROM scenes
       WHERE workspace_id = $1 AND record_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
    );
    assert.equal(scenesAfterRejection.rows[0].count, scenes.rows.length);

    // append-only 姿态：realm_runtime 不得 UPDATE 既有场景行。
    await assert.rejects(
      runtimePool.query(
        `UPDATE scenes SET location = '改写' WHERE workspace_id = $1`,
        [POSTGRES_DEMO_IDS.workspace],
      ),
    );
  },
);

test(
  "submitted turns trigger crystallization only after adjudication approval",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    let behavior: "approve" | "reject" = "approve";
    const crystallizer: SceneCrystallizer = {
      async extract() {
        return behavior === "approve"
          ? { delta: { location: "灯塔值房" }, worldClaims: [], characterNotes: [] }
          : {
              delta: { displayTime: "停战纪元17年 · 雾月1日 · 清晨" },
              worldClaims: [],
              characterNotes: [],
            };
      },
      async adjudicate() {
        return behavior === "approve"
          ? { approved: true, reason: "动线相容", adjusted: null, model: "fake" }
          : {
              approved: false,
              reason: "时间倒退且非回溯叙事",
              adjusted: null,
              model: "fake",
            };
      },
    };

    let sequence = 0;
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
      pool: ownerPool,
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
    const projection = createPostgresDeliveryProjectionRepository(ownerPool);
    const recordService = createLocalRecordService({
      repository,
      projection,
      actionCatalog: createPostgresActionAffordanceCatalog(ownerPool),
      runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(ownerPool),
      sceneCrystallizationStore: createPostgresSceneCrystallizationStore(runtimePool),
      sceneCrystallizer: crystallizer,
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `scene-token-${++sequence}`,
        clock: () => new Date("2026-08-15T05:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-15T05:00:00.000Z"),
      idFactory: () => `scene-${++sequence}`,
      orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
        characters: scope.aiCharacters,
      }),
    });

    // 裁决通过：回合落库后场景结晶异步写回。
    const first = await recordService.loadRecord(POSTGRES_DEMO_IDS.record);
    const committed = await recordService.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "我们离开防波堤，走进灯塔值房。",
      idempotencyKey: "scene-crystallization-approve",
      writeToken: first.writeToken,
    });
    assert.equal(committed.disposition, "committed");
    await eventually(async () => {
      const delivered = await projection.loadForPlayer({
        workspaceId: POSTGRES_DEMO_IDS.workspace,
        recordId: POSTGRES_DEMO_IDS.record,
        principalId: POSTGRES_DEMO_IDS.principal,
      });
      return delivered?.scene.location === "灯塔值房";
    });
    const scenesAfterApproval = await ownerPool.query(
      `SELECT count(*)::int AS count FROM scenes
       WHERE workspace_id = $1 AND record_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
    );

    // 裁决拒绝：审计落库，场景不动。
    behavior = "reject";
    const second = await recordService.loadRecord(POSTGRES_DEMO_IDS.record);
    const rejectedTurn = await recordService.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "忽然之间，时间倒流回雾月初一的清晨。",
      idempotencyKey: "scene-crystallization-reject",
      writeToken: second.writeToken,
    });
    assert.equal(rejectedTurn.disposition, "committed");
    await eventually(async () => {
      const audits = await ownerPool.query(
        `SELECT count(*)::int AS count FROM semantic_conflict_evaluations
         WHERE workspace_id = $1 AND prompt_version = 'scene-crystallization/v1'`,
        [POSTGRES_DEMO_IDS.workspace],
      );
      return audits.rows[0].count === 1;
    });
    const delivered = await projection.loadForPlayer({
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      recordId: POSTGRES_DEMO_IDS.record,
      principalId: POSTGRES_DEMO_IDS.principal,
    });
    assert.equal(delivered?.scene.location, "灯塔值房");
    assert.notEqual(
      delivered?.scene.worldTime,
      "停战纪元17年 · 雾月1日 · 清晨",
    );
    const scenesAfterRejection = await ownerPool.query(
      `SELECT count(*)::int AS count FROM scenes
       WHERE workspace_id = $1 AND record_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
    );
    assert.equal(scenesAfterRejection.rows[0].count, scenesAfterApproval.rows[0].count);
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
  if (!/^realm_scene_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
