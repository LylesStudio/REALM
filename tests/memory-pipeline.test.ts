import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryPrefetchHub,
  createMemorySyncScheduler,
  type MemorySyncScope,
} from "../modules/memory/pipeline.ts";

const SCOPE: MemorySyncScope = {
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
  recordId: "record_first_watch",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("sync_turn scheduler single-flights concurrent schedules per workspace+record", async () => {
  const gate = deferred<{ materialized: number }>();
  let runs = 0;
  const scheduler = createMemorySyncScheduler({
    extract: (scope) => {
      runs += 1;
      assert.deepEqual(scope, SCOPE);
      return gate.promise;
    },
  });

  // 并发三次触发同一 record：单飞守卫只允许一次在途。
  scheduler.schedule(SCOPE);
  scheduler.schedule(SCOPE);
  scheduler.schedule(SCOPE);
  await Promise.resolve();
  assert.equal(runs, 1);

  // 在途期间的新触发挂 pending：结束后补跑一次（re-arm），而不是三次。
  gate.resolve({ materialized: 2 });
  await scheduler.idle();
  assert.equal(runs, 2);
});

test("sync_turn scheduler keeps distinct records independent", async () => {
  const gates = new Map<string, ReturnType<typeof deferred<{ materialized: number }>>>();
  const running = new Set<string>();
  let maxConcurrent = 0;
  const scheduler = createMemorySyncScheduler({
    extract: async (scope) => {
      running.add(scope.recordId);
      maxConcurrent = Math.max(maxConcurrent, running.size);
      const gate = gates.get(scope.recordId)!;
      const result = await gate.promise;
      running.delete(scope.recordId);
      return result;
    },
  });
  const other: MemorySyncScope = { ...SCOPE, recordId: "record_other" };
  gates.set(SCOPE.recordId, deferred());
  gates.set(other.recordId, deferred());

  scheduler.schedule(SCOPE);
  scheduler.schedule(other);
  await Promise.resolve();
  assert.equal(maxConcurrent, 2, "不同 record 的萃取互不阻塞");

  gates.get(SCOPE.recordId)!.resolve({ materialized: 0 });
  gates.get(other.recordId)!.resolve({ materialized: 0 });
  await scheduler.idle();
});

test("sync_turn scheduler treats extraction failure as warn-only and stays schedulable", async (t) => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  let calls = 0;
  const scheduler = createMemorySyncScheduler({
    extract: () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("db offline"))
        : Promise.resolve({ materialized: 1 });
    },
  });

  scheduler.schedule(SCOPE);
  await scheduler.idle();
  assert.equal(calls, 1);
  assert.ok(warnings.some((line) => line.includes("db offline")));

  // 失败释放单飞位：后续触发照常萃取。
  scheduler.schedule(SCOPE);
  await scheduler.idle();
  assert.equal(calls, 2);
});

test("sync_turn scheduler idle resolves immediately when nothing is scheduled", async () => {
  const scheduler = createMemorySyncScheduler({
    extract: () => Promise.resolve({ materialized: 0 }),
  });
  await scheduler.idle();
});

test("sync_turn scheduler re-arms once with the latest pending scope", async () => {
  const gate = deferred<{ materialized: number }>();
  const seen: MemorySyncScope[] = [];
  let calls = 0;
  const scheduler = createMemorySyncScheduler({
    extract: (scope) => {
      calls += 1;
      seen.push(scope);
      if (calls === 1) return gate.promise;
      return Promise.resolve({ materialized: 0 });
    },
  });
  const first: MemorySyncScope = { ...SCOPE };
  const second: MemorySyncScope = { ...SCOPE };
  const third: MemorySyncScope = { ...SCOPE };

  scheduler.schedule(first);
  scheduler.schedule(second);
  scheduler.schedule(third);
  gate.resolve({ materialized: 1 });
  await scheduler.idle();

  assert.equal(calls, 2, "在途一次 + re-arm 补跑一次，中间触发被合并");
  assert.equal(seen[0], first);
  assert.equal(seen[1], third, "re-arm 使用最新挂起的 scope");
});

test("sync_turn scheduler re-arms after a failure with the pending scope", async (t) => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const gate = deferred<{ materialized: number }>();
  const seen: MemorySyncScope[] = [];
  let calls = 0;
  const scheduler = createMemorySyncScheduler({
    extract: (scope) => {
      calls += 1;
      seen.push(scope);
      if (calls === 1) return gate.promise;
      return Promise.resolve({ materialized: 0 });
    },
  });
  const first: MemorySyncScope = { ...SCOPE };
  const second: MemorySyncScope = { ...SCOPE };

  scheduler.schedule(first);
  scheduler.schedule(second);
  gate.reject(new Error("boom"));
  await scheduler.idle();

  assert.equal(calls, 2, "失败释放单飞位，pending 补跑");
  assert.equal(seen[1], second);
  assert.ok(warnings.some((line) => line.includes("boom")));
});

const PREFETCH_INPUT = {
  recordId: "record_first_watch",
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
  playerText: "先不要拆信，检查信使离开的方向。",
} as const;

