/**
 * 内容解析层 · BaseContentResolver focused 验收。
 *
 * 覆盖（目标 Slice 1 验收面）：
 * - base resolver 返回期望的 world/character/action/story/scene/goal/i18n
 *   形状（含三语本地化与不可变性）；
 * - 未知内容键 fail-closed（显式 null miss，绝不回退其他 bundle/文案）；
 * - 身份键拒绝：world-bound binding、夹带身份、非哨兵版本、空 worldId
 *   违例、未知请求键、非法语言一律抛 ContentResolutionError；
 * - 返回值深冻结，调用方 mutate 不影响共享内容。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_CONTENT_RESOLVER,
  createBaseContentResolver,
} from "../modules/content-resolution/base-resolver.ts";
import {
  ContentResolutionError,
  baseContentRequestBase,
  normalizeContentLanguage,
  type ContentResolver,
} from "../modules/content-resolution/public.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";

const resolver: ContentResolver = createBaseContentResolver();
const demoScope = baseContentRequestBase("zh-CN", "ember-coast");

test("content language normalizer accepts exactly the three supported languages", () => {
  assert.equal(normalizeContentLanguage("zh-CN"), "zh-CN");
  assert.equal(normalizeContentLanguage("en"), "en");
  assert.equal(normalizeContentLanguage("ja"), "ja");
  assert.equal(normalizeContentLanguage("fr"), undefined);
  assert.equal(normalizeContentLanguage(""), undefined);
  assert.equal(normalizeContentLanguage(undefined), undefined);
});

test("base resolver returns the expected world shape with settings and localization", () => {
  const world = resolver.resolveWorld(demoScope);
  assert.ok(world);
  assert.equal(world.contentKey, "ember-coast");
  assert.equal(world.name, "烬海诸国");
  assert.equal(world.era, "停战纪元 17 年");
  assert.equal(world.calendarId, "truce_calendar");
  assert.equal(world.style, "classical");
  assert.equal(world.worldlineLabel, "原初世界线");
  assert.deepEqual(world.settings, {
    era: "停战纪元 17 年",
    style: "classical",
    weather: "冷雾，无风",
    tension: "钟声已经响过三次",
    displayTime: "停战纪元17年 · 雾月12日 · 入夜",
  });

  const en = resolver.resolveWorld(baseContentRequestBase("en", "ember-coast"));
  assert.equal(en?.name, "Embercoast Realms");
  assert.equal(en?.worldlineLabel, "Original Worldline");
  const ja = resolver.resolveWorld(baseContentRequestBase("ja", "ember-coast"));
  assert.equal(ja?.name, "燼海の諸国");

  // preset bundle 也经同一契约解析。
  const preset = resolver.resolveWorld(baseContentRequestBase("zh-CN", "dnd-tavern"));
  assert.equal(preset?.name, "遗忘酒馆");
  assert.equal(preset?.style, "western_fantasy");
  assert.equal(preset?.calendarId, "native_calendar");
});

test("base resolver returns character definitions including the player seat", () => {
  const characters = resolver.listCharacters(demoScope);
  assert.equal(characters.length, 3);
  const player = resolver.resolveCharacter({ ...demoScope, characterKey: "player" });
  assert.ok(player);
  assert.equal(player.isPlayer, true);
  assert.equal(player.displayName, "洛川");
  assert.equal(player.role, "人类使节");
  const scoutEn = resolver.resolveCharacter({
    ...baseContentRequestBase("en", "ember-coast"),
    characterKey: "scout",
  });
  assert.equal(scoutEn?.displayName, "塞娜", "专有名词不翻译");
  assert.equal(scoutEn?.role, "Harbor watch scout");
  const scholar = resolver.resolveCharacter({ ...demoScope, characterKey: "scholar" });
  assert.equal(scholar?.isPlayer, false);
});

test("base resolver returns skill/asset/stance action definitions with rule payloads", () => {
  const actions = resolver.listActions(demoScope);
  assert.deepEqual(
    actions.map((action) => action.actionKey).sort(),
    ["careful_observation", "guarded_watch", "signal_lantern"].sort(),
  );

  const skill = resolver.resolveAction({
    ...demoScope,
    actionKind: "skill",
    actionKey: "careful_observation",
  });
  assert.ok(skill);
  assert.equal(skill.actionKind, "skill");
  assert.equal(skill.title, "细致观察");
  assert.equal(skill.rulePackKey, "realm.light.v1");
  assert.equal(skill.consumable, false);
  assert.equal(skill.effectKind, null);
  assert.deepEqual(skill.metadata.check, { system: "d20", modifier: 2, target: 12 });

  const asset = resolver.resolveAction({ ...demoScope, actionKind: "asset", actionKey: "signal_lantern" });
  assert.equal(asset?.consumable, true);
  const stance = resolver.resolveAction({ ...demoScope, actionKind: "stance", actionKey: "guarded_watch" });
  assert.equal(stance?.effectKind, "stance");

  // actionKind 不符 = miss（绝不跨类返回同 key 内容）。
  assert.equal(
    resolver.resolveAction({ ...demoScope, actionKind: "asset", actionKey: "careful_observation" }),
    null,
  );
  // kind 过滤的 list。
  assert.equal(resolver.listActions({ ...demoScope, actionKind: "skill" }).length, 1);
  // preset bundle 无演示 Action。
  assert.equal(resolver.listActions(baseContentRequestBase("zh-CN", "dnd-tavern")).length, 0);
});

test("base resolver returns story/scene shapes including the opening narration", () => {
  const story = resolver.resolveStory(demoScope);
  assert.ok(story);
  assert.equal(story.storyKey, "silent-bell");
  assert.equal(story.title, "无声钟的来客");
  assert.equal(story.recordTitle, "第一幕 · 雾港来信");
  assert.equal(story.opening.speaker, "旁白");
  assert.equal(story.opening.segments.length, 3);
  assert.equal(story.opening.segments[0]?.id, "environment-1");
  assert.ok(story.opening.content.includes("无声钟") === false);

  const scene = resolver.resolveScene(demoScope);
  assert.ok(scene);
  assert.equal(scene.sceneKey, "north-breakwater");
  assert.equal(scene.title, "北防波堤");
  assert.equal(scene.location, "灰鲸港 · 北防波堤");
  assert.equal(scene.objective, "决定是否当众拆开密函");
  assert.equal(scene.displayTime, "停战纪元17年 · 雾月12日 · 入夜");

  // 显式 key 不符 = miss；缺省 = bundle 主 story/scene。
  assert.equal(resolver.resolveStory({ ...demoScope, storyKey: "other" }), null);
  assert.equal(resolver.resolveScene({ ...demoScope, sceneKey: "other" }), null);
  assert.equal(resolver.resolveStory({ ...demoScope, storyKey: "silent-bell" })?.title, story.title);
});

test("base resolver resolves engine-owned Goal definitions only in the sentinel mode", () => {
  const goal = resolver.resolveGoal({ ...demoScope, goalKey: "base.first-narration" });
  assert.ok(goal);
  assert.equal(goal.goalKey, "base.first-narration");
  assert.equal(goal.policyVersion, "base-v1");
  assert.equal(goal.mode, "deterministic");
  assert.equal(resolver.resolveGoal({ ...demoScope, goalKey: "missing" }), null);
});

test("base resolver resolves flat i18n message bundles per language", () => {
  const zh = resolver.resolveMessages(demoScope);
  assert.ok(zh);
  assert.equal(zh["world.name"], "烬海诸国");
  assert.equal(zh["character.scout.role"], "港卫斥候");
  assert.equal(zh["action.signal_lantern.title"], "雾港信号灯");
  assert.equal(zh["opening.segment.fact-1"], "远处灯塔的光随第三声钟鸣熄灭。");
  const en = resolver.resolveMessages(baseContentRequestBase("en", "ember-coast"));
  assert.equal(en?.["world.name"], "Embercoast Realms");
  assert.equal(en?.["action.guarded_watch.description"], "Contain your movements and stay alert to changes around you.");
  // preset bundle 也有消息束（世界/故事/记录/开场白）。
  const preset = resolver.resolveMessages(baseContentRequestBase("ja", "anime-hero"));
  assert.equal(preset?.["world.name"], "魔王城前の村");
  assert.equal(typeof preset?.["opening.content"], "string");
});

test("base resolver resolves full genesis content per bundle and language", () => {
  const content = resolver.resolveGenesisContent({
    binding: { kind: "base" },
    contentKey: "dnd-tavern",
    language: "en",
  });
  assert.ok(content);
  assert.equal(content.contentKey, "dnd-tavern");
  assert.equal(content.world.name, "The Forgotten Tavern");
  assert.equal(content.world.style, "western_fantasy");
  assert.equal(content.story.title, "The Greystone Commission");
  assert.equal(content.record.title, "Act I · The Tavern's Commission");
  assert.equal(content.scene.location, "Greystone · Rusted Anchor Tavern");
  // 空可选字段省略（preset 无 displayTime/scene.title）。
  assert.equal(content.scene.displayTime, undefined);
  assert.equal(content.scene.title, undefined);
  assert.equal(content.playerRole, "Retired town-guard swordsman");
  assert.equal(content.playerStance, "player");
  assert.equal(content.characters.length, 2);
  assert.deepEqual(content.goals, []);
  assert.match(content.opening, /tavern door crashes open/);

  // ember-coast 的 genesis 内容含 displayTime，同伴不含玩家席位。
  const demo = resolver.resolveGenesisContent({
    binding: { kind: "base" },
    contentKey: "ember-coast",
    language: "zh-CN",
  });
  assert.equal(demo?.scene.displayTime, "停战纪元17年 · 雾月12日 · 入夜");
  assert.deepEqual(
    demo?.characters.map((character) => character.characterKey),
    ["scout", "scholar"],
  );
});

test("unknown content keys fail closed with explicit null misses", () => {
  assert.equal(resolver.resolveWorld(baseContentRequestBase("zh-CN", "no-such-bundle")), null);
  assert.equal(
    resolver.resolveCharacter({ ...demoScope, characterKey: "ghost" }),
    null,
  );
  assert.equal(
    resolver.resolveAction({ ...demoScope, actionKind: "skill", actionKey: "ghost" }),
    null,
  );
  assert.equal(
    resolver.resolveMessages(baseContentRequestBase("zh-CN", "no-such-bundle")),
    null,
  );
  assert.equal(
    resolver.resolveGenesisContent({
      binding: { kind: "base" },
      contentKey: "no-such-bundle",
      language: "zh-CN",
    }),
    null,
  );
  assert.deepEqual(resolver.listCharacters(baseContentRequestBase("zh-CN", "no-such-bundle")), []);
  assert.deepEqual(resolver.listActions(baseContentRequestBase("zh-CN", "no-such-bundle")), []);
});

test("identity violations are rejected fail-closed", () => {
  // world-bound binding：base resolver 绝不代解。
  assert.throws(
    () => resolver.resolveWorld({
      binding: { kind: "world", worldId: "world_harbor", worldVersion: "1.2.0" },
      worldId: "world_harbor",
      worldVersion: "1.2.0",
      language: "zh-CN",
    }),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_IDENTITY_REJECTED",
  );
  // base 请求夹带 worldId。
  assert.throws(
    () => resolver.resolveWorld({
      ...demoScope,
      worldId: "world_ember_coast",
    }),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_IDENTITY_REJECTED",
  );
  // 非哨兵版本。
  assert.throws(
    () => resolver.resolveWorld({ ...demoScope, worldVersion: "1.0.0" }),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_IDENTITY_REJECTED",
  );
  // 夹带额外身份键的伪造 base binding。
  assert.throws(
    () => resolver.resolveWorld({
      ...demoScope,
      binding: { kind: "base", worldId: "sneaky" } as never,
    }),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_IDENTITY_REJECTED",
  );
  // genesis 请求同样拒绝 world-bound binding。
  assert.throws(
    () => resolver.resolveGenesisContent({
      binding: { kind: "world", worldId: "world_harbor", worldVersion: "1.2.0" },
      language: "zh-CN",
    }),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_IDENTITY_REJECTED",
  );
});

test("malformed requests are rejected fail-closed", () => {
  // 未知请求键。
  assert.throws(
    () => resolver.resolveWorld({ ...demoScope, tenantId: "x" } as never),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_REQUEST_INVALID",
  );
  // 非法语言。
  assert.throws(
    () => resolver.resolveWorld({ ...demoScope, language: "fr" } as never),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_REQUEST_INVALID",
  );
  // 空 characterKey/actionKey/goalKey。
  assert.throws(
    () => resolver.resolveCharacter({ ...demoScope, characterKey: "  " }),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_REQUEST_INVALID",
  );
  assert.throws(
    () => resolver.resolveGoal({ ...demoScope, goalKey: "" }),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_REQUEST_INVALID",
  );
  // world-bound 请求身份与 binding 不符。
  assert.throws(
    () => resolver.resolveWorld({
      binding: { kind: "world", worldId: "world_harbor", worldVersion: "1.2.0" },
      worldId: "world_other",
      worldVersion: "1.2.0",
      language: "zh-CN",
    }),
    (error: unknown) =>
      error instanceof ContentResolutionError && error.code === "CONTENT_IDENTITY_REJECTED",
  );
});

test("resolved content is deeply frozen plain data", () => {
  const world = resolver.resolveWorld(demoScope);
  assert.ok(world && Object.isFrozen(world) && Object.isFrozen(world.settings));
  const story = resolver.resolveStory(demoScope);
  assert.ok(story && Object.isFrozen(story.opening) && Object.isFrozen(story.opening.segments));
  const skill = resolver.resolveAction({ ...demoScope, actionKind: "skill", actionKey: "careful_observation" });
  assert.ok(skill && Object.isFrozen(skill.metadata));
  const metadata = skill!.metadata as { check: Record<string, unknown> };
  assert.ok(Object.isFrozen(metadata.check));
  const messages = resolver.resolveMessages(demoScope);
  assert.ok(messages && Object.isFrozen(messages));
  const genesis = resolver.resolveGenesisContent({
    binding: { kind: "base" },
    contentKey: "dnd-tavern",
    language: "zh-CN",
  });
  assert.ok(genesis && Object.isFrozen(genesis.characters) && Object.isFrozen(genesis.world.settings));

  // mutate 返回值不影响后续解析（共享 bundle 不受污染）。
  const before = resolver.resolveWorld(demoScope)?.name;
  assert.equal(before, "烬海诸国");
  assert.equal(LOCAL_WORLD_VERSION, "0.0.0-local");
  // 共享 resolver 与工厂实例行为一致。
  assert.equal(
    BASE_CONTENT_RESOLVER.resolveWorld(demoScope)?.name,
    resolver.resolveWorld(demoScope)?.name,
  );
});
