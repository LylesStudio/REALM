import { FatalTurnError } from "../runtime/public.ts";
import { INTERNAL_META_CORE_PATTERNS } from "../presentation/internal-text-core.ts";
import { createDemoRuleDefinitionProvider } from "./demo-definitions.ts";
import { resolveUncertainty, type RandomIntSource } from "./engine.ts";
import {
  createDataDrivenRulePack,
  type CheckSpecification,
  type DiceSystem,
} from "./rule-pack.ts";

export type ActionActor = {
  characterInstanceId: string;
  participantId: string;
  displayName: string;
  /**
   * 当前 Record 的角色简介摘要（定义简介 + 追加合并的 growth notes）；
   * 可选——模型上下文用，旧调用方缺省不影响行为。
   */
  profileSummary?: string;
};

export type ActionAffordanceKind = "skill" | "asset" | "stance" | "scene";

export type ActionAffordance = {
  id: string;
  kind: ActionAffordanceKind;
  actorCharacterInstanceId: string;
  actorName: string;
  title: string;
  description: string;
  suggestedText: string;
};

export type ActionSelection = {
  affordanceId: string;
};

export type ActionAffordanceScope = {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
  principalId: string;
  characterInstanceId: string;
};

export interface ActionAffordanceCatalog {
  listAuthorized(
    scope: ActionAffordanceScope,
  ): Promise<readonly ActionAffordance[]>;
}

export type ActToolCall = {
  callId: string;
  name: "act";
  arguments: {
    intent: string;
    targetId: string | null;
    approach: string | null;
  };
};

export type UseSkillToolCall = {
  callId: string;
  name: "use_skill";
  arguments: {
    skillId: string;
    targetId: string | null;
    intent: string;
  };
};

export type UseAssetToolCall = {
  callId: string;
  name: "use_asset";
  arguments: {
    assetId: string;
    targetId: string | null;
    intent: string;
  };
};

export type TakeStanceToolCall = {
  callId: string;
  name: "take_stance";
  arguments: {
    stanceId: string;
    intent: string;
  };
};

export type ActorToolCall =
  | ActToolCall
  | UseSkillToolCall
  | UseAssetToolCall
  | TakeStanceToolCall;

export type ActionOutcome = "success" | "partial" | "failure" | "impossible";
export type ActionResolutionMode = "automatic" | "check" | "contest";

export type DiscoveryObservationDraft = {
  subject: string;
  feature: string;
  nextCheck: string;
};

export type DiscoveryObservation = DiscoveryObservationDraft & {
  certainty: "confirmed" | "partial";
};

/** 仅拦截高置信度的 prompt/协议注入语句；普通世界词汇（如“供水系统”“模型船”“检定”）合法。 */
export function isInternalDiscoveryText(value: string): boolean {
  if (INTERNAL_META_CORE_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }
  return /生成对白|输出\s*(?:json|JSON)|调用工具|工具调用|忽略(?:此前|上文|以上|这些).{0,30}(?:指令|规则|提示)|(?:不要|不得|请勿).{0,20}(?:泄露|改变输出|绕过).{0,20}(?:格式|系统|规则|提示)/i.test(value);
}

export type DynamicDiscoveryContext = {
  /** 世界内系统文本语言；缺省时 prompt kit 回落默认规则。 */
  language?: string;
  worldName: string;
  era: string;
  summary: string;
  storyTitle: string;
  premise: string;
  location: string;
  weather: string;
  tension: string;
  objective: string;
  canon: string;
  /** SWM v2：合格 lore excerpt 行（空=无；可选以保持旧装配兼容）。 */
  worldLore?: string;
  recentPublicEvents: readonly string[];
};

export type SkillDiscoveryContext = {
  skillKey: string;
  title: string;
  description: string;
};

export type DynamicDiscoveryRequest = {
  actor: ActionActor;
  call: UseSkillToolCall;
  skill: SkillDiscoveryContext;
  outcome: Extract<ActionOutcome, "success" | "partial">;
  publicFact: string;
  context: DynamicDiscoveryContext;
};

export interface DynamicDiscoveryGenerator {
  generate(input: DynamicDiscoveryRequest): Promise<DiscoveryObservationDraft | null>;
}

/** 将已授权的结构化发现压成角色可说、且不新增事实的短句。 */
export function renderDiscoveryDialogue(
  observation: DiscoveryObservation,
): string | null {
  const subject = observation.subject.trim();
  const feature = observation.feature.trim();
  const nextCheck = observation.nextCheck.trim();
  if (!subject || !feature || !nextCheck) return null;
  if (observation.certainty === "partial") {
    return `“${subject}有点不对劲：${feature}。我还不能下结论，先${nextCheck}。”`;
  }
  return `“${subject}不对。${feature}。沿着这条线索，${nextCheck}。”`;
}

