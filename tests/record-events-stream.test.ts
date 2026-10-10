/**
 * Phase 2G-B：Record committed-event SSE 生产装配与唤醒流行为。
 * 真实 route seam（createCommittedEventStream / handleCommittedEventsGet）+
 * fake wakeup + 真实 LocalRecordService interface（内存 fake 实现）：
 * 初次 replay 一次、无轮询；wake 按 cursor 重读；串行无重复；abort/cancel
 * 清理；LISTEN 失败安全关流；production GET 装配 LISTEN/wakeup 的源码 guard。
 * 纯内存测试：不连接任何真实数据库。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createCommittedEventStream,
  handleCommittedEventsGet,
} from "../app/api/record/events/route.ts";
import {
  LOCAL_RECORD_SCOPE,
  type LocalRecordService,
} from "../modules/application/local-record-service.ts";
import type { ProjectionEvent } from "../modules/application/legacy-record-projection-types.ts";
import type { RecordCommittedWakeupScope } from "../database/postgres/record-events.ts";

const decoder = new TextDecoder();

function fakeEvent(ordinal: number, content: string): ProjectionEvent {
  return {
    id: `event_${ordinal}`,
    ordinal,
    type: "narration",
    speaker: "旁白",
    speakerParticipantId: null,
    role: "narrator",
    content,
    segments: [],
    worldTime: "停战纪元17年 · 雾月12日 · 入夜",
    status: "committed",
  } as unknown as ProjectionEvent;
}

interface FakeService {
  service: LocalRecordService;
  calls: number[];
  events: ProjectionEvent[];
}

function fakeService(initial: ProjectionEvent[]): FakeService {
  const state: FakeService = {
    calls: [],
    events: [...initial],
    service: undefined as unknown as LocalRecordService,
  };
  state.service = {
    async loadRecord() {
      throw new Error("not used");
    },
    async openDefaultRecord() {
      throw new Error("not used");
    },
    async submitMessage() {
      throw new Error("not used");
    },
    async startSelfPlay() {
      throw new Error("not used");
    },
    async stopSelfPlay() {
      throw new Error("not used");
    },
    async listCommittedEvents(_recordId: string, afterOrdinal: number) {
      state.calls.push(afterOrdinal);
      return state.events.filter((event) => event.ordinal > afterOrdinal);
    },
    async authorizeRecordViewer() {
      return undefined;
    },
    cancelMessage() {
      return false;
    },
    subscribePreviews() {
      return () => {};
    },
  };
  return state;
}

/** 与 listenRecordCommitted 相同的缓冲语义：无 waiter 时唤醒计数缓冲。 */
function fakeWakeup(options: { fail?: boolean } = {}) {
  const scopes: RecordCommittedWakeupScope[] = [];
  const waiters: Array<(wake: boolean) => void> = [];
  let pending = 0;
  let closed = false;
  return {
    scopes,
    isClosed: () => closed,
    factory: async (scope: RecordCommittedWakeupScope) => {
      scopes.push(scope);
      if (options.fail) throw new Error("LISTEN failed");
      return {
        wait: () => {
          if (closed) return Promise.resolve(false);
          if (pending > 0) {
            pending -= 1;
            return Promise.resolve(true);
          }
          return new Promise<boolean>((resolve) => waiters.push(resolve));
        },
        close: async () => {
          closed = true;
          while (waiters.length > 0) waiters.shift()!(false);
        },
      };
    },
    wake: () => {
      const waiter = waiters.shift();
      if (waiter) waiter(true);
      else pending += 1;
    },
  };
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 2000,
): Promise<string> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("read timeout")), timeoutMs),
    ),
  ]);
  assert.equal(result.done, false, "stream closed unexpectedly");
  return decoder.decode(result.value);
}

async function tick(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("wakeup stream replays once, never polls, and re-reads by cursor on wake", async () => {
  const { service, calls, events } = fakeService([fakeEvent(1, "雾沿着石阶爬上防波堤。")]);
  const wakeup = fakeWakeup();
  const abort = new AbortController();
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    abort.signal,
    { wakeup: wakeup.factory, heartbeatIntervalMs: Number.POSITIVE_INFINITY },
  );
  const reader = stream.getReader();

  const first = await readChunk(reader);
  assert.match(first, /^id: 1\nevent: committed\ndata: /);
  assert.match(first, /雾沿着石阶爬上防波堤/);

  // 初次 replay 只 list 一次；无唤醒时绝不轮询。
  assert.deepEqual(calls, [0]);
  await tick(60);
  assert.deepEqual(calls, [0], "生产唤醒模式不得出现 750ms 轮询");

  // wakeup factory 按 workspace+record 作用域装配。
  assert.deepEqual(wakeup.scopes, [
    { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, recordId: LOCAL_RECORD_SCOPE.recordId },
  ]);

  // wake：按 viewer cursor 重读 ledger，只发送新 committed event。
  events.push(fakeEvent(2, "灯塔在远处亮了一下。"));
  wakeup.wake();
  const second = await readChunk(reader);
  assert.match(second, /^id: 2\nevent: committed\ndata: /);
  assert.deepEqual(calls, [0, 1], "wake 后必须按 cursor 重读");

  // 空 wake（无新事件）：按最新 cursor 重读发生但不产生帧。
  wakeup.wake();
  await tick(30);
  assert.deepEqual(calls, [0, 1, 2]);
  abort.abort();
  assert.equal((await reader.read()).done, true);
});

