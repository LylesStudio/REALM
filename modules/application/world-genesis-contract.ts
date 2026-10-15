import {
  WORLD_STYLE_KEYS,
  normalizeWorldStyle,
  type WorldStyle,
} from "../style/world-style.ts";
import type { WorldBinding } from "../world-transfer/realm-save.ts";

/**
 * 启笔铸界 · client-safe 契约（Client/Server 边界修复）。
 *
 * 本模块只含纯 TypeScript 草稿类型与 normalizer，依赖仅
 * style/world-style.ts（同为 client-safe）；不得 import inference/*、
 * prompt-kit、structured-output、gateway、model settings 或 node:*。
 * server 侧模型生成在 ./world-genesis.ts（re-export 本模块保持兼容）。
 * tests/frontend-record-contract.test.ts 的 client 依赖图围栏保证此边界。
 */

export const GENESIS_CREATION_REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;

export const GENESIS_LANGUAGES = ["zh-CN", "en", "ja"] as const;
export type GenesisLanguage = (typeof GENESIS_LANGUAGES)[number];

/**
 * RealmWorld 声明式 Goal 的创建期物化声明。只携带 Record-scoped 运行态
 * 所需的键（goal key + policy version）；定义、rubric 与文案仍留在
 * RealmWorld 内容层（引擎升级计划 §2.2 硬边界），绝不随草稿落库。
 * 仅 declarative RealmWorld instantiate 路径设置；模型/表单 genesis
 * 永远不产生该字段。
 */
export interface WorldGenesisGoalDeclaration {
  goalKey: string;
  policyVersion: string;
}

export function normalizeGenesisLanguage(value: unknown): GenesisLanguage | undefined {
  return typeof value === "string"
    && (GENESIS_LANGUAGES as readonly string[]).includes(value)
    ? value as GenesisLanguage
    : undefined;
}

export interface WorldGenesisDraft {
  /** Engine-owned identity override used only by declarative RealmWorld instantiation. */
  worldIdentity?: { worldId: string; worldVersion: string };
  /** Stable runtime topology IDs used for idempotent RealmWorld instantiation. */
  runtimeIdentity?: { worldlineId: string; storyId: string; recordId: string };
  /**
   * Declarative RealmWorld Goals to materialize as Record-scoped
   * goal_instances in the same genesis transaction (and to enqueue opening
   * assessment jobs for). Absent/empty = legacy path, no behavior change.
   */
  goals?: readonly WorldGenesisGoalDeclaration[];
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
  scene: { title?: string; location: string; weather: string; tension: string; displayTime?: string; objective: string };
  /**
   * 批次 S：人类玩家的姿态。player=入局（默认），observer=观察者·执笔者。
   * 旧路径缺省按 player 处理，向后兼容。
   */
  playerStance: "player" | "observer";
  /** 批次 S：开场白（卷首旁白），≤300 字；非空时落库即插入开场事件。 */
  opening: string;
}

export type WorldGenesisSource = "model" | "fallback";

/**
 * 草稿 → 内容绑定（内容解析层入口身份）：携带 RealmWorld 身份的草稿为
 * world-bound（worldId + worldVersion 精确绑定），否则为 base。genesis
 * 经 ContentResolver/WorldBinding 消费内容时以此为一级分发依据。
 */
export function genesisBindingFromDraft(
  draft: Pick<WorldGenesisDraft, "worldIdentity">,
): WorldBinding {
  return draft.worldIdentity
    ? {
      kind: "world",
      worldId: draft.worldIdentity.worldId,
      worldVersion: draft.worldIdentity.worldVersion,
    }
    : { kind: "base" };
}

export const MAX_COMPANIONS = 2;

/**
 * 默认故事/记录标题（批次 B12）：跟随草稿内容语言，不写死中文。
 * 与 i18n `ui.guided.defaultStoryTitle/defaultRecordTitle` 同值；
 * 分步 skip 路径与本 normalizer 共用本表，保证三语一致。
 */
const DEFAULT_STORY_TITLES: Record<GenesisLanguage, string> = {
  "zh-CN": "序章",
  en: "Prologue",
  ja: "プロローグ",
};
const DEFAULT_RECORD_TITLES: Record<GenesisLanguage, string> = {
  "zh-CN": "第一章",
  en: "Chapter One",
  ja: "第一章",
};

export function defaultGenesisStoryTitle(language: GenesisLanguage | undefined): string {
  return DEFAULT_STORY_TITLES[language ?? "zh-CN"];
}

export function defaultGenesisRecordTitle(language: GenesisLanguage | undefined): string {
  return DEFAULT_RECORD_TITLES[language ?? "zh-CN"];
}

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
  sceneTitle: 60,
  sceneField: 60,
  displayTime: 60,
  objective: 120,
  opening: 300,
} as const;

