import { INTERNAL_META_CORE_PATTERNS } from "./internal-text-core.ts";

export const SEMANTIC_SEGMENT_KINDS = [
  "environment",
  "story",
  "fact",
  "action",
  "dialogue",
] as const;

export type SemanticSegmentKind = (typeof SEMANTIC_SEGMENT_KINDS)[number];
export type SemanticSpeechMode = "narrator" | "speaker" | "none";

/**
 * One immutable presentation and speech boundary inside a committed Event.
 * Boundaries are represented by array position, never by visible sentinel text.
 */
export type SemanticSegment = {
  readonly [key: string]: string;
  id: string;
  kind: SemanticSegmentKind;
  content: string;
  speechMode: SemanticSpeechMode;
};

export interface SemanticPresentationV1 {
  readonly [key: string]: number | readonly SemanticSegment[];
  schemaVersion: 1;
  segments: readonly SemanticSegment[];
}

const MAX_SEGMENTS = 24;
const MAX_SEGMENT_LENGTH = 2_000;

export function semanticPresentation(
  segments: readonly SemanticSegment[],
): SemanticPresentationV1 {
  if (!isValidSemanticSegments(segments)) {
    throw new Error("Semantic presentation segments are invalid.");
  }
  return { schemaVersion: 1, segments: segments.map((segment) => ({ ...segment })) };
}

export function parseSemanticPresentation(
  value: unknown,
): readonly SemanticSegment[] | null {
  if (!isObject(value)) return null;
  const presentation = isObject(value.presentation) ? value.presentation : value;
  if (presentation.schemaVersion !== 1 || !Array.isArray(presentation.segments)) {
    return null;
  }
  if (!isValidSemanticSegments(presentation.segments)) return null;
  return presentation.segments.map((segment) => ({ ...segment }));
}

export function fallbackSemanticSegments(
  content: string,
  kind: SemanticSegmentKind,
  id = "segment-1",
): readonly SemanticSegment[] {
  const normalized = content.trim();
  if (!normalized) return [];
  return [
    {
      id,
      kind,
      content: normalized,
      speechMode: kind === "dialogue" ? "speaker" : "narrator",
    },
  ];
}

/**
 * Compatibility parser for legacy compound prose. Outside quoted speech stays
 * an action (for utterance Events), while balanced quoted spans become
 * dialogue. New model output must provide explicit segments instead.
 *
 * Player utterances additionally follow the roleplay convention where a
 * balanced parenthesized span (（…） or (...)) describes an action and the
 * remaining bare text is spoken dialogue.
 */
export function fallbackCompositeSemanticSegments(
  content: string,
  fallbackKind: SemanticSegmentKind,
): readonly SemanticSegment[] {
  const normalized = content.trim();
  if (!normalized) return [];
  const spans = compositeSpans(normalized);
  if (spans.length === 0) return fallbackSemanticSegments(normalized, fallbackKind);
  const hasParenthesizedAction = spans.some((span) => span.kind === "action");

  const segments: SemanticSegment[] = [];
  let cursor = 0;
  let actionIndex = 0;
  let dialogueIndex = 0;
  const pushSegment = (kind: SemanticSegmentKind, text: string) => {
    if (kind === "dialogue") {
      dialogueIndex += 1;
      segments.push({
        id: `dialogue-${dialogueIndex}`,
        kind,
        content: text,
        speechMode: "speaker",
      });
      return;
    }
    actionIndex += 1;
    segments.push({
      id: `action-${actionIndex}`,
      kind: "action",
      content: text,
      speechMode: "narrator",
    });
  };
  for (const span of spans) {
    const before = normalized.slice(cursor, span.start);
    if (before.trim()) {
      pushSegment(bareTextKind(fallbackKind, hasParenthesizedAction), before);
    }
    pushSegment(span.kind, normalized.slice(span.start, span.end));
    cursor = span.end;
  }
  const after = normalized.slice(cursor);
  if (after.trim()) {
    pushSegment(bareTextKind(fallbackKind, hasParenthesizedAction), after);
  }
  return segments;
}

/**
 * Bare text around quoted spans keeps the legacy fallback kind. When a player
 * utterance marks its action with parentheses, the remaining bare text is
 * spoken dialogue.
 */
function bareTextKind(
  fallbackKind: SemanticSegmentKind,
  hasParenthesizedAction: boolean,
): SemanticSegmentKind {
  if (fallbackKind === "action" && hasParenthesizedAction) return "dialogue";
  return fallbackKind === "dialogue" ? "action" : fallbackKind;
}

export function semanticSegmentLabel(kind: SemanticSegmentKind): string {
  switch (kind) {
    case "environment":
      return "环境";
    case "story":
      return "剧情";
    case "fact":
      return "事实";
    case "action":
      return "动作";
    case "dialogue":
      return "台词";
  }
}

