/**
 * 批次 T9 Canon 回读——PostgreSQL 集成测试（产生侧）
 * （docs/development/T9-CANON-READBACK.md §4.2）。
 * 覆盖：晶化 approved delta 入图谱（世界本体实体 upsert 幂等、白名单谓词
 * Claim 落库 record_confirmed、来源事件/游标正确、裁决拒绝零入图）、
 * /api/world-knowledge 与 /api/canon 显式 worldId（非 demo 世界读写正确、
 * 缺失 400、不存在 404、非成员 fail-closed）。
 */
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
  createPostgresWorldKnowledgeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import {
  crystallizationWorldEntityId,
  type SceneCrystallizer,
} from "../modules/application/scene-crystallization.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";
import { createLocalM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import {
  endSharedRuntimePools,
  resolveWorldScopeForMember,
} from "../app/api/world-scope.ts";
import {
  GET as knowledgeGET,
  POST as knowledgePOST,
} from "../app/api/world-knowledge/route.ts";
import {
  GET as canonGET,
  POST as canonPOST,
} from "../app/api/canon/route.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";

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

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_t9_test_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });

  const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
  // 路由级调用走本地回落身份：测试进程摘除门禁（用后还原）。
  const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
  delete process.env.REALM_ACCESS_TOKEN;

  t.after(async () => {
    await endSharedRuntimePools();
    if (previousAccessToken === undefined) {
      delete process.env.REALM_ACCESS_TOKEN;
    } else {
      process.env.REALM_ACCESS_TOKEN = previousAccessToken;
    }
    if (previousRuntimeUrl === undefined) {
      delete process.env.REALM_RUNTIME_DATABASE_URL;
    } else {
      process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
    }
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
  await ownerPool.query(
    `INSERT INTO accounts (workspace_id, principal_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, display_name) DO NOTHING`,
    [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.principalId, "测试旅人"],
  );
  return { ownerPool, runtimePool };
}

async function eventually(probe: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(false, "condition not met in time");
}

test(
  "T9 PG: approved crystallization flows into the world knowledge graph (idempotent entity, sourced claims)",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    let reject = false;
    const crystallizer: SceneCrystallizer = {
      async extract() {
        return reject
          ? { delta: { location: "不应入图" }, worldClaims: [], characterNotes: [] }
          : {
              delta: { location: "灯塔值房", weather: "浓雾" },
              worldClaims: [],
              characterNotes: [],
            };
      },
      async adjudicate() {
        return reject
          ? { approved: false, reason: "动线矛盾", adjusted: null, model: "fake" }
          : { approved: true, reason: "动线相容", adjusted: null, model: "fake" };
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
    const recordService = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(ownerPool),
      actionCatalog: createPostgresActionAffordanceCatalog(ownerPool),
      runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(ownerPool),
      sceneCrystallizationStore: createPostgresSceneCrystallizationStore(runtimePool),
      sceneCrystallizer: crystallizer,
      worldKnowledge: createWorldKnowledgeService(
        createPostgresWorldKnowledgeRepository(runtimePool),
      ),
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `t9-token-${++sequence}`,
        clock: () => new Date("2026-08-21T01:00:00.000Z"),
      }),
      clock: () => new Date("2026-08-21T01:00:00.000Z"),
      idFactory: () => `t9-${++sequence}`,
      orchestratorFactory: (scope) => createLocalM2TurnOrchestrator({
        characters: scope.aiCharacters,
      }),
    });

    // 第一回合：approved 晶化（location + weather）→ 实体 + 两条 Claim 入图。
    const first = await recordService.loadRecord(POSTGRES_DEMO_IDS.record);
    const committed = await recordService.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "我们离开防波堤，走进灯塔值房。",
      idempotencyKey: "t9-inflow-1",
      writeToken: first.writeToken,
    });
    assert.equal(committed.disposition, "committed");
    await eventually(async () => {
      const claims = await ownerPool.query(
        `SELECT count(*)::int AS count FROM world_claims WHERE world_id = $1`,
        [POSTGRES_DEMO_IDS.world],
      );
      return claims.rows[0].count === 2;
    });

    const entityId = crystallizationWorldEntityId(POSTGRES_DEMO_IDS.world);
    const entities = await ownerPool.query(
      `SELECT id, entity_kind, name FROM world_entities WHERE id = $1`,
      [entityId],
    );
    assert.equal(entities.rows.length, 1);
    assert.equal(entities.rows[0].entity_kind, "setting");
    assert.equal(entities.rows[0].name, "烬海诸国");

    const claims = await ownerPool.query(
      `SELECT predicate, object_value, scope, truth_status, confidence,
              source_record_id, source_event_id, valid_from_tick::text AS tick
       FROM world_claims WHERE world_id = $1 ORDER BY predicate ASC`,
      [POSTGRES_DEMO_IDS.world],
    );
    assert.deepEqual(
      claims.rows.map((row) => [row.predicate, row.object_value]),
      [["scene.location", "灯塔值房"], ["world.weather", "浓雾"]],
    );
    for (const row of claims.rows) {
      assert.equal(row.scope, "record");
      assert.equal(row.truth_status, "record_confirmed");
      assert.equal(Number(row.confidence), 1);
      assert.equal(row.source_record_id, POSTGRES_DEMO_IDS.record);
      // 来源事件是真实落库的晶化事件（source 证据链完整）。
      const event = await ownerPool.query(
        `SELECT event_kind, world_tick::text AS tick FROM events WHERE id = $1`,
        [row.source_event_id],
      );
      assert.equal(event.rows[0]?.event_kind, "system.correction.committed");
      assert.equal(row.tick, event.rows[0]?.tick);
    }

    // 第二回合（仍 approved）：实体 upsert 幂等（仍一行），Claim 追加。
    const second = await recordService.loadRecord(POSTGRES_DEMO_IDS.record);
    await recordService.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "我在值房里点起灯。",
      idempotencyKey: "t9-inflow-2",
      writeToken: second.writeToken,
    });
    await eventually(async () => {
      const claims = await ownerPool.query(
        `SELECT count(*)::int AS count FROM world_claims WHERE world_id = $1`,
        [POSTGRES_DEMO_IDS.world],
      );
      return claims.rows[0].count === 4;
    });
    const entitiesAfter = await ownerPool.query(
      `SELECT count(*)::int AS count FROM world_entities WHERE id = $1`,
      [entityId],
    );
    assert.equal(entitiesAfter.rows[0].count, 1, "entity upsert stays idempotent");

    // 批次 T11-A2（W8）：晶化入图谱经 repository 打点——失效账本应有
    // entity/claim 事件（upsert 幂等但每回合仍有一次 upsert 事件）。
    const inflowEvents = await ownerPool.query(
      `SELECT kind, count(*)::int AS count FROM graph_invalidation_events
       WHERE world_id = $1 GROUP BY kind ORDER BY kind`,
      [POSTGRES_DEMO_IDS.world],
    );
    assert.deepEqual(
      Object.fromEntries(inflowEvents.rows.map((row) => [row.kind, row.count])),
      { claim: 4, entity: 2 },
      "晶化入图谱应产生 2 次 entity upsert + 4 条 claim 失效事件",
    );

    // 裁决拒绝：零入图（审计另行落库是既有行为）。
    reject = true;
    const third = await recordService.loadRecord(POSTGRES_DEMO_IDS.record);
    await recordService.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "时间倒流回昨天。",
      idempotencyKey: "t9-inflow-3",
      writeToken: third.writeToken,
    });
    await eventually(async () => {
      const audits = await ownerPool.query(
        `SELECT count(*)::int AS count FROM semantic_conflict_evaluations
         WHERE workspace_id = $1`,
        [POSTGRES_DEMO_IDS.workspace],
      );
      return audits.rows[0].count >= 1;
    });
    const claimsFinal = await ownerPool.query(
      `SELECT count(*)::int AS count FROM world_claims
       WHERE world_id = $1 AND object_value = '不应入图'`,
      [POSTGRES_DEMO_IDS.world],
    );
    assert.equal(claimsFinal.rows[0].count, 0, "rejected delta never enters the graph");
  },
);

