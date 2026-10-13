/**
 * Engine backend Slice 3：统一 durable job host（persistence-neutral）。
 *
 * first-night、memory-prefetch、self-play-beat 三类后台工作共用一张持久
 * 队列表（realm_durable_jobs，迁移 0058）与同一套生命周期语义：
 *
 * - 每行携带 workspace/record 作用域、job_kind、有界 payload JSON、
 *   attempt_count、available_at 与 pending/claimed/completed/failed 状态机；
 * - claim 由队列实现以 lease_owner + lease_expires_at fencing；worker 崩溃
 *   留下的 claimed 行在租约过期后被下一次 claim 回收（stale recovery）；
 * - complete/fail 以 (state, attempt_count, lease_owner) 幂等 fencing——
 *   重复 complete 返回 "settled" 而不是抛错，过期租约返回 "stale"；
 * - payload 逐 kind 校验（bounded：未知字段/超长/缺键一律 fail-closed），
 *   无效 payload 或缺 handler 的 job 直接落 failed（JOB_PAYLOAD_INVALID /
 *   JOB_HANDLER_MISSING），绝不进入 handler；
 * - 单实例 advisory lock、idle backoff、有界错误分类日志与幂等 stop 复用
 *   既有 durable-worker-host；本模块只新增 job 派发语义。
 *
 * 依赖方向：本模块不 import database/postgres、routes、local-record-service
 * 或任何业务 runtime；PG 队列实现与 handler 装配在外层完成。
 */
import {
  createDurableWorkerHost,
  safeWorkerErrorCode,
  type DurableWorkerHost,
} from "./durable-worker-host.ts";

export const DURABLE_JOB_KINDS = [
  "first-night",
  "memory-prefetch",
  "self-play-beat",
] as const;
export type DurableJobKind = (typeof DURABLE_JOB_KINDS)[number];

export function isDurableJobKind(value: unknown): value is DurableJobKind {
  return typeof value === "string"
    && (DURABLE_JOB_KINDS as readonly string[]).includes(value);
}

/** 队列返回的已认领 job（lease fencing 字段齐备）。 */
export interface ClaimedDurableJob {
  jobId: string;
  workspaceId: string;
  kind: DurableJobKind;
  recordId: string;
  /** 未经校验的原始 payload；handler 派发前必须过 validate/parse。 */
  payload: unknown;
  attemptCount: number;
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface DurableJobEnqueueInput {
  jobId: string;
  kind: DurableJobKind;
  recordId: string;
  /** 有界 JSON object；超长/非 object 由实现 fail-closed 拒绝。 */
  payload: Readonly<Record<string, unknown>>;
  availableAt?: string;
  /**
   * true 时，同 id 的 terminal（completed/failed）行被重置回 pending
   * （懒重试/链式修复语义）；active（pending/claimed）行保持不重叠。
   */
  requeueTerminal?: boolean;
}

export type DurableJobEnqueueResult = "inserted" | "existing" | "requeued";

/** complete/fail 的幂等结果：applied=本次生效；settled=已是目标终态；stale=租约不再当前。 */
export type DurableJobSettleResult = "applied" | "settled" | "stale";

export interface DurableJobQueue {
  enqueue(input: DurableJobEnqueueInput): Promise<DurableJobEnqueueResult>;
  /** 认领一条到期 job；claimed 且租约过期的行被回收重领（stale recovery）。 */
  claimNext(input: {
    now: string;
    kinds: readonly DurableJobKind[];
  }): Promise<ClaimedDurableJob | null>;
  complete(job: ClaimedDurableJob, now: string): Promise<DurableJobSettleResult>;
  fail(
    job: ClaimedDurableJob,
    code: string,
    now: string,
  ): Promise<DurableJobSettleResult>;
}

export type DurableJobHandler = (job: ClaimedDurableJob) => Promise<void>;

/** handler 注册表：运行期可变（registerHandler 后新 cycle 即生效）。 */
export type DurableJobHandlerRegistry = Map<DurableJobKind, DurableJobHandler>;

// ---------------------------------------------------------------------------
// payload 校验（bounded、fail-closed）
// ---------------------------------------------------------------------------

const ID_LIMIT = 200;
const NAME_LIMIT = 128;
const QUERY_LIMIT = 1000;

function isBoundedText(value: unknown, limit: number): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= limit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export interface MemoryPrefetchJobPayload {
  sessionId: number;
  worldId: string;
  worldlineId: string;
  characterInstanceId: string;
  query: string;
}

export interface SelfPlayBeatJobPayload {
  sessionId: string;
  beat: number;
  principalId?: string;
}

export function parseMemoryPrefetchJobPayload(
  value: unknown,
): MemoryPrefetchJobPayload | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, [
    "sessionId",
    "worldId",
    "worldlineId",
    "characterInstanceId",
    "query",
  ])) return null;
  if (!Number.isSafeInteger(value.sessionId) || (value.sessionId as number) < 1) {
    return null;
  }
  if (!isBoundedText(value.worldId, NAME_LIMIT)) return null;
  if (!isBoundedText(value.worldlineId, NAME_LIMIT)) return null;
  if (!isBoundedText(value.characterInstanceId, NAME_LIMIT)) return null;
  if (typeof value.query !== "string" || value.query.length > QUERY_LIMIT) {
    return null;
  }
  return {
    sessionId: value.sessionId as number,
    worldId: value.worldId,
    worldlineId: value.worldlineId,
    characterInstanceId: value.characterInstanceId,
    query: value.query,
  };
}

