import assert from "node:assert/strict";
import test from "node:test";
import {
  GENESIS_CHAT_MAX_TURNS,
  GENESIS_CHAT_MAX_TURN_CHARS,
  generateGenesisChatReply,
  mergeDraftPatch,
  normalizeGenesisChatResponse,
  sanitizeDraftPatch,
  truncateTranscript,
} from "../modules/application/genesis-chat.ts";
import type { ModelChatRequest, ModelChatResponse, ModelGateway } from "../modules/inference/public.ts";
import type { WorldGenesisDraft } from "../modules/application/world-genesis.ts";

function fakeGateway(responses: Array<{ content: string; model?: string }>) {
  const calls: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      calls.push(request);
      const next = responses.shift();
      const response: ModelChatResponse = {
        model: next?.model ?? "fake",
        content: next?.content ?? "",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
      return response;
    },
  };
  return { gateway, calls };
}

const BASE_DRAFT: WorldGenesisDraft = {
  world: { name: "雾都", era: "灯盏纪元", summary: "一座以灯计时的城市。" },
  style: "modern",
  story: { title: "熄灯之夜", premise: "最后一盏主灯开始闪烁。" },
  record: { title: "第一夜" },
  playerRole: "守灯人的学徒",
  companions: [{ name: "烛芯", role: "灯芯匠", summary: "记得每一盏灯的脾气。" }],
  scene: { location: "主灯塔", weather: "薄雾", tension: "灯火将熄", objective: "查明熄灯原因" },
  playerStance: "player",
  opening: "",
};

test("truncateTranscript keeps recent turns, clamps content and drops invalid entries", () => {
  const longContent = "字".repeat(GENESIS_CHAT_MAX_TURN_CHARS + 80);
  const turns = Array.from({ length: GENESIS_CHAT_MAX_TURNS - 1 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "scribe",
    content: `第${index}轮`,
  }));
  const noisy = [
    { role: "system", content: "不该出现" },
    { role: "user", content: "   " },
    { role: 42, content: "坏角色" },
    "not-an-object",
    { role: "user", content: longContent },
    ...turns,
  ];
  const result = truncateTranscript(noisy);
  assert.equal(result.length, GENESIS_CHAT_MAX_TURNS);
  // 只保留最近 16 条：长文条目恰好入选并被截断至 500 字。
  assert.equal(result[0].content.length, GENESIS_CHAT_MAX_TURN_CHARS);
  assert.equal(result[result.length - 1].content, `第${turns.length - 1}轮`);
  for (const turn of result) {
    assert.ok(turn.role === "user" || turn.role === "scribe");
  }
});

test("truncateTranscript rejects non-arrays", () => {
  assert.deepEqual(truncateTranscript(null), []);
  assert.deepEqual(truncateTranscript({ role: "user" }), []);
});

test("sanitizeDraftPatch keeps only known fields and clamps limits", () => {
  const patch = sanitizeDraftPatch({
    world: { name: "新".repeat(60), era: "新纪元", summary: "" },
    style: "classical",
    playerRole: "  巡游者  ",
    playerStance: "observer",
    opening: "启".repeat(400),
    companions: [
      { name: "甲", role: "向导", summary: "识路。" },
      { name: "", role: "无名", summary: "会被丢弃。" },
      { name: "乙", role: "信使", summary: "跑得快。" },
      { name: "丙", role: "多余", summary: "超过两名。" },
    ],
    unknownField: "drop me",
  });
  assert.ok(patch);
  assert.equal(patch.world?.name.length, 40);
  assert.equal(patch.world?.era, "新纪元");
  assert.equal(patch.world?.summary, undefined);
  assert.equal(patch.style, "classical");
  assert.equal(patch.playerRole, "巡游者");
  assert.equal(patch.playerStance, "observer");
  assert.equal(patch.opening?.length, 300);
  assert.deepEqual(patch.companions?.map((item) => item.name), ["甲", "乙"]);
});

test("sanitizeDraftPatch returns null without recognizable fields", () => {
  assert.equal(sanitizeDraftPatch({ foo: 1 }), null);
  assert.equal(sanitizeDraftPatch("text"), null);
  assert.equal(sanitizeDraftPatch(null), null);
});

test("mergeDraftPatch overwrites only present fields and normalizes", () => {
  const merged = mergeDraftPatch(BASE_DRAFT, {
    world: { name: "换名之都" },
    companions: [
      { name: "新伴", role: "引路人", summary: "替换原同伴。" },
      { name: "二伴", role: "书记", summary: "第二名。" },
      { name: "三伴", role: "溢出", summary: "会被截掉。" },
    ],
  });
  assert.ok(merged);
  assert.equal(merged.world.name, "换名之都");
  // 未出现在 patch 中的字段保持原值。
  assert.equal(merged.world.era, "灯盏纪元");
  assert.equal(merged.story.title, "熄灯之夜");
  assert.equal(merged.companions.length, 2);
  assert.equal(merged.companions[0].name, "新伴");
});

test("mergeDraftPatch is fail-closed on illegal merged structure", () => {
  // 无 base、patch 也不含世界名 → 规整后整体非法。
  assert.equal(mergeDraftPatch(null, { scene: { location: "某地" } }), null);
  // patch 类型非法时仅按 base 规整。
  const kept = mergeDraftPatch(BASE_DRAFT, "not-an-object");
  assert.equal(kept?.world.name, "雾都");
  assert.equal(mergeDraftPatch(null, null), null);
});

