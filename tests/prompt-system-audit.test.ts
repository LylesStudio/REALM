/**
 * Prompt System v2 全量审计（public documentation）：
 * 1. 每条生产链的 system message 必须 English-only（无 CJK）；
 * 2. 动态中文世界资料/角色名/玩家原话只出现在 user context block；
 * 3. anti-AI（NATURAL_VOICE_RULES）只注入自然语言生成链，分类器没有；
 * 4. 生产 prompt 源码不得残留旧中文惯用语/写死 demo 名；
 * 5. Tavern 用户导入的 system_prompt 不属于本审计（tavern-import-service
 *    无 prompt 构造，profile 摘要只是数据）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ModelChatRequest,
  ModelGateway,
  ModelProviderSettings,
} from "../modules/inference/public.ts";
import { createLocalModelSettingsStore } from "../modules/inference/local-settings.ts";
import { createModelSettingsService } from "../modules/application/model-settings-service.ts";
import {
  createModelDynamicDiscoveryGenerator,
  createModelPoweredM2TurnOrchestrator,
  createModelPresenceAssessor,
  createModelVisibilityAssessor,
} from "../modules/orchestration/public.ts";
import { createSceneCrystallizer } from "../modules/application/scene-crystallization.ts";
import { buildFirstNightMessages } from "../modules/application/first-night.ts";
import { generateGenesisDraft } from "../modules/application/world-genesis.ts";
import { generateGenesisChatReply } from "../modules/application/genesis-chat.ts";
import { generateGenesisSuggestions } from "../modules/application/genesis-suggestions.ts";
import { createModelSemanticConflictAssessor } from "../modules/worldline/semantic-conflict.ts";

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;
const VOICE_MARKER = "No assistant mannerisms";

function capturingGateway(
  captured: ModelChatRequest[],
  reply: unknown = { ok: true },
): ModelGateway {
  return {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      return {
        model: "fake-model",
        content: typeof reply === "string" ? reply : JSON.stringify(reply),
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

function assertSystemEnglishOnly(captured: ModelChatRequest[], label: string) {
  assert.ok(captured.length > 0, `${label}: 至少产生一次模型调用`);
  for (const request of captured) {
    const system = request.messages[0]?.content ?? "";
    assert.equal(request.messages[0]?.role, "system", `${label}: 首条为 system`);
    assert.ok(!CJK.test(system), `${label}: system 不得含 CJK：${system.slice(0, 80)}`);
  }
}

const CHINESE_BRIEF = {
  worldName: "烬海诸国",
  era: "停战纪元 17 年",
  summary: "人魔停战十七年后。",
  storyTitle: "无声钟",
  premise: "一封密函被送上岸。",
  location: "灰鲸港",
  weather: "冷雾",
  tension: "戒备",
  objective: "拆开密函",
  canon: "- 北岸灯塔 状态：无风夜自行点亮",
  worldLore: "",
};

const SCOUT = {
  characterInstanceId: "scout-instance",
  participantId: "scout-participant",
  displayName: "塞娜",
};

test("orchestration turn: every system message is English-only, dynamic data stays in user", async () => {
  const captured: ModelChatRequest[] = [];
  const gateway = capturingGateway(captured, {
    goal: "回应玩家", activatedCharacterInstanceIds: [], narratorEnabled: true,
  });
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
    brief: CHINESE_BRIEF,
  });
  await orchestrator.plan({ turnId: "turn-audit", playerText: "我抬头看灯。" });
  assertSystemEnglishOnly(captured, "DM plan");
  const user = captured[0]?.messages[1]?.content ?? "";
  assert.ok(user.includes("烬海诸国"), "动态世界名进 user context");
  assert.ok(user.includes("我抬头看灯"), "玩家原话进 user context");
  assert.ok(user.includes(CHINESE_BRIEF.canon), "canon 原文进 user context");
  const system = captured[0]?.messages[0]?.content ?? "";
  assert.ok(!system.includes("烬海诸国"), "动态世界名不得进 system");
  assert.ok(!system.includes("塞娜"), "动态角色名不得进 system");
  assert.match(system, /binding established history/);
});

test("visibility and presence gates are English-only classifiers without voice rules", async () => {
  const captured: ModelChatRequest[] = [];
  const gateway = capturingGateway(captured, {
    visibility: "public",
    audienceCharacterInstanceIds: [],
    reason: "公开喊话。",
  });
  const visibility = createModelVisibilityAssessor({
    player: SCOUT,
    characters: [SCOUT],
    getGateway: async () => gateway,
    brief: CHINESE_BRIEF,
  });
  await visibility.assess({ playerText: "大家听我说。" });
  assertSystemEnglishOnly(captured, "visibility");
  assert.ok(!captured[0]?.messages[0]?.content.includes(VOICE_MARKER));

  const presenceCaptured: ModelChatRequest[] = [];
  const presenceGateway = capturingGateway(presenceCaptured, {
    shouldSpeak: false,
    characterInstanceId: null,
    triggerKind: null,
    reason: "没有素材。",
  });
  const presence = createModelPresenceAssessor({
    getGateway: async () => presenceGateway,
    brief: CHINESE_BRIEF,
  });
  await presence.assess({
    context: { environment: ["冷雾漫过防波堤。"], peer: [], hook: null },
    candidates: [SCOUT],
    budget: 1,
  });
  assertSystemEnglishOnly(presenceCaptured, "presence gate");
  assert.ok(!presenceCaptured[0]?.messages[0]?.content.includes(VOICE_MARKER));
  assert.ok(
    presenceCaptured[0]?.messages[1]?.content.includes("冷雾漫过防波堤"),
    "触发素材原文进 user context",
  );
});

test("natural-language chains carry voice rules; dynamic names stay out of system", async () => {
  const captured: ModelChatRequest[] = [];
  const routingGateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      const system = request.messages[0]?.content ?? "";
      const content = system.includes("independent Narrator")
        ? JSON.stringify({
          environment: "冷雾沿石阶向上漫开。",
          storyBeat: "港口尽头亮起一盏灯。",
          suggestions: [],
        })
        : JSON.stringify({ action: "塞娜抬眼。", dialogue: "“雾又浓了。”" });
      return {
        model: "fake-model",
        content,
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => routingGateway,
    brief: CHINESE_BRIEF,
  });
  const plan = {
    goal: "回应玩家",
    constraints: [],
    activatedCharacters: [SCOUT],
    narratorEnabled: true,
    actionBudgetPerCharacter: 1,
    visibility: { kind: "public" as const },
  };
  await orchestrator.draft({ turnId: "turn-voice", playerText: "你看向塞娜。", plan });
  const reactCalls = captured.filter((request) =>
    request.messages[0]?.content.includes("You speak only as the character")
  );
  assert.ok(reactCalls.length > 0, "presence/ordinary react 链被触发");
  const narratorCalls = captured.filter((request) =>
    request.messages[0]?.content.includes("independent Narrator")
  );
  assert.ok(narratorCalls.length > 0, "narrator 链被触发");
  for (const call of [...reactCalls, ...narratorCalls]) {
    const system = call.messages[0]?.content ?? "";
    assert.ok(!CJK.test(system));
    assert.ok(system.includes(VOICE_MARKER), "自然语言链必须有 anti-AI voice 规则");
    assert.ok(!system.includes("塞娜"), "动态角色名不得进 system");
  }
  for (const call of reactCalls) {
    assert.ok(call.messages[1]?.content.includes("[Character]"));
    assert.ok(call.messages[1]?.content.includes("塞娜"), "角色名在 user [Character] 块");
  }
  // narrator 的禁止名单是调用时数据，进 user context。
  const narratorUser = narratorCalls[0]?.messages[1]?.content ?? "";
  assert.ok(narratorUser.includes("forbidden"), "forbiddenNames 块在 user 侧");
});

test("scene crystallizer extraction and adjudication are English-only", async () => {
  const captured: ModelChatRequest[] = [];
  const crystallizer = createSceneCrystallizer({
    getGateway: async () => capturingGateway(captured, { location: "灯塔" }),
  });
  await crystallizer.extract({
    playerText: "我推门走进灯塔。",
    turnSummary: "门轴发出涩响。",
    current: {
      worldName: "烬海诸国",
      era: "停战纪元",
      displayTime: "深夜",
      location: "灰鲸港",
      weather: "冷雾",
      tension: "戒备",
      objective: "拆信",
    },
  });
  assertSystemEnglishOnly(captured, "scene extraction");
  assert.ok(captured[0]?.messages[1]?.content.includes("我推门走进灯塔"));
  // 上限与 normalizer 同源：prompt 里的数字必须等于 FIELD_LIMITS。
  const system = captured[0]?.messages[0]?.content ?? "";
  assert.match(system, /"objective"\?: string \(<= 120 chars\)/);
  assert.ok(!system.includes("20 字"), "旧脱节上限文案已移除");

  const verdictCaptured: ModelChatRequest[] = [];
  const adjudicating = createSceneCrystallizer({
    getGateway: async () => capturingGateway(verdictCaptured, {
      approved: true, reason: "consistent", adjusted: null,
    }),
  });
  await adjudicating.adjudicate({
    playerText: "我推门走进灯塔。",
    turnSummary: "门轴发出涩响。",
    current: {
      worldName: "烬海诸国",
      era: "停战纪元",
      displayTime: "深夜",
      location: "灰鲸港",
      weather: "冷雾",
      tension: "戒备",
      objective: "拆信",
    },
    delta: { location: "灯塔" },
  });
  assertSystemEnglishOnly(verdictCaptured, "scene adjudication");
  assert.ok(!verdictCaptured[0]?.messages[0]?.content.includes(VOICE_MARKER));
});

test("first-night messages: English system, dynamic world data in user, voice rules present", () => {
  const { system, user } = buildFirstNightMessages({
    world: { name: "烬海诸国", era: "停战纪元", summary: "人魔停战十七年后。" },
    story: { title: "无声钟", premise: "密函上岸。" },
    playerRole: "守夜人",
    companions: [{ name: "塞娜", role: "斥候", summary: "沉默的观察者。" }],
    scene: { location: "灰鲸港", weather: "冷雾", tension: "戒备", objective: "拆信" },
    opening: "雾压在港口的屋顶上。",
    playerName: "旅人",
    playerStance: "player",
    style: "modern",
  });
  assert.ok(!CJK.test(system), "first-night system 不得含 CJK");
  assert.ok(system.includes(VOICE_MARKER));
  assert.ok(user.includes("烬海诸国") && user.includes("塞娜"), "动态资料在 user");
  assert.ok(!system.includes("简体中文"), "语言规则不再写死简体中文");
  assert.match(system, /configured language/);
});

test("genesis draft/chat/suggestions and semantic conflict systems are English-only", async () => {
  const draftCaptured: ModelChatRequest[] = [];
  const draft = await generateGenesisDraft(
    capturingGateway(draftCaptured, { world: { name: "雾港" } }),
    "一座总有雾的港口城市，灯塔会在无风夜自行点亮。",
  );
  assert.ok(draft);
  assertSystemEnglishOnly(draftCaptured, "genesis draft");
  assert.ok(draftCaptured[0]?.messages[1]?.content.includes("一座总有雾的港口城市"));
  assert.ok(!/塞娜|弥洛|洛川/.test(draftCaptured[0]?.messages[0]?.content ?? ""),
    "写死的排除名已移除");

  const chatCaptured: ModelChatRequest[] = [];
  const reply = await generateGenesisChatReply(
    capturingGateway(chatCaptured, { reply: "继续。", phase: "exploring", draftPatch: null }),
    { message: "我想要一个有雾的港口。", transcript: [], draft: null },
  );
  assert.ok(reply);
  assertSystemEnglishOnly(chatCaptured, "genesis chat");

  const suggestionCaptured: ModelChatRequest[] = [];
  await generateGenesisSuggestions(
    capturingGateway(suggestionCaptured, { suggestions: ["雾港", "灯塔城", "潮声镇"] }),
    { step: "world-name", intent: "想要有雾的港口", context: {} },
  );
  assertSystemEnglishOnly(suggestionCaptured, "genesis suggestions");

  const conflictCaptured: ModelChatRequest[] = [];
  const assessor = createModelSemanticConflictAssessor({
    getGateway: async () => capturingGateway(conflictCaptured, {
      kind: "other", severity: "none", recommendation: "merge", rationale: "无冲突。",
    }),
  });
  await assessor.evaluate({
    changeSet: {
      changes: [{
        kind: "assert",
        subjectEntityId: "entity_lighthouse",
        predicate: "状态",
        objectValue: "点亮",
        effectiveCursor: { tick: 1, ordinal: 1, calendarId: "cal", display: "深夜" },
      }],
    },
    existingClaims: [],
    deterministicSeverity: "high-risk",
    deterministicReason: "无硬锚点",
  });
  assertSystemEnglishOnly(conflictCaptured, "semantic conflict");
  assert.ok(conflictCaptured[0]?.messages[1]?.content.includes("无硬锚点"));
});

test("dynamic discovery is an English-only NLG chain with shared field limits", async () => {
  const captured: ModelChatRequest[] = [];
  const generator = createModelDynamicDiscoveryGenerator({
    getGateway: async () => capturingGateway(captured, {
      subject: "蜡封边缘",
      feature: "细痕横切压纹",
      nextCheck: "检查封蜡内侧",
    }),
  });
  const result = await generator.generate({
    actor: SCOUT,
    call: {
      callId: "call-1",
      name: "use_skill",
      arguments: { skillId: "careful_observation", targetId: "letter_seal", intent: "辨认蜡封是否被动过" },
    },
    skill: { skillKey: "careful_observation", title: "细致观察", description: "辨认细微痕迹。" },
    outcome: "success",
    publicFact: "蜡封完好无损",
    context: { ...CHINESE_BRIEF, recentPublicEvents: ["雾笛在远处响过一次。"] },
  });
  assert.ok(result);
  assertSystemEnglishOnly(captured, "dynamic discovery");
  const system = captured[0]?.messages[0]?.content ?? "";
  const user = captured[0]?.messages[1]?.content ?? "";
  assert.ok(system.includes(VOICE_MARKER), "discovery 是自然语言链，必须有 voice 规则");
  assert.match(system, /"subject": string \(<= 160 chars\)/, "上限与 DISCOVERY_FIELD_LIMITS 同源");
  assert.ok(user.includes("辨认蜡封是否被动过"), "行动意图原文进 user context");
  assert.ok(user.includes("雾笛在远处响过一次。"), "公开事件原文进 user context");
});

test("connectivity probe is an English-only structured chain with shared schema", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realm-probe-audit-"));
  try {
    const store = createLocalModelSettingsStore({
      filePath: join(directory, "model-providers.json"),
      environment: {},
    });
    await store.saveProfile({
      schemaVersion: 1,
      providerId: "lmstudio",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiKey: "",
      selectedModel: "probe-model",
      thinking: "disabled",
      timeoutMs: 30_000,
      maxTokens: 2_048,
      availableModels: [],
      lastDiscoveredAt: null,
      updatedAt: "2026-08-31T00:00:00.000Z",
    } satisfies ModelProviderSettings, true);
    const captured: ModelChatRequest[] = [];
    const service = createModelSettingsService({
      store,
      createGateway: () => capturingGateway(captured, { ok: true }),
    });
    await service.test({ providerId: "lmstudio" });
    assertSystemEnglishOnly(captured, "connectivity probe");
    assert.match(
      captured[0]?.messages[0]?.content ?? "",
      /"ok": boolean/,
      "probe system 携带同源 schema",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test("SWM v2: lore excerpts enter user context as background, canon stays binding, crystallization excluded", async () => {
  const captured: ModelChatRequest[] = [];
  const gateway = capturingGateway(captured, {
    goal: "回应玩家", activatedCharacterInstanceIds: [], narratorEnabled: true,
  });
  const loreBrief = {
    ...CHINESE_BRIEF,
    worldLore: "- 《灯塔志》：灯塔建于停战前夜，守灯人世代更替。",
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
    brief: loreBrief,
  });
  await orchestrator.plan({ turnId: "turn-lore", playerText: "我抬头看灯。" });
  const system = captured[0]?.messages[0]?.content ?? "";
  const user = captured[0]?.messages[1]?.content ?? "";
  assert.ok(user.includes("[World lore excerpts]"), "lore 块必须在 user 侧");
  assert.ok(user.includes("灯塔志"), "lore 原文进 user context");
  assert.ok(!system.includes("灯塔志"), "lore 动态内容不得进 system");
  assert.ok(!CJK.test(system));
  assert.match(system, /background reference only.*yield to canon|must always yield to canon/, "canon 优先静态规则在 system");

  // 空 lore：块结构性缺席。
  const emptyCaptured: ModelChatRequest[] = [];
  const emptyOrchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => capturingGateway(emptyCaptured, {
      goal: "回应玩家", activatedCharacterInstanceIds: [], narratorEnabled: true,
    }),
    brief: { ...CHINESE_BRIEF, worldLore: "" },
  });
  await emptyOrchestrator.plan({ turnId: "turn-lore-empty", playerText: "我抬头看灯。" });
  assert.ok(
    !(emptyCaptured[0]?.messages[1]?.content ?? "").includes("[World lore excerpts]"),
    "空 lore 时 lore 块结构性缺席",
  );

  // 晶化链结构性排除：其 user 不出现 lore 块（输入契约不含 lore）。
  const crystalCaptured: ModelChatRequest[] = [];
  const crystallizer = createSceneCrystallizer({
    getGateway: async () => capturingGateway(crystalCaptured, { location: "灯塔" }),
  });
  await crystallizer.extract({
    playerText: "我推门走进灯塔。",
    turnSummary: "门轴发出涩响。",
    current: {
      worldName: "烬海诸国",
      era: "停战纪元",
      displayTime: "深夜",
      location: "灰鲸港",
      weather: "冷雾",
      tension: "戒备",
      objective: "拆信",
    },
  });
  assert.ok(
    !(crystalCaptured[0]?.messages[1]?.content ?? "").includes("[World lore excerpts]"),
    "scene crystallization 不得消费 lore excerpt",
  );
  // 源码级围栏：晶化模块不得引用 worldLore。
  const crystalSource = readFileSync(
    new URL("../modules/application/scene-crystallization.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!crystalSource.includes("worldLore"), "scene-crystallization.ts 不得引用 worldLore");
});


test("SWM v2: lore consumers are explicit opt-in — classifiers/reviewer never receive lore", async () => {
  const loreBrief = {
    ...CHINESE_BRIEF,
    worldLore: "- 《灯塔志》：灯塔建于停战前夜，守灯人世代更替。",
  };

  // visibility gate：user 不得含 lore。
  const visCaptured: ModelChatRequest[] = [];
  const visibility = createModelVisibilityAssessor({
    player: SCOUT,
    characters: [SCOUT],
    getGateway: async () => capturingGateway(visCaptured, {
      visibility: "public", audienceCharacterInstanceIds: [], reason: "公开。",
    }),
    brief: loreBrief,
  });
  await visibility.assess({ playerText: "大家听我说。" });
  assert.ok(
    !(visCaptured[0]?.messages[1]?.content ?? "").includes("[World lore excerpts]"),
    "visibility gate 不得消费 lore",
  );

  // presence gate：user 不得含 lore。
  const presCaptured: ModelChatRequest[] = [];
  const presence = createModelPresenceAssessor({
    getGateway: async () => capturingGateway(presCaptured, {
      shouldSpeak: false, characterInstanceId: null, triggerKind: null, reason: "无。",
    }),
    brief: loreBrief,
  });
  await presence.assess({
    context: { environment: ["冷雾漫过防波堤。"], peer: [], hook: null },
    candidates: [SCOUT],
    budget: 1,
  });
  assert.ok(
    !(presCaptured[0]?.messages[1]?.content ?? "").includes("[World lore excerpts]"),
    "presence gate 不得消费 lore",
  );

  // 完整 orchestrator 流程：DM plan 与 reviewer——plan 有 lore、reviewer 无 lore。
  const flowCaptured: ModelChatRequest[] = [];
  const flowGateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      flowCaptured.push(request);
      const system = request.messages[0]?.content ?? "";
      const json = (value: unknown) => ({
        model: "fake-model",
        content: JSON.stringify(value),
        toolCalls: [] as const,
        finishReason: "stop",
        usage: null,
      });
      if (request.tools) {
        return {
          model: "fake-model",
          content: "",
          toolCalls: [{
            id: "call-1",
            name: "act",
            arguments: { intent: "查看灯塔", targetId: "lighthouse", approach: "cautious" },
          }] as const,
          finishReason: "tool_calls",
          usage: null,
        };
      }
      if (system.includes("DM Controller")) {
        return json({
          goal: "回应玩家",
          activatedCharacterInstanceIds: ["scout-instance"],
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
      throw new Error("unexpected call");
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => flowGateway,
    brief: loreBrief,
  });
  const input = { turnId: "turn-lore-flow", playerText: "我去看看灯塔。" };
  const plan = await orchestrator.plan(input);
  const planUser = flowCaptured.at(-1)?.messages[1]?.content ?? "";
  assert.ok(planUser.includes("[World lore excerpts]"), "DM plan 是允许的 lore 消费者");
  const candidate = await orchestrator.draft({ ...input, plan });
  await orchestrator.validate({ plan, candidate });
  const reviewerCalls = flowCaptured.filter((request) =>
    (request.messages[0]?.content ?? "").includes("DM output reviewer")
  );
  assert.ok(reviewerCalls.length > 0, "reviewer 必须被真实流程触发");
  for (const call of reviewerCalls) {
    assert.ok(
      !(call.messages[1]?.content ?? "").includes("[World lore excerpts]"),
      "DM output reviewer 不得消费 lore",
    );
  }
  // narrator 与 character react 是允许的消费者。
  const narratorUser = flowCaptured.find((request) =>
    (request.messages[0]?.content ?? "").includes("independent Narrator")
  )?.messages[1]?.content ?? "";
  assert.ok(narratorUser.includes("[World lore excerpts]"), "Narrator 是允许的 lore 消费者");
  const reactUser = flowCaptured.find((request) =>
    (request.messages[0]?.content ?? "").includes("You speak only as the character")
  )?.messages[1]?.content ?? "";
  assert.ok(reactUser.includes("[World lore excerpts]"), "Character Runner 是允许的 lore 消费者");
});

test("production prompt sources contain no legacy Chinese prompt idioms or demo bans", () => {
  const files = [
    "modules/orchestration/model-powered.ts",
    "modules/application/scene-crystallization.ts",
    "modules/application/first-night.ts",
    "modules/application/world-genesis.ts",
    "modules/application/genesis-chat.ts",
    "modules/application/genesis-suggestions.ts",
    "modules/worldline/semantic-conflict.ts",
    "modules/application/model-settings-service.ts",
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.ok(!source.includes("只输出 json"), `${file}: 旧中文输出指令残留`);
    assert.ok(!source.includes("只输出一个 JSON"), `${file}: 旧中文输出指令残留`);
    assert.ok(!source.includes("输出 JSON。"), `${file}: 旧中文催稿行残留`);
    assert.ok(!source.includes("回应语言必须"), `${file}: 旧枚举语言规则残留`);
    assert.ok(!/【.*】/.test(source), `${file}: 中文块标签残留`);
    assert.ok(!/不得使用「塞娜」/.test(source), `${file}: 写死排除名残留`);
  }
  // Tavern 导入服务是用户数据通道，不属于本审计；确认它没有 prompt 构造。
  const tavern = readFileSync(
    new URL("../modules/application/tavern-import-service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(!tavern.includes('role: "system"'), "tavern-import 不得构造模型消息");
});
