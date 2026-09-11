/**
 * REALM 结构化输出容错（Prompt System v2 §D）。
 *
 * tolerantParseJsonObject：对模型返回的 JSON object 响应做安全容忍——
 * UTF-8 BOM、外围空白、标准 markdown fenced block、JSON 前后的简短非结构化
 * 前言/尾注（只提取唯一完整 JSON object）、常见 trailing comma。
 * 绝不 eval、绝不执行模型文本；多个 object、数组、标量、截断内容一律拒绝。
 */
import {
  emitModelCallObservation,
  nextModelCallRequestId,
  sanitizeObservationErrorCode,
} from "./model-call-observer.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 字符串感知的 trailing-comma 清除（字符串字面量内的逗号不动）。 */
function stripTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (lookahead < input.length && /\s/.test(input[lookahead]!)) lookahead += 1;
      if (input[lookahead] === "}" || input[lookahead] === "]") continue;
    }
    out += char;
  }
  return out;
}

function tryParseObject(candidate: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripTrailingCommas(candidate));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 字符串感知的平衡括号扫描：返回 text 中所有完整 `{...}` span（起止下标）。
 * 不完整（截断）的尾部 object 不产生 span。
 */
function findObjectSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let start = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      if (depth > 0) inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push([start, index + 1]);
        start = -1;
      }
    }
  }
  return spans;
}

/**
 * 从模型文本中安全提取唯一 JSON object；无法确认唯一/完整时返回 null。
 */
export function tolerantParseJsonObject(
  content: string,
): Record<string, unknown> | null {
  if (typeof content !== "string") return null;
  // 1. BOM + 外围空白。
  const cleaned = content.replace(/^\uFEFF/, "").trim();
  if (!cleaned) return null;

  // 2. 直通：整体即合法 object。
  const direct = tryParseObject(cleaned);
  if (direct) return direct;

  // 3. markdown fenced block：优先取围栏内容。
  const fenced = [...cleaned.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const match of fenced) {
    const inner = tryParseObject(match[1]!.trim());
    if (inner) return inner;
  }

  // 4. 前言/尾注：只接受全文恰好一个完整 JSON object；外围若仍带括号
  //    字符（如数组包裹、残缺括号）则不是「前言/尾注」，拒绝。
  const spans = findObjectSpans(cleaned);
  if (spans.length !== 1) return null;
  const before = cleaned.slice(0, spans[0]![0]);
  const after = cleaned.slice(spans[0]![1]);
  if (/[[\]{}]/.test(before) || /[[\]{}]/.test(after)) return null;
  return tryParseObject(cleaned.slice(spans[0]![0], spans[0]![1]));
}

/** 脱敏的解析失败类别（日志/修复反馈用，绝不回显模型原文）。 */
export type StructuredOutputFailureKind = "unparseable" | "not-object" | "schema";

/** 修复请求的统一 English 用户消息（不回显模型原文）。 */
export function buildRepairUserMessage(
  kind: StructuredOutputFailureKind,
  schemaInstruction: string,
): string {
  return [
    "Your previous response could not be used.",
    `Failure category: ${kind}.`,
    schemaInstruction,
    "Return the corrected JSON object only. No prose, no markdown fences.",
  ].join("\n");
}

export interface StructuredOutputLogEvent {
  code: string;
  attempt: number;
  kind: StructuredOutputFailureKind;
  /** 原始响应长度（只记长度，不记内容）。 */
  length: number;
}

/**
 * Batch 2B-P0：一次逻辑结构化调用的可选观测元数据。提供时，
 * requestStructuredObject 在逻辑调用结束（成功/双失败/provider 错误）
 * emit 恰好一条 ModelCallObservation；缺省完全不改变既有行为（no-op）。
 */
export interface StructuredOutputObservation {
  /** 逻辑阶段标签（如 crystallization-extract）。 */
  stage: string;
  /** provider 标识；缺省 "unknown"（provider/profile 归因后续 CONDITIONAL）。 */
  providerId?: string;
  /** transport；结构化直连调用缺省 "chat"。 */
  transport?: "chat" | "stream";
}

/** 默认脱敏日志（console.warn；只记类别/次数/长度，不回显模型原文）。 */
export function defaultStructuredOutputLog(event: StructuredOutputLogEvent): void {
  console.warn(
    `[realm] structured output ${event.kind} (${event.code}, attempt ${event.attempt}, length ${event.length}).`,
  );
}

/**
 * 一次修复请求（Prompt System v2 §D.3）：
 * 初次 tolerantParse/normalize 失败时，用 English 反馈（错误类别 + 目标
 * schema，不回显模型原文）追加恰好一次 repair；仍失败返回 null，由调用方
 * 走各自的 fail-closed/degraded 语义。provider/network/timeout 错误不被
 * 伪装成格式 repair——它们从 call 直接上抛。
 */
