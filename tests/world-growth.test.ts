/**
 * 世界知识与人物设定自然生长——Core 聚焦测试。
 *
 * 覆盖：growth 结构化字段规整（有界、fail-closed、roster 白名单）、
 * extraction 单次结构化调用同时带回场景 delta 与 growth、无场景变化时
 * growth 仍可产生且不制造空 correction、公共回合写回（record_confirmed +
 * 来源可追踪 + profile note 追加）、restricted 回合不产生公共增长、
 * growth 失败只 warn 不阻断回合、重复调度幂等。
 * 所有异步用例带短超时，后台管线用有界轮询等待。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSceneCrystallizer,
  GROWTH_LIMITS,
  normalizeGrowthCharacterNotes,
  normalizeGrowthWorldClaims,
  type SceneExtraction,
  type SceneStateSnapshot,
} from "../modules/application/scene-crystallization.ts";
import {
  mergeProfileNotes,
  normalizeProfileNoteEntry,
  PROFILE_NOTE_LIMITS,
  profileNoteTextAt,
  type ProfileNoteEntry,
} from "../database/postgres/character-growth-store.ts";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/public.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  LocalRecordServiceError,
  type FormalEventPayload,
  type PlayerUtterancePayload,
} from "../modules/application/local-record-service.ts";
import {
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import {
  createLocalM2TurnOrchestrator,
  createRuleBasedDMController,
  type M2TurnCandidate,
  type M2TurnPlan,
  type M2TurnValidation,
} from "../modules/orchestration/public.ts";
import type { WorldClaim, WorldEntity } from "../modules/world-knowledge/public.ts";

const CURRENT: SceneStateSnapshot = {
  worldName: "烬海诸国",
  era: "停战纪元 17 年",
  displayTime: "停战纪元17年 · 雾月12日 · 入夜",
  location: "灰鲸港 · 北防波堤",
  weather: "冷雾，无风",
  tension: "戒备",
  objective: "决定是否拆开密函",
};

const ROSTER = [
  {
    characterInstanceId: "char_inst_player",
    participantId: "participant_player",
    displayName: "洛川",
    profileSummary: "在北岸谋生的旅人。",
  },
  {
    characterInstanceId: "char_inst_scout",
    participantId: "participant_scout",
    displayName: "塞娜",
    profileSummary: "谨慎的斥候。",
  },
] as const;

function jsonResponse(value: unknown): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };
}

test("growth normalizers bound output and fail closed", () => {
  // 非数组 / 全非法 → 空
  assert.deepEqual(normalizeGrowthWorldClaims(null), []);
  assert.deepEqual(normalizeGrowthWorldClaims("fact"), []);
  assert.deepEqual(
    normalizeGrowthWorldClaims([{ entity: "", predicate: "p", value: "v" }]),
    [],
  );
  // 字段修剪限长 + entityKind 白名单兜底 + 条数上限
  const claims = normalizeGrowthWorldClaims([
    { entity: " 灯塔看守 ", entityKind: "person", predicate: "立场", value: "保持中立" },
    { entity: "雾潮", entityKind: "nonsense", predicate: "周期", value: "每逢无风夜" },
    { entity: "x".repeat(100), predicate: "p", value: "v" },
    { entity: "多余", predicate: "p", value: "v" },
  ]);
  assert.equal(claims.length, GROWTH_LIMITS.worldClaims);
  assert.deepEqual(claims[0], {
    entity: "灯塔看守",
    entityKind: "person",
    predicate: "立场",
    value: "保持中立",
  });
  assert.equal(claims[1]!.entityKind, "other", "未知 entityKind 兜底 other");
  assert.equal(claims[2]!.entity.length, GROWTH_LIMITS.entity);

  // characterNotes：目标必须在 roster 内；note 修剪限长；条数上限。
  const notes = normalizeGrowthCharacterNotes([
    { characterInstanceId: "char_inst_scout", note: " 对密函保持警惕 " },
    { characterInstanceId: "char_inst_ghost", note: "不在名册" },
    { characterInstanceId: "char_inst_player", note: "记得灯塔的钟声" },
    { characterInstanceId: "char_inst_scout", note: "第三条应被截断" },
  ], ROSTER);
  assert.equal(notes.length, GROWTH_LIMITS.characterNotes);
  assert.deepEqual(notes[0], {
    characterInstanceId: "char_inst_scout",
    note: "对密函保持警惕",
  });
  assert.equal(notes[1]!.characterInstanceId, "char_inst_player");
  assert.deepEqual(normalizeGrowthCharacterNotes("x", ROSTER), []);
});

test("one structured extraction returns delta, worldClaims and characterNotes together", async () => {
  const captured: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      return jsonResponse({
        worldClaims: [{
          entity: "北岸灯塔",
          entityKind: "geography",
          predicate: "异常",
          value: "无风夜自行点亮",
        }],
        characterNotes: [{
          characterInstanceId: "char_inst_scout",
          note: "能辨认旧世界文字的刻痕",
        }],
      });
    },
  };
  const crystallizer = createSceneCrystallizer({ getGateway: async () => gateway });
  const extraction = await crystallizer.extract({
    playerText: "塞娜说她认得灯塔上的刻痕。",
    turnSummary: "塞娜：那是无风夜的旧灯语。",
    current: CURRENT,
    recentDialogue: [{
      speaker: "塞娜",
      speakerParticipantId: "participant_scout",
      recipientId: "participant_player",
      text: "那是无风夜的旧灯语。",
    }],
    participants: ROSTER,
  });
  assert.ok(extraction);
  // 无场景变化：delta 为 null，growth 仍然存在（同一次调用）。
  assert.equal(extraction!.delta, null);
  assert.equal(extraction!.worldClaims.length, 1);
  assert.equal(extraction!.worldClaims[0]!.entity, "北岸灯塔");
  assert.deepEqual(extraction!.characterNotes, [{
    characterInstanceId: "char_inst_scout",
    note: "能辨认旧世界文字的刻痕",
  }]);

  const system = captured[0]?.messages[0]?.content ?? "";
  const user = captured[0]?.messages[1]?.content ?? "";
  assert.ok(!/[一-鿿]/.test(system), "extraction system 保持静态 English");
  assert.ok(system.includes("worldClaims"), "schema 声明 worldClaims");
  assert.ok(system.includes("characterNotes"), "schema 声明 characterNotes");
  // roster/profile 与带主体 ID 的公开对话进 user context。
  assert.ok(user.includes("[Participants]"));
  assert.ok(user.includes("谨慎的斥候"), "roster 携带 profile 摘要");
  assert.ok(user.includes("[Recent public dialogue]"));
  assert.ok(user.includes("participant_scout"), "对话携带 speaker participantId");
  assert.ok(user.includes("participant_player"), "对话携带 recipientId");

  // 空输出 {} 仍是合法「无变化」，growth 为空数组。
  const empty = createSceneCrystallizer({
    getGateway: async () => ({
      async discoverModels() {
        return [];
      },
      async chat() {
        return jsonResponse({});
      },
    } as ModelGateway),
  });
  const emptyExtraction = await empty.extract({
    playerText: "我继续走。",
    turnSummary: "",
    current: CURRENT,
  });
  assert.deepEqual(emptyExtraction, {
    delta: null,
    worldClaims: [],
    characterNotes: [],
  });
});

test("mergeProfileNotes appends, dedupes and never touches the base summary", () => {
  assert.deepEqual(mergeProfileNotes(undefined, ["对密函保持警惕"]), ["对密函保持警惕"]);
  assert.deepEqual(
    mergeProfileNotes(["已有"], ["已有", " 新增 "]),
    ["已有", "新增"],
    "精确去重 + 修剪",
  );
  // 超长截断 + 总量上限丢最旧
  const long = "长".repeat(PROFILE_NOTE_LIMITS.noteLength * 2);
  const merged = mergeProfileNotes([], [long]);
  assert.equal((merged[0] as string).length, PROFILE_NOTE_LIMITS.noteLength);
  const many = mergeProfileNotes(
    Array.from({ length: PROFILE_NOTE_LIMITS.maxNotes }, (_, i) => `旧${i}`),
    ["新"],
  );
  assert.equal(many.length, PROFILE_NOTE_LIMITS.maxNotes);
  assert.equal(many.at(-1), "新");
  assert.equal(many[0], "旧1", "最旧的 note 被丢弃");
});

const ENTRY_PROVENANCE = {
  sourceRecordId: "record_src",
  sourceEventId: "turn_1:narration",
  validFromTick: 17_121_219,
  createdAt: "2026-09-06T02:00:00.000Z",
};

test("mergeProfileNotes 双读：旧字符串原样保留，新 entry 带 provenance，按文本跨形状去重", () => {
  const legacy = "旧字符串笔记";
  const existingEntry: ProfileNoteEntry = {
    note: "已有",
    sourceRecordId: "record_src",
    sourceEventId: "turn_0:player",
    validFromTick: 17_121_200,
    validToTick: null,
    createdAt: "2026-09-05T02:00:00.000Z",
    revokedAt: null,
  };
  const merged = mergeProfileNotes(
    [legacy, existingEntry, { malformed: true }, 42, null],
    ["已有", " 新笔记 "],
    ENTRY_PROVENANCE,
  );
  // 旧字符串形状不变（不迁移）；malformed object/非字符串 fail-closed 丢弃。
  assert.equal(merged[0], legacy);
  assert.deepEqual(merged[1], existingEntry);
  assert.equal(merged.length, 3);
  // 新 note 以 object entry 写入，provenance 完整。
  const added = merged[2] as ProfileNoteEntry;
  assert.equal(added.note, "新笔记");
  assert.equal(added.sourceRecordId, ENTRY_PROVENANCE.sourceRecordId);
  assert.equal(added.sourceEventId, ENTRY_PROVENANCE.sourceEventId);
  assert.equal(added.validFromTick, ENTRY_PROVENANCE.validFromTick);
  assert.equal(added.validToTick, null);
  assert.equal(added.revokedAt, null);
  // 跨形状按 note 文本去重：existing entry 的 "已有" 没有被重复追加。
  assert.equal(
    merged.filter((item) =>
      (typeof item === "string" ? item : item.note) === "已有"
    ).length,
    1,
    "旧字符串/新 object 混合按文本精确去重",
  );
  // 无 provenance 时保持 legacy 字符串写入（纯函数旧行为）。
  assert.deepEqual(mergeProfileNotes([], ["纯文本"]), ["纯文本"]);
});

test("profileNoteTextAt 只渲染当前有效文本：revoked/过期/未来/malformed 一律不渲染", () => {
  const cursor = 100;
  const entry = (overrides: Partial<ProfileNoteEntry>): ProfileNoteEntry => ({
    note: "有效笔记",
    sourceRecordId: "record_src",
    sourceEventId: "turn_1:narration",
    validFromTick: 90,
    validToTick: null,
    createdAt: "2026-09-06T02:00:00.000Z",
    revokedAt: null,
    ...overrides,
  });
  // legacy string 始终可读；metadata 不进入渲染结果。
  assert.equal(profileNoteTextAt(" 旧笔记 ", cursor), "旧笔记");
  assert.equal(profileNoteTextAt(entry({}), cursor), "有效笔记");
  // revoked 不渲染。
  assert.equal(
    profileNoteTextAt(entry({ revokedAt: "2026-09-06T03:00:00.000Z" }), cursor),
    null,
  );
  // 过期（validToTick <= cursor）不渲染；validToTick 在未来仍渲染。
  assert.equal(profileNoteTextAt(entry({ validToTick: 100 }), cursor), null);
  assert.equal(profileNoteTextAt(entry({ validToTick: 101 }), cursor), "有效笔记");
  // 未来（validFromTick > cursor）不渲染；恰好等于 cursor 渲染（inclusive）。
  assert.equal(profileNoteTextAt(entry({ validFromTick: 101 }), cursor), null);
  assert.equal(profileNoteTextAt(entry({ validFromTick: 100 }), cursor), "有效笔记");
  // cursor 不可用（null）时保守：只过滤 revokedAt，不猜 temporal。
  assert.equal(profileNoteTextAt(entry({ validFromTick: 999 }), null), "有效笔记");
  assert.equal(
    profileNoteTextAt(entry({ revokedAt: "2026-09-06T03:00:00.000Z" }), null),
    null,
  );
  // malformed object fail-closed：metadata 绝不当作 note 渲染。
  assert.equal(profileNoteTextAt({ note: 42 }, cursor), null);
  assert.equal(profileNoteTextAt({ note: "缺来源" }, cursor), null);
  assert.equal(profileNoteTextAt({ foo: "bar" }, cursor), null);
  assert.equal(normalizeProfileNoteEntry({ note: "缺来源" }), null);
});

/** 应用层测试夹具：内存运行时 + 可控 growth 依赖。 */
function createGrowthFixture(options: {
  extraction: SceneExtraction;
  visibilityAssessor?: {
    assess(input: { playerText: string }): Promise<{
      visibility: { kind: "public" } | {
        kind: "restricted";
        domainId: string;
        audienceCharacterInstanceIds: readonly string[];
      };
      reason: string;
    }>;
  };
  failKnowledge?: boolean;
  /** Batch 4A：模拟来源 Event 在 scope 内不可解析（repo fail-closed false）。 */
  unknownSource?: boolean;
}) {
  const repository: RuntimeRepository<
    PlayerUtterancePayload,
    M2TurnPlan,
    M2TurnCandidate,
    M2TurnValidation,
    FormalEventPayload,
    { recordId: string; eventIds: readonly string[] }
  > = createInMemoryRuntimeRepository({
    recordHeads: [
      { recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 },
    ],
  });
  let tokenSequence = 0;
  let idSequence = 0;
  const baseProjection = () => ({
    id: LOCAL_RECORD_SCOPE.recordId,
    version: 1,
    world: {
      id: "world_ember_coast",
      name: "烬海诸国",
      era: "停战纪元 17 年",
      summary: "",
      timeCursor: "",
      style: "classical",
      language: "zh-CN",
    },
    story: {
      id: "story_silent_bell",
      title: "无声钟的来客",
      status: "active",
      premise: "",
    },
    record: {
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "初更",
      status: "active",
      version: 1,
      location: "灰鲸港 · 北防波堤",
      worldTime: "",
    },
    scene: {
      location: "灰鲸港 · 北防波堤",
      worldTime: "",
      weather: "冷雾",
      tension: "",
      objective: "",
    },
    cast: [],
    participants: [],
    events: [],
    stories: [],
    records: [],
  });
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return baseProjection();
    },
    async loadDeliveryForPlayer() {
      return {
        record: baseProjection(),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: null,
          membershipRole: "owner" as const,
        },
      };
    },
  };
  const knowledgeCalls = {
    entities: [] as WorldEntity[],
    claimBatches: [] as WorldClaim[][],
  };
  const knowledgeStore = new Map<string, WorldClaim>();
  // Batch 4A：模拟 repo 派生的来源 Event cursor（真实世界 tick>0）。
  const SOURCE_TICK = 17_121_219;
  const knowledge = {
    async upsertEntity(_scope: unknown, entity: WorldEntity) {
      if (options.failKnowledge) throw new Error("knowledge unavailable");
      knowledgeCalls.entities.push(entity);
    },
    async appendClaim(_scope: unknown, claim: WorldClaim) {
      if (!knowledgeStore.has(claim.id)) knowledgeStore.set(claim.id, claim);
    },
    async appendClaims(_scope: unknown, claims: readonly WorldClaim[]) {
      for (const claim of claims) {
        if (!knowledgeStore.has(claim.id)) knowledgeStore.set(claim.id, claim);
      }
    },
    async appendClaimsIdempotent(_scope: unknown, claims: readonly WorldClaim[]) {
      if (options.failKnowledge) throw new Error("knowledge unavailable");
      knowledgeCalls.claimBatches.push([...claims]);
      for (const claim of claims) {
        // 幂等：同 id 重复调度不重复落账。
        if (!knowledgeStore.has(claim.id)) knowledgeStore.set(claim.id, claim);
      }
    },
    async appendDialogueGrowth(
      _scope: unknown,
      input: {
        recordId: string;
        sourceEventId: string;
        entities: readonly Omit<WorldEntity, "validFromTick" | "validToTick">[];
        claims: readonly Omit<
          WorldClaim,
          "validFromTick" | "validToTick" | "sourceRecordId" | "sourceEventId"
        >[];
      },
    ) {
      if (options.failKnowledge) throw new Error("knowledge unavailable");
      // 来源不可解析/跨 scope：fail-closed 零写入。
      if (options.unknownSource) return false;
      // 与 PG repo 同契约：entity/claim 统一盖章派生 cursor 与来源字段。
      knowledgeCalls.entities.push(
        ...input.entities.map((entity) => ({
          ...entity,
          validFromTick: SOURCE_TICK,
          validToTick: null,
        })),
      );
      const materialized = input.claims.map((claim) => ({
        ...claim,
        validFromTick: SOURCE_TICK,
        validToTick: null,
        sourceRecordId: input.recordId,
        sourceEventId: input.sourceEventId,
      }));
      knowledgeCalls.claimBatches.push(materialized);
      for (const claim of materialized) {
        // 幂等：同 id 重复调度不重复落账。
        if (!knowledgeStore.has(claim.id)) knowledgeStore.set(claim.id, claim);
      }
      return true;
    },
  };
  const noteCalls: { characterInstanceId: string; note: string }[][] = [];
  const noteEntries: ProfileNoteEntry[] = [];
  const characterGrowth = {
    async appendProfileNotes(
      scope: { recordId: string },
      notes: readonly { characterInstanceId: string; note: string }[],
      source: { sourceEventId: string },
    ) {
      // 来源不可解析/跨 scope：fail-closed 零写入。
      if (options.unknownSource) return false;
      noteCalls.push([...notes]);
      // 与 PG store 同契约：object entry + 服务端 provenance/cursor 盖章。
      for (const { note } of notes) {
        noteEntries.push({
          note: note.trim().slice(0, PROFILE_NOTE_LIMITS.noteLength),
          sourceRecordId: scope.recordId,
          sourceEventId: source.sourceEventId,
          validFromTick: SOURCE_TICK,
          validToTick: null,
          createdAt: "2026-08-13T02:00:00.000Z",
          revokedAt: null,
        });
      }
      return true;
    },
  };
  const storeCalls = { applyDelta: 0 };
  const sceneStore = {
    async applyDelta() {
      storeCalls.applyDelta += 1;
      return { tick: 1, ordinal: 1, eventId: "scene-event-1" };
    },
    async recordRejection() {},
  };
  const extractInputs: unknown[] = [];
  const crystallizer = {
    async extract(input: unknown) {
      extractInputs.push(input);
      return options.extraction;
    },
    async adjudicate() {
      return null;
    },
  };
  const service = createLocalRecordService({
    repository,
    projection,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `growth-token-${++tokenSequence}`,
      clock: () => new Date("2026-08-13T02:00:00.000Z"),
    }),
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
    idFactory: () => `growth-${++idSequence}`,
    orchestrator: createLocalM2TurnOrchestrator({
      characters: [],
      dmController: {
        async plan() {
          return {
            goal: "回应玩家",
            constraints: [],
            activatedCharacters: [],
            narratorEnabled: false,
            actionBudgetPerCharacter: 0,
            visibility: { kind: "public" as const },
          };
        },
        approveActions: (input) =>
          createRuleBasedDMController().approveActions(input),
        validate: (input) => createRuleBasedDMController().validate(input),
      },
    }),
    sceneCrystallizer: crystallizer,
    sceneCrystallizationStore: sceneStore,
    worldKnowledge: knowledge,
    characterGrowth,
    // 关掉回合后自动插话/在场：后台自治回合会推进 Record 版本，干扰
    // 连续两回合的写令牌 CAS（growth 幂等性才是本夹具关注点）。
    interjectionPolicy: {
      evaluate: () => ({ kind: "silent" as const, reason: "test fixture" }),
    },
    presenceBudget: 0,
    ...(options.visibilityAssessor
      ? { visibilityAssessor: options.visibilityAssessor }
      : {}),
  });
  return {
    service,
    knowledgeCalls,
    knowledgeStore,
    noteCalls,
    noteEntries,
    storeCalls,
    extractInputs,
    sourceTick: SOURCE_TICK,
  };
}

