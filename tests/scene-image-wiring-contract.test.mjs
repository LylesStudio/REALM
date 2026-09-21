/**
 * 场景图接缝静态围栏（scene-image-wiring-contract）。
 *
 * 钉住：
 * A. route 走 session 门禁 + server-only service，不 import 客户端组件；
 * B. client bundle（app/components/** 与 app/realm-client.tsx）不得 import
 *    modules/imagine 或 scene-image-service（server-only 模块不泄入前端）；
 * C. 业务代码不硬编码 graph node id：service 内禁止出现裸 graph 坐标字面量
 *    （bindings 只能来自 manifest）；
 * D. route/service 不回显内部错误原文；composer 常量与 graph smoke 占位
 *    一致（基底/负面串未漂移）；
 * E. manifest smoke 记录与 graph 占位一致（I2I 输入图为相对占位名）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { uiMessageTable } from "../modules/i18n/public.ts";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const route = read("app/api/record/scene-image/route.ts");
const service = read("modules/application/scene-image-service.ts");
const composer = read("modules/imagine/scene-prompt.ts");
const realmClient = read("app/realm-client.tsx");
const graph = JSON.parse(read("workflows/realm/anima-scene-t2i-v0.api.json"));
const manifest = JSON.parse(read("workflows/realm/anima-scene-v0.manifest.json"));

test("A. route：session 门禁 + server-only service + 503/404 边界", () => {
  assert.match(route, /resolveRequestPrincipal\(request, LOCAL_RECORD_SCOPE\.principalId\)/);
  assert.match(route, /unauthorizedResponse\(\)/);
  assert.match(route, /REALM_RUNTIME_DATABASE_URL/);
  assert.match(route, /createSceneImageService\(\{/);
  assert.match(route, /createPostgresRecordRuntimeScopeRepository/);
  assert.match(route, /dispatched/);
  // 不 import 任何客户端组件/前端模块。
  assert.doesNotMatch(route, /from ".*components/);
});

test("B. client bundle 不得 import server-only imagine/scene-image 模块", () => {
  assert.doesNotMatch(realmClient, /modules\/imagine|scene-image-service|workflows\/realm/);
  // 全部组件目录同样约束。
  const dir = fileURLToPath(new URL("../app/components", import.meta.url));
  for (const file of readdirSync(dir)) {
    if (!/\.(tsx?|ts)$/.test(file)) continue;
    const source = read(`app/components/${file}`);
    assert.doesNotMatch(
      source,
      /modules\/imagine|scene-image-service|workflows\/realm/,
      `app/components/${file} 不得 import server-only 图像模块`,
    );
  }
});

test("C. service 不硬编码 graph node id（binding 只来自 manifest）", () => {
  // node id 坐标形态：inputs 后随数字字符串键——service 内不得出现。
  assert.doesNotMatch(service, /inputs\[["']\d+["']\]/);
  assert.doesNotMatch(service, /graph\[["']\d+["']\]/);
  // service 只经 manifest/patcher 反读。
  assert.match(service, /readPatchedValue\(manifest, "t2i"/);
  assert.match(service, /patchWorkflowGraph\(\{/);
});

test("D. 内部错误不回显；composer 常量与 graph smoke 占位一致", () => {
  assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
  assert.doesNotMatch(service, /error\.message/);
  // composer 的固定基底/负面串必须与 graph 当前 smoke 占位前缀一致（未漂移）。
  const positiveNode = manifest.workflows.t2i.bindings.positivePrompt.node;
  const positiveInput = manifest.workflows.t2i.bindings.positivePrompt.input;
  const graphPositive = graph[positiveNode].inputs[positiveInput];
  const negativeNode = manifest.workflows.t2i.bindings.negativePrompt.node;
  const negativeInput = manifest.workflows.t2i.bindings.negativePrompt.input;
  const graphNegative = graph[negativeNode].inputs[negativeInput];
  const baseMatch = composer.match(/SCENE_IMAGE_BASE_PREFIX =\s*\n?\s*"([^"]+)"/);
  const negativeMatch = composer.match(/SCENE_IMAGE_NEGATIVE_PROMPT =\s*\n?\s*"([^"]+)"/);
  assert.ok(baseMatch && negativeMatch);
  assert.ok(
    graphPositive.startsWith(baseMatch[1]),
    "composer 基底必须是 graph 占位 prompt 的前缀（未漂移）",
  );
  assert.equal(graphNegative, negativeMatch[1], "负面串与 graph 占位一致");
});

test("E. manifest smoke 记录与 I2I graph 占位一致", () => {
  const i2i = manifest.workflows.i2i;
  const i2iGraph = JSON.parse(read(`workflows/realm/${i2i.graphFile}`));
  const binding = i2i.bindings.inputImage;
  assert.equal(binding.runtimeOverride, true);
  assert.equal(manifest.smokeInput.node, binding.node);
  assert.equal(i2iGraph[binding.node].class_type, "LoadImage");
  assert.ok(!/C:\\|\/home\/|\/tmp\/|\//.test(i2iGraph[binding.node].inputs[binding.input]));
});

test("F. dispatch seam：显式 dispatch 才走 provider，disabled fail-closed", () => {
  // route：dispatch 只从 body 布尔读取；默认 prepare-only，显式 dispatch 走落库闭环。
  assert.match(route, /dispatch = body\.dispatch === true/);
  assert.match(route, /dispatchAndStoreSceneImage\(/);
  assert.match(route, /prepareSceneImageWorkflow\(/);
  assert.match(route, /COMFYUI_DISABLED/);
  // service：dispatch 前必须读配置且 enabled 为 false 时拒绝。
  assert.match(service, /dispatchAndStoreSceneImage\(/);
  assert.match(service, /if \(!settings\.enabled\)/);
  assert.match(service, /queuePrompt\(prepared\.patchedGraph\)/);
  // active 生成复用：重复点击不新建 queue 请求，且 claim 在 provider queue 前受 DB 锁保护。
  assert.match(service, /claimOrCreateGeneration\(/);
  assert.match(service, /const resolved = await resolveScope\(scope\)/);
  // 客户端永不含 dispatch 默认开启的诱导：dispatch 缺省 false。
  assert.doesNotMatch(route, /dispatch = true\b/);
});

test("G. ComfyUI 设置 route/store/UI 卡边界", () => {
  const settingsRoute = read("app/api/settings/comfyui/route.ts");
  assert.match(settingsRoute, /resolveRequestPrincipal\(request, "principal_demo_player"\)/);
  assert.match(settingsRoute, /createComfyUiSettingsStore\(\)/);
  assert.match(settingsRoute, /action !== "test"/);
  const store = read("modules/imagine/comfyui-settings.ts");
  // 0600 原子写 + public snapshot 不含 apiKey。
  assert.match(store, /0o600/);
  const publicFn = store.slice(
    store.indexOf("export function publicComfyUiSettings"),
    store.indexOf("export interface ComfyUiSettingsStore"),
  );
  assert.ok(!/apiKey:\s/.test(publicFn), "public snapshot 不得带 apiKey 字段");
  // 默认 baseUrl 只在 server-only 模块；client bundle 不得出现主机地址。
  assert.doesNotMatch(realmClient, /192\.168\.\d+\.\d+|comfyui-settings|comfyui-client/);
  const settingsUi = read("app/settings/settings-client.tsx");
  assert.match(settingsUi, /data-testid="comfyui-card"/);
  assert.match(settingsUi, /role="status"/);
  assert.doesNotMatch(settingsUi, /192\.168\.\d+\.\d+/, "WebUI 不得硬编码 ComfyUI 主机地址");
  assert.doesNotMatch(settingsUi, /comfyui-settings|comfyui-client/, "WebUI 不得 import server-only 模块");
  // i18n 三语齐备。
  for (const key of [
    "ui.comfyui.cardTitle", "ui.comfyui.fieldEnabled", "ui.comfyui.testAction",
    "ui.comfyui.saveAction", "ui.comfyui.testOk", "ui.comfyui.saveOk",
    "ui.comfyui.errLoad", "ui.comfyui.errTest", "ui.comfyui.errSave",
  ]) {
    const table = uiMessageTable(key);
    assert.ok(table, `missing i18n key: ${key}`);
    for (const language of ["zh-CN", "en", "ja"]) {
      assert.ok(table[language]?.trim(), `${key} 缺 ${language}`);
    }
  }
});
