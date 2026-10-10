/**
 * Durable Outbox dispatcher（Phase 2G-A）：application 层的一次性消费核心。
 *
 * 职责边界：只编排“发现可投递消息 → 带 lease/fencing claim → 调用注入的
 * publish sink → 按结果 settle delivered/retryable/failed”。outbox 写入、
 * claim/settle 状态机与 fencing 语义全部由 runtime/public.ts 的
 * RuntimeRepository 公开契约提供，本模块不复制其 SQL 或状态机实现，也不
 * 反向 import local-record-service.ts。本阶段不接 Record SSE、NOTIFY、
 * route 或常驻 service；publish sink 是窄接口，外部平台投递在后续阶段接线。
 */
import {
  RuntimeConcurrencyError,
  RuntimeInvariantError,
  type JsonValue,
  type RuntimeOutboxMessage,
  type RuntimeRepository,
} from "../runtime/public.ts";

/** Dispatcher 实际依赖的仓储窄面：只读 outbox 列表与 claim/settle 契约。 */
export type OutboxDispatcherRepository<
  TPayload extends JsonValue = JsonValue,
> = Pick<
  RuntimeRepository<
    JsonValue,
    JsonValue,
    JsonValue,
    JsonValue,
    JsonValue,
    TPayload
  >,
  "listOutboxMessages" | "claimOutbox" | "settleOutbox"
>;

/** 交给 publish sink 的窄请求：topic、payload 与消息身份/record scope 可读。 */
export interface OutboxPublishRequest<TPayload extends JsonValue = JsonValue> {
  messageId: string;
  turnId: string;
  recordId: string;
  topic: string;
  dedupeKey: string;
  payload: TPayload;
  /** 当前 delivery attempt（claim 之后的 attempts 计数，从 1 开始）。 */
  attempt: number;
}

/**
 * 显式窄 publish 契约：resolve 表示已投递；抛 RetryableOutboxPublishError
 * 表示可重试；抛 PermanentOutboxPublishError 或任何未知错误表示不可重试。
 */
export interface OutboxPublishSink<TPayload extends JsonValue = JsonValue> {
  publish(request: OutboxPublishRequest<TPayload>): Promise<void>;
}

/** 可分类的可重试投递错误；safeMessage 是不含凭据/连接串的安全摘要。 */
export class RetryableOutboxPublishError extends Error {
  readonly code: string;
  readonly safeMessage: string;

