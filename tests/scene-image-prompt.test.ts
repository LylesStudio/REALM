/**
 * T2I 场景 prompt composer 单元测试（唯一 sentinel，非 demo 数据）。
 * 钉住：分层顺序、空字段省略、长度/控制字符 fail-closed、negative 稳定、
 * 生产路径无示例海边小镇句。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  composeScenePrompt,
  IMAGE_VISUAL_PROFILES,
  SCENE_IMAGE_BASE_PREFIX,
  SCENE_IMAGE_ENVIRONMENT_ONLY_RULES,
  SCENE_IMAGE_NEGATIVE_PROMPT,
  SCENE_PROMPT_MAX_CHARS,
  type ScenePromptScope,
} from "../modules/imagine/public.ts";

function sentinelScope(overrides: Partial<ScenePromptScope["brief"]> = {}): ScenePromptScope {
  return {
    style: "modern",
    brief: {
      worldName: "WORLDNAME_SENTINEL_XQ",
      era: "ERA_SENTINEL_ZR",
      summary: "WORLDSUMMARY_SENTINEL_PM",
      storyTitle: "STORYTITLE_SENTINEL_KV",
      premise: "PREMISE_SENTINEL_GB",
      location: "LOCATION_SENTINEL_TD",
      weather: "WEATHER_SENTINEL_HY",
      tension: "TENSION_SENTINEL_WU",
      objective: "OBJECTIVE_SENTINEL_FJ",
      canon: "- CANON_SENTINEL_AQ：canon fact",
      worldLore: "- 《LORE_SENTINEL_EK》：lore excerpt",
      ...overrides,
    },
    displayTime: "DISPLAYTIME_SENTINEL_NC",
    recentPublicEvents: [
      "EVENT_SENTINEL_OLD",
      "EVENT_SENTINEL_MID",
      "EVENT_SENTINEL_NEW",
    ],
  };
}

test("composer: 场景-only sentinel 进入 positive，人物叙事全部排除", () => {
  const { positivePrompt, negativePrompt, includedBlocks } = composeScenePrompt(sentinelScope());
  assert.ok(positivePrompt.startsWith(SCENE_IMAGE_BASE_PREFIX));
  assert.ok(positivePrompt.includes(SCENE_IMAGE_ENVIRONMENT_ONLY_RULES));
  for (const sentinel of [
    "WORLDNAME_SENTINEL_XQ", "ERA_SENTINEL_ZR",
    "LOCATION_SENTINEL_TD", "WEATHER_SENTINEL_HY", "DISPLAYTIME_SENTINEL_NC",
    "TENSION_SENTINEL_WU", "OBJECTIVE_SENTINEL_FJ",
  ]) {
    assert.ok(positivePrompt.includes(sentinel), `positive 缺 ${sentinel}`);
  }
  for (const excluded of [
    "WORLDSUMMARY_SENTINEL_PM", "STORYTITLE_SENTINEL_KV", "PREMISE_SENTINEL_GB",
    "CANON_SENTINEL_AQ", "LORE_SENTINEL_EK",
    "EVENT_SENTINEL_OLD", "EVENT_SENTINEL_MID", "EVENT_SENTINEL_NEW",
  ]) {
    assert.ok(!positivePrompt.includes(excluded), `场景-only prompt 不得包含 ${excluded}`);
  }
  assert.deepEqual([...includedBlocks], ["profile", "world", "scene"]);
  const position = (needle: string) => positivePrompt.indexOf(needle);
  assert.ok(position("visual style:") > 0 && position("visual style:") < position("WORLDNAME_SENTINEL_XQ"));
  assert.ok(position("WORLDNAME_SENTINEL_XQ") < position("LOCATION_SENTINEL_TD"));
  assert.ok(negativePrompt.startsWith(SCENE_IMAGE_NEGATIVE_PROMPT));
  assert.ok(negativePrompt.includes("people") && negativePrompt.includes("humanoid"));
  assert.ok(negativePrompt.includes("photorealistic"), "modern profile 漂移负面必须进入 negative");
  assert.ok(!positivePrompt.includes("quiet coastal village"));
});

test("composer: 空字段 fail-closed 省略，不输出空标签", () => {
  const scope = sentinelScope({
    era: "", summary: "", storyTitle: "", premise: "",
    weather: "", tension: "", objective: "", canon: "", worldLore: "",
  });
  scope.displayTime = "";
  scope.recentPublicEvents = [];
  const { positivePrompt, includedBlocks } = composeScenePrompt(scope);
  assert.ok(positivePrompt.includes("WORLDNAME_SENTINEL_XQ"));
  assert.ok(positivePrompt.includes("LOCATION_SENTINEL_TD"));
  assert.ok(!positivePrompt.includes("Story:"), "空 story 整块省略");
  assert.ok(!positivePrompt.includes("Canon:"), "空 canon 整块省略");
  assert.ok(!positivePrompt.includes("Lore:"), "空 lore 整块省略");
  assert.ok(!positivePrompt.includes("Narrative focus:"), "空 focus 整块省略");
  assert.deepEqual([...includedBlocks], ["profile", "world", "scene"]);
});

test("composer: 完全空的 scope 只剩基底与 profile（不伪造内容）", () => {
  const { positivePrompt, includedBlocks } = composeScenePrompt({
    style: "modern",
    brief: {
      worldName: "", era: "", summary: "", storyTitle: "", premise: "",
      location: "", weather: "", tension: "", objective: "", canon: "", worldLore: "",
    },
    displayTime: "",
    recentPublicEvents: [],
  });
  assert.equal(
    positivePrompt,
    `${SCENE_IMAGE_BASE_PREFIX}\n${IMAGE_VISUAL_PROFILES.modern.visualPrompt}\n${SCENE_IMAGE_ENVIRONMENT_ONLY_RULES}\n\n`,
  );
  assert.deepEqual([...includedBlocks], ["profile"]);
});

test("composer: 长度预算与控制字符 fail-closed", () => {
  const huge = "龍".repeat(4000);
  const scope = sentinelScope({
    summary: huge,
    premise: huge,
    canon: huge,
    worldLore: huge,
  });
  const { positivePrompt, includedBlocks } = composeScenePrompt(scope);
  assert.ok(
    positivePrompt.length <= SCENE_PROMPT_MAX_CHARS,
    `positive 超出预算：${positivePrompt.length}`,
  );
  // 超预算从末位块向前丢（focus/lore/canon 先于 world/scene 被丢）。
  assert.ok(!includedBlocks.includes("focus"), "focus 应首先被丢弃");
  // 控制字符被剥离（独立小 scope，避开预算丢块；逐字符检查，仅放行 \n）。
  const controlScope = sentinelScope({
    canon: "", worldLore: "", location: "LOC\x00ATION\x07CTRL",
  });
  controlScope.recentPublicEvents = ["EVENT_SHOULD_NOT_ENTER"];
  const controlResult = composeScenePrompt(controlScope);
  assert.ok(
    [...controlResult.positivePrompt].every((ch) => ch === "\n" || ch >= " "),
    "positive 不得含控制字符",
  );
  assert.ok(controlResult.positivePrompt.includes("LOC ATION CTRL"));
  assert.ok(!controlResult.positivePrompt.includes("EVENT_SHOULD_NOT_ENTER"));
});

test("composer: recent public events 当前阶段不进入场景图 prompt", () => {
  const scope = sentinelScope({ canon: "", worldLore: "" });
  scope.recentPublicEvents = ["EVENT_SHOULD_NOT_ENTER_1", "EVENT_SHOULD_NOT_ENTER_2"];
  const { positivePrompt, includedBlocks } = composeScenePrompt(scope);
  assert.ok(!positivePrompt.includes("EVENT_SHOULD_NOT_ENTER_1"));
  assert.ok(!positivePrompt.includes("EVENT_SHOULD_NOT_ENTER_2"));
  assert.deepEqual([...includedBlocks], ["profile", "world", "scene"]);
});
