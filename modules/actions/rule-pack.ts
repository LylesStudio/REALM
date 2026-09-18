/**
 * 批次 T4：数据驱动规则包——唯一裁决逻辑。
 *
 * 规则引擎不持有任何世界内容：技能/资产/姿态的定义（含判定参数
 * metadata）全部由 RuleDefinitionProvider 从世界数据（创世与导入
 * 生成、PostgreSQL 定义表）加载。引擎只做推导与裁决：
 *
 * - use_skill：metadata.check 有效 → 检定（T4 仅 d20）；无 check → 自动成功；
 * - use_asset：consumable → 账本成本；否则自动成功；
 * - take_stance：施加姿态效果（账本状态）；
 * - 未定义的能力一律 fail-closed（SKILL/ASSET/STANCE_NOT_AVAILABLE）。
 *
 * metadata 契约与判定参数推导规则见 public documentation §2.2。
 */
import { FatalTurnError } from "../runtime/public.ts";
import type {
  ActionActor,
  ActionOutcome,
  ActionRulePack,
  CostDraft,
  DiscoveryObservationDraft,
  EffectDraft,
  RuleDecision,
  SkillDiscoveryContext,
} from "./public.ts";

/** 骰系字段预留（T5 多骰系）；T4 只实现 d20 解算。 */
export type DiceSystem = "d20" | "2d6" | "percentile" | "pool" | "draw";
export const DICE_SYSTEMS: readonly DiceSystem[] = [
  "d20",
  "2d6",
  "percentile",
  "pool",
  "draw",
];

/**
 * 批次 T5：metadata.check 推导后的判定参数契约（T5 规范 §2.2）。
 * 骰系选择完全由 system 分流；draw 的 deck 为裁决时刻的剩余牌堆
 * （规则包已扣除本记录内已物化的抽牌）。
 */
export type CheckSpecification =
  | { system: "d20"; modifier: number; target: number; partialMargin?: number }
  | { system: "2d6"; modifier: number; target: number; partialMargin?: number }
  | { system: "percentile"; modifier: number; target: number; partialMargin?: number }
  | {
      system: "pool";
      modifier: number;
      target: number;
      dice: number;
      sides: number;
      successOn: number;
      partialMargin?: number;
    }
  | {
      system: "draw";
      skillKey: string;
      deck: readonly string[];
      successCards: readonly string[];
    };

export type SkillDefinitionRecord = {
  definitionId: string;
  skillKey: string;
  title: string;
  description: string;
  metadata: Readonly<Record<string, unknown>>;
};

export type AssetDefinitionRecord = {
  definitionId: string;
  assetKey: string;
  title: string;
  description: string;
  consumable: boolean;
  metadata: Readonly<Record<string, unknown>>;
};

export type EffectDefinitionRecord = {
  definitionId: string;
  effectKey: string;
  title: string;
  description: string;
  effectKind: string;
  metadata: Readonly<Record<string, unknown>>;
};

/** 按世界加载三类规则定义；查无返回 null（由规则包 fail-closed）。 */
export interface RuleDefinitionProvider {
  loadSkill(skillKey: string): Promise<SkillDefinitionRecord | null>;
  loadAsset(assetKey: string): Promise<AssetDefinitionRecord | null>;
  loadStance(stanceKey: string): Promise<EffectDefinitionRecord | null>;
  /** 当前 Record 的少量可公开场景上下文，用于渲染结构化发现模板。 */
  loadDiscoveryContext?(): Promise<Readonly<Record<string, string>>>;
  /**
   * 批次 T5 抽牌不放回：返回本记录内该行动者该技能已物化的抽牌。
   * 可选——纯内存 provider 不实现时按完整牌堆裁决（无跨进程账本可查）。
   */
  listDrawnCards?(input: {
    skillKey: string;
    actorCharacterInstanceId: string;
  }): Promise<readonly string[]>;
}

type OutcomeKey = ActionOutcome;
const OUTCOME_KEYS: readonly OutcomeKey[] = [
  "success",
  "partial",
  "failure",
  "impossible",
];

/** 「观察四周」等自然行动的基线文案（不含任何世界特定内容）。 */
const ACT_FACTS: Record<ActionOutcome, string> = {
  success: "{actor}开始按自己的判断确认眼前的情况。",
  partial: "{actor}只能确认眼前的一部分情况。",
  failure: "{actor}暂时没有获得可靠的新信息。",
  impossible: "{actor}目前无法执行这个行动。",
};


