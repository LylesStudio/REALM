import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_UI_LANGUAGE,
  UI_LANGUAGES,
  normalizeUiLanguage,
  uiMessageKeys,
  uiMessageTable,
  uiText,
} from "../modules/i18n/public.ts";
import {
  WORLD_STYLE_KEYS,
  WORLD_STYLE_LANGUAGES,
  worldStyleTemplateKeys,
  worldStyleTemplateTable,
  worldStyleText,
} from "../modules/style/world-style.ts";

test("ui language enum normalizes unknown values to zh-CN", () => {
  assert.equal(normalizeUiLanguage(undefined), "zh-CN");
  assert.equal(normalizeUiLanguage("fr"), "zh-CN");
  assert.equal(normalizeUiLanguage("en"), "en");
  assert.equal(normalizeUiLanguage("ja"), "ja");
  assert.equal(DEFAULT_UI_LANGUAGE, "zh-CN");
});

test("every ui message key has identical complete tables in all three languages", () => {
  const keys = uiMessageKeys();
  assert.ok(keys.length >= 70, `ui key count ${keys.length}`);
  for (const key of keys) {
    const table = uiMessageTable(key);
    assert.ok(table, key);
    for (const language of UI_LANGUAGES) {
      const value: unknown = table[language];
      assert.equal(typeof value, "string", `${key}/${language}`);
      assert.ok((value as string).trim().length > 0, `${key}/${language} must not be empty`);
    }
  }
});

test("uiText interpolates, falls back for missing languages and never exposes keys", () => {
  assert.equal(uiText("ui.composer.submit", "en"), "Send");
  assert.equal(uiText("ui.composer.submit", "ja"), "送信");
  assert.equal(
    uiText("ui.inspector.castCount", "zh-CN", { count: "3" }),
    "3 人",
  );
  // 未知 key：告警并返回 key（开发期兜底；契约测试保证线上不发生）。
  assert.equal(uiText("ui.no.such.key", "en"), "ui.no.such.key");
});

test("world style templates cover 26 keys × 4 styles × 3 languages", () => {
  const keys = worldStyleTemplateKeys();
  assert.ok(keys.length >= 26);
  for (const key of keys) {
    for (const language of WORLD_STYLE_LANGUAGES) {
      const table = worldStyleTemplateTable(key, language);
      assert.ok(table, `${key}/${language}`);
      for (const style of WORLD_STYLE_KEYS) {
        const value = table[style];
        assert.ok(value && value.trim().length > 0, `${key}/${language}/${style}`);
      }
    }
  }
  // 语言维度抽查：风格保持、语言分流。
  assert.equal(
    worldStyleText("timeline.empty.title", "classical", undefined, "zh-CN"),
    "长卷初展，诸事未定",
  );
  assert.equal(
    worldStyleText("timeline.empty.title", "classical", undefined, "en"),
    "The long scroll unfurls; nothing is yet decided",
  );
  assert.equal(
    worldStyleText("timeline.empty.title", "classical", undefined, "ja"),
    "長巻初めて開く、諸事いまだ定まらず",
  );
});