export function formatDiscoveryObservationContent(
  observation: DiscoveryObservationDraft,
): string {
  return `对象：${observation.subject}；特征：${observation.feature}；下一步：${observation.nextCheck}`;
}

export type PrivateObservationDraft = {
  characterInstanceId: string;
  content: string;
  discovery?: DiscoveryObservation;
};

export type EffectDraft = {
  effectId: string;
  targetId: string;
  operation: "apply" | "remove";
};

export type CostDraft = {
  resourceId: string;
  amount: number;
};

/**
 * 批次 T5：统一 MechanicDetail（规范 §2.3）——五种骰系同一结构：
 * 骰点明细（rolls）/修正/目标/比照值（total）/成败，暴击与大失败落标记；
 * draw 附带 skillKey（不放回历史查询关联键）、drawnCard、deckRemaining。
 */
export type MechanicDetail = {
  system: DiceSystem;
  /** 骰点明细（d20→1 颗、2d6→2 颗、pool→N 颗）；draw 无骰点为空数组。 */
  rolls: readonly number[];
  /** draw 恒 0（draw 不允许 modifier）。 */
  modifier: number;
  /** percentile=成功率；pool=需要成功数；draw 恒 0。 */
  target: number;
  /** d20/2d6：合计+修正；percentile：roll；pool：成功数+修正；draw 恒 0。 */
  total: number;
  success: boolean;
  critical?: true;
  fumble?: true;
  skillKey?: string;
  drawnCard?: string;
  /** draw：本次抽取后的剩余牌数。 */
  deckRemaining?: number;
};

export type ActionReceipt = {
  callId: string;
  callFingerprint: string;
  status: "resolved";
  resolution: ActionResolutionMode;
  outcome: ActionOutcome;
  summary: string;
  publicFacts: readonly string[];
  privateObservations: readonly PrivateObservationDraft[];
  effects: readonly EffectDraft[];
  costs: readonly CostDraft[];
  mechanic?: MechanicDetail;
};

export type ActionTransaction = {
  transactionId: string;
  origin: "character";
  actor: ActionActor;
  call: ActorToolCall;
  receipt: ActionReceipt;
};

export type RuleDecision = {
  resolution: ActionResolutionMode;
  automaticOutcome?: ActionOutcome;
  check?: CheckSpecification;
  facts: Readonly<Record<ActionOutcome, string>>;
  privateObservation?: string;
  privateObservationDetail?: DiscoveryObservationDraft;
  skillContext?: SkillDiscoveryContext;
  effects?: readonly EffectDraft[];
  costs?: readonly CostDraft[];
};

export interface ActionRulePack {
  decide(input: {
    actor: ActionActor;
    call: ActorToolCall;
  }): Promise<RuleDecision>;
}

/** 角色实际持有的技能摘要（提示词与校验的数据源）。 */
export type CharacterSkillSummary = {
  skillKey: string;
  title: string;
  description: string;
};

/**
 * 批次 T4：角色技能持有查询。真实模型路径按世界数据
 * （character_skills + skill_definitions，含世界游标门禁）加载；
 * 加载失败必须 fail-closed 为空集（角色只能 act）。
 */
export interface CharacterSkillProvider {
  listSkills(
    characterInstanceId: string,
  ): Promise<readonly CharacterSkillSummary[]>;
}

export interface ActionResolver {
  resolve(input: {
    actor: ActionActor;
    call: ActorToolCall;
  }): Promise<ActionTransaction>;
}

const EMPTY_DYNAMIC_DISCOVERY_CONTEXT: DynamicDiscoveryContext = {
  worldName: "",
  era: "",
  summary: "",
  storyTitle: "",
  premise: "",
  location: "",
  weather: "",
  tension: "",
  objective: "",
  canon: "",
  recentPublicEvents: [],
};

/** 动态发现字段上限（prompt 说明与 normalizer 同源）。 */
export const DISCOVERY_FIELD_LIMITS = {
  subject: 160,
  feature: 400,
  nextCheck: 400,
} as const;

/**
 * discovery 输出的共享 normalizer（Prompt System v2 单源）：字段上限
 * 同源 DISCOVERY_FIELD_LIMITS + 注入拦截；orchestration 解析层与规则层
 * 双重校验共用本实现，不得再复制。
 */
