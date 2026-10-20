import type { GoalDefinition } from "../goals/public.ts";
import type { JsonValue } from "../runtime/public.ts";
import { ENGINE_BASE_WORLD, ENGINE_BASE_CONTENT_VERSION } from "./engine-base.ts";

export interface BaseGoalDefinitionRequest {
  worldId: string;
  worldVersion: string;
  goalKey: string;
}

/**
 * Public engine-owned Goal content for base mode. RealmWorld packages provide
 * their own definitions; these definitions are deliberately small and generic
 * so base mode can dogfood the same resolver without requiring an install.
 */
function freezeContent<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeContent(child);
    Object.freeze(value);
  }
  return value;
}
export const BUILTIN_BASE_GOAL_DEFINITIONS: readonly GoalDefinition[] = freezeContent([
  {
    goalKey: "base.first-narration",
    policyVersion: "base-v1",
    mode: "deterministic",
    visible: true,
    rubric: {
      kind: "event_count",
      eventKind: "narration.committed",
      progressKey: "narrations",
      threshold: 1,
    },
    outcome: {
      title: "The story has begun",
      kind: "base-opening",
    },
  },
]);

/** Append revisions here on an engine content change; retain historical bytes.
 * The pinned complete-set hash prevents changing a revision in place. */
export const ENGINE_BASE_GOAL_REVISIONS = freezeContent({
  "1.0.0": { revision: "1.0.0", definitions: BUILTIN_BASE_GOAL_DEFINITIONS,
    contentHash: "4c9053595939b6a146a2230363c8cc8a3211740ce2502f3b5123edd90e98f261" },
});
export function resolveBaseGoalRevision(revision = ENGINE_BASE_CONTENT_VERSION) {
  return Object.hasOwn(ENGINE_BASE_GOAL_REVISIONS, revision)
    ? ENGINE_BASE_GOAL_REVISIONS[revision as keyof typeof ENGINE_BASE_GOAL_REVISIONS] : null;
}

export function createBaseGoalDefinitionResolver(
  definitions: readonly GoalDefinition[] = BUILTIN_BASE_GOAL_DEFINITIONS,
): (request: BaseGoalDefinitionRequest) => GoalDefinition | null {
  const byKey = new Map<string, GoalDefinition>();
  for (const definition of definitions) {
    if (
      !definition
      || typeof definition.goalKey !== "string"
      || definition.goalKey.trim().length === 0
      || byKey.has(definition.goalKey)
    ) {
      throw new Error("Base Goal definitions must have unique non-empty keys.");
    }
    byKey.set(definition.goalKey, definition);
  }
  return (request) => {
    if (request.worldVersion !== ENGINE_BASE_WORLD.worldVersion) return null;
    return byKey.get(request.goalKey) ?? null;
  };
}

export const resolveBaseGoalDefinition = createBaseGoalDefinitionResolver();

// ---------------------------------------------------------------------------
// Base instantiation plan：base 内置内容经同一 genesis 物化契约
// ---------------------------------------------------------------------------

export type BaseContentErrorCode =
  | "BASE_CONTENT_INVALID"
  | "BASE_CONTENT_IDENTITY"
  | "BASE_GOAL_UNKNOWN";

export class BaseContentError extends Error {
  readonly code: BaseContentErrorCode;

  constructor(code: BaseContentErrorCode, message: string) {
    super(message);
    this.name = "BaseContentError";
    this.code = code;
  }
}

export interface BaseInstantiationCharacterPlan {
  displayName: string;
  role: string;
  summary: string;
}

/**
 * Base mode 的 genesis 物化计划——`RealmWorldRuntimeInstantiationPlan` 的
 * base 对应物（引擎升级计划 §2.2/§6）：同一内容解析层契约，binding 恒为
 * `{ kind: "base" }`，绝不携带 worldId/worldVersion 身份。与 world-bound
 * 计划的差异仅在于：base 角色没有包级 characterKey/profile，opening 由
 * base 内容直接携带（world-bound 的 opening 恒为空串）。
 *
 * 本计划纯内存、 persistence-neutral：不要求 install root / trust-store，
 * 不执行任何安装或网络操作；落库版本恒为 LOCAL_WORLD_VERSION 哨兵。
 */
export interface BaseInstantiationPlan {
  binding: { kind: "base" };
  world: {
    name: string;
    era: string;
    summary: string;
    settings: Readonly<Record<string, JsonValue>>;
  };
  story: { title: string; premise: string };
  record: { title: string };
  scene: {
    title?: string;
    location: string;
    objective: string;
    tension: string;
    weather: string;
    displayTime?: string;
  };
  playerRole: string;
  playerStance: "player" | "observer";
  characters: readonly BaseInstantiationCharacterPlan[];
  /** 已解析的 engine-owned Goal 定义（声明的 goalKey 全量解析，fail-closed）。 */
  goals: readonly GoalDefinition[];
  opening: string;
}

