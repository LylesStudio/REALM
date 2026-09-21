import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  uiMessageTable,
  uiText,
} from "../modules/i18n/public.ts";

/**
 * 玩家路径迭代契约（PLAYER-JOURNEY-ITERATION.md 的结构锁定）：
 * 入口主次、Library 显式回 Record、GenesisChat 字段 i18n、overlay 语义、
 * 新 key 三语完整。不创建真实世界、不发请求、不读 .env.local。
 */
const root = resolve(new URL("..", import.meta.url).pathname);
const read = (relative) => readFileSync(resolve(root, relative), "utf8");

test("onboarding keeps exactly one primary creation entry and an existing-worlds area", () => {
  const onboarding = read("app/components/world-onboarding.tsx");
  assert.equal(
    (onboarding.match(/onboarding-entry is-primary/g) ?? []).length,
    1,
    "入口屏必须恰好一个 primary 创世动作",
  );
  assert.match(onboarding, /onboarding-worlds/);
  assert.ok(
    onboarding.indexOf("onboarding-entries") < onboarding.indexOf("onboarding-worlds"),
    "已有世界区必须位于创世动作之后",
  );
  assert.doesNotMatch(onboarding, /onOpenGraph|onManage|归档|删除/, "入口屏不得混入管理工具");
});

test("library exposes an explicit return-to-record action only when a record is open", () => {
  const panel = read("app/components/library-panel.tsx");
  assert.match(panel, /currentRecordId\.trim\(\) \? \(/);
  assert.match(panel, /uiText\("ui\.library\.returnToRecord", uiLanguage\)/);
  assert.match(panel, /onOpenRecord\(currentRecordId\)/);
  assert.doesNotMatch(panel, /aria-label="世界库"/, "panel aria-label 不得硬编码中文");
  assert.match(panel, /uiText\("ui\.header\.library", uiLanguage\)/);
});

test("world and story views expose an explicit return to the current record", () => {
  const world = read("app/components/world-view.tsx");
  const story = read("app/components/story-view.tsx");
  assert.match(world, /currentRecordId\.trim\(\) \? \(/);
  assert.match(world, /uiText\("ui\.worldView\.openRecord", uiLanguage\)/);
  assert.match(world, /onOpenRecord\(currentRecordId\)/);
  assert.match(story, /currentRecordId\.trim\(\) \? \(/);
  assert.match(story, /uiText\("ui\.storyView\.openRecord", uiLanguage\)/);
  assert.match(story, /onOpenRecord\(currentRecordId\)/);
  const css = read("app/globals.css");
  assert.match(css, /\.record-action-button\.is-primary\s*\{/);
  assert.match(css, /\.record-section\s*\{\s*border-top: 1px solid var\(--line\);\s*display: block;/);
  assert.match(css, /\.record-section\s*\{[\s\S]*grid-column: 1 \/ -1;/);
  assert.match(css, /\.speaker-block h3\s*\{[\s\S]*white-space: nowrap;/);
});

test("genesis chat proposal fields and placeholders are fully i18n-driven", () => {
  const chat = read("app/components/guided-genesis-chat.tsx");
  for (const hardcoded of [
    "世界名称",
    "时代背景",
    "世界概述",
    "开场故事",
    "故事简介",
    "记录之名",
    "你的定位",
  ]) {
    assert.ok(
      !chat.includes(`<span>${hardcoded}</span>`),
      `genesis-chat 残留硬编码 label: ${hardcoded}`,
    );
  }
  assert.equal(
    (chat.match(/placeholder="[^"]*"/g) ?? []).length,
    0,
    "genesis-chat 不得残留硬编码 placeholder",
  );
});

test("new journey i18n keys exist in all three languages", () => {
  const keys = [
    "ui.library.returnToRecord",
    "ui.genesisChat.field.worldName",
    "ui.genesisChat.field.era",
    "ui.genesisChat.field.summary",
    "ui.genesisChat.field.storyTitle",
    "ui.genesisChat.field.storyPremise",
    "ui.genesisChat.field.companions",
    "ui.genesisChat.field.scene",
    "ui.genesisChat.field.style",
    "ui.genesisChat.field.recordTitle",
    "ui.genesisChat.field.playerRole",
    "ui.genesisChat.ph.name",
    "ui.genesisChat.ph.role",
    "ui.genesisChat.ph.sketch",
    "ui.genesisChat.ph.location",
    "ui.genesisChat.ph.weather",
    "ui.genesisChat.ph.tension",
    "ui.genesisChat.ph.objective",
    "ui.genesisChat.addCompanion",
    "ui.genesisChat.removeCompanion",
    "ui.storyView.openRecord",
  ];
  for (const key of keys) {
    const table = uiMessageTable(key);
    assert.ok(table, `missing i18n key: ${key}`);
    for (const language of ["zh-CN", "en", "ja"]) {
      assert.ok(table[language]?.trim(), `${key} 缺 ${language} 文案`);
    }
  }
  assert.equal(uiText("ui.library.heading", "zh-CN"), "创建 · 导入 · 管理");
  assert.equal(uiText("ui.library.returnToRecord", "zh-CN"), "← 回到当前记录");
});

test("overlays keep dialog semantics and the journey design doc is frozen", () => {
  const client = read("app/realm-client.tsx");
  assert.equal((client.match(/role="dialog"/g) ?? []).length >= 3, true);
  assert.ok(
    existsSync(resolve(root, "docs/development/PLAYER-JOURNEY-ITERATION.md")),
    "路径设计规范必须存在",
  );
});
