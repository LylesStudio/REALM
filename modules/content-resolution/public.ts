/**
 * 内容解析层（Content Resolution Layer）· 公共契约（引擎升级计划 §2.2）。
 *
 * base 内置内容与已挂载 RealmWorld 内容经同一层读取：world document/
 * settings、角色定义、Action 定义（skill/asset/effect/stance）、Story/Scene
 * 定义、Goal 定义与 i18n 消息束。本模块只含纯 TypeScript 契约（client-safe；
 * 依赖仅 realm-save.ts 的 WorldBinding/LOCAL_WORLD_VERSION 与 type-only 的
 * GoalDefinition/JsonValue），不得 import node:*、pg 或任何 DB 模块——
 * 内容解析层绝不暴露 SQL/DB 概念。
 *
 * 语义（fail-closed）：
 * - 请求严格：未知请求键、非法语言、非法 binding 形态一律抛
 *   ContentResolutionError（CONTENT_REQUEST_INVALID）；
 * - 身份边界：base 请求必须 worldId === "" 且 worldVersion ===
 *   LOCAL_WORLD_VERSION 哨兵；world-bound 请求的 worldId/worldVersion 必须
 *   与 binding 精确一致。任何身份不符（含用 base resolver 解 world-bound
 *   身份）抛 CONTENT_IDENTITY_REJECTED——绝不静默降级/伪装；
 * - 未知内容键返回 null（显式 miss），绝不回退到其他内容包或默认文案；
 * - 返回值为不可变纯数据（深冻结），不含函数/连接/游标。
 */
import type { GoalDefinition } from "../goals/public.ts";
import type { JsonValue } from "../runtime/public.ts";
import { ENGINE_BASE_WORLD } from "../world-transfer/engine-base.ts";
import {
  type WorldBinding,
} from "../world-transfer/realm-save.ts";

export const CONTENT_LANGUAGES = ["zh-CN", "en", "ja"] as const;
export type ContentLanguage = (typeof CONTENT_LANGUAGES)[number];

export function normalizeContentLanguage(value: unknown): ContentLanguage | undefined {
  return typeof value === "string"
    && (CONTENT_LANGUAGES as readonly string[]).includes(value)
    ? value as ContentLanguage
    : undefined;
}

export type ContentActionKind = "skill" | "asset" | "effect" | "stance";

export type ContentResolutionErrorCode =
  | "CONTENT_REQUEST_INVALID"
  | "CONTENT_IDENTITY_REJECTED";

export class ContentResolutionError extends Error {
  readonly code: ContentResolutionErrorCode;

  constructor(code: ContentResolutionErrorCode, message: string) {
    super(message);
    this.name = "ContentResolutionError";
    this.code = code;
  }
}

/**
 * 内容请求公共身份域。contentKey 选择内容包内的具体 bundle：
 * base binding 下为 engine-owned bundle key（如 "ember-coast" 演示世界或
 * preset key）；world-bound 下为包内内容键（缺省 = 包的主内容）。
 */
export interface ContentRequestBase {
  binding: WorldBinding;
  worldId: string;
  worldVersion: string;
  language: ContentLanguage;
  contentKey?: string;
}

export type WorldContentRequest = ContentRequestBase;

export interface CharacterContentRequest extends ContentRequestBase {
  characterKey: string;
}

export interface ActionContentRequest extends ContentRequestBase {
  actionKind: ContentActionKind;
  actionKey: string;
}

export interface ActionListRequest extends ContentRequestBase {
  actionKind?: ContentActionKind;
}

export interface StoryContentRequest extends ContentRequestBase {
  storyKey?: string;
}

export interface SceneContentRequest extends ContentRequestBase {
  sceneKey?: string;
}

export interface GoalContentRequest extends ContentRequestBase {
  goalKey: string;
}

export type MessagesContentRequest = ContentRequestBase;

/** Genesis 内容请求：按 binding + contentKey + language 解析完整创世内容。 */
export interface GenesisContentRequest {
  binding: WorldBinding;
  contentKey?: string;
  language: ContentLanguage;
}

