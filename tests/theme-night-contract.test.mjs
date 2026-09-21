/**
 * 夜间主题契约（theme-night-contract）。
 *
 * 钉住：
 * A. 主题状态模型：normalizeTheme/readStoredTheme/applyTheme 纯语义、
 *    稳定 storage key、SSR 安全（模块顶层不碰 window）；
 * B. 首帧初始化：layout 内联脚本与 applyTheme 语义一致（night 才写
 *    data-theme + color-scheme），且在 body 渲染前；
 * C. 切换入口：header 与设置页复用同一 ThemeToggle；aria-pressed/
 *    i18n label/无 reload/无 API 请求；
 * D. 覆盖完整性：globals.css 无裸露硬编码色（:root 与 var() fallback
 *    之外）；night 覆盖块为 :root 的每个颜色变量给出值；light 默认值
 *    不被 night 块改写；语义 event 色两主题成对存在；
 * E. 视觉约束：无圆角/无浏览器默认外观依赖/尊重 reduced-motion。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { uiMessageTable } from "../modules/i18n/public.ts";
import {
  applyTheme,
  currentTheme,
  normalizeTheme,
  readStoredTheme,
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
} from "../app/theme.ts";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const globalsCss = read("app/globals.css");
const layout = read("app/layout.tsx");
const realmClient = read("app/realm-client.tsx");
const settingsClient = read("app/settings/settings-client.tsx");
const toggle = read("app/components/theme-toggle.tsx");

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `${startMarker} must exist`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end !== -1, `${endMarker} must exist after ${startMarker}`);
  return source.slice(start, end);
}

const rootBlock = extractBlock(globalsCss, ":root {", "/* ---- 深夜纸墨");
const nightBlock = extractBlock(
  globalsCss,
  ':root[data-theme="night"] {',
  "/* 夜间滚动条与原生控件协调",
);

function varsOf(block) {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]);
}

test("A. 主题状态模型：normalize/read/apply 语义与 SSR 安全", () => {
  assert.equal(normalizeTheme("night"), "night");
  assert.equal(normalizeTheme("light"), "light");
  assert.equal(normalizeTheme(undefined), "light");
  assert.equal(normalizeTheme("dark"), "light", "非法值回落浅色");
  assert.equal(readStoredTheme(null), "light");
  assert.equal(
    readStoredTheme({ getItem: (key) => (key === THEME_STORAGE_KEY ? "night" : null) }),
    "night",
  );
  assert.equal(
    readStoredTheme({
      getItem: () => {
        throw new Error("denied");
      },
    }),
    "light",
    "存储异常 fail-closed 到浅色",
  );
  // applyTheme：data-theme 与 color-scheme 同步。
  const fakeRoot = { dataset: {}, style: {} };
  applyTheme("night", fakeRoot);
  assert.equal(fakeRoot.dataset.theme, "night");
  assert.equal(fakeRoot.style.colorScheme, "dark");
  applyTheme("light", fakeRoot);
  assert.equal(fakeRoot.dataset.theme, "light");
  assert.equal(fakeRoot.style.colorScheme, "light");
  assert.equal(currentTheme(fakeRoot), "light");
  assert.equal(currentTheme(undefined), "light", "SSR 无 root 时恒 light");
  assert.equal(THEME_STORAGE_KEY, "realm.theme", "storage key 稳定");
  // 模块顶层不得直接引用 window/localStorage（SSR 安全）——只允许在
  // 函数体/脚本字符串中出现。
  const themeSource = read("app/theme.ts");
  const topLevel = themeSource.split("\n").filter(
    (line) => line.startsWith("export const") && !line.includes("THEME_INIT_SCRIPT"),
  );
  for (const line of topLevel) {
    assert.ok(!line.includes("window") && !line.includes("localStorage"), line);
  }
});

test("B. 首帧初始化脚本与 applyTheme 语义一致且在 body 前", () => {
  assert.match(THEME_INIT_SCRIPT, new RegExp(THEME_STORAGE_KEY));
  assert.match(THEME_INIT_SCRIPT, /dataset\.theme="night"/);
  assert.match(THEME_INIT_SCRIPT, /colorScheme="dark"/);
  // light 依赖缺省（脚本只在 night 写入），不反向写 light。
  assert.ok(!THEME_INIT_SCRIPT.includes('dataset.theme="light"'));
  // layout：脚本在 <head> 且经 THEME_INIT_SCRIPT 注入（SSR 不执行）。
  assert.match(layout, /<head>/);
  assert.match(layout, /THEME_INIT_SCRIPT/);
  assert.match(layout, /<html lang="zh-CN" suppressHydrationWarning>/);
  assert.ok(
    layout.indexOf("THEME_INIT_SCRIPT") < layout.indexOf("<body>"),
    "init script must run before body",
  );
});

test("C. 切换入口：header/设置页同一组件；aria/i18n/无副作用", () => {
  assert.match(realmClient, /<ThemeToggle uiLanguage=\{uiLanguage\} \/>/);
  assert.match(settingsClient, /<ThemeToggle uiLanguage=\{uiLanguage\} className="settings-back" \/>/);
  assert.match(toggle, /aria-pressed=\{night\}/);
  assert.match(toggle, /data-testid="theme-toggle"/);
  assert.match(toggle, /applyTheme\(next, document\.documentElement\)/);
  assert.match(toggle, /localStorage\.setItem\(THEME_STORAGE_KEY, next\)/);
  // 切换不得触发导航/请求。
  assert.ok(!/location\.reload|router\.refresh|fetch\(/.test(toggle));
  for (const key of ["ui.theme.toNight", "ui.theme.toLight", "ui.theme.toggleAria"]) {
    const table = uiMessageTable(key);
    assert.ok(table, `missing key: ${key}`);
    for (const language of ["zh-CN", "en", "ja"]) {
      assert.ok(table[language]?.trim(), `${key} 缺 ${language}`);
    }
  }
});

test("D. 覆盖完整性：无裸露硬编码色；night 覆盖全部颜色变量", () => {
  // :root 与 var() fallback 之外不得再有直接 hex 颜色。
  const lines = globalsCss.split("\n");
  for (const [index, line] of lines.entries()) {
    if (/^\s*--[a-z0-9-]+\s*:/.test(line)) continue; // 变量定义
    if (/var\(--/.test(line)) continue; // var()/fallback 使用
    assert.ok(
      !/#[0-9a-fA-F]{3,8}\b/.test(line),
      `globals.css:${index + 1} 裸露硬编码色: ${line.trim()}`,
    );
  }
  // night 块为 :root 的每个颜色变量提供覆盖（字体变量除外）。
  const rootColorVars = varsOf(rootBlock).filter((name) => !name.startsWith("--font-"));
  const nightVars = new Set(varsOf(nightBlock));
  for (const name of rootColorVars) {
    assert.ok(nightVars.has(name), `night 未覆盖: ${name}`);
  }
  // light 默认值不被 night 块改写（每个值必须与 :root 不同）。
  const rootValues = Object.fromEntries(
    [...rootBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
  for (const match of nightBlock.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    assert.notEqual(
      match[2].trim(),
      rootValues[match[1]],
      `${match[1]} 在夜间与浅色同值（疑似复制未改）`,
    );
  }
  // 语义 event 色两主题成对。
  for (const name of [
    "--semantic-environment",
    "--semantic-story",
    "--semantic-fact",
    "--semantic-action",
    "--semantic-dialogue",
  ]) {
    assert.ok(rootVars().has(name), `light 缺 ${name}`);
    assert.ok(nightVars.has(name), `night 缺 ${name}`);
  }
  function rootVars() {
    return new Set(varsOf(rootBlock));
  }
  // color-scheme 双主题显式声明。
  assert.match(rootBlock, /color-scheme: light;/);
  assert.match(nightBlock, /color-scheme: dark;/);
  // 内容表面与表单控件必须走独立的成对 token；禁止回退到浅色 --white
  // 作为夜间输入/卡片背景，否则会出现浅底叠浅字。
  for (const name of [
    "--surface",
    "--field-bg",
    "--field-text",
    "--field-placeholder",
    "--field-disabled-bg",
    "--field-disabled-text",
    "--field-option-bg",
    "--field-option-text",
  ]) {
    assert.ok(rootVars().has(name), `light 缺 ${name}`);
    assert.ok(nightVars.has(name), `night 缺 ${name}`);
  }
  assert.match(globalsCss, /input:not\(\[type="radio"\]\):not\(\[type="checkbox"\]\):not\(\[type="file"\]\)/);
  assert.match(globalsCss, /textarea::placeholder/);
  assert.doesNotMatch(globalsCss, /background: var\(--white\);/, "内容表面不得继续使用白色专用 token");
});

test("E. 视觉约束：无圆角新引入；过渡尊重 reduced-motion", () => {
  assert.ok(!/border-radius/.test(nightBlock), "night 块不得引入圆角");
  const transitionStart = globalsCss.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(transitionStart !== -1, "reduced-motion 媒体块必须存在");
  const transition = globalsCss.slice(transitionStart, transitionStart + 600);
  assert.match(transition, /transition: background-color 120ms/);
  assert.ok(!/animation|@keyframes/.test(transition), "主题过渡不得引入动画背景");
});
