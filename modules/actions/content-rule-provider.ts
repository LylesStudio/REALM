/**
 * ContentResolver 装配的规则定义 provider（Slice 2.5）。
 *
 * 运行时定义读取按 Record 的 WorldBinding 经内容解析层（§2.2）分流：
 * base binding → BaseContentResolver；world-bound binding → 已挂载签名
 * RealmWorld 包的 RealmWorldContentResolver。本模块把 ContentResolver 的
 * 同步解析结果映射为 RuleDefinitionProvider 的三类定义记录。
 *
 * 组合语义（fail-closed）：
 * - fallback（DB 物化定义，含账本 definitionId 与抽牌账本）优先于内容层
 *   ——已物化/已授权能力的账本身份绝不被内容层覆盖，回执 definitionId
 *   与资产/抽牌账本保持一致；
 * - 内容层只补充 fallback 未物化的定义（world-bound 包内容、preset 附加
 *   内容）；两者都 miss → null（规则包按既有契约 fail-closed）；
 * - resolver 请求非法/身份不符（ContentResolutionError）不吞掉——直接
 *   抛出，绝不静默降级到错误内容包；resolver 不可用（null）只意味着
 *   内容层无贡献，fallback 照常工作。
 *
 * client-safe 纯模块：不 import node:* / pg / DB 模块。
 */
import {
  normalizeContentLanguage,
  type ContentResolver,
  type ResolvedActionDefinition,
} from "../content-resolution/public.ts";
import {
  LOCAL_WORLD_VERSION,
  type WorldBinding,
} from "../world-transfer/realm-save.ts";
import type {
  AssetDefinitionRecord,
  EffectDefinitionRecord,
  RuleDefinitionProvider,
  SkillDefinitionRecord,
} from "./rule-pack.ts";

export interface ContentRuleDefinitionProviderOptions {
  /**
   * 按 binding 选定的 ContentResolver。允许异步工厂（world-bound 需先
   * 挂载/验签包）；返回 null 表示内容层不可用（定义解析仅靠 fallback）。
   */
  resolver:
    | ContentResolver
    | null
    | (() => Promise<ContentResolver | null>);
  /** Record 的 WorldBinding（精确形态；请求身份与之严格一致）。 */
  binding: WorldBinding;
  /**
   * world-bound 身份；base binding 下必须为 ""/LOCAL_WORLD_VERSION 哨兵
   * （缺省即按 base 处理）。
   */
  worldId?: string;
  worldVersion?: string;
  /** 世界语言（worlds.settings.language；非法值回落 zh-CN）。 */
  language?: string;
  /** base bundle 键 / 包内内容键；缺省 = 各 resolver 的主内容。 */
  contentKey?: string;
  /** 当前 Record 场景地点，用于渲染 `{location}` 发现模板。 */
  location?: string;
  /** 次级来源（DB 物化定义）；冲突时优先，见模块头组合语义。 */
  fallback?: RuleDefinitionProvider;
}

/** 内容层定义的合成身份：仅用于未物化定义，绝不与 DB 定义 id 混用。 */
function contentDefinitionId(definition: ResolvedActionDefinition): string {
  return `content:${definition.actionKind}:${definition.actionKey}`;
}

function toSkillRecord(
  definition: ResolvedActionDefinition,
): SkillDefinitionRecord {
  return {
    definitionId: contentDefinitionId(definition),
    skillKey: definition.actionKey,
    title: definition.title,
    description: definition.description,
    metadata: definition.metadata,
  };
}

function toAssetRecord(
  definition: ResolvedActionDefinition,
): AssetDefinitionRecord {
  return {
    definitionId: contentDefinitionId(definition),
    assetKey: definition.actionKey,
    title: definition.title,
    description: definition.description,
    consumable: definition.consumable,
    metadata: definition.metadata,
  };
}

function toStanceRecord(
  definition: ResolvedActionDefinition,
): EffectDefinitionRecord | null {
  // stance 定义必须携带 effectKind；缺失视为 miss（fail-closed），
  // 绝不编造效果种类。
  if (definition.effectKind === null) return null;
  return {
    definitionId: contentDefinitionId(definition),
    effectKey: definition.actionKey,
    title: definition.title,
    description: definition.description,
    effectKind: definition.effectKind,
    metadata: definition.metadata,
  };
}

export function createContentRuleDefinitionProvider(
  options: ContentRuleDefinitionProviderOptions,
): RuleDefinitionProvider {
  const language = normalizeContentLanguage(options.language) ?? "zh-CN";
  const binding = options.binding;
  const requestBase = {
    binding,
    worldId: binding.kind === "base" ? "" : (options.worldId ?? binding.worldId),
    worldVersion: binding.kind === "base"
      ? LOCAL_WORLD_VERSION
      : (options.worldVersion ?? binding.worldVersion),
    language,
    ...(options.contentKey !== undefined
      ? { contentKey: options.contentKey }
      : {}),
  } as const;
  let resolvedResolver: ContentResolver | null | undefined;

  async function resolverInstance(): Promise<ContentResolver | null> {
    if (resolvedResolver !== undefined) return resolvedResolver;
    const source = options.resolver;
    resolvedResolver = typeof source === "function" ? await source() : source;
    return resolvedResolver;
  }

  async function lookup(
    actionKind: "skill" | "asset" | "stance",
    actionKey: string,
  ): Promise<ResolvedActionDefinition | null> {
    const resolver = await resolverInstance();
    if (!resolver) return null;
    return resolver.resolveAction({
      ...requestBase,
      actionKind,
      actionKey,
    });
  }

  return {
    async loadSkill(skillKey) {
      // fallback（DB 物化定义）优先：已授权能力的账本 definitionId 不被
      // 内容层合成身份覆盖；内容层只补充未物化定义。
      const materialized = await options.fallback?.loadSkill(skillKey);
      if (materialized) return materialized;
      const definition = await lookup("skill", skillKey);
      return definition ? toSkillRecord(definition) : null;
    },
    async loadAsset(assetKey) {
      const materialized = await options.fallback?.loadAsset(assetKey);
      if (materialized) return materialized;
      const definition = await lookup("asset", assetKey);
      return definition ? toAssetRecord(definition) : null;
    },
    async loadStance(stanceKey) {
      const materialized = await options.fallback?.loadStance(stanceKey);
      if (materialized) return materialized;
      const definition = await lookup("stance", stanceKey);
      return definition ? toStanceRecord(definition) : null;
    },
    async loadDiscoveryContext() {
      if (options.fallback?.loadDiscoveryContext) {
        return options.fallback.loadDiscoveryContext();
      }
      return { location: options.location?.trim() ?? "" };
    },
    // 抽牌账本（批次 T5）只属于 DB 物化层；内容层无账本可查。
    ...(options.fallback?.listDrawnCards
      ? { listDrawnCards: options.fallback.listDrawnCards }
      : {}),
  };
}
