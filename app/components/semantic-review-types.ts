/**
 * 批次 T11-D：semantic review 操作面的纯契约层（无 React、无 fetch）。
 * 规范 public documentation：
 * - 三种 change kind 的 payload 形态严格对应服务端 parseChangeSet；
 * - effectiveCursor/existingFuture 只来自 context route 的服务端 head 游标；
 * - 结果展示白名单：classification/recommendation/rationale/source，
 *   绝不携带 prompt、inputDigest、requestId 等内部字段。
 */

export type SemanticReviewChangeKind = "assert" | "terminate" | "supersede";

// WorldCursor 单源在 modules/context/public.ts（types-only，client-safe）。
import type { WorldCursor } from "../../modules/context/public.ts";
export type { WorldCursor } from "../../modules/context/public.ts";

export type SemanticReviewChange = {
  kind: SemanticReviewChangeKind;
  subjectEntityId: string;
  predicate: string;
  objectValue: string;
  targetClaimId?: string;
  effectiveCursor: WorldCursor;
};

/** 复审结果展示形态（白名单字段；内部字段在 normalization 时被丢弃）。 */
export type SemanticReviewOutcome = {
  classification: "none" | "bridgeable" | "hard" | "high-risk";
  recommendation: "merge" | "branch" | "reject" | null;
  rationale: string;
  source: "model" | "fallback" | null;
};

const CLASSIFICATIONS = new Set(["none", "bridgeable", "hard", "high-risk"]);
const RECOMMENDATIONS = new Set(["merge", "branch", "reject"]);

/** context GET 响应的 fail-closed 解析：非法游标一律 null。 */
export function normalizeSemanticReviewContext(value: unknown): {
  worldId: string;
  worldlineId: string;
  existingFuture: WorldCursor;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (body.ok !== true) return null;
  const scope = body.scope as Record<string, unknown> | undefined;
  const cursor = normalizeCursor(body.existingFuture);
  if (
    !scope
    || typeof scope.worldId !== "string"
    || typeof scope.worldlineId !== "string"
    || !cursor
  ) {
    return null;
  }
  return {
    worldId: scope.worldId,
    worldlineId: scope.worldlineId,
    existingFuture: cursor,
  };
}

function normalizeCursor(value: unknown): WorldCursor | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const cursor = value as Record<string, unknown>;
  const tick = typeof cursor.tick === "number" ? cursor.tick : Number(cursor.tick);
  const ordinal = typeof cursor.ordinal === "number" ? cursor.ordinal : Number(cursor.ordinal);
  if (!Number.isSafeInteger(tick) || !Number.isSafeInteger(ordinal)) return null;
  return {
    tick,
    ordinal,
    calendarId: typeof cursor.calendarId === "string" ? cursor.calendarId : "native",
    display: typeof cursor.display === "string" ? cursor.display : "",
  };
}

/**
 * 以当前 Claim 为草稿来源构造单条 change（与服务端 parseChangeSet 一一对应）：
 * - assert：保留 subject/predicate，用户编辑候选 object；
 * - terminate：当前 Claim 为 target，不携带新值；
 * - supersede：当前 Claim 为 target，用户编辑替代 object。
 * effectiveCursor 固定为 context route 返回的服务端 head 游标。
 */
export function buildSemanticReviewChange(input: {
  kind: SemanticReviewChangeKind;
  claim: { id: string; subjectEntityId: string; predicate: string; objectValue: string };
  objectValue: string;
  cursor: WorldCursor;
}): SemanticReviewChange | null {
  const subjectEntityId = input.claim.subjectEntityId.trim();
  const predicate = input.claim.predicate.trim();
  if (!subjectEntityId || !predicate) return null;
  const objectValue = input.objectValue.trim();
  const base = {
    subjectEntityId,
    predicate,
    effectiveCursor: input.cursor,
  };
  if (input.kind === "assert") {
    if (!objectValue) return null;
    return { kind: "assert", ...base, objectValue };
  }
  if (input.kind === "terminate") {
    return {
      kind: "terminate",
      ...base,
      objectValue: "",
      targetClaimId: input.claim.id,
    };
  }
  if (!objectValue) return null;
  return {
    kind: "supersede",
    ...base,
    objectValue,
    targetClaimId: input.claim.id,
  };
}

/**
 * semantic POST 成功响应 → 展示形态。none/hard 走确定性结论
 * （recommendation/source 为 null，rationale 取 classification.reason）；
 * high-risk 取 semantic evidence 的 result + source。非法响应一律 null。
 */
export function normalizeSemanticReviewOutcome(value: unknown): SemanticReviewOutcome | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (body.ok !== true) return null;
  const deterministic = body.deterministic as Record<string, unknown> | undefined;
  const classification = deterministic?.classification as Record<string, unknown> | undefined;
  const conflict = classification?.conflict;
  if (typeof conflict !== "string" || !CLASSIFICATIONS.has(conflict)) return null;
  const deterministicReason = typeof classification?.reason === "string"
    ? classification.reason
    : "";
  const semantic = body.semantic as Record<string, unknown> | null | undefined;
  if (!semantic) {
    return {
      classification: conflict as SemanticReviewOutcome["classification"],
      recommendation: null,
      rationale: deterministicReason,
      source: null,
    };
  }
  const result = semantic.result as Record<string, unknown> | undefined;
  const severity = result?.severity;
  const recommendation = result?.recommendation;
  const rationale = result?.rationale;
  const source = semantic.source;
  if (
    typeof severity !== "string"
    || !CLASSIFICATIONS.has(severity)
    || typeof recommendation !== "string"
    || !RECOMMENDATIONS.has(recommendation)
    || typeof rationale !== "string"
    || (source !== "model" && source !== "fallback")
  ) {
    return null;
  }
  return {
    classification: severity as SemanticReviewOutcome["classification"],
    recommendation: recommendation as NonNullable<SemanticReviewOutcome["recommendation"]>,
    rationale,
    source,
  };
}

/** 错误映射：409 可再次点击；503 稳定不可用；其余归并为通用失败。 */
export function semanticReviewErrorKey(status: number, code: string | undefined): string {
  if (status === 409 || code === "SEMANTIC_REVIEW_BUSY") {
    return "ui.semanticReview.errBusy";
  }
  if (
    status === 503
    || code === "SEMANTIC_REVIEW_UNAVAILABLE"
    || code === "LOCAL_RUNTIME_NOT_INITIALIZED"
  ) {
    return "ui.semanticReview.errUnavailable";
  }
  if (status === 404 || code === "WORLD_NOT_FOUND") {
    return "ui.semanticReview.errNotFound";
  }
  if (status === 401 || code === "UNAUTHORIZED") {
    return "ui.semanticReview.errUnauthorized";
  }
  return "ui.semanticReview.errGeneric";
}
