/**
 * Record SSE 轮询负担 baseline（一次性脚本，不入测试门）。
 * 对象：app/api/record/events/route.ts 的 createCommittedEventStream
 * （默认 pollIntervalMs=750 / heartbeatIntervalMs=15s）+ fake in-memory
 * service（只计数 listCommittedEvents；不代表 PG EVENTS_SQL/全投影 latency）。
 *
 * 场景：
 *  A. 轮询负载矩阵 K∈{1,2,4} × N∈{50,500,1000}（注入 pollIntervalMs=100 +
 *     maxPolls=30 做 tick 精确测量，约 3s/组合），另跑一组默认 750ms
 *     （maxPolls=4）验证 per-tick 数字一致；
 *  B. 首批补发 vs 持续空轮询分离（首批等待/发送耗时、空轮询率）；
 *  C. Last-Event-ID/after cursor replay：只补缺失 ordinal，重复/乱序即失败；
 *  D. cancel：reader.cancel() 与 AbortSignal 各一次——取消后零新增 poll、
 *     流闭合、无 timer/listener 残留（以调用数冻结 + 流 done 证明）。
 *
 * 用法：node scripts/record-sse-baseline.mjs（可选 DATABASE_URL 仅做
 * loopback guard 校验；本脚本为 fake-only，不连接数据库）。
 */
import { createCommittedEventStream } from "../app/api/record/events/route.ts";
import {
  assertLoopbackDatabaseUrl,
  safeErrorCategory,
  summarizeDurations,
} from "./baseline-common.mjs";

// DATABASE_URL 在本脚本仅作 guard 校验对象（fake-only，不实际连接）。
if (process.env.DATABASE_URL) {
  assertLoopbackDatabaseUrl(process.env.DATABASE_URL);
}

const decoder = new TextDecoder();

function makeEvents(count) {
  const events = [];
  for (let ordinal = 1; ordinal <= count; ordinal += 1) {
    events.push({
      id: `event-${ordinal}`,
      ordinal,
      type: "叙事",
      speaker: "旁白",
      role: "narrator",
      content: `第${ordinal}条合成事件正文，用于测量 SSE 帧字节规模。`,
      worldTime: "纪元 17 年 潮汛 4 日",
      visibility: "公开",
      status: "committed",
    });
  }
  return events;
}

/** fake service：只实现 route 消费的 listCommittedEvents，逐次记录游标与空返。 */
function createFakeService(events) {
  const stats = { calls: 0, emptyCalls: 0, cursors: [] };
  return {
    stats,
    service: {
      async listCommittedEvents(recordId, cursor) {
        stats.calls += 1;
        stats.cursors.push(cursor);
        const batch = events.filter((event) => event.ordinal > cursor);
        if (batch.length === 0) stats.emptyCalls += 1;
        return batch;
      },
    },
  };
}

function parseFrames(chunks) {
  const text = decoder.decode(concat(chunks));
  const frames = text.split("\n\n").filter((frame) => frame.trim());
  const eventIds = [];
  let heartbeatFrames = 0;
  for (const frame of frames) {
    if (frame.startsWith(":")) {
      heartbeatFrames += 1;
      continue;
    }
    const idLine = frame.split("\n").find((line) => line.startsWith("id: "));
    if (idLine) eventIds.push(Number(idLine.slice(4)));
  }
  return { totalBytes: Buffer.byteLength(text), frames: frames.length, eventIds, heartbeatFrames };
}

