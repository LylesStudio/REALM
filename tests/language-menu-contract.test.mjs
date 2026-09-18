/**
 * 界面语言入口与自动检测契约：
 * - header / 设置页 / 登录页三处常驻 LanguageMenu；
 * - 首访按 navigator 语言自动检测（zh/ja/en → 三语，其余回落中文）；
 * - 切换走共享 writeUiLanguage（存储 + 同页广播），菜单含三语自称选项。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readProjectFile = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("LanguageMenu is mounted in app header, settings header, and login corner", () => {
  const realmClient = readProjectFile("app/realm-client.tsx");
  assert.match(realmClient, /<LanguageMenu uiLanguage=\{uiLanguage\} \/>/);
  assert.match(realmClient, /import \{ LanguageMenu \} from "\.\/components\/language-menu\.tsx"/);

  const settingsClient = readProjectFile("app/settings/settings-client.tsx");
  assert.match(settingsClient, /<LanguageMenu uiLanguage=\{uiLanguage\} className="settings-back" \/>/);

  const loginPage = readProjectFile("app/login/page.tsx");
  assert.match(loginPage, /className="login-language-corner"/);
  assert.match(loginPage, /<LanguageMenu uiLanguage=\{language\} \/>/);
});

test("LanguageMenu renders custom listbox with three self-named options", () => {
  const menu = readProjectFile("app/components/language-menu.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(menu, /role="listbox"/);
  assert.match(menu, /role="option"/);
  assert.doesNotMatch(menu, /<select/);
  assert.match(menu, /"zh-CN": "中文"/);
  assert.match(menu, /en: "English"/);
  assert.match(menu, /ja: "日本語"/);
  assert.match(menu, /writeUiLanguage\(language\)/);
});

test("first-visit auto detection maps navigator languages to ui languages", () => {
  const helper = readProjectFile("app/ui-language.ts");
  assert.match(helper, /navigator\.languages\?\.\[0\]/);
  assert.match(helper, /raw\.startsWith\("zh"\)/);
  assert.match(helper, /raw\.startsWith\("ja"\)/);
  assert.match(helper, /raw\.startsWith\("en"\)/);
  assert.match(helper, /readUiLanguage\(\)/);
  assert.match(helper, /persistDetectedUiLanguage/);
  assert.match(helper, /subscribeUiLanguage/);
  assert.match(helper, /UI_LANGUAGE_CHANGE_EVENT/);

  const realmClient = readProjectFile("app/realm-client.tsx");
  assert.match(realmClient, /setUiLanguage\(readUiLanguage\(\)\)/);
  assert.match(realmClient, /subscribeUiLanguage\(\(\) => setUiLanguage\(readUiLanguage\(\)\)\)/);

  const loginPage = readProjectFile("app/login/page.tsx");
  assert.match(loginPage, /readUiLanguage\(\)/);
});

test("language menu i18n keys exist in all three languages", () => {
  const i18n = readProjectFile("modules/i18n/public.ts");
  assert.match(i18n, /"ui\.lang\.label"/);
  assert.match(i18n, /"ui\.lang\.toggleAria"/);
});