/**
 * 检测不应进入世界台词的规则/提示词语气。
 * 同时保护新模型输出与历史持久化 presentation，避免提示边界泄漏。
 */
export function isInternalInstructionText(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  return [
    ...INTERNAL_META_CORE_PATTERNS,
    /只应作为/,
    /(?:不得|禁止|必须).*(?:输出|生成|认知|依据|事实|信息)/,
    /(?:系统|提示词|规则引擎|模型|prompt)/i,
    /当前没有.*(?:足以|能够).*(?:推翻|改变).*(?:判断|结论)/,
    /足以让(?:角色|人物).*(?:形成|做出).*(?:判断|结论)/,
    /可复核的异常(?:细节)?/,
    /确认目标上有一处.*异常/,
    /还不能判断.*来源/,
  ].some((pattern) => pattern.test(trimmed));
}

/** 交付侧统一过滤旧 dialogue/fact；有无显式 presentation 都走这里。 */
export function filterUnsafeDeliverySegments(
  segments: readonly SemanticSegment[],
): readonly SemanticSegment[] {
  return segments.filter((segment) =>
    !(
      (segment.kind === "dialogue" || segment.kind === "fact")
      && isInternalInstructionText(segment.content)
    ));
}

function isValidSemanticSegments(value: readonly unknown[]): value is SemanticSegment[] {
  if (value.length < 1 || value.length > MAX_SEGMENTS) return false;
  const ids = new Set<string>();
  for (const candidate of value) {
    if (!isObject(candidate)) return false;
    const { id, kind, content, speechMode } = candidate;
    if (
      typeof id !== "string"
      || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)
      || ids.has(id)
      || !SEMANTIC_SEGMENT_KINDS.includes(kind as SemanticSegmentKind)
      || typeof content !== "string"
      || !content.trim()
      || content.length > MAX_SEGMENT_LENGTH
      || !["narrator", "speaker", "none"].includes(String(speechMode))
    ) {
      return false;
    }
    ids.add(id);
  }
  return true;
}

interface TextRange {
  start: number;
  end: number;
}

interface CompositeSpan extends TextRange {
  kind: SemanticSegmentKind;
}

function compositeSpans(content: string): CompositeSpan[] {
  const quotes = quotedRanges(content).map((range): CompositeSpan => ({
    ...range,
    kind: "dialogue",
  }));
  const parens = parenthesizedRanges(content, quotes).map((range): CompositeSpan => ({
    ...range,
    kind: "action",
  }));
  return [...quotes, ...parens].sort((left, right) => left.start - right.start);
}

/**
 * Balanced （…） / (...) spans mark action descriptions inside player
 * utterances. Spans that overlap quoted dialogue are ignored so quoted text
 * keeps its speech boundary.
 */
function parenthesizedRanges(
  content: string,
  excluded: readonly TextRange[],
): TextRange[] {
  const pairs = [
    ["（", "）"],
    ["(", ")"],
  ] as const;
  const ranges: TextRange[] = [];
  let searchFrom = 0;
  while (searchFrom < content.length) {
    let next: { open: string; close: string; start: number } | null = null;
    for (const [open, close] of pairs) {
      const start = content.indexOf(open, searchFrom);
      if (start >= 0 && (next === null || start < next.start)) {
        next = { open, close, start };
      }
    }
    if (!next) break;
    const closeAt = content.indexOf(next.close, next.start + next.open.length);
    if (closeAt < 0) break;
    const end = closeAt + next.close.length;
    const overlapsQuote = excluded.some(
      (range) => next.start < range.end && end > range.start,
    );
    if (end - next.start > next.open.length + next.close.length && !overlapsQuote) {
      ranges.push({ start: next.start, end });
    }
    searchFrom = end;
  }
  return ranges;
}

function quotedRanges(content: string): TextRange[] {
  const pairs = [
    ["“", "”"],
    ["「", "」"],
    ["『", "』"],
    ['"', '"'],
  ] as const;
  const ranges: TextRange[] = [];
  let searchFrom = 0;
  while (searchFrom < content.length) {
    let next: { open: string; close: string; start: number } | null = null;
    for (const [open, close] of pairs) {
      const start = content.indexOf(open, searchFrom);
      if (start >= 0 && (next === null || start < next.start)) {
        next = { open, close, start };
      }
    }
    if (!next) break;
    const closeAt = content.indexOf(next.close, next.start + next.open.length);
    if (closeAt < 0) break;
    const end = closeAt + next.close.length;
    ranges.push({ start: next.start, end });
    searchFrom = end;
  }
  return ranges;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
