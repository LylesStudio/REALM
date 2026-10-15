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
import { POST as postGenesisChat } from "../app/api/world/genesis-chat/route.ts";

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
  // 批次 A3：可选文本的显式空串 = 清除（保留在 patch 中），不再静默丢弃。
  assert.equal(patch.world?.summary, "");
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

test("mergeDraftPatch replaces companions as a full snapshot", () => {
  const replaced = mergeDraftPatch(BASE_DRAFT, {
    companions: [{ name: "老锚", role: "向导", summary: "认得旧航线。" }],
  });
  assert.deepEqual(replaced?.companions.map((item) => item.name), ["老锚"]);

  const both = mergeDraftPatch(BASE_DRAFT, {
    companions: [
      { name: "烛芯", role: "灯芯匠", summary: "记得每一盏灯的脾气。" },
      { name: "老锚", role: "向导", summary: "认得旧航线。" },
    ],
  });
  assert.ok(both);
  assert.deepEqual(both.companions.map((item) => item.name), ["烛芯", "老锚"]);

  const edited = mergeDraftPatch(both, {
    companions: [
      { name: "烛芯", role: "守灯人", summary: "记得每一盏灯的脾气。" },
      { name: "老锚", role: "向导", summary: "认得旧航线。" },
    ],
  });
  assert.equal(edited?.companions[0]?.role, "守灯人");
  assert.equal(edited?.companions[1]?.name, "老锚");

  const removed = mergeDraftPatch(both, {
    companions: [{ name: "老锚", role: "向导", summary: "认得旧航线。" }],
  });
  assert.deepEqual(removed?.companions.map((item) => item.name), ["老锚"]);

  const cleared = mergeDraftPatch(BASE_DRAFT, { companions: [] });
  assert.equal(cleared?.companions.length, 0);

  const unchanged = mergeDraftPatch(BASE_DRAFT, { world: { era: "新纪元" } });
  assert.equal(unchanged?.companions[0]?.name, "烛芯");
});

test("mergeDraftPatch keeps scene title and display time across field merges", () => {
  const titled = mergeDraftPatch(BASE_DRAFT, {
    scene: { title: "雾夜", displayTime: "入夜" },
  });
  assert.ok(titled);
  assert.equal(titled.scene.title, "雾夜");
  assert.equal(titled.scene.displayTime, "入夜");
  assert.equal(titled.scene.location, "主灯塔");
  const patched = mergeDraftPatch(titled, { scene: { weather: "大雾" } });
  assert.equal(patched?.scene.title, "雾夜");
  assert.equal(patched?.scene.displayTime, "入夜");
  assert.equal(patched?.scene.weather, "大雾");
  assert.equal(patched?.scene.location, "主灯塔");
});

