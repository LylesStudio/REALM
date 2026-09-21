/**
 * 本机/LAN ComfyUI 真实冒烟（一次性脚本，不入测试门，缺服务 fail-closed）。
 * 步骤：GET /system_stats（连接测试）→ 用 semantic manifest patch T2I graph
 * （smoke prompt + 固定 seed）→ POST /prompt（真实提交）→ GET /queue 回读。
 * 只证明 queue accepted + prompt_id；不轮询完成、不下载输出图。
 *
 * 用法：REALM_COMFYUI_BASE_URL=http://<host>:8000 node scripts/comfyui-local-smoke.mjs
 * （缺省读 modules/imagine/comfyui-settings.ts 的同一内置默认地址）
 */
import {
  composeScenePrompt,
  createComfyUiClient,
  createComfyUiSettingsStore,
  loadSceneWorkflowManifest,
  loadWorkflowGraph,
  patchWorkflowGraph,
} from "../modules/imagine/public.ts";

const store = createComfyUiSettingsStore();
const settings = await store.load();

// smoke 用固定的最小 scope（不依赖数据库；不代表生产动态数据路径）。
const prompt = composeScenePrompt({
  style: "modern",
  brief: {
    worldName: "Smoke Harbor",
    era: "",
    summary: "",
    storyTitle: "",
    premise: "",
    location: "a quiet lighthouse pier",
    weather: "gentle mist",
    tension: "",
    objective: "",
    canon: "",
    worldLore: "",
  },
  displayTime: "",
  recentPublicEvents: [],
});

const manifest = loadSceneWorkflowManifest();
const graph = loadWorkflowGraph(manifest.workflows.t2i.graphFile);
const patched = patchWorkflowGraph({
  manifest,
  workflow: "t2i",
  graph,
  inputs: {
    positivePrompt: prompt.positivePrompt,
    negativePrompt: prompt.negativePrompt,
    outputPrefix: "realm_comfyui_smoke",
  },
});

const client = createComfyUiClient({ ...settings, requestTimeoutMs: 30_000 });

try {
  const { latencyMs } = await client.systemStats();
  console.log(`[smoke] system_stats ok (${latencyMs}ms)`);
  const { promptId } = await client.queuePrompt(patched);
  console.log(`[smoke] /prompt accepted: prompt_id=${promptId}`);
  // queue 回读确认在队列/运行中（只读计数，不轮询完成）。
  const queue = await fetch(`${settings.baseUrl}/queue`);
  const body = await queue.json();
  const running = Array.isArray(body.queue_running) ? body.queue_running.length : "?";
  const pending = Array.isArray(body.queue_pending) ? body.queue_pending.length : "?";
  console.log(`[smoke] queue: running=${running} pending=${pending}（accepted ≠ 生成完成）`);
} catch (error) {
  // 安全类别输出，不 echo URL/凭据/body。
  const code = error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
  console.error(`[smoke] failed: ${code}`);
  process.exitCode = 1;
}
