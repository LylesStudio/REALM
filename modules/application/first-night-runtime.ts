import { createLocalPostgresPool } from "../../database/postgres/public.ts";
import {
  createPostgresFirstNightStore,
  type FirstNightStore,
} from "../../database/postgres/first-night-store.ts";
import {
  createFirstNightRunner,
  createFirstNightScheduler,
} from "./first-night.ts";
import { getModelSettingsService } from "./model-settings-service.ts";

/**
 * 初夜运行时装配（批次 T1）：进程级单例，世界落笔路由与记录服务共用，
 * 保证同一 recordId 只有一个在途初夜任务（模块内单飞守卫）。
 * 全部写入走 REALM_RUNTIME_DATABASE_URL 的受限 realm_runtime 角色。
 */

export interface FirstNightRuntime {
  store: FirstNightStore;
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
  const schedule = createFirstNightScheduler({
    runFirstNight: createFirstNightRunner({
      store,
      getGateway: () => getModelSettingsService().gateway(),
    }),
  });
  const runtime: FirstNightRuntime = { store, schedule };
  cached = { workspaceId, runtime };
  return runtime;
}
