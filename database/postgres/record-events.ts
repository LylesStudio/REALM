import pg from "pg";

/**
 * Phase 2G-B：Record committed-event 唤醒契约（NOTIFY + committed-event ledger）。
 *
 * 不变量：
 * - `events` 表/投影读取才是 durable committed-event ledger；NOTIFY 仅作
 *   低延迟唤醒，消费方必须按 viewer cursor 重读 ledger，绝不信任 payload；
 * - notify 在 commitRelease 的同一事务内发出——随提交送达，回滚不送达；
 * - payload 仅含 workspaceId/recordId/nextOrdinal 最小唤醒字段，不含事件
 *   内容、token、payload、连接串或凭据。
 */

export const RECORD_COMMITTED_CHANNEL = "record_committed";

export interface RecordCommittedWakeup {
  workspaceId: string;
  recordId: string;
  nextOrdinal: number;
}

/** 唤醒载荷：严格白名单最小字段的 JSON 字符串。 */
export function recordCommittedWakeupPayload(
  wakeup: RecordCommittedWakeup,
): string {
  return JSON.stringify({
    workspaceId: wakeup.workspaceId,
    recordId: wakeup.recordId,
    nextOrdinal: wakeup.nextOrdinal,
  });
}

/**
 * 把 committed-event NOTIFY 唤醒并入调用方事务的最后一条 UPDATE（CTE 前缀
 * + WHERE 引用）。
 *
 * 为什么折叠而不是独立 `SELECT pg_notify(...)`：玩家回合有 DB 查询预算
 * 围栏（tests/postgres-turn-efficiency.test.ts，每 client.query 计入），
 * 唤醒不得增加净查询数。
 *
 * 为什么必须经 `EXISTS (SELECT 1 FROM ...)` 引用 CTE：实测 PG17 会整体
 * 跳过未被引用的 SELECT CTE（即使含 volatile 函数），不引用则 NOTIFY
 * 根本不执行；`EXISTS` 引用保证随语句执行恰好一次，且 CTE 恒产一行，
 * 不改变 UPDATE 的匹配语义。NOTIFY 仍随事务提交送达、回滚不送达。
 *
 * channel 与 payload 全部作为绑定参数追加在调用方 values 之后——
 * 不拼接 SQL identifier/值。
 */
export function withRecordCommittedNotify(
  statement: { update: string; where: string; values: readonly unknown[] },
  wakeup: RecordCommittedWakeup,
): { text: string; values: unknown[] } {
  const channelParam = statement.values.length + 1;
  const payloadParam = statement.values.length + 2;
  return {
    text: `WITH record_committed_wakeup AS (
  SELECT pg_notify($${channelParam}, $${payloadParam})
)
${statement.update}
WHERE ${statement.where}
  AND EXISTS (SELECT 1 FROM record_committed_wakeup)`,
    values: [
      ...statement.values,
      RECORD_COMMITTED_CHANNEL,
      recordCommittedWakeupPayload(wakeup),
    ],
  };
}

const WAKEUP_KEYS = new Set(["workspaceId", "recordId", "nextOrdinal"]);

/** 严格白名单解析 NOTIFY payload；任何多余/缺失/非法字段 → null。 */
export function parseRecordCommittedWakeup(
  payload: string,
): RecordCommittedWakeup | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !WAKEUP_KEYS.has(key))) return null;
    if (
      typeof record.workspaceId !== "string"
      || typeof record.recordId !== "string"
      || !Number.isSafeInteger(record.nextOrdinal)
      || (record.nextOrdinal as number) < 0
    ) {
      return null;
    }
    return {
      workspaceId: record.workspaceId,
      recordId: record.recordId,
      nextOrdinal: record.nextOrdinal as number,
    };
  } catch {
    return null;
  }
}

export interface RecordCommittedWakeupScope {
  workspaceId: string;
  recordId: string;
}

export interface RecordCommittedWakeupSource {
  /** true = 本作用域有 commit 唤醒；false = 源已关闭或 LISTEN 连接失败。 */
  wait(): Promise<boolean>;
  close(): Promise<void>;
}

/** LISTEN 专用连接的最小契约（测试可注入 fake client）。 */
export interface RecordCommittedListenClient {
  connect(): Promise<unknown>;
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
  on(event: string, listener: (message: { payload?: string }) => void): unknown;
  removeListener(
    event: string,
    listener: (message: { payload?: string }) => void,
  ): unknown;
  end(): Promise<void>;
}

/**
 * 建立专用 LISTEN 连接（每 SSE 连接一个 pg.Client，不占共享 pool）并返回
 * 唤醒源。LISTEN 在返回前已建立——调用方随后做初次 ledger replay，
 * 连接建立竞态由唤醒缓冲 + cursor 去重吸收。
 * 唤醒按 workspaceId+recordId 过滤；payload 的 nextOrdinal 不直接消费。
 */
export async function listenRecordCommitted(
  connectionString: string,
  scope: RecordCommittedWakeupScope,
  createClient: () => RecordCommittedListenClient = () =>
    new pg.Client({ connectionString }),
): Promise<RecordCommittedWakeupSource> {
  const client = createClient();
  await client.connect();
  try {
    // 固定安全 channel 常量（LISTEN 不支持绑定参数，标识符不来自外部输入）。
    await client.query(`LISTEN ${RECORD_COMMITTED_CHANNEL}`);
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }

  let pending = 0;
  let closed = false;
  let ended = false;
  let waiter: ((wake: boolean) => void) | undefined;
  const settle = (wake: boolean) => {
    const current = waiter;
    waiter = undefined;
    current?.(wake);
  };
  const onNotification = (message: { payload?: string }) => {
    const wakeup = parseRecordCommittedWakeup(message.payload ?? "");
    if (!wakeup) return;
    if (
      wakeup.workspaceId !== scope.workspaceId
      || wakeup.recordId !== scope.recordId
    ) {
      return;
    }
    // 只作唤醒：要么解除当前 waiter，要么缓冲一次（不累积重复唤醒）。
    if (waiter) settle(true);
    else pending += 1;
  };
  const onError = () => {
    closed = true;
    settle(false);
  };
  client.on("notification", onNotification);
  client.on("error", onError);

  return {
    wait() {
      if (closed) return Promise.resolve(false);
      if (pending > 0) {
        pending -= 1;
        return Promise.resolve(true);
      }
      // 消费方串行等待；防御性解除遗留 waiter，避免泄漏挂起。
      settle(false);
      return new Promise<boolean>((resolve) => {
        waiter = resolve;
      });
    },
    async close() {
      closed = true;
      settle(false);
      if (ended) return;
      ended = true;
      client.removeListener("notification", onNotification);
      client.removeListener("error", onError);
      await client.end().catch(() => undefined);
    },
  };
}