test("prefetch hub fires character recalls in parallel and consumes ready results", async () => {
  const gates = new Map<string, ReturnType<typeof deferred<string>>>();
  const running = new Set<string>();
  let maxConcurrent = 0;
  const hub = createMemoryPrefetchHub({
    recall: async (input) => {
      running.add(input.characterInstanceId);
      maxConcurrent = Math.max(maxConcurrent, running.size);
      assert.equal(input.query, PREFETCH_INPUT.playerText);
      const gate = gates.get(input.characterInstanceId)!;
      const result = await gate.promise;
      running.delete(input.characterInstanceId);
      return result;
    },
  });
  gates.set("char_inst_scout", deferred());
  gates.set("char_inst_scholar", deferred());

  const handle = hub.begin({
    ...PREFETCH_INPUT,
    characters: [{ characterInstanceId: "char_inst_scout" }, { characterInstanceId: "char_inst_scholar" }],
  });

  // 并行在途：两个召回同时挂起，未就绪时 fail-closed 返回 ""。
  await Promise.resolve();
  assert.equal(maxConcurrent, 2, "各角色召回必须并行发起");
  assert.equal(hub.consume(PREFETCH_INPUT.recordId, "char_inst_scout"), "");
  assert.equal(hub.consume(PREFETCH_INPUT.recordId, "char_inst_scholar"), "");

  gates.get("char_inst_scout")!.resolve("- 塞娜记得信使朝北离开。");
  await schedulerTick();
  assert.equal(
    hub.consume(PREFETCH_INPUT.recordId, "char_inst_scout"),
    "- 塞娜记得信使朝北离开。",
  );
  // 未就绪的角色继续 fail-closed。
  assert.equal(hub.consume(PREFETCH_INPUT.recordId, "char_inst_scholar"), "");

  gates.get("char_inst_scholar")!.resolve("- 弥洛注意到蜡封的海盐味。");
  await schedulerTick();
  assert.equal(
    hub.consume(PREFETCH_INPUT.recordId, "char_inst_scholar"),
    "- 弥洛注意到蜡封的海盐味。",
  );

  hub.end(handle);
  assert.equal(hub.consume(PREFETCH_INPUT.recordId, "char_inst_scout"), "");
});

test("prefetch hub fail-closes on recall failure and leaves no session side effects", async (t) => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.warn = originalWarn;
  });

  const hub = createMemoryPrefetchHub({
    recall: async (input) => {
      if (input.characterInstanceId === "char_inst_scout") {
        throw new Error("recall offline");
      }
      return "- 弥洛的召回成功。";
    },
  });
  const handle = hub.begin({
    ...PREFETCH_INPUT,
    characters: [{ characterInstanceId: "char_inst_scout" }, { characterInstanceId: "char_inst_scholar" }],
  });
  await schedulerTick();

  assert.equal(hub.consume(PREFETCH_INPUT.recordId, "char_inst_scout"), "");
  assert.equal(hub.consume(PREFETCH_INPUT.recordId, "char_inst_scholar"), "- 弥洛的召回成功。");
  assert.ok(warnings.some((line) => line.includes("recall offline")));
  hub.end(handle);
});

test("prefetch hub consume without a session returns empty string", () => {
  const hub = createMemoryPrefetchHub({
    recall: () => Promise.resolve("- 不应被调用。"),
  });
  assert.equal(hub.consume("record_missing", "char_inst_scout"), "");
});

test("prefetch hub session replacement isolates late results from the old session", async () => {
  const gates: Array<ReturnType<typeof deferred<string>>> = [];
  let recallIndex = 0;
  const hub = createMemoryPrefetchHub({
    recall: () => gates[recallIndex++]?.promise ?? Promise.resolve(""),
  });

  // 旧会话：插话回合发起的召回迟迟不返回。
  const oldGate = deferred<string>();
  gates.push(oldGate);
  const oldHandle = hub.begin({
    ...PREFETCH_INPUT,
    playerText: "第一回合的玩家输入。",
    characters: [{ characterInstanceId: "char_inst_scout" }],
  });

  // 新会话：下一回合 begin 整体替换旧会话。
  const newGate = deferred<string>();
  gates.push(newGate);
  const newHandle = hub.begin({
    ...PREFETCH_INPUT,
    playerText: "第二回合的玩家输入。",
    characters: [{ characterInstanceId: "char_inst_scout" }],
  });

  // 旧会话的迟到结果不得串入新会话。
  oldGate.resolve("- 旧会话的迟到记忆。");
  newGate.resolve("- 新会话的就绪记忆。");
  await schedulerTick();
  assert.equal(
    hub.consume(PREFETCH_INPUT.recordId, "char_inst_scout"),
    "- 新会话的就绪记忆。",
  );

  // 旧句柄 end 不得误删新会话。
  hub.end(oldHandle);
  assert.equal(
    hub.consume(PREFETCH_INPUT.recordId, "char_inst_scout"),
    "- 新会话的就绪记忆。",
  );
  hub.end(newHandle);
  assert.equal(hub.consume(PREFETCH_INPUT.recordId, "char_inst_scout"), "");
});

/** 让出事件循环，等待已 resolve 的 promise 链完成回写。 */
async function schedulerTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
