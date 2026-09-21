/**
 * 场景图 worker 运行状态（server-only，data-home heartbeat 文件，无 DB 迁移）。
 * - writer：worker runtime 周期写 `<dataHome>/diagnostics/scene-image-worker.json`
 *   （原子写；只含安全字段：state/workspaces/updatedAt/安全分类码）。
 * - reader：API 侧按新鲜度判 online/unavailable（阈值内 fresh = online；
 *   缺失/过期/损坏 = unavailable，读不出原因不写敏感信息）。
 * dataHome 解析与 session-secret 同路径（REALM_DATA_HOME ?? cwd/.local）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SCENE_IMAGE_WORKER_HEARTBEAT_FILE = "scene-image-worker.json";
/** 心跳过期阈值：worker 循环每 ≤5s 写一次；3 倍余量。 */
export const SCENE_IMAGE_WORKER_STALE_MS = 15_000;

export interface SceneImageWorkerHeartbeat {
  state: "online" | "stopping";
  workspaces: readonly string[];
  updatedAt: string;
}

export interface SceneImageWorkerStatus {
  state: "online" | "unavailable";
  /** unavailable 时的安全诊断（stale/missing/invalid；不含内部细节）。 */
  reason?: "stale" | "missing" | "invalid";
}

function heartbeatPath(): string {
  const settingsRoot = process.env.REALM_DATA_HOME?.trim() || resolve(process.cwd(), ".local");
  return resolve(settingsRoot, "diagnostics", SCENE_IMAGE_WORKER_HEARTBEAT_FILE);
}

export function writeSceneImageWorkerHeartbeat(input: {
  state: "online" | "stopping";
  workspaces: readonly string[];
  now?: () => number;
}): void {
  const now = input.now ?? (() => Date.now());
  const path = heartbeatPath();
  const frame: SceneImageWorkerHeartbeat = {
    state: input.state,
    workspaces: input.workspaces,
    updatedAt: new Date(now()).toISOString(),
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(frame)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    // 心跳写失败不杀 worker（诊断降级为 unavailable，由 reader 报告）。
  }
}

export function readSceneImageWorkerStatus(input?: {
  now?: () => number;
  staleMs?: number;
}): SceneImageWorkerStatus {
  const now = input?.now ?? (() => Date.now());
  const staleMs = input?.staleMs ?? SCENE_IMAGE_WORKER_STALE_MS;
  let frame: SceneImageWorkerHeartbeat;
  try {
    frame = JSON.parse(readFileSync(heartbeatPath(), "utf8")) as SceneImageWorkerHeartbeat;
  } catch {
    return { state: "unavailable", reason: "missing" };
  }
  if (
    !frame
    || (frame.state !== "online" && frame.state !== "stopping")
    || !Array.isArray(frame.workspaces)
    || typeof frame.updatedAt !== "string"
  ) {
    return { state: "unavailable", reason: "invalid" };
  }
  const updatedAt = Date.parse(frame.updatedAt);
  if (!Number.isFinite(updatedAt)) return { state: "unavailable", reason: "invalid" };
  if (now() - updatedAt > staleMs) return { state: "unavailable", reason: "stale" };
  return { state: "online" };
}
