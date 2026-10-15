import assert from "node:assert/strict";
import test from "node:test";
import { createGoalProjectionStream } from "../modules/goals/projection-stream.ts";
import type { GoalProjection } from "../modules/goals/projection.ts";

const active: GoalProjection = {
  goalKey: "harbor.signal",
  scopeKind: "record",
  state: "active",
  attempt: 1,
  supersedesInstanceId: null,
  progress: { signals: 1 },
  outcome: null,
};
const completed: GoalProjection = {
  ...active,
  state: "completed",
  progress: { signals: 2 },
  outcome: { title: "Signal received" },
};

test("Goal projection stream emits an initial snapshot, ignores unrelated wakes, and coalesces transitions", async () => {
  const controller = new AbortController();
  const waiters: ((value: boolean) => void)[] = [];
  let transitionAvailable = false;
  let closeCount = 0;
  const stream = createGoalProjectionStream({
    recordId: "record-1",
    initialCursor: 0,
    signal: controller.signal,
    load: async () => ({
      headOrdinal: transitionAvailable ? 2 : 1,
      goals: transitionAvailable ? [completed] : [active],
    }),
    listGoalTransitionOrdinalsAfter: async (cursor) =>
      transitionAvailable && cursor < 2 ? [2] : [],
    waitForWakeup: () => new Promise<boolean>((resolve) => waiters.push(resolve)),
    closeWakeup: async () => { closeCount += 1; },
    heartbeatIntervalMs: 60_000,
  });
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /"headOrdinal":1/);
  assert.match(new TextDecoder().decode(first.value), /"state":"active"/);

  waiters.shift()!(true);
  for (let attempt = 0; attempt < 20 && waiters.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(waiters.length, 1);
  transitionAvailable = true;
  waiters.shift()!(true);
  const second = await reader.read();
  assert.equal(second.done, false);
  assert.match(new TextDecoder().decode(second.value), /"headOrdinal":2/);
  assert.match(new TextDecoder().decode(second.value), /"state":"completed"/);

  waiters.shift()!(false);
  const done = await reader.read();
  assert.equal(done.done, true);
  assert.equal(closeCount, 1);
});

test("Goal projection stream closes safely when aborted during wake", async () => {
  const controller = new AbortController();
  let wakeResolve: ((value: boolean) => void) | undefined;
  let closeCount = 0;
  const stream = createGoalProjectionStream({
    recordId: "record-2",
    initialCursor: 0,
    signal: controller.signal,
    load: async () => ({ headOrdinal: 0, goals: [] }),
    listGoalTransitionOrdinalsAfter: async () => [],
    waitForWakeup: () => new Promise<boolean>((resolve) => { wakeResolve = resolve; }),
    closeWakeup: async () => { closeCount += 1; },
    heartbeatIntervalMs: 60_000,
  });
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  controller.abort();
  wakeResolve?.(false);
  const done = await reader.read();
  assert.equal(done.done, true);
  assert.equal(closeCount, 1);
});