export function parseSelfPlayBeatJobPayload(
  value: unknown,
): SelfPlayBeatJobPayload | null {
  if (!isRecord(value)) return null;
  if (!hasOnlyKeys(value, ["sessionId", "beat", "principalId"])) return null;
  if (!isBoundedText(value.sessionId, ID_LIMIT)) return null;
  if (!Number.isSafeInteger(value.beat) || (value.beat as number) < 1) return null;
  if (
    value.principalId !== undefined
    && !isBoundedText(value.principalId, NAME_LIMIT)
  ) {
    return null;
  }
  return {
    sessionId: value.sessionId,
    beat: value.beat as number,
    ...(value.principalId !== undefined
      ? { principalId: value.principalId as string }
      : {}),
  };
}

/** 逐 kind 有界校验：first-night 只接受空对象（recordId 在行上）。 */
export function validateDurableJobPayload(
  kind: DurableJobKind,
  payload: unknown,
): boolean {
  switch (kind) {
    case "first-night":
      return isRecord(payload) && Object.keys(payload).length === 0;
    case "memory-prefetch":
      return parseMemoryPrefetchJobPayload(payload) !== null;
    case "self-play-beat":
      return parseSelfPlayBeatJobPayload(payload) !== null;
  }
}

// ---------------------------------------------------------------------------
// 派发：claim → validate → handle → complete/fail（幂等 fencing）
// ---------------------------------------------------------------------------

export interface DurableJobCycleSlot {
  workspaceId: string;
  queue: DurableJobQueue;
}

/**
 * 处理一条已认领 job：payload 无效或 handler 缺失落 failed（fail-closed）；
 * handler 抛错以有界 machine code 落 failed；否则 complete。complete/fail
 * 的 stale/settled 结果只表示并发/重放，不再扩散。
 */
export async function processClaimedDurableJob(options: {
  queue: DurableJobQueue;
  job: ClaimedDurableJob;
  handlers: DurableJobHandlerRegistry;
  now: string;
}): Promise<"completed" | "failed"> {
  const handler = options.handlers.get(options.job.kind);
  if (!handler) {
    await options.queue.fail(options.job, "JOB_HANDLER_MISSING", options.now);
    return "failed";
  }
  if (!validateDurableJobPayload(options.job.kind, options.job.payload)) {
    await options.queue.fail(options.job, "JOB_PAYLOAD_INVALID", options.now);
    return "failed";
  }
  try {
    await handler(options.job);
  } catch (error) {
    // 有界分类：raw message 可能携带连接串/endpoint/provider payload。
    await options.queue.fail(options.job, safeWorkerErrorCode(error), options.now);
    return "failed";
  }
  await options.queue.complete(options.job, options.now);
  return "completed";
}

/** 单 slot 单 cycle：认领并处理一条 job；返回是否做了工作。 */
export async function runDurableJobCycle(options: {
  slot: DurableJobCycleSlot;
  handlers: DurableJobHandlerRegistry;
  now: string;
}): Promise<boolean> {
  const kinds = [...options.handlers.keys()];
  if (kinds.length === 0) return false;
  const job = await options.slot.queue.claimNext({ now: options.now, kinds });
  if (!job) return false;
  await processClaimedDurableJob({
    queue: options.slot.queue,
    job,
    handlers: options.handlers,
    now: options.now,
  });
  return true;
}

// ---------------------------------------------------------------------------
// host 装配：advisory-lock 单实例 + idle backoff + stale recovery 复用既有
// durable-worker-host；本工厂只补 cycle 派发。
// ---------------------------------------------------------------------------

