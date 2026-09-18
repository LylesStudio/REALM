/**
 * 隐私安全的模型调用观测出口（Cleanup Phase 4 / Batch 2B）。
 *
 * 只允许结构化元数据：stage、provider/model 标识、transport、elapsed、
 * usage 数值（计数，不是 token 文本）、finishReason、provider/structured
 * 重试计数与脱敏错误分类码。严禁 prompt 内容、玩家原文、message 数组、
 * 连接 URL、Authorization、API key、模型返回正文与 token 文本进入本模块。
 *
 * 默认 no-op：未配置 observer 时业务行为完全不变；observer 抛错被隔离，
 * 绝不改变模型调用结果。内存 ledger 有界（ring buffer），无数据库依赖。
 */

export type ModelCallObservation = {
  /** 本地 opaque id（单调递增，不含 secret、不含请求内容）。 */
  requestId: string;
  /** 逻辑阶段（classifier/planner/previewNlg/actor/probe/其他调用方标签）。 */
  stage: string;
  /** provider 标识；调用方无从得知时填 "unknown"。 */
  providerId: string;
  /** 模型标识；流式 transport 无法解析模型 id 时为 null。 */
  model: string | null;
  transport: "chat" | "stream";
  elapsedMs: number;
  /** usage 计数（数值）；provider 未返回时为 null。 */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  finishReason: string | null;
  /** 本次逻辑调用内的真实 provider 请求次数（含 transport/空流重试与回退）。 */
  providerAttempts: number;
  /** 本次逻辑调用内的 structured repair 次数（0 或 1，repair 上限不变）。 */
  structuredRepairs: number;
  /** structured 失败的脱敏类别（unparseable/not-object/schema；不复制原文）。 */
  structuredFailureKinds: readonly string[];
  outcome: "success" | "error";
  /** 脱敏错误分类码（如 MODEL_TIMEOUT/MODEL_RATE_LIMITED/既有 TurnError code）。 */
  errorCode?: string;
};

export type ModelCallObserver = (event: ModelCallObservation) => void;

let opaqueSequence = 0;
let activeObserver: ModelCallObserver | null = null;

/** 注入全局观测回调；null 恢复默认 no-op。 */
export function setModelCallObserver(observer: ModelCallObserver | null): void {
  activeObserver = observer;
}

export function getModelCallObserver(): ModelCallObserver | null {
  return activeObserver;
}

export function nextModelCallRequestId(): string {
  opaqueSequence += 1;
  return `mc_${opaqueSequence}`;
}

/** 观测隔离：回调抛错一律吞掉，绝不改变业务结果。 */
export function emitModelCallObservation(event: ModelCallObservation): void {
  if (!activeObserver) return;
  try {
    activeObserver(event);
  } catch {
    // 观测回调的异常不得影响模型调用结果（Batch 2B 硬约束）。
  }
}

const SAFE_OBSERVATION_ERROR_CODES = new Set([
  "MODEL_API_KEY_MISSING",
  "MODEL_PROVIDER_UNSUPPORTED",
  "MODEL_ENDPOINT_NOT_ALLOWED",
  "MODEL_SETTINGS_INVALID",
  "MODEL_AUTH_FAILED",
  "MODEL_RATE_LIMITED",
  "MODEL_TIMEOUT",
  "MODEL_RESPONSE_INVALID",
  "MODEL_REQUEST_FAILED",
  "MODEL_STAGE_DEADLINE_EXCEEDED",
  "TURN_CANCELLED",
  // 合法结构化/业务失败码（自有枚举，随各阶段 schema 同源演进）——
  // 白名单只挡任意运行时错误码与上游回显，不抹掉已知业务分类。
  "CHARACTER_ACTION_INVALID",
  "CHARACTER_RESPONSE_INVALID",
  "DM_PLAN_INVALID",
  "DM_REVIEW_INVALID",
  "DM_VISIBILITY_INVALID",
  "NARRATOR_RESPONSE_INVALID",
  "PRESENCE_ASSESSMENT_INVALID",
  "PRESENCE_RESPONSE_INVALID",
  "FIRST_NIGHT_INVALID",
  "GENESIS_CHAT_INVALID",
  "GENESIS_DRAFT_INVALID",
  "GENESIS_SUGGESTIONS_INVALID",
]);

/**
 * 脱敏错误分类：只透传既有模型/取消枚举型 error.code，否则归一通用码；
 * 绝不复制任意运行时错误字段或错误正文。
 */
export function sanitizeObservationErrorCode(error: unknown): string {
  if (
    error !== null
    && typeof error === "object"
    && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    && SAFE_OBSERVATION_ERROR_CODES.has((error as { code: string }).code)
  ) {
    return (error as { code: string }).code;
  }
  return "MODEL_PROVIDER_STEP_FAILED";
}

/** 有界内存账本（ring buffer；默认容量 256，超出丢弃最旧）。 */
export function createBoundedModelCallLedger(options?: {
  capacity?: number;
  observer?: ModelCallObserver;
}): {
  observer: ModelCallObserver;
  entries: readonly ModelCallObservation[];
  clear: () => void;
} {
  const capacity = Math.max(1, options?.capacity ?? 256);
  const buffer: ModelCallObservation[] = [];
  return {
    observer: (event) => {
      buffer.push(event);
      if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
      options?.observer?.(event);
    },
    get entries() {
      return [...buffer];
    },
    clear: () => {
      buffer.length = 0;
    },
  };
}
