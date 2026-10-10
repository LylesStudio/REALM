import { normalizeWorldStyle } from "../style/world-style.ts";
import type {
  BaseGenesisParameters,
  BaseInstantiationPlan,
} from "../world-transfer/base-content.ts";
import { BaseContentError } from "../world-transfer/base-content.ts";
import type { RealmWorldRuntimeInstantiationPlan } from "../world-transfer/realmworld-runtime-content.ts";
import { realmWorldPlanToGenesisDraft } from "./realmworld-genesis.ts";
import {
  normalizeGenesisLanguage,
  type WorldGenesisDraft,
} from "./world-genesis-contract.ts";

/**
 * 统一 genesis 物化契约（引擎升级计划 §2.2/§6）：base 内置内容与 signed
 * RealmWorld 共用同一 draft → materializer 通道。本模块只做 plan ↔ draft
 * 的纯适配；物化（单事务落库）始终是 LibraryService.createGenesis。
 *
 * 身份边界 fail-closed：base 计划绝不携带 worldIdentity/runtimeIdentity
 * （落库 world_version 由物化层钉为 LOCAL_WORLD_VERSION 哨兵）；携带
 * RealmWorld 身份的草稿/计划绝不降级为 base。
 */

export type GenesisInstantiationPlan =
  | BaseInstantiationPlan
  | RealmWorldRuntimeInstantiationPlan;

/** 伪造 plan 上一旦出现即拒绝的身份键（binding 由精确匹配单独校验）。 */
const PLAN_IDENTITY_KEYS = [
  "worldIdentity",
  "runtimeIdentity",
  "worldId",
  "worldVersion",
] as const;

/**
 * Base plan 可执行身份边界 fail-closed：plan 本体及其嵌套内容对象绝不携带
 * RealmWorld 身份——即便 binding 合法，夹带身份的伪造 plan 也绝不静默丢弃
 * 身份降级为 base。
 */
function assertNoPlanIdentityKeys(value: unknown, where: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if ((PLAN_IDENTITY_KEYS as readonly string[]).includes(key)) {
      throw new BaseContentError(
        "BASE_CONTENT_IDENTITY",
        `base instantiation plan ${where} must not carry identity key ${key}`,
      );
    }
  }
}

/**
 * 旧入口（preset/form/chat/one-shot）的草稿 → base 内容层参数。草稿若携带
 * RealmWorld 身份（worldIdentity/runtimeIdentity）则 fail-closed——身份
 * 绝不静默丢弃降级为 base。
 */
export function baseGenesisParametersFromDraft(
  draft: WorldGenesisDraft,
): BaseGenesisParameters {
  if (draft.worldIdentity || draft.runtimeIdentity) {
    throw new BaseContentError(
      "BASE_CONTENT_IDENTITY",
      "a draft carrying RealmWorld identity must not enter the base content layer",
    );
  }
  return {
    world: {
      name: draft.world.name,
      era: draft.world.era,
      summary: draft.world.summary,
    },
    ...(draft.language ? { language: draft.language } : {}),
    style: draft.style,
    story: { title: draft.story.title, premise: draft.story.premise },
    record: { title: draft.record.title },
    playerRole: draft.playerRole,
    playerStance: draft.playerStance,
    characters: draft.companions.map((companion) => ({
      displayName: companion.name,
      role: companion.role,
      summary: companion.summary,
    })),
    scene: {
      ...(draft.scene.title !== undefined ? { title: draft.scene.title } : {}),
      location: draft.scene.location,
      weather: draft.scene.weather,
      tension: draft.scene.tension,
      ...(draft.scene.displayTime !== undefined
        ? { displayTime: draft.scene.displayTime }
        : {}),
      objective: draft.scene.objective,
    },
    opening: draft.opening,
    // base 的 Goal 声明以内容层定义为准：只带 goalKey，policyVersion 由
    // engine-owned 定义解析（未知 key 由 provider fail-closed）。
    ...(draft.goals && draft.goals.length > 0
      ? { goals: draft.goals.map((goal) => goal.goalKey) }
      : {}),
  };
}

/**
 * Base instantiation plan → 既有事务化 genesis 草稿。不携带
 * worldIdentity/runtimeIdentity：世界 ID 由物化层随机派生，落库
 * world_version 恒为 LOCAL_WORLD_VERSION 哨兵。
 */
export function baseInstantiationPlanToGenesisDraft(
  plan: BaseInstantiationPlan,
): WorldGenesisDraft {
  const binding = plan?.binding as Record<string, unknown> | undefined;
  if (
    !binding
    || binding.kind !== "base"
    || Object.keys(binding).length !== 1
  ) {
    throw new BaseContentError(
      "BASE_CONTENT_IDENTITY",
      "base instantiation requires an exact { kind: \"base\" } WorldBinding",
    );
  }
  assertNoPlanIdentityKeys(plan, "plan");
  assertNoPlanIdentityKeys(plan.world, "plan.world");
  assertNoPlanIdentityKeys(plan.story, "plan.story");
  assertNoPlanIdentityKeys(plan.record, "plan.record");
  assertNoPlanIdentityKeys(plan.scene, "plan.scene");
  (plan.characters ?? []).forEach((character, index) => {
    assertNoPlanIdentityKeys(character, `plan.characters[${index}]`);
  });
  const language = normalizeGenesisLanguage(plan.world.settings.language);
  return {
    // base 计划绝不携带身份键——物化层钉 LOCAL_WORLD_VERSION 哨兵。
    ...(language ? { language } : {}),
    // 与 world-bound 相同的物化形态：仅 goalKey/policyVersion 进入草稿，
    // 定义/rubric 留在 base 内容层（engine-owned）。
    ...(plan.goals.length > 0
      ? {
        goals: plan.goals.map((goal) => ({
          goalKey: goal.goalKey,
          policyVersion: goal.policyVersion,
        })),
      }
      : {}),
    world: {
      name: plan.world.name,
      era: plan.world.era,
      summary: plan.world.summary,
    },
    style: normalizeWorldStyle(plan.world.settings.style),
    story: { title: plan.story.title, premise: plan.story.premise },
    record: { title: plan.record.title },
    playerRole: plan.playerRole,
    playerStance: plan.playerStance,
    opening: plan.opening,
    companions: plan.characters.map((character) => ({
      name: character.displayName,
      role: character.role,
      summary: character.summary,
    })),
    scene: {
      ...(plan.scene.title !== undefined ? { title: plan.scene.title } : {}),
      location: plan.scene.location,
      weather: plan.scene.weather,
      tension: plan.scene.tension,
      ...(plan.scene.displayTime !== undefined
        ? { displayTime: plan.scene.displayTime }
        : {}),
      objective: plan.scene.objective,
    },
  };
}

/**
 * 统一 plan → draft 适配入口：按 binding 分发，base 与 world-bound 走同一
 * 物化契约。world-bound 计划必须携带确定性 runtimeIdentity（幂等重放）；
 * 非法/缺失身份 fail-closed，绝不回退 base。
 */
export function instantiationPlanToGenesisDraft(
  plan: GenesisInstantiationPlan,
  runtimeIdentity?: { worldlineId: string; storyId: string; recordId: string },
): WorldGenesisDraft {
  if (plan.binding.kind === "base") {
    return baseInstantiationPlanToGenesisDraft(plan as BaseInstantiationPlan);
  }
  if (!runtimeIdentity) {
    throw new Error("RealmWorld instantiation requires a stable runtime identity.");
  }
  return realmWorldPlanToGenesisDraft(
    plan as RealmWorldRuntimeInstantiationPlan,
    runtimeIdentity,
  );
}