export function createUnifiedDurableJobHost(options: {
  slots: readonly DurableJobCycleSlot[];
  handlers: DurableJobHandlerRegistry;
  acquireLock: () => Promise<() => Promise<void>>;
  checkHealth: () => Promise<void>;
  onStart?: () => Promise<void>;
  idleMinMs: number;
  idleMaxMs: number;
  alreadyStartedError: () => Error;
  alreadyStoppedError?: () => Error;
  close: () => Promise<void>;
  logger?: (line: string) => void;
  clock?: () => string;
}): DurableWorkerHost {
  const log = options.logger ?? (() => {});
  const clock = options.clock ?? (() => new Date().toISOString());
  return createDurableWorkerHost({
    idleMinMs: options.idleMinMs,
    idleMaxMs: options.idleMaxMs,
    logger: log,
    hooks: {
      acquireLock: options.acquireLock,
      checkHealth: options.checkHealth,
      ...(options.onStart ? { onStart: options.onStart } : {}),
      async runCycle() {
        let didWork = false;
        for (const slot of options.slots) {
          try {
            if (await runDurableJobCycle({
              slot,
              handlers: options.handlers,
              now: clock(),
            })) {
              didWork = true;
            }
          } catch (error) {
            // 单 slot 故障（如连接中断）不拖垮其他 slot；有界 code 日志。
            log(`cycle error=${safeWorkerErrorCode(error)}`);
          }
        }
        return didWork;
      },
      close: options.close,
      alreadyStartedError: options.alreadyStartedError,
      ...(options.alreadyStoppedError
        ? { alreadyStoppedError: options.alreadyStoppedError }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// 内存队列（测试与无 DB 装配用）：与 PG 实现同一 lease/fencing/幂等语义。
// ---------------------------------------------------------------------------

interface InMemoryJobRow {
  id: string;
  kind: DurableJobKind;
  recordId: string;
  payload: Readonly<Record<string, unknown>>;
  state: "pending" | "claimed" | "completed" | "failed";
  attemptCount: number;
  availableAt: number;
  leaseOwner: string | null;
  leaseExpiresAt: number | null;
  lastErrorCode: string | null;
}

export function createInMemoryDurableJobQueue(options: {
  workspaceId: string;
  leaseOwner: string;
  leaseDurationMs?: number;
  clock?: () => string;
}): DurableJobQueue & {
  /** 测试断言用：按 id 读当前行快照。 */
  inspect(jobId: string): {
    state: InMemoryJobRow["state"];
    attemptCount: number;
    lastErrorCode: string | null;
  } | null;
} {
  const leaseDurationMs = options.leaseDurationMs ?? 30_000;
  const clock = options.clock ?? (() => new Date().toISOString());
  const rows = new Map<string, InMemoryJobRow>();

  const epoch = (value: string): number => {
    const time = Date.parse(value);
    if (!Number.isFinite(time)) throw new Error("durable job timestamp invalid");
    return time;
  };

  return {
    async enqueue(input) {
      if (!isDurableJobKind(input.kind)) {
        throw new Error("durable job kind invalid");
      }
      const existing = rows.get(input.jobId);
      if (existing) {
        if (
          input.requeueTerminal
          && (existing.state === "completed" || existing.state === "failed")
        ) {
          existing.state = "pending";
          existing.payload = input.payload;
          existing.availableAt = epoch(input.availableAt ?? clock());
          existing.leaseOwner = null;
          existing.leaseExpiresAt = null;
          existing.lastErrorCode = null;
          return "requeued";
        }
        return "existing";
      }
      rows.set(input.jobId, {
        id: input.jobId,
        kind: input.kind,
        recordId: input.recordId,
        payload: input.payload,
        state: "pending",
        attemptCount: 0,
        availableAt: epoch(input.availableAt ?? clock()),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      });
      return "inserted";
    },
    async claimNext(input) {
      const now = epoch(input.now);
      const candidates = [...rows.values()]
        .filter((row) =>
          input.kinds.includes(row.kind)
          && (
            (row.state === "pending" && row.availableAt <= now)
            || (row.state === "claimed"
              && row.leaseExpiresAt !== null
              && row.leaseExpiresAt <= now)
          )
        )
        .sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id));
      const row = candidates[0];
      if (!row) return null;
      row.state = "claimed";
      row.attemptCount += 1;
      row.leaseOwner = options.leaseOwner;
      row.leaseExpiresAt = now + leaseDurationMs;
      row.lastErrorCode = null;
      return {
        jobId: row.id,
        workspaceId: options.workspaceId,
        kind: row.kind,
        recordId: row.recordId,
        payload: row.payload,
        attemptCount: row.attemptCount,
        leaseOwner: row.leaseOwner,
        leaseExpiresAt: new Date(row.leaseExpiresAt).toISOString(),
      };
    },
    async complete(job, now) {
      const row = rows.get(job.jobId);
      if (!row) return "stale";
      if (
        row.state === "claimed"
        && row.attemptCount === job.attemptCount
        && row.leaseOwner === job.leaseOwner
        && row.leaseExpiresAt !== null
        && row.leaseExpiresAt > epoch(now)
      ) {
        row.state = "completed";
        row.leaseOwner = null;
        row.leaseExpiresAt = null;
        return "applied";
      }
      return row.state === "completed" ? "settled" : "stale";
    },
    async fail(job, code, now) {
      const row = rows.get(job.jobId);
      if (!row) return "stale";
      if (
        row.state === "claimed"
        && row.attemptCount === job.attemptCount
        && row.leaseOwner === job.leaseOwner
        && row.leaseExpiresAt !== null
        && row.leaseExpiresAt > epoch(now)
      ) {
        row.state = "failed";
        row.leaseOwner = null;
        row.leaseExpiresAt = null;
        row.lastErrorCode = code;
        return "applied";
      }
      return row.state === "failed" ? "settled" : "stale";
    },
    inspect(jobId) {
      const row = rows.get(jobId);
      if (!row) return null;
      return {
        state: row.state,
        attemptCount: row.attemptCount,
        lastErrorCode: row.lastErrorCode,
      };
    },
  };
}
