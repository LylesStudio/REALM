import type { RuleDefinitionProvider } from "./rule-pack.ts";
import { BASE_WORLD_BUNDLES } from "../content-resolution/base-content-data.ts";

/**
 * 批次 T4：演示世界三类规则定义的装配层视图。
 *
 * 内容唯一事实来源已迁入内容解析层
 * （modules/content-resolution/base-content-data.ts 的 "ember-coast"
 * bundle；zh-CN 为规范语言）；本模块只补充 DB 运行身份（definitionId）
 * 并导出既有形状——demo-seed（PostgreSQL 种子）与本地内存规则包共用，
 * 定义即数据，规则引擎不持有任何硬编码桥段。
 *
 * metadata 契约见 docs/development/T4-RULE-REALIZATION.md §2.2：
 * facts 模板以 {actor} 占位，裁决时替换为行动者 displayName。
 */

const DEMO_ACTIONS = BASE_WORLD_BUNDLES["ember-coast"]!.actions;

function demoAction(actionKey: string) {
  const action = DEMO_ACTIONS.find((item) => item.actionKey === actionKey);
  if (!action) throw new Error(`demo action ${actionKey} missing from base content`);
  return action;
}

const SKILL = demoAction("careful_observation");
const ASSET = demoAction("signal_lantern");
const STANCE = demoAction("guarded_watch");
if (STANCE.effectKind === null) {
  throw new Error("demo stance action must carry an effectKind");
}
const STANCE_EFFECT_KIND: string = STANCE.effectKind;

export const DEMO_SKILL_DEFINITION = {
  definitionId: "skill_careful_observation",
  skillKey: SKILL.actionKey,
  title: SKILL.title["zh-CN"],
  description: SKILL.description["zh-CN"],
  rulePackKey: SKILL.rulePackKey,
  metadata: SKILL.metadata,
} as const;

export const DEMO_ASSET_DEFINITION = {
  definitionId: "asset_signal_lantern",
  assetKey: ASSET.actionKey,
  title: ASSET.title["zh-CN"],
  description: ASSET.description["zh-CN"],
  rulePackKey: ASSET.rulePackKey,
  consumable: ASSET.consumable,
  metadata: ASSET.metadata,
} as const;

export const DEMO_STANCE_DEFINITION = {
  definitionId: "effect_guarded_watch",
  effectKey: STANCE.actionKey,
  title: STANCE.title["zh-CN"],
  description: STANCE.description["zh-CN"],
  rulePackKey: STANCE.rulePackKey,
  effectKind: STANCE_EFFECT_KIND,
  metadata: STANCE.metadata,
} as const;

/** 本地内存规则包的演示定义 provider（纯内存测试组合用）。 */
export function createDemoRuleDefinitionProvider(): RuleDefinitionProvider {
  return {
    async loadSkill(skillKey) {
      return skillKey === DEMO_SKILL_DEFINITION.skillKey
        ? { ...DEMO_SKILL_DEFINITION, metadata: structuredClone(DEMO_SKILL_DEFINITION.metadata) }
        : null;
    },
    async loadAsset(assetKey) {
      return assetKey === DEMO_ASSET_DEFINITION.assetKey
        ? { ...DEMO_ASSET_DEFINITION, metadata: structuredClone(DEMO_ASSET_DEFINITION.metadata) }
        : null;
    },
    async loadStance(stanceKey) {
      return stanceKey === DEMO_STANCE_DEFINITION.effectKey
        ? { ...DEMO_STANCE_DEFINITION, metadata: structuredClone(DEMO_STANCE_DEFINITION.metadata) }
        : null;
    },
  };
}
