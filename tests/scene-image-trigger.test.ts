/**
 * 场景图自动触发器单元测试（fake queue/accounts，无 DB）：
 * 模式门禁、幂等键透传、deltaChangesScene 场景字段判定、入队失败不抛出。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { RecordRuntimeScope } from "../database/postgres/public.ts";
import type { SceneImageRequest } from "../database/postgres/scene-image-queue.ts";
import {
  createSceneImageAutoTrigger,
  deltaChangesScene,
} from "../modules/application/scene-image-trigger.ts";
import { normalizeSceneImageMode } from "../modules/imagine/public.ts";

const SCOPE = {
  workspaceId: "ws_t",
  principalId: "principal_t",
  worldId: "world_t",
  recordId: "record_t",
  sceneId: "scene_t",
} as unknown as RecordRuntimeScope;

function harness(mode: string) {
  const enqueued: { triggerKind: string; sourceEventId: string; principalId: string }[] = [];
  const trigger = createSceneImageAutoTrigger({
    accounts: {
      async findSceneImageMode() {
        return normalizeSceneImageMode(mode);
      },
    },
    queue: {
      async enqueue(input: { triggerKind: string; sourceEventId: string; principalId: string }) {
        enqueued.push(input);
        return { request: { id: "req_1" } as unknown as SceneImageRequest, enqueued: true };
      },
    } as never,
    logger: () => undefined,
  });
  return { trigger, enqueued };
}

test("normalizeSceneImageMode: 非法/缺失 fail-closed off", () => {
  assert.equal(normalizeSceneImageMode("off"), "off");
  assert.equal(normalizeSceneImageMode("scene_change"), "scene_change");
  assert.equal(normalizeSceneImageMode("every_turn"), "every_turn");
  assert.equal(normalizeSceneImageMode("always"), "off");
  assert.equal(normalizeSceneImageMode(undefined), "off");
  assert.equal(normalizeSceneImageMode(null), "off");
});

test("every_turn：仅 every_turn 模式入队，幂等键透传", async () => {
  const on = harness("every_turn");
  await on.trigger.afterPlayerTurn({
    runtimeScope: SCOPE,
    principalId: "principal_t",
    sourceEventId: "idem-key-1",
  });
  assert.equal(on.enqueued.length, 1);
  assert.equal(on.enqueued[0]!.triggerKind, "every_turn");
  assert.equal(on.enqueued[0]!.sourceEventId, "idem-key-1");
  assert.equal(on.enqueued[0]!.principalId, "principal_t");

  // scene_change / off / 未知模式不入队。
  for (const mode of ["scene_change", "off", "garbage"]) {
    const other = harness(mode);
    await other.trigger.afterPlayerTurn({
      runtimeScope: SCOPE,
      principalId: "principal_t",
      sourceEventId: "idem-key-2",
    });
    assert.equal(other.enqueued.length, 0, `mode=${mode} 不得触发 every_turn`);
  }
});

test("scene_change：仅 scene_change 模式入队；场景字段判定", async () => {
  const on = harness("scene_change");
  await on.trigger.afterSceneChange({
    runtimeScope: SCOPE,
    principalId: "principal_t",
    sourceEventId: "event_scene_1",
  });
  assert.equal(on.enqueued.length, 1);
  assert.equal(on.enqueued[0]!.triggerKind, "scene_change");

  const off = harness("every_turn");
  await off.trigger.afterSceneChange({
    runtimeScope: SCOPE,
    principalId: "principal_t",
    sourceEventId: "event_scene_2",
  });
  assert.equal(off.enqueued.length, 0);

  // deltaChangesScene：任一场景字段非空即变化；全空/undefined 不变。
  assert.ok(deltaChangesScene({ location: "灯塔" }));
  assert.ok(deltaChangesScene({ weather: "雾" }));
  assert.ok(deltaChangesScene({ tension: "紧" }));
  assert.ok(deltaChangesScene({ objective: "点灯" }));
  assert.ok(deltaChangesScene({ displayTime: "夜" }));
  assert.ok(!deltaChangesScene({}));
  assert.ok(!deltaChangesScene({ location: "", weather: "  " }));
});

test("入队失败只留日志（不抛出、不阻塞调用方）", async () => {
  const trigger = createSceneImageAutoTrigger({
    accounts: { async findSceneImageMode() { return "every_turn" as const; } },
    queue: {
      async enqueue() {
        throw new Error("db exploded");
      },
    } as never,
    logger: () => undefined,
  });
  await trigger.afterPlayerTurn({
    runtimeScope: SCOPE,
    principalId: "principal_t",
    sourceEventId: "idem-key-3",
  });
  // 不抛即通过。
});
