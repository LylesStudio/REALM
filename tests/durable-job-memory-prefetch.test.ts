/**
 * Slice 3：memory prefetch 重召回迁入统一 durable job host。
 * 覆盖：begin 只入队（信封快路径不变，consume 同步 fail-closed ""）→
 * claimed job 执行召回 → deliver 回灌当前会话 → consume 取到结果；
 * stale recovery（租约过期回收重跑）、幂等 complete、失败收束（召回失败
 * job failed 且 consume 仍 ""）、迟到结果会话隔离、跨 record 隔离、
 * 无效 payload fail-closed。队列用内存实现，不触真实数据库。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryPrefetchHub } from "../modules/memory/pipeline.ts";
import {
  createInMemoryDurableJobQueue,
  parseMemoryPrefetchJobPayload,
  runDurableJobCycle,
  type ClaimedDurableJob,
  type DurableJobHandler,
  type DurableJobHandlerRegistry,
  type DurableJobKind,
} from "../modules/application/unified-durable-job-host.ts";

const WORKSPACE = "ws_test";
const NOW = "2026-10-11T00:00:00.000Z";
const LATER = "2026-10-11T00:10:01.000Z";

function createFixture(options: { recallThrows?: boolean } = {}) {
  let clock = NOW;
  const queue = createInMemoryDurableJobQueue({
    workspaceId: WORKSPACE,
    leaseOwner: "test-worker",
    leaseDurationMs: 60_000,
    clock: () => clock,
  });
  const recallCalls: string[] = [];
  const recall = async (input: { characterInstanceId: string; query: string }) => {
    recallCalls.push(`${input.characterInstanceId}:${input.query}`);
    if (options.recallThrows) throw new Error("recall exploded");
    return `- ${input.characterInstanceId} 记得 ${input.query}`;
  };
  const hub = createMemoryPrefetchHub({
    recall,
    dispatch: (input) => {
      void queue.enqueue({
        jobId: `memory-prefetch:test:${input.recordId}:${input.sessionId}:${input.characterInstanceId}`,
        kind: "memory-prefetch",
        recordId: input.recordId,
        payload: {
          sessionId: input.sessionId,
          worldId: input.worldId,
          worldlineId: input.worldlineId,
          characterInstanceId: input.characterInstanceId,
          query: input.playerText,
        },
      }).catch(() => undefined);
    },
  });
  const handlers: DurableJobHandlerRegistry = new Map<DurableJobKind, DurableJobHandler>();
  handlers.set("memory-prefetch", async (job: ClaimedDurableJob) => {
    const payload = parseMemoryPrefetchJobPayload(job.payload);
    if (!payload) {
      throw Object.assign(new Error("invalid"), { code: "PREFETCH_JOB_PAYLOAD_INVALID" });
    }
    const content = await recall({
      characterInstanceId: payload.characterInstanceId,
      query: payload.query,
    });
    hub.deliver?.({
      recordId: job.recordId,
      sessionId: payload.sessionId,
      characterInstanceId: payload.characterInstanceId,
      content,
    });
  });
  const cycle = () =>
    runDurableJobCycle({
      slot: { workspaceId: WORKSPACE, queue },
      handlers,
      now: clock,
    });
  const beginInput = (recordId: string) => ({
    recordId,
    workspaceId: WORKSPACE,
    worldId: "world_test",
    worldlineId: "worldline_test",
    playerText: "灯塔",
    characters: [{ characterInstanceId: "char_a" }, { characterInstanceId: "char_b" }],
  });
  const flush = async () => {
    // dispatch 的 enqueue 是 fire-and-forget；等待 microtask 落地。
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };
  return {
    queue,
    hub,
    handlers,
    cycle,
    recallCalls,
    beginInput,
    flush,
    setClock(value: string) {
      clock = value;
    },
  };
}

test("memory-prefetch job：begin 入队→claimed 召回→deliver→consume；快路径不等待", async () => {
  const fixture = createFixture();
  const handle = fixture.hub.begin(fixture.beginInput("record_a"));
  // 快路径：召回未完成时 consume 同步 fail-closed ""。
  assert.equal(fixture.hub.consume("record_a", "char_a"), "");
  await fixture.flush();
  assert.equal(await fixture.cycle(), true);
  assert.equal(await fixture.cycle(), true);
  assert.equal(await fixture.cycle(), false);
  assert.equal(fixture.hub.consume("record_a", "char_a"), "- char_a 记得 灯塔");
  assert.equal(fixture.hub.consume("record_a", "char_b"), "- char_b 记得 灯塔");
  fixture.hub.end(handle);
  assert.equal(fixture.hub.consume("record_a", "char_a"), "");
  assert.deepEqual(fixture.recallCalls, ["char_a:灯塔", "char_b:灯塔"]);
});

test("memory-prefetch job：stale recovery——claimed 租约过期回收重跑后送达", async () => {
  const fixture = createFixture();
  fixture.hub.begin(fixture.beginInput("record_a"));
  await fixture.flush();
  // worker 崩溃：claim 后不处理。
  const claimed = await fixture.queue.claimNext({ now: NOW, kinds: ["memory-prefetch"] });
  assert.ok(claimed);
  fixture.setClock(LATER);
  await fixture.cycle();
  await fixture.cycle();
  assert.equal(fixture.hub.consume("record_a", "char_a"), "- char_a 记得 灯塔");
  assert.equal(fixture.hub.consume("record_a", "char_b"), "- char_b 记得 灯塔");
  // 崩溃 claim 的 attempt 被重领：两 job 各自 completed。
  assert.equal(
    fixture.queue.inspect(`memory-prefetch:test:record_a:1:char_a`)?.state,
    "completed",
  );
});

test("memory-prefetch job：幂等 complete——重放 settled，deliver 不重复", async () => {
  const fixture = createFixture();
  fixture.hub.begin(fixture.beginInput("record_a"));
  await fixture.flush();
  const claimed = await fixture.queue.claimNext({ now: NOW, kinds: ["memory-prefetch"] });
  assert.ok(claimed);
  assert.equal(await fixture.queue.complete(claimed, NOW), "applied");
  assert.equal(await fixture.queue.complete(claimed, NOW), "settled");
  assert.equal(await fixture.queue.fail(claimed, "X", NOW), "stale");
});

test("memory-prefetch job：召回失败收束 failed，consume 保持 fail-closed \"\"", async () => {
  const fixture = createFixture({ recallThrows: true });
  fixture.hub.begin(fixture.beginInput("record_a"));
  await fixture.flush();
  await fixture.cycle();
  await fixture.cycle();
  assert.equal(fixture.hub.consume("record_a", "char_a"), "");
  const row = fixture.queue.inspect("memory-prefetch:test:record_a:1:char_a");
  assert.equal(row?.state, "failed");
  assert.equal(row?.lastErrorCode, "unknown");
});

test("memory-prefetch job：迟到结果按会话标识隔离——替换会话后旧结果丢弃", async () => {
  const fixture = createFixture();
  const first = fixture.hub.begin(fixture.beginInput("record_a"));
  await fixture.flush();
  // 同 record 再次 begin 整体替换旧会话。
  const second = fixture.hub.begin(fixture.beginInput("record_a"));
  await fixture.flush();
  // 旧会话（session 1）的 job 跑完，deliver 被会话标识隔离丢弃。
  await fixture.cycle();
  await fixture.cycle();
  assert.equal(fixture.hub.consume("record_a", "char_a"), "");
  // 新会话（session 2）的 job 跑完正常送达。
  await fixture.cycle();
  await fixture.cycle();
  assert.equal(fixture.hub.consume("record_a", "char_a"), "- char_a 记得 灯塔");
  fixture.hub.end(first);
  fixture.hub.end(second);
});

test("memory-prefetch job：无效 payload fail-closed——job 落 failed，不召回", async () => {
  const fixture = createFixture();
  await fixture.queue.enqueue({
    jobId: "memory-prefetch:test:record_a:9:char_a",
    kind: "memory-prefetch",
    recordId: "record_a",
    payload: { sessionId: "not-a-number" },
  });
  assert.equal(await fixture.cycle(), true);
  const row = fixture.queue.inspect("memory-prefetch:test:record_a:9:char_a");
  assert.equal(row?.state, "failed");
  assert.equal(row?.lastErrorCode, "JOB_PAYLOAD_INVALID");
  assert.deepEqual(fixture.recallCalls, []);
});

test("memory-prefetch job：跨 record 隔离——各自会话各自召回互不影响", async () => {
  const fixture = createFixture();
  fixture.hub.begin(fixture.beginInput("record_a"));
  fixture.hub.begin(fixture.beginInput("record_b"));
  await fixture.flush();
  for (let index = 0; index < 4; index += 1) await fixture.cycle();
  assert.equal(fixture.hub.consume("record_a", "char_a"), "- char_a 记得 灯塔");
  assert.equal(fixture.hub.consume("record_b", "char_a"), "- char_a 记得 灯塔");
  assert.equal(fixture.hub.consume("record_b", "char_b"), "- char_b 记得 灯塔");
  assert.equal(
    fixture.queue.inspect("memory-prefetch:test:record_a:1:char_a")?.state,
    "completed",
  );
  assert.equal(
    fixture.queue.inspect("memory-prefetch:test:record_b:2:char_a")?.state,
    "completed",
  );
});
