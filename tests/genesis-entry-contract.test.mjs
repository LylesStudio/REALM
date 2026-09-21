/**
 * 创世入口统一契约（genesis-entry-contract）。
 *
 * 钉住：
 * 1. 首次 onboarding 与已有 session 的世界库共用同一「AI 助手对话（主）/
 *    分步引导（次）」入口与同一 GuidedGenesisChat / GuidedGenesis 组件；
 * 2. 共享 creation overlay 状态模型：openCreation（library 来源先收世界库）、
 *    closeCreation（回到来源上下文）、chat→guided fallback 保留 source、
 *    创建成功统一关闭并打开新 record；
 * 3. 旧的单轮「灵感 → 单轮 draft → 手稿编辑」路径已移除（UI/props/state/
 *    i18n/CSS 无残留死代码），ManualCreateForm 管理能力保留。
 * 纯静态/纯函数断言，不起服务、不碰数据库。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { uiMessageTable } from "../modules/i18n/public.ts";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const realmClient = read("app/realm-client.tsx");
const libraryPanel = read("app/components/library-panel.tsx");
const onboarding = read("app/components/world-onboarding.tsx");
const globalsCss = read("app/globals.css");

/** 截取函数体（从签名到下一个同级函数/方法）。 */
function fnBody(source, signature, nextSignatures) {
  const start = source.indexOf(signature);
  assert.ok(start !== -1, `${signature} must exist`);
  const ends = nextSignatures
    .map((next) => source.indexOf(next, start + signature.length))
    .filter((index) => index !== -1);
  const end = ends.length > 0 ? Math.min(...ends) : source.length;
  return source.slice(start, end);
}

test("1. 两种来源共用同一入口组件与共享 overlay 渲染", () => {
  // onboarding 与世界库都经由 openCreation 打开 chat/guided。
  assert.match(realmClient, /openCreation\("chat", "onboarding"\)/);
  assert.match(realmClient, /openCreation\("guided", "onboarding"\)/);
  assert.match(realmClient, /openCreation\("chat", "library"\)/);
  assert.match(realmClient, /openCreation\("guided", "library"\)/);
  // 共享渲染函数被两个返回分支使用（onboarding 分支 + 主 session 分支）。
  const renderCalls = realmClient.match(/\{renderCreationOverlay\(\)\}/g) ?? [];
  assert.equal(renderCalls.length, 2, "renderCreationOverlay 必须在两个分支各调用一次");
  const render = fnBody(realmClient, "function renderCreationOverlay", [
    "async function",
    "function ",
    "if (loadState",
  ]);
  assert.match(render, /<GuidedGenesisChat/);
  assert.match(render, /<GuidedGenesis[\s>]/);
  // 两套布尔状态已收口为单一状态模型。
  assert.ok(!/setChatOpen|setGuidedOpen/.test(realmClient), "旧的 chatOpen/guidedOpen 不得残留");
  assert.match(realmClient, /const \[creationOverlay, setCreationOverlay\]/);
  // onboarding 组件与世界库组件的 props 名称一致（同一入口语义）。
  assert.match(onboarding, /onOpenChat: \(\) => void/);
  assert.match(onboarding, /onOpenGuided: \(\) => void/);
  assert.match(libraryPanel, /onOpenChat: \(\) => void/);
  assert.match(libraryPanel, /onOpenGuided: \(\) => void/);
});

test("2. 来源返回语义：library 来源收/回世界库；fallback 保留 source；成功统一关闭", () => {
  const open = fnBody(realmClient, "function openCreation", ["function closeCreation"]);
  assert.match(open, /if \(source === "library"\) setLibraryOpen\(false\)/);
  const close = fnBody(realmClient, "function closeCreation", ["async function confirmCreation"]);
  assert.match(close, /setCreationOverlay\(null\)/);
  assert.match(close, /if \(source === "library"\) openLibrary\(\)/);
  const confirm = fnBody(realmClient, "async function confirmCreation", [
    "function renderCreationOverlay",
  ]);
  // 创建成功：复用既有 confirmWorldGenesis（/api/world/generate 语义不变），
  // 关闭 overlay；新 record 由组件 onOpenRecord 打开。
  assert.match(confirm, /confirmWorldGenesis\(draft\)/);
  assert.match(confirm, /if \(recordId\) setCreationOverlay\(null\)/);
  // chat → guided fallback 保留来源，不产生第二套 overlay 状态。
  assert.match(
    realmClient,
    /onFallback=\{\(\) =>\s*setCreationOverlay\(\{ kind: "guided", source: creationOverlay\.source \}\)\}/,
  );
});

test("3. 旧单轮 genesis 路径与死代码已移除；管理能力保留", () => {
  for (const dead of [
    "genesisPrompt",
    "onGenesisDraft",
    "onGenesisConfirm",
    "genesis-section",
    "genesis-manuscript",
    "updateManuscript",
    "manuscriptSource",
  ]) {
    assert.ok(!libraryPanel.includes(dead), `library-panel 残留: ${dead}`);
    assert.ok(!realmClient.includes(dead), `realm-client 残留: ${dead}`);
  }
  // realm-client 不再持有单轮 draft 生成器。
  assert.ok(!/async function generateWorldDraft/.test(realmClient));
  // ManualCreateForm（故事/记录/角色）保留。
  assert.match(libraryPanel, /function ManualCreateForm/);
  assert.match(libraryPanel, /<ManualCreateForm/);
  // i18n：新入口 key 三语完整；旧 key 已注销。
  for (const key of ["ui.library.chatEntry", "ui.library.chatHint"]) {
    const table = uiMessageTable(key);
    assert.ok(table, `missing key: ${key}`);
    for (const language of ["zh-CN", "en", "ja"]) {
      assert.ok(table[language]?.trim(), `${key} 缺 ${language}`);
    }
  }
  for (const removed of [
    "ui.library.genesisEyebrow",
    "ui.library.genesisHint",
    "ui.library.genesisPlaceholder",
    "ui.library.genesisDraft",
    "ui.library.genesisDrafting",
    "ui.library.manuscript",
    "ui.library.confirm",
    "ui.library.confirming",
    "ui.library.redraft",
  ]) {
    assert.equal(uiMessageTable(removed), null, `i18n 死 key 残留: ${removed}`);
  }
  // CSS：旧区块已清除；chat/guided 共享样式仍在。
  for (const deadClass of [
    ".genesis-section",
    ".genesis-prompt",
    ".genesis-manuscript",
    ".genesis-confirm",
    ".genesis-stance",
  ]) {
    assert.ok(!globalsCss.includes(deadClass), `globals.css 残留: ${deadClass}`);
  }
  assert.ok(globalsCss.includes(".guided-entry"), "共享入口样式必须保留");
  // 入口按钮 accessible name 走 i18n（非硬编码）。
  assert.match(libraryPanel, /uiText\("ui\.library\.chatEntry", uiLanguage\)/);
  assert.match(libraryPanel, /uiText\("ui\.library\.guidedEntry", uiLanguage\)/);
});
