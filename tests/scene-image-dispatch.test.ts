/**
 * scene-image dispatch seam 测试：真实 service 路径（in-memory scope repo +
 * tmp 文件 store + 注入 client），覆盖 disabled fail-closed、enabled 成功
 * dispatch 返回 promptId、prepare 语义不受影响。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RecordRuntimeScope } from "../database/postgres/public.ts";
import { createSceneImageService } from "../modules/application/scene-image-service.ts";
import {
  createComfyUiSettingsStore,
  loadSceneWorkflowManifest,
  readPatchedValue,
  SceneWorkflowError,
} from "../modules/imagine/public.ts";

const SCOPE_FIXTURE: RecordRuntimeScope = {
  workspaceId: "ws_test",
  principalId: "principal_test",
  worldId: "world_test",
  worldlineId: "worldline_test",
  storyId: "story_test",
  recordId: "record_test",
  sceneId: "scene_test",
  publicPolicyId: "policy_test",
  calendarId: "cal_test",
  displayTime: "纪元 17 年",
  style: "modern",
  worldStatus: "active",
  brief: {
    worldName: "WORLD_DISPATCH_XQ",
    era: "",
    summary: "",
    storyTitle: "",
    premise: "",
    location: "LOCATION_DISPATCH_TD",
    weather: "",
    tension: "",
    objective: "",
    canon: "",
    worldLore: "",
  },
  playerActor: {
    characterInstanceId: "ci",
    participantId: "pi",
    displayName: "旅人",
    profileSummary: "",
  },
  aiCharacters: [],
  observerCharacterInstanceIds: [],
  recentPublicEvents: [],
  recentPublicDialogue: [],
  recordKnowledge: [],
};

const SCOPE = { workspaceId: "ws_test", principalId: "principal_test", recordId: "record_test" };

function scopeRepository() {
  return { async resolve() { return SCOPE_FIXTURE; } };
}

async function tmpStore() {
  const dir = await mkdtemp(join(tmpdir(), "realm-dispatch-test-"));
  return {
    dir,
    store: createComfyUiSettingsStore({ filePath: join(dir, "comfyui.json") }),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("dispatch: 未启用配置 fail-closed COMFYUI_DISABLED，不发请求", async () => {
  const { store, cleanup } = await tmpStore();
  try {
    let clientCalls = 0;
    const service = createSceneImageService({
      scopeRepository: scopeRepository(),
      comfyUiStore: store,
      createComfyUiClient: () => ({
        async systemStats() { clientCalls += 1; return { latencyMs: 1 }; },
        async queuePrompt() { clientCalls += 1; return { promptId: "x" }; },
        async history() { return { status: "pending" as const }; },
        async viewImage() {
          throw new Error("not used in disabled path");
        },
      }),
    });
    await assert.rejects(
      service.dispatchSceneImage(SCOPE),
      (error: unknown) => {
        assert.ok(error instanceof SceneWorkflowError);
        assert.equal(error.code, "COMFYUI_DISABLED");
        return true;
      },
    );
    assert.equal(clientCalls, 0, "disabled 时不得发起 provider 请求");
  } finally {
    await cleanup();
  }
});

test("dispatch: 启用后真实走 prepare→patch→queuePrompt，返回 promptId", async () => {
  const { store, cleanup } = await tmpStore();
  try {
    await store.save({ enabled: true, baseUrl: "http://192.168.1.20:8000", requestTimeoutMs: 30_000 });
    const queued: unknown[] = [];
    const service = createSceneImageService({
      scopeRepository: scopeRepository(),
      comfyUiStore: store,
      createComfyUiClient: (settings) => {
        assert.equal(settings.baseUrl, "http://192.168.1.20:8000", "client 必须拿到持久化配置");
        return {
          async systemStats() { return { latencyMs: 1 }; },
          async queuePrompt(graph) {
            queued.push(graph);
            return { promptId: "pid-dispatch-fixture" };
          },
          async history() { return { status: "pending" as const }; },
          async viewImage() {
            throw new Error("not used in dispatch-only path");
          },
        };
      },
    });
    const result = await service.dispatchSceneImage(SCOPE);
    assert.equal(result.dispatched, true);
    assert.equal(result.promptId, "pid-dispatch-fixture");
    assert.equal(result.visualStyle, "modern");
    assert.equal(queued.length, 1);
    // 队列里的 graph 就是 manifest patched graph（真实数据已进入）。
    const manifest = loadSceneWorkflowManifest();
    const queuedGraph = queued[0] as Parameters<typeof readPatchedValue>[2];
    const positive = String(readPatchedValue(manifest, "t2i", queuedGraph, "positivePrompt"));
    assert.ok(positive.includes("WORLD_DISPATCH_XQ"));
    assert.ok(positive.includes("LOCATION_DISPATCH_TD"));
    assert.ok(positive.includes("visual style:"), "视觉 profile 必须进入 dispatch prompt");
  } finally {
    await cleanup();
  }
});

test("dispatch: 缺 store 的服务 fail-closed；prepare 语义不受影响", async () => {
  const service = createSceneImageService({ scopeRepository: scopeRepository() });
  await assert.rejects(service.dispatchSceneImage(SCOPE), (error: unknown) => {
    assert.ok(error instanceof SceneWorkflowError && error.code === "COMFYUI_DISABLED");
    return true;
  });
  const prepared = await service.prepareSceneImageWorkflow(SCOPE);
  assert.equal(prepared.dispatched, false);
  assert.ok(prepared.positivePrompt.includes("WORLD_DISPATCH_XQ"));
});
