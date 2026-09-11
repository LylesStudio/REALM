/**
 * v37 C3：realm-dev 专用池工厂（worker 零改动——公共 factory 默认行为不变，
 * worker 继续用 createLocalPostgresPool）。
 *
 * `component ∈ {'realm-dev','realm-dev-transfer'}`（冻结二值）；
 * application_name 在 poolTuning 合并之后强制写入；overrides/连接串 query
 * 中的 application_name/fallback_application_name 一律拒绝（误标即配置
 * 错误，fail-closed）。
 *
 * 用途：pg_stat_activity 归属（drain 读回的归属辅助证据）+ transfer 池
 * 独立标识。不进 getSharedRuntimePool 之外的其他公共路径。
 */
import type { Pool, PoolConfig } from "pg";
import { createLocalPostgresPool } from "./workspace-transaction.ts";

export type RealmDevComponent = "realm-dev" | "realm-dev-transfer";

export function createRealmDevPostgresPool(
  connectionString: string | undefined,
  component: RealmDevComponent,
  tuning: PoolConfig = {},
): Pool {
  if (component !== "realm-dev" && component !== "realm-dev-transfer") {
    throw new Error(`unknown realm-dev pool component: ${String(component)}`);
  }
  if (!connectionString) {
    throw new Error("realm-dev pool requires a connection string.");
  }
  // 连接串 query 中的 application_name 注入拒绝（createLocalPostgresPool
  // 本就拒绝一切 query 参数；这里先给出明确错误）。
  const url = new URL(connectionString);
  if (url.searchParams.has("application_name")
    || url.searchParams.has("fallback_application_name")) {
    throw new Error(
      "application_name in the connection string is not allowed for realm-dev pools.",
    );
  }
  if ("application_name" in tuning || "fallback_application_name" in tuning) {
    throw new Error(
      "application_name overrides are not allowed for realm-dev pools.",
    );
  }
  // poolTuning 合并之后强制写入 application_name。
  return createLocalPostgresPool(connectionString, {
    ...tuning,
    application_name: component,
  });
}