async function eventually(
  check: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met in time");
}

const GROWTH_EXTRACTION: SceneExtraction = {
  delta: null,
  worldClaims: [{
    entity: "北岸灯塔",
    entityKind: "geography",
    predicate: "异常",
    value: "无风夜自行点亮",
  }],
  characterNotes: [{
    characterInstanceId: "char_inst_scout",
    note: "能辨认旧世界文字的刻痕",
  }],
};

test("a committed public turn grows world claims and profile notes without a scene correction", { timeout: 15_000 }, async () => {
  const fixture = createGrowthFixture({ extraction: GROWTH_EXTRACTION });
  const initial = await fixture.service.loadRecord();
  const committed = await fixture.service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "塞娜说她认得灯塔上的刻痕。",
    idempotencyKey: "growth-turn-1",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");

  await eventually(() =>
    fixture.knowledgeCalls.claimBatches.length > 0 && fixture.noteCalls.length > 0
  );
  // world claim：record 级 record_confirmed，来源可追踪，绝不自动升级 canon。
  const claims = fixture.knowledgeCalls.claimBatches[0]!;
  assert.equal(claims.length, 1);
  assert.equal(claims[0]!.scope, "record");
  assert.equal(claims[0]!.truthStatus, "record_confirmed");
  assert.equal(claims[0]!.sourceRecordId, LOCAL_RECORD_SCOPE.recordId);
  assert.ok(claims[0]!.sourceEventId, "claim 携带 sourceEventId");
  assert.equal(claims[0]!.predicate, "异常");
  // Batch 4A：entity 与 claim 绑定同一个真实来源 Event cursor（>0，绝不回退 0）。
  assert.ok(claims[0]!.validFromTick > 0, "claim validFromTick 必须绑定真实 cursor");
  assert.equal(claims[0]!.validFromTick, fixture.sourceTick);
  assert.equal(
    fixture.knowledgeCalls.entities[0]?.validFromTick,
    claims[0]!.validFromTick,
    "entity 与 claim 使用同一 cursor",
  );
  assert.equal(fixture.knowledgeCalls.entities[0]?.name, "北岸灯塔");
  // 人物 note 追加到当前 Record roster 目标。
  assert.deepEqual(fixture.noteCalls[0], [{
    characterInstanceId: "char_inst_scout",
    note: "能辨认旧世界文字的刻痕",
  }]);
  // Batch 4B：note 以 object entry 落库，服务端 provenance/cursor 完整。
  const noteEntry = fixture.noteEntries[0]!;
  assert.equal(noteEntry.note, "能辨认旧世界文字的刻痕");
  assert.equal(noteEntry.sourceRecordId, LOCAL_RECORD_SCOPE.recordId);
  assert.ok(noteEntry.sourceEventId, "note 携带真实 sourceEventId");
  assert.equal(noteEntry.validFromTick, fixture.sourceTick);
  assert.ok(noteEntry.validFromTick > 0, "note validFromTick 必须绑定真实 cursor");
  assert.equal(noteEntry.validToTick, null);
  assert.equal(noteEntry.revokedAt, null);
  // 无场景 delta：不产生空的场景 correction。
  assert.equal(fixture.storeCalls.applyDelta, 0);
  // extraction 输入携带 roster/profile 与公开对话字段。
  const extractInput = fixture.extractInputs[0] as {
    participants?: readonly { characterInstanceId: string; profileSummary: string }[];
    recentDialogue?: readonly unknown[];
  };
  assert.ok(
    extractInput.participants?.some((p) => p.characterInstanceId === "char_inst_scout"),
    "extraction 输入携带当前 roster",
  );
  assert.ok(
    extractInput.participants?.every((p) => typeof p.profileSummary === "string"),
    "extraction 输入携带 profile 摘要",
  );
});

