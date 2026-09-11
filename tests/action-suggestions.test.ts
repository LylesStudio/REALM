import assert from "node:assert/strict";
import test from "node:test";
import {
  composeAssetSuggestion,
  composeObserveSurroundingsCopy,
} from "../database/postgres/action-state.ts";
import { normalizeNextSuggestions } from "../modules/orchestration/public.ts";
import { normalizeRecordEnvelope } from "../app/components/record-types.ts";

test("observe-surroundings copy follows the scene snapshot", () => {
  // 留白（无场景数据）：中性兜底，不编造意象。
  assert.deepEqual(
    composeObserveSurroundingsCopy({ scene_location: null, scene_weather: null }),
    {
      description: "留意周遭环境的变化。",
      suggestedText: "我观察周遭的变化。",
    },
  );
  assert.deepEqual(
    composeObserveSurroundingsCopy({ scene_location: "  ", scene_weather: "雾" }),
    {
      description: "留意周遭环境的变化。",
      suggestedText: "我观察周遭的变化。",
    },
  );

  // 有场景：贴合地点与天气。
  assert.deepEqual(
    composeObserveSurroundingsCopy({
      scene_location: "灰鲸港 · 北防波堤",
      scene_weather: "冷雾，无风",
    }),
    {
      description: "留意灰鲸港 · 北防波堤一带的变化（冷雾，无风）。",
      suggestedText: "我观察灰鲸港 · 北防波堤一带的变化。",
    },
  );

  // 有地点无天气：不带括注。
  assert.deepEqual(
    composeObserveSurroundingsCopy({ scene_location: "灯塔值房", scene_weather: "" }),
    {
      description: "留意灯塔值房一带的变化。",
      suggestedText: "我观察灯塔值房一带的变化。",
    },
  );

  // 任何输入都不得产出演示世界意象（除非它来自场景数据本身）。
  const bare = composeObserveSurroundingsCopy({
    scene_location: null,
    scene_weather: null,
  });
  assert.ok(!bare.description.includes("防波堤"));
  assert.ok(!bare.description.includes("灯塔"));
});

test("asset suggestion composes from the asset's own title", () => {
  assert.equal(composeAssetSuggestion("雾港信号灯"), "我使用雾港信号灯。");
  assert.equal(composeAssetSuggestion(" 铜罗盘 "), "我使用铜罗盘。");
  assert.equal(composeAssetSuggestion(""), "我使用这件物品。");
});

test("next suggestions normalize with fail-closed semantics", () => {
  assert.deepEqual(normalizeNextSuggestions(undefined), []);
  assert.deepEqual(normalizeNextSuggestions(null), []);
  assert.deepEqual(normalizeNextSuggestions("问灯塔看守"), []);
  assert.deepEqual(normalizeNextSuggestions([]), []);
  assert.deepEqual(normalizeNextSuggestions([" ", 42, null]), []);

  // 修剪、限长、至多 3 条。
  assert.deepEqual(
    normalizeNextSuggestions([
      "  问问灯塔看守  ",
      "x".repeat(60),
      "拆开密函",
      "第四条不出现",
    ]),
    ["问问灯塔看守", "x".repeat(40), "拆开密函"],
  );
});

test("record envelope carries suggestions only when the server sends them", () => {
  const base = {
    ok: true,
    record: { id: "r1", title: "记录" },
    writeToken: "token",
    viewer: { perspective: "omniscient", dynamicKnowledgeVisible: true },
  };
  // 缺失字段 → 空数组（不渲染提案区）。
  assert.deepEqual(normalizeRecordEnvelope(base).suggestions, []);
  // 非法载荷 → 空数组。
  assert.deepEqual(
    normalizeRecordEnvelope({ ...base, suggestions: "不是数组" }).suggestions,
    [],
  );
  // 正常载荷 → 修剪保留。
  assert.deepEqual(
    normalizeRecordEnvelope({
      ...base,
      suggestions: [" 看看雾里的船 ", "", "回航", "第四条"],
    }).suggestions,
    ["看看雾里的船", "回航", "第四条"],
  );
});