test(
  "T9 PG: canon/knowledge APIs take explicit worldId (400 missing, 404 unknown/non-member, non-demo world works)",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool } = await createMigratedDatabase(t);
    const library = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };
    await library.create(scope, {
      kind: "world",
      name: "图谱异邦",
      era: "测绘纪元",
      summary: "非 demo 世界的图谱读写。",
    });
    const world = (await library.list(scope)).worlds.find(
      (item) => item.name === "图谱异邦",
    )!;

    // 缺失 worldId → 400。
    const missing = await knowledgeGET(
      new Request("http://localhost/api/world-knowledge"),
    );
    assert.equal(missing.status, 400);
    const missingCanon = await canonGET(
      new Request("http://localhost/api/canon"),
    );
    assert.equal(missingCanon.status, 400);

    // 不存在的世界 → 404（不泄露存在性）。
    const unknown = await knowledgeGET(
      new Request("http://localhost/api/world-knowledge?worldId=world_nope"),
    );
    assert.equal(unknown.status, 404);

    // 非成员 fail-closed（解析器级）：stranger 对两世界都拿不到 scope。
    assert.equal(
      await resolveWorldScopeForMember(ownerPool, {
        workspaceId: scope.workspaceId,
        principalId: "principal_stranger",
        worldId: world.id,
      }),
      null,
    );

    // 非 demo 世界完整读写：实体 + Claim + 提案。
    const entityResponse = await knowledgePOST(
      new Request("http://localhost/api/world-knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "upsertEntity",
          entityKind: "setting",
          name: "异邦灯塔",
          summary: "异乡的第一座灯塔。",
          worldId: world.id,
        }),
      }),
    );
    assert.equal(entityResponse.status, 201);
    const entityId = ((await entityResponse.json()) as { id: string }).id;

    const claimResponse = await knowledgePOST(
      new Request("http://localhost/api/world-knowledge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "appendClaim",
          subjectEntityId: entityId,
          predicate: "状态",
          objectValue: "点亮",
          scope: "story",
          truthStatus: "record_confirmed",
          worldId: world.id,
        }),
      }),
    );
    assert.equal(claimResponse.status, 201);
    const claimId = ((await claimResponse.json()) as { id: string }).id;

    const propose = await canonPOST(
      new Request("http://localhost/api/canon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "propose",
          targetLevel: "story",
          claimIds: [claimId],
          rationale: "异邦灯塔已点亮应入正史。",
          worldId: world.id,
        }),
      }),
    );
    assert.equal(propose.status, 201);

    const listed = await canonGET(
      new Request(
        `http://localhost/api/canon?worldId=${encodeURIComponent(world.id)}`,
      ),
    );
    assert.equal(listed.status, 200);
    const proposals = ((await listed.json()) as {
      proposals: { rationale: string }[];
    }).proposals;
    assert.ok(
      proposals.some((item) => item.rationale === "异邦灯塔已点亮应入正史。"),
    );

    // demo 世界语义不回退：demo scope 读取正常且与异邦隔离。
    const demoListed = await knowledgeGET(
      new Request(
        `http://localhost/api/world-knowledge?worldId=${POSTGRES_DEMO_IDS.world}`,
      ),
    );
    assert.equal(demoListed.status, 200);
    const demoGraph = (await demoListed.json()) as {
      entities: { id: string }[];
    };
    assert.ok(
      !demoGraph.entities.some((entity) => entity.id === entityId),
      "non-demo world entities never leak into the demo scope",
    );
  },
);

