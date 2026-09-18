/**
 * 演示世界多语化契约：
 * - app/demo-content.ts 的 DEMO_IDS 必须与 database/postgres/demo-seed.ts
 *   的 POSTGRES_DEMO_IDS 一致（按 id 匹配的根基）；
 * - ui.demo.* 的 zh 值必须与种子原文逐字一致（防键表与种子漂移）；
 * - 助手对演示 id 返回三语不同文本，对非演示实体原样透传（同引用）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const readProjectFile = (relativePath) =>
  readFileSync(join(projectRoot, relativePath), "utf8");

const seedSource = readProjectFile("database/postgres/demo-seed.ts");
const definitionsSource = readProjectFile("modules/actions/demo-definitions.ts");

test("DEMO_IDS stay in lockstep with POSTGRES_DEMO_IDS", async () => {
  const { DEMO_IDS } = await import("../app/demo-content.ts");
  const expected = {
    world: /world: "([^"]+)"/.exec(seedSource)[1],
    worldline: /worldline: "([^"]+)"/.exec(seedSource)[1],
    story: /story: "([^"]+)"/.exec(seedSource)[1],
    record: /record: "([^"]+)"/.exec(seedSource)[1],
    openingEvent: /openingEvent: "([^"]+)"/.exec(seedSource)[1],
    playerDefinition: /playerDefinition: "([^"]+)"/.exec(seedSource)[1],
    scoutDefinition: /scoutDefinition: "([^"]+)"/.exec(seedSource)[1],
    scholarDefinition: /scholarDefinition: "([^"]+)"/.exec(seedSource)[1],
  };
  assert.deepEqual({ ...DEMO_IDS }, expected);
});

test("ui.demo.* zh values match the seed literals verbatim", async () => {
  const { uiMessageTable } = await import("../modules/i18n/public.ts");
  const pairs = [
    ["ui.demo.worldName", "烬海诸国"],
    ["ui.demo.worldSummary", "人魔停战十七年后，海上的无声钟再次响起。"],
    ["ui.demo.worldEra", "停战纪元 17 年"],
    ["ui.demo.worldWeather", "冷雾，无风"],
    ["ui.demo.worldTension", "钟声已经响过三次"],
    ["ui.demo.worldDisplayTime", "停战纪元17年 · 雾月12日 · 入夜"],
    ["ui.demo.worldlineLabel", "原初世界线"],
    ["ui.demo.storyTitle", "无声钟的来客"],
    ["ui.demo.storyPremise", "北岸灯塔在无风夜自行点亮，一封不属于任何阵营的密函被送上岸。"],
    ["ui.demo.recordTitle", "第一幕 · 雾港来信"],
    ["ui.demo.sceneLocation", "灰鲸港 · 北防波堤"],
    ["ui.demo.sceneObjective", "决定是否当众拆开密函"],
    ["ui.demo.charPlayerRole", "人类使节"],
    ["ui.demo.charPlayerSummary", "停战议会派来的年轻调停人。"],
    ["ui.demo.charScoutRole", "港卫斥候"],
    ["ui.demo.charScoutSummary", "熟悉灰鲸港每一条暗巷，对异常极度警觉。"],
    ["ui.demo.charScholarRole", "魔族铭文学者"],
    ["ui.demo.charScholarSummary", "温和寡言，能辨认战前的禁忌铭文。"],
    ["ui.demo.narrator", "旁白"],
  ];
  for (const [key, expected] of pairs) {
    const table = uiMessageTable(key);
    assert.ok(table, `${key} 缺失`);
    assert.equal(table["zh-CN"], expected, `${key} zh 值与种子原文漂移`);
    assert.ok(table.en.trim().length > 0, `${key} en 为空`);
    assert.ok(table.ja.trim().length > 0, `${key} ja 为空`);
  }
  // 种子原文必须仍存在于种子/定义源（本地化不回写 DB，锚定两边同源）。
  for (const literal of pairs.map(([, value]) => value)) {
    assert.ok(
      seedSource.includes(literal) || definitionsSource.includes(literal),
      `种子/定义源中找不到原文：${literal}`,
    );
  }
});

test("demo helpers localize demo entities and pass through everything else", async () => {
  const {
    demoWorldText,
    demoStoryText,
    demoSceneText,
    demoCharacterText,
    demoEventText,
    demoRecordTitle,
    DEMO_IDS,
  } = await import("../app/demo-content.ts");

  const world = { id: DEMO_IDS.world, name: "烬海诸国", era: "停战纪元 17 年", summary: "s" };
  assert.equal(demoWorldText(world, "zh-CN").name, "烬海诸国");
  assert.equal(demoWorldText(world, "en").name, "Embercoast Realms");
  assert.equal(demoWorldText(world, "ja").name, "燼海の諸国");
  assert.equal(demoWorldText(world, "en").era, "Year 17 of the Truce Era");

  const otherWorld = { id: "world_other", name: "别处", era: "e" };
  assert.equal(demoWorldText(otherWorld, "en"), otherWorld, "非演示世界必须同引用透传");

  const story = { id: DEMO_IDS.story, title: "无声钟的来客", premise: "p" };
  assert.notEqual(demoStoryText(story, "en").title, story.title);
  assert.equal(demoStoryText({ id: "story_x", title: "t" }, "en").title, "t");

  const scene = {
    location: "灰鲸港 · 北防波堤",
    worldTime: "停战纪元17年 · 雾月12日 · 入夜",
    weather: "冷雾，无风",
    tension: "钟声已经响过三次",
    objective: "决定是否当众拆开密函",
  };
  const enScene = demoSceneText(scene, DEMO_IDS.world, "en");
  assert.equal(enScene.location, "Graywhale Harbor · North Breakwater");
  assert.equal(enScene.weather, "Cold mist, no wind");
  assert.equal(demoSceneText(scene, "world_other", "en"), scene);

  const player = { id: DEMO_IDS.playerDefinition, role: "人类使节", summary: "x" };
  const enPlayer = demoCharacterText(player, "en");
  assert.equal(enPlayer.role, "Human envoy");
  assert.equal(enPlayer.summary, "A young mediator sent by the Truce Council.");

  const event = {
    id: DEMO_IDS.openingEvent,
    speaker: "旁白",
    content: "原文",
    worldTime: "停战纪元17年 · 雾月12日 · 入夜",
    segments: [
      { id: "environment-1", kind: "environment", content: "a", speechMode: "narrator" },
      { id: "story-1", kind: "story", content: "b", speechMode: "narrator" },
      { id: "fact-1", kind: "fact", content: "c", speechMode: "narrator" },
    ],
  };
  const jaEvent = demoEventText(event, "ja");
  assert.equal(jaEvent.speaker, "語り部");
  assert.equal(jaEvent.worldTime, "停戦紀17年・霧月12日・入夜");
  assert.equal(jaEvent.segments[0].content, "霧が石段を登り、防波堤へと迫る。");
  assert.ok(jaEvent.content.includes(jaEvent.segments[1].content));
  const otherEvent = { id: "evt_x", speaker: "旁白", content: "c", worldTime: "w", segments: [] };
  assert.equal(demoEventText(otherEvent, "en"), otherEvent);

  assert.equal(demoRecordTitle(DEMO_IDS.record, "第一幕 · 雾港来信", "ja"), "第一幕・霧港の手紙");
  assert.equal(demoRecordTitle("record_x", "t", "ja"), "t");
});
