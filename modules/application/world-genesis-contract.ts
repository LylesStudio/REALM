import { normalizeWorldStyle, type WorldStyle } from "../style/world-style.ts";

/**
 * 启笔铸界 · client-safe 契约（Client/Server 边界修复）。
 *
 * 本模块只含纯 TypeScript 草稿类型与 normalizer，依赖仅
 * style/world-style.ts（同为 client-safe）；不得 import inference/*、
 * prompt-kit、structured-output、gateway、model settings 或 node:*。
 * server 侧模型生成在 ./world-genesis.ts（re-export 本模块保持兼容）。
 * tests/frontend-record-contract.test.ts 的 client 依赖图围栏保证此边界。
 */

export const GENESIS_LANGUAGES = ["zh-CN", "en", "ja"] as const;
export type GenesisLanguage = (typeof GENESIS_LANGUAGES)[number];

export function normalizeGenesisLanguage(value: unknown): GenesisLanguage | undefined {
  return typeof value === "string"
    && (GENESIS_LANGUAGES as readonly string[]).includes(value)
    ? value as GenesisLanguage
    : undefined;
}

export interface WorldGenesisDraft {
  world: { name: string; era: string; summary: string };
  /** 初始运行内容语言；缺省时由当前账号的系统/界面语言补齐。 */
  language?: GenesisLanguage;
  /** 世界文风；缺省 modern（未点选/留白跳过）。 */
  style: WorldStyle;
  story: { title: string; premise: string };
  record: { title: string };
  /** 人类玩家在本世界中的角色定位（名称来自登录账号，不在草稿内）。 */
  playerRole: string;
  /** 契合世界观的本地 AI 同伴，至多两名。 */
  companions: { name: string; role: string; summary: string }[];
  scene: { location: string; weather: string; tension: string; objective: string };
  /**
   * 批次 S：人类玩家的姿态。player=入局（默认），observer=观察者·执笔者。
   * 旧路径缺省按 player 处理，向后兼容。
   */
  playerStance: "player" | "observer";
  /** 批次 S：开场白（卷首旁白），≤300 字；非空时落库即插入开场事件。 */
  opening: string;
}

export type WorldGenesisSource = "model" | "fallback";

export const MAX_COMPANIONS = 2;

/** 创世手稿字段上限：prompt 说明与规整同源（Prompt System v2）。 */
export const GENESIS_LIMITS = {
  worldName: 40,
  era: 40,
  summary: 300,
  storyTitle: 60,
  premise: 300,
  recordTitle: 60,
  playerRole: 60,
  companionName: 24,
  companionRole: 40,
  companionSummary: 120,
  sceneField: 60,
  objective: 120,
  opening: 300,
} as const;

function clamp(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 从灵感原文提炼一个可用的世界名（降级与补缺共用）。 */
function deriveWorldName(prompt: string): string {
  const firstClause = prompt
    .split(/[\n，。,.!！?？；;：:]/)
    .map((part) => part.trim())
    .find((part) => part.length > 0) ?? "";
  return firstClause.slice(0, 12);
}

/** 从灵感原文提炼背景摘要。 */
function deriveSummary(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * 宽容规整草稿：字段缺失时留空或由灵感原文提炼；同伴过滤无名条目并
 * 截断到两名。世界名无法解析（草稿与灵感都为空）时返回 null。
 */
export function normalizeGenesisDraft(
  value: unknown,
  prompt = "",
): WorldGenesisDraft | null {
  const source = isObject(value) ? value : {};
  const world = isObject(source.world) ? source.world : {};
  const story = isObject(source.story) ? source.story : {};
  const record = isObject(source.record) ? source.record : {};
  const scene = isObject(source.scene) ? source.scene : {};

  const name = clamp(world.name, GENESIS_LIMITS.worldName) || deriveWorldName(prompt);
  if (!name) return null;

  const companions = (Array.isArray(source.companions) ? source.companions : [])
    .map((item) => (isObject(item) ? item : {}))
    .map((item) => ({
      name: clamp(item.name, GENESIS_LIMITS.companionName),
      role: clamp(item.role, GENESIS_LIMITS.companionRole),
      summary: clamp(item.summary, GENESIS_LIMITS.companionSummary),
    }))
    .filter((item) => item.name.length > 0)
    .slice(0, MAX_COMPANIONS);

  return {
    ...(normalizeGenesisLanguage(source.language)
      ? { language: normalizeGenesisLanguage(source.language) }
      : {}),
    world: {
      name,
      era: clamp(world.era, GENESIS_LIMITS.era),
      summary: clamp(world.summary, GENESIS_LIMITS.summary) || deriveSummary(prompt),
    },
    style: normalizeWorldStyle(source.style),
    playerStance: source.playerStance === "observer" ? "observer" : "player",
    opening: clamp(source.opening, GENESIS_LIMITS.opening),
    story: {
      title: clamp(story.title, GENESIS_LIMITS.storyTitle) || "序章",
      premise: clamp(story.premise, GENESIS_LIMITS.premise) || deriveSummary(prompt),
    },
    record: {
      title: clamp(record.title, GENESIS_LIMITS.recordTitle) || "第一笔",
    },
    playerRole: clamp(source.playerRole, GENESIS_LIMITS.playerRole),
    companions,
    scene: {
      location: clamp(scene.location, GENESIS_LIMITS.sceneField),
      weather: clamp(scene.weather, GENESIS_LIMITS.sceneField),
      tension: clamp(scene.tension, GENESIS_LIMITS.sceneField),
      objective: clamp(scene.objective, GENESIS_LIMITS.objective),
    },
  };
}

/** 模型不可用时的确定性本地生成：只从灵感原文提炼，不虚构阵容。 */
export function fallbackGenesisDraft(prompt: string): WorldGenesisDraft {
  const draft = normalizeGenesisDraft({}, prompt);
  if (!draft) {
    // prompt 经路由校验非空，这里只是类型上的兜底。
    throw new Error("World genesis prompt is empty.");
  }
  return draft;
}
