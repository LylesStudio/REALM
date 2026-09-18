/**
 * 批次 T3 角色在场（public documentation）。
 *
 * 玩家回合提交后，未发声角色可以基于叙事上下文（环境变化、同侪言行、
 * 未响应钩子）主动发声。本模块提供确定性部件：触发素材抽取、候选过滤、
 * 预算常量、门禁输出与关系输出规整——模型门禁在 model-powered.ts，
 * 回合装配与落库在 application/local-record-service.ts。
 */

import type { ActionTransaction } from "../actions/public.ts";
import type { ActivatedCharacter, SemanticOutputDraft } from "./public.ts";
import type { TurnControl } from "../runtime/turn-control.ts";

/** 在场触发种类：环境变化 / 同侪言行 / 未响应的开场钩子。 */
export type PresenceTriggerKind = "environment" | "peer" | "hook";

/** 每玩家回合在场发声预算（默认 1：房间里有人，但绝不两人抢话）。 */
export const PRESENCE_MAX_PER_TURN = 1;
/** 预算硬上限：依赖注入可降不可升。 */
export const PRESENCE_HARD_CAP_PER_TURN = 2;
/** 在场触发种类的权威枚举（prompt 说明与 normalizer 同源）。 */
export const PRESENCE_TRIGGER_KINDS = ["environment", "peer", "hook"] as const;
/** 门禁 reason 上限（prompt 说明与 normalizer 同源）。 */
export const PRESENCE_REASON_LIMIT = 240;
/** relationship 字段上限（prompt 说明与 normalizer 同源）。 */
export const PRESENCE_RELATIONSHIP_LIMITS = { target: 60, note: 80 } as const;

/**
 * 在场触发素材（确定性抽取）。三类全空 → 确定性沉默，不发起模型门禁。
 */
export type PresenceContext = {
  /** 本回合旁白的 environment/story 段。 */
  environment: readonly string[];
  /** 本回合角色台词与行动公开事实（同侪素材）。 */
  peer: readonly string[];
  /** 初夜开场钩子（ready/degraded）；无钩子为 null。 */
  hook: string | null;
};

/** 门禁裁决：谁说、因何说；或沉默（附原因）。 */
export type PresenceDecision =
  | {
      kind: "speak";
      characterInstanceId: string;
      triggerKind: PresenceTriggerKind;
      reason: string;
    }
  | { kind: "silent"; reason: string };

/** presence 回合携带的在场上下文（全字符串，JsonValue 序列化安全）。 */
export type PresenceTurnContext = {
  characterInstanceId: string;
  triggerKind: PresenceTriggerKind;
  /** 触发素材摘要（截断限长）。 */
  triggerText: string;
  /** T2 prefetch 同步消费结果（可为空）。 */
  memories: string;
  /** CharacterMemoryService.relationships 主观关系视图（可为空）。 */
  relationships: string;
};

/** 在场门禁（模型或确定性实现）；失败必须 fail-closed 为沉默。 */
export interface PresenceAssessor {
  assess(input: {
    context: PresenceContext;
    candidates: readonly { characterInstanceId: string; displayName: string }[];
    budget: number;
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<PresenceDecision>;
}

/** 从本回合已提交产物确定性抽取三类触发素材（纯函数）。 */
export function extractPresenceContext(input: {
  narration?: SemanticOutputDraft | null;
  characterResponses?: readonly SemanticOutputDraft[];
  actionTransactions?: readonly ActionTransaction[];
  hookContent?: string | null;
}): PresenceContext {
  const environment = (input.narration?.segments ?? [])
    .filter((segment) => segment.kind === "environment" || segment.kind === "story")
    .map((segment) => segment.content.trim())
    .filter((content) => content.length > 0);
  const peer: string[] = [];
  for (const response of input.characterResponses ?? []) {
    for (const segment of response.segments) {
      if (segment.kind !== "dialogue") continue;
      const line = segment.content.trim();
      if (line.length > 0) peer.push(`${response.speaker}：${line}`);
    }
  }
  for (const transaction of input.actionTransactions ?? []) {
    for (const fact of transaction.receipt.publicFacts) {
      const line = fact.trim();
      if (line.length > 0) {
        peer.push(`${transaction.actor.displayName}的公开行动结果：${line}`);
      }
    }
  }
  const hook = input.hookContent?.trim() || null;
  return { environment, peer, hook };
}

export function presenceContextIsEmpty(context: PresenceContext): boolean {
  return context.environment.length === 0
    && context.peer.length === 0
    && context.hook === null;
}

/** 单一触发素材拼接为提示词文本（截断限长）。 */
export function presenceTriggerText(
  context: PresenceContext,
  kind: PresenceTriggerKind,
): string {
  const lines = kind === "environment"
    ? context.environment
    : kind === "peer"
      ? context.peer
      : context.hook
        ? [context.hook]
        : [];
  return lines.join("；").slice(0, 500);
}

/** 候选过滤：本回合已激活/已发声与冷却中角色不进候选（不重复刷同一人）。 */
export function filterPresenceCandidates(input: {
  characters: readonly ActivatedCharacter[];
  excludedCharacterInstanceIds: ReadonlySet<string>;
  turnControl: Pick<TurnControl, "canInterject">;
}): ActivatedCharacter[] {
  return input.characters.filter(
    (character) =>
      !input.excludedCharacterInstanceIds.has(character.characterInstanceId)
      && input.turnControl.canInterject(character.characterInstanceId),
  );
}

/**
 * 门禁输出确定性规整（fail-closed）：shouldSpeak 非 true、选人越候选、
 * triggerKind 越界一律沉默；本函数绝不抛错。
 */
export function normalizePresenceDecision(
  body: Record<string, unknown>,
  candidateIds: ReadonlySet<string>,
): PresenceDecision {
  const reason = typeof body.reason === "string"
    ? body.reason.trim().slice(0, PRESENCE_REASON_LIMIT)
    : "";
  if (body.shouldSpeak !== true) {
    return {
      kind: "silent",
      reason: reason || "门禁判定没有值得反应的素材。",
    };
  }
  if (
    typeof body.characterInstanceId !== "string"
    || !candidateIds.has(body.characterInstanceId)
  ) {
    return { kind: "silent", reason: "门禁选人越出候选名单，fail-closed 沉默。" };
  }
  const triggerKind = body.triggerKind;
  if (
    triggerKind !== "environment"
    && triggerKind !== "peer"
    && triggerKind !== "hook"
  ) {
    return { kind: "silent", reason: "门禁触发种类越界，fail-closed 沉默。" };
  }
  return {
    kind: "speak",
    characterInstanceId: body.characterInstanceId,
    triggerKind,
    reason: reason || "门禁判定该角色应给出简短反应。",
  };
}

/**
 * presence react 的 relationship 输出规整（fail-closed）：
 * 仅接受 {target, note} 双短文本；任何非法值归 null。
 * target 是否与在场名册真实匹配由应用层落库前校验。
 */
export function normalizePresenceRelationship(
  value: unknown,
): { target: string; note: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.target !== "string" || typeof record.note !== "string") {
    return null;
  }
  const target = record.target.trim();
  const note = record.note.trim();
  if (
    !target
    || target.length > PRESENCE_RELATIONSHIP_LIMITS.target
    || !note
    || note.length > PRESENCE_RELATIONSHIP_LIMITS.note
  ) return null;
  return { target, note };
}