/**
 * Base genesis 参数（三条 genesis 通道降格为参数生成器后的统一输入形态）。
 * 只允许内容字段；任何身份/安装字段（binding/worldIdentity/runtimeIdentity/
 * worldId/worldVersion）都 fail-closed——base 绝不能伪装成 RealmWorld
 * package，也不继承既有 Record 的运行身份。
 */
export interface BaseGenesisParameters {
  world: { name: string; era?: string; summary?: string };
  /** 初始运行内容语言（如 zh-CN/en/ja）；缺省由账号语言补齐。 */
  language?: string;
  /** 世界文风 key；缺省/未知由草稿规整到 modern。 */
  style?: string;
  story: { title: string; premise?: string };
  record: { title: string };
  playerRole?: string;
  playerStance?: "player" | "observer";
  characters?: readonly { displayName: string; role?: string; summary?: string }[];
  scene?: {
    title?: string;
    location?: string;
    weather?: string;
    tension?: string;
    displayTime?: string;
    objective?: string;
  };
  opening?: string;
  /** 要随 genesis 物化的 engine-owned Goal keys；未知 key fail-closed。 */
  goals?: readonly string[];
}

const BASE_PARAMETER_KEYS = [
  "world",
  "language",
  "style",
  "story",
  "record",
  "playerRole",
  "playerStance",
  "characters",
  "scene",
  "opening",
  "goals",
] as const;

/** 身份/安装字段一旦出现即拒绝——绝不静默丢弃身份降级为 base。 */
const FORBIDDEN_IDENTITY_KEYS = [
  "binding",
  "worldIdentity",
  "runtimeIdentity",
  "worldId",
  "worldVersion",
] as const;

/** 嵌套内容对象的合法键集合——嵌套未知键/身份键同样 fail-closed。 */
const BASE_WORLD_KEYS = ["name", "era", "summary"] as const;
const BASE_STORY_KEYS = ["title", "premise"] as const;
const BASE_RECORD_KEYS = ["title"] as const;
const BASE_SCENE_KEYS = [
  "title",
  "location",
  "weather",
  "tension",
  "displayTime",
  "objective",
] as const;
const BASE_CHARACTER_KEYS = ["displayName", "role", "summary"] as const;

const MAX_BASE_CHARACTERS = 64;
const MAX_BASE_TEXT = 512;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验对象只携带声明的键：身份/安装字段一律 BASE_CONTENT_IDENTITY（绝不
 * 静默丢弃身份），其余未知键 BASE_CONTENT_INVALID（不静默降级语义）。
 */
function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if ((FORBIDDEN_IDENTITY_KEYS as readonly string[]).includes(key)) {
      throw new BaseContentError(
        "BASE_CONTENT_IDENTITY",
        `base genesis ${where} must not carry identity key ${key}`,
      );
    }
    if (!allowed.includes(key)) {
      throw new BaseContentError(
        "BASE_CONTENT_INVALID",
        `unknown base genesis ${where} key ${key}`,
      );
    }
  }
}

function optionalText(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > MAX_BASE_TEXT) {
    throw new BaseContentError("BASE_CONTENT_INVALID", `base content ${where} is invalid`);
  }
  return value;
}

function requiredText(value: unknown, where: string): string {
  const result = optionalText(value, where);
  if (result === undefined || result.trim().length === 0) {
    throw new BaseContentError("BASE_CONTENT_INVALID", `base content ${where} is required`);
  }
  return result;
}

/**
 * 从 base genesis 参数构建 base instantiation plan（persistence-neutral
 * 内容解析层入口）。校验 fail-closed：
 * - 未知参数键与任何身份/安装字段一律拒绝（base 不伪装 RealmWorld）；
 * - 声明的 Goal keys 全部经 engine-owned 定义解析，未知/重复 key 拒绝；
 * - binding 恒钉为 `{ kind: "base" }`，world_version 只能由物化层落
 *   LOCAL_WORLD_VERSION 哨兵。
 */
