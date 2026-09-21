/**
 * 场景图自动 worker 运行时（参考 propagation-worker-runtime）。
 * - 专用连接持 advisory lock（realm_scene_image_worker）单实例；
 * - loopback runtime DB（createLocalPostgresPool 自带回环校验）+
 *   realm_runtime 最小权限；REALM_SCENE_IMAGE_WORKSPACES 显式清单；
 * - 启动健康检查（0048/0050 表存在性）+ stale lease 恢复；
 * - claim → dispatchAndStoreSceneImage（0048 既有 prepare/queue/history/
 *   view/落库路径）→ complete / retry（临时） / fail（永久）；
 * - 临时 = 网络/连接/超时/未启用配置；永久 = 路径/magic/校验/schema 类；
 * - 日志只写安全分类码（绝不写 provider URL/path/body/key/prompt_id）；
 * - idle backoff 有上限；SIGTERM/SIGINT 经 stop() 干净退出。
 */
import pg from "pg";
import { createLocalPostgresPool } from "../../database/postgres/workspace-transaction.ts";
import {
  createPostgresRecordRuntimeScopeRepository,
  createPostgresSceneImageQueue,
  createPostgresSceneImageStore,
} from "../../database/postgres/public.ts";
import { createSceneImageService } from "./scene-image-service.ts";
import { writeSceneImageWorkerHeartbeat } from "./scene-image-status.ts";
import {
  ComfyUiError,
  createComfyUiSettingsStore,
  SceneWorkflowError,
} from "../imagine/public.ts";

const ADVISORY_LOCK_NAME = "realm_scene_image_worker";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 120_000;

/** 临时（可重试）错误分类：网络/连接/超时/未启用配置；其余按永久处理。 */
export function isTransientSceneImageError(error: unknown): boolean {
  if (error instanceof ComfyUiError) {
    return error.code === "COMFYUI_UNREACHABLE" || error.code === "COMFYUI_TIMEOUT";
  }
  if (error instanceof SceneWorkflowError) {
    // 配置未启用/未配置：不永久失败（用户可能稍后启用），按临时重试。
    return error.code === "COMFYUI_DISABLED";
  }
  const code = (error as { code?: string } | null)?.code ?? "";
  if (/^08\d{3}$/.test(code) || code === "57P01") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated/i.test(message);
}

export class SceneImageWorkerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneImageWorkerLockError";
  }
}