/** base binding 的合法请求身份（worldId 空串 + 哨兵版本）。 */
export function baseContentRequestBase(
  language: ContentLanguage,
  contentKey?: string,
): ContentRequestBase {
  return {
    binding: { kind: "base" },
    worldId: ENGINE_BASE_WORLD.worldId,
    worldVersion: ENGINE_BASE_WORLD.worldVersion,
    language,
    ...(contentKey !== undefined ? { contentKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// 解析结果（不可变纯数据）
// ---------------------------------------------------------------------------

export interface ResolvedWorldContent {
  contentKey: string;
  name: string;
  era: string;
  summary: string;
  calendarId: string;
  style: string;
  weather: string;
  tension: string;
  displayTime: string;
  worldlineLabel: string;
  settings: Readonly<Record<string, JsonValue>>;
}

export interface ResolvedCharacterDefinition {
  characterKey: string;
  displayName: string;
  role: string;
  summary: string;
  /** true = 人类玩家席位定义。 */
  isPlayer: boolean;
}

export interface ResolvedActionDefinition {
  actionKind: ContentActionKind;
  actionKey: string;
  title: string;
  description: string;
  rulePackKey: string;
  consumable: boolean;
  /** stance/effect 类的 effect_kind；非 effect 类为 null。 */
  effectKind: string | null;
  /** 判定/结果模板等规则载荷（规范文案层，永不按界面语言翻译）。 */
  metadata: Readonly<Record<string, JsonValue>>;
}

export interface ResolvedOpeningContent {
  speaker: string;
  content: string;
  segments: readonly {
    id: string;
    kind: string;
    content: string;
    speechMode: string;
  }[];
}

export interface ResolvedStoryContent {
  storyKey: string;
  title: string;
  premise: string;
  recordTitle: string;
  opening: ResolvedOpeningContent;
}

export interface ResolvedSceneContent {
  sceneKey: string;
  title: string;
  location: string;
  weather: string;
  tension: string;
  displayTime: string;
  objective: string;
}

/** 创世全内容：world/story/record/scene/同伴阵容/Goal/开场白。 */
export interface ResolvedGenesisContent {
  contentKey: string;
  world: {
    name: string;
    era: string;
    summary: string;
    style: string;
    settings: Readonly<Record<string, JsonValue>>;
  };
  story: { title: string; premise: string };
  record: { title: string };
  scene: {
    title?: string;
    location: string;
    weather: string;
    tension: string;
    displayTime?: string;
    objective: string;
  };
  playerRole: string;
  playerStance: "player" | "observer";
  /** 同伴阵容（不含人类玩家席位定义）。 */
  characters: readonly {
    characterKey: string;
    displayName: string;
    role: string;
    summary: string;
  }[];
  goals: readonly GoalDefinition[];
  opening: string;
}

/**
 * 内容解析器公共契约。所有方法同步：world-bound 实现应先挂载/缓存包内容，
 * 解析本身不执行 IO。未知内容键返回 null；身份/请求非法抛
 * ContentResolutionError。
 */
export interface ContentResolver {
  resolveWorld(request: WorldContentRequest): ResolvedWorldContent | null;
  resolveCharacter(request: CharacterContentRequest): ResolvedCharacterDefinition | null;
  listCharacters(request: ContentRequestBase): readonly ResolvedCharacterDefinition[];
  resolveAction(request: ActionContentRequest): ResolvedActionDefinition | null;
  listActions(request: ActionListRequest): readonly ResolvedActionDefinition[];
  resolveStory(request: StoryContentRequest): ResolvedStoryContent | null;
  resolveScene(request: SceneContentRequest): ResolvedSceneContent | null;
  resolveGoal(request: GoalContentRequest): GoalDefinition | null;
  /** 该 bundle + 语言的扁平消息束；未知 bundle 返回 null。 */
  resolveMessages(request: MessagesContentRequest): Readonly<Record<string, string>> | null;
  resolveGenesisContent(request: GenesisContentRequest): ResolvedGenesisContent | null;
}

// ---------------------------------------------------------------------------
// 请求校验（fail-closed，供各 resolver 实现共用）
// ---------------------------------------------------------------------------

const REQUEST_BASE_KEYS = ["binding", "worldId", "worldVersion", "language", "contentKey"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownRequestKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ContentResolutionError(
        "CONTENT_REQUEST_INVALID",
        `unknown content request key ${where}.${key}`,
      );
    }
  }
}

/** 校验 binding 精确形态：base 恰一键；world 恰三键且身份非空。 */
export function assertExactBinding(value: unknown, where: string): WorldBinding {
  if (!isPlainObject(value)) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      `content request ${where}.binding must be an object`,
    );
  }
  const keys = Object.keys(value);
  if (value.kind === "base") {
    if (keys.length !== 1) {
      throw new ContentResolutionError(
        "CONTENT_IDENTITY_REJECTED",
        `content request ${where}.binding must be an exact { kind: "base" }`,
      );
    }
    return { kind: "base" };
  }
  if (value.kind === "world") {
    if (
      keys.length !== 3
      || typeof value.worldId !== "string"
      || typeof value.worldVersion !== "string"
      || value.worldId.trim().length === 0
      || value.worldVersion.trim().length === 0
    ) {
      throw new ContentResolutionError(
        "CONTENT_IDENTITY_REJECTED",
        `content request ${where}.binding must carry a non-empty world identity`,
      );
    }
    return { kind: "world", worldId: value.worldId, worldVersion: value.worldVersion };
  }
  throw new ContentResolutionError(
    "CONTENT_REQUEST_INVALID",
    `content request ${where}.binding.kind is unknown`,
  );
}

