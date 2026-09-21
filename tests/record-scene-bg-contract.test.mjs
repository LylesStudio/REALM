/**
 * Record 场景氛围背景契约（record-scene-bg-contract）。
 *
 * 钉住：
 * A. 装饰层语义：realm-client 中 .record-scene-bg 为 .record-main 首个
 *    子节点、aria-hidden、不携带任何业务数据属性；
 * B. 层叠与交互：独立绝对层 + 前景遮罩（::before 图像 / ::after veil），
 *    pointer-events: none、不参与布局；内容经 record-main 直接子节点
 *    统一抬升（z-index: 1），不对 .record-main 整体设 opacity；
 * C. 过滤强度集中在 --record-scene-* token（独立 :root 块，不并入主题
 *    颜色矩阵）；夜间有更强遮罩覆盖且与浅色不同值；
 * D. 视觉语言：无圆角、无 backdrop-filter、不对 record-main 整体 opacity；
 * E. 资产：public/scenes/record-scene-v0.png 存在且为 PNG；
 *    CSS 只引用仓库内 public 路径（无 /tmp 或本机绝对路径）。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const exists = (path) =>
  existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url)));

const globalsCss = read("app/globals.css");
const realmClient = read("app/realm-client.tsx");

const sceneLayerBlock = globalsCss.slice(
  globalsCss.indexOf(".record-scene-bg {"),
  globalsCss.indexOf("/* 背景层之上的内容前景"),
);

test("A. 装饰层语义：首子节点、aria-hidden、无业务数据", () => {
  const mainOpen = realmClient.indexOf('<main className="record-main">');
  assert.ok(mainOpen !== -1, "record-main 必须存在");
  const layerAt = realmClient.indexOf('className="record-scene-bg"', mainOpen);
  const headingAt = realmClient.indexOf('className="record-heading"', mainOpen);
  assert.ok(layerAt !== -1, "场景背景层必须存在");
  assert.ok(layerAt < headingAt, "背景层必须是 record-main 的首个内容子节点");
  assert.match(
    realmClient.slice(layerAt - 40, layerAt + 80),
    /aria-hidden="true"/,
    "装饰层必须 aria-hidden",
  );
  // 层元素不携带任何业务数据（纯装饰；Stage 3 起 style 只承载
  // --record-scene-image 的 /api/files 相对 URL 覆盖，无事件/记录数据）。
  assert.match(
    realmClient.slice(layerAt - 40, layerAt + 320),
    /className="record-scene-bg"\s+aria-hidden="true"/,
  );
});

test("B. 层叠与交互：独立层 + 遮罩 + pointer-events 关闭 + 内容抬升", () => {
  assert.match(sceneLayerBlock, /\.record-scene-bg::before/);
  assert.match(sceneLayerBlock, /\.record-scene-bg::after/);
  assert.match(sceneLayerBlock, /pointer-events:\s*none/);
  assert.match(sceneLayerBlock, /position:\s*absolute/);
  assert.match(sceneLayerBlock, /z-index:\s*0/);
  // 前景遮罩跟随纸面变量（浅色/夜间自动同面）。
  assert.match(sceneLayerBlock, /color-mix\(in srgb, var\(--paper\) var\(--record-scene-veil-strength\)/);
  // 内容统一抬升到背景层之上。
  assert.match(globalsCss, /\.record-main > :not\(\.record-scene-bg\) \{\s*position: relative;\s*z-index: 1;/s);
  // 背景层不参与布局：absolute + inset 0（不改高度/宽度流）。
  assert.match(sceneLayerBlock, /inset:\s*0/);
});

test("C. 过滤强度集中在 --record-scene-* token；夜间遮罩更强", () => {
  const tokenBlock = globalsCss.slice(
    globalsCss.indexOf("/*\n * Record 聊天主区场景氛围背景 token"),
    globalsCss.indexOf(".record-main {"),
  );
  for (const token of [
    "--record-scene-image",
    "--record-scene-opacity",
    "--record-scene-saturate",
    "--record-scene-contrast",
    "--record-scene-veil-strength",
  ]) {
    assert.ok(tokenBlock.includes(token), `缺 token: ${token}`);
  }
  assert.match(tokenBlock, /--record-scene-image:\s*url\("\/scenes\/record-scene-v0\.png"\)/);
  // ::before 真实消费三个过滤 token。
  assert.match(sceneLayerBlock, /opacity:\s*var\(--record-scene-opacity\)/);
  assert.match(
    sceneLayerBlock,
    /filter:\s*saturate\(var\(--record-scene-saturate\)\) contrast\(var\(--record-scene-contrast\)\)/,
  );
  // 夜间遮罩强度覆盖且与浅色不同值。
  const nightBlock = globalsCss.slice(
    globalsCss.indexOf(':root[data-theme="night"] {'),
    globalsCss.indexOf("/* 夜间滚动条与原生控件协调"),
  );
  const lightStrength = tokenBlock.match(/--record-scene-veil-strength:\s*(\d+)%/);
  const nightStrength = nightBlock.match(/--record-scene-veil-strength:\s*(\d+)%/);
  assert.ok(lightStrength && nightStrength, "浅色/夜间遮罩强度都必须定义");
  assert.ok(
    Number(nightStrength[1]) > Number(lightStrength[1]),
    "夜间遮罩必须强于浅色（保护文本对比度）",
  );
});

test("D. 视觉语言约束：无圆角/无玻璃模糊/无整体 opacity", () => {
  assert.ok(!/border-radius/.test(sceneLayerBlock), "背景层不得引入圆角");
  assert.ok(!/backdrop-filter/.test(sceneLayerBlock), "禁止玻璃拟态");
  // .record-main 规则本身不得设置 opacity（会连文字一起变淡）。
  const mainRule = globalsCss.slice(
    globalsCss.indexOf(".record-main {"),
    globalsCss.indexOf(".record-scene-bg {"),
  );
  assert.ok(!/opacity/.test(mainRule), "record-main 不得整体设 opacity");
});

test("E. 资产：仓库内 public 路径、PNG 真实存在、无本机绝对路径", () => {
  assert.ok(exists("public/scenes/record-scene-v0.png"), "场景样例图必须入库");
  const bytes = readFileSync(
    fileURLToPath(new URL("../public/scenes/record-scene-v0.png", import.meta.url)),
  );
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "资产必须是真实 PNG",
  );
  assert.ok(!/\/tmp\/|\/home\/|C:\\/.test(sceneLayerBlock), "CSS 不得引用本机绝对路径");
});

test("F. 古籍装裱边缘：token 集中、伪元素结构、主题安全色", () => {
  const tokenBlock = globalsCss.slice(
    globalsCss.indexOf("/*\n * Record 聊天主区场景氛围背景 token"),
    globalsCss.indexOf(".record-main {"),
  );
  for (const token of [
    "--record-scene-edge-strength",
    "--record-scene-edge-strength-soft",
    "--record-scene-plate-inset",
    "--record-scene-plate-strength",
  ]) {
    assert.ok(tokenBlock.includes(token), `缺装裱 token: ${token}`);
  }
  const nightBlock = globalsCss.slice(
    globalsCss.indexOf(':root[data-theme="night"] {'),
    globalsCss.indexOf("/* 夜间滚动条与原生控件协调"),
  );
  // 夜间边缘做旧必须更强（深色面上保持可感知）且与浅色不同值。
  const lightEdge = tokenBlock.match(/--record-scene-edge-strength:\s*(\d+)%/);
  const nightEdge = nightBlock.match(/--record-scene-edge-strength:\s*(\d+)%/);
  assert.ok(lightEdge && nightEdge, "浅色/夜间边缘强度都必须定义");
  assert.ok(Number(nightEdge[1]) > Number(lightEdge[1]), "夜间边缘强度必须大于浅色");
  assert.ok(nightBlock.includes("--record-scene-plate-strength"), "夜间必须覆盖版心框线强度");

  // 结构：纸边做旧 = ::after 上偏心径向渐变（至少两组，制造轻微不规则），
  // 版心框线 = 负 offset outline；做旧色向 paper-deep、框线色向 line-dark
  // （两主题都朝“更暗的纸”收敛）。
  const afterBlock = sceneLayerBlock.slice(sceneLayerBlock.indexOf(".record-scene-bg::after"));
  const radialCount = (afterBlock.match(/radial-gradient/g) ?? []).length;
  assert.ok(radialCount >= 2, "纸边做旧至少需要两组偏心径向渐变");
  assert.match(afterBlock, /at 46% 38%/);
  assert.match(afterBlock, /at 57% 66%/);
  assert.match(afterBlock, /color-mix\(in srgb, var\(--paper-deep\) var\(--record-scene-edge-strength\)/);
  assert.match(afterBlock, /outline:\s*1px solid color-mix\(in srgb, var\(--line-dark\) var\(--record-scene-plate-strength\)/);
  assert.match(afterBlock, /outline-offset:\s*calc\(-1 \* var\(--record-scene-plate-inset\)\)/);
  // 原有均匀遮罩必须保留（文字区对比度不变）。
  assert.match(afterBlock, /linear-gradient\([\s\S]*var\(--record-scene-veil-strength\)/);
  // 禁令复核：装裱不得引入圆角/玻璃模糊/撕纸贴图。
  assert.ok(!/border-radius|backdrop-filter/.test(afterBlock));
  assert.ok(!/mask-image|clip-path: polygon/.test(afterBlock), "禁止撕纸式 mask/裁切");
});
