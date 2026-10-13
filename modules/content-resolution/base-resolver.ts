/**
 * BaseContentResolver · engine-owned base 内容的 ContentResolver 实现。
 *
 * base 内置内容经统一内容解析层读取（引擎升级计划 §2.2/§6 的 dogfood）：
 * 世界/角色/Action/Story/Scene/Goal/i18n 全部来自
 * ./base-content-data.ts 的 engine-owned bundle，纯内存、client-safe、
 * 无 install root / trust-store / 网络 / DB。
 *
 * fail-closed 语义（contract 见 ./public.ts）：
 * - 只接受精确 base 请求身份（worldId "" + LOCAL_WORLD_VERSION 哨兵）；
 *   world-bound binding 或任何身份夹带一律 CONTENT_IDENTITY_REJECTED；
 * - 未知 contentKey/characterKey/actionKey/goalKey 返回 null（显式 miss，
 *   绝不回退其他 bundle 或默认文案）；
 * - 返回值深冻结，调用方无法 mutate 共享内容。
 */
import {
  resolveBaseGoalDefinition,
} from "../world-transfer/base-content.ts";
import { ENGINE_BASE_WORLD } from "../world-transfer/engine-base.ts";
import {
  BASE_DEMO_CONTENT_KEY,
  BASE_WORLD_BUNDLES,
  type BaseWorldBundle,
} from "./base-content-data.ts";
import {
  ContentResolutionError,
  normalizeContentRequest,
  normalizeGenesisContentRequest,
  type ActionContentRequest,
  type ActionListRequest,
  type CharacterContentRequest,
  type ContentLanguage,
  type ContentRequestBase,
  type ContentResolver,
  type GenesisContentRequest,
  type GoalContentRequest,
  type MessagesContentRequest,
  type ResolvedActionDefinition,
  type ResolvedCharacterDefinition,
  type ResolvedGenesisContent,
  type ResolvedSceneContent,
  type ResolvedStoryContent,
  type ResolvedWorldContent,
  type SceneContentRequest,
  type StoryContentRequest,
  type WorldContentRequest,
} from "./public.ts";
import type { GoalDefinition } from "../goals/public.ts";
import type { JsonValue } from "../runtime/public.ts";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** 空串可选字段（preset 无 displayTime/scene.title）在 genesis 内容中省略。 */
function nonEmpty(text: string): string | undefined {
  return text.trim().length > 0 ? text : undefined;
}

function bundleFor(contentKey: string | undefined): BaseWorldBundle | null {
  return BASE_WORLD_BUNDLES[contentKey ?? BASE_DEMO_CONTENT_KEY] ?? null;
}

function resolveWorldContent(
  bundle: BaseWorldBundle,
  language: ContentLanguage,
): ResolvedWorldContent {
  const settings: Record<string, JsonValue> = {
    era: bundle.world.era[language],
    style: bundle.style,
    weather: bundle.world.weather[language],
    tension: bundle.world.tension[language],
    ...(nonEmpty(bundle.world.displayTime[language])
      ? { displayTime: bundle.world.displayTime[language] }
      : {}),
  };
  return deepFreeze({
    contentKey: bundle.contentKey,
    name: bundle.world.name[language],
    era: bundle.world.era[language],
    summary: bundle.world.summary[language],
    calendarId: bundle.calendarId,
    style: bundle.style,
    weather: bundle.world.weather[language],
    tension: bundle.world.tension[language],
    displayTime: bundle.world.displayTime[language],
    worldlineLabel: bundle.worldlineLabel[language],
    settings,
  });
}

function resolveCharacterContent(
  bundle: BaseWorldBundle,
  characterKey: string,
  language: ContentLanguage,
): ResolvedCharacterDefinition | null {
  const character = bundle.characters.find((item) => item.characterKey === characterKey);
  if (!character) return null;
  return deepFreeze({
    characterKey: character.characterKey,
    displayName: character.displayName[language],
    role: character.role[language],
    summary: character.summary[language],
    isPlayer: character.isPlayer,
  });
}

function resolveActionContent(
  bundle: BaseWorldBundle,
  actionKey: string,
  language: ContentLanguage,
): ResolvedActionDefinition | null {
  const action = bundle.actions.find((item) => item.actionKey === actionKey);
  if (!action) return null;
  return deepFreeze({
    actionKind: action.actionKind,
    actionKey: action.actionKey,
    title: action.title[language],
    description: action.description[language],
    rulePackKey: action.rulePackKey,
    consumable: action.consumable,
    effectKind: action.effectKind,
    metadata: structuredClone(action.metadata),
  });
}

