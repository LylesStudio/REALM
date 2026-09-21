/**
 * scene-image-status：worker 心跳 writer/reader 契约（data-home 文件，
 * 无 DB 迁移）。fresh→online；stale/missing/invalid→unavailable；
 * 写失败不抛出；文件内容只含安全字段。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  readSceneImageWorkerStatus,
  SCENE_IMAGE_WORKER_STALE_MS,
  writeSceneImageWorkerHeartbeat,
} from "../modules/application/scene-image-status.ts";

function withDataHome(t: test.TestContext): string {
  const dataHome = mkdtempSync(join(tmpdir(), "realm-scene-status-"));
  const previous = process.env.REALM_DATA_HOME;
  process.env.REALM_DATA_HOME = dataHome;
  t.after(() => {
    if (previous === undefined) delete process.env.REALM_DATA_HOME;
    else process.env.REALM_DATA_HOME = previous;
    rmSync(dataHome, { recursive: true, force: true });
  });
  return dataHome;
}

const HEARTBEAT_RELATIVE = join("diagnostics", "scene-image-worker.json");

test("fresh heartbeat → online；文件只含安全字段", (t) => {
  const dataHome = withDataHome(t);
  const now = 1_800_000_000_000;
  writeSceneImageWorkerHeartbeat({
    state: "online",
    workspaces: ["ws_demo"],
    now: () => now,
  });
  const status = readSceneImageWorkerStatus({ now: () => now + 1_000 });
  assert.deepEqual(status, { state: "online" });

  const raw = readFileSync(resolve(dataHome, HEARTBEAT_RELATIVE), "utf8");
  const frame = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(Object.keys(frame).sort(), ["state", "updatedAt", "workspaces"]);
  assert.doesNotMatch(raw, /postgresql:\/\/|api[-_]?key|token|password/i);
});

test("stale / missing / invalid → unavailable（安全原因码）", (t) => {
  const dataHome = withDataHome(t);
  const now = 1_800_000_000_000;

  // missing：从未写出。
  assert.deepEqual(
    readSceneImageWorkerStatus({ now: () => now }),
    { state: "unavailable", reason: "missing" },
  );

  // stale：超过阈值。
  writeSceneImageWorkerHeartbeat({
    state: "online",
    workspaces: ["ws_demo"],
    now: () => now,
  });
  assert.deepEqual(
    readSceneImageWorkerStatus({ now: () => now + SCENE_IMAGE_WORKER_STALE_MS + 1 }),
    { state: "unavailable", reason: "stale" },
  );

  // invalid：结构损坏。
  writeFileSync(
    resolve(dataHome, HEARTBEAT_RELATIVE),
    `${JSON.stringify({ state: "online", updatedAt: 42 })}\n`,
    "utf8",
  );
  assert.deepEqual(
    readSceneImageWorkerStatus({ now: () => now }),
    { state: "unavailable", reason: "invalid" },
  );

  // invalid：updatedAt 不可解析。
  writeFileSync(
    resolve(dataHome, HEARTBEAT_RELATIVE),
    `${JSON.stringify({ state: "online", workspaces: [], updatedAt: "not-a-date" })}\n`,
    "utf8",
  );
  assert.deepEqual(
    readSceneImageWorkerStatus({ now: () => now }),
    { state: "unavailable", reason: "invalid" },
  );
});

test("stopping 心跳在新鲜窗口内仍视为进程存活（online）", (t) => {
  withDataHome(t);
  const now = 1_800_000_000_000;
  writeSceneImageWorkerHeartbeat({
    state: "stopping",
    workspaces: ["ws_demo"],
    now: () => now,
  });
  assert.deepEqual(readSceneImageWorkerStatus({ now: () => now + 500 }), { state: "online" });
});
