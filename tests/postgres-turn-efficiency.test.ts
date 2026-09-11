/**
 * Clean-up Iteration Phase 2：玩家回合的 DB 查询/事务计数基线与回归围栏。
 *
 * 计数方式：Proxy 包装 pg Pool（含 connect() 返回的事务 client），统计
 * 全部 client.query 的 SQL 文本。标记见 MARKERS。数字是真实临时库测量值，
 * 优化前后的 before/after 记录在 STATUS 与提交信息。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresActionAffordanceCatalog,
  createPostgresCharacterMemoryRepository,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  createPostgresSceneCrystallizationStore,
  createPostgresWorldKnowledgeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
} from "../modules/application/local-record-service.ts";
import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/public.ts";
import {
  createMemoryPrefetchHub,
  createMemorySyncScheduler,
} from "../modules/memory/pipeline.ts";
import { createCharacterMemoryService } from "../modules/memory/public.ts";
import { createWorldKnowledgeService } from "../modules/world-knowledge/public.ts";
import type {
  ModelChatRequest,
  ModelGateway,
} from "../modules/inference/public.ts";
import type { SceneExtraction } from "../modules/application/scene-crystallization.ts";

/** 计数池：query/connect（事务 client）全计入。 */
function createCountingPool(pool: pg.Pool): { pool: pg.Pool; queries: string[] } {
  const queries: string[] = [];
  function wrapQuery<T extends pg.Pool | pg.PoolClient>(target: T): T {
    return new Proxy(target, {
      get(object, property) {
        if (property === "query") {
          return (text: unknown, values?: unknown) => {
            queries.push(typeof text === "string" ? text : "");
            return (object.query as (t: unknown, v?: unknown) => unknown).call(object, text, values);
          };
        }
        if (property === "connect" && "connect" in object) {
          return async () => wrapQuery(await (object as pg.Pool).connect());
        }
        const value = Reflect.get(object, property);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  }
  return { pool: wrapQuery(pool), queries };
}

const MARKERS = {
  /** record-scope resolve 主查询（record-scope.ts 独有）。 */
  scopeResolve: /empty_retrospection/,
  /** canon 展示查询（DB 侧 LIMIT 13；独立事务）。 */
  canonRead: /LIMIT 13/,
  /** delivery projection META_SQL。 */
  projectionMeta: /controlled_character_instance_ids/,
  /** projection EVENTS_SQL 全量授权事件扫描（仅全量路径 ASC 序）。 */
  projectionEvents: /ORDER BY event\.record_ordinal ASC/,
  /** 晶化瘦读（同一授权体，DESC LIMIT 有界）。 */
  leanRecentEvents: /LIMIT \$7/,
  /** commitRelease 观察落库。 */
  observationInsert: /INSERT INTO observations/,
  /** 图谱 claim 写入。 */
  claimInsert: /INSERT INTO world_claims/,
  /** SWM v2 lore excerpt 查询（并入 canon 事务）。 */
  loreRead: /FROM world_articles/,
} as const;

function countByMarkers(queries: readonly string[]) {
  return Object.fromEntries(
    Object.entries(MARKERS).map(([name, marker]) => [
      name,
      queries.filter((sql) => marker.test(sql)).length,
    ]),
  ) as Record<keyof typeof MARKERS, number> & { total: number };
}

test(
  "player turn DB budget: scope resolved once, no extra full projection read for crystallization",
  { skip: !process.env.DATABASE_URL, timeout: 120_000 },
  async (t) => {
    const adminUrl = new URL(process.env.DATABASE_URL!);
    if (!["127.0.0.1", "localhost", "::1"].includes(adminUrl.hostname)) {
      throw new Error("loopback only");
    }
    const databaseName = `realm_turneff_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimeUrl = new URL(ownerUrl);
    runtimeUrl.username = "realm_runtime";
    runtimeUrl.password = "";
    const rawRuntimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 6 });

    t.after(async () => {
      await rawRuntimePool.end();
      await ownerPool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });

    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    const { pool: runtimePool, queries } = createCountingPool(rawRuntimePool);
    let sequence = 0;
    const memoryRepository = createPostgresCharacterMemoryRepository(runtimePool);
    const memory = createCharacterMemoryService({ repository: memoryRepository });
    const memorySync = createMemorySyncScheduler({
      extract: (scope) => memoryRepository.extractAuthorized(scope),
    });
    const memoryPrefetch = createMemoryPrefetchHub({
      recall: async (input) => {
        const memories = await memory.recall({ ...input, limit: 6 });
        return memories.map((item) => `- ${item.content}`).join("\n");
      },
    });
    const fakeGateway: ModelGateway = {
      async discoverModels() {
        return [];
      },
      async chat(request: ModelChatRequest) {
        const system = request.messages[0]?.content ?? "";
        const json = (value: unknown) => ({
          model: "fake-model",
          content: JSON.stringify(value),
          toolCalls: [] as const,
          finishReason: "stop",
          usage: null,
        });
        if (system.includes("presence gate")) {
          return json({ shouldSpeak: false, characterInstanceId: null, triggerKind: null, reason: "无。" });
        }
        if (system.includes("information visibility")) {
          return json({ visibility: "public", audienceCharacterInstanceIds: [], reason: "公开。" });
        }
        if (system.includes("DM Controller")) {
          return json({
            goal: "回应玩家",
            activatedCharacterInstanceIds: [POSTGRES_DEMO_IDS.scoutInstance],
            narratorEnabled: true,
          });
        }
        if (system.includes("independent Narrator")) {
          return json({ environment: "冷雾未散。", storyBeat: "灯影摇动。", suggestions: [] });
        }
        if (system.includes("You speak only as the character")) {
          return json({ action: "塞娜点头。", dialogue: "“嗯。”" });
        }
        if (system.includes("DM output reviewer")) {
          return json({ accepted: true, goalSatisfied: true, worldCompatible: true });
        }
        return {
          model: "fake-model",
          content: "",
          toolCalls: [] as const,
          finishReason: "stop",
          usage: null,
        };
      },
    };

    // 晶化走真实 PG store + 假 crystallizer（固定 delta，裁决通过），
    // 图谱写入走真实 worldKnowledge（测 claim 批量）。
    const sceneCrystallizer = {
      async extract(): Promise<SceneExtraction | null> {
        return {
          delta: { weather: "雾转浓" },
          worldClaims: [],
          characterNotes: [],
        };
      },
      async adjudicate() {
        return { approved: true, reason: "ok", adjusted: null, model: "fake" as string };
      },
    };
    const service = createLocalRecordService({
      repository: createPostgresRuntimeRepository({
        pool: runtimePool,
        workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
        mapFormalEvent: mapLocalFormalEvent,
        allocateWorldCursors({ previous, eventCount }) {
          return Array.from({ length: eventCount }, (_, index) => ({
            tick: previous.tick,
            ordinal: previous.ordinal + index + 1,
            calendarId: previous.calendarId,
            display: previous.display,
          }));
        },
      }),
      projection: createPostgresDeliveryProjectionRepository(runtimePool),
      runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(runtimePool),
      actionCatalog: createPostgresActionAffordanceCatalog(runtimePool),
      memorySync,
      memoryPrefetch,
      characterMemory: memory,
      sceneCrystallizationStore: createPostgresSceneCrystallizationStore(runtimePool),
      sceneCrystallizer,
      worldKnowledge: createWorldKnowledgeService(
        createPostgresWorldKnowledgeRepository(runtimePool),
      ),
      tokens: createMemoryWriteTokenRegistry({
        randomToken: () => `pg-eff-${++sequence}`,
        clock: () => new Date("2026-09-03T03:00:00.000Z"),
      }),
      clock: () => new Date("2026-09-03T03:00:00.000Z"),
      idFactory: () => `pg-eff-${++sequence}`,
      orchestratorFactory: (scope) => createModelPoweredM2TurnOrchestrator({
        characters: scope.aiCharacters,
        getGateway: async () => fakeGateway,
        brief: scope.brief,
        style: scope.style,
        async recallMemory(character) {
          return memoryPrefetch.consume(scope.recordId, character.characterInstanceId);
        },
      }),
    });

    // SWM 下一阶段（G4）：播种 attested 空链接文章（claim 链接不再是资格），
    // 使 lore 路径真实执行并命中。
    const ws = LOCAL_RECORD_SCOPE.workspaceId;
    await ownerPool.query(
      `INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body, claim_ids, source_event_ids)
       VALUES ($1, $2, $3, 'article_eff_beacon', '灯塔志', '灯塔建于停战前夜。', ARRAY[]::text[], ARRAY[]::text[])`,
      [ws, POSTGRES_DEMO_IDS.world, POSTGRES_DEMO_IDS.worldline],
    );
    await ownerPool.query(
      `INSERT INTO article_qualifications (
         workspace_id, world_id, worldline_id, article_id, id, seq,
         provenance_kind, status, content_hash, attested_by, attested_at,
         available_from_tick, available_from_ordinal
       )
       SELECT article.workspace_id, article.world_id, article.worldline_id,
              article.id, 'aq_attest_eff', 1, 'owner_attest', 'qualified_public',
              encode(digest(article.id || E'\n' || article.title || E'\n' || article.body, 'sha256'), 'hex'),
              'principal_demo_player', CURRENT_TIMESTAMP, 0, 0
       FROM world_articles AS article
       WHERE article.workspace_id = $1 AND article.id = 'article_eff_beacon'`,
      [ws],
    );

    const initial = await service.loadRecord();
    queries.length = 0;
    const committed = await service.submitMessage({
      recordId: POSTGRES_DEMO_IDS.record,
      content: "我沿着防波堤走向灯塔。",
      idempotencyKey: "turn-efficiency-1",
      writeToken: initial.writeToken,
    });
    assert.equal(committed.disposition, "committed");
    await memorySync.idle();
    // 晶化是 fire-and-forget：等图谱 claim 落库（或确认无 delta）再计数收口。
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const counts = { ...countByMarkers(queries), total: queries.length };
    console.log("[turn-efficiency] query counts:", JSON.stringify(counts));

    // 回归围栏（Clean-up Iteration Phase 2 after 值；before 见 STATUS/提交信息）：
    assert.equal(counts.scopeResolve, 1, "scope 每回合只解析一次（含 canon 单事务）");
    assert.equal(counts.canonRead, 1, "canon 展示查询每回合一次（LIMIT 13 有界）");
    // 完整投影快照（含全量 EVENTS 扫描）至多 2 次：提交前 + 回合后信封；
    // 晶化改走瘦读（META 单行 + DESC LIMIT 6），不再全量扫事件。
    assert.ok(
      counts.projectionEvents <= 2,
      "全量事件扫描至多 2 次（提交前 + 信封；晶化不再全量重读）",
    );
    assert.equal(counts.leanRecentEvents, 1, "晶化必须走瘦读路径");
    assert.ok(
      counts.projectionMeta <= 3,
      "META 单行读取至多 3 次（快照×2 + 晶化瘦读×1）",
    );
    // 观察落库批量化为单条 INSERT。
    assert.ok(
      counts.observationInsert <= 1,
      "commitRelease observations 必须批量单条 INSERT",
    );
    // 图谱 claim N+1 合并：晶化 delta 单字段 → 至多 1 条 claim INSERT。
    assert.ok(counts.claimInsert <= 1, "晶化 claim 写入必须单事务批量");
    // SWM v2：canon 同事务 lore 查询恰好 1 次（资格集合非空时）；总预算
    // 170 → ≤172（+canon 全文行 +lore 查询，仍 +0 事务）。
    assert.equal(counts.loreRead, 1, "lore excerpt 查询必须并入 canon 事务且至多一次");
    // v37 §D.0：统一写入 gate（每个 C 面写事务 worlds KEY SHARE +
    // records FOR UPDATE 锁内重读）带来确定性 +42 查询
    // （acceptCommand/advance×4/beginStageAttempt×4/commitRelease/crystallization
    // 各自两拍 gate；无新事务、无全投影重读）。预算 172 → ≤214。
    assert.ok(counts.total <= 214, `回合总查询预算 172→≤214（v37 写入 gate），实际 ${counts.total}`);
  },
);
