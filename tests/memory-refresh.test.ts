import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createMemoryRefreshScheduler } from "../app/memory-refresh.ts";

test("memory refresh scheduler debounces committed events and retries async sync", () => {
  let nextTimer = 0;
  const pending = new Map<number, () => void>();
  const cleared: number[] = [];
  let enabled = true;
  let invalidations = 0;
  const scheduler = createMemoryRefreshScheduler({
    isEnabled: () => enabled,
    invalidate: () => { invalidations += 1; },
    delaysMs: [10, 20, 30],
    setTimeoutFn: (callback) => {
      const id = ++nextTimer;
      pending.set(id, callback);
      return id;
    },
    clearTimeoutFn: (id) => {
      const timerId = id as number;
      cleared.push(timerId);
      pending.delete(timerId);
    },
  });

  scheduler.schedule();
  scheduler.schedule();
  assert.equal(pending.size, 1, "同一批 committed 事件只保留一个首个 timer");
  const fire = (id: number) => {
    const callback = pending.get(id);
    pending.delete(id);
    callback?.();
  };
  const first = [...pending.keys()][0]!;
  fire(first);
  assert.equal(invalidations, 1);
  assert.equal(pending.size, 1, "首轮读取后继续等待后台 sync_turn");
  const second = [...pending.keys()][0]!;
  fire(second);
  assert.equal(invalidations, 2);
  const third = [...pending.keys()][0]!;
  fire(third);
  assert.equal(invalidations, 3);
  assert.equal(pending.size, 0, "达到上限后停止重读");

  scheduler.schedule();
  enabled = false;
  const disabledTimer = [...pending.keys()][0]!;
  fire(disabledTimer);
  assert.equal(invalidations, 3, "动态知识关闭时不触发读取");
  enabled = true;
  scheduler.schedule();
  const disposableTimer = [...pending.keys()][0]!;
  scheduler.dispose();
  assert.ok(cleared.includes(disposableTimer));
});

test("realm client wires committed events to bounded memory reread cleanup", () => {
  const source = readFileSync(new URL("../app/realm-client.tsx", import.meta.url), "utf8");
  assert.match(source, /createMemoryRefreshScheduler/);
  assert.match(source, /memoryRefreshRef\.current\?\.schedule\(\)/);
  assert.match(source, /memoryRefreshScheduler\.dispose\(\)/);
});
