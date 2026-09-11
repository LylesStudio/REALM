import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackGenesisDraft,
  generateGenesisDraft,
  normalizeGenesisDraft,
} from "../modules/application/world-genesis.ts";
import type { ModelGateway } from "../modules/inference/public.ts";

const PROMPT = "一座漂在云海上的旧船港，船员用风声记账，雾起时会有不属于任何航线的船靠岸。";

test("normalizeGenesisDraft fills missing fields from the prompt and clamps companions", () => {
  const draft = normalizeGenesisDraft({
    world: { name: "  云港志  ", era: "风账纪元" },
    companions: [
      { name: "阿橹", role: "记账员", summary: "听得懂风声的人。" },
      { name: "老锚", role: "向导", summary: "" },
      { name: "多余者", role: "不应出现", summary: "" },
      { role: "无名者不得入场" },
    ],
    scene: { location: "七号泊台" },
  }, PROMPT);

  assert.ok(draft);
  assert.equal(draft.world.name, "云港志");
  assert.equal(draft.world.era, "风账纪元");
  assert.equal(draft.world.summary, PROMPT.replace(/\s+/g, " ").trim());
  assert.equal(draft.story.title, "序章");
  assert.equal(draft.record.title, "第一笔");
  assert.equal(draft.companions.length, 2);
  assert.equal(draft.companions[0]?.name, "阿橹");
  assert.equal(draft.companions[1]?.name, "老锚");
  assert.equal(draft.scene.location, "七号泊台");
  assert.equal(draft.scene.weather, "");
});

test("normalizeGenesisDraft rejects drafts without any resolvable world name", () => {
  assert.equal(normalizeGenesisDraft({}), null);
  assert.equal(normalizeGenesisDraft("not an object"), null);
  assert.equal(normalizeGenesisDraft({ world: { name: "  " } }), null);
  assert.ok(normalizeGenesisDraft({}, PROMPT)?.world.name);
});

test("fallbackGenesisDraft derives everything from the prompt and invents no cast", () => {
  const draft = fallbackGenesisDraft(PROMPT);
  assert.equal(draft.world.name, "一座漂在云海上的旧船港");
  assert.ok(draft.world.summary.includes("风声记账"));
  assert.equal(draft.companions.length, 0);
  assert.equal(draft.playerRole, "");
  assert.equal(draft.scene.location, "");
});

test("generateGenesisDraft parses model JSON and tolerates malformed output", async () => {
  const goodGateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat() {
      return {
        model: "test-model",
        content: JSON.stringify({
          world: { name: "云港志", era: "风账纪元 3 年", summary: "云海上的旧船港。" },
          story: { title: "雾中航船", premise: "一艘无籍船靠岸。" },
          record: { title: "靠岸" },
          playerRole: "替港口辨认风声的新账房",
          companions: [{ name: "阿橹", role: "记账员", summary: "听得懂风声。" }],
          scene: {
            location: "七号泊台",
            weather: "平流雾",
            tension: "港卫警惕",
            objective: "登记来船",
          },
        }),
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
  const draft = await generateGenesisDraft(goodGateway, PROMPT);
  assert.ok(draft);
  assert.equal(draft.world.name, "云港志");
  assert.equal(draft.playerRole, "替港口辨认风声的新账房");
  assert.equal(draft.companions[0]?.name, "阿橹");

  const badGateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat() {
      return {
        model: "test-model",
        content: "这不是 JSON",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
  assert.equal(await generateGenesisDraft(badGateway, PROMPT), null);

  const failingGateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat() {
      throw new Error("network down");
    },
  };
  await assert.rejects(generateGenesisDraft(failingGateway, PROMPT));
});
