import { WORLD_STYLE_KEYS, normalizeWorldStyle } from "../style/world-style.ts";
import {
  GENESIS_LIMITS,
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
  /**
   * 本轮开场白增量（≤300 字）的兼容回显；canonical 位置是
   * draftPatch.opening（任何阶段都可保留，显式空串=清除）。
   */
  opening: string;
}

export const GENESIS_CHAT_MAX_TURNS = 16;
export const GENESIS_CHAT_MAX_TURN_CHARS = 500;
export const MAX_REPLY_CHARS = 1000;
export const MAX_OPENING_CHARS = GENESIS_LIMITS.opening;

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
  const name = clampText(value.name, GENESIS_LIMITS.companionName);
  if (!name) return null;
  return {
    name,
    role: clampText(value.role, GENESIS_LIMITS.companionRole),
    summary: clampText(value.summary, GENESIS_LIMITS.companionSummary),
  };
}

/**
 * draftPatch 字段语义（批次 A3，prompt 说明与本函数同源）：
 * - 字段省略或显式 null = 不改（宽松客户端兼容）；
 * - 可选文本（world.era/summary、story.premise、playerRole、opening、
 *   scene 六字段）显式空字符串 = 清除；非空字符串 = 覆盖；
 * - world.name / story.title / record.title 显式空串或错误类型 = 非法，
 *   不收进 patch（由 hasDiscardedProposalFields 升级为 repair/拒绝）；
 * - style/language/playerStance 只收合法枚举；非法枚举值同上 fail-closed，
 *   绝不 silently default 覆盖既有草稿；
 * - companions 是完整快照替换：数组 = 整表替换（[] = 清空），省略/null = 不改，
 *   非数组其他值 = 非法。
 * 无任何可识别字段时返回 null。
 */
export function sanitizeDraftPatch(
  patch: unknown,
): Partial<WorldGenesisDraft> | null {
  if (!isObject(patch)) return null;
  const result: Record<string, unknown> = {};

  if (patch.language === "zh-CN" || patch.language === "en" || patch.language === "ja") {
    result.language = patch.language;
  }
  if (isObject(patch.world)) {
    const world: Record<string, string> = {};
    const name = clampText(patch.world.name, GENESIS_LIMITS.worldName);
    // 可选文本显式空串 = 清除；name 空串非法（不收键 → 上游 reject/repair）。
    if (typeof patch.world.name === "string" && name) world.name = name;
    if (typeof patch.world.era === "string") {
      world.era = clampText(patch.world.era, GENESIS_LIMITS.era);
    }
    if (typeof patch.world.summary === "string") {
      world.summary = clampText(patch.world.summary, GENESIS_LIMITS.summary);
    }
    if (Object.keys(world).length > 0) result.world = world;
  }
  if (patch.style !== undefined && patch.style !== null) {
    // 非法 style 不收键——交给 discarded-fields 检查 fail-closed，不归一为 modern。
    if (typeof patch.style === "string"
      && (WORLD_STYLE_KEYS as readonly string[]).includes(patch.style)) {
      result.style = normalizeWorldStyle(patch.style);
    }
  }
  if (isObject(patch.story)) {
    const story: Record<string, string> = {};
    const title = clampText(patch.story.title, GENESIS_LIMITS.storyTitle);
    if (typeof patch.story.title === "string" && title) story.title = title;
    if (typeof patch.story.premise === "string") {
      story.premise = clampText(patch.story.premise, GENESIS_LIMITS.premise);
    }
    if (Object.keys(story).length > 0) result.story = story;
  }
  if (isObject(patch.record)) {
    const title = clampText(patch.record.title, GENESIS_LIMITS.recordTitle);
    if (typeof patch.record.title === "string" && title) result.record = { title };
  }
  if (patch.playerRole !== undefined && patch.playerRole !== null) {
    if (typeof patch.playerRole === "string") {
      result.playerRole = clampText(patch.playerRole, GENESIS_LIMITS.playerRole);
    }
  }
  // companions 是完整快照替换，不是逐条增量。空数组表示清空，省略/null 才是不改。
  if (Array.isArray(patch.companions)) {
    result.companions = patch.companions
      .map((item) => clampCompanion(item))
      .filter((item): item is { name: string; role: string; summary: string } => item !== null)
      .slice(0, 2);
  }
  if (isObject(patch.scene)) {
    const scene: Record<string, string> = {};
    if (typeof patch.scene.title === "string") {
      scene.title = clampText(patch.scene.title, GENESIS_LIMITS.sceneTitle);
    }
    if (typeof patch.scene.location === "string") {
      scene.location = clampText(patch.scene.location, GENESIS_LIMITS.sceneField);
    }
    if (typeof patch.scene.weather === "string") {
      scene.weather = clampText(patch.scene.weather, GENESIS_LIMITS.sceneField);
    }
    if (typeof patch.scene.tension === "string") {
      scene.tension = clampText(patch.scene.tension, GENESIS_LIMITS.sceneField);
    }
    if (typeof patch.scene.displayTime === "string") {
      scene.displayTime = clampText(patch.scene.displayTime, GENESIS_LIMITS.displayTime);
    }
    if (typeof patch.scene.objective === "string") {
      scene.objective = clampText(patch.scene.objective, GENESIS_LIMITS.objective);
    }
    if (Object.keys(scene).length > 0) result.scene = scene;
  }
  if (patch.playerStance === "observer" || patch.playerStance === "player") {
    result.playerStance = patch.playerStance;
  }
  if (patch.opening !== undefined && patch.opening !== null) {
    if (typeof patch.opening === "string") {
      result.opening = clampText(patch.opening, MAX_OPENING_CHARS);
    }
  }

  return Object.keys(result).length > 0
    ? (result as Partial<WorldGenesisDraft>)
    : null;
}

