/**
 * 场景图前端契约（record-scene-image-ui）：
 * A. envelope sceneImage normalize：合法形状透传；fileId/fileUrl 缺失、
 *    非 ready、外部/绝对 URL 一律 fail-closed null；recordEnvelopesEqual
 *    对 sceneImage 变化敏感（背景刷新不被吞）。
 * B. realm-client：显式按钮（observer 不可见）、dispatch:true 提交、
 *    CSS 变量覆盖只接受 /api/files 相对路径、无图不设覆盖。
 * C. i18n 三语齐备；状态条 role=status。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  normalizeRecordEnvelope,
  recordEnvelopesEqual,
} from "../app/components/record-types.ts";
import { uiMessageTable } from "../modules/i18n/public.ts";

const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const BASE_ENVELOPE = {
  record: {
    id: "record_x",
    version: 1,
    world: { id: "world_x", name: "世界X", era: "" },
    story: { id: "story_x", title: "故事X", status: "" },
    record: { id: "record_x", title: "记录X", location: "", worldTime: "", version: 1 },
    events: [],
    cast: [],
    scene: { location: "", worldTime: "", weather: "", tension: "", objective: "" },
    stories: [],
    records: [],
  },
  writeToken: "token-x",
  viewer: {
    cursor: "viewer-local",
    perspective: "omniscient",
    characterInstanceId: null,
    dynamicKnowledgeVisible: true,
    membershipRole: "owner",
  },
  affordances: [],
  suggestions: [],
};

test("A. sceneImage normalize：合法透传 + 非法 fail-closed + 等值比较敏感", () => {
  const withImage = normalizeRecordEnvelope({
    ...BASE_ENVELOPE,
    sceneImage: {
      fileId: "file_abc123",
      fileUrl: "/api/files/file_abc123",
      status: "ready",
    },
  });
  assert.deepEqual(withImage.sceneImage, {
    fileId: "file_abc123",
    fileUrl: "/api/files/file_abc123",
    status: "ready",
  });

  // fail-closed 矩阵：缺字段/非 ready/外部 URL/缺省/null。
  for (const bad of [
    { fileId: "file_abc123", fileUrl: "http://192.168.1.242:8000/view?filename=x.png", status: "ready" },
    { fileId: "file_abc123", fileUrl: "/api/files/file_abc123", status: "running" },
    { fileId: "", fileUrl: "/api/files/file_abc123", status: "ready" },
    null,
    undefined,
    "file_abc123",
  ]) {
    const envelope = normalizeRecordEnvelope({ ...BASE_ENVELOPE, sceneImage: bad });
    assert.equal(envelope.sceneImage, null, `非法形状必须 null：${JSON.stringify(bad)}`);
  }
  const withoutImage = normalizeRecordEnvelope(BASE_ENVELOPE);
  assert.equal(withoutImage.sceneImage, null, "旧数据（无字段）必须 null");

  // recordEnvelopesEqual 对 sceneImage 变化敏感（背景必须能被刷新）。
  assert.ok(!recordEnvelopesEqual(withImage, withoutImage));
  assert.ok(recordEnvelopesEqual(withImage, normalizeRecordEnvelope({
    ...BASE_ENVELOPE,
    sceneImage: { fileId: "file_abc123", fileUrl: "/api/files/file_abc123", status: "ready" },
  })));
});

test("B. realm-client：显式按钮 + dispatch 提交 + 安全 CSS 变量覆盖", () => {
  const client = read("app/realm-client.tsx");
  // 显式触发（不自动生成）；dispatch:true；recordId 来自当前投影。
  assert.match(client, /data-testid="scene-image-generate"/);
  assert.match(client, /dispatch: true/);
  assert.match(client, /envelope\.viewer\.membershipRole !== "observer"/);
  assert.match(client, /sceneImageBusy/);
  // 背景覆盖只经 CSS 变量 + 服务端相对路径；无图不设覆盖（undefined）。
  assert.match(client, /\["--record-scene-image" as string\]: `url\("\$\{envelope\.sceneImage\.fileUrl\}"\)`/);
  // 不得把远端地址/内部 id 渲染进 UI。
  assert.doesNotMatch(client, /192\.168\.\d+\.\d+|promptId.*sceneImage/);
  // 状态条 role=status。
  assert.match(client, /className="record-scene-status" role="status"/);
});

test("C. i18n 三语齐备", () => {
  for (const key of [
    "ui.recordScene.generate", "ui.recordScene.regenerate", "ui.recordScene.busy",
    "ui.recordScene.ready", "ui.recordScene.running", "ui.recordScene.failed",
    "ui.recordScene.job.queued", "ui.recordScene.job.running", "ui.recordScene.job.failed",
    "ui.recordScene.job.waitingWorker",
    "ui.sceneAuto.control", "ui.sceneAuto.mode.off", "ui.sceneAuto.mode.scene_change",
    "ui.sceneAuto.mode.every_turn", "ui.sceneAuto.note", "ui.sceneAuto.saved",
    "ui.sceneAuto.failed", "ui.sceneAuto.workerUnavailable",
  ]) {
    const table = uiMessageTable(key);
    assert.ok(table, `missing i18n key: ${key}`);
    for (const language of ["zh-CN", "en", "ja"] as const) {
      assert.ok(table[language]?.trim(), `${key} 缺 ${language}`);
    }
  }
});

test("D. sceneImageJob normalize：合法透传 + 非法 fail-closed + 等值敏感", () => {
  const withJob = normalizeRecordEnvelope({
    ...BASE_ENVELOPE,
    sceneImageJob: { status: "queued", triggerKind: "every_turn" },
  });
  assert.deepEqual(withJob.sceneImageJob, { status: "queued", triggerKind: "every_turn" });
  for (const bad of [
    { status: "running", triggerKind: "every_turn" },
    { status: "running", triggerKind: "scene_change" },
    { status: "failed", triggerKind: "scene_change" },
  ]) {
    const envelope = normalizeRecordEnvelope({ ...BASE_ENVELOPE, sceneImageJob: bad });
    assert.deepEqual(envelope.sceneImageJob, bad);
  }
  for (const bad of [
    { status: "pending", triggerKind: "every_turn" },
    { status: "ready", triggerKind: "wrong" },
    null,
    "queued",
    42,
  ]) {
    assert.equal(
      normalizeRecordEnvelope({ ...BASE_ENVELOPE, sceneImageJob: bad }).sceneImageJob,
      null,
      `非法形状必须 null：${JSON.stringify(bad)}`,
    );
  }
  const without = normalizeRecordEnvelope(BASE_ENVELOPE);
  assert.equal(without.sceneImageJob, null, "旧数据（无字段）必须 null");
  assert.ok(!recordEnvelopesEqual(withJob, without), "job 变化必须驱动信封更新");
});

test("E. 自动模式控制：显式按钮 + radiogroup + 立即持久化 + 无自动消耗", () => {
  const client = read("app/realm-client.tsx");
  assert.match(client, /data-testid="scene-auto-toggle"/);
  assert.match(client, /role="group"/);
  assert.match(client, /aria-pressed=\{sceneAutoMode === mode\}/);
  assert.match(client, /aria-haspopup="dialog"/);
  // 选择即 PUT 持久化（不经 localStorage）。
  assert.match(client, /fetch\("\/api\/settings\/scene-image", \{[\s\S]*?method: "PUT"/);
  assert.doesNotMatch(client, /localStorage.*scene/);
  // 挂载时只读 GET（不得自动 POST dispatch）。
  assert.match(client, /fetch\("\/api\/settings\/scene-image", \{[\s\S]*?headers/);
  // 默认 off。
  assert.match(client, /useState<"off" \| "scene_change" \| "every_turn">\("off"\)/);
  // job 状态徽标走安全 i18n，不透出 prompt_id/路径。
  assert.match(client, /data-testid="scene-image-job"/);
  assert.doesNotMatch(client, /promptId/);
});

test("F. worker 可用性投影：未连接 ≠ 排队中；心跳轮询与徽标分支", () => {
  const client = read("app/realm-client.tsx");
  // 挂载 GET 同时读 worker 心跳投影（online/unavailable）。
  assert.match(client, /worker\?\.state/);
  assert.match(client, /useState<"online" \| "unavailable" \| null>\(null\)/);
  // 自动模式开启或有自动任务时轻量轮询心跳。
  assert.match(client, /sceneWorkerWatchActive/);
  // Worker 未连接：明确徽标，而不是含混的「排队中」。
  assert.match(client, /data-testid="scene-worker-unavailable"/);
  assert.match(client, /ui\.sceneAuto\.workerUnavailable/);
  // queued 且 worker 不可用 → waitingWorker 文案；其余状态不变。
  assert.match(
    client,
    /status === "queued" && sceneWorkerState === "unavailable"[\s\S]*?job\.waitingWorker/,
  );
});

test("G. worker 心跳服务端投影：settings route 附带安全状态", () => {
  const route = read("app/api/settings/scene-image/route.ts");
  // GET 返回 worker 心跳投影（data-home 文件，无 DB 迁移）。
  assert.match(route, /readSceneImageWorkerStatus/);
  assert.match(route, /worker: readSceneImageWorkerStatus\(\)/);
  // 不透出 provider/prompt 内部信息。
  assert.doesNotMatch(route, /promptId|baseUrl/);
  const status = read("modules/application/scene-image-status.ts");
  // heartbeat 帧只有安全字段；写失败不杀 worker。
  assert.match(status, /state: "online" \| "stopping"/);
  assert.doesNotMatch(status, /promptId|baseUrl|connectionString/);
});
