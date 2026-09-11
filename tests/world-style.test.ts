import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WORLD_STYLE,
  WORLD_STYLE_KEYS,
  WORLD_STYLE_PROFILES,
  describeWorldStyle,
  normalizeWorldStyle,
  worldStyleTemplateKeys,
  worldStyleTemplateTable,
  worldStyleText,
} from "../modules/style/world-style.ts";

test("style enum normalizes unknown and missing values to modern", () => {
  assert.equal(normalizeWorldStyle(undefined), "modern");
  assert.equal(normalizeWorldStyle(null), "modern");
  assert.equal(normalizeWorldStyle(""), "modern");
  assert.equal(normalizeWorldStyle("gothic"), "modern");
  assert.equal(normalizeWorldStyle("classical"), "classical");
  assert.equal(normalizeWorldStyle("anime"), "anime");
  assert.equal(DEFAULT_WORLD_STYLE, "modern");
});

test("every style profile carries the full structured constraint set", () => {
  for (const key of WORLD_STYLE_KEYS) {
    const profile = WORLD_STYLE_PROFILES[key];
    assert.ok(profile.label.trim().length > 0, `${key}.label`);
    assert.ok(profile.tone.trim().length > 0, `${key}.tone`);
    assert.ok(profile.diction.trim().length > 0, `${key}.diction`);
    assert.ok(profile.imagery.trim().length > 0, `${key}.imagery`);
    assert.ok(profile.sample.trim().length > 0, `${key}.sample`);
    // 风格描述注入的是结构化约束而非单个名词。
    const block = describeWorldStyle(key);
    assert.ok(block.includes("语调："));
    assert.ok(block.includes("用词："));
    assert.ok(block.includes("意象："));
    assert.ok(block.includes("示范："));
  }
});

test("every fixed-copy template key has all four styles with no empty strings", () => {
  const keys = worldStyleTemplateKeys();
  // 规范 §4 清单：9 步提问 + 4 风格名 + 4 行动卡 + 7 结晶 + 2 空态。
  assert.ok(keys.length >= 26, `template count ${keys.length}`);
  for (const key of keys) {
    const table = worldStyleTemplateTable(key);
    assert.ok(table, key);
    for (const style of WORLD_STYLE_KEYS) {
      const value: unknown = table[style];
      assert.equal(typeof value, "string", `${key}/${style}`);
      assert.ok((value as string).trim().length > 0, `${key}/${style} must not be empty`);
    }
  }
  // 清单关键 key 存在性抽查
  for (const required of [
    "guided.step.world-name.question",
    "guided.step.style.question",
    "guided.step.review.question",
    "action.observe.description.blank",
    "scene.crystallize.prefix",
    "scene.crystallize.speaker",
    "timeline.empty.title",
  ]) {
    assert.ok(keys.includes(required), required);
  }
});

test("template lookup interpolates params and falls back safely", () => {
  assert.equal(
    worldStyleText("action.observe.description.scenic", "modern", {
      location: "天台",
      weather: "小雨",
    }),
    "留意天台一带的变化（小雨）。",
  );
  assert.equal(
    worldStyleText("guided.step.world-name.question", "classical"),
    "这片天地，当以何名传世？",
  );
  // 未知 key 抛出（契约测试兜底不允许缺失）。
  assert.throws(() => worldStyleText("no.such.key", "modern"));
});
