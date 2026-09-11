import pg from "pg";
import { createLocalPostgresPool } from "../../database/postgres/workspace-transaction.ts";
import { createPostgresPropagationJobQueue } from "../../database/postgres/propagation-job-queue.ts";
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
  let stopped = false;
  let lockClient: pg.Client | null = null;
  let wake: (() => void) | undefined;

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
      log(`job ${job.id} failed permanently: ${job.lastError ?? "unknown"}`);
    },
  });

  async function listWorkspaces(): Promise<string[]> {
    // 显式清单（RLS 约束见 options 注释）；queue 方法内部经
    // withWorkspaceTransaction 逐 workspace 设置上下文。
    return workspaces;
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (wake === done) wake = undefined;
        resolve();
      }, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      wake = done;
    });
  }

  return {
    async start() {
      // 单例闸门： advisory lock 由专用连接持有至进程退出
      //（连接串回环已由上方 createLocalPostgresPool 校验）。
      lockClient = new pg.Client({ connectionString: options.connectionString });
      await lockClient.connect();
      const locked = await lockClient.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
        [ADVISORY_LOCK_NAME],
      );
      if (locked.rows[0]?.locked !== true) {
        await lockClient.end().catch(() => undefined);
        lockClient = null;
        throw new PropagationWorkerLockError(
          "another propagation worker instance holds the advisory lock",
        );
      }
      log("advisory lock acquired");

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

      // 启动 stale 恢复：上次崩溃遗留的 running 任务回到 pending。
      for (const workspaceId of await listWorkspaces()) {
        const recovered = await worker.recoverStale(workspaceId);
        if (recovered > 0) {
          log(`recovered ${recovered} stale job(s) for ${workspaceId}`);
        }
      }

      let backoff = idleMinMs;
      while (!stopped) {
        let didWork = false;
        try {
          for (const workspaceId of await listWorkspaces()) {
            if (stopped) break;
            const outcome = await worker.runOnce(workspaceId);
            if (outcome !== "idle") {
              didWork = true;
              log(`job ${outcome} for ${workspaceId}`);
            }
          }
        } catch (error) {
          // 队列级故障（如数据库重启）：不崩进程，按退避重试。
          log(`poll error: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (didWork) {
          backoff = idleMinMs;
        } else {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, idleMaxMs);
        }
      }
    },

    async stop() {
      stopped = true;
      wake?.();
      if (lockClient) {
        await lockClient.end().catch(() => undefined);
        lockClient = null;
      }
      await pool.end().catch(() => undefined);
    },
  };
}
