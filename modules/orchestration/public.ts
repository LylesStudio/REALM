import {
  actorToolFingerprint,
  createDeterministicActionResolver,
  renderDiscoveryDialogue,
  type ActionActor,
  type ActionResolver,
  type ActionTransaction,
  type ActorToolCall,
} from "../actions/public.ts";
import type {
  SemanticSegment,
  SemanticSegmentKind,
} from "../presentation/semantic-segments.ts";
import { FatalTurnError } from "../runtime/public.ts";
import type { PresenceTurnContext } from "./presence.ts";

export type ActivatedCharacter = ActionActor;

export type TurnVisibilityPlan =
  | { kind: "public" }
  | {
      kind: "restricted";
      domainId: string;
      audienceCharacterInstanceIds: readonly string[];
    };

export type TurnVisibilityAssessment = {
  visibility: TurnVisibilityPlan;
  reason: string;
};

export type M2TurnPlan = {
  goal: string;
  constraints: readonly string[];
  activatedCharacters: readonly ActivatedCharacter[];
  narratorEnabled: boolean;
  actionBudgetPerCharacter: number;
  visibility: TurnVisibilityPlan;
  playerAction?: {
    actor: ActivatedCharacter;
    call: ActorToolCall;
  };
  /**
   * 批次 T3：presence 回合的在场上下文（固定计划携带，供 drafter 透传
   * CharacterRunner.react）；普通回合与插话回合无此字段。
   */
  presence?: PresenceTurnContext;
};

export type SemanticOutputDraft = {
  speaker: string;
  participantId: string | null;
  characterInstanceId: string | null;
  content: string;
  segments: readonly SemanticSegment[];
  /**
   * 对话主体标记（内部字段，UI 不展示、不改变可见文本）：角色有明确对话
   * 对象时为对方 participantId（必须与当前 Record 名册对齐），无明确对象
   * 时缺省/null；旧事件与旧实现读作 null（向后兼容）。
   */
  recipientId?: string | null;
  /** 旁白附带的下一步对话提案（仅 narrator 输出使用；fail-closed 可为空）。 */
  suggestions?: readonly string[];
  /**
   * 批次 T3：在场反应附带的关系变化（仅 presence react 使用；
   * fail-closed 规整，无效即缺省）。落库前由应用层校验 target 名册匹配。
   */
  relationship?: { target: string; note: string };
};

/**
 * 当前 Record 可寻址参与者名册项。participantId 是每个玩家/NPC/其他
 * 可寻址参与者的 canonical ID（复用既有 participantId，不另造 ID 体系）。
 */
export type DialogueParticipant = {
  participantId: string;
  characterInstanceId: string;
  displayName: string;
};

/**
 * 带主体信息的最近公开对话行（仅 public 事件；注入 Character Runner 的
 * 下一回合上下文，绝不包含 restricted/private 内容，也不渲染给玩家）。
 */
export type PublicDialogueLine = {
  speaker: string;
  speakerParticipantId: string | null;
  recipientId: string | null;
  text: string;
};

/**
 * Character Runner 的主体上下文：当前可寻址名册 + 带主体信息的最近公开
 * 对话摘要。缺省时 runner 不提供名册块，且任何 recipientId 规整为 null。
 */
export type DialogueSubjectContext = {
  roster: readonly DialogueParticipant[];
  recentPublicDialogue: readonly PublicDialogueLine[];
  /**
   * 当前记录的 record_confirmed 世界知识行（record-local 背景，绝非
   * story/world canon）；缺省为空。
   */
  recordKnowledge?: readonly string[];
};

/** 下一步对话提案的单条长度与条数上限（prompt 说明与 normalizer 同源）。 */
export const NEXT_SUGGESTION_LIMIT = 40;
export const NEXT_SUGGESTION_MAX_COUNT = 3;

/**
 * 回合后给玩家的下一步对话提案（fail-closed 规整）：
 * 非数组/空数组/全非法条目一律归空；超 3 条截断；逐条修剪限长。
 * 规范见 docs/development/ACTION-SUGGESTIONS.md。
 */
export function normalizeNextSuggestions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim().slice(0, NEXT_SUGGESTION_LIMIT) : ""))
    .filter((item) => item.length > 0)
    .slice(0, NEXT_SUGGESTION_MAX_COUNT);
}