function resolveStoryContent(
  bundle: BaseWorldBundle,
  language: ContentLanguage,
): ResolvedStoryContent {
  return deepFreeze({
    storyKey: bundle.story.storyKey,
    title: bundle.story.title[language],
    premise: bundle.story.premise[language],
    recordTitle: bundle.record.title[language],
    opening: {
      speaker: bundle.opening.speaker[language],
      content: bundle.opening.content[language],
      segments: bundle.opening.segments.map((segment) => ({
        id: segment.id,
        kind: segment.kind,
        content: segment.content[language],
        speechMode: segment.speechMode,
      })),
    },
  });
}

function resolveSceneContent(
  bundle: BaseWorldBundle,
  language: ContentLanguage,
): ResolvedSceneContent {
  return deepFreeze({
    sceneKey: bundle.scene.sceneKey,
    title: bundle.scene.title[language],
    location: bundle.scene.location[language],
    weather: bundle.world.weather[language],
    tension: bundle.world.tension[language],
    displayTime: bundle.world.displayTime[language],
    objective: bundle.scene.objective[language],
  });
}

function resolveMessageBundle(
  bundle: BaseWorldBundle,
  language: ContentLanguage,
): Readonly<Record<string, string>> {
  const messages: Record<string, string> = {
    "world.name": bundle.world.name[language],
    "world.era": bundle.world.era[language],
    "world.summary": bundle.world.summary[language],
    "world.weather": bundle.world.weather[language],
    "world.tension": bundle.world.tension[language],
    "world.displayTime": bundle.world.displayTime[language],
    "worldline.origin.label": bundle.worldlineLabel[language],
    "story.title": bundle.story.title[language],
    "story.premise": bundle.story.premise[language],
    "record.title": bundle.record.title[language],
    "scene.title": bundle.scene.title[language],
    "scene.location": bundle.scene.location[language],
    "scene.objective": bundle.scene.objective[language],
    "playerRole": bundle.playerRole[language],
    "opening.speaker": bundle.opening.speaker[language],
    "opening.content": bundle.opening.content[language],
  };
  for (const character of bundle.characters) {
    messages[`character.${character.characterKey}.name`] = character.displayName[language];
    messages[`character.${character.characterKey}.role`] = character.role[language];
    messages[`character.${character.characterKey}.summary`] = character.summary[language];
  }
  for (const segment of bundle.opening.segments) {
    messages[`opening.segment.${segment.id}`] = segment.content[language];
  }
  for (const action of bundle.actions) {
    messages[`action.${action.actionKey}.title`] = action.title[language];
    messages[`action.${action.actionKey}.description`] = action.description[language];
  }
  return deepFreeze(messages);
}

function resolveGenesis(
  bundle: BaseWorldBundle,
  language: ContentLanguage,
  resolveGoal: (goalKey: string) => GoalDefinition | null,
): ResolvedGenesisContent {
  const goals = bundle.goalKeys.map((goalKey) => {
    const definition = resolveGoal(goalKey);
    if (!definition) {
      throw new ContentResolutionError(
        "CONTENT_REQUEST_INVALID",
        `base bundle ${bundle.contentKey} declares unknown Goal key ${goalKey}`,
      );
    }
    return definition;
  });
  return deepFreeze({
    contentKey: bundle.contentKey,
    world: {
      name: bundle.world.name[language],
      era: bundle.world.era[language],
      summary: bundle.world.summary[language],
      style: bundle.style,
      settings: resolveWorldContent(bundle, language).settings,
    },
    story: {
      title: bundle.story.title[language],
      premise: bundle.story.premise[language],
    },
    record: { title: bundle.record.title[language] },
    scene: {
      ...(nonEmpty(bundle.scene.title[language])
        ? { title: bundle.scene.title[language] }
        : {}),
      location: bundle.scene.location[language],
      weather: bundle.world.weather[language],
      tension: bundle.world.tension[language],
      ...(nonEmpty(bundle.world.displayTime[language])
        ? { displayTime: bundle.world.displayTime[language] }
        : {}),
      objective: bundle.scene.objective[language],
    },
    playerRole: bundle.playerRole[language],
    playerStance: bundle.playerStance,
    characters: bundle.characters
      .filter((character) => !character.isPlayer)
      .map((character) => ({
        characterKey: character.characterKey,
        displayName: character.displayName[language],
        role: character.role[language],
        summary: character.summary[language],
      })),
    goals,
    opening: bundle.opening.content[language],
  });
}

/**
 * 创建 BaseContentResolver。只接受 base 身份；world-bound binding 一律
 * CONTENT_IDENTITY_REJECTED（RealmWorld resolver 是后续 slice 的职责，
 * base 绝不代解/降级）。
 */