/**
 * 校验请求公共域并返回规范化身份。base 请求必须空 worldId + 哨兵版本；
 * world-bound 请求必须与 binding 精确一致。extraKeys 为各子请求追加的键。
 */
export function normalizeContentRequest(
  request: ContentRequestBase,
  extraKeys: readonly string[] = [],
): { binding: WorldBinding; contentKey: string | undefined; language: ContentLanguage } {
  if (!isPlainObject(request)) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      "content request must be an object",
    );
  }
  assertKnownRequestKeys(request, [...REQUEST_BASE_KEYS, ...extraKeys], "request");
  const binding = assertExactBinding(request.binding, "request");
  const language = normalizeContentLanguage(request.language);
  if (!language) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      "content request language is invalid",
    );
  }
  if (
    typeof request.worldId !== "string"
    || typeof request.worldVersion !== "string"
  ) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      "content request worldId/worldVersion must be strings",
    );
  }
  if (binding.kind === "base") {
    if (
      request.worldId !== ENGINE_BASE_WORLD.worldId
      || request.worldVersion !== ENGINE_BASE_WORLD.worldVersion
    ) {
      throw new ContentResolutionError(
        "CONTENT_IDENTITY_REJECTED",
        "base content requests must carry an empty worldId and the local sentinel worldVersion",
      );
    }
  } else if (
    request.worldId !== binding.worldId
    || request.worldVersion !== binding.worldVersion
  ) {
    throw new ContentResolutionError(
      "CONTENT_IDENTITY_REJECTED",
      "world-bound content request identity must match the binding exactly",
    );
  }
  if (
    request.contentKey !== undefined
    && (typeof request.contentKey !== "string" || request.contentKey.trim().length === 0)
  ) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      "content request contentKey must be a non-empty string",
    );
  }
  return { binding, contentKey: request.contentKey, language };
}

/** Genesis 内容请求校验（身份域与内容请求一致，无 worldId/worldVersion 键）。 */
export function normalizeGenesisContentRequest(
  request: GenesisContentRequest,
): { binding: WorldBinding; contentKey: string | undefined; language: ContentLanguage } {
  if (!isPlainObject(request)) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      "genesis content request must be an object",
    );
  }
  assertKnownRequestKeys(request, ["binding", "contentKey", "language"], "genesis");
  const binding = assertExactBinding(request.binding, "genesis");
  const language = normalizeContentLanguage(request.language);
  if (!language) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      "genesis content request language is invalid",
    );
  }
  if (
    request.contentKey !== undefined
    && (typeof request.contentKey !== "string" || request.contentKey.trim().length === 0)
  ) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      "genesis content request contentKey must be a non-empty string",
    );
  }
  return { binding, contentKey: request.contentKey, language };
}
