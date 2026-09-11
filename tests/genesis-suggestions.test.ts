import assert from "node:assert/strict";
import test from "node:test";
import {
  generateGenesisSuggestions,
  isGuidedGenesisStep,
  normalizeGenesisSuggestions,
} from "../modules/application/genesis-suggestions.ts";
import type { ModelGateway } from "../modules/inference/public.ts";

function fakeGateway(content: string | (() => string)): ModelGateway {
  return {
    async discoverModels() {
      return [];
    },
    async chat() {
      return {
        model: "fake-model",
        content: typeof content === "function" ? content() : content,
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

test("guided genesis steps are exactly the suggestable seven", () => {
  assert.ok(isGuidedGenesisStep("world-name"));
  assert.ok(isGuidedGenesisStep("scene"));
  assert.ok(!isGuidedGenesisStep("review"));
  assert.ok(!isGuidedGenesisStep("drop-table"));
  assert.ok(!isGuidedGenesisStep(42));
});

test("normalizeGenesisSuggestions covers text, story, companions and scene steps", () => {
  // 文本步：限长截断、空串剔除、至多 3 条。
  const names = normalizeGenesisSuggestions("world-name", {
    suggestions: [" 云港志 ", "", "x".repeat(80), "雾桑", "多余者"],
  });
  assert.deepEqual(names, ["云港志", "x".repeat(40), "雾桑"]);

  // 故事步：标题+缘起合成展示串，无标题剔除。
  const stories = normalizeGenesisSuggestions("story", {
    suggestions: [
      { title: "雾中航船", premise: "无籍船靠岸。" },
      { premise: "没有标题不可用" },
      "不是对象",
    ],
  });
  assert.deepEqual(stories, ["雾中航船——无籍船靠岸。"]);

  // 同行之人：无名剔除，至多 2 人。
  const companions = normalizeGenesisSuggestions("companions", {
    suggestions: [
      { name: "阿橹", role: "记账员", summary: "听得懂风声。" },
      { role: "无名者" },
      { name: "老锚", role: "向导", summary: "" },
      { name: "第三人", role: "", summary: "" },
    ],
  });
  assert.deepEqual(companions, [
    { name: "阿橹", role: "记账员", summary: "听得懂风声。" },
    { name: "老锚", role: "向导", summary: "" },
  ]);

  // 场景步：四字段候选，各至多 2 条；全空 fail-closed。
  const scene = normalizeGenesisSuggestions("scene", {
    suggestions: [{
      location: ["七号泊台", "望楼", "多余"],
      weather: ["平流雾"],
      tension: [],
      objective: ["登记来船"],
    }],
  });
  assert.deepEqual(scene, {
    location: ["七号泊台", "望楼"],
    weather: ["平流雾"],
    tension: [],
    objective: ["登记来船"],
  });
  assert.equal(
    normalizeGenesisSuggestions("scene", {
      suggestions: [{ location: [], weather: [], tension: [], objective: [] }],
    }),
    null,
  );
});

test("normalizeGenesisSuggestions fails closed on malformed payloads", () => {
  assert.equal(normalizeGenesisSuggestions("era", null), null);
  assert.equal(normalizeGenesisSuggestions("era", "text"), null);
  assert.equal(normalizeGenesisSuggestions("era", {}), null);
  assert.equal(normalizeGenesisSuggestions("era", { suggestions: "no" }), null);
  assert.equal(normalizeGenesisSuggestions("era", { suggestions: [] }), null);
  assert.equal(normalizeGenesisSuggestions("era", { suggestions: [" ", 1] }), null);
  assert.equal(normalizeGenesisSuggestions("companions", { suggestions: [] }), null);
  assert.equal(normalizeGenesisSuggestions("scene", { suggestions: [] }), null);
});

test("generateGenesisSuggestions returns null on every failure branch", async () => {
  const context = { world: { name: "云港志", era: "", summary: "" } };

  // 正常路径
  const ok = await generateGenesisSuggestions(
    fakeGateway(JSON.stringify({ suggestions: ["雾桑", "汐泊"] })),
    { step: "world-name", intent: "云上的港口", context },
  );
  assert.deepEqual(ok, ["雾桑", "汐泊"]);

  // 非法 JSON
  assert.equal(
    await generateGenesisSuggestions(
      fakeGateway("not json"),
      { step: "era", intent: "", context },
    ),
    null,
  );

  // schema 不符
  assert.equal(
    await generateGenesisSuggestions(
      fakeGateway(JSON.stringify({ wrong: true })),
      { step: "era", intent: "", context },
    ),
    null,
  );

  // 模型错误
  const failing: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat() {
      throw new Error("MODEL_TIMEOUT");
    },
  };
  assert.equal(
    await generateGenesisSuggestions(failing, { step: "era", intent: "", context }),
    null,
  );
});