/** 定义未提供 outcomes 时的确定性兜底句式（含能力 title，不引入随机与模型调用）。 */
const GENERIC_SKILL_FACTS: Record<ActionOutcome, string> = {
  success: "{actor}运用「{title}」完成了这次尝试。",
  partial: "{actor}运用「{title}」只达成了部分目标。",
  failure: "{actor}运用「{title}」未能达成目标。",
  impossible: "当前的情况不允许「{title}」发挥作用。",
};
const GENERIC_ASSET_FACTS: Record<ActionOutcome, string> = {
  success: "{actor}使用了「{title}」。",
  partial: "{actor}只发挥了「{title}」的一部分作用。",
  failure: "{actor}这次没能用好「{title}」。",
  impossible: "当前无法使用「{title}」。",
};
const GENERIC_STANCE_FACTS: Record<ActionOutcome, string> = {
  success: "{actor}进入了「{title}」。",
  partial: "{actor}勉强维持着「{title}」。",
  failure: "{actor}没能进入「{title}」。",
  impossible: "当前无法进入「{title}」。",
};

export function createDataDrivenRulePack(
  provider: RuleDefinitionProvider,
): ActionRulePack {
  return {
    async decide({ actor, call }) {
      switch (call.name) {
        case "act":
          return {
            resolution: "automatic",
            automaticOutcome: "success",
            facts: renderFacts(ACT_FACTS, actor, ""),
          };
        case "use_skill":
          return decideSkill(provider, actor, call.arguments.skillId, call.arguments.targetId);
        case "use_asset":
          return decideAsset(provider, actor, call.arguments.assetId);
        case "take_stance":
          return decideStance(provider, actor, call.arguments.stanceId);
      }
    },
  };
}

async function decideSkill(
  provider: RuleDefinitionProvider,
  actor: ActionActor,
  skillId: string,
  targetId: string | null,
): Promise<RuleDecision> {
  const definition = await provider.loadSkill(skillId);
  if (!definition) {
    throw new FatalTurnError(
      "SKILL_NOT_AVAILABLE",
      "The requested skill is not available in the active Rule Pack.",
    );
  }
  const metadata = definition.metadata;
  const discoveryContext = provider.loadDiscoveryContext
    ? await provider.loadDiscoveryContext()
    : {};
  let check = parseCheckSpecification(metadata.check);
  if (check?.system === "draw") {
    // 批次 T5 抽牌不放回：以「定义牌堆 − 本记录内已物化抽牌」为剩余牌堆；
    // 抽空 fail-closed（DECK_EXHAUSTED），绝不静默重置。
    const drawn = provider.listDrawnCards
      ? await provider.listDrawnCards({
          skillKey: definition.skillKey,
          actorCharacterInstanceId: actor.characterInstanceId,
        })
      : [];
    const drawnSet = new Set(drawn);
    const remaining = check.deck.filter((card) => !drawnSet.has(card));
    if (remaining.length === 0) {
      throw new FatalTurnError(
        "DECK_EXHAUSTED",
        "The draw deck for this skill is exhausted in the active record.",
      );
    }
    check = { ...check, skillKey: definition.skillKey, deck: remaining };
  }
  const targetOverrides = targetId
    ? readOutcomeBlock((metadata.targets as Record<string, unknown> | undefined)?.[targetId])
    : undefined;
  const baseOutcomes = readOutcomeBlock(metadata.outcomes);
  const facts = renderFacts(
    mergeOutcomes(GENERIC_SKILL_FACTS, baseOutcomes, targetOverrides, definition.title),
    actor,
    definition.title,
    discoveryContext,
  );
  // 没有技能定义自己的私有观察时，不制造通用观察占位句。
  // 通用的“角色形成判断”属于规则/旁白语气，曾被 Character Runner
  // 当作对白拼接；没有合法观察就只保留 action/fact。
  const privateObservationTemplate = firstText([
    targetOverrides?.privateObservation,
    baseOutcomes?.privateObservation,
  ]);
  const privateObservation = privateObservationTemplate
    ? renderTemplate(privateObservationTemplate, actor, definition.title)
    : undefined;
  const discoveryTemplate = targetOverrides?.discovery ?? baseOutcomes?.discovery;
  const privateObservationDetail = discoveryTemplate
    ? {
        subject: renderTemplate(
          discoveryTemplate.subject,
          actor,
          definition.title,
          discoveryContext,
        ),
        feature: renderTemplate(
          discoveryTemplate.feature,
          actor,
          definition.title,
          discoveryContext,
        ),
        nextCheck: renderTemplate(
          discoveryTemplate.nextCheck,
          actor,
          definition.title,
          discoveryContext,
        ),
      }
    : undefined;
  if (!check) {
    return {
      resolution: "automatic",
      automaticOutcome: "success",
      facts,
      skillContext: {
        skillKey: definition.skillKey,
        title: definition.title,
        description: definition.description,
      } satisfies SkillDiscoveryContext,
      ...(privateObservation ? { privateObservation } : {}),
      ...(privateObservationDetail ? { privateObservationDetail } : {}),
    };
  }
  return {
    resolution: "check",
    check,
    facts,
    skillContext: {
      skillKey: definition.skillKey,
      title: definition.title,
      description: definition.description,
    } satisfies SkillDiscoveryContext,
    ...(privateObservation ? { privateObservation } : {}),
    ...(privateObservationDetail ? { privateObservationDetail } : {}),
  };
}

