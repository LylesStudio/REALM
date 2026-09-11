import { normalizeWorldStyle } from "../style/world-style.ts";
import {
  normalizeGenesisDraft,
  type WorldGenesisDraft,
} from "./world-genesis-contract.ts";

/**
 * 司卷对谈 · client-safe 契约（Client/Server 边界修复）。
 *
 * 纯类型/常量与纯函数（transcript 截断、draftPatch 消毒/合并、响应规整）。
 * 不得 import inference/*、prompt-kit、gateway 或 node:*；模型调用通道在
 * ./genesis-chat.ts（server-only，re-export 本模块保持兼容）。
 * tests/frontend-record-contract.test.ts 的 client 依赖图围栏保证此边界。
 */

export type GenesisChatRole = "user" | "scribe";

export interface GenesisChatTurn {
  role: GenesisChatRole;
  content: string;
}

export type GenesisChatPhase = "exploring" | "proposing" | "ready";

/** 对谈阶段的权威枚举（prompt 说明与校验同源）。 */
export const GENESIS_CHAT_PHASES = ["exploring", "proposing", "ready"] as const;

export function isGenesisChatPhase(value: unknown): value is GenesisChatPhase {
  return (GENESIS_CHAT_PHASES as readonly string[]).includes(value as string);
}

export interface GenesisChatOutcome {
  reply: string;
  /** 本轮提案增量（已消毒限长）；null 表示本轮不定稿。 */
  draftPatch: Partial<WorldGenesisDraft> | null;
  phase: GenesisChatPhase;
  /** 开场白，仅 phase=ready 时可能非空，≤300 字。 */
  opening: string;
}

export const GENESIS_CHAT_MAX_TURNS = 16;
export const GENESIS_CHAT_MAX_TURN_CHARS = 500;
export const MAX_REPLY_CHARS = 1000;
export const MAX_OPENING_CHARS = 300;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 通用文本修剪（transcript/draft/响应规整共用；server 通道也用）。 */
export function clampGenesisText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

const clampText = clampGenesisText;

/**
 * 对话历史截断：只保留 role ∈ {user, scribe} 且内容非空的条目，
 * 单条裁至 500 字，整体只取最近 16 条。
 */
export function truncateTranscript(value: unknown): GenesisChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: GenesisChatTurn[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const role = item.role;
    if (role !== "user" && role !== "scribe") continue;
    const content = clampText(item.content, GENESIS_CHAT_MAX_TURN_CHARS);
    if (!content) continue;
    turns.push({ role, content });
  }
  return turns.slice(-GENESIS_CHAT_MAX_TURNS);
}

function clampCompanion(value: unknown): { name: string; role: string; summary: string } | null {
  if (!isObject(value)) return null;
  const name = clampText(value.name, 24);
  if (!name) return null;
  return {
    name,
    role: clampText(value.role, 40),
    summary: clampText(value.summary, 120),
  };
}

/**
 * draftPatch 消毒：只保留草稿契约内的字段并逐字段限长；
 * 无任何可识别字段时返回 null。
 */
export function sanitizeDraftPatch(
  patch: unknown,
): Partial<WorldGenesisDraft> | null {
  if (!isObject(patch)) return null;
  const result: Record<string, unknown> = {};

  if (isObject(patch.world)) {
    const world: Record<string, string> = {};
    const name = clampText(patch.world.name, 40);
    const era = clampText(patch.world.era, 40);
    const summary = clampText(patch.world.summary, 300);
    if (name) world.name = name;
    if (era) world.era = era;
    if (summary) world.summary = summary;
    if (Object.keys(world).length > 0) result.world = world;
  }
  if (patch.style !== undefined) {
    result.style = normalizeWorldStyle(patch.style);
  }
  if (isObject(patch.story)) {
    const story: Record<string, string> = {};
    const title = clampText(patch.story.title, 60);
    const premise = clampText(patch.story.premise, 300);
    if (title) story.title = title;
    if (premise) story.premise = premise;
    if (Object.keys(story).length > 0) result.story = story;
  }
  if (isObject(patch.record)) {
    const title = clampText(patch.record.title, 60);
    if (title) result.record = { title };
  }
  if (patch.playerRole !== undefined) {
    result.playerRole = clampText(patch.playerRole, 60);
  }
  if (Array.isArray(patch.companions)) {
    result.companions = patch.companions
      .map((item) => clampCompanion(item))
      .filter((item): item is { name: string; role: string; summary: string } => item !== null)
      .slice(0, 2);
  }
  if (isObject(patch.scene)) {
    const scene: Record<string, string> = {};
    const location = clampText(patch.scene.location, 60);
    const weather = clampText(patch.scene.weather, 60);
    const tension = clampText(patch.scene.tension, 60);
    const objective = clampText(patch.scene.objective, 120);
    if (location) scene.location = location;
    if (weather) scene.weather = weather;
    if (tension) scene.tension = tension;
    if (objective) scene.objective = objective;
    if (Object.keys(scene).length > 0) result.scene = scene;
  }
  if (patch.playerStance === "observer" || patch.playerStance === "player") {
    result.playerStance = patch.playerStance;
  }
  if (patch.opening !== undefined) {
    result.opening = clampText(patch.opening, MAX_OPENING_CHARS);
  }

  return Object.keys(result).length > 0
    ? (result as Partial<WorldGenesisDraft>)
    : null;
}

/**
 * draftPatch 合并：只覆盖 patch 中出现的字段（对象字段做浅层合并），
 * 合并结果经 normalizeGenesisDraft 同源规整；整体非法（如世界名缺失）
 * 返回 null——fail-closed。
 */
export function mergeDraftPatch(
  base: Partial<WorldGenesisDraft> | null | undefined,
  patch: unknown,
): WorldGenesisDraft | null {
  const sanitized = patch === null || patch === undefined
    ? null
    : sanitizeDraftPatch(patch);
  const source: Record<string, unknown> = isObject(base) ? { ...base } : {};
  if (sanitized) {
    for (const [key, value] of Object.entries(sanitized)) {
      if (
        (key === "world" || key === "story" || key === "record" || key === "scene")
        && isObject(source[key])
        && isObject(value)
      ) {
        source[key] = { ...(source[key] as object), ...value };
      } else {
        source[key] = value;
      }
    }
  }
  return normalizeGenesisDraft(source, "");
}

/**
 * 模型响应规整：phase 枚举非法 / reply 为空 → null（fail-closed）。
 * draftPatch 消毒后无可识别字段、或与 base 合并后整体非法（如探索期
 * 尚未谈出世界名）→ 只丢弃本轮 patch（按 null 处理），对谈照常继续——
 * 无效增量绝不进草稿，但司卷的回应仍然成立。opening 仅在 phase=ready 保留。
 */
export function normalizeGenesisChatResponse(
  raw: unknown,
  baseDraft: Partial<WorldGenesisDraft> | null,
): GenesisChatOutcome | null {
  if (!isObject(raw)) return null;
  const reply = clampText(raw.reply, MAX_REPLY_CHARS);
  if (!reply) return null;
  if (!isGenesisChatPhase(raw.phase)) return null;

  let draftPatch: Partial<WorldGenesisDraft> | null = null;
  if (raw.draftPatch !== null && raw.draftPatch !== undefined) {
    const sanitized = sanitizeDraftPatch(raw.draftPatch);
    if (sanitized && mergeDraftPatch(baseDraft, sanitized)) {
      draftPatch = sanitized;
    }
  }

  const opening = raw.phase === "ready"
    ? clampText(raw.opening, MAX_OPENING_CHARS)
    : "";

  return { reply, draftPatch, phase: raw.phase, opening };
}