/**
 * 送进模型前的未信草稿/context JSON 上限。诚实草稿远小于此值；
 * 超限在路由层拒绝，不启动模型调用。不含对谈 transcript。
 */
export const GENESIS_PROMPT_INPUT_MAX_CHARS = 8_000;

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
 * 截断到两名。世界名无法解析（草稿与灵感都为空）时返回 null——除非
 * `allowUnnamed`（对谈 partial draft 累积）：此时保留全部已定字段、
 * 世界名留空串，绝不制造伪名字；创建入口仍要求非空世界名。
 * 默认故事/记录标题跟随草稿语言（不写死中文）。
 */
export function normalizeGenesisDraft(
  value: unknown,
  prompt = "",
  options: { allowUnnamed?: boolean } = {},
): WorldGenesisDraft | null {
  const source = isObject(value) ? value : {};
  const world = isObject(source.world) ? source.world : {};
  const story = isObject(source.story) ? source.story : {};
  const record = isObject(source.record) ? source.record : {};
  const scene = isObject(source.scene) ? source.scene : {};

  const language = normalizeGenesisLanguage(source.language);
  const name = clamp(world.name, GENESIS_LIMITS.worldName) || deriveWorldName(prompt);
  if (!name && !options.allowUnnamed) return null;

  const companions = clampCompanions(source.companions);
  const sceneTitle = clamp(scene.title, GENESIS_LIMITS.sceneTitle);
  const sceneDisplayTime = clamp(scene.displayTime, GENESIS_LIMITS.displayTime);

  return {
    ...(language ? { language } : {}),
    world: {
      name,
      era: clamp(world.era, GENESIS_LIMITS.era),
      summary: clamp(world.summary, GENESIS_LIMITS.summary) || deriveSummary(prompt),
    },
    style: normalizeWorldStyle(source.style),
    playerStance: source.playerStance === "observer" ? "observer" : "player",
    opening: clamp(source.opening, GENESIS_LIMITS.opening),
    story: {
      title: clamp(story.title, GENESIS_LIMITS.storyTitle) || defaultGenesisStoryTitle(language),
      premise: clamp(story.premise, GENESIS_LIMITS.premise) || deriveSummary(prompt),
    },
    record: {
      title: clamp(record.title, GENESIS_LIMITS.recordTitle) || defaultGenesisRecordTitle(language),
    },
    playerRole: clamp(source.playerRole, GENESIS_LIMITS.playerRole),
    companions,
    scene: {
      ...(sceneTitle ? { title: sceneTitle } : {}),
      location: clamp(scene.location, GENESIS_LIMITS.sceneField),
      weather: clamp(scene.weather, GENESIS_LIMITS.sceneField),
      tension: clamp(scene.tension, GENESIS_LIMITS.sceneField),
      ...(sceneDisplayTime ? { displayTime: sceneDisplayTime } : {}),
      objective: clamp(scene.objective, GENESIS_LIMITS.objective),
    },
  };
}

function clampCompanions(value: unknown): WorldGenesisDraft["companions"] {
  return (Array.isArray(value) ? value : [])
    .map((item) => (isObject(item) ? item : {}))
    .map((item) => ({
      name: clamp(item.name, GENESIS_LIMITS.companionName),
      role: clamp(item.role, GENESIS_LIMITS.companionRole),
      summary: clamp(item.summary, GENESIS_LIMITS.companionSummary),
    }))
    .filter((item) => item.name.length > 0)
    .slice(0, MAX_COMPANIONS);
}

function knownStyle(value: unknown): WorldStyle | undefined {
  return typeof value === "string"
    && (WORLD_STYLE_KEYS as readonly string[]).includes(value)
    ? value as WorldStyle
    : undefined;
}

/** 未信 JSON 在进入 prompt 之前的体积闸门。无法序列化视为超限。 */
export function genesisPromptInputWithinBudget(value: unknown): boolean {
  if (value == null) return true;
  try {
    return JSON.stringify(value).length <= GENESIS_PROMPT_INPUT_MAX_CHARS;
  } catch {
    return false;
  }
}

/**
 * 把客户端草稿收成 prompt 可用的有界 DTO。
 * 不发明默认标题，不接收 goals / worldIdentity / runtimeIdentity，
 * 错误形状（companions 不是数组、scene 不是对象）直接丢弃而不是抛错。
 */