export function normalizeDiscoveryDraft(value: unknown): DiscoveryObservationDraft | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const subject = typeof source.subject === "string" ? source.subject.trim() : "";
  const feature = typeof source.feature === "string" ? source.feature.trim() : "";
  const nextCheck = typeof source.nextCheck === "string" ? source.nextCheck.trim() : "";
  if (
    subject.length < 1 || subject.length > DISCOVERY_FIELD_LIMITS.subject
    || feature.length < 1 || feature.length > DISCOVERY_FIELD_LIMITS.feature
    || nextCheck.length < 1 || nextCheck.length > DISCOVERY_FIELD_LIMITS.nextCheck
  ) return null;
  if (isInternalDiscoveryText(`${subject}\n${feature}\n${nextCheck}`)) {
    return null;
  }
  return { subject, feature, nextCheck };
}

export function createDeterministicActionResolver(options: {
  rulePack?: ActionRulePack;
  allowStatefulReceipts?: boolean;
  /** 批次 T5：随机源注入点（测试用确定性序列；生产缺省 CSPRNG）。 */
  randomInt?: RandomIntSource;
  dynamicDiscoveryGenerator?: DynamicDiscoveryGenerator;
  dynamicDiscoveryContext?: DynamicDiscoveryContext;
} = {}): ActionResolver {
  const rulePack = options.rulePack ?? createLocalRulePack();
  const receipts = new Map<string, {
    fingerprint: string;
    transaction: ActionTransaction;
  }>();

  return {
    async resolve(input) {
      validateActor(input.actor);
      validateActorToolCall(input.call);
      if (
        !options.allowStatefulReceipts
        && (input.call.name === "use_asset" || input.call.name === "take_stance")
      ) {
        throw new FatalTurnError(
          "STATEFUL_ACTION_NOT_AVAILABLE",
          "State-changing Actor Tools require the durable PostgreSQL Action State Ledger.",
        );
      }
      const fingerprint = actorToolFingerprint(input.call);
      const existing = receipts.get(input.call.callId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new FatalTurnError(
            "ACTION_IDEMPOTENCY_CONFLICT",
            "An Actor Tool Call identifier was reused with different arguments.",
          );
        }
        return structuredClone(existing.transaction);
      }

      const decision = await rulePack.decide(input);
      const receipt = resolveDecision(
        input,
        fingerprint,
        decision,
        options.allowStatefulReceipts ?? false,
        options.randomInt,
      );
      if (
        options.dynamicDiscoveryGenerator
        && input.call.name === "use_skill"
        && decision.skillContext
        && (receipt.outcome === "success" || receipt.outcome === "partial")
      ) {
        let dynamic: DiscoveryObservationDraft | null = null;
        try {
          dynamic = await options.dynamicDiscoveryGenerator.generate({
            actor: input.actor,
            call: input.call,
            skill: decision.skillContext,
            outcome: receipt.outcome,
            publicFact: receipt.summary,
            context: options.dynamicDiscoveryContext ?? EMPTY_DYNAMIC_DISCOVERY_CONTEXT,
          });
        } catch {
          dynamic = null;
        }
        const normalized = normalizeDiscoveryDraft(dynamic);
        receipt.privateObservations = normalized
          ? [{
              characterInstanceId: input.actor.characterInstanceId,
              content: formatDiscoveryObservationContent(normalized),
              discovery: {
                ...normalized,
                certainty: receipt.outcome === "partial" ? "partial" : "confirmed",
              },
            }]
          : [];
      }
      const transaction: ActionTransaction = {
        transactionId: `${input.call.callId}:action`,
        origin: "character",
        actor: { ...input.actor },
        call: structuredClone(input.call),
        receipt,
      };
      receipts.set(input.call.callId, { fingerprint, transaction });
      return structuredClone(transaction);
    },
  };
}

export function createLocalRulePack(): ActionRulePack {
  return createDataDrivenRulePack(createDemoRuleDefinitionProvider());
}

export function actorToolFingerprint(call: ActorToolCall): string {
  return JSON.stringify({
    callId: call.callId,
    name: call.name,
    arguments: Object.fromEntries(
      Object.entries(call.arguments).sort(([left], [right]) =>
        left.localeCompare(right)
      ),
    ),
  });
}

