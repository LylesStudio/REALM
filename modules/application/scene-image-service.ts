/**
 * 场景建立图 payload 准备 + 落库 seam（server-only application service）。
 * 生产调用路径：POST /api/record/scene-image → 本服务 →
 * createPostgresRecordRuntimeScopeRepository（与回合管线同一 scope 来源）
 * → composeScenePrompt → patchWorkflowGraph（manifest bindings）。
 *
 * 边界（docs/development/IMAGE-GENERATION-STORAGE-FRONTEND.md）：
 * - prepare：只准备可执行 payload（dispatched=false）；
 * - dispatchSceneImage：queue accepted 语义（dispatched=true + promptId）；
 * - dispatchAndStoreSceneImage：queue → 有界轮询 history → /view 下载校验 →
 *   world_files + 台账同事务 → ready；active 生成复用（重复点击不新建）；
 *   超时返回 running（不 fail，下次点击继续同一 prompt）。
 */
import type { RecordRuntimeScopeRepository } from "../../database/postgres/public.ts";
import type { RecordRuntimeScope } from "../../database/postgres/public.ts";
import type { SceneImageStore } from "../../database/postgres/scene-image-store.ts";
import { SceneImageFenceError, type SceneImageFence } from "../../database/postgres/scene-image-store.ts";
import type { SceneImageQueue } from "../../database/postgres/scene-image-queue.ts";
import {
  composeScenePrompt,
  ComfyUiError,
  createComfyUiClient,
  loadSceneWorkflowManifest,
  loadWorkflowGraph,
  patchWorkflowGraph,
  readPatchedValue,
  SceneWorkflowError,
  type ComfyUiClient,
  type ComfyUiSettings,
  type ComfyUiSettingsStore,
} from "../imagine/public.ts";
import { LocalRecordServiceError } from "./local-record-service.ts";

export interface SceneImageScope {
  workspaceId: string;
  principalId: string;
  recordId: string;
}

export interface PreparedSceneImageWorkflow {
  workflowId: string;
  runtime: string;
  seed: number;
  width: number;
  height: number;
  outputPrefix: string;
  positivePrompt: string;
  negativePrompt: string;
  /** 实际使用的图像视觉 profile key。 */
  visualStyle: string;
  includedBlocks: readonly string[];
  /** 经 manifest bindings 注入后的完整 API graph（可执行 payload）。 */
  patchedGraph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  /** prepare 边界：只准备 payload，尚未提交远端。 */
  dispatched: false;
}

export interface DispatchedSceneImage extends Omit<PreparedSceneImageWorkflow, "dispatched"> {
  dispatched: true;
  /** ComfyUI queue acceptance id（不代表图片已生成）。 */
  promptId: string;
}

export type SceneImageRunStatus = "ready" | "running" | "failed";

export interface SceneImageRunResult {
  status: SceneImageRunStatus;
  /** ready 时的台账生成 id（请求队列绑定证据）。 */
  generationId?: string;
  fileId?: string;
  fileUrl?: string;
  /** 失败时的安全分类码（provider 细节绝不外泄）。 */
  errorCode?: string;
}

/** 轮询预算（可注入测试）；超时只返回 running，不 fail（下次点击继续）。 */
const SCENE_IMAGE_MAX_WAIT_MS = 90_000;
const SCENE_IMAGE_POLL_INTERVAL_MS = 1_000;

