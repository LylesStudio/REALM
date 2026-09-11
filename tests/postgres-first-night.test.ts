import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresDeliveryProjectionRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresRuntimeRepository,
  seedPostgresDemo,
  withWorkspaceTransaction,
} from "../database/postgres/public.ts";
import { createPostgresFirstNightStore } from "../database/postgres/first-night-store.ts";
import {
  createFirstNightRunner,
  fallbackFirstNightPack,
  normalizeFirstNightPack,
  composeDeterministicOpening,
  BLANK_FIRST_NIGHT_CONTEXT,
} from "../modules/application/first-night.ts";
import {
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
  type FormalEventPayload,
  type OutboxPayload,
  type PlayerUtterancePayload,
} from "../modules/application/local-record-service.ts";
import type { ModelGateway } from "../modules/inference/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
} from "../modules/orchestration/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

const GENESIS_DRAFT = {
  world: { name: "云港志", era: "风账纪元 3 年", summary: "云海上的旧船港。" },
  style: "modern" as const,
  story: { title: "雾中航船", premise: "一艘无籍船靠岸。" },
  record: { title: "靠岸" },
  playerRole: "替港口辨认风声的新账房",
  companions: [{ name: "阿橹", role: "记账员", summary: "听得懂风声的人。" }],
  scene: {
    location: "七号泊台",
    weather: "平流雾",
    tension: "港卫警惕",
    objective: "登记来船",
  },
  playerStance: "player" as const,
  opening: "",
};

const failingGateway: ModelGateway = {
  discoverModels: async () => [],
  chat: async () => {
    throw new Error("model offline");
  },
};

