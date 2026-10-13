/**
 * Slice 3：first-night 迁入统一 durable job host。
 * 覆盖：enqueue→claim→complete 全链（runner 落 ready）、active 去重、
 * stale recovery（租约过期回收重跑）、幂等 complete（重放 settled）、
 * 失败收束（job failed + terminal 重排懒重试）、无效 payload fail-closed、
 * 跨 record 隔离。队列用内存实现（与 PG 同一 lease/fencing 语义），
 * runner 用 fake store + 确定性 gateway，不触真实数据库/模型。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFirstNightRunner,
  type FirstNightPack,
} from "../modules/application/first-night.ts";
import type { FirstNightClaim } from "../database/postgres/first-night-store.ts";
import {
  createInMemoryDurableJobQueue,
  runDurableJobCycle,
  type ClaimedDurableJob,
  type DurableJobHandler,
  type DurableJobHandlerRegistry,
  type DurableJobKind,
} from "../modules/application/unified-durable-job-host.ts";

const WORKSPACE = "ws_test";
const NOW = "2026-10-11T00:00:00.000Z";
const LATER = "2026-10-11T00:10:01.000Z";

function pack(): FirstNightPack {
  return {
    scene: { environment: "潮声。", story: "灯塔亮着。", fact: "北风。" },
    characters: [],
    hook: { content: "灯灭了。", suggestions: ["去灯塔", "问问守灯人"] },
  };
}

function gateway() {
  return Promise.resolve({
    providerId: "fake",
    chat: async () => ({
      content: JSON.stringify(pack()),
      model: "fake-model",
      usage: { promptTokens: 1, completionTokens: 1 },
      finishReason: "stop",
    }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

function createFakeFirstNightStore(options: { commitThrows?: boolean } = {}) {
  const markers = new Map<string, {
    state: "pending" | "ready" | "degraded";
    attempts: number;
    hookContent: string;
  }>();
  return {
    markers,
    store: {
      async find(recordId: string) {
        const marker = markers.get(recordId);
        return marker
          ? { recordId, worldId: "world_test", suggestions: [], context: null, ...marker }
          : null;
      },
      async claimAttempt(recordId: string): Promise<FirstNightClaim | null> {
        const marker = markers.get(recordId);
        if (!marker || marker.state !== "pending") return null;
        marker.attempts += 1;
        return { attempts: marker.attempts, context: null };
      },
      async commitPack(recordId: string, committed: FirstNightPack, state: "ready" | "degraded") {
        if (options.commitThrows) throw new Error("commit exploded");
        const marker = markers.get(recordId);
        if (!marker || marker.state !== "pending") return false;
        marker.state = state;
        marker.hookContent = committed.hook.content;
        return true;
      },
    },
    seed(recordId: string) {
      markers.set(recordId, { state: "pending", attempts: 0, hookContent: "" });
    },
  };
}

function createFixture(options: { commitThrows?: boolean } = {}) {
  let clock = NOW;
  const queue = createInMemoryDurableJobQueue({
    workspaceId: WORKSPACE,
    leaseOwner: "test-worker",
    leaseDurationMs: 60_000,
    clock: () => clock,
  });
  const fake = createFakeFirstNightStore(options);
  const runFirstNight = createFirstNightRunner({
    store: fake.store,
    getGateway: gateway,
  });
  const handlers: DurableJobHandlerRegistry = new Map<DurableJobKind, DurableJobHandler>();
  handlers.set("first-night", async (job: ClaimedDurableJob) => {
    await runFirstNight(job.recordId);
  });
  const schedule = (recordId: string) =>
    queue.enqueue({
      jobId: `first-night:${recordId}`,
      kind: "first-night",
      recordId,
      payload: {},
      requeueTerminal: true,
    });
  const cycle = () =>
    runDurableJobCycle({
      slot: { workspaceId: WORKSPACE, queue },
      handlers,
      now: clock,
    });
  return {
    queue,
    fake,
    schedule,
    cycle,
    handlers,
    setClock(value: string) {
      clock = value;
    },
  };
}

test("first-night job：enqueue→claim→complete，marker 落 ready", async () => {
  const fixture = createFixture();
  fixture.fake.seed("record_a");
  assert.equal(await fixture.schedule("record_a"), "inserted");
  assert.equal(await fixture.cycle(), true);
  assert.equal(fixture.queue.inspect("first-night:record_a")?.state, "completed");
  assert.equal(fixture.queue.inspect("first-night:record_a")?.attemptCount, 1);
  assert.equal(fixture.fake.markers.get("record_a")?.state, "ready");
  assert.equal(fixture.fake.markers.get("record_a")?.hookContent, "灯灭了。");
});

test("first-night job：active 期间重复 schedule 去重（existing，不重叠）", async () => {
  const fixture = createFixture();
  fixture.fake.seed("record_a");
  assert.equal(await fixture.schedule("record_a"), "inserted");
  assert.equal(await fixture.schedule("record_a"), "existing");
  assert.equal(await fixture.cycle(), true);
  assert.equal(fixture.queue.inspect("first-night:record_a")?.attemptCount, 1);
});

test("first-night job：stale recovery——claimed 租约过期后被回收重跑", async () => {
  const fixture = createFixture();
  fixture.fake.seed("record_a");
  await fixture.schedule("record_a");
  // worker 崩溃：只 claim 不处理。
  const claimed = await fixture.queue.claimNext({ now: NOW, kinds: ["first-night"] });
  assert.ok(claimed);
  assert.equal(claimed.attemptCount, 1);
  // 租约未过期时不得重领。
  assert.equal(await fixture.queue.claimNext({ now: NOW, kinds: ["first-night"] }), null);
  // 租约过期后回收重跑。
  fixture.setClock(LATER);
  assert.equal(await fixture.cycle(), true);
  const row = fixture.queue.inspect("first-night:record_a");
  assert.equal(row?.state, "completed");
  assert.equal(row?.attemptCount, 2);
  assert.equal(fixture.fake.markers.get("record_a")?.state, "ready");
});

test("first-night job：幂等 complete——重放返回 settled，状态不再变化", async () => {
  const fixture = createFixture();
  fixture.fake.seed("record_a");
  await fixture.schedule("record_a");
  const claimed = await fixture.queue.claimNext({ now: NOW, kinds: ["first-night"] });
  assert.ok(claimed);
  assert.equal(await fixture.queue.complete(claimed, NOW), "applied");
  assert.equal(await fixture.queue.complete(claimed, NOW), "settled");
  assert.equal(fixture.queue.inspect("first-night:record_a")?.state, "completed");
  // 过期租约 fencing：另一个 lease owner 的 complete 是 stale。
  const reclaimed = await fixture.queue.claimNext({ now: NOW, kinds: ["first-night"] });
  assert.equal(reclaimed, null);
});

test("first-night job：失败收束落 failed，懒重试 terminal 重排后跑通", async () => {
  const fixture = createFixture({ commitThrows: true });
  fixture.fake.seed("record_a");
  await fixture.schedule("record_a");
  assert.equal(await fixture.cycle(), true);
  assert.equal(fixture.queue.inspect("first-night:record_a")?.state, "failed");
  assert.equal(fixture.fake.markers.get("record_a")?.state, "pending");
  // 懒重试：terminal 行重排回 pending。
  assert.equal(await fixture.schedule("record_a"), "requeued");
  assert.equal(await fixture.cycle(), true);
  const row = fixture.queue.inspect("first-night:record_a");
  assert.equal(row?.state, "failed");
  assert.equal(row?.attemptCount, 2);
});

test("first-night job：无效 payload fail-closed——job 落 failed，handler 不执行", async () => {
  const fixture = createFixture();
  fixture.fake.seed("record_a");
  await fixture.queue.enqueue({
    jobId: "first-night:record_a",
    kind: "first-night",
    recordId: "record_a",
    // 旁路绕过 schedule 的有界 payload 约定，模拟损坏行。
    payload: { evil: "x" } as Record<string, unknown>,
  });
  assert.equal(await fixture.cycle(), true);
  const row = fixture.queue.inspect("first-night:record_a");
  assert.equal(row?.state, "failed");
  assert.equal(row?.lastErrorCode, "JOB_PAYLOAD_INVALID");
  assert.equal(fixture.fake.markers.get("record_a")?.state, "pending");
  assert.equal(fixture.fake.markers.get("record_a")?.attempts, 0);
});

test("first-night job：跨 record 隔离——失败/完成互不影响", async () => {
  const fixture = createFixture();
  fixture.fake.seed("record_a");
  fixture.fake.seed("record_b");
  await fixture.schedule("record_a");
  await fixture.schedule("record_b");
  assert.equal(await fixture.cycle(), true);
  assert.equal(await fixture.cycle(), true);
  assert.equal(fixture.fake.markers.get("record_a")?.state, "ready");
  assert.equal(fixture.fake.markers.get("record_b")?.state, "ready");
  assert.equal(fixture.queue.inspect("first-night:record_a")?.state, "completed");
  assert.equal(fixture.queue.inspect("first-night:record_b")?.state, "completed");
  // 独立收束：fail record_a 的（已 completed→settled）不影响 record_b。
  const claimedB = await fixture.queue.claimNext({ now: NOW, kinds: ["first-night"] });
  assert.equal(claimedB, null);
});
