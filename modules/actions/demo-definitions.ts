import type { RuleDefinitionProvider } from "./rule-pack.ts";

/**
 * 批次 T4：演示世界三类规则定义的唯一事实来源。
 * demo-seed（PostgreSQL 种子）与本地内存规则包共用这份数据——
 * 定义即数据，规则引擎不持有任何硬编码桥段。
 *
 * metadata 契约见 docs/development/T4-RULE-REALIZATION.md §2.2：
 * facts 模板以 {actor} 占位，裁决时替换为行动者 displayName。
 */

export const DEMO_SKILL_DEFINITION = {
  definitionId: "skill_careful_observation",
  skillKey: "careful_observation",
  title: "细致观察",
  description: "在不破坏目标的前提下辨认细微痕迹。",
  rulePackKey: "realm.light.v1",
  metadata: {
    check: { system: "d20", modifier: 2, target: 12 },
    defaultTargetId: "letter_seal",
    outcomes: {
      success: "{actor}从雾气与潮痕之间辨认出了一处可靠的方向变化。",
      partial: "{actor}只辨认出一处尚不能确认的模糊痕迹。",
      failure: "雾气和潮水抹去了足够可靠的痕迹。",
      impossible: "当前环境不允许继续辨认痕迹。",
    },
    targets: {
      letter_seal: {
        success: "{actor}确认密函蜡封边缘存在一处被重新压合的细痕。",
        partial: "{actor}发现蜡封边缘有一处可疑细痕，但暂时无法确认成因。",
        failure: "蜡封表面的磨损不足以支持可靠判断。",
        impossible: "当前光线与环境不允许继续辨认蜡封细节。",
      },
    },
  },
} as const;

export const DEMO_ASSET_DEFINITION = {
  definitionId: "asset_signal_lantern",
  assetKey: "signal_lantern",
  title: "雾港信号灯",
  description: "点亮一次短促的定向灯光，照出近处轮廓。",
  rulePackKey: "realm.light.v1",
  consumable: true,
  metadata: {
    outcomes: {
      success: "{actor}点亮雾港信号灯，短促的定向光束切开了近处雾幕。",
      partial: "信号灯只照出一小片模糊轮廓。",
      failure: "信号灯没有形成可用照明。",
      impossible: "当前无法安全点亮信号灯。",
    },
    privateObservation: "灯光只照亮近处，没有穿透更远的浓雾。",
  },
} as const;

export const DEMO_STANCE_DEFINITION = {
  definitionId: "effect_guarded_watch",
  effectKey: "guarded_watch",
  title: "警戒姿态",
  description: "收束动作并持续留意周围变化。",
  rulePackKey: "realm.light.v1",
  effectKind: "stance",
  metadata: {
    outcomes: {
      success: "{actor}收束动作，进入持续留意周围变化的警戒姿态。",
      partial: "{actor}只能勉强维持警戒。",
      failure: "{actor}没能建立稳定警戒。",
      impossible: "当前无法进入警戒姿态。",
    },
  },
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