/**
 * draftPatch 合并：只覆盖 patch 中出现的字段（对象字段做浅层合并）。
 * companions 例外：出现即整表替换，不按匿名下标猜测增量。
 * 合并结果经 normalizeGenesisDraft(allowUnnamed) 同源规整——批次 A2：
 * 世界名未定时返回保留全部已定字段的 partial 草稿（世界名空串，
 * 可跨轮累积），绝不制造伪名字；创建入口另作完整性校验。
 * 仅在 base 与 patch 都无可识别内容时返回 null。
 */
export function mergeDraftPatch(
  base: Partial<WorldGenesisDraft> | null | undefined,
  patch: unknown,
): WorldGenesisDraft | null {
  const sanitized = patch === null || patch === undefined
    ? null
    : sanitizeDraftPatch(patch);
  if (!sanitized && !isObject(base)) return null;
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
  return normalizeGenesisDraft(source, "", { allowUnnamed: true });
}

/**
 * 批次 B7：对谈在途期间用户手改的字段路径集合。
 * 字段路径粒度：world/story/record/scene 到子字段，companions 整组，
 * 其余顶层字段（style/language/playerRole/playerStance/opening）整字段。
 */
export const GENESIS_EDITABLE_FIELD_PATHS = [
  "world.name", "world.era", "world.summary",
  "story.title", "story.premise", "record.title",
  "style", "language", "playerRole", "playerStance", "opening",
  "companions",
  "scene.title", "scene.location", "scene.weather",
  "scene.tension", "scene.displayTime", "scene.objective",
] as const;

export type GenesisEditableFieldPath = (typeof GENESIS_EDITABLE_FIELD_PATHS)[number];

function fieldValue(
  draft: Partial<WorldGenesisDraft> | null | undefined,
  path: GenesisEditableFieldPath,
): unknown {
  if (!draft) return undefined;
  const [group, key] = path.split(".") as [string, string | undefined];
  const source = draft as Record<string, unknown>;
  if (key === undefined) return source[group];
  const nested = source[group];
  return isObject(nested) ? nested[key] : undefined;
}

/**
 * 对比请求发出时的快照与当前草稿，列出用户手改过的字段路径。
 * companions 按 JSON 整体比较（匿名行不做逐行猜测）。
 */
export function diffEditedGenesisFields(
  before: Partial<WorldGenesisDraft> | null | undefined,
  after: Partial<WorldGenesisDraft> | null | undefined,
): GenesisEditableFieldPath[] {
  const edited: GenesisEditableFieldPath[] = [];
  for (const path of GENESIS_EDITABLE_FIELD_PATHS) {
    const a = fieldValue(before, path);
    const b = fieldValue(after, path);
    const same = path === "companions"
      ? JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
      : (a ?? "") === (b ?? "");
    if (!same) edited.push(path);
  }
  return edited;
}

/**
 * 把用户在在途期间手改的字段值盖回服务端合并结果：
 * 模型 patch 只落在用户没碰过的字段上（不误丢未冲突的模型更新）。
 */