test("normalizeGenesisChatResponse enforces phase enum and reply presence", () => {
  assert.equal(
    normalizeGenesisChatResponse({ reply: "", phase: "exploring" }, null),
    null,
  );
  assert.equal(
    normalizeGenesisChatResponse({ reply: "你好", phase: "chatting" }, null),
    null,
  );
  assert.equal(normalizeGenesisChatResponse("text", null), null);
  const ok = normalizeGenesisChatResponse(
    { reply: "先从名字聊起？", phase: "exploring" },
    null,
  );
  assert.ok(ok);
  assert.equal(ok.draftPatch, null);
  assert.equal(ok.opening, "");
});

test("normalizeGenesisChatResponse drops an illegal patch but keeps the reply", () => {
  // patch 无法与 base 合成合法草稿（缺世界名）→ 丢弃 patch，对谈继续。
  const dropped = normalizeGenesisChatResponse(
    {
      reply: "提案来了。",
      phase: "proposing",
      draftPatch: { scene: { location: "港口" } },
    },
    null,
  );
  assert.ok(dropped);
  assert.equal(dropped.reply, "提案来了。");
  assert.equal(dropped.phase, "proposing");
  assert.equal(dropped.draftPatch, null);

  // 消毒后无任何可识别字段 → 同样按「本轮不定稿」处理，不失败。
  const garbage = normalizeGenesisChatResponse(
    { reply: "再聊聊。", phase: "exploring", draftPatch: { foo: 1 } },
    null,
  );
  assert.ok(garbage);
  assert.equal(garbage.draftPatch, null);

  // base 已有世界名时，仅改场景的 patch 合法 → 采纳。
  const kept = normalizeGenesisChatResponse(
    {
      reply: "场景已改。",
      phase: "proposing",
      draftPatch: { scene: { location: "港口" } },
    },
    BASE_DRAFT,
  );
  assert.ok(kept);
  assert.equal(kept.draftPatch?.scene?.location, "港口");

  const ok = normalizeGenesisChatResponse(
    {
      reply: "提案来了。",
      phase: "proposing",
      draftPatch: { world: { name: "港城" }, playerStance: "observer" },
    },
    null,
  );
  assert.ok(ok);
  assert.equal(ok.draftPatch?.world?.name, "港城");
  assert.equal(ok.draftPatch?.playerStance, "observer");
});

test("generateGenesisChatReply escalates model/thinking on degenerate responses", async () => {
  const good = JSON.stringify({
    reply: "雾从何来？",
    phase: "exploring",
    draftPatch: null,
  });
  const { gateway, calls } = fakeGateway([
    { content: "   " },          // ① 配置原样：纯空白退化
    { content: "" },             // ② 同模型关思考：仍空
    { content: good, model: "deepseek-v4-pro" }, // ③ 备选模型成功
  ]);
  const outcome = await generateGenesisChatReply(gateway, {
    message: "一座雾港",
    transcript: [],
    draft: null,
    fallbackModel: "deepseek-v4-pro",
  });
  assert.ok(outcome);
  assert.equal(outcome.reply, "雾从何来？");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].model, undefined);
  assert.equal(calls[0].thinking, undefined);
  assert.equal(calls[1].thinking, "disabled");
  assert.equal(calls[1].model, undefined);
  assert.equal(calls[2].thinking, "disabled");
  assert.equal(calls[2].model, "deepseek-v4-pro");
});

test("generateGenesisChatReply gives up silently after all attempts degenerate", async () => {
  const { gateway, calls } = fakeGateway([
    { content: "" },
    { content: "  " },
    { content: "{" },
    { content: "still-not-json" },
  ]);
  const outcome = await generateGenesisChatReply(gateway, {
    message: "一座雾港",
    transcript: [],
    draft: null,
    fallbackModel: "deepseek-v4-pro",
  });
  assert.equal(outcome, null);
  // Prompt System v2：三级空响应退化 + 非空但不可解析时恰好一次 repair。
  assert.equal(calls.length, 4);
  // repair 反馈为英文且带目标 schema，不回显模型原文。
  const repairRequest = calls[3];
  const repairMessage = repairRequest?.messages.at(-1)?.content ?? "";
  assert.match(repairMessage, /Return the corrected JSON object only/);
  assert.ok(!repairMessage.includes("still-not-json"));
});

test("normalizeGenesisChatResponse keeps opening only at ready phase", () => {
  const ready = normalizeGenesisChatResponse(
    {
      reply: "谈妥了。",
      phase: "ready",
      draftPatch: { world: { name: "港城" } },
      opening: "灯灭的那晚，".concat("海雾漫进了港城。".repeat(80)),
    },
    BASE_DRAFT,
  );
  assert.ok(ready);
  assert.equal(ready.opening.length, 300);

  const proposing = normalizeGenesisChatResponse(
    {
      reply: "先看看提案。",
      phase: "proposing",
      draftPatch: { world: { name: "港城" } },
      opening: "不该出现的开场白",
    },
    BASE_DRAFT,
  );
  assert.ok(proposing);
  assert.equal(proposing.opening, "");
});