  constructor(code: string, safeMessage = "The publish step can be retried.") {
    super(safeMessage);
    this.name = "RetryableOutboxPublishError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

/** 可分类的永久投递错误；safeMessage 是不含凭据/连接串的安全摘要。 */
export class PermanentOutboxPublishError extends Error {
  readonly code: string;
  readonly safeMessage: string;

  constructor(code: string, safeMessage = "The publish step cannot succeed.") {
    super(safeMessage);
    this.name = "PermanentOutboxPublishError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

export interface OutboxDispatcherDependencies<
  TPayload extends JsonValue = JsonValue,
> {
  repository: OutboxDispatcherRepository<TPayload>;
  sink: OutboxPublishSink<TPayload>;
  /** 显式时钟，返回 ISO 时间戳；不允许隐式 Date.now，保证测试确定性。 */
  clock: () => string;
  leaseOwner: string;
  leaseDurationMs: number;
  batchLimit: number;
  /** 线性 backoff 基数：retryAt = now + retryDelayMs * attempt。 */
  retryDelayMs: number;
  /** 超过该 attempt 数后，可重试错误也 settle failed。 */
  maxAttempts: number;
}

export interface OutboxDispatchReport {
  now: string;
  scanned: number;
  candidates: number;
  claimed: number;
  delivered: number;
  retryable: number;
  failed: number;
  claimConflicts: number;
  settleConflicts: number;
}

export interface OutboxDispatcher {
  /** 一次性消费一个批次；同一 dispatcher 上的调用不得重叠。 */
  runOnce(): Promise<OutboxDispatchReport>;
}

export function createOutboxDispatcher<
  TPayload extends JsonValue = JsonValue,
>(
  dependencies: OutboxDispatcherDependencies<TPayload>,
): OutboxDispatcher {
  const config = validateConfig(dependencies);
  let running = false;

  return {
    async runOnce() {
      if (running) {
        throw new RuntimeInvariantError(
          "OUTBOX_DISPATCHER_BUSY",
          "An Outbox dispatch run is already in progress.",
        );
      }
      running = true;
      try {
        return await runBatch(config);
      } finally {
        running = false;
      }
    },
  };
}

interface ValidatedConfig<TPayload extends JsonValue = JsonValue> {
  repository: OutboxDispatcherRepository<TPayload>;
  sink: OutboxPublishSink<TPayload>;
  clock: () => string;
  leaseOwner: string;
  leaseDurationMs: number;
  batchLimit: number;
  retryDelayMs: number;
  maxAttempts: number;
}

function validateConfig<TPayload extends JsonValue>(
  dependencies: OutboxDispatcherDependencies<TPayload>,
): ValidatedConfig<TPayload> {
  if (!dependencies.repository) {
    throw new RuntimeInvariantError(
      "OUTBOX_DISPATCHER_REPOSITORY_REQUIRED",
      "An Outbox dispatcher requires a runtime repository.",
    );
  }
  if (!dependencies.sink || typeof dependencies.sink.publish !== "function") {
    throw new RuntimeInvariantError(
      "OUTBOX_DISPATCHER_SINK_REQUIRED",
      "An Outbox dispatcher requires a publish sink.",
    );
  }
  if (typeof dependencies.clock !== "function") {
    throw new RuntimeInvariantError(
      "OUTBOX_DISPATCHER_CLOCK_INVALID",
      "An Outbox dispatcher requires an explicit clock.",
    );
  }
  const leaseOwner = dependencies.leaseOwner?.trim() ?? "";
  if (!leaseOwner) {
    throw new RuntimeInvariantError(
      "OUTBOX_DISPATCHER_LEASE_OWNER_INVALID",
      "An Outbox dispatcher requires a non-empty lease owner.",
    );
  }
  if (
    !Number.isFinite(dependencies.leaseDurationMs) ||
    dependencies.leaseDurationMs <= 0
  ) {
    throw new RuntimeInvariantError(
      "OUTBOX_DISPATCHER_LEASE_INVALID",
      "Lease duration must be a positive finite number of milliseconds.",
    );
  }
  if (
    !Number.isSafeInteger(dependencies.batchLimit) ||
    dependencies.batchLimit < 1
  ) {
    throw new RuntimeInvariantError(
      "OUTBOX_DISPATCHER_BATCH_INVALID",
      "Batch limit must be a positive safe integer.",
    );
  }
  if (
    !Number.isFinite(dependencies.retryDelayMs) ||
    dependencies.retryDelayMs <= 0
  ) {
    throw new RuntimeInvariantError(
      "OUTBOX_DISPATCHER_RETRY_INVALID",
      "Retry delay must be a positive finite number of milliseconds.",
    );
  }
  if (
    !Number.isSafeInteger(dependencies.maxAttempts) ||
    dependencies.maxAttempts < 1
  ) {
    throw new RuntimeInvariantError(
      "OUTBOX_DISPATCHER_ATTEMPTS_INVALID",
      "Max attempts must be a positive safe integer.",
    );
  }
  return { ...dependencies, leaseOwner };
}

async function runBatch<TPayload extends JsonValue>(
  config: ValidatedConfig<TPayload>,
): Promise<OutboxDispatchReport> {
  const now = config.clock();
  const nowEpoch = timestampEpoch(now, "OUTBOX_DISPATCHER_NOW_INVALID");
  const leaseExpiresAt = new Date(
    nowEpoch + config.leaseDurationMs,
  ).toISOString();

  const messages = await config.repository.listOutboxMessages();
  const candidates = messages
    .filter((message) => isDispatchable(message, nowEpoch))
    .sort(compareCandidates)
    .slice(0, config.batchLimit);

  const report: OutboxDispatchReport = {
    now,
    scanned: messages.length,
    candidates: candidates.length,
    claimed: 0,
    delivered: 0,
    retryable: 0,
    failed: 0,
    claimConflicts: 0,
    settleConflicts: 0,
  };

  for (const candidate of candidates) {
    let claimed: RuntimeOutboxMessage<TPayload>;
    try {
      claimed = await config.repository.claimOutbox({
        messageId: candidate.messageId,
        expectedRevision: candidate.revision,
        leaseOwner: config.leaseOwner,
        leaseExpiresAt,
        now,
      });
    } catch (error) {
      if (error instanceof RuntimeConcurrencyError) {
        // claim 竞争失败：跳过本条并计数，不让整个 batch 失败。
        report.claimConflicts += 1;
        continue;
      }
      throw error;
    }
    report.claimed += 1;

    let outcome: SettledOutcome;
    try {
      await config.sink.publish({
        messageId: claimed.messageId,
        turnId: claimed.turnId,
        recordId: claimed.recordId,
        topic: claimed.topic,
        dedupeKey: claimed.dedupeKey,
        payload: claimed.payload,
        attempt: claimed.attempts,
      });
      outcome = { kind: "delivered" };
    } catch (error) {
      outcome = classifyPublishFailure(error, claimed, config, now, nowEpoch);
    }

    try {
      await config.repository.settleOutbox({
        messageId: claimed.messageId,
        expectedRevision: claimed.revision,
        outcome: outcome.kind,
        leaseOwner: claimed.leaseOwner ?? config.leaseOwner,
        now,
        ...(outcome.kind === "retryable" ? { retryAt: outcome.retryAt } : {}),
        ...(outcome.kind !== "delivered" ? { failure: outcome.failure } : {}),
      });
      report[outcome.kind] += 1;
    } catch (error) {
      if (error instanceof RuntimeConcurrencyError) {
        // 旧 worker / revision 或 lease 不匹配：不覆写新 worker 状态。
        report.settleConflicts += 1;
        continue;
      }
      throw error;
    }
  }

  return report;
}

type SettledOutcome =
  | { kind: "delivered" }
  | { kind: "retryable"; retryAt: string; failure: FailureSummary }
  | { kind: "failed"; failure: FailureSummary };

interface FailureSummary {
  code: string;
  message: string;
  occurredAt: string;
}

function classifyPublishFailure<TPayload extends JsonValue>(
  error: unknown,
  claimed: RuntimeOutboxMessage<TPayload>,
  config: ValidatedConfig<TPayload>,
  now: string,
  nowEpoch: number,
): SettledOutcome {
  if (error instanceof RetryableOutboxPublishError) {
    const failure = {
      code: error.code,
      message: error.safeMessage,
      occurredAt: now,
    };
    if (claimed.attempts < config.maxAttempts) {
      return {
        kind: "retryable",
        retryAt: new Date(
          nowEpoch + config.retryDelayMs * claimed.attempts,
        ).toISOString(),
        failure,
      };
    }
    return { kind: "failed", failure };
  }
  if (error instanceof PermanentOutboxPublishError) {
    return {
      kind: "failed",
      failure: {
        code: error.code,
        message: error.safeMessage,
        occurredAt: now,
      },
    };
  }
  // 未知错误按永久失败处理，且只落安全摘要，不泄露原始错误内容
  // （可能包含凭据/连接串）。
  return {
    kind: "failed",
    failure: {
      code: "OUTBOX_PUBLISH_FAILED",
      message: "The publish sink failed.",
      occurredAt: now,
    },
  };
}

function isDispatchable<TPayload extends JsonValue>(
  message: RuntimeOutboxMessage<TPayload>,
  nowEpoch: number,
): boolean {
  if (message.state === "pending" || message.state === "retryable") {
    return (
      timestampEpoch(message.availableAt, "OUTBOX_DISPATCHER_NOW_INVALID") <=
      nowEpoch
    );
  }
  if (message.state === "delivering") {
    // lease 过期的 delivering 消息允许 recovery claim。
    return (
      message.leaseExpiresAt !== undefined &&
      timestampEpoch(
        message.leaseExpiresAt,
        "OUTBOX_DISPATCHER_NOW_INVALID",
      ) <= nowEpoch
    );
  }
  return false;
}

function compareCandidates<TPayload extends JsonValue>(
  left: RuntimeOutboxMessage<TPayload>,
  right: RuntimeOutboxMessage<TPayload>,
): number {
  const byAvailability = left.availableAt.localeCompare(right.availableAt);
  return byAvailability !== 0
    ? byAvailability
    : left.messageId.localeCompare(right.messageId);
}

function timestampEpoch(value: string, code: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    throw new RuntimeInvariantError(code, "Outbox dispatcher time is invalid.");
  }
  return epoch;
}