export type CharacterIntent = {
  character: ActivatedCharacter;
  requestedActions: readonly ActorToolCall[];
};

export type M2TurnCandidate = {
  narration: SemanticOutputDraft | null;
  characterResponses: readonly SemanticOutputDraft[];
  actionTransactions: readonly ActionTransaction[];
};

export type M2TurnValidation = {
  accepted: boolean;
  goalSatisfied: boolean;
  worldCompatible: boolean;
  actionTransactionsComplete: boolean;
  narratorChecked: boolean;
  activatedCharacterCount: number;
  /**
   * 批次 T10-A：模型复核审计（可选，向后兼容——旧 checkpoint 无此字段）。
   * mode="model" 复核正常放行；mode="degraded" 为确定性降级接受
   * （三连否决/复核不可用/输出持续非法，见 T10-A-DM-DEGRADATION.md）。
   */
  review?: {
    mode: "model" | "degraded";
    vetoes: number;
    reason: string;
  };
};

export interface DMController {
  plan(input: {
    turnId: string;
    playerText: string;
    availableCharacters: readonly ActivatedCharacter[];
    visibility?: TurnVisibilityPlan;
    playerAction?: { actor: ActivatedCharacter; call: ActorToolCall };
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<M2TurnPlan>;
  approveActions(input: {
    plan: M2TurnPlan;
    intents: readonly CharacterIntent[];
  }): Promise<readonly {
    actor: ActivatedCharacter;
    call: ActorToolCall;
  }[]>;
  validate(input: {
    plan: M2TurnPlan;
    candidate: M2TurnCandidate;
    playerText?: string;
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<M2TurnValidation>;
}

export interface Narrator {
  narrate(input: {
    playerText: string;
    actionTransactions: readonly ActionTransaction[];
    activatedCharacters: readonly ActivatedCharacter[];
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<SemanticOutputDraft>;
}

export interface CharacterRunner {
  propose(input: {
    turnId: string;
    playerText: string;
    character: ActivatedCharacter;
    actionBudget: number;
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<CharacterIntent>;
  react(input: {
    playerText: string;
    character: ActivatedCharacter;
    actionTransactions: readonly ActionTransaction[];
    /** 批次 T3：presence 回合的在场上下文；缺省为普通回合反应。 */
    presence?: PresenceTurnContext;
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<SemanticOutputDraft>;
}

export interface M2TurnOrchestrator {
  plan(input: {
    turnId: string;
    playerText: string;
    visibility?: TurnVisibilityPlan;
    playerAction?: { actor: ActivatedCharacter; call: ActorToolCall };
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<M2TurnPlan>;
  draft(input: {
    turnId: string;
    playerText: string;
    plan: M2TurnPlan;
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<M2TurnCandidate>;
  validate(input: {
    plan: M2TurnPlan;
    candidate: M2TurnCandidate;
    playerText?: string;
    /** Batch 2D：本地取消信号（可选，向后兼容）。 */
    signal?: AbortSignal;
  }): Promise<M2TurnValidation>;
}

export function createLocalM2TurnOrchestrator(options: {
  characters: readonly ActivatedCharacter[];
  dmController?: DMController;
  narrator?: Narrator;
  characterRunner?: CharacterRunner;
  actionResolver?: ActionResolver;
}): M2TurnOrchestrator {
  // 允许空阵容：只有人类玩家的世界由 Narrator 单独推进，
  // DM 计划会激活 0 个角色，回合管线对空数组全程安全。
  const dm = options.dmController ?? createRuleBasedDMController();
  const narrator = options.narrator ?? createLocalNarrator();
  const characterRunner = options.characterRunner ?? createLocalCharacterRunner();
  const actionResolver = options.actionResolver ?? createDeterministicActionResolver();

  return {
    async plan(input) {
      const plan = await dm.plan({
        ...input,
        availableCharacters: options.characters,
      });
      const withPlayerAction = input.playerAction
        ? { ...plan, playerAction: input.playerAction }
        : plan;
      return {
        ...withPlayerAction,
        visibility: input.visibility ?? withPlayerAction.visibility,
        narratorEnabled: withPlayerAction.narratorEnabled,
      };
    },

    async draft(input) {
      const intents = await Promise.all(
        input.plan.activatedCharacters.map((character) =>
          characterRunner.propose({
            turnId: input.turnId,
            playerText: input.playerText,
            character,
            actionBudget: input.plan.actionBudgetPerCharacter,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        ),
      );
      const approved = await dm.approveActions({
        plan: input.plan,
        intents,
      });
      const actionTransactions: ActionTransaction[] = [];
      if (input.plan.playerAction) {
        actionTransactions.push(await actionResolver.resolve(input.plan.playerAction));
      }
      for (const action of approved) {
        actionTransactions.push(await actionResolver.resolve(action));
      }

      const narration = input.plan.narratorEnabled
        ? await narrator.narrate({
            playerText: input.playerText,
            actionTransactions,
            activatedCharacters: input.plan.activatedCharacters,
            ...(input.signal ? { signal: input.signal } : {}),
          })
        : null;
      const characterResponses = await Promise.all(
        input.plan.activatedCharacters.map((character) =>
          characterRunner.react({
            playerText: input.playerText,
            character,
            actionTransactions,
            ...(input.plan.presence ? { presence: input.plan.presence } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          })
        ),
      );
      // 提案随回合一次产出：旁白结构化输出附带，fail-closed 规整后
      // 并入候选（经运行时 checkpoint 持久化，release 后随信封返回前端）。
      if (narration) {
        const nextSuggestions = normalizeNextSuggestions(narration.suggestions);
        if (nextSuggestions.length > 0) {
          narration.suggestions = nextSuggestions;
        } else {
          delete narration.suggestions;
        }
      }
      return { narration, characterResponses, actionTransactions };
    },

    validate(input) {
      return dm.validate(input);
    },
  };
}

export function createRuleBasedDMController(): DMController {
  return {
    async plan({ availableCharacters }) {
      return {
        goal: "Advance one coherent public scene without assigning a character's stance.",
        constraints: [
          "Activate only characters needed for this Turn.",
          "Require characters to declare material actions through Actor Tools.",
          "Narrate only world-facing results from completed Action Receipts.",
        ],
        activatedCharacters: availableCharacters.slice(0, 1),
        narratorEnabled: true,
        actionBudgetPerCharacter: 1,
        visibility: { kind: "public" },
      };
    },

    async approveActions({ plan, intents }) {
      if (intents.length !== plan.activatedCharacters.length) {
        throw incompleteCandidate();
      }
      const seenCalls = new Set<string>();
      return intents.flatMap((intent, index) => {
        const expected = plan.activatedCharacters[index];
        if (
          !expected
          || !sameActor(intent.character, expected)
          || intent.requestedActions.length > plan.actionBudgetPerCharacter
        ) {
          throw incompleteCandidate();
        }
        return intent.requestedActions.map((call) => {
          if (seenCalls.has(call.callId)) throw incompleteCandidate();
          seenCalls.add(call.callId);
          return { actor: expected, call };
        });
      });
    },

    async validate({ plan, candidate }) {
      const expectedCharacters = plan.activatedCharacters;
      const actualCharacters = candidate.characterResponses;
      const transactionsByActor = new Map<string, ActionTransaction[]>();
      for (const transaction of candidate.actionTransactions) {
        const existing = transactionsByActor.get(transaction.actor.characterInstanceId) ?? [];
        existing.push(transaction);
        transactionsByActor.set(transaction.actor.characterInstanceId, existing);
      }
      const playerTransactionCount = !plan.playerAction
        ? 0
        : candidate.actionTransactions.filter((transaction) =>
          transaction.origin === "character"
          && sameActor(transaction.actor, plan.playerAction!.actor)
          && actorToolFingerprint(transaction.call)
            === actorToolFingerprint(plan.playerAction!.call)
          && transaction.receipt.status === "resolved"
          && transaction.receipt.callFingerprint
            === actorToolFingerprint(plan.playerAction!.call)
        ).length;
      const playerTransactionValid = plan.playerAction
        ? playerTransactionCount === 1
        : playerTransactionCount === 0;
      const transactionsValid = candidate.actionTransactions.length
          <= expectedCharacters.length * plan.actionBudgetPerCharacter
            + (plan.playerAction ? 1 : 0)
        && playerTransactionValid
        && candidate.actionTransactions.every((transaction) => {
          if (
            plan.playerAction
            && sameActor(transaction.actor, plan.playerAction.actor)
            && actorToolFingerprint(transaction.call)
              === actorToolFingerprint(plan.playerAction.call)
          ) return true;
          return expectedCharacters.some((expected) =>
            sameActor(transaction.actor, expected)
          );
        })
        && expectedCharacters.every((expected) => {
          const transactions = transactionsByActor.get(expected.characterInstanceId) ?? [];
          return transactions.length <= plan.actionBudgetPerCharacter
            && transactions.every((transaction) =>
              transaction.origin === "character"
              && sameActor(transaction.actor, expected)
              && transaction.transactionId === `${transaction.call.callId}:action`
              && transaction.receipt.status === "resolved"
              && transaction.receipt.callId === transaction.call.callId
              && transaction.receipt.callFingerprint
                === actorToolFingerprint(transaction.call)
              && transaction.receipt.publicFacts.length > 0
            );
        });
      const narratorValid = !plan.narratorEnabled
        || (candidate.narration !== null
          && candidate.narration.participantId === null
          && candidate.narration.characterInstanceId === null
          && validOutput(candidate.narration, ["environment", "story", "fact"])
          && narratorAuthorityIsValid(
            candidate.narration,
            candidate.actionTransactions,
            expectedCharacters,
          ));
      const charactersValid = expectedCharacters.length === actualCharacters.length
        && actualCharacters.every((response, index) => {
          const expected = expectedCharacters[index];
          return expected !== undefined
            && response.characterInstanceId === expected.characterInstanceId
            && response.participantId === expected.participantId
            && response.speaker === expected.displayName
            && validOutput(response, ["action", "dialogue"]);
        });
      if (!transactionsValid || !narratorValid || !charactersValid) {
        throw incompleteCandidate();
      }
      return {
        accepted: true,
        goalSatisfied: true,
        worldCompatible: true,
        actionTransactionsComplete: true,
        narratorChecked: narratorValid,
        activatedCharacterCount: actualCharacters.length,
      };
    },
  };
}

export function createLocalNarrator(): Narrator {
  return {
    async narrate({ actionTransactions }) {
      const publicFact = actionTransactions
        .flatMap((transaction) => transaction.receipt.publicFacts)
        .at(0) ?? "防波堤仍维持着短暂的平静。";
      const segments = [
        {
          id: "environment-1",
          kind: "environment",
          content: "冷雾贴着防波堤缓慢流动。",
          speechMode: "narrator",
        },
        {
          id: "fact-1",
          kind: "fact",
          content: publicFact,
          speechMode: "narrator",
        },
        {
          id: "story-1",
          kind: "story",
          content: "是否拆开密函的决定仍悬而未决。",
          speechMode: "narrator",
        },
      ] as const satisfies readonly SemanticSegment[];
      return {
        speaker: "旁白",
        participantId: null,
        characterInstanceId: null,
        content: joinSegments(segments),
        segments,
      };
    },
  };
}

export function createLocalCharacterRunner(): CharacterRunner {
  return {
    async propose({ turnId, character, actionBudget }) {
      if (actionBudget === 0) {
        return { character, requestedActions: [] } satisfies CharacterIntent;
      }
      // The local Fake Provider emits the same typed action shape regardless of
      // player wording. It demonstrates the Actor Tool contract without
      // pretending that regular expressions are language understanding.
      return {
        character,
        requestedActions: [{
          callId: `${turnId}:${character.characterInstanceId}:act:1`,
          name: "act",
          arguments: {
            intent: "确认当前场景中与玩家行动相关的可感知变化",
            targetId: "scene_first_watch",
            approach: "cautious",
          },
        }],
      };
    },

    async react({ character, actionTransactions, presence }) {
      if (presence) {
        // 批次 T3：在场反应的本地确定性形态——轻微动作 + 本人台词。
        const segments = [
          {
            id: "action-1",
            kind: "action",
            content: `${character.displayName}注意到刚发生的变化，作出轻微反应。`,
            speechMode: "narrator",
          },
          {
            id: "dialogue-1",
            kind: "dialogue",
            content: `“${presence.triggerText.slice(0, 40) || "这一幕"}……值得留神。”`,
            speechMode: "speaker",
          },
        ] as const satisfies readonly SemanticSegment[];
        return {
          speaker: character.displayName,
          participantId: character.participantId,
          characterInstanceId: character.characterInstanceId,
          content: joinSegments(segments),
          segments,
        };
      }
      const ownTransaction = actionTransactions.find(
        (transaction) =>
          transaction.actor.characterInstanceId === character.characterInstanceId,
      );
      const discovery = ownTransaction?.receipt.privateObservations.find(
        (item) => item.characterInstanceId === character.characterInstanceId,
      )?.discovery;
      const dialogue = discovery ? renderDiscoveryDialogue(discovery) : null;
      const segments = [
        {
          id: "action-1",
          kind: "action",
          content: discovery
            ? `${character.displayName}检查${discovery.subject}，准备${discovery.nextCheck}。`
            : `${character.displayName}沿着防波堤确认周围的变化。`,
          speechMode: "narrator",
        },
        ...(dialogue ? [{
          id: "dialogue-1",
          kind: "dialogue" as const,
          content: dialogue,
          speechMode: "speaker" as const,
        }] : []),
      ] as const satisfies readonly SemanticSegment[];
      return {
        speaker: character.displayName,
        participantId: character.participantId,
        characterInstanceId: character.characterInstanceId,
        content: joinSegments(segments),
        segments,
      };
    },
  };
}

function validOutput(
  output: SemanticOutputDraft,
  allowedKinds: readonly SemanticSegmentKind[],
): boolean {
  const ids = new Set(output.segments.map((segment) => segment.id));
  return output.content.trim().length > 0
    && output.content.length <= 2_000
    && output.segments.length > 0
    && ids.size === output.segments.length
    && output.segments.every((segment) =>
      allowedKinds.includes(segment.kind)
      && segment.content.trim().length > 0
    )
    && joinSegments(output.segments) === output.content;
}

/**
 * P1-14：英文人称/角色指代（与 model-powered.ts 的 NARRATOR_HUMAN_REFERENCE_ENGLISH
 * 同源演进）。只匹配边界明确的人称代词与显式角色指代；动作/台词动词
 * 故意不做裸匹配（合法环境主语如 "The lighthouse light turns" 不误判）。
 */
const NARRATOR_HUMAN_REFERENCE_ENGLISH =
  /\b(?:he|she|they|him|her|them|his|their|theirs)\b|\bthe\s+(?:players?|characters?|protagonist|narrator)\b/i;

function narratorAuthorityIsValid(
  narration: SemanticOutputDraft,
  transactions: readonly ActionTransaction[],
  characters: readonly ActivatedCharacter[],
): boolean {
  const publicFacts = new Set(
    transactions.flatMap((transaction) => transaction.receipt.publicFacts),
  );
  return narration.segments.every((segment) => {
    if (segment.kind === "fact") return publicFacts.has(segment.content);
    if (segment.kind !== "environment" && segment.kind !== "story") return true;
    return !/她|他|斥候|学者|使节|提问者|玩家|角色|人物|人影|来者|众人|有人|手中|指尖|目光|低声|说道|回应/.test(segment.content)
      && !NARRATOR_HUMAN_REFERENCE_ENGLISH.test(segment.content)
      && characters.every((character) =>
        !segment.content.includes(character.displayName)
      );
  });
}

function joinSegments(segments: readonly SemanticSegment[]): string {
  return segments.map((segment) => segment.content.trim()).join("\n");
}

function sameActor(left: ActionActor, right: ActionActor): boolean {
  return left.characterInstanceId === right.characterInstanceId
    && left.participantId === right.participantId
    && left.displayName === right.displayName;
}

function incompleteCandidate(): FatalTurnError {
  return new FatalTurnError(
    "DM_OUTPUT_INCOMPLETE",
    "The DM rejected an incomplete or role-incompatible Turn candidate.",
  );
}

export {
  createModelDynamicDiscoveryGenerator,
  createModelPoweredM2TurnOrchestrator,
  createModelPresenceAssessor,
  createModelVisibilityAssessor,
  normalizeObservationDialogue,
} from "./model-powered.ts";