export function createSceneImageService(options: {
  scopeRepository: RecordRuntimeScopeRepository;
  /** dispatch 所需：ComfyUI 配置存储与 client 工厂（测试注入 fake client）。 */
  comfyUiStore?: ComfyUiSettingsStore;
  createComfyUiClient?: (settings: ComfyUiSettings) => ComfyUiClient;
  /** 落库所需：生成台账 store（database/postgres/scene-image-store.ts）。 */
  sceneImageStore?: SceneImageStore;
  /** worker 模式必需：请求队列（fence 终态与 generation 同事务结算）。 */
  sceneImageQueue?: SceneImageQueue;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxWaitMs?: number;
  pollIntervalMs?: number;
}) {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxWaitMs = options.maxWaitMs ?? SCENE_IMAGE_MAX_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SCENE_IMAGE_POLL_INTERVAL_MS;

  async function resolveScope(scope: SceneImageScope) {
    const resolved = await options.scopeRepository.resolve(scope);
    if (!resolved) {
      throw new LocalRecordServiceError(
        "NOT_FOUND",
        "The requested record is not available for this player.",
      );
    }
    return resolved;
  }

  function prepareResolved(
    resolved: RecordRuntimeScope,
    overrides: { seed?: number },
  ): PreparedSceneImageWorkflow {
    const prompt = composeScenePrompt(resolved);
    const manifest = loadSceneWorkflowManifest();
    const graph = loadWorkflowGraph(manifest.workflows.t2i.graphFile);
    const patchedGraph = patchWorkflowGraph({
      manifest,
      workflow: "t2i",
      graph,
      inputs: {
        positivePrompt: prompt.positivePrompt,
        negativePrompt: prompt.negativePrompt,
        ...(overrides.seed !== undefined ? { seed: overrides.seed } : {}),
      },
    });
    // effective 值一律从 patched graph 经 manifest 反读（单一事实源）。
    return {
      workflowId: manifest.workflows.t2i.id,
      runtime: manifest.workflows.t2i.runtime,
      seed: Number(readPatchedValue(manifest, "t2i", patchedGraph, "seed")),
      width: Number(readPatchedValue(manifest, "t2i", patchedGraph, "width")),
      height: Number(readPatchedValue(manifest, "t2i", patchedGraph, "height")),
      outputPrefix: String(readPatchedValue(manifest, "t2i", patchedGraph, "outputPrefix")),
      positivePrompt: String(readPatchedValue(manifest, "t2i", patchedGraph, "positivePrompt")),
      negativePrompt: String(readPatchedValue(manifest, "t2i", patchedGraph, "negativePrompt")),
      visualStyle: prompt.visualStyle,
      includedBlocks: prompt.includedBlocks,
      patchedGraph,
      dispatched: false,
    };
  }

  async function enabledComfyUiClient(): Promise<ComfyUiClient> {
    if (!options.comfyUiStore) {
      throw new SceneWorkflowError("COMFYUI_DISABLED", "ComfyUI 未配置。");
    }
    const settings = await options.comfyUiStore.load();
    if (!settings.enabled) {
      throw new SceneWorkflowError("COMFYUI_DISABLED", "图像生成未在设置中启用。");
    }
    return (options.createComfyUiClient ?? createComfyUiClient)(settings);
  }

  /** fence 存在时走原子 settle（generation failed + request failed 同事务）。 */
  async function settleGenerationFailed(
    workspaceId: string,
    generationId: string,
    errorCode: string,
    fence?: SceneImageFence,
  ): Promise<void> {
    const store = options.sceneImageStore!;
    if (fence) {
      await store.failGenerationAndSettle({ workspaceId, id: generationId }, errorCode, fence);
    } else {
      await store.failGeneration({ workspaceId, id: generationId }, errorCode);
    }
  }

  return {
    async prepareSceneImageWorkflow(
      scope: SceneImageScope,
      overrides: { seed?: number } = {},
    ): Promise<PreparedSceneImageWorkflow> {
      return prepareResolved(await resolveScope(scope), overrides);
    },

    /**
     * 显式 dispatch：prepare → 读 ComfyUI 配置（disabled fail-closed）→
     * 原生 POST /prompt。成功只代表 queue accepted（不声称图片已生成）。
     */
    async dispatchSceneImage(
      scope: SceneImageScope,
      overrides: { seed?: number } = {},
    ): Promise<DispatchedSceneImage> {
      const prepared = prepareResolved(await resolveScope(scope), overrides);
      const client = await enabledComfyUiClient();
      const { promptId } = await client.queuePrompt(prepared.patchedGraph);
      return { ...prepared, dispatched: true, promptId };
    },

    /**
     * dispatch + 落库闭环：active 生成复用（queued/running 命中则继续同一
     * prompt，不新建）→ 有界轮询 history → 下载校验 → world_files + 台账
     * 同事务 ready。超时/进行中返回 running；失败写台账安全分类码，
     * 不留可见半成品。
     */
    async dispatchAndStoreSceneImage(
      scope: SceneImageScope,
      overrides: { seed?: number } = {},
      run: { fence?: SceneImageFence } = {},
    ): Promise<SceneImageRunResult> {
      if (!options.sceneImageStore) {
        throw new SceneWorkflowError("COMFYUI_DISABLED", "图像生成存储未配置。");
      }
      // worker 模式必须携带 fence（缺失即 fail-closed）；用户显式 dispatch
      // 是独立授权路径（无 request 行，不走 worker fence）。
      if (run.fence && !options.sceneImageQueue) {
        throw new SceneWorkflowError(
          "SCENE_IMAGE_FENCE_REQUIRED",
          "worker dispatch requires the scene image queue for fencing.",
        );
      }
      const client = await enabledComfyUiClient();
      const store = options.sceneImageStore;
      // 授权边界在 route 层（authorizeRecordViewer：membership + viewer
      // projection）；本 service 只解析 Record scope（未知/已归档 Record
      // → null fail-closed），membership 判定不在此层。
      const resolved = await resolveScope(scope);
      const prepared = prepareResolved(resolved, overrides);
      const claimed = await store.claimOrCreateGeneration(
        {
          workspaceId: resolved.workspaceId,
          worldId: resolved.worldId,
          recordId: resolved.recordId,
          sceneId: resolved.sceneId,
          queuePrompt: async () => (await client.queuePrompt(prepared.patchedGraph)).promptId,
        },
        run.fence ? { fence: run.fence } : undefined,
      );
      const generationId = claimed.generation.id;
      const promptId = claimed.generation.promptId;
      if (!promptId || claimed.generation.worldId !== resolved.worldId) {
        await settleGenerationFailed(scope.workspaceId, generationId, "GENERATION_SCOPE_MISMATCH", run.fence);
        return { status: "failed", errorCode: "GENERATION_SCOPE_MISMATCH" };
      }
      const generationWorldId = resolved.worldId;

      const deadline = now() + maxWaitMs;
      for (;;) {
        const history = await client.history(promptId);
        if (history.status === "failed") {
          await settleGenerationFailed(scope.workspaceId, generationId, "GENERATION_FAILED", run.fence);
          return { status: "failed", errorCode: "GENERATION_FAILED" };
        }
        if (history.status === "ready") {
          try {
            const image = await client.viewImage(history.image);
            const { fileId } = run.fence
              ? await store.completeGenerationAndSettle(
                { workspaceId: scope.workspaceId, worldId: generationWorldId, id: generationId },
                {
                  contentType: image.contentType,
                  filename: history.image.filename,
                  data: image.data,
                },
                run.fence,
              )
              : await store.completeGeneration(
                { workspaceId: scope.workspaceId, worldId: generationWorldId, id: generationId },
                {
                  contentType: image.contentType,
                  filename: history.image.filename,
                  data: image.data,
                },
              );
            return {
              status: "ready",
              generationId,
              fileId,
              fileUrl: `/api/files/${fileId}`,
            };
          } catch (error) {
            if (error instanceof SceneImageFenceError) throw error;
            const code = error instanceof ComfyUiError ? error.code : "GENERATION_FAILED";
            await settleGenerationFailed(scope.workspaceId, generationId, code, run.fence);
            return { status: "failed", errorCode: code };
          }
        }
        if (now() >= deadline) {
          // 超时不 fail：生成仍在队列/进行中；下次显式操作继续同一 prompt。
          return { status: "running", generationId };
        }
        await sleep(pollIntervalMs);
      }
    },
  };
}

export type SceneImageService = ReturnType<typeof createSceneImageService>;