function resolveDecision(
  input: { actor: ActionActor; call: ActorToolCall },
  callFingerprint: string,
  decision: RuleDecision,
  allowStatefulReceipts: boolean,
  randomInt?: RandomIntSource,
): ActionReceipt {
  if (
    !allowStatefulReceipts
    && ((decision.effects?.length ?? 0) > 0 || (decision.costs?.length ?? 0) > 0)
  ) {
    throw new FatalTurnError(
      "STATEFUL_ACTION_NOT_AVAILABLE",
      "Rule decisions with effects or costs require the durable PostgreSQL state ledger.",
    );
  }
  let outcome: ActionOutcome;
  let mechanic: MechanicDetail | undefined;
  if (decision.resolution === "automatic") {
    outcome = decision.automaticOutcome ?? "success";
  } else if (decision.resolution === "check") {
    if (!decision.check) {
      throw new FatalTurnError(
        "RULE_DECISION_INVALID",
        "A check decision requires a supported internal mechanic.",
      );
    }
    // 批次 T5：掷骰只发生在这里（裁决时刻），结果随 Receipt 一次物化落库；
    // 重放走解析器 callId 去重与发布层 completed 短路，读已落库结果不重掷。
    const resolution = resolveUncertainty({
      check: decision.check,
      ...(randomInt ? { randomInt } : {}),
    });
    outcome = resolution.outcome;
    mechanic = resolution.mechanic;
  } else {
    throw new FatalTurnError(
      "CONTEST_NOT_AVAILABLE",
      "Contested actions are not enabled in this local batch.",
    );
  }

  const fact = decision.facts[outcome];
  if (!fact?.trim()) {
    throw new FatalTurnError(
      "RULE_DECISION_INVALID",
      "Every resolved outcome requires a public world fact.",
    );
  }
  const privateObservationContent = decision.privateObservation?.trim()
    || (decision.privateObservationDetail
      ? `对象：${decision.privateObservationDetail.subject}；特征：${decision.privateObservationDetail.feature}；下一步：${decision.privateObservationDetail.nextCheck}`
      : "");
  return {
    callId: input.call.callId,
    callFingerprint,
    status: "resolved",
    resolution: decision.resolution,
    outcome,
    summary: fact,
    publicFacts: [fact],
    privateObservations: privateObservationContent
        && (outcome === "success" || outcome === "partial")
      ? [{
          characterInstanceId: input.actor.characterInstanceId,
          content: privateObservationContent,
          ...(decision.privateObservationDetail
            ? {
                discovery: {
                  ...decision.privateObservationDetail,
                  certainty: outcome === "partial" ? "partial" as const : "confirmed" as const,
                },
              }
            : {}),
        }]
      : [],
    effects: decision.effects ?? [],
    costs: decision.costs ?? [],
    ...(mechanic ? { mechanic } : {}),
  };
}

function validateActor(actor: ActionActor): void {
  if (
    !actor.characterInstanceId.trim()
    || !actor.participantId.trim()
    || !actor.displayName.trim()
  ) {
    throw new FatalTurnError(
      "ACTION_ACTOR_INVALID",
      "Actor Tools require a complete CharacterInstance identity.",
    );
  }
}

function validateActorToolCall(call: ActorToolCall): void {
  requireText(call.callId, "Actor Tool Call identity", 160);
  switch (call.name) {
    case "act":
      requireText(call.arguments.intent, "Action intent");
      optionalText(call.arguments.targetId, "Action target");
      optionalText(call.arguments.approach, "Action approach");
      break;
    case "use_skill":
      requireIdentifier(call.arguments.skillId, "Skill");
      requireText(call.arguments.intent, "Skill intent");
      optionalText(call.arguments.targetId, "Skill target");
      break;
    case "use_asset":
      requireIdentifier(call.arguments.assetId, "Asset");
      requireText(call.arguments.intent, "Asset intent");
      optionalText(call.arguments.targetId, "Asset target");
      break;
    case "take_stance":
      requireIdentifier(call.arguments.stanceId, "Stance");
      requireText(call.arguments.intent, "Stance intent");
      break;
  }
}

function requireIdentifier(value: string, label: string): void {
  requireText(value, label, 120);
  if (!/^[a-z0-9][a-z0-9_.:-]*$/i.test(value)) {
    throw new FatalTurnError(
      "ACTOR_TOOL_ARGUMENT_INVALID",
      `${label} must use a stable identifier.`,
    );
  }
}

function requireText(value: string, label: string, maxLength = 320): void {
  if (!value.trim() || value.length > maxLength) {
    throw new FatalTurnError(
      "ACTOR_TOOL_ARGUMENT_INVALID",
      `${label} must be non-empty and concise.`,
    );
  }
}

function optionalText(value: string | null, label: string): void {
  if (value !== null) requireText(value, label, 160);
}
