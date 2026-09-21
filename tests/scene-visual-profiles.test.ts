/**
 * 图像视觉 profile 测试：四风格注入、unknown fail-closed、场景-only分层、
 * 漂移负面、预算保护（profile 不挤掉 World/Scene 核心数据）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  composeScenePrompt,
  IMAGE_VISUAL_PROFILES,
  imageVisualProfile,
  resolveImageVisualStyle,
  SCENE_IMAGE_BASE_PREFIX,
  SCENE_IMAGE_NEGATIVE_PROMPT,
  SCENE_PROMPT_MAX_CHARS,
  type ScenePromptScope,
} from "../modules/imagine/public.ts";
import { WORLD_STYLE_KEYS } from "../modules/style/world-style.ts";

function baseScope(style: unknown): ScenePromptScope {
  return {
    style: style as ScenePromptScope["style"],
    brief: {
      worldName: "WORLD_XQ", era: "ERA_ZR", summary: "SUMMARY_PM",
      storyTitle: "STORY_KV", premise: "PREMISE_GB",
      location: "LOCATION_TD", weather: "WEATHER_HY",
      tension: "TENSION_WU", objective: "OBJECTIVE_FJ",
      canon: "- CANON_AQ：fact", worldLore: "- 《LORE_EK》：excerpt",
    },
    displayTime: "TIME_NC",
    recentPublicEvents: ["EVENT_ONE"],
  };
}

test("profile: 四种 WorldStyle 的视觉层全部进入 positive 且分层顺序固定", () => {
  for (const style of WORLD_STYLE_KEYS) {
    const profile = IMAGE_VISUAL_PROFILES[style];
    const { positivePrompt, includedBlocks, visualStyle } = composeScenePrompt(baseScope(style));
    assert.ok(profile.visualPrompt.length > 0, `${style} profile 不能为空`);
    assert.ok(positivePrompt.includes(profile.visualPrompt), `${style} profile 未进 prompt`);
    assert.equal(visualStyle, style);
    assert.deepEqual(
      [...includedBlocks],
      ["profile", "world", "scene"],
      `${style} 场景-only 分层必须固定`,
    );
    // 顺序：base → profile → world。
    assert.ok(positivePrompt.startsWith(SCENE_IMAGE_BASE_PREFIX));
    assert.ok(
      positivePrompt.indexOf(profile.visualPrompt) < positivePrompt.indexOf("WORLD_XQ"),
      `${style} profile 必须在 World 之前`,
    );
  }
});

test("profile: 未知/缺失风格 fail-closed 到 modern", () => {
  assert.equal(resolveImageVisualStyle("cyberpunk-2077"), "modern");
  assert.equal(resolveImageVisualStyle(undefined), "modern");
  assert.equal(resolveImageVisualStyle(42), "modern");
  assert.equal(imageVisualProfile("cyberpunk-2077"), IMAGE_VISUAL_PROFILES.modern);
  const { visualStyle, positivePrompt } = composeScenePrompt(baseScope("cyberpunk-2077"));
  assert.equal(visualStyle, "modern");
  assert.ok(positivePrompt.includes(IMAGE_VISUAL_PROFILES.modern.visualPrompt));
});

test("profile: negative 稳定前缀 + 每风格漂移约束", () => {
  for (const style of WORLD_STYLE_KEYS) {
    const profile = IMAGE_VISUAL_PROFILES[style];
    const { negativePrompt } = composeScenePrompt(baseScope(style));
    assert.ok(negativePrompt.startsWith(SCENE_IMAGE_NEGATIVE_PROMPT));
    assert.ok(negativePrompt.includes(profile.negativeAdditions));
    assert.ok(
      negativePrompt.includes("photorealistic"),
      `${style} 必须带风格漂移负面`,
    );
  }
});

test("profile: 预算压力下 profile 不被丢弃、动态数据仍保留核心块", () => {
  const scope = baseScope("classical");
  scope.brief.canon = "龍".repeat(3000);
  scope.brief.worldLore = "龍".repeat(3000);
  const { positivePrompt, includedBlocks } = composeScenePrompt(scope);
  assert.ok(positivePrompt.length <= SCENE_PROMPT_MAX_CHARS);
  assert.ok(includedBlocks.includes("profile"), "profile 不得被预算丢弃");
  assert.ok(includedBlocks.includes("world") && includedBlocks.includes("scene"));
  assert.ok(positivePrompt.includes(IMAGE_VISUAL_PROFILES.classical.visualPrompt));
});

test("profile: 视觉层文本均为英文视觉约束且有界（≤400 字符）", () => {
  for (const style of WORLD_STYLE_KEYS) {
    const profile = IMAGE_VISUAL_PROFILES[style];
    assert.ok(profile.visualPrompt.length <= 400, `${style} profile 超预算`);
    assert.ok(!/[一-鿿]/.test(profile.visualPrompt), `${style} profile 不得含中文行文`);
    assert.ok(!/[一-鿿]/.test(profile.negativeAdditions), `${style} negative 不得含中文`);
  }
});