export function createBaseInstantiationPlan(
  parameters: BaseGenesisParameters,
  options: {
    resolveGoalDefinition?: (request: BaseGoalDefinitionRequest) => GoalDefinition | null;
  } = {},
): BaseInstantiationPlan {
  if (!isPlainRecord(parameters)) {
    throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis parameters must be an object");
  }
  assertKnownKeys(parameters, BASE_PARAMETER_KEYS, "parameters");
  const world = isPlainRecord(parameters.world) ? parameters.world : null;
  if (!world) {
    throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis world is required");
  }
  assertKnownKeys(world, BASE_WORLD_KEYS, "world");
  const story = isPlainRecord(parameters.story) ? parameters.story : null;
  if (!story) {
    throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis story is required");
  }
  assertKnownKeys(story, BASE_STORY_KEYS, "story");
  const record = isPlainRecord(parameters.record) ? parameters.record : null;
  if (!record) {
    throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis record is required");
  }
  assertKnownKeys(record, BASE_RECORD_KEYS, "record");
  const name = requiredText(world.name, "world.name");
  const era = optionalText(world.era, "world.era") ?? "";
  const summary = optionalText(world.summary, "world.summary") ?? "";
  const language = optionalText(parameters.language, "language");
  const style = optionalText(parameters.style, "style");
  const scene = parameters.scene === undefined ? {} : parameters.scene;
  if (!isPlainRecord(scene)) {
    throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis scene is invalid");
  }
  assertKnownKeys(scene, BASE_SCENE_KEYS, "scene");
  const sceneTitle = optionalText(scene.title, "scene.title");
  const sceneDisplayTime = optionalText(scene.displayTime, "scene.displayTime");
  const sceneWeather = optionalText(scene.weather, "scene.weather") ?? "";
  const sceneTension = optionalText(scene.tension, "scene.tension") ?? "";
  const playerStance = parameters.playerStance ?? "player";
  if (playerStance !== "player" && playerStance !== "observer") {
    throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis playerStance is invalid");
  }
  const charactersValue = parameters.characters ?? [];
  if (!Array.isArray(charactersValue) || charactersValue.length > MAX_BASE_CHARACTERS) {
    throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis characters are invalid");
  }
  const characters = charactersValue.map((raw, index) => {
    if (!isPlainRecord(raw)) {
      throw new BaseContentError("BASE_CONTENT_INVALID", `base character ${index} is invalid`);
    }
    assertKnownKeys(raw, BASE_CHARACTER_KEYS, `characters[${index}]`);
    return {
      displayName: requiredText(raw.displayName, `characters[${index}].displayName`),
      role: optionalText(raw.role, `characters[${index}].role`) ?? "",
      summary: optionalText(raw.summary, `characters[${index}].summary`) ?? "",
    };
  });
  const resolveGoal = options.resolveGoalDefinition ?? resolveBaseGoalDefinition;
  const goalKeys = parameters.goals ?? [];
  if (!Array.isArray(goalKeys)) {
    throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis goals are invalid");
  }
  const seenGoalKeys = new Set<string>();
  const goals = goalKeys.map((rawKey) => {
    if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
      throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis goal keys must be non-empty strings");
    }
    if (seenGoalKeys.has(rawKey)) {
      throw new BaseContentError("BASE_CONTENT_INVALID", "base genesis goal keys must be unique");
    }
    seenGoalKeys.add(rawKey);
    // base binding 下 worldId 不参与绑定（§6）；哨兵版本是唯一合法通道。
    const definition = resolveGoal({
      worldId: ENGINE_BASE_WORLD.worldId,
      worldVersion: ENGINE_BASE_WORLD.worldVersion,
      goalKey: rawKey,
    });
    if (!definition) {
      throw new BaseContentError("BASE_GOAL_UNKNOWN", `unknown engine-owned base Goal key ${rawKey}`);
    }
    return definition;
  });
  const settings: Record<string, JsonValue> = {
    era,
    summary,
    weather: sceneWeather,
    tension: sceneTension,
    ...(language ? { language } : {}),
    ...(style ? { style } : {}),
    ...(sceneDisplayTime ? { displayTime: sceneDisplayTime } : {}),
  };
  return {
    binding: { kind: "base" },
    world: { name, era, summary, settings },
    story: {
      title: requiredText(story.title, "story.title"),
      premise: optionalText(story.premise, "story.premise") ?? "",
    },
    record: { title: requiredText(record.title, "record.title") },
    scene: {
      ...(sceneTitle !== undefined ? { title: sceneTitle } : {}),
      location: optionalText(scene.location, "scene.location") ?? "",
      objective: optionalText(scene.objective, "scene.objective") ?? "",
      tension: sceneTension,
      weather: sceneWeather,
      ...(sceneDisplayTime !== undefined ? { displayTime: sceneDisplayTime } : {}),
    },
    playerRole: optionalText(parameters.playerRole, "playerRole") ?? "",
    playerStance,
    characters,
    goals,
    opening: optionalText(parameters.opening, "opening") ?? "",
  };
}