test("concurrent wakes are serialized and deduplicated by cursor", async () => {
  const { service, calls, events } = fakeService([fakeEvent(1, "开场。")]);
  const wakeup = fakeWakeup();
  const abort = new AbortController();
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    abort.signal,
    { wakeup: wakeup.factory, heartbeatIntervalMs: Number.POSITIVE_INFINITY },
  );
  const reader = stream.getReader();
  await readChunk(reader);
  assert.deepEqual(calls, [0]);

  // 多个唤醒在 drain 期间到达：缓冲合并、串行重读、cursor 去重。
  events.push(fakeEvent(2, "第二拍。"), fakeEvent(3, "第三拍。"));
  wakeup.wake();
  wakeup.wake();
  wakeup.wake();
  const frames = [await readChunk(reader), await readChunk(reader)];
  assert.deepEqual(
    frames.map((frame) => frame.match(/^id: (\d+)/)![1]),
    ["2", "3"],
    "事件必须按序、不重复",
  );
  await tick(30);
  // 每次重读以上次送达的 cursor 前进；缓冲的重复 wake 只导致空重读。
  assert.ok(calls.every((cursor, index) => index === 0 || cursor >= 1));
  const lists = calls.length;
  await tick(40);
  assert.equal(calls.length, lists, "wake 消费完后不得继续轮询");
  abort.abort();
  await reader.read();
});

test("abort and cancel close the wakeup source and stop querying", async () => {
  const { service, calls } = fakeService([fakeEvent(1, "开场。")]);
  const wakeup = fakeWakeup();
  const abort = new AbortController();
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    abort.signal,
    { wakeup: wakeup.factory, heartbeatIntervalMs: Number.POSITIVE_INFINITY },
  );
  const reader = stream.getReader();
  await readChunk(reader);
  abort.abort();
  assert.equal((await reader.read()).done, true);
  assert.equal(wakeup.isClosed(), true, "abort 必须回收专用 wakeup 源");
  const listsAtAbort = calls.length;
  await tick(40);
  assert.equal(calls.length, listsAtAbort, "abort 后不得继续查询");

  // cancel 路径同样清理。
  const second = fakeService([]);
  const secondWakeup = fakeWakeup();
  const secondStream = createCommittedEventStream(
    second.service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    new AbortController().signal,
    { wakeup: secondWakeup.factory, heartbeatIntervalMs: Number.POSITIVE_INFINITY },
  );
  const secondReader = secondStream.getReader();
  await tick(10);
  await secondReader.cancel();
  assert.equal(secondWakeup.isClosed(), true, "cancel 必须回收专用 wakeup 源");
  const secondLists = second.calls.length;
  await tick(40);
  assert.equal(second.calls.length, secondLists);
});

test("LISTEN/connect failure closes the stream safely without querying or polling", async () => {
  const { service, calls } = fakeService([fakeEvent(1, "开场。")]);
  const wakeup = fakeWakeup({ fail: true });
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    new AbortController().signal,
    { wakeup: wakeup.factory, heartbeatIntervalMs: Number.POSITIVE_INFINITY },
  );
  const reader = stream.getReader();
  assert.equal((await reader.read()).done, true, "LISTEN 失败必须安全关流");
  await tick(40);
  assert.deepEqual(calls, [], "LISTEN 失败不得回退轮询或继续查询");
});

test("wakeup stream still projects events through the service projection", async () => {
  const { service } = fakeService([fakeEvent(1, "投影内容。")]);
  const wakeup = fakeWakeup();
  const abort = new AbortController();
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    abort.signal,
    { wakeup: wakeup.factory, heartbeatIntervalMs: Number.POSITIVE_INFINITY },
  );
  const reader = stream.getReader();
  const frame = await readChunk(reader);
  const data = JSON.parse(frame.match(/^data: (.*)$/m)![1]!) as {
    event: Record<string, unknown>;
  };
  assert.equal(data.event.content, "投影内容。");
  assert.equal(data.event.status, "committed");
  assert.doesNotMatch(frame, /candidate|manifest|token|connectionString/i);
  abort.abort();
  await reader.read();
});

test("legacy test seam keeps maxPolls fallback when no wakeup is provided", async () => {
  const { service, calls } = fakeService([fakeEvent(1, "开场。")]);
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    new AbortController().signal,
    { maxPolls: 1, heartbeatIntervalMs: Number.POSITIVE_INFINITY },
  );
  const text = await new Response(stream).text();
  assert.match(text, /^id: 1\nevent: committed\ndata: /);
  assert.deepEqual(calls, [0]);

  const replay = handleCommittedEventsGet(
    new Request("http://localhost/api/record/events?afterOrdinal=1"),
    service,
    { maxPolls: 1 },
  );
  assert.equal(await replay.text(), "");
});

test("production GET wires LISTEN wakeup and never falls back to 750ms polling", () => {
  const route = readFileSync(
    fileURLToPath(new URL("../app/api/record/events/route.ts", import.meta.url)),
    "utf8",
  );
  const getStart = route.indexOf("export async function GET(");
  const seamStart = route.indexOf("export function handleCommittedEventsGet(");
  assert.ok(getStart > 0 && seamStart > getStart, "production GET 必须存在");
  const productionGet = route.slice(getStart, seamStart);

  // 生产装配：显式 LISTEN/wakeup，且不把轮询参数传进生产路径。
  assert.match(productionGet, /REALM_RUNTIME_DATABASE_URL/);
  assert.match(productionGet, /listenRecordCommitted/);
  assert.match(productionGet, /wakeup/);
  assert.match(productionGet, /503/);
  assert.doesNotMatch(
    productionGet,
    /pollIntervalMs|maxPolls|setTimeout|setInterval/,
    "production GET 不得装配任何轮询参数",
  );

  // 轮询默认值只允许留在测试 seam 的 legacy 分支里。
  const seam = route.slice(seamStart);
  assert.match(seam, /options\.wakeup/, "stream 必须区分 wakeup 与 legacy 轮询");
  assert.match(seam, /options\.pollIntervalMs \?\? 750/);
});