function concat(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** 驱动一条流直至 done/超时；记录首帧等待与首批发送窗口。 */
async function drainStream(stream, { timeoutMs = 15_000 } = {}) {
  const reader = stream.getReader();
  const chunks = [];
  const startedAt = performance.now();
  let firstFrameAt = null;
  const deadline = setTimeout(() => {
    void reader.cancel();
  }, timeoutMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        if (firstFrameAt === null) {
          firstFrameAt = performance.now();
        }
      }
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  return {
    chunks,
    firstFrameWaitMs: firstFrameAt === null ? null : Number((firstFrameAt - startedAt).toFixed(2)),
    totalMs: Number((performance.now() - startedAt).toFixed(2)),
  };
}

/** 场景 A/B：K 并发 × N 事件的轮询负载（注入短 interval + maxPolls 精确 tick）。 */
async function pollingCombo({ connections, eventCount, pollIntervalMs, maxPolls, heartbeatIntervalMs }) {
  const events = makeEvents(eventCount);
  const fake = createFakeService(events);
  const controller = new AbortController();
  const drains = [];
  for (let index = 0; index < connections; index += 1) {
    const stream = createCommittedEventStream(
      fake.service,
      "record-baseline",
      0,
      controller.signal,
      { pollIntervalMs, heartbeatIntervalMs, maxPolls },
      "principal-baseline",
    );
    drains.push(drainStream(stream));
  }
  const results = await Promise.all(drains);
  const perConnection = results.map((result) => parseFrames(result.chunks));
  const firstWaits = results.map((result) => result.firstFrameWaitMs).filter((v) => v !== null);
  const totalEventFrames = perConnection.reduce((sum, frame) => sum + frame.eventIds.length, 0);
  const totalBytes = perConnection.reduce((sum, frame) => sum + frame.totalBytes, 0);
  const totalHeartbeats = perConnection.reduce((sum, frame) => sum + frame.heartbeatFrames, 0);
  const polls = fake.stats.calls;
  const emptyPolls = fake.stats.emptyCalls;
  return {
    connections,
    eventCount,
    pollIntervalMs,
    maxPolls,
    heartbeatIntervalMs,
    serviceCalls: polls,
    pollsPerConnection: Number((polls / connections).toFixed(2)),
    emptyPolls,
    emptyPollRatio: polls === 0 ? 0 : Number((emptyPolls / polls).toFixed(3)),
    eventsEmitted: totalEventFrames,
    eventsPerConnection: Number((totalEventFrames / connections).toFixed(2)),
    sseBytesTotal: totalBytes,
    bytesPerConnection: Number((totalBytes / connections).toFixed(0)),
    heartbeatFrames: totalHeartbeats,
    firstFrameWaitMs: summarizeDurations(firstWaits),
    // 首批之外的 poll 即空轮询（catch-up 模型下首批恰 1 次/连接）。
    note: "N 事件在 cursor=0 一次性补发：每连接首批 1 次非空 poll，其后全部为空轮询",
  };
}

/** 场景 C：cursor replay——断开后以最后 ordinal 重连，只补缺失事件。 */
async function replayScenario() {
  const events = makeEvents(20);
  const fake = createFakeService(events);
  const controller = new AbortController();
  // 首连：读到 ordinal 7 后取消（模拟断线）。
  const first = createCommittedEventStream(
    fake.service, "record-baseline", 0, controller.signal,
    { pollIntervalMs: 25, heartbeatIntervalMs: 60_000, maxPolls: 1 }, "principal-baseline",
  );
  const firstDrain = await drainStream(first);
  const firstIds = parseFrames(firstDrain.chunks).eventIds;
  const delivered = firstIds.slice(0, 7);
  const lastDelivered = delivered.at(-1) ?? 0;
  // 重连：Last-Event-ID 语义（initialOrdinal=lastDelivered），只补 8..20。
  const resumed = createCommittedEventStream(
    fake.service, "record-baseline", lastDelivered, controller.signal,
    { pollIntervalMs: 25, heartbeatIntervalMs: 60_000, maxPolls: 1 }, "principal-baseline",
  );
  const resumedDrain = await drainStream(resumed);
  const resumedIds = parseFrames(resumedDrain.chunks).eventIds;
  const expected = Array.from({ length: 20 - lastDelivered }, (_, index) => lastDelivered + 1 + index);
  const strictlyIncreasing = resumedIds.every((id, index) => index === 0 || id > resumedIds[index - 1]);
  const noDuplicates = new Set(resumedIds).size === resumedIds.length;
  const exactReplay = JSON.stringify(resumedIds) === JSON.stringify(expected);
  return {
    firstConnection: { polls: 1, deliveredBeforeDisconnect: delivered.length, lastDeliveredOrdinal: lastDelivered },
    resumed: {
      eventIds: resumedIds,
      expectedIds: expected,
      exactReplay,
      strictlyIncreasing,
      noDuplicates,
    },
    pass: exactReplay && strictlyIncreasing && noDuplicates,
  };
}

/** 场景 D：cancel——reader.cancel() 与 AbortSignal 取消后零新增 poll。 */
async function cancelScenario(mode) {
  const events = makeEvents(5);
  const fake = createFakeService(events);
  const controller = new AbortController();
  const stream = createCommittedEventStream(
    fake.service, "record-baseline", 0, controller.signal,
    { pollIntervalMs: 100, heartbeatIntervalMs: 60_000, maxPolls: 100 }, "principal-baseline",
  );
  const reader = stream.getReader();
  // 读掉首批（1 次非空 poll + 空转若干），然后取消。
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const callsBeforeCancel = fake.stats.calls;
  if (mode === "reader-cancel") {
    await reader.cancel();
  } else {
    controller.abort();
  }
  let closed = false;
  try {
    // abort 模式下控制器 close 前已入队的帧仍会先交付——必须读干队列
    // 直到 done，而不是只读一帧判关闭。
    const deadlineAt = Date.now() + 1_000;
    for (;;) {
      const next = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), Math.max(1, deadlineAt - Date.now()))),
      ]);
      if (next === "timeout") break;
      if (next.done) {
        closed = true;
        break;
      }
    }
  } catch {
    closed = true;
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  const callsAfterCancel = fake.stats.calls - callsBeforeCancel;
  reader.releaseLock();
  return {
    mode,
    callsBeforeCancel,
    callsAfterCancel,
    streamClosed: closed,
    pass: callsAfterCancel === 0 && closed,
  };
}