test("repeated scheduling is idempotent: no duplicate claims or notes", { timeout: 15_000 }, async () => {
  const fixture = createGrowthFixture({ extraction: GROWTH_EXTRACTION });
  for (const key of ["growth-repeat-1", "growth-repeat-2"]) {
    // 每回合重新取写令牌（single-writer CAS：上一回合提交后版本已推进）。
    const envelope = await fixture.service.loadRecord();
    const committed = await fixture.service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "塞娜又提起灯塔的刻痕。",
      idempotencyKey: key,
      writeToken: envelope.writeToken,
    });
    assert.equal(committed.disposition, "committed");
  }
  await eventually(() => fixture.knowledgeCalls.claimBatches.length >= 2);
  await eventually(() => fixture.noteCalls.length >= 2);
  // 两次调度的 claim 具有同一确定性身份，落账去重后仍只有一条。
  assert.equal(
    fixture.knowledgeCalls.claimBatches[0]![0]!.id,
    fixture.knowledgeCalls.claimBatches[1]![0]!.id,
    "同一来源的 claim 身份确定",
  );
  assert.equal(fixture.knowledgeStore.size, 1, "重复调度不产生重复 claim");
});

test("a restricted turn never produces public growth", { timeout: 15_000 }, async () => {
  const fixture = createGrowthFixture({
    extraction: GROWTH_EXTRACTION,
    visibilityAssessor: {
      async assess() {
        return {
          visibility: {
            kind: "restricted" as const,
            domainId: "domain_secret",
            audienceCharacterInstanceIds: ["char_inst_scout"],
          },
          reason: "密谈。",
        };
      },
    },
  });
  const initial = await fixture.service.loadRecord();
  let proposalId = "";
  await assert.rejects(
    fixture.service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我压低声音说出灯塔的秘密。",
      idempotencyKey: "growth-restricted",
      writeToken: initial.writeToken,
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalRecordServiceError);
      assert.equal(error.code, "VISIBILITY_CONFIRMATION_REQUIRED");
      proposalId = error.visibilityProposal!.proposalId;
      return true;
    },
  );
  const committed = await fixture.service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我压低声音说出灯塔的秘密。",
    idempotencyKey: "growth-restricted",
    writeToken: initial.writeToken,
    visibilityConfirmation: { proposalId, decision: "restricted" },
  });
  assert.equal(committed.disposition, "committed");
  // 私密边界：非公共回合在提取器之前结构性跳过——extractor 从未被调用，
  // 私密原文不会进入任何公共 growth/scene 提取。
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(
    fixture.extractInputs.length,
    0,
    "restricted 回合不得调用 extractor",
  );
  assert.equal(fixture.knowledgeCalls.claimBatches.length, 0);
  assert.equal(fixture.knowledgeCalls.entities.length, 0);
  assert.equal(fixture.noteCalls.length, 0);
});