export async function requestStructuredObject<T>(options: {
  /** 发起一次模型调用（调用方负责 modelCall/provider 重试包装）。
   *  可选第二参 onProviderRequest：调用方内部有退化阶梯/就地重试时，
   *  对「第一次之后」的每个真实 provider 请求各调用一次（Batch 2B-P1
   *  观测口径：不合并不拆分；失败路径也如实计数）。 */
  call: (
    messages: readonly {
      role: "system" | "user" | "assistant";
      content: string;
    }[],
    onProviderRequest?: () => void,
  ) => Promise<{
    content: string;
    model: string;
    /** Batch 2B-P0：可选响应元数据（观测口径用；缺省记 null）。 */
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    } | null;
    finishReason?: string | null;
    /**
     * Batch 2B-P1：本次 call 内真实 provider 请求总数（含第一次；调用方
     * 内部有退化阶梯/就地重试时如实回报）。缺省按「每次 call 一次 +
     * onProviderRequest 回调次数」计。
     */
    providerAttempts?: number;
  }>;
  /** 初始消息（system policy + user context；可多轮，含 assistant 历史）。 */
  messages: readonly { role: "system" | "user" | "assistant"; content: string }[];
  /** 业务 normalizer；拒绝时返回 null。 */
  normalize: (body: Record<string, unknown>) => T | null;
  /** English 目标 schema 说明（来自 jsonOutputInstruction 生成的同一份文本）。 */
  schemaInstruction: string;
  /** 脱敏日志（类别/长度/attempt）；缺省 console.warn。 */
  onLog?: (event: StructuredOutputLogEvent) => void;
  /** 日志用错误类别码（沿用各调用点现有 code）。 */
  code: string;
  /** Batch 2B-P0：可选观测；提供时在逻辑调用结束 emit 恰好一条观测。 */
  observation?: StructuredOutputObservation;
}): Promise<{ value: T; model: string; repaired: boolean } | null> {
  const log = options.onLog ?? ((event: StructuredOutputLogEvent) => {
    defaultStructuredOutputLog(event);
  });
  // Batch 2B-P0 观测口径（与 model-powered callModelJson 同源）：
  // providerAttempts=真实 call 次数；structuredRepairs=初次失败后进入
  // 恰好一次 repair（成功或失败都计 1，初次 provider 错误计 0）；
  // failureKinds 只记脱敏类别。观测不携带消息/prompt/正文。
  const observation = options.observation;
  const startedAt = Date.now();
  let providerAttempts = 0;
  const structuredFailureKinds: string[] = [];
  let lastModel: string | null = null;
  let lastUsage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null = null;
  let lastFinishReason: string | null = null;
  const countingLog = (event: StructuredOutputLogEvent) => {
    structuredFailureKinds.push(event.kind);
    log(event);
  };
  try {
    const result = await runAttempts(countingLog);
    if (observation) {
      emitModelCallObservation({
        requestId: nextModelCallRequestId(),
        stage: observation.stage,
        providerId: observation.providerId ?? "unknown",
        model: lastModel,
        transport: observation.transport ?? "chat",
        elapsedMs: Date.now() - startedAt,
        usage: lastUsage,
        finishReason: lastFinishReason,
        providerAttempts,
        structuredRepairs: result?.repaired
          ? 1
          : structuredFailureKinds.length >= 1
            ? 1
            : 0,
        structuredFailureKinds,
        // 两次结构化尝试后仍为 null = 本次逻辑调用失败（不是 success）。
        outcome: result ? "success" : "error",
        ...(result ? {} : { errorCode: options.code }),
      });
    }
    return result;
  } catch (error) {
    if (observation) {
      emitModelCallObservation({
        requestId: nextModelCallRequestId(),
        stage: observation.stage,
        providerId: observation.providerId ?? "unknown",
        model: lastModel,
        transport: observation.transport ?? "chat",
        elapsedMs: Date.now() - startedAt,
        usage: lastUsage,
        finishReason: lastFinishReason,
        providerAttempts,
        // 初次 provider 失败 → kinds 空 → 0；repair 请求 provider 失败 → 1。
        structuredRepairs: structuredFailureKinds.length >= 1 ? 1 : 0,
        structuredFailureKinds,
        outcome: "error",
        errorCode: sanitizeObservationErrorCode(error),
      });
    }
    throw error;
  }

  async function runAttempts(
    logAttempt: (event: StructuredOutputLogEvent) => void,
  ): Promise<{ value: T; model: string; repaired: boolean } | null> {
    let messages = options.messages;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // 每次 call 调用至少对应一次真实 provider 请求（无论成败）；
      // 阶梯/就地重试的额外请求由 onProviderRequest 或返回字段补记。
      providerAttempts += 1;
      let extraAttempts = 0;
      let response: Awaited<ReturnType<typeof options.call>>;
      try {
        response = await options.call(messages, () => {
          extraAttempts += 1;
        });
      } catch (error) {
        // 额外阶梯请求的回调发生在真实请求前；若该请求随后失败，
        // 正常返回后的汇总路径不会执行，必须在这里补入已发出的请求数。
        providerAttempts += extraAttempts;
        throw error;
      }
      providerAttempts += response.providerAttempts !== undefined
        ? Math.max(0, response.providerAttempts - 1)
        : extraAttempts;
      lastModel = response.model;
      lastUsage = response.usage ?? null;
      lastFinishReason = response.finishReason ?? null;
      const content = response.content;
      const parsed = tolerantParseJsonObject(content);
      if (parsed) {
        const value = options.normalize(parsed);
        if (value !== null) {
          return { value, model: response.model, repaired: attempt === 1 };
        }
        logAttempt({
          code: options.code,
          attempt,
          kind: "schema",
          length: content.length,
        });
      } else {
        logAttempt({
          code: options.code,
          attempt,
          kind: "unparseable",
          length: content.length,
        });
      }
      if (attempt === 0) {
        // 恰好一次 repair：English 反馈 + 目标 schema；不回显模型原文。
        messages = [
          ...messages,
          {
            role: "user" as const,
            content: buildRepairUserMessage(
              parsed ? "schema" : "unparseable",
              options.schemaInstruction,
            ),
          },
        ];
      }
    }
    return null;
  }
}
