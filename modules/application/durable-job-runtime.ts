import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  createLocalPostgresPool,
} from "../../database/postgres/workspace-transaction.ts";
import { createPostgresDurableJobQueue } from "../../database/postgres/durable-job-queue.ts";
import {
  createUnifiedDurableJobHost,
  type DurableJobEnqueueInput,
  type DurableJobEnqueueResult,
  type DurableJobHandler,
  type DurableJobHandlerRegistry,
  type DurableJobKind,
} from "./unified-durable-job-host.ts";
import { safeWorkerErrorCode } from "./durable-worker-host.ts";
import { RuntimeInvariantError } from "../runtime/public.ts";

/**
 * Slice 3：嵌入式统一 durable job runtime（进程内单例，按 workspace 缓存）。
 *
 * - 持有受限 realm_runtime 连接池 + realm_durable_jobs 队列 + 统一 host；
 * - host 以 advisory lock（realm_durable_job_host）做单实例闸门，首次
 *   registerHandler 时 fire-and-forget 启动；抢不到锁只留告警——enqueue
 *   依然生效，job 由持锁实例处理（或待本进程下一次启动回收）；
 * - lease 默认 5 分钟：覆盖初夜/自演拍的模型调用时长；worker 崩溃留下的
 *   claimed 行在租约过期后被 claimNext 回收（stale recovery）；
 * - enqueue/handler 失败均为 fail-closed：payload 无效在派发前落
 *   JOB_PAYLOAD_INVALID，绝不进入业务 handler。
 */

const ADVISORY_LOCK_NAME = "realm_durable_job_host";
const DEFAULT_LEASE_DURATION_MS = 300_000;
const DEFAULT_IDLE_MIN_MS = 250;
const DEFAULT_IDLE_MAX_MS = 10_000;

export interface DurableJobRuntime {
  /** 本进程实例标识（job id 唯一性前缀，防跨进程碰撞）。 */
  readonly instanceId: string;
  enqueue(input: DurableJobEnqueueInput): Promise<DurableJobEnqueueResult>;
  registerHandler(kind: DurableJobKind, handler: DurableJobHandler): void;
  stop(): Promise<void>;
}

export function createDurableJobRuntime(options: {
  connectionString: string;
  workspaceId: string;
  leaseDurationMs?: number;
  idleMinMs?: number;
  idleMaxMs?: number;
  logger?: (line: string) => void;
  clock?: () => string;
}): DurableJobRuntime {
  const connectionString = options.connectionString.trim();
  const workspaceId = options.workspaceId.trim();
  if (!connectionString) {
    throw new RuntimeInvariantError(
      "DURABLE_JOB_DATABASE_URL_INVALID",
      "Durable job runtime requires a connection string.",
    );
  }
  if (!workspaceId) {
    throw new RuntimeInvariantError(
      "DURABLE_JOB_WORKSPACE_INVALID",
      "Durable job runtime requires a Workspace identifier.",
    );
  }
  const log = options.logger
    ?? ((line: string) => console.log(`[durable-job-host] ${line}`));
  const instanceId = randomUUID();
  const pool = createLocalPostgresPool(connectionString, { max: 4 });
  pool.on("error", () => {});
  const queue = createPostgresDurableJobQueue({
    pool,
    workspaceId,
    leaseOwner: `durable-job:${process.pid}:${instanceId}`,
    leaseDurationMs: options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
  });
  const handlers: DurableJobHandlerRegistry = new Map();

  const host = createUnifiedDurableJobHost({
    slots: [{ workspaceId, queue }],
    handlers,
    idleMinMs: options.idleMinMs ?? DEFAULT_IDLE_MIN_MS,
    idleMaxMs: options.idleMaxMs ?? DEFAULT_IDLE_MAX_MS,
    logger: log,
    ...(options.clock ? { clock: options.clock } : {}),
    alreadyStartedError: () => new RuntimeInvariantError(
      "DURABLE_JOB_HOST_ALREADY_STARTED",
      "Durable job host cannot be started twice.",
    ),
    async acquireLock() {
      const client = new pg.Client({ connectionString });
      try {
        await client.connect();
        const locked = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
          [ADVISORY_LOCK_NAME],
        );
        if (locked.rows[0]?.locked !== true) {
          throw new RuntimeInvariantError(
            "DURABLE_JOB_HOST_ALREADY_RUNNING",
            "Another durable job host holds the advisory lock.",
          );
        }
        log("advisory lock acquired");
        return async () => {
          await client.end().catch(() => undefined);
        };
      } catch (error) {
        // connect/抢锁失败不得泄漏专用 client；原始 driver 错误只上抛。
        await client.end().catch(() => undefined);
        throw error;
      }
    },
    async checkHealth() {
      const health = await pool.query<{ jobs: string | null }>(
        "SELECT to_regclass('public.realm_durable_jobs') AS jobs",
      );
      if (!health.rows[0]?.jobs) {
        throw new RuntimeInvariantError(
          "DURABLE_JOB_SCHEMA_UNAVAILABLE",
          "Durable job host requires migration 0058 (realm_durable_jobs).",
        );
      }
    },
    async close() {
      await pool.end().catch(() => undefined);
    },
  });

  let startRequested = false;
  return {
    instanceId,
    enqueue(input) {
      return queue.enqueue(input);
    },
    registerHandler(kind, handler) {
      handlers.set(kind, handler);
      if (startRequested) return;
      startRequested = true;
      // fire-and-forget：抢锁失败（另一实例在跑）只留有界告警，job 留在
      // 队列由持锁实例处理；绝不阻塞路由/服务装配路径。
      void host.start().catch((error) => {
        console.warn(
          `[realm] durable job host unavailable: ${safeWorkerErrorCode(error)}`,
        );
      });
    },
    async stop() {
      await host.stop();
    },
  };
}

let cached: { workspaceId: string; runtime: DurableJobRuntime } | undefined;

/** 进程级单例（与 first-night runtime 同一装配模式）；缺 env 即 fail-closed。 */
export function getDurableJobRuntime(workspaceId: string): DurableJobRuntime {
  if (cached && cached.workspaceId === workspaceId) return cached.runtime;
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    throw new Error("REALM_RUNTIME_DATABASE_URL is required for the durable job runtime.");
  }
  const runtime = createDurableJobRuntime({ connectionString, workspaceId });
  cached = { workspaceId, runtime };
  return runtime;
}

/** 关停/测试路径：停止 host 并释放连接池（幂等）。 */
export async function closeDurableJobRuntime(): Promise<void> {
  const current = cached;
  cached = undefined;
  await current?.runtime.stop().catch(() => undefined);
}