async function decideAsset(
  provider: RuleDefinitionProvider,
  actor: ActionActor,
  assetId: string,
): Promise<RuleDecision> {
  const definition = await provider.loadAsset(assetId);
  if (!definition) {
    throw new FatalTurnError(
      "ASSET_NOT_AVAILABLE",
      "The requested asset is not available in the active Rule Pack.",
    );
  }
  const baseOutcomes = readOutcomeBlock(definition.metadata.outcomes);
  const facts = renderFacts(
    mergeOutcomes(GENERIC_ASSET_FACTS, baseOutcomes, undefined, definition.title),
    actor,
    definition.title,
  );
  const privateObservation = renderTemplate(
    firstText([baseOutcomes?.privateObservation]),
    actor,
    definition.title,
  );
  const costs: CostDraft[] = definition.consumable
    ? [{ resourceId: `asset:${definition.definitionId}`, amount: 1 }]
    : [];
  return {
    resolution: "automatic",
    automaticOutcome: "success",
    facts,
    ...(privateObservation ? { privateObservation } : {}),
    ...(costs.length > 0 ? { costs } : {}),
  };
}

async function decideStance(
  provider: RuleDefinitionProvider,
  actor: ActionActor,
  stanceId: string,
): Promise<RuleDecision> {
  const definition = await provider.loadStance(stanceId);
  if (!definition) {
    throw new FatalTurnError(
      "STANCE_NOT_AVAILABLE",
      "The requested stance is not available in the active Rule Pack.",
    );
  }
  const baseOutcomes = readOutcomeBlock(definition.metadata.outcomes);
  const facts = renderFacts(
    mergeOutcomes(GENERIC_STANCE_FACTS, baseOutcomes, undefined, definition.title),
    actor,
    definition.title,
  );
  const effects: EffectDraft[] = [{
    effectId: definition.definitionId,
    targetId: actor.characterInstanceId,
    operation: "apply",
  }];
  return {
    resolution: "automatic",
    automaticOutcome: "success",
    facts,
    effects,
  };
}

/**
 * metadata.check 推导（批次 T5 五骰系，规范 §2.2）：缺省 → null（自动成功）；
 * 骰系选择完全由 system 分流；未知骰系与任何非法字段一律
 * RULE_DECISION_INVALID fail-closed，绝不静默改判。
 */
export function parseCheckSpecification(raw: unknown): CheckSpecification | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Skill check metadata must be an object.",
    );
  }
  const spec = raw as Record<string, unknown>;
  const system = spec.system;
  if (typeof system !== "string" || !(DICE_SYSTEMS as readonly string[]).includes(system)) {
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Skill check metadata declares an unknown dice system.",
    );
  }
  if (system === "draw") {
    return parseDrawSpecification(spec);
  }
  const modifier = spec.modifier === undefined ? 0 : spec.modifier;
  const target = spec.target;
  if (
    typeof modifier !== "number" || !Number.isInteger(modifier)
    || typeof target !== "number" || !Number.isInteger(target) || target < 1
  ) {
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Skill check metadata requires an integer modifier and a positive integer target.",
    );
  }
  const partialMargin = parsePartialMargin(spec.partialMargin);
  if (system === "percentile") {
    if (target > 100) {
      throw new FatalTurnError(
        "RULE_DECISION_INVALID",
        "Percentile check target must be a success rate within 1..100.",
      );
    }
    return {
      system: "percentile",
      modifier,
      target,
      ...(partialMargin === undefined ? {} : { partialMargin }),
    };
  }
  if (system === "pool") {
    const dice = spec.dice;
    const sides = spec.sides === undefined ? 6 : spec.sides;
    const successOn = spec.successOn === undefined ? sides : spec.successOn;
    if (
      typeof dice !== "number" || !Number.isInteger(dice) || dice < 1 || dice > 50
      || typeof sides !== "number" || !Number.isInteger(sides) || sides < 2
      || typeof successOn !== "number" || !Number.isInteger(successOn)
      || successOn < 1 || successOn > sides
    ) {
      throw new FatalTurnError(
        "RULE_DECISION_INVALID",
        "Pool check metadata requires dice 1..50, integer sides >= 2 and successOn within 1..sides.",
      );
    }
    return {
      system: "pool",
      modifier,
      target,
      dice,
      sides,
      successOn,
      ...(partialMargin === undefined ? {} : { partialMargin }),
    };
  }
  if (system !== "d20" && system !== "2d6") {
    // 防御不可达分支（DiceSystem 联合已穷尽）——fail-closed 不静默。
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Skill check metadata declares an unknown dice system.",
    );
  }
  return {
    system,
    modifier,
    target,
    ...(partialMargin === undefined ? {} : { partialMargin }),
  };
}