try {
  const matrix = [];
  for (const eventCount of [50, 500, 1000]) {
    for (const connections of [1, 2, 4]) {
      matrix.push(await pollingCombo({
        connections,
        eventCount,
        pollIntervalMs: 100,
        maxPolls: 30,
        heartbeatIntervalMs: 250,
      }));
    }
  }
  // 默认 750ms 验证组（maxPolls=4 ≈ 3s）：per-tick 数字应与注入组一致。
  const defaultInterval = await pollingCombo({
    connections: 2,
    eventCount: 500,
    pollIntervalMs: 750,
    maxPolls: 4,
    heartbeatIntervalMs: 15_000,
  });
  const replay = await replayScenario();
  const cancels = [
    await cancelScenario("reader-cancel"),
    await cancelScenario("abort-signal"),
  ];
  const assertionsPass = replay.pass && cancels.every((entry) => entry.pass);
  const report = {
    scenario: "record-sse-polling-baseline",
    subject: "app/api/record/events/route.ts createCommittedEventStream（默认 pollIntervalMs=750/heartbeat=15s；矩阵组注入 100ms×30 tick 归一，验证组为真实默认 750ms）",
    service: "fake in-memory（只证明轮询策略与帧/字节形态；不代表 PG EVENTS_SQL/全投影 latency）",
    matrix,
    defaultIntervalValidation: defaultInterval,
    replay,
    cancels,
    assertionsPass,
  };
  console.log(JSON.stringify(report, null, 2));
  for (const combo of matrix) {
    console.error(
      `[summary] K=${combo.connections} N=${combo.eventCount} polls/conn=${combo.pollsPerConnection} `
      + `empty=${(combo.emptyPollRatio * 100).toFixed(1)}% bytes/conn=${combo.bytesPerConnection} `
      + `events/conn=${combo.eventsPerConnection} hb=${combo.heartbeatFrames}`,
    );
  }
  console.error(
    `[summary] default-750ms K=2 N=500 polls/conn=${defaultInterval.pollsPerConnection} `
    + `empty=${(defaultInterval.emptyPollRatio * 100).toFixed(1)}% hb=${defaultInterval.heartbeatFrames}`,
  );
  console.error(`[summary] replay pass=${replay.pass} cancels=${cancels.map((c) => `${c.mode}:${c.pass}`).join(",")}`);
  if (!assertionsPass) {
    console.error("[baseline] replay/cancel assertions FAILED");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`[baseline] failed: ${safeErrorCategory(error)}`);
  process.exitCode = 1;
}