export function createBaseContentResolver(): ContentResolver {
  /** 公共身份校验 + base-only 边界；返回规范化 contentKey/language。 */
  function baseScope(request: ContentRequestBase, extraKeys: readonly string[] = []) {
    const scope = normalizeContentRequest(request, extraKeys);
    if (scope.binding.kind !== "base") {
      throw new ContentResolutionError(
        "CONTENT_IDENTITY_REJECTED",
        "the base content resolver only serves exact base bindings",
      );
    }
    return scope;
  }

  return {
    resolveWorld(request: WorldContentRequest) {
      const scope = baseScope(request);
      const bundle = bundleFor(scope.contentKey);
      return bundle ? resolveWorldContent(bundle, scope.language) : null;
    },

    resolveCharacter(request: CharacterContentRequest) {
      const scope = baseScope(request, ["characterKey"]);
      if (typeof request.characterKey !== "string" || request.characterKey.trim().length === 0) {
        throw new ContentResolutionError(
          "CONTENT_REQUEST_INVALID",
          "character content request characterKey must be a non-empty string",
        );
      }
      const bundle = bundleFor(scope.contentKey);
      return bundle ? resolveCharacterContent(bundle, request.characterKey, scope.language) : null;
    },

    listCharacters(request: ContentRequestBase) {
      const scope = baseScope(request);
      const bundle = bundleFor(scope.contentKey);
      if (!bundle) return Object.freeze([]);
      return deepFreeze(
        bundle.characters.map((character) =>
          resolveCharacterContent(bundle, character.characterKey, scope.language)!),
      );
    },

    resolveAction(request: ActionContentRequest) {
      const scope = baseScope(request, ["actionKind", "actionKey"]);
      if (typeof request.actionKey !== "string" || request.actionKey.trim().length === 0) {
        throw new ContentResolutionError(
          "CONTENT_REQUEST_INVALID",
          "action content request actionKey must be a non-empty string",
        );
      }
      const bundle = bundleFor(scope.contentKey);
      const resolved = bundle
        ? resolveActionContent(bundle, request.actionKey, scope.language)
        : null;
      // actionKind 不符视为 miss（绝不跨类返回同 key 内容）。
      return resolved && resolved.actionKind === request.actionKind ? resolved : null;
    },

    listActions(request: ActionListRequest) {
      const scope = baseScope(request, ["actionKind"]);
      const bundle = bundleFor(scope.contentKey);
      if (!bundle) return Object.freeze([]);
      return deepFreeze(
        bundle.actions
          .filter((action) =>
            request.actionKind === undefined || action.actionKind === request.actionKind)
          .map((action) => resolveActionContent(bundle, action.actionKey, scope.language)!),
      );
    },

    resolveStory(request: StoryContentRequest) {
      const scope = baseScope(request, ["storyKey"]);
      const bundle = bundleFor(scope.contentKey);
      if (!bundle) return null;
      // storyKey 缺省 = bundle 主故事；显式不符 = miss。
      if (request.storyKey !== undefined && request.storyKey !== bundle.story.storyKey) {
        return null;
      }
      return resolveStoryContent(bundle, scope.language);
    },

    resolveScene(request: SceneContentRequest) {
      const scope = baseScope(request, ["sceneKey"]);
      const bundle = bundleFor(scope.contentKey);
      if (!bundle) return null;
      if (request.sceneKey !== undefined && request.sceneKey !== bundle.scene.sceneKey) {
        return null;
      }
      return resolveSceneContent(bundle, scope.language);
    },

    resolveGoal(request: GoalContentRequest) {
      baseScope(request, ["goalKey"]);
      if (typeof request.goalKey !== "string" || request.goalKey.trim().length === 0) {
        throw new ContentResolutionError(
          "CONTENT_REQUEST_INVALID",
          "goal content request goalKey must be a non-empty string",
        );
      }
      // Goal 定义是 engine-owned 全局 base 内容（与 bundle 无关）。
      const definition = resolveBaseGoalDefinition({
        worldId: ENGINE_BASE_WORLD.worldId,
        worldVersion: ENGINE_BASE_WORLD.worldVersion,
        goalKey: request.goalKey,
      });
      return definition ? deepFreeze(structuredClone(definition)) : null;
    },

    resolveMessages(request: MessagesContentRequest) {
      const scope = baseScope(request);
      const bundle = bundleFor(scope.contentKey);
      return bundle ? resolveMessageBundle(bundle, scope.language) : null;
    },

    resolveGenesisContent(request: GenesisContentRequest) {
      const scope = normalizeGenesisContentRequest(request);
      if (scope.binding.kind !== "base") {
        throw new ContentResolutionError(
          "CONTENT_IDENTITY_REJECTED",
          "the base content resolver only serves exact base bindings",
        );
      }
      const bundle = bundleFor(scope.contentKey);
      if (!bundle) return null;
      return resolveGenesis(bundle, scope.language, (goalKey) =>
        resolveBaseGoalDefinition({
          worldId: ENGINE_BASE_WORLD.worldId,
          worldVersion: ENGINE_BASE_WORLD.worldVersion,
          goalKey,
        }));
    },
  };
}

/** 共享 engine-owned base resolver（纯内存、无状态，可安全共享）。 */
export const BASE_CONTENT_RESOLVER: ContentResolver = createBaseContentResolver();