export function applyGenesisFieldEdits(
  merged: WorldGenesisDraft,
  current: Partial<WorldGenesisDraft> | null | undefined,
  edited: readonly GenesisEditableFieldPath[],
): WorldGenesisDraft {
  if (!current || edited.length === 0) return merged;
  const result: WorldGenesisDraft = {
    ...merged,
    world: { ...merged.world },
    story: { ...merged.story },
    record: { ...merged.record },
    scene: { ...merged.scene },
    companions: merged.companions.map((item) => ({ ...item })),
  };
  for (const path of edited) {
    const value = fieldValue(current, path);
    const [group, key] = path.split(".") as [string, string | undefined];
    if (key === undefined) {
      if (path === "companions") {
        result.companions = (Array.isArray(value) ? value : [])
          .map((item) => ({ ...(item as { name: string; role: string; summary: string }) }));
      } else {
        (result as unknown as Record<string, unknown>)[group] = value;
      }
    } else {
      const nested = (result as unknown as Record<string, unknown>)[group];
      if (isObject(nested)) (nested as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

/** 正式提案不能借已有草稿通过校验，同时悄悄丢掉错名字段或同伴。
 *  显式 null 字段视为「不改」（宽松客户端兼容），不计入丢弃。 */
function hasDiscardedProposalFields(raw: unknown, sanitized: unknown): boolean {
  if (isObject(raw) && !isObject(sanitized)) {
    return Object.keys(raw).some((key) => (raw as Record<string, unknown>)[key] !== null);
  }
  if (Array.isArray(raw)) {
    return !Array.isArray(sanitized)
      || raw.length !== sanitized.length
      || raw.some((item, index) => hasDiscardedProposalFields(item, sanitized[index]));
  }
  if (!isObject(raw)) return false;
  if (!isObject(sanitized)) return true;
  return Object.keys(raw).some((key) => {
    const value = (raw as Record<string, unknown>)[key];
    if (value === null) return false;
    return !Object.hasOwn(sanitized, key)
      || hasDiscardedProposalFields(value, (sanitized as Record<string, unknown>)[key]);
  });
}

/**
 * 模型响应规整：phase 枚举非法 / reply 为空 → null（fail-closed）。
 *
 * opening 的唯一 canonical 位置是 draftPatch.opening（批次 A1）：任何阶段
 * 提供的合法开场正文都随草稿保留，不再因 phase≠ready 被悄悄清除。
 * 顶层 opening 只是兼容输入——仅当 draftPatch.opening 缺席时并入 patch；
 * 两处同时出现以 draftPatch.opening 为准；顶层省略或空串都是「不改」，
 * 清空开场只能显式走 draftPatch.opening = ""。
 *
 * 批次 A2：exploring 阶段保留合法 partial patch（世界名未定也可累积）；
 * proposing / ready 必须有可用提案且合并后世界名非空；无效增量返回 null
 * 触发有界 schema repair，不能悄悄丢掉提案却把一句“已成型”当成功。
 */
export function normalizeGenesisChatResponse(
  raw: unknown,
  baseDraft: Partial<WorldGenesisDraft> | null,
): GenesisChatOutcome | null {
  if (!isObject(raw)) return null;
  const reply = clampText(raw.reply, MAX_REPLY_CHARS);
  if (!reply) return null;
  if (!isGenesisChatPhase(raw.phase)) return null;

  // A1：顶层 opening 兼容输入并入 patch（仅当 patch 未携带 opening）。
  let rawPatch: unknown = raw.draftPatch;
  if (typeof raw.opening === "string" && raw.opening.trim()) {
    const patchObject = isObject(rawPatch) ? { ...rawPatch } : {};
    if (patchObject.opening === undefined) patchObject.opening = raw.opening;
    rawPatch = patchObject;
  }

  let draftPatch: Partial<WorldGenesisDraft> | null = null;
  let mergedDraft = mergeDraftPatch(baseDraft, null);
  if (rawPatch !== null && rawPatch !== undefined) {
    const sanitized = sanitizeDraftPatch(rawPatch);
    if (hasDiscardedProposalFields(rawPatch, sanitized)) {
      return null;
    }
    const merged = sanitized ? mergeDraftPatch(baseDraft, sanitized) : null;
    if (sanitized && merged) {
      // exploring：partial 保留（世界名可未定）；proposing/ready：必须成型。
      if (raw.phase === "exploring" || merged.world.name) {
        draftPatch = sanitized;
        mergedDraft = merged;
      } else {
        return null;
      }
    } else if (raw.phase !== "exploring") {
      return null;
    }
  }
  if (raw.phase !== "exploring" && (!mergedDraft || !mergedDraft.world.name)) return null;

  // 兼容回显：本轮 canonical opening 增量（新值）；客户端应以 draftPatch 合并为准。
  const opening = draftPatch && typeof draftPatch.opening === "string"
    ? draftPatch.opening
    : "";

  return { reply, draftPatch, phase: raw.phase, opening };
}