test(
  "T9 PG: merged story canon appears in the next turn's record scope brief (consumption side)",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool } = await createMigratedDatabase(t);
    const library = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };
    await library.create(scope, {
      kind: "world",
      name: "正史回读厅",
      era: "编年纪元",
      summary: "验证正史注入的世界。",
    });
    const world = (await library.list(scope)).worlds.find(
      (item) => item.name === "正史回读厅",
    )!;
    await library.create(scope, {
      kind: "story",
      worldId: world.id,
      title: "编年史",
      premise: "……",
    });
    const withStory = (await library.list(scope)).worlds.find(
      (item) => item.id === world.id,
    )!;
    await library.create(scope, {
      kind: "record",
      storyId: withStory.stories[0]!.id,
      title: "第一章",
    });
    const recordId = (await ownerPool.query(
      `SELECT id FROM records WHERE workspace_id = $1 AND world_id = $2`,
      [scope.workspaceId, world.id],
    )).rows[0].id as string;

    // 实体 + Claim + 提案 + 合并（晋升 story_canon）。
    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(ownerPool),
    );
    const worldScope = (await resolveWorldScopeForMember(ownerPool, {
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      worldId: world.id,
    }))!;
    await knowledge.upsertEntity(worldScope, {
      id: "entity_t9_beacon",
      entityKind: "setting",
      name: "回读灯塔",
      summary: "",
      validFromTick: 0,
      validToTick: null,
    });
    await knowledge.appendClaim(worldScope, {
      id: "claim_t9_beacon",
      subjectEntityId: "entity_t9_beacon",
      predicate: "状态",
      objectValue: "彻夜长明",
      scope: "story",
      truthStatus: "record_confirmed",
      confidence: 1,
      validFromTick: 0,
      validToTick: null,
      sourceRecordId: null,
      sourceEventId: null,
      supersedesClaimId: null,
    });
    const merge = await canonPOST(
      new Request("http://localhost/api/canon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "propose",
          targetLevel: "story",
          claimIds: ["claim_t9_beacon"],
          rationale: "灯塔长明入正史。",
          worldId: world.id,
        }),
      }),
    );
    const proposalId = ((await merge.json()) as { proposal: { id: string } })
      .proposal.id;
    const decide = await canonPOST(
      new Request("http://localhost/api/canon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "decide",
          proposalId,
          decision: "merge",
          decidedBy: "user",
          worldId: world.id,
        }),
      }),
    );
    assert.equal(decide.status, 200);

    // 下一回合的 scope：brief.canon 含晋升后的正史行（supersede 链最新）。
    const scopeRepository = createPostgresRecordRuntimeScopeRepository(ownerPool);
    const resolved = await scopeRepository.resolve({
      workspaceId: scope.workspaceId,
      principalId: scope.principalId,
      recordId,
    });
    assert.ok(resolved, "record scope resolves");
    assert.ok(
      resolved!.brief.canon.includes("回读灯塔 状态：彻夜长明"),
      `brief.canon must carry the merged canon line, got: ${resolved!.brief.canon}`,
    );
    // 原 claim（已被 supersede）不重复出现。
    assert.equal(
      resolved!.brief.canon.split("回读灯塔").length - 1,
      1,
      "superseded claim must not appear twice",
    );
  },
);