function stubGateway(content: string): ModelGateway {
  return {
    discoverModels: async () => [],
    chat: async () => ({
      model: "stub-model",
      content,
      toolCalls: [],
      finishReason: "stop",
      usage: null,
    }),
  };
}

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_first_night_${randomUUID().replaceAll("-", "")}`;
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

  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
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

test(
  "first night: seal writes deterministic opening + pending marker; failing gateway degrades fail-closed",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    const library = createPostgresLibraryService(ownerPool);
    // 全部异步写入走受限 realm_runtime 角色，验证 0019 授权真实存在。
    const store = createPostgresFirstNightStore(runtimePool, LOCAL_RECORD_SCOPE.workspaceId);
    const projection = createPostgresDeliveryProjectionRepository(ownerPool);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };

    // ===== 落笔入界：确定性开场旁白 + pending 状态行 =====
    const genesis = await library.createGenesis(scope, GENESIS_DRAFT);

    const marker = await store.find(genesis.recordId);
    assert.ok(marker, "seal must write a first-night marker row");
    assert.equal(marker.state, "pending");
    assert.equal(marker.attempts, 0);
    assert.equal(marker.context?.world.name, "云港志");
    assert.equal(marker.context?.scene.location, "七号泊台");
    assert.equal(marker.context?.playerName, "测试旅人");

    const sealView = await projection.loadForPlayer({
      workspaceId: scope.workspaceId,
      recordId: genesis.recordId,
      principalId: scope.principalId,
    });
    assert.ok(sealView);
    assert.equal(sealView.events.length, 1, "timeline must never be empty after seal");
    assert.equal(sealView.events[0]?.speaker, "旁白");
    // 场景地点非空 → 风格化合成句（modern）。
    assert.equal(
      sealView.events[0]?.content,
      composeDeterministicOpening({ ...BLANK_FIRST_NIGHT_CONTEXT, ...GENESIS_DRAFT }),
    );
    assert.ok(sealView.events[0]?.content.includes("七号泊台"));

    // ===== 失败网关：fail-closed 到确定性降级包 =====
    const runFirstNight = createFirstNightRunner({
      store,
      getGateway: async () => failingGateway,
    });
    await runFirstNight(genesis.recordId);

    const degraded = await store.find(genesis.recordId);
    assert.ok(degraded);
    assert.equal(degraded.state, "degraded");
    assert.equal(degraded.attempts, 1);

    const degradedView = await projection.loadForPlayer({
      workspaceId: scope.workspaceId,
      recordId: genesis.recordId,
      principalId: scope.principalId,
    });
    assert.ok(degradedView);
    // 卷首旁白 + 场景定格 + 钩子事件（草稿有 objective → 降级钩子非空）。
    assert.equal(degradedView.events.length, 3);
    const sceneEvent = degradedView.events[1];
    assert.ok(sceneEvent);
    assert.equal(sceneEvent.role, "narrator");
    // 降级包由草稿场景字段经风格模板合成。
    const fallback = fallbackFirstNightPack({ ...BLANK_FIRST_NIGHT_CONTEXT, ...GENESIS_DRAFT });
    assert.ok(sceneEvent.content.includes(fallback.scene.environment));
    assert.ok(sceneEvent.content.includes(fallback.scene.story));
    assert.ok(sceneEvent.content.includes(fallback.scene.fact));
    const segmentKinds = sceneEvent.segments.map((segment) => segment.kind);
    assert.deepEqual(segmentKinds, ["environment", "story", "fact"]);
    const hookEvent = degradedView.events[2];
    assert.ok(hookEvent);
    assert.equal(hookEvent.role, "narrator");
    assert.equal(hookEvent.content, fallback.hook.content);

    // 降级包钩子与提案镜像进状态行（投影快路径）。
    assert.equal(degraded.hookContent, fallback.hook.content);
    assert.deepEqual([...degraded.suggestions], fallback.hook.suggestions);
    assert.ok(degraded.suggestions.length >= 2, "草稿 objective+location → 至少两条降级提案");

    // 头指针推进：记录版本 2、批次三事件，世界线 (0,3)。
    const head = await withWorkspaceTransaction(
      ownerPool,
      scope.workspaceId,
      (client) =>
        client.query(
          `SELECT record_version, next_record_ordinal, last_world_tick, last_world_ordinal
           FROM record_heads
           WHERE workspace_id = $1 AND record_id = $2`,
          [scope.workspaceId, genesis.recordId],
        ),
      { readOnly: true },
    );
    assert.equal(Number(head.rows[0]?.record_version), 2);
    assert.equal(Number(head.rows[0]?.next_record_ordinal), 4);
    assert.equal(Number(head.rows[0]?.last_world_ordinal), 3);
    const worldline = await withWorkspaceTransaction(
      ownerPool,
      scope.workspaceId,
      async (client) => {
        const record = await client.query(
          `SELECT worldline_id FROM records WHERE workspace_id = $1 AND id = $2`,
          [scope.workspaceId, genesis.recordId],
        );
        return client.query(
          `SELECT head_tick, head_ordinal FROM worldlines WHERE workspace_id = $1 AND id = $2`,
          [scope.workspaceId, record.rows[0]?.worldline_id],
        );
      },
      { readOnly: true },
    );
    assert.equal(Number(worldline.rows[0]?.head_ordinal), 3);

    // 幂等：非 pending 状态重复提交直接跳过。
    const replayed = await store.commitPack(
      genesis.recordId,
      fallbackFirstNightPack({ ...BLANK_FIRST_NIGHT_CONTEXT, ...GENESIS_DRAFT }),
      "degraded",
    );
    assert.equal(replayed, false);

    // claimAttempt 对非 pending 行返回 null（懒重试不再消耗尝试次数）。
    assert.equal(await store.claimAttempt(genesis.recordId), null);
  },
);

test(
  "first night: valid model output commits ready with presentation segments",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    const library = createPostgresLibraryService(ownerPool);
    const store = createPostgresFirstNightStore(runtimePool, LOCAL_RECORD_SCOPE.workspaceId);
    const projection = createPostgresDeliveryProjectionRepository(ownerPool);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };
    const draft = { ...GENESIS_DRAFT, opening: "雾夜，一艘无籍船悄悄靠岸。" };
    const genesis = await library.createGenesis(scope, draft);

    // opening 非空 → 卷首旁白原样落库。
    const sealView = await projection.loadForPlayer({
      workspaceId: scope.workspaceId,
      recordId: genesis.recordId,
      principalId: scope.principalId,
    });
    assert.equal(sealView?.events[0]?.content, "雾夜，一艘无籍船悄悄靠岸。");

    const runFirstNight = createFirstNightRunner({
      store,
      getGateway: async () =>
        stubGateway(
          JSON.stringify({
            scene: {
              environment: "灯塔的光扫过湿漉漉的泊台。",
              story: "缆绳正从雾里递过来。",
              fact: "风声账本摊开在案头，墨迹未干。",
            },
            characters: [
              {
                name: "阿橹",
                utterance: "雾这么大，来船怎么不点灯？",
                action: "把听风筒往雾里探了探。",
              },
              { name: "陌生人", utterance: "提案外的角色不该进场。", action: "" },
            ],
            hook: {
              content: "雾里的来船没有点灯，却在泊台外停了三次。",
              suggestions: [
                "登上泊台，朝来船喊话",
                "问阿橹风声账上有没有这艘船",
                "先去港卫值房报备",
                "去灯房查夜航簿",
                "登上泊台，朝来船喊话"
              ],
            },
          }),
        ),
    });
    await runFirstNight(genesis.recordId);

    const ready = await store.find(genesis.recordId);
    assert.ok(ready);
    assert.equal(ready.state, "ready");

    const readyView = await projection.loadForPlayer({
      workspaceId: scope.workspaceId,
      recordId: genesis.recordId,
      principalId: scope.principalId,
    });
    assert.ok(readyView);
    // 卷首旁白 + 场景定格 + 同行者发声（提案外角色被丢弃）+ 钩子事件。
    assert.equal(readyView.events.length, 4);
    const sceneEvent = readyView.events[1];
    assert.ok(sceneEvent);
    assert.equal(sceneEvent.role, "narrator");
    assert.ok(sceneEvent.content.includes("灯塔的光扫过湿漉漉的泊台。"));
    assert.deepEqual(
      sceneEvent.segments.map((segment) => segment.kind),
      ["environment", "story", "fact"],
    );
    const characterEvent = readyView.events[2];
    assert.ok(characterEvent);
    assert.equal(characterEvent.role, "character");
    assert.equal(characterEvent.speaker, "阿橹");
    assert.ok(characterEvent.speakerParticipantId, "同行者发声必须解析到参与者席位");
    assert.deepEqual(
      characterEvent.segments.map((segment) => [segment.kind, segment.speechMode]),
      [["action", "narrator"], ["dialogue", "speaker"]],
    );
    assert.ok(characterEvent.content.includes("雾这么大，来船怎么不点灯？"));
    const hookEvent = readyView.events[3];
    assert.ok(hookEvent);
    assert.equal(hookEvent.role, "narrator");
    assert.equal(hookEvent.content, "雾里的来船没有点灯，却在泊台外停了三次。");

    // 钩子与提案镜像进状态行（重复提案去重、超出上限截断）。
    assert.equal(ready.hookContent, "雾里的来船没有点灯，却在泊台外停了三次。");
    assert.deepEqual([...ready.suggestions], [
      "登上泊台，朝来船喊话",
      "问阿橹风声账上有没有这艘船",
      "先去港卫值房报备",
    ]);

    // 批次头指针：同一 record_version，ordinal/world ordinal 连续。
    const head = await withWorkspaceTransaction(
      ownerPool,
      scope.workspaceId,
      (client) =>
        client.query(
          `SELECT record_version, next_record_ordinal, last_world_tick, last_world_ordinal
           FROM record_heads
           WHERE workspace_id = $1 AND record_id = $2`,
          [scope.workspaceId, genesis.recordId],
        ),
      { readOnly: true },
    );
    assert.equal(Number(head.rows[0]?.record_version), 2);
    assert.equal(Number(head.rows[0]?.next_record_ordinal), 5);
    assert.equal(Number(head.rows[0]?.last_world_ordinal), 4);
  },
);

test(
  "first night: envelope carries marker state via record service wiring",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const { ownerPool, runtimePool } = await createMigratedDatabase(t);
    const library = createPostgresLibraryService(ownerPool);
    const store = createPostgresFirstNightStore(runtimePool, LOCAL_RECORD_SCOPE.workspaceId);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    };
    const genesis = await library.createGenesis(scope, GENESIS_DRAFT);

    const repository = createPostgresRuntimeRepository<
      PlayerUtterancePayload,
      M2TurnPlan,
      M2TurnCandidate,
      M2TurnValidation,
      FormalEventPayload,
      OutboxPayload
    >({
      pool: runtimePool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      mapFormalEvent: mapLocalFormalEvent,
    });
    const service = createLocalRecordService({
      repository,
      projection: createPostgresDeliveryProjectionRepository(ownerPool),
      runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(ownerPool),
      tokens: createMemoryWriteTokenRegistry({}),
      firstNight: {
        load: (recordId) => store.find(recordId),
      },
    });

    // pending 状态进入 envelope；旧演示记录无状态行 → null。
    const envelope = await service.loadRecord(genesis.recordId);
    assert.deepEqual(envelope.firstNight, {
      state: "pending",
      hookContent: "",
      openingSuggestions: [],
    });
    const demoEnvelope = await service.loadRecord(POSTGRES_DEMO_IDS.record);
    assert.equal(demoEnvelope.firstNight, null);
  },
);

const NORMALIZE_CONTEXT = {
  ...BLANK_FIRST_NIGHT_CONTEXT,
  world: { ...BLANK_FIRST_NIGHT_CONTEXT.world, name: "云港志" },
  companions: [
    { name: "阿橹", role: "记账员", summary: "听得懂风声的人。" },
    { name: "灯姨", role: "守灯人", summary: "掌灯三十年。" },
  ],
};

test("first night pack normalization is fail-closed", () => {
  assert.equal(normalizeFirstNightPack(null, NORMALIZE_CONTEXT), null);
  assert.equal(normalizeFirstNightPack({ scene: {} }, NORMALIZE_CONTEXT), null);
  assert.equal(
    normalizeFirstNightPack(
      { scene: { environment: "   ", story: "", fact: "" } },
      NORMALIZE_CONTEXT,
    ),
    null,
  );
  // 缺钩子或提案不足两条 → 整包 fail-closed。
  assert.equal(
    normalizeFirstNightPack(
      { scene: { environment: "灯塔亮了。" } },
      NORMALIZE_CONTEXT,
    ),
    null,
  );
  assert.equal(
    normalizeFirstNightPack(
      {
        scene: { environment: "灯塔亮了。" },
        hook: { content: "风声有些不对。", suggestions: ["去泊台看看来船"] },
      },
      NORMALIZE_CONTEXT,
    ),
    null,
  );
  const normalized = normalizeFirstNightPack(
    {
      scene: { environment: "  灯塔亮了。 ", story: "", fact: null },
      hook: { content: "风声有些不对。", suggestions: ["去泊台看看来船", "问灯姨借风声账"] },
    },
    NORMALIZE_CONTEXT,
  );
  assert.ok(normalized);
  assert.equal(normalized.scene.environment, "灯塔亮了。");
  assert.equal(normalized.scene.story, "");
  assert.deepEqual(normalized.characters, []);
  assert.equal(normalized.hook.content, "风声有些不对。");
  assert.deepEqual(normalized.hook.suggestions, ["去泊台看看来船", "问灯姨借风声账"]);
});

test("first night characters keep only exact companion-name matches with voice", () => {
  const normalized = normalizeFirstNightPack(
    {
      scene: { environment: "泊台起雾。", story: "", fact: "" },
      characters: [
        { name: "阿橹", utterance: "  风声不对，先别解缆。 ", action: " 按住账本 " },
        { name: "阿橹", utterance: "重复条目应被去重。", action: "" },
        { name: "陌生人", utterance: "不在提案里的角色一律丢弃。", action: "" },
        { name: "灯姨", utterance: "", action: "没有台词的角色也丢弃。" },
      ],
      hook: { content: "雾里的来船没有点灯。", suggestions: ["去泊台看看", "问阿橹风声"] },
    },
    NORMALIZE_CONTEXT,
  );
  assert.ok(normalized);
  assert.deepEqual(normalized.characters, [
    { name: "阿橹", utterance: "风声不对，先别解缆。", action: "按住账本" },
  ]);
});

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^realm_first_night_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
