import pg from "pg";
import { createLocalPostgresPool } from "../../database/postgres/workspace-transaction.ts";
import { createPostgresPropagationJobQueue } from "../../database/postgres/propagation-job-queue.ts";
import {
  createDurableWorkerHost,
  safeWorkerErrorCode,
} from "./durable-worker-host.ts";
import {
  createPropagationWorker,
  type PropagationJob,
} from "../../modules/propagation/worker.ts";
import { PropagationTopologyError } from "../../database/postgres/propagation-topology.ts";
import type { WorldScope } from "../../modules/world-knowledge/public.ts";

/**
 * 批次 T11-B：独立传播 Worker 运行时（规范 §五）。
 * - 专用连接持 PostgreSQL advisory lock——单实例闸门，抢不到即失败退出
 *   （systemd Restart=on-failure 不会叠加实例）；
 * - loopback runtime DB + realm_runtime 最小权限（createLocalPostgresPool
 *   自带回环校验）；
 * - 启动健康检查（拓扑表存在性）+ 逐 workspace stale 恢复；
 * - 临时错误 attempts<maxAttempts 自动 failed→pending（退避由队列按
 *   attempts 计算）；拓扑/schema/外键类永久错误留 failed 不无限重试；
 * - 无任务时 idle backoff 有上限。
 */

const ADVISORY_LOCK_NAME = "realm_propagation_worker";
const DEFAULT_MAX_ATTEMPTS = 3;

/** 临时（可重试）错误分类：连接/服务中断类为临时，其余按永久处理。 */
export function isTransientPropagationError(error: unknown): boolean {
  if (error instanceof PropagationTopologyError) return false;
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string } | null)?.code ?? "";
  if (/^08\d{3}$/.test(code) || code === "57P01") return true; // PG 连接类 SQLSTATE
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|Connection terminated|terminating connection/i.test(
    message,
  );
}

export class PropagationWorkerLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropagationWorkerLockError";
  }
}

export function createPropagationWorkerRuntime(options: {
  connectionString: string;
  /**
   * 服务的 workspace 清单。realm_runtime 对 propagation_jobs 有 FORCE RLS，
   * 不设置 workspace 上下文读不到任何行，因此不做「全库枚举 workspace」
   * 的伪实现——本地单 workspace 部署由脚本显式传入
   * （REALM_PROPAGATION_WORKSPACES，缺省 demo workspace）。
   */
  workspaces: readonly string[];
  maxAttempts?: number;
  idleMinMs?: number;
  idleMaxMs?: number;
  logger?: (line: string) => void;
}): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const idleMinMs = options.idleMinMs ?? 1_000;
  const idleMaxMs = options.idleMaxMs ?? 15_000;
  const log = options.logger ?? ((line: string) => console.log(`[propagation-worker] ${line}`));
  if (options.workspaces.length === 0) {
    throw new Error("propagation worker requires at least one workspace");
  }
  const workspaces = [...options.workspaces];
  // createLocalPostgresPool 自带 loopback 校验（先于 lock client 创建，
  // 非回环连接串在此处即抛出）；连接串无凭证落日志。
  const pool = createLocalPostgresPool(options.connectionString, { max: 4 });
  pool.on("error", () => {});
  const queue = createPostgresPropagationJobQueue(pool);

  const worker = createPropagationWorker({
    queue,
    onFailed: async (scope: WorldScope, job: PropagationJob, error: unknown) => {
      // 有限重试：临时错误且 attempts 未达上限 → 重新置 pending
      //（再次领取的时间间隔由队列按 attempts 持久化退避计算）。
      if (job.attempts < maxAttempts && isTransientPropagationError(error)) {
        await queue.retry(scope, job.id);
        log(`job ${job.id} re-queued after transient failure (attempt ${job.attempts})`);
        return;
      }
      // 只写有界 machine code：job.lastError / 原始 driver message 可能包含
      // 连接串、endpoint 或 provider payload，绝不进日志（重试/lease/拓扑
      // 语义不受影响）。
      log(`job ${job.id} failed permanently: error=${safeWorkerErrorCode(error)}`);
    },
  });

  async function listWorkspaces(): Promise<string[]> {
    // 显式清单（RLS 约束见 options 注释）；queue 方法内部经
    // withWorkspaceTransaction 逐 workspace 设置上下文。
    return workspaces;
  }

  async function runCycle(): Promise<boolean> {
    let didWork = false;
    try {
      for (const workspaceId of await listWorkspaces()) {
        const outcome = await worker.runOnce(workspaceId);
        if (outcome !== "idle") {
          didWork = true;
          log(`job ${outcome} for ${workspaceId}`);
        }
      }
    } catch (error) {
      // 队列级故障（如数据库重启）：不崩进程，按退避重试。
      // 只写有界 machine code，与 host 安全日志边界一致；原始 message 不落盘。
      log(`poll error=${safeWorkerErrorCode(error)}`);
    }
    return didWork;
  }

  // 共享 host 统一 advisory-lock 生命周期接缝、启动 health hook、
  // idle backoff、有界错误分类日志与幂等 stop/wake；本 runtime 继续
  // 持有自己的 pool、锁名、健康查询、stale 恢复与逐 workspace cycle。
  const host = createDurableWorkerHost({
    idleMinMs,
    idleMaxMs,
    logger: log,
    hooks: {
      alreadyStartedError: () => new PropagationWorkerLockError(
        "propagation worker runtime cannot be started twice",
      ),
      async acquireLock() {
        // 单例闸门： advisory lock 由专用连接持有至进程退出
        //（连接串回环已由上方 createLocalPostgresPool 校验）。
        const client = new pg.Client({ connectionString: options.connectionString });
        try {
          await client.connect();
          const locked = await client.query<{ locked: boolean }>(
            `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
            [ADVISORY_LOCK_NAME],
          );
          if (locked.rows[0]?.locked !== true) {
            throw new PropagationWorkerLockError(
              "another propagation worker instance holds the advisory lock",
            );
          }
          log("advisory lock acquired");
          return async () => {
            await client.end().catch(() => undefined);
          };
        } catch (error) {
          // connect/query/抢锁失败都必须关闭专用 client；原始 driver 错误
          // 只上抛、不写日志（可能包含连接串/endpoint）。
          await client.end().catch(() => undefined);
          throw error;
        }
      },
      async checkHealth() {
        // 健康检查：拓扑表与队列表必须存在（迁移 0025 已应用）。
        const health = await pool.query(
          `SELECT to_regclass('public.propagation_nodes') AS nodes,
                  to_regclass('public.propagation_routes') AS routes,
                  to_regclass('public.propagation_jobs') AS jobs`,
        );
        if (!health.rows[0]?.nodes || !health.rows[0]?.routes || !health.rows[0]?.jobs) {
          throw new Error(
            "propagation worker requires migration 0025 (topology tables missing)",
          );
        }
      },
      async onStart() {
        // 启动 stale 恢复：上次崩溃遗留的 running 任务回到 pending。
        for (const workspaceId of await listWorkspaces()) {
          const recovered = await worker.recoverStale(workspaceId);
          if (recovered > 0) {
            log(`recovered ${recovered} stale job(s) for ${workspaceId}`);
          }
        }
      },
      runCycle,
      async close() {
        await pool.end().catch(() => undefined);
      },
    },
  });

  return {
    start: () => host.start(),
    stop: () => host.stop(),
  };
}