export function sanitizeUntrustedGenesisDraft(value: unknown): Partial<WorldGenesisDraft> {
  if (!isObject(value)) return {};
  const result: Partial<WorldGenesisDraft> = {};
  const language = normalizeGenesisLanguage(value.language);
  if (language) result.language = language;

  if (isObject(value.world)) {
    const name = clamp(value.world.name, GENESIS_LIMITS.worldName);
    const era = clamp(value.world.era, GENESIS_LIMITS.era);
    const summary = clamp(value.world.summary, GENESIS_LIMITS.summary);
    if (name || era || summary) result.world = { name, era, summary };
  }
  const style = knownStyle(value.style);
  if (style) result.style = style;

  if (isObject(value.story)) {
    const title = clamp(value.story.title, GENESIS_LIMITS.storyTitle);
    const premise = clamp(value.story.premise, GENESIS_LIMITS.premise);
    if (title || premise) result.story = { title, premise };
  }
  if (isObject(value.record)) {
    const title = clamp(value.record.title, GENESIS_LIMITS.recordTitle);
    if (title) result.record = { title };
  }
  const playerRole = clamp(value.playerRole, GENESIS_LIMITS.playerRole);
  if (playerRole) result.playerRole = playerRole;
  if (value.playerStance === "observer" || value.playerStance === "player") {
    result.playerStance = value.playerStance;
  }
  const opening = clamp(value.opening, GENESIS_LIMITS.opening);
  if (opening) result.opening = opening;

  const companions = clampCompanions(value.companions);
  if (companions.length > 0) result.companions = companions;

  if (isObject(value.scene)) {
    const title = clamp(value.scene.title, GENESIS_LIMITS.sceneTitle);
    const location = clamp(value.scene.location, GENESIS_LIMITS.sceneField);
    const weather = clamp(value.scene.weather, GENESIS_LIMITS.sceneField);
    const tension = clamp(value.scene.tension, GENESIS_LIMITS.sceneField);
    const displayTime = clamp(value.scene.displayTime, GENESIS_LIMITS.displayTime);
    const objective = clamp(value.scene.objective, GENESIS_LIMITS.objective);
    if (title || location || weather || tension || displayTime || objective) {
      result.scene = {
        ...(title ? { title } : {}),
        location,
        weather,
        tension,
        ...(displayTime ? { displayTime } : {}),
        objective,
      };
    }
  }
  return result;
}

/**
 * 模型可见的已定稿视图（批次 A5）：嵌套形状与 draftPatch 输出 schema
 * 同构——world/story/record/scene 保持各自字段身份，不再用扁平别名
 * （world=名字串、openingStory 等），避免模型把别名抄回 draftPatch。
 * 保留显式空值和合法枚举；不会把用户清除的字段伪装成尚未填写。
 */
export function settledGenesisView(value: unknown): Record<string, unknown> | null {
  const draft = sanitizeUntrustedGenesisDraft(value);
  // Empty editable values are settled values too, not invitations to refill them.
  if (isObject(value)) {
    if (typeof value.opening === "string") draft.opening = clamp(value.opening, GENESIS_LIMITS.opening);
    if (typeof value.playerRole === "string") draft.playerRole = clamp(value.playerRole, GENESIS_LIMITS.playerRole);
    if (Array.isArray(value.companions)) draft.companions = clampCompanions(value.companions);
  }
  const view: Record<string, unknown> = {};
  if (draft.language) view.language = draft.language;
  if (draft.world) {
    const world: Record<string, string> = {};
    if (typeof draft.world.name === "string") world.name = draft.world.name;
    if (typeof draft.world.era === "string") world.era = draft.world.era;
    if (typeof draft.world.summary === "string") world.summary = draft.world.summary;
    if (Object.keys(world).length > 0) view.world = world;
  }
  if (draft.style) view.style = draft.style;
  if (draft.story) {
    const story: Record<string, string> = {};
    if (typeof draft.story.title === "string") story.title = draft.story.title;
    if (typeof draft.story.premise === "string") story.premise = draft.story.premise;
    if (Object.keys(story).length > 0) view.story = story;
  }
  if (typeof draft.record?.title === "string") view.record = { title: draft.record.title };
  if (typeof draft.playerRole === "string") view.playerRole = draft.playerRole;
  if (draft.playerStance) view.playerStance = draft.playerStance;
  if (typeof draft.opening === "string") view.opening = draft.opening;
  if (Array.isArray(draft.companions)) {
    view.companions = draft.companions.map((item) => ({
      name: item.name,
      ...(item.role ? { role: item.role } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
    }));
  }
  const scene: Record<string, string> = {};
  if (typeof draft.scene?.title === "string") scene.title = draft.scene.title;
  if (typeof draft.scene?.location === "string") scene.location = draft.scene.location;
  if (typeof draft.scene?.weather === "string") scene.weather = draft.scene.weather;
  if (typeof draft.scene?.tension === "string") scene.tension = draft.scene.tension;
  if (typeof draft.scene?.displayTime === "string") scene.displayTime = draft.scene.displayTime;
  if (typeof draft.scene?.objective === "string") scene.objective = draft.scene.objective;
  if (Object.keys(scene).length > 0) view.scene = scene;
  return Object.keys(view).length > 0 ? view : null;
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
