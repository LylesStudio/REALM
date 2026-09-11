import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/types.ts";
import { generateGenesisDraft } from "../modules/application/world-genesis.ts";
import { normalizeGenesisDraft } from "../modules/application/world-genesis-contract.ts";
import {
  buildFirstNightMessages,
  normalizeFirstNightPack,
  type FirstNightContext,
} from "../modules/application/first-night.ts";
import {
  generateGenesisSuggestions,
  normalizeGenesisSuggestions,
} from "../modules/application/genesis-suggestions.ts";
import {
  createSceneCrystallizer,
  normalizeGrowthCharacterNotes,
  normalizeGrowthWorldClaims,
} from "../modules/application/scene-crystallization.ts";
import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/model-powered.ts";

/**
 * Cleanup Phase 4 / Batch 1：schema 声明与 normalizer 实际形状的契约测试。
 * 每一处都用 prompt capture 验证模型实际看到的类型文本，并用 round-trip
 * 验证 normalizer 接收该形状、对不匹配输入保持 fail-closed。
 */

function jsonResponse(value: unknown): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };
}

function fakeGateway(
  handler: (request: ModelChatRequest) => Promise<ModelChatResponse>,
): ModelGateway {
  return {
    async discoverModels() {
      return [];
    },
    chat: handler,
  };
}

const FIRST_NIGHT_CONTEXT: FirstNightContext = {
  world: { name: "灯塔港", era: "潮声纪元", summary: "雾中灯塔。" },
  style: "modern",
  story: { title: "序章", premise: "守塔人失踪。" },
  playerRole: "守塔学徒",
  playerName: "",
  playerStance: "player",
  companions: [
    { name: "阿葵", role: "灯塔医师", summary: "沉默而可靠。" },
    { name: "小满", role: "见习守塔人", summary: "好奇。" },
  ],
  scene: { location: "灯塔顶", weather: "浓雾", tension: "低", objective: "点亮主灯" },
  opening: "",
};

test("world genesis companions: schema declares object[] and normalizer accepts it", async () => {
  let systemPrompt = "";
  const gateway = fakeGateway(async (request) => {
    systemPrompt = request.messages[0]?.content ?? "";
    return jsonResponse({
      world: { name: "灯塔港", era: "潮声纪元", summary: "雾中灯塔。" },
      story: { title: "序章", premise: "守塔人失踪。" },
      record: { title: "第一笔" },
      playerRole: "新来的守塔学徒",
      companions: [{ name: "阿葵", role: "灯塔医师", summary: "沉默而可靠。" }],
      scene: { location: "灯塔顶", weather: "浓雾", tension: "低", objective: "点亮主灯" },
    });
  });
  const draft = await generateGenesisDraft(gateway, "一座雾中的灯塔");
  assert.ok(draft, "draft should be produced");
  assert.match(systemPrompt, /"companions": array of objects/);
  assert.ok(!systemPrompt.includes('"companions": string[]'));
  assert.equal(draft.companions[0]?.name, "阿葵");
});

test("world genesis companions: non-object items stay fail-closed", () => {
  const draft = normalizeGenesisDraft(
    {
      world: { name: "灯塔港" },
      companions: ["阿葵", { name: "小满", role: "学徒", summary: "好奇。" }],
    },
    "一座雾中的灯塔",
  );
  assert.ok(draft);
  assert.deepEqual(draft.companions.map((item) => item.name), ["小满"]);
});

test("first-night characters: schema declares object[] and normalizer accepts it", () => {
  const { system } = buildFirstNightMessages(FIRST_NIGHT_CONTEXT);
  assert.match(system, /"characters": array of objects/);
  assert.ok(!system.includes('"characters": string[]'));
  const pack = normalizeFirstNightPack(
    {
      scene: { environment: "浓雾压在灯塔顶。", story: "主灯熄灭。", fact: "灯油早已见底。" },
      characters: [
        { name: "阿葵", utterance: "先把灯油找来。", action: "检查灯芯" },
        { name: "小满", utterance: "我去库房。", action: "转身下楼" },
      ],
      hook: { content: "库房的锁坏了。", suggestions: ["检查库房", "询问阿葵"] },
    },
    FIRST_NIGHT_CONTEXT,
  );
  assert.ok(pack);
  assert.deepEqual(pack.characters.map((item) => item.name), ["阿葵", "小满"]);
});

test("first-night characters: non-object items stay fail-closed", () => {
  const pack = normalizeFirstNightPack(
    {
      scene: { environment: "浓雾。", story: "灯灭。", fact: "油尽。" },
      characters: ["阿葵", { name: "小满", utterance: "我去。", action: "下楼" }],
      hook: { content: "锁坏了。", suggestions: ["检查库房", "询问阿葵"] },
    },
    FIRST_NIGHT_CONTEXT,
  );
  assert.ok(pack);
  assert.deepEqual(pack.characters.map((item) => item.name), ["小满"]);
});

