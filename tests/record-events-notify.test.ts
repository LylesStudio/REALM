/**
 * Phase 2G-B：Record committed-event NOTIFY 唤醒契约。
 * - withRecordCommittedNotify 把 pg_notify 折叠进调用方写语句，channel/payload
 *   全部参数绑定，payload 白名单最小字段，不增加净查询数（回合 DB 预算围栏）；
 * - parseRecordCommittedWakeup 严格白名单解析；
 * - listenRecordCommitted 专用 LISTEN 连接的唤醒/过滤/关闭语义（fake client seam）；
 * - commitRelease 源码契约：事务内 notify，幂等早返回不重复 notify。
 * 纯内存测试：不连接任何真实数据库。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  RECORD_COMMITTED_CHANNEL,
  listenRecordCommitted,
  parseRecordCommittedWakeup,
  recordCommittedWakeupPayload,
  withRecordCommittedNotify,
  type RecordCommittedListenClient,
} from "../database/postgres/record-events.ts";

function readProjectFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const SCOPE = { workspaceId: "workspace_test", recordId: "record_test" };

interface CapturedQuery {
  text: string;
  values: readonly unknown[] | undefined;
}

function fakeTransactionalClient() {
  const queries: CapturedQuery[] = [];
  return {
    queries,
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
  };
}

test("withRecordCommittedNotify folds pg_notify into the caller statement with bound params", async () => {
  const client = fakeTransactionalClient();
  const statement = withRecordCommittedNotify(
    {
      update: "UPDATE command_inbox SET state = 'completed'",
      where: "workspace_id = $1 AND id = $2",
      values: [SCOPE.workspaceId, "turn_1"],
    },
    { workspaceId: SCOPE.workspaceId, recordId: SCOPE.recordId, nextOrdinal: 42 },
  );
  await client.query(statement.text, statement.values);
  assert.equal(
    client.queries.length,
    1,
    "唤醒折叠进最后一条写语句，不得增加净查询数（回合 DB 预算围栏）",
  );
  const { text, values } = client.queries[0]!;
  // 不拼接 SQL identifier/值：channel 与 payload 是追加的绑定参数 $3/$4。
  assert.match(
    text,
    /^WITH record_committed_wakeup AS \(\s*SELECT pg_notify\(\$3, \$4\)\s*\)\nUPDATE command_inbox/,
  );
  // PG17 会跳过未引用的 SELECT CTE——必须经 EXISTS 引用保证 NOTIFY 执行。
  assert.match(
    text,
    /WHERE workspace_id = \$1 AND id = \$2\s+AND EXISTS \(SELECT 1 FROM record_committed_wakeup\)$/,
  );
  assert.doesNotMatch(text, /'record_committed'/);
  assert.equal(values!.length, 4);
  assert.equal(values![2], RECORD_COMMITTED_CHANNEL);
  assert.match(RECORD_COMMITTED_CHANNEL, /^[a-z][a-z0-9_]*$/);
  const payload = JSON.parse(values![3] as string) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ["nextOrdinal", "recordId", "workspaceId"],
    "payload 仅含最小唤醒字段白名单",
  );
  assert.equal(payload.workspaceId, SCOPE.workspaceId);
  assert.equal(payload.recordId, SCOPE.recordId);
  assert.equal(payload.nextOrdinal, 42);
  assert.doesNotMatch(
    values![3] as string,
    /token|secret|password|credential|postgres(ql)?:\/\/|"payload"|"content"|"event"/i,
    "payload 不得携带事件内容、token、连接串或凭据",
  );
  // payload builder 与 statement 折叠使用同一白名单序列化。
  assert.equal(
    values![3],
    recordCommittedWakeupPayload({
      workspaceId: SCOPE.workspaceId,
      recordId: SCOPE.recordId,
      nextOrdinal: 42,
    }),
  );
});

test("parseRecordCommittedWakeup accepts only the strict allowlist shape", () => {
  assert.deepEqual(
    parseRecordCommittedWakeup(
      JSON.stringify({ workspaceId: "w", recordId: "r", nextOrdinal: 7 }),
    ),
    { workspaceId: "w", recordId: "r", nextOrdinal: 7 },
  );
  const rejected: unknown[] = [
    { workspaceId: "w", recordId: "r", nextOrdinal: 7, payload: { secret: true } },
    { workspaceId: "w", recordId: "r" },
    { workspaceId: "w", recordId: "r", nextOrdinal: -1 },
    { workspaceId: "w", recordId: "r", nextOrdinal: 1.5 },
    { workspaceId: "w", recordId: "r", nextOrdinal: "7" },
    { workspaceId: "w", recordId: 7, nextOrdinal: 7 },
    ["workspaceId", "recordId"],
    null,
  ];
  for (const value of rejected) {
    assert.equal(
      parseRecordCommittedWakeup(JSON.stringify(value)),
      null,
      `must reject ${JSON.stringify(value)}`,
    );
  }
  assert.equal(parseRecordCommittedWakeup("not json"), null);
  assert.equal(parseRecordCommittedWakeup(""), null);
});

class FakeListenClient extends EventEmitter {
  queries: CapturedQuery[] = [];
  connected = false;
  ended = false;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async query(text: string, values?: readonly unknown[]): Promise<unknown> {
    this.queries.push({ text, values });
    return { rows: [], rowCount: 0 };
  }

  async end(): Promise<void> {
    this.ended = true;
  }

  asClient(): RecordCommittedListenClient {
    return this as unknown as RecordCommittedListenClient;
  }
}

function notifyPayload(scope: { workspaceId: string; recordId: string }, nextOrdinal = 1) {
  return JSON.stringify({ ...scope, nextOrdinal });
}

test("listenRecordCommitted LISTENs first, wakes only on matching scope, closes cleanly", async () => {
  const client = new FakeListenClient();
  const source = await listenRecordCommitted(
    "postgres://127.0.0.1:5432/realm_test",
    SCOPE,
    () => client.asClient(),
  );
  assert.equal(client.connected, true);
  assert.deepEqual(
    client.queries.map((query) => query.text),
    [`LISTEN ${RECORD_COMMITTED_CHANNEL}`],
    "专用连接只发 LISTEN，固定安全 channel 名",
  );

  // 错 record / 错 workspace / 畸形 payload：不得唤醒。
  const waiting = source.wait();
  let settled: boolean | undefined;
  void waiting.then((wake) => {
    settled = wake;
  });
  client.emit("notification", { channel: RECORD_COMMITTED_CHANNEL, payload: notifyPayload({ workspaceId: SCOPE.workspaceId, recordId: "record_other" }) });
  client.emit("notification", { channel: RECORD_COMMITTED_CHANNEL, payload: notifyPayload({ workspaceId: "workspace_other", recordId: SCOPE.recordId }) });
  client.emit("notification", { channel: RECORD_COMMITTED_CHANNEL, payload: "garbage" });
  client.emit("notification", { channel: RECORD_COMMITTED_CHANNEL, payload: JSON.stringify({ workspaceId: SCOPE.workspaceId, recordId: SCOPE.recordId, nextOrdinal: 1, event: { content: "泄露" } }) });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(settled, undefined, "异 record/workspace/畸形 payload 不得唤醒");

  // 匹配作用域的唤醒：payload 不进消费侧，仅触发 true。
  client.emit("notification", { channel: RECORD_COMMITTED_CHANNEL, payload: notifyPayload(SCOPE, 9) });
  assert.equal(await waiting, true);

  // 缓冲语义：无 waiter 时到达的唤醒不丢失，下一个 wait 立即返回。
  client.emit("notification", { channel: RECORD_COMMITTED_CHANNEL, payload: notifyPayload(SCOPE, 10) });
  assert.equal(await source.wait(), true);
  // 缓冲已被消费，不会重复唤醒。
  const drained = source.wait();
  let drainedSettled: boolean | undefined;
  void drained.then((wake) => {
    drainedSettled = wake;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(drainedSettled, undefined);

  // 关闭：挂起的 wait 以 false 解除，专用 client 被回收。
  await source.close();
  assert.equal(await drained, false);
  assert.equal(client.ended, true);
  await source.close();
  assert.equal(await source.wait(), false);
});

test("listenRecordCommitted LISTEN failure ends the dedicated client and rejects", async () => {
  const client = new FakeListenClient();
  client.query = async () => {
    throw new Error("LISTEN refused");
  };
  await assert.rejects(
    listenRecordCommitted(
      "postgres://127.0.0.1:5432/realm_test",
      SCOPE,
      () => client.asClient(),
    ),
  );
  assert.equal(client.ended, true, "LISTEN 失败必须回收专用连接");
});

test("listenRecordCommitted connection error fails pending and future waits", async () => {
  const client = new FakeListenClient();
  const source = await listenRecordCommitted(
    "postgres://127.0.0.1:5432/realm_test",
    SCOPE,
    () => client.asClient(),
  );
  const waiting = source.wait();
  client.emit("error", new Error("connection reset"));
  assert.equal(await waiting, false);
  assert.equal(await source.wait(), false);
  await source.close();
  assert.equal(client.ended, true);
});

test("commitRelease notifies in-transaction after the idempotent early return", () => {
  const adapter = readProjectFile("database/postgres/runtime-repository.ts");
  assert.match(
    adapter,
    /import \{ withRecordCommittedNotify \} from "\.\/record-events\.ts";/,
  );
  const start = adapter.indexOf("async commitRelease(");
  const end = adapter.indexOf("async loadRecordHead(", start);
  assert.ok(start > 0 && end > start, "commitRelease body must be locatable");
  const body = adapter.slice(start, end);

  // 幂等早返回（completed + 同 fingerprint）必须先于 notify 返回。
  const idempotent = body.indexOf('run.state === "completed"');
  const earlyReturn = body.indexOf("return clone(run);", idempotent);
  const notify = body.indexOf("withRecordCommittedNotify(");
  assert.ok(idempotent > 0, "幂等早返回必须保留");
  assert.ok(earlyReturn > idempotent, "幂等路径必须直接返回");
  assert.ok(notify > earlyReturn, "幂等 replay 不得重复 notify");

  // notify 在事务内、写入（record_heads/outbox/turn state）完成之后。
  const recordHeadUpdate = body.indexOf("UPDATE record_heads");
  const outboxInsert = body.indexOf("INSERT INTO outbox");
  const saveRun = body.lastIndexOf("saveRun(client, run)");
  assert.ok(recordHeadUpdate > 0 && notify > recordHeadUpdate);
  assert.ok(outboxInsert > 0 && notify > outboxInsert);
  assert.ok(saveRun > 0 && notify > saveRun);

  // 唤醒折叠进最后一条写语句（command_inbox UPDATE），单次 client.query，
  // 不增加净查询数；channel/payload 不经字符串拼接进入 SQL。
  assert.match(body, /withRecordCommittedNotify\(\s*\{\s*update: `UPDATE command_inbox/);
  assert.match(
    body,
    /await client\.query\(completionStatement\.text, completionStatement\.values\)/,
  );
  assert.doesNotMatch(body, /\$\{RECORD_COMMITTED_CHANNEL\}/);
  // 载荷仅含最小唤醒字段。
  assert.match(
    body,
    /\{\s*workspaceId,\s*recordId: run\.command\.recordId,\s*nextOrdinal,?\s*\}/,
  );
});