export function createSceneImageWorkerRuntime(options: {
  connectionString: string;
  /** 显式 workspace 清单（REALM_SCENE_IMAGE_WORKSPACES；缺省 demo）。 */
  workspaces: readonly string[];
  maxAttempts?: number;
  leaseMs?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  idleMinMs?: number;
  idleMaxMs?: number;
  logger?: (line: string) => void;
  /** 测试注入：ComfyUI client 工厂（缺省真实原生 client）。 */
  createComfyUiClient?: Parameters<typeof createSceneImageService>[0]["createComfyUiClient"];
  /** 测试注入：心跳写出（缺省写 data-home heartbeat 文件）。 */
  heartbeat?: (input: { state: "online" | "stopping"; workspaces: readonly string[] }) => void;
  now?: () => number;
}): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const idleMinMs = options.idleMinMs ?? 1_000;
  const idleMaxMs = options.idleMaxMs ?? 15_000;
  const log = options.logger ?? ((line: string) => console.log(`[scene-image-worker] ${line}`));
  if (options.workspaces.length === 0) {
    throw new Error("scene image worker requires at least one workspace");
  }
  const workspaces = [...options.workspaces];
  const pool = createLocalPostgresPool(options.connectionString, { max: 4 });
  pool.on("error", () => {});
  const queue = createPostgresSceneImageQueue(pool);
  const sceneImageStore = createPostgresSceneImageStore(pool);
  const scopeRepository = createPostgresRecordRuntimeScopeRepository(pool);
  const service = createSceneImageService({
    scopeRepository,
    comfyUiStore: createComfyUiSettingsStore(),
    sceneImageStore,
    ...(options.createComfyUiClient
      ? { createComfyUiClient: options.createComfyUiClient }
      : {}),
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
  });
  let stopped = false;
  let lockClient: pg.Client | null = null;
  let wake: (() => void) | undefined;
  const now = options.now ?? (() => Date.now());
  const heartbeat = options.heartbeat ?? writeSceneImageWorkerHeartbeat;
  let lastHeartbeatAt = 0;
  /** 节流心跳：每个循环至多每 4s 写一次（文件写出失败不杀 worker）。 */
  function beat(state: "online" | "stopping", force = false): void {
    if (!force && now() - lastHeartbeatAt < 4_000) return;
    lastHeartbeatAt = now();
    heartbeat({ state, workspaces });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        if (wake === done) wake = undefined;
        resolve();
      }
      wake = done;
    });
  }

  /** 处理一条 leased 请求：ready→complete；failed→fail；running→retry。 */
  async function processRequest(workspaceId: string): Promise<boolean> {
    const request = await queue.claim({ workspaceId }, { leaseMs });
    if (!request) return false;
    try {
      const result = await service.dispatchAndStoreSceneImage({
        workspaceId,
        principalId: request.principalId,
        recordId: request.recordId,
      });
      if (result.status === "ready" && result.generationId) {
        await queue.complete({ workspaceId, id: request.id }, result.generationId);
        log(`request completed for record ${request.recordId} (${request.triggerKind})`);
      } else if (result.status === "failed") {
        await queue.fail({ workspaceId, id: request.id }, result.errorCode ?? "GENERATION_FAILED");
        log(`request failed for record ${request.recordId}: ${result.errorCode ?? "GENERATION_FAILED"}`);
      } else {
        // running（有界等待超时）：生成仍在 provider 侧进行。达到总尝试
        // 上限时同时收口请求与 0048 generation，避免 active 永久占位；
        // 否则回 queued，由下次 claim 复用同一 active generation。
        if (request.attempts + 1 >= maxAttempts) {
          if (result.generationId) {
            await sceneImageStore.failGeneration(
              { workspaceId, id: result.generationId },
              "COMFYUI_TIMEOUT",
            );
          }
          await queue.fail({ workspaceId, id: request.id }, "COMFYUI_TIMEOUT");
          log(`request failed permanently: COMFYUI_TIMEOUT`);
        } else {
          await queue.retry({ workspaceId, id: request.id });
          log(`request still running for record ${request.recordId}; re-queued`);
        }
      }
    } catch (error) {
      const safeCode = error instanceof ComfyUiError || error instanceof SceneWorkflowError
        ? error.code
        : "GENERATION_FAILED";
      if (request.attempts + 1 < maxAttempts && isTransientSceneImageError(error)) {
        await queue.retry({ workspaceId, id: request.id });
        log(`request re-queued after transient failure (${safeCode})`);
      } else {
        await queue.fail({ workspaceId, id: request.id }, safeCode);
        log(`request failed permanently: ${safeCode}`);
      }
    }
    return true;
  }

  return {
    async start() {
      lockClient = new pg.Client({ connectionString: options.connectionString });
      await lockClient.connect();
      const locked = await lockClient.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
        [ADVISORY_LOCK_NAME],
      );
      if (locked.rows[0]?.locked !== true) {
        await lockClient.end().catch(() => undefined);
        lockClient = null;
        throw new SceneImageWorkerLockError(
          "another scene image worker instance holds the advisory lock",
        );
      }
      log("advisory lock acquired");
      // 拿锁成功即上报在线（health 失败前也是「进程活着」；
      // 读侧按新鲜度判 online，health 失败走异常退出+停写）。
      beat("online", true);

      const health = await pool.query(
        `SELECT to_regclass('public.scene_image_generations') AS generations,
                to_regclass('public.scene_image_requests') AS requests`,
      );
      if (!health.rows[0]?.generations || !health.rows[0]?.requests) {
        throw new Error("scene image worker requires migrations 0048/0050");
      }

      for (const workspaceId of workspaces) {
        const recovered = await queue.recoverStale({ workspaceId });
        if (recovered > 0) log(`recovered ${recovered} stale request(s) for ${workspaceId}`);
      }

      let backoff = idleMinMs;
      while (!stopped) {
        beat("online");
        let didWork = false;
        try {
          for (const workspaceId of workspaces) {
            if (stopped) break;
            if (await processRequest(workspaceId)) didWork = true;
          }
        } catch (error) {
          // 队列级故障（如数据库重启）：不崩进程，按退避重试；不写敏感信息。
          const safeCode = (error as { code?: string } | null)?.code ?? "unknown";
          log(`poll error: ${safeCode}`);
        }
        if (didWork) backoff = idleMinMs;
        else {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, idleMaxMs);
        }
      }
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      beat("stopping", true);
      wake?.();
      if (lockClient) {
        await lockClient.end().catch(() => undefined);
        lockClient = null;
      }
      await pool.end().catch(() => undefined);
    },
  };
}