test("genesis suggestions: structured steps declare object[], text steps keep string[]", async () => {
  let companionsSystem = "";
  const companions = await generateGenesisSuggestions(
    fakeGateway(async (request) => {
      companionsSystem = request.messages[0]?.content ?? "";
      return jsonResponse({
        suggestions: [{ name: "阿葵", role: "医师", summary: "沉默而可靠。" }],
      });
    }),
    { step: "companions", intent: "", context: {} },
  );
  assert.ok(companions, "companions suggestions should normalize");
  assert.match(companionsSystem, /"suggestions": array of objects/);
  assert.ok(!companionsSystem.includes('"suggestions": string[]'));

  let worldNameSystem = "";
  const names = await generateGenesisSuggestions(
    fakeGateway(async (request) => {
      worldNameSystem = request.messages[0]?.content ?? "";
      return jsonResponse({ suggestions: ["灯塔港", "雾角", "潮声湾"] });
    }),
    { step: "world-name", intent: "", context: {} },
  );
  assert.ok(names, "world-name suggestions should normalize");
  assert.match(worldNameSystem, /"suggestions": string\[\]/);
  assert.ok(!worldNameSystem.includes('"suggestions": array of objects'));
});

test("genesis suggestions: mismatched shapes stay fail-closed", () => {
  // companions 步收到字符串数组 → 全部丢弃 → null（不为模型放宽）。
  assert.equal(
    normalizeGenesisSuggestions("companions", { suggestions: ["阿葵"] }),
    null,
  );
  // world-name 步收到对象数组 → 全部丢弃 → null。
  assert.equal(
    normalizeGenesisSuggestions("world-name", {
      suggestions: [{ name: "灯塔港" }],
    }),
    null,
  );
});

test("scene crystallization: growth fields declare object[] and round-trip", async () => {
  let system = "";
  const crystallizer = createSceneCrystallizer({
    getGateway: async () =>
      fakeGateway(async (request) => {
        system = request.messages[0]?.content ?? "";
        return jsonResponse({
          location: "灯塔顶",
          worldClaims: [
            { entity: "灯塔主灯", entityKind: "setting", predicate: "状态", value: "熄灭" },
          ],
          characterNotes: [{ characterInstanceId: "ci-1", note: "怕黑" }],
        });
      }),
  });
  const result = await crystallizer.extract({
    playerText: "我去看看主灯。",
    turnSummary: "守塔人走向灯塔顶层。",
    current: {
      worldName: "灯塔港",
      era: "潮声纪元",
      displayTime: "潮声纪元 第三夜",
      location: "灯塔下",
      weather: "浓雾",
      tension: "低",
      objective: "点亮主灯",
    },
    participants: [
      { characterInstanceId: "ci-1", participantId: "p-1", displayName: "阿葵", profileSummary: "灯塔医师" },
    ],
  });
  assert.ok(result, "extraction should succeed");
  assert.match(system, /"worldClaims"\?: array of objects/);
  assert.match(system, /"characterNotes"\?: array of objects/);
  assert.equal(result.worldClaims.length, 1);
  assert.equal(result.characterNotes.length, 1);
  assert.equal(result.characterNotes[0]?.note, "怕黑");
});

test("scene crystallization: growth normalizers stay fail-closed", () => {
  assert.deepEqual(
    normalizeGrowthWorldClaims([
      "not-an-object",
      { entity: "", predicate: "状态", value: "熄灭" },
      { entity: "灯塔主灯", entityKind: "unknown-kind", predicate: "状态", value: "熄灭" },
    ]).map((claim) => claim.entity),
    ["灯塔主灯"],
  );
  assert.equal(normalizeGrowthWorldClaims("not-array").length, 0);
  assert.deepEqual(
    normalizeGrowthCharacterNotes(
      [
        { characterInstanceId: "ci-1", note: "怕黑" },
        { characterInstanceId: "outsider", note: "x" },
      ],
      [{ characterInstanceId: "ci-1" }],
    ).map((note) => note.characterInstanceId),
    ["ci-1"],
  );
});

test("character propose: no respondOnly in prompt; no tool call means no action", async () => {
  const toolsRequests: ModelChatRequest[] = [];
  let reactSystem = "";
  const gateway = fakeGateway(async (request) => {
    const system = request.messages[0]?.content ?? "";
    if (request.tools) {
      toolsRequests.push(request);
      return jsonResponse({});
    }
    if (system.includes("DM Controller")) {
      return jsonResponse({
        goal: "回应玩家的自然询问",
        activatedCharacterInstanceIds: ["scout-instance"],
        narratorEnabled: false,
      });
    }
    if (system.includes("natural exchange")) {
      reactSystem = system;
      return jsonResponse({ action: "塞娜侧耳。", dialogue: "我在听。" });
    }
    if (system.includes("DM output reviewer")) {
      return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
    }
    throw new Error("Unexpected model call");
  });
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [{
      characterInstanceId: "scout-instance",
      participantId: "scout-participant",
      displayName: "塞娜",
    }],
    getGateway: async () => gateway,
  });
  const input = { turnId: "turn-propose-contract", playerText: "你还醒着吗？" };
  const plan = await orchestrator.plan(input);
  assert.equal(plan.actionBudgetPerCharacter, 1, "activated character gets a tool budget");
  const candidate = await orchestrator.draft({ ...input, plan });
  assert.equal(toolsRequests.length, 1, "propose issues exactly one tools request");
  const proposeSystem = toolsRequests[0]!.messages[0]?.content ?? "";
  assert.ok(!proposeSystem.includes("respondOnly"), "propose prompt must not mention respondOnly");
  assert.equal(candidate.actionTransactions.length, 0, "no tool call produces no action");
  // recipient nullable：react schema 精确标注 or null（归属校验由 presence 套件覆盖）。
  assert.match(reactSystem, /"recipientId": string or null/);
});
