import { createLocalPostgresPool } from "../../database/postgres/public.ts";
import {
  createPostgresFirstNightStore,
  type FirstNightStore,
} from "../../database/postgres/first-night-store.ts";
import { createFirstNightRunner } from "./first-night.ts";
import { getModelSettingsService } from "./model-settings-service.ts";
import { getDurableJobRuntime } from "./durable-job-runtime.ts";

/**
 * 初夜运行时装配（批次 T1；Slice 3 迁入统一 durable job host）。
 *
 * schedule 不再是进程内 ad-hoc fire-and-forget：它向 realm_durable_jobs
 * 入队一条 first-night job（确定性 id `first-night:{recordId}`，terminal
 * 行可被懒重试重置回 pending）；统一 host 的 claimed job 执行既有 runner
 * （claimAttempt → 生成/降级 → commitPack），完成/失败经 lease fencing
 * 幂等收束。进程级单例保证同一路由与记录服务共用同一队列与 host。
 * 全部写入走 REALM_RUNTIME_DATABASE_URL 的受限 realm_runtime 角色。
 */

export interface FirstNightRuntime {
  store: FirstNightStore;
  /** fire-and-forget：入队 durable first-night job（不等待、不抛错）。 */
  schedule: (recordId: string) => void;
}

let cached: { workspaceId: string; runtime: FirstNightRuntime } | undefined;

export function getFirstNightRuntime(workspaceId: string): FirstNightRuntime {
  if (cached && cached.workspaceId === workspaceId) return cached.runtime;
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    throw new Error("REALM_RUNTIME_DATABASE_URL is required for the first-night runtime.");
  }
  const pool = createLocalPostgresPool(connectionString);
  const store = createPostgresFirstNightStore(pool, workspaceId);
  const runFirstNight = createFirstNightRunner({
    store,
    getGateway: () => getModelSettingsService().gateway(),
  });
  const durableJobs = getDurableJobRuntime(workspaceId);
  // claimed job 执行 seal/ready 逻辑；runner 抛错（落库失败等）由 host 以
  // 有界 code 落 failed，marker 保持 pending，等待懒重试 requeue。
  durableJobs.registerHandler("first-night", async (job) => {
    await runFirstNight(job.recordId);
  });
  const schedule = (recordId: string) => {
    const key = recordId.trim();
    if (!key) return;
    // 懒调度 fire-and-forget：不等待、不抛错；active 行去重（active 不
    // 重叠），terminal 行重置回 pending（懒重试）；失败只告警，pending
    // 内容照常返回（入队失败不影响 envelope 主路径）。
    void durableJobs.enqueue({
      jobId: `first-night:${key}`,
      kind: "first-night",
      recordId: key,
      payload: {},
      requeueTerminal: true,
    }).catch(() => {
      console.warn("[realm] first night schedule failed: skipped lazy retry");
    });
  };
  const runtime: FirstNightRuntime = { store, schedule };
  cached = { workspaceId, runtime };
  return runtime;
}