function parsePartialMargin(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 10) {
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Skill partialMargin must be an integer within 1..10.",
    );
  }
  return raw;
}

/** draw 契约: deck 非空去重 ≤100；successCards 非空且 ⊆ deck；不允许 modifier/target。 */
function parseDrawSpecification(
  spec: Record<string, unknown>,
): CheckSpecification {
  if (
    spec.modifier !== undefined
    || spec.target !== undefined
    || spec.partialMargin !== undefined
  ) {
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Draw check metadata must not declare modifier, target or partialMargin.",
    );
  }
  const deck = spec.deck;
  const successCards = spec.successCards;
  const deckValid = Array.isArray(deck) && deck.length > 0 && deck.length <= 100
    && deck.every((card) => typeof card === "string" && card.trim().length > 0)
    && new Set(deck).size === deck.length;
  if (!deckValid) {
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Draw check metadata requires a non-empty unique deck of at most 100 cards.",
    );
  }
  const deckSet = new Set(deck as readonly string[]);
  const successValid = Array.isArray(successCards) && successCards.length > 0
    && successCards.every((card) => typeof card === "string" && deckSet.has(card));
  if (!successValid) {
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Draw check metadata requires successCards to be a non-empty subset of the deck.",
    );
  }
  return {
    system: "draw",
    skillKey: "", // 由规则包裁决时回填（历史查询关联键）
    deck: deck as readonly string[],
    successCards: successCards as readonly string[],
  };
}

type OutcomeBlock = Partial<Record<OutcomeKey | "privateObservation", string>> & {
  discovery?: DiscoveryObservationDraft;
};

function readOutcomeBlock(raw: unknown): OutcomeBlock | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const block: OutcomeBlock = {};
  const source = raw as Record<string, unknown>;
  for (const key of [...OUTCOME_KEYS, "privateObservation"] as const) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      block[key] = value;
    }
  }
  const discovery = readDiscoveryObservation(source.discovery);
  if (discovery) block.discovery = discovery;
  return block;
}

function readDiscoveryObservation(raw: unknown): DiscoveryObservationDraft | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  const subject = typeof source.subject === "string" ? source.subject.trim() : "";
  const feature = typeof source.feature === "string" ? source.feature.trim() : "";
  const nextCheck = typeof source.nextCheck === "string" ? source.nextCheck.trim() : "";
  if (
    !subject || subject.length > 120
    || !feature || feature.length > 240
    || !nextCheck || nextCheck.length > 240
  ) {
    return undefined;
  }
  return { subject, feature, nextCheck };
}

function mergeOutcomes(
  generic: Record<ActionOutcome, string>,
  base: OutcomeBlock | undefined,
  overrides: OutcomeBlock | undefined,
  title: string,
): Record<ActionOutcome, string> {
  const merged = { ...generic };
  for (const key of OUTCOME_KEYS) {
    const template = overrides?.[key] ?? base?.[key];
    if (template) merged[key] = template;
  }
  for (const key of OUTCOME_KEYS) {
    merged[key] = merged[key]!.replaceAll("{title}", title);
  }
  return merged;
}

function renderFacts(
  facts: Record<ActionOutcome, string>,
  actor: ActionActor,
  title: string,
  context: Readonly<Record<string, string>> = {},
): Record<ActionOutcome, string> {
  return {
    success: renderTemplate(facts.success, actor, title, context),
    partial: renderTemplate(facts.partial, actor, title, context),
    failure: renderTemplate(facts.failure, actor, title, context),
    impossible: renderTemplate(facts.impossible, actor, title, context),
  };
}

function renderTemplate(
  template: string | undefined,
  actor: ActionActor,
  title: string,
  context: Readonly<Record<string, string>> = {},
): string {
  return (template ?? "")
    .replaceAll("{actor}", actor.displayName)
    .replaceAll("{title}", title)
    .replaceAll("{location}", context.location?.trim() || "目标");
}

function firstText(values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}