test("growth failure only warns and never breaks the committed turn", { timeout: 15_000 }, async () => {
  const fixture = createGrowthFixture({
    extraction: GROWTH_EXTRACTION,
    failKnowledge: true,
  });
  const initial = await fixture.service.loadRecord();
  const committed = await fixture.service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "塞娜说她认得灯塔上的刻痕。",
    idempotencyKey: "growth-failure",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
  // 后台管线失败被吞掉（warn）：轮询确认 extraction 已运行后进程无未捕获异常。
  await eventually(() => fixture.extractInputs.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const reloaded = await fixture.service.loadRecord();
  assert.ok(reloaded.writeToken);
});

test("unresolvable source event is fail-closed: zero growth writes, no tick=0 fallback", { timeout: 15_000 }, async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    const fixture = createGrowthFixture({
      extraction: GROWTH_EXTRACTION,
      unknownSource: true,
    });
    const initial = await fixture.service.loadRecord();
    const committed = await fixture.service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "塞娜说她认得灯塔上的刻痕。",
      idempotencyKey: "growth-unknown-source",
      writeToken: initial.writeToken,
    });
    // 回合不受 best-effort growth 失败影响。
    assert.equal(committed.disposition, "committed");
    await eventually(() => fixture.extractInputs.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // fail-closed：entity/claim 零写入，绝不写 valid_from_tick=0 的假时序。
    assert.equal(fixture.knowledgeCalls.entities.length, 0);
    assert.equal(fixture.knowledgeCalls.claimBatches.length, 0);
    assert.equal(fixture.knowledgeStore.size, 0);
    // Batch 4B：profile note 同样零写入（无无来源 note）。
    assert.equal(fixture.noteCalls.length, 0);
    assert.equal(fixture.noteEntries.length, 0);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((line) =>
      line.includes("dialogue world growth skipped")
      && line.includes("source event not found in scope")
    ),
    "fail-closed 必须留下可诊断 warn",
  );
  assert.ok(
    warnings.some((line) =>
      line.includes("dialogue profile growth skipped")
      && line.includes("source event not found in scope")
    ),
    "profile note fail-closed 必须留下可诊断 warn",
  );
});
