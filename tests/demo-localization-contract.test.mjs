/**
 * 演示世界多语化契约（内容解析层版本）：
 * - app/demo-content.ts 的 DEMO_IDS 必须与 database/postgres/demo-seed.ts
 *   的 POSTGRES_DEMO_IDS 一致（按 id 匹配的根基）；
 * - 演示世界文案的唯一事实来源是内容解析层 base bundle "ember-coast"
 *   （modules/content-resolution）；zh-CN 规范值必须与本文件的锚定原文
 *   逐字一致（防内容层漂移）；
 * - demo-seed.ts 必须经 base resolver 取内容（兼容 shim），不得回退为
 *   硬编码文案；
 * - 助手对演示 id 返回三语不同文本，对非演示实体原样透传（同引用）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const readProjectFile = (relativePath) =>
  readFileSync(join(projectRoot, relativePath), "utf8");

const seedSource = readProjectFile("database/postgres/demo-seed.ts");
const demoContentSource = readProjectFile("app/demo-content.ts");

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

test("base content layer owns the canonical demo texts (zh-CN verbatim anchors)", async () => {
  const { BASE_CONTENT_RESOLVER } = await import("../modules/content-resolution/base-resolver.ts");
  const { BASE_DEMO_CONTENT_KEY } = await import("../modules/content-resolution/base-content-data.ts");
  const { baseContentRequestBase } = await import("../modules/content-resolution/public.ts");
  const scope = baseContentRequestBase("zh-CN", BASE_DEMO_CONTENT_KEY);
  const messages = BASE_CONTENT_RESOLVER.resolveMessages(scope);
  assert.ok(messages, "demo message bundle must resolve");
  const pairs = [
    ["world.name", "烬海诸国"],
    ["world.summary", "人魔停战十七年后，海上的无声钟再次响起。"],
    ["world.era", "停战纪元 17 年"],
    ["world.weather", "冷雾，无风"],
    ["world.tension", "钟声已经响过三次"],
    ["world.displayTime", "停战纪元17年 · 雾月12日 · 入夜"],
    ["worldline.origin.label", "原初世界线"],
    ["story.title", "无声钟的来客"],
    ["story.premise", "北岸灯塔在无风夜自行点亮，一封不属于任何阵营的密函被送上岸。"],
    ["record.title", "第一幕 · 雾港来信"],
    ["scene.location", "灰鲸港 · 北防波堤"],
    ["scene.objective", "决定是否当众拆开密函"],
    ["character.player.role", "人类使节"],
    ["character.player.summary", "停战议会派来的年轻调停人。"],
    ["character.scout.role", "港卫斥候"],
    ["character.scout.summary", "熟悉灰鲸港每一条暗巷，对异常极度警觉。"],
    ["character.scholar.role", "魔族铭文学者"],
    ["character.scholar.summary", "温和寡言，能辨认战前的禁忌铭文。"],
    ["opening.speaker", "旁白"],
  ];
  for (const [key, expected] of pairs) {
    assert.equal(messages[key], expected, `${key} zh 规范值漂移`);
  }
  // en/ja 必须非空且与 zh 不同（角色名等专有名词除外）。
  for (const language of ["en", "ja"]) {
    const localized = BASE_CONTENT_RESOLVER.resolveMessages(
      baseContentRequestBase(language, BASE_DEMO_CONTENT_KEY),
    );
    for (const [key, zhValue] of pairs) {
      assert.ok(localized[key].trim().length > 0, `${key}/${language} 为空`);
      assert.notEqual(localized[key], zhValue, `${key}/${language} 未翻译`);
    }
  }
});

test("demo seed is a compatibility shim over the base content layer", () => {
  // shim 必须经内容解析层取内容，且不再硬编码世界文案原文。
  assert.match(seedSource, /content-resolution\/base-resolver\.ts/);
  assert.match(seedSource, /content-resolution\/base-content-data\.ts/);
  for (const literal of ["烬海诸国", "无声钟的来客", "灰鲸港 · 北防波堤"]) {
    assert.ok(
      !seedSource.includes(literal),
      `demo-seed 不得硬编码世界文案：${literal}`,
    );
  }
  // 渲染层映射只引用内容层消息键，不再经过 ui.demo.* 界面文案层。
  assert.ok(!demoContentSource.includes("ui.demo."), "demo-content 不得再引用 ui.demo.* 键");
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