test("mergeDraftPatch keeps partial drafts across turns before a world name settles", () => {
  // 批次 A2：无 base、patch 不含世界名 → 保留 partial（世界名空串），
  // 跨轮累积；完整性（非空世界名）由创建入口校验，不在这里制造伪名字。
  const partial = mergeDraftPatch(null, { scene: { location: "某地" } });
  assert.ok(partial);
  assert.equal(partial.world.name, "");
  assert.equal(partial.scene.location, "某地");
  const accumulated = mergeDraftPatch(partial, { world: { era: "灯盏纪元" } });
  assert.equal(accumulated?.world.name, "");
  assert.equal(accumulated?.world.era, "灯盏纪元");
  assert.equal(accumulated?.scene.location, "某地");
  const named = mergeDraftPatch(accumulated, { world: { name: "雾都" } });
  assert.equal(named?.world.name, "雾都");
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

test("normalizeGenesisChatResponse keeps exploratory partial patches and never pretends a missing proposal succeeded", () => {
  // 批次 A2：探索阶段的合法 partial patch 保留（世界名未定也可累积）。
  const kept = normalizeGenesisChatResponse(
    {
      reply: "先从港口聊起。",
      phase: "exploring",
      draftPatch: { scene: { location: "港口" } },
    },
    null,
  );
  assert.ok(kept);
  assert.equal(kept.reply, "先从港口聊起。");
  assert.equal(kept.phase, "exploring");
  assert.equal(kept.draftPatch?.scene?.location, "港口");

  // 携带无法识别的 patch 必须 repair；exploring 也不能静默丢弃字段。
  const garbage = normalizeGenesisChatResponse(
    { reply: "再聊聊。", phase: "exploring", draftPatch: { foo: 1 } },
    null,
  );
  assert.equal(garbage, null);

  // base 已有世界名时，仅改场景的 patch 合法 → 采纳。
  const amended = normalizeGenesisChatResponse(
    {
      reply: "场景已改。",
      phase: "proposing",
      draftPatch: { scene: { location: "港口" } },
    },
    BASE_DRAFT,
  );
  assert.ok(amended);
  assert.equal(amended.draftPatch?.scene?.location, "港口");

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

test("a flat world proposal is repaired instead of silently reduced to a reply", async () => {
  const flat = {
    reply: "世界已在齿轮转动中成型。",
    phase: "proposing",
    draftPatch: {
      name: "齿轮余烬", era: "蒸汽纪元", essence: "机械秩序的真相与反抗",
      style: "western_fantasy", opening_story: "走私犯在飞艇上发现纸带秘密。",
      player_role: "走私犯", companions: [{ name: "机械师", role: "工程师", summary: "修理飞艇。" }],
      scene: { location: "飞艇" },
    },
  };
  const repaired = {
    reply: "提案整理好了。", phase: "proposing",
    draftPatch: {
      world: { name: "齿轮余烬", era: "蒸汽纪元", summary: "机械秩序的真相与反抗" },
      story: { title: "纸带密令", premise: "走私犯在飞艇上发现纸带秘密。" },
      record: { title: "飞艇上的交易" }, playerRole: "走私犯",
      companions: flat.draftPatch.companions, scene: flat.draftPatch.scene,
    },
  };
  const { gateway, calls } = fakeGateway([{ content: JSON.stringify(flat) }, { content: JSON.stringify(repaired) }]);
  const result = await generateGenesisChatReply(gateway, {
    message: "帮我编一个完整故事", transcript: [], draft: null, language: "zh-CN",
  });
  assert.equal(calls.length, 2, "an unusable proposing patch must trigger the bounded schema repair");
  assert.equal(result?.draftPatch?.world?.name, "齿轮余烬");
  assert.equal(result?.draftPatch?.story?.premise, repaired.draftPatch.story.premise);
  assert.equal(result?.draftPatch?.playerRole, "走私犯");
  assert.match(calls[1]?.messages.at(-1)?.content ?? "", /Failure category: schema/);
});

test("scribe proposal and repair both specify the nested draft field contract", async () => {
  const { gateway, calls } = fakeGateway([
    { content: JSON.stringify({ reply: "提案来了。", phase: "proposing", draftPatch: { name: "云城" } }) },
    { content: JSON.stringify({ reply: "提案整理好了。", phase: "proposing", draftPatch: BASE_DRAFT }) },
  ]);
  assert.ok(await generateGenesisChatReply(gateway, {
    message: "做一份完整提案", transcript: [], draft: null, language: "zh-CN",
  }));
  assert.equal(calls.length, 2);
  for (const schema of [calls[0]?.messages[0]?.content ?? "", calls[1]?.messages.at(-1)?.content ?? ""]) {
    assert.match(schema, /"world"\?:\s*\{"name":/);
    assert.match(schema, /"story"\?:\s*\{"title"\?:/);
    assert.match(schema, /"record"\?:\s*\{"title"\?:/);
    assert.match(schema, /"playerRole"\?:/);
    assert.match(schema, /"summary"\?:.*300 chars/);
    assert.match(schema, /"draftPatch": object or null/);
    assert.match(schema, /Do not flatten/);
  }
});

test("proposal updates cannot silently discard unrecognized fields against an existing draft", () => {
  for (const draftPatch of [
    { name: "被丢弃的新世界名", style: "western_fantasy" },
    { world: { name: "新世界名", essence: "被丢弃的新世界概述" } },
    { player_role: "被丢弃的新身份", scene: { location: "飞艇" } },
  ]) {
    assert.equal(normalizeGenesisChatResponse({ reply: "提案已更新。", phase: "proposing", draftPatch }, BASE_DRAFT), null);
  }
});

test("illegal enum values and empty required names are rejected, never defaulted over the draft", () => {
  // 批次 A3：非法 style/language/stance 不收键 → proposing/ready 走 repair（null），
  // 绝不静默归一为 modern/player 覆盖既有草稿。
  for (const draftPatch of [
    { style: "cyberpunk" },
    { language: "fr" },
    { playerStance: "spectator" },
    { world: { name: "" } },
    { playerRole: 42 },
  ]) {
    assert.equal(
      normalizeGenesisChatResponse({ reply: "非法值。", phase: "proposing", draftPatch }, BASE_DRAFT),
      null,
    );
  }
  // exploring 阶段同字段不收键但不炸毁整轮（partial 语义）。
  const exploring = normalizeGenesisChatResponse(
    { reply: "继续聊。", phase: "exploring", draftPatch: { style: "cyberpunk", world: { era: "新纪元" } } },
    BASE_DRAFT,
  );
  assert.equal(exploring, null, "invalid enums trigger repair in exploring too");
  // 显式 null = 不改（不计入丢弃，不触发 repair）。
  const nullNoop = normalizeGenesisChatResponse(
    { reply: "空操作。", phase: "proposing", draftPatch: { style: null, world: { era: "灯盏纪元" } } },
    BASE_DRAFT,
  );
  assert.ok(nullNoop);
  assert.equal(nullNoop.draftPatch?.world?.era, "灯盏纪元");
});

test("explicit empty strings clear optional text fields through the merge", () => {
  // 批次 A3：era/summary/premise/playerRole/opening/scene 字段可显式清空。
  const cleared = mergeDraftPatch(BASE_DRAFT, {
    world: { era: "", summary: "" },
    story: { premise: "" },
    playerRole: "",
    opening: "",
    scene: { location: "", title: "", displayTime: "" },
  });
  assert.ok(cleared);
  assert.equal(cleared.world.era, "");
  assert.equal(cleared.world.summary, "");
  assert.equal(cleared.story.premise, "");
  assert.equal(cleared.playerRole, "");
  assert.equal(cleared.opening, "");
  assert.equal(cleared.scene.location, "");
  assert.equal(cleared.scene.title, undefined);
  assert.equal(cleared.scene.displayTime, undefined);
  // 未出现在 patch 中的字段保持原值。
  assert.equal(cleared.story.title, "熄灯之夜");
  assert.equal(cleared.world.name, "雾都");
  // story.title / record.title / world.name 显式空串非法（不收键）。
  const rejected = normalizeGenesisChatResponse(
    { reply: "标题不能为空。", phase: "proposing", draftPatch: { story: { title: "" } } },
    BASE_DRAFT,
  );
  assert.equal(rejected, null);
});

test("proposing and ready require a usable draft rather than a bare success sentence", () => {
  for (const phase of ["proposing", "ready"] as const) {
    for (const draftPatch of [null, { scene: { location: "飞艇" } }]) {
      assert.equal(normalizeGenesisChatResponse({ reply: "世界已成型。", phase, draftPatch }, null), null);
    }
    assert.ok(normalizeGenesisChatResponse({ reply: "保留这份提案。", phase, draftPatch: null }, BASE_DRAFT));
  }
});

test("generateGenesisChatReply rejects an oversized draft before calling the model", async () => {
  let calls = 0;
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat() {
      calls += 1;
      throw new Error("model must not run");
    },
  };
  const outcome = await generateGenesisChatReply(gateway, {
    message: "一座雾港",
    transcript: [],
    draft: { world: { name: "雾港", era: "", summary: "x".repeat(9_000) } },
  });
  assert.equal(outcome, null);
  assert.equal(calls, 0);
});

test("automatic genesis opening uses the interface language without inventing player input", async () => {
  for (const language of ["zh-CN", "en", "ja"] as const) {
    const { gateway, calls } = fakeGateway([{
      content: JSON.stringify({ reply: "fixture reply", phase: "exploring", draftPatch: null }),
    }]);
    const outcome = await generateGenesisChatReply(gateway, {
      message: "",
      transcript: [],
      draft: null,
      language,
    });
    assert.ok(outcome);
    const system = calls[0]?.messages[0]?.content ?? "";
    assert.ok(system.includes(`interface language (${language})`));
    assert.match(system, /first sentence/);
    assert.doesNotMatch(system, /Write in the language of the latest player input/);
    const user = calls[0]?.messages.at(-1)?.content ?? "";
    assert.match(user, /\[Automatic opening request\]/);
    assert.doesNotMatch(user, /\[Player this turn\]/);
    assert.ok(user.includes(`interface language (${language})`));
  }
});

test("automatic opening ignores previous Scribe language and uses the UI language default", async () => {
  for (const [language, expected] of [[undefined, "zh-CN"], ["unsupported", "zh-CN"], ["ja", "ja"]] as const) {
    const { gateway, calls } = fakeGateway([{
      content: JSON.stringify({ reply: "fixture reply", phase: "exploring", draftPatch: null }),
    }]);
    await generateGenesisChatReply(gateway, {
      message: "   ",
      transcript: [{ role: "scribe", content: "What kind of world would you like?" }],
      draft: { ...BASE_DRAFT, language: "en" },
      language,
    });
    assert.ok(calls[0]?.messages[0]?.content.includes(`interface language (${expected})`));
    assert.match(calls[0]?.messages[0]?.content ?? "", /previous Scribe replies are not player input/);
    assert.equal(calls[0]?.messages[1]?.role, "user", "retain the provider's user-first history shape");
    assert.match(calls[0]?.messages[1]?.content ?? "", /\[Automatic opening request\]/);
  }
});

test("real player input keeps its language precedence after the automatic opening", async () => {
  const playerText = "A floating city above a dry ocean.";
  for (const message of [playerText, ""] as const) {
    const { gateway, calls } = fakeGateway([{
      content: JSON.stringify({ reply: "fixture reply", phase: "exploring", draftPatch: null }),
    }]);
    await generateGenesisChatReply(gateway, {
      message,
      transcript: message ? [{ role: "scribe", content: "你想创造什么世界？" }] : [
        { role: "user", content: playerText },
        { role: "scribe", content: "What keeps it afloat?" },
      ],
      draft: null,
      language: "zh-CN",
    });
    const system = calls[0]?.messages[0]?.content ?? "";
    assert.match(system, /Write in the language of the latest player input/);
    assert.doesNotMatch(system, /This is an automatic opening with no player input/);
    const user = calls[0]?.messages.at(-1)?.content ?? "";
    if (message) assert.ok(user.includes(`[Player this turn]\n${playerText}`));
    else {
      assert.match(user, /\[Automatic continuation request\]/);
      assert.doesNotMatch(user, /\[Player this turn\]/);
      assert.match(user, /latest player-authored message/);
    }
  }
});

test("structured repair preserves the automatic opening language constraint", async () => {
  const { gateway, calls } = fakeGateway([
    { content: "not-json" },
    { content: JSON.stringify({ reply: "fixture reply", phase: "exploring", draftPatch: null }) },
  ]);
  const outcome = await generateGenesisChatReply(gateway, {
    message: "", transcript: [], draft: null, language: "ja",
  });
  assert.ok(outcome);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(call.messages[0]?.content.includes("interface language (ja)"));
    assert.match(call.messages[1]?.content ?? "", /\[Automatic opening request\]/);
  }
});

test("scribe prompt requires a full companion snapshot and shows settled roles", async () => {
  const { gateway, calls } = fakeGateway([
    {
      content: JSON.stringify({
        reply: "再加一位？",
        phase: "exploring",
        draftPatch: null,
      }),
    },
  ]);
  const outcome = await generateGenesisChatReply(gateway, {
    message: "再加一位向导",
    transcript: [],
    draft: BASE_DRAFT,
  });
  assert.ok(outcome);
  const system = calls[0]?.messages[0]?.content ?? "";
  assert.match(system, /replaces the entire companion list/);
  const user = calls[0]?.messages.at(-1)?.content ?? "";
  assert.match(user, /烛芯/);
  assert.match(user, /灯芯匠/);
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

test("normalizeGenesisChatResponse folds top-level opening into the canonical draftPatch at any phase", () => {
  // 批次 A1：opening 的 canonical 位置是 draftPatch.opening；顶层 opening
  // 是兼容输入（patch 缺席时并入），任何阶段的合法正文都不被悄悄清除。
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
  assert.equal(ready.draftPatch?.opening?.length, 300);

  const proposing = normalizeGenesisChatResponse(
    {
      reply: "先看看提案。",
      phase: "proposing",
      draftPatch: { world: { name: "港城" } },
      opening: "提前写下的开场白",
    },
    BASE_DRAFT,
  );
  assert.ok(proposing);
  // 非 ready 不再清空：开场正文随 draftPatch 保留。
  assert.equal(proposing.draftPatch?.opening, "提前写下的开场白");
  assert.equal(proposing.opening, "提前写下的开场白");

  // 两处冲突：draftPatch.opening 为准；顶层省略/空串 = 不改（不清空）。
  const conflict = normalizeGenesisChatResponse(
    {
      reply: "以 patch 为准。",
      phase: "ready",
      draftPatch: { opening: "canonical 版" },
      opening: "顶层旧版",
    },
    BASE_DRAFT,
  );
  assert.equal(conflict?.draftPatch?.opening, "canonical 版");

  const untouched = normalizeGenesisChatResponse(
    { reply: "没动开场。", phase: "ready", draftPatch: null },
    BASE_DRAFT,
  );
  assert.equal(untouched?.opening, "");
  assert.equal(untouched?.draftPatch, null);

  // 显式空串经 draftPatch.opening 清除既有开场。
  const cleared = mergeDraftPatch({ ...BASE_DRAFT, opening: "旧开场" }, { opening: "" });
  assert.equal(cleared?.opening, "");
});

test("genesis chat route rejects an oversized draft before the model", async () => {
  const response = await postGenesisChat(new Request("http://localhost/api/world/genesis-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: "一座雾港",
      draft: { world: { name: "雾港", summary: "x".repeat(9_000) } },
    }),
  }));
  assert.equal(response.status, 400);
  const body = await response.json() as { ok: boolean; error: { code: string; message: string } };
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "INVALID_COMMAND");
  assert.equal(body.error.message.includes("xxxxx"), false);
});
