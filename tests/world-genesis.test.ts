import assert from "node:assert/strict";
import test from "node:test";
import {
  fallbackGenesisDraft,
  generateGenesisDraft,
  genesisDraftFingerprint,
  genesisPromptInputWithinBudget,
  normalizeGenesisDraft,
  sanitizeUntrustedGenesisDraft,
  settledGenesisView,
} from "../modules/application/world-genesis.ts";
import {
  defaultGenesisRecordTitle,
  defaultGenesisStoryTitle,
} from "../modules/application/world-genesis-contract.ts";
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
  // 批次 B12：默认标题三语同源（zh-CN 默认值为「第一章」）。
  assert.equal(draft.record.title, "第一章");
  assert.equal(draft.companions.length, 2);
  assert.equal(draft.companions[0]?.name, "阿橹");
  assert.equal(draft.companions[1]?.name, "老锚");
  assert.equal(draft.scene.location, "七号泊台");
  assert.equal(draft.scene.weather, "");
});

test("normalizeGenesisDraft keeps scene title and display time", () => {
  const draft = normalizeGenesisDraft({
    world: { name: "雾港" },
    scene: {
      title: " 夜航 ",
      location: "七号码头",
      displayTime: "雾月入夜",
      weather: "雾",
    },
  });
  assert.ok(draft);
  assert.equal(draft.scene.title, "夜航");
  assert.equal(draft.scene.displayTime, "雾月入夜");
  assert.equal(draft.scene.location, "七号码头");
  assert.equal(draft.scene.weather, "雾");
  const omitted = normalizeGenesisDraft({
    world: { name: "雾港" },
    scene: { location: "港" },
  });
  assert.equal(omitted?.scene.title, undefined);
  assert.equal(omitted?.scene.displayTime, undefined);
});

test("sanitizeUntrustedGenesisDraft drops privileged fields and bad shapes", () => {
  const clean = sanitizeUntrustedGenesisDraft({
    worldIdentity: { worldId: "w", worldVersion: "1" },
    runtimeIdentity: { worldlineId: "a", storyId: "b", recordId: "c" },
    goals: [{ goalKey: "secret-goal", policyVersion: "1" }],
    world: { name: "雾港" },
    companions: "nope",
    scene: "nope",
  });
  assert.equal(clean.world?.name, "雾港");
  assert.equal(clean.companions, undefined);
  assert.equal(clean.scene, undefined);
  assert.equal("worldIdentity" in clean, false);
  assert.equal("runtimeIdentity" in clean, false);
  assert.equal("goals" in clean, false);
  const view = settledGenesisView({
    world: { name: "雾港" },
    companions: [
      { name: "阿汐", role: "向导", summary: "识路" },
      { name: "老锚", role: "船工", summary: "掌舵" },
    ],
    scene: { title: "夜航", location: "港", displayTime: "入夜" },
    goals: [{ goalKey: "secret-goal" }],
  });
  // 批次 A5：settled 视图与 draftPatch schema 同构嵌套，不再用扁平别名。
  assert.deepEqual(view?.world, { name: "雾港", era: "", summary: "" });
  assert.deepEqual(view?.scene, { title: "夜航", location: "港", weather: "", tension: "", displayTime: "入夜", objective: "" });
  const companions = view?.companions as { name: string; role: string }[];
  assert.deepEqual(companions.map((item) => item.name), ["阿汐", "老锚"]);
  assert.equal(JSON.stringify(view).includes("secret-goal"), false);
  assert.equal(settledGenesisView({ companions: "nope", scene: 12 }), null);
  assert.equal(genesisPromptInputWithinBudget({ world: { name: "雾港" } }), true);
  assert.equal(
    genesisPromptInputWithinBudget({ world: { summary: "x".repeat(9_000) } }),
    false,
  );
});

test("normalizeGenesisDraft rejects drafts without any resolvable world name", () => {
  assert.equal(normalizeGenesisDraft({}), null);
  assert.equal(normalizeGenesisDraft("not an object"), null);
  assert.equal(normalizeGenesisDraft({ world: { name: "  " } }), null);
  assert.ok(normalizeGenesisDraft({}, PROMPT)?.world.name);
});

test("default story/record titles follow the draft language across all three locales", () => {
  // 批次 B12：默认标题不写死中文；故事/记录默认值与分步 skip 路径同源。
  for (const [language, storyTitle, recordTitle] of [
    ["zh-CN", "序章", "第一章"],
    ["en", "Prologue", "Chapter One"],
    ["ja", "プロローグ", "第一章"],
  ] as const) {
    const draft = normalizeGenesisDraft({ world: { name: "雾港" }, language });
    assert.equal(draft?.story.title, storyTitle);
    assert.equal(draft?.record.title, recordTitle);
    assert.equal(defaultGenesisStoryTitle(language), storyTitle);
    assert.equal(defaultGenesisRecordTitle(language), recordTitle);
  }
  // allowUnnamed：partial 草稿保留字段、不造伪名（批次 A2）。
  const partial = normalizeGenesisDraft({ scene: { location: "港" } }, "", { allowUnnamed: true });
  assert.equal(partial?.world.name, "");
  assert.equal(partial?.scene.location, "港");
  assert.equal(normalizeGenesisDraft({ scene: { location: "港" } }), null);
});

test("genesisDraftFingerprint is stable for the same draft and changes with content", () => {
  const draft = normalizeGenesisDraft({
    world: { name: "雾港" },
    companions: [{ name: "阿汐", role: "向导", summary: "识路" }],
    scene: { title: "夜航", location: "港", displayTime: "入夜" },
  }, PROMPT);
  assert.ok(draft);
  assert.equal(genesisDraftFingerprint(draft), genesisDraftFingerprint({
    ...draft,
    scene: { ...draft.scene, title: draft.scene.title },
  }));
  const renamed = normalizeGenesisDraft({
    world: { name: "另一港" },
    companions: [{ name: "阿汐", role: "向导", summary: "识路" }],
  }, PROMPT);
  assert.notEqual(genesisDraftFingerprint(draft), genesisDraftFingerprint(renamed!));
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

  // 批次 A6：空对象/无世界名的模型结果不得被 prompt 补缺后冒充 model 成功。
  const emptyGateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat() {
      return {
        model: "test-model",
        content: "{}",
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
  assert.equal(await generateGenesisDraft(emptyGateway, PROMPT), null);

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
