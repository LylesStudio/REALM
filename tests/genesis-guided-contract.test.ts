import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyStepConfirm,
  stepSavedValue,
} from "../app/components/guided-genesis-steps.ts";
import type { WorldGenesisDraft } from "../modules/application/world-genesis.ts";
import { handleSuggestPost } from "../app/api/world/suggest/route.ts";
import type { ModelGateway } from "../modules/inference/public.ts";
import { uiMessageTable, uiText } from "../modules/i18n/public.ts";

/**
 * 创世 UX 批契约测试：
 * A. 分步回退状态机（填写→前进→回退→修改→前进→review 全保留）；
 * B. AI 代写 route（fake gateway 注入；正常链/失败链/安全提示/零泄漏）；
 * C. 界面文案现代化（key 三语完整、组件无古风残留、提问不随文风变化）。
 * 不创建真实世界、不碰数据库、不发真实模型请求、不读 .env.local。
 */

function emptyDraft(): WorldGenesisDraft {
  return {
    world: { name: "", era: "", summary: "" },
    style: "modern",
    story: { title: "", premise: "" },
    record: { title: "" },
    playerRole: "",
    companions: [],
    scene: { location: "", weather: "", tension: "", objective: "" },
    playerStance: "player",
    opening: "",
  };
}

test("A: 填写 A→前进→填写 B→回退→A 值还在→修改 A→前进→B 仍在→review 全部保留", () => {
  // 第 1 步：填写世界名称并提交。
  let draft = applyStepConfirm("world-name", emptyDraft(), {
    text: "雾港",
    storyTitle: "",
    storyPremise: "",
  });
  assert.equal(draft.world.name, "雾港");
  // 前进到时代背景并提交。
  draft = applyStepConfirm("era", draft, {
    text: "停战纪元 17 年",
    storyTitle: "",
    storyPremise: "",
  });
  // 回退到世界名称：已保存值重新填回输入。
  const restored = stepSavedValue("world-name", draft);
  assert.equal(restored.text, "雾港", "回退必须恢复已保存值");
  // 修改世界名称后再次前进：时代背景不得丢失。
  draft = applyStepConfirm("world-name", draft, {
    text: "雾港新编",
    storyTitle: "",
    storyPremise: "",
  });
  assert.equal(draft.world.name, "雾港新编");
  assert.equal(draft.world.era, "停战纪元 17 年", "修改 A 不得清空 B");
  // 继续填写概述/故事/角色，review 前所有内容完整。
  draft = applyStepConfirm("summary", draft, {
    text: "人魔停战后重建的港城。",
    storyTitle: "",
    storyPremise: "",
  });
  draft = applyStepConfirm("story", draft, {
    text: "",
    storyTitle: "无声钟的来客",
    storyPremise: "密函上岸。",
  });
  draft = applyStepConfirm("player-role", draft, {
    text: "人类使节",
    storyTitle: "",
    storyPremise: "",
  });
  assert.deepEqual(
    {
      name: draft.world.name,
      era: draft.world.era,
      summary: draft.world.summary,
      title: draft.story.title,
      premise: draft.story.premise,
      role: draft.playerRole,
    },
    {
      name: "雾港新编",
      era: "停战纪元 17 年",
      summary: "人魔停战后重建的港城。",
      title: "无声钟的来客",
      premise: "密函上岸。",
      role: "人类使节",
    },
  );
});

test("A: 空输入提交不清空已保存内容；回退后的再次前进只更新当前字段", () => {
  let draft = applyStepConfirm("world-name", emptyDraft(), {
    text: "雾港",
    storyTitle: "",
    storyPremise: "",
  });
  // 空提交（用户什么都没改直接下一步）不得抹掉名称。
  draft = applyStepConfirm("world-name", draft, {
    text: "   ",
    storyTitle: "",
    storyPremise: "",
  });
  assert.equal(draft.world.name, "雾港", "空输入不得覆盖已保存内容");
  // story 步骤：标题留空保留旧标题/默认，简介留空保留旧简介。
  draft = applyStepConfirm("story", draft, {
    text: "",
    storyTitle: "无声钟",
    storyPremise: "密函上岸。",
  });
  draft = applyStepConfirm("story", draft, {
    text: "",
    storyTitle: "",
    storyPremise: "",
  });
  assert.equal(draft.story.title, "无声钟");
  assert.equal(draft.story.premise, "密函上岸。");
  // story 回退恢复两个输入框。
  const restored = stepSavedValue("story", draft);
  assert.equal(restored.storyTitle, "无声钟");
  assert.equal(restored.storyPremise, "密函上岸。");
});

test("A: scene 点选只更新对应字段（状态机契约：不触发 advance 语义）", () => {
  // scene 字段更新是局部 patch（组件内 setDraft），其余字段保持。
  const draft = {
    ...emptyDraft(),
    scene: { location: "灰鲸港", weather: "", tension: "", objective: "" },
  };
  const patched = {
    ...draft,
    scene: { ...draft.scene, weather: "冷雾" },
  };
  assert.equal(patched.scene.location, "灰鲸港");
  assert.equal(patched.scene.weather, "冷雾");
  const source = readFileSync(
    fileURLToPath(new URL("../app/components/guided-genesis.tsx", import.meta.url)),
    "utf8",
  );
  const pickFn = source.slice(
    source.indexOf("function pickSceneSuggestion"),
    source.indexOf("async function sealWorld"),
  );
  assert.ok(!pickFn.includes("advance("), "scene 点选不得 advance 跳步");
  assert.match(pickFn, /setDraft\(\{ \.\.\.draft, scene: \{ \.\.\.draft\.scene, \[field\]: value \} \}\)/);
});

function fakeGateway(script: (string | Error)[]): ModelGateway {
  return {
    async discoverModels() {
      return [];
    },
    async chat() {
      const next = script.shift();
      if (next === undefined) throw new Error("unexpected call");
      if (next instanceof Error) throw next;
      return {
        model: "fake-model",
        content: next,
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

function suggestRequest(body: unknown): Request {
  return new Request("http://localhost/api/world/suggest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("B: 正常链返回候选；失败链返回 ok:false + 固定安全提示且零泄漏", async () => {
  // 正常链（fake gateway 返回合法 JSON 候选）。
  const ok = await handleSuggestPost(
    suggestRequest({ step: "world-name", intent: "雾港", context: {} }),
    {
      gateway: fakeGateway([
        JSON.stringify({ suggestions: ["雾港新城", "雾下港"] }),
      ]),
    },
  );
  assert.equal(ok.status, 200);
  const okBody = await ok.json() as { ok: boolean; suggestions?: unknown };
  assert.equal(okBody.ok, true);
  assert.ok(okBody.suggestions !== undefined);

  // 模型/网关错误（未配置、缺 key、provider 失败）→ 安全提示。
  const failing = await handleSuggestPost(
    suggestRequest({ step: "world-name", intent: "雾港", context: {} }),
    {
      gateway: fakeGateway([
        new Error("connect failed: http://secret-internal-host:8823/v1 key=sk-live-12345"),
      ]),
    },
  );
  assert.equal(failing.status, 200);
  const failBody = await failing.json() as {
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(failBody.ok, false);
  assert.equal(failBody.error.code, "NO_SUGGESTION");
  assert.equal(failBody.error.message, "AI 建议暂时不可用，请检查模型设置或稍后重试。");
  for (const forbidden of ["secret-internal-host", "sk-live-12345", "Bearer", "http://", "Authorization"]) {
    assert.ok(!failBody.error.message.includes(forbidden), `泄漏: ${forbidden}`);
  }

  // 结构化解析失败（非法 JSON 两轮）→ 同样安全提示。
  const malformed = await handleSuggestPost(
    suggestRequest({ step: "world-name", intent: "", context: {} }),
    { gateway: fakeGateway(["not json", "still not json"]) },
  );
  const malformedBody = await malformed.json() as {
    ok: boolean;
    error: { code: string; message: string };
  };
  assert.equal(malformedBody.ok, false);
  assert.equal(malformedBody.error.code, "NO_SUGGESTION");
  assert.ok(malformedBody.error.message.length > 0, "失败不得再返回空 message");

  // 非法 step → 400 INVALID_COMMAND。
  const invalid = await handleSuggestPost(suggestRequest({ step: "hack" }));
  assert.equal(invalid.status, 400);
});

test("B: realm-client suggestGenesis 区分 HTTP 错误/ok:false/malformed（源码契约）", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../app/realm-client.tsx", import.meta.url)),
    "utf8",
  );
  const fn = source.slice(
    source.indexOf("async function suggestGenesis"),
    source.indexOf("useEffect(() =>", source.indexOf("async function suggestGenesis")),
  );
  assert.match(fn, /!response\.ok \|\| !payload \|\| typeof payload !== "object"/);
  assert.match(fn, /body\.ok !== true/);
  assert.match(fn, /body\.suggestions === undefined \|\| body\.suggestions === null/);
  assert.match(fn, /errorMessage/);
  assert.doesNotMatch(fn, /apiKey|Authorization|connectionString/);
});

test("B: 组件显示 AI 失败提示条与重试入口（源码契约）", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../app/components/guided-genesis.tsx", import.meta.url)),
    "utf8",
  );
  assert.match(source, /suggestError/);
  assert.match(source, /guided-suggest-error/);
  assert.match(source, /ui\.guided\.suggestRetry/);
  assert.match(source, /result\.suggestions/);
});

test("C: 文案 key 三语完整；新 key 存在且现代", () => {
  const newKeys = [
    "ui.guided.back",
    "ui.guided.suggestFailed",
    "ui.guided.suggestRetry",
    "ui.guided.question.worldName",
    "ui.guided.question.era",
    "ui.guided.question.style",
    "ui.guided.question.summary",
    "ui.guided.question.story",
    "ui.guided.question.playerRole",
    "ui.guided.question.stance",
    "ui.guided.question.companions",
    "ui.guided.question.review",
  ];
  for (const key of newKeys) {
    const table = uiMessageTable(key);
    assert.ok(table, `missing key: ${key}`);
    for (const language of ["zh-CN", "en", "ja"] as const) {
      assert.ok(table[language]?.trim(), `${key} 缺 ${language}`);
    }
  }
  for (const archaic of ["司卷", "落笔", "留白", "合卷", "世界之名", "纸墨", "手稿"]) {
    for (const key of newKeys) {
      assert.ok(!uiText(key, "zh-CN").includes(archaic), `${key} 残留古风词: ${archaic}`);
    }
  }
  // 现代化替换后的关键文案。
  assert.equal(uiText("ui.guided.seal", "zh-CN"), "创建世界");
  assert.equal(uiText("ui.guided.skip", "zh-CN"), "跳过");
  assert.equal(uiText("ui.guided.scroll", "zh-CN"), "已填写内容");
  assert.equal(uiText("ui.genesisChat.scribe", "zh-CN"), "AI 助手");
  assert.equal(uiText("ui.library.chatEntry", "zh-CN"), "与 AI 助手对话");
  assert.equal(uiText("ui.library.sourceFallback", "zh-CN"), "AI 不可用 · 使用本地草稿");
});

test("C: 组件源码无古风残留；提问固定现代文案不随 draft.style 变化", () => {
  const guided = readFileSync(
    fileURLToPath(new URL("../app/components/guided-genesis.tsx", import.meta.url)),
    "utf8",
  );
  const questionKeys = {
    "world-name": "ui.guided.question.worldName",
    era: "ui.guided.question.era",
    style: "ui.guided.question.style",
    summary: "ui.guided.question.summary",
    story: "ui.guided.question.story",
    "player-role": "ui.guided.question.playerRole",
    stance: "ui.guided.question.stance",
    companions: "ui.guided.question.companions",
    scene: "ui.guided.question.scene",
    review: "ui.guided.question.review",
  } as const;
  for (const [step, key] of Object.entries(questionKeys)) {
    const sourceKey = step.includes("-") ? `"${step}"` : step;
    assert.ok(guided.includes(`${sourceKey}: "${key}"`), `${step} question key mapping missing`);
    assert.notEqual(uiText(key, "zh-CN"), key, `${key} must resolve to a registered message`);
  }
  assert.doesNotMatch(guided, /guided\.step\.\$\{step\.id\}\.question/, "提问不得再调用 style 模板");
  for (const archaic of ["司卷", "落笔", "落墨", "合卷", "世界之名", "纪元基调", "世界底色", "同行之人", "初始场景", "已定之卷", "纸墨手稿"]) {
    assert.ok(!guided.includes(archaic), `guided-genesis 残留: ${archaic}`);
  }
  const chat = readFileSync(
    fileURLToPath(new URL("../app/components/guided-genesis-chat.tsx", import.meta.url)),
    "utf8",
  );
  assert.ok(!/司卷/.test(chat), "guided-genesis-chat 残留司卷");
  // stepSavedValue/applyStepConfirm 已迁入独立纯模块。
  assert.doesNotMatch(guided, /export function stepSavedValue|export function applyStepConfirm/);
});

test("C: i18n 注册表创世 key 无古风残留（保留 classical 世界文风选项）", () => {
  const checked = [
    "ui.guided.eyebrow",
    "ui.guided.suggest",
    "ui.guided.suggesting",
    "ui.guided.skip",
    "ui.guided.confirm",
    "ui.guided.scroll",
    "ui.guided.seal",
    "ui.guided.sealing",
    "ui.guided.companionNote",
    "ui.guided.companionsSolo",
    "ui.guided.sceneNote",
    "ui.onboarding.title",
    "ui.onboarding.chatEntry",
    "ui.genesisChat.title",
    "ui.genesisChat.sending",
    "ui.genesisChat.confirm",
    "ui.library.guidedEntry",
    "ui.library.chatEntry",
    "ui.library.chatHint",
    "ui.library.sourceModel",
    "ui.library.sourceFallback",
  ];
  for (const key of checked) {
    const zh = uiText(key, "zh-CN");
    assert.ok(!/司卷|落笔|留白|合卷|铸界|纸墨|手稿/.test(zh), `${key} 残留古风: ${zh}`);
  }
  // 世界文风选项本身保留（classical 是用户可选的游戏风格，不是界面文案）。
  const styleSource = readFileSync(
    fileURLToPath(new URL("../modules/style/world-style.ts", import.meta.url)),
    "utf8",
  );
  assert.match(styleSource, /classical/, "classical 世界文风选项必须保留");
});
