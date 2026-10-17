/**
 * Local Record turn runtime dependency bridge（Phase 2E）：从
 * local-record-service.ts 拆出的 TurnRuntimeDependencies 组装边界——
 * planner/drafter/validator/releaser、presence/interjection 固定计划、
 * 取消 signal 检查、orchestrator factory 选择与 action catalog 接线。
 * 行为保持——所有语义与拆分前逐行一致；本模块不复制第二份 runtime
 * 状态机/commit 逻辑，只做模块间 bridge 组装。
 *
 * 依赖方向硬边界：本模块只依赖 runtime/orchestration/actions/presentation
 * 的公开契约与 read-model 的共享类型/错误，绝不 import
 * local-record-service.ts（反向依赖由 facade 以 import/re-export 维持
 * 公开 API 与类型路径不变）。
 */
import {
  type RecordRuntimeScope,
  type RuntimeActor,
} from "../../database/postgres/public.ts";
import {
  FatalTurnError,
  type JsonValue,
  type RuntimeRepository,
  type TurnRun,
  type TurnRuntimeDependencies,
} from "../runtime/public.ts";
import {
  createLocalM2TurnOrchestrator,
  createRuleBasedDMController,
  type DraftProgress,
  type M2TurnCandidate,
  type M2TurnOrchestrator,
  type M2TurnPlan,
  type M2TurnValidation,
  type TurnVisibilityPlan,
} from "../orchestration/public.ts";
import { type PresenceTriggerKind } from "../orchestration/presence.ts";
import {
  fallbackCompositeSemanticSegments,
  type SemanticSegment,
} from "../presentation/semantic-segments.ts";
import {
  type ActionAffordance,
  type ActionAffordanceCatalog,
  type ActionSelection,
  type ActionTransaction,
  type ActorToolCall,
} from "../actions/public.ts";
import {
  LocalRecordServiceError,
  demoRecordRuntimeScope,
  listAuthorizedAffordances,
} from "./local-record-read-model.ts";
import { type CharacterProfileUpdate } from "./character-profile.ts";
import { decodeNarrativeState, emptyNarrativeState, planNarrativeConsequence,
  type RecordNarrativeState, type NarrativeConsequenceProposal } from "./narrative-situation.ts";

/** 进行中回合的本地取消信号登记（recordId 作用域，取消须同源）。 */
export type ActiveTurnSignal = { recordId: string; controller: AbortController };

export type PlayerUtterancePayload = {
  text: string;
  actionSelection?: ActionSelection;
  visibility: TurnVisibilityPlan;
  runtimeScope?: RecordRuntimeScope;
  profileUpdate?: CharacterProfileUpdate;
  /** M4：角色自动插话回合；不产生玩家事件。 */
  interjection?: {
    characterInstanceId: string;
    triggerText: string;
  };
  /** 批次 T3：角色在场回合；不产生玩家事件。 */
  presence?: {
    characterInstanceId: string;
    triggerKind: PresenceTriggerKind;
    triggerText: string;
    memories: string;
    relationships: string;
  };
  /**
   * 批次 T7：世界自演拍（无玩家输入的自治回合）——走完整 DM 规划/旁白/
   * 角色行动管线，不产生玩家事件；text 恒等于 selfPlay.instruction。
   */
  selfPlay?: {
    beat: number;
    instruction: string;
  };
};
export type FormalEventPayload = {
  schemaVersion: 1;
  role: "player" | "character" | "narrator" | "system";
  speaker: string;
  participantId: string | null;
  content: string;
  segments: readonly SemanticSegment[];
  /**
   * 对话主体标记（内部字段，UI 不展示）：角色有明确对话对象时为对方
   * participantId，无明确对象时缺省；旧事件读作 null（向后兼容）。
   */
  recipientId?: string | null;
  /** 旁白附带的下一步对话提案，随 narration.committed 事件持久化。 */
  suggestions?: readonly string[];
  /** Engine-bound state and accepted proposal; never accepted from a browser. */
  narrativeState?: RecordNarrativeState;
  narrativeConsequence?: NarrativeConsequenceProposal;
  /** 玩家明确自述后，当前 Record 角色简介的动态更新。 */
  profileUpdate?: CharacterProfileUpdate;
  actionTransaction?: ActionTransaction;
  /**
   * 批次 T3：在场标记（payload 元数据，不是新事件类型）——
   * 该事件是回合外角色主动发声，triggerKind 为触发种类。
   */
  presence?: {
    characterInstanceId: string;
    triggerKind: PresenceTriggerKind;
  };
  /**
   * 批次 T7：自演拍标记（payload 元数据，不是新事件类型）——
   * 该事件是世界自演回合产出，beat 为拍号（1 起）。
   */
  selfPlay?: {
    beat: number;
  };
};
export type OutboxPayload = {
  recordId: string;
  eventIds: readonly string[];
};

export type LocalRuntimeRepository = RuntimeRepository<
  PlayerUtterancePayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation,
  FormalEventPayload,
  OutboxPayload
>;

export type LocalTurnRun = TurnRun<
  PlayerUtterancePayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation
>;

export function createLocalTurnDependencies(
  repository: LocalRuntimeRepository,
  clock: () => Date,
  idFactory?: () => string,
  orchestration?: M2TurnOrchestrator | ((scope: RecordRuntimeScope) => M2TurnOrchestrator),
  turnSignals?: ReadonlyMap<string, ActiveTurnSignal>,
  actionCatalog?: ActionAffordanceCatalog,
): TurnRuntimeDependencies<
  PlayerUtterancePayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation,
  FormalEventPayload,
  OutboxPayload
> {
  function orchestratorFor(scope: RecordRuntimeScope): M2TurnOrchestrator {
    if (typeof orchestration === "function") return orchestration(scope);
    return orchestration ?? createLocalM2TurnOrchestrator({
      characters: scope.aiCharacters,
    });
  }
  function assertNotCancelled(idempotencyKey: string) {
    // M4：打断在阶段边界生效；被取消的 Turn 不得提交任何正式事件。
    if (turnSignals?.get(idempotencyKey)?.controller.signal.aborted) {
      throw new FatalTurnError(
        "TURN_CANCELLED",
        "The Turn was interrupted by the player.",
      );
    }
  }
  return {
    repository,
    planner: {
      async plan(context) {
        assertNotCancelled(context.command.idempotencyKey);
        const scope = context.command.payload.runtimeScope ?? demoRecordRuntimeScope();
        const presence = context.command.payload.presence;
        if (presence) {
          // 在场回合使用固定计划：不调用模型规划，无 Narrator、无行动预算。
          const character = scope.aiCharacters.find(
            (actor) => actor.characterInstanceId === presence.characterInstanceId,
          );
          if (!character) {
            throw new FatalTurnError(
              "PRESENCE_CHARACTER_UNKNOWN",
              "The presence character is not part of this Record.",
            );
          }
          return {
            turnIntent: `让 ${character.displayName} 对刚发生的变化自发作出一个简短反应。`,
            constraints: ["在场反应不得开启 Narrator，不得包含行动事务。"],
            activatedCharacters: [character],
            narratorEnabled: false,
            actionBudgetPerCharacter: 0,
            visibility: context.command.payload.visibility,
            presence: {
              characterInstanceId: presence.characterInstanceId,
              triggerKind: presence.triggerKind,
              triggerText: presence.triggerText,
              memories: presence.memories,
              relationships: presence.relationships,
            },
          };
        }
        const interjection = context.command.payload.interjection;
        if (interjection) {
          // 插话回合使用固定计划：不调用模型规划，无 Narrator、无行动预算。
          const character = scope.aiCharacters.find(
            (actor) => actor.characterInstanceId === interjection.characterInstanceId,
          );
          if (!character) {
            throw new FatalTurnError(
              "INTERJECTION_CHARACTER_UNKNOWN",
              "The interjecting character is not part of this Record.",
            );
          }
          return {
            turnIntent: `让 ${character.displayName} 对触发内容作出简短插话回应。`,
            constraints: ["插话不得开启 Narrator，不得包含行动事务。"],
            activatedCharacters: [character],
            narratorEnabled: false,
            actionBudgetPerCharacter: 0,
            visibility: context.command.payload.visibility,
          };
        }
        const orchestrator = orchestratorFor(scope);
        const selfPlay = context.command.payload.selfPlay;
        if (selfPlay) {
          // 批次 T7 自演拍：真实 DM 模型规划（无玩家输入，instruction 作上下文），
          // 随后确定性规整——Narrator 恒开、行动预算恒 1、空激活兜底前 1 名，
          // 保证每拍有内容；规整只收紧不放纵（DM 越界输出仍已在 plan 内被拒）。
          const planned = await orchestrator.plan({
            turnId: context.turnId,
            playerText: selfPlay.instruction,
            visibility: context.command.payload.visibility,
          });
          return {
            ...planned,
            narrativeMode: "passive",
            narratorEnabled: true,
            actionBudgetPerCharacter: 1,
            activatedCharacters: planned.activatedCharacters.length > 0
              ? planned.activatedCharacters
              : scope.aiCharacters.slice(0, 1),
          };
        }
        return orchestrator.plan({
          turnId: context.turnId,
          playerText: context.command.payload.text,
          visibility: context.command.payload.visibility,
          ...(context.command.payload.actionSelection
            ? {
                playerAction: await resolvePlayerAction(
                  actionCatalog!,
                  scope,
                  context.turnId,
                  context.command.payload.text,
                  context.command.payload.actionSelection,
                ),
              }
            : {}),
        });
      },
    },
    drafter: {
      async draft(context) {
        assertNotCancelled(context.command.idempotencyKey);
        const scope = context.command.payload.runtimeScope ?? demoRecordRuntimeScope();
        const orchestrator = orchestratorFor(scope);
        return orchestrator.draft({
          turnId: context.turnId,
          playerText: context.command.payload.interjection
            ? context.command.payload.interjection.triggerText
            : context.command.payload.text,
          plan: context.plan.body,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.draftProgress
            ? { progress: context.draftProgress as unknown as DraftProgress }
            : {}),
          ...(context.saveDraftProgress
            ? {
              onProgress: async (progress: DraftProgress) => {
                await context.saveDraftProgress?.(progress as unknown as JsonValue);
              },
            }
            : {}),
        });
      },
    },
    validator: {
      async validate(context) {
        assertNotCancelled(context.command.idempotencyKey);
        if (context.command.payload.interjection || context.command.payload.presence) {
          // 插话/在场只做结构校验：恰好一条目标角色回应、无行动事务；不走模型复核。
          return createRuleBasedDMController().validate({
            plan: context.plan.body,
            candidate: context.candidate.body,
          });
        }
        const scope = context.command.payload.runtimeScope ?? demoRecordRuntimeScope();
        const orchestrator = orchestratorFor(scope);
        return orchestrator.validate({
          plan: context.plan.body,
          candidate: context.candidate.body,
          playerText: context.command.payload.text,
        });
      },
    },
    releaseBuilder: {
      async build(context) {
        assertNotCancelled(context.command.idempotencyKey);
        const scope = context.command.payload.runtimeScope ?? demoRecordRuntimeScope();
        const presence = context.command.payload.presence;
        if (presence) {
          // 在场回合只发布角色自主发声：不产生玩家事件、旁白或行动事务；
          // payload 附 presence 标记（既有事件形态，不是新事件类型）。
          return {
            formalEvents: context.candidate.body.characterResponses.map(
              (response, index) => ({
                eventId: `${context.turnId}:presence:${index + 1}`,
                kind: "utterance.committed",
                payload: {
                  schemaVersion: 1 as const,
                  role: "character" as const,
                  speaker: response.speaker,
                  participantId: response.participantId,
                  content: response.content,
                  segments: response.segments,
                  // 对话主体标记：仅在有明确对象时落字段（缺省读作 null）。
                  ...(response.recipientId
                    ? { recipientId: response.recipientId }
                    : {}),
                  presence: {
                    characterInstanceId: presence.characterInstanceId,
                    triggerKind: presence.triggerKind,
                  },
                },
              }),
            ),
            outbox: [
              {
                messageId: `${context.turnId}:delivery`,
                topic: "record.events.committed",
                dedupeKey: `${context.turnId}:delivery:v1`,
                payload: {
                  recordId: context.command.recordId,
                  eventIds: context.candidate.body.characterResponses.map(
                    (_response, index) => `${context.turnId}:presence:${index + 1}`,
                  ),
                },
              },
            ],
          };
        }
        if (context.command.payload.interjection) {
          // 插话回合只发布角色回应：不产生玩家事件、旁白或行动事务。
          return {
            formalEvents: context.candidate.body.characterResponses.map(
              (response, index) => ({
                eventId: `${context.turnId}:interjection:${index + 1}`,
                kind: "utterance.committed",
                payload: {
                  schemaVersion: 1 as const,
                  role: "character" as const,
                  speaker: response.speaker,
                  participantId: response.participantId,
                  content: response.content,
                  segments: response.segments,
                  ...(response.recipientId
                    ? { recipientId: response.recipientId }
                    : {}),
                },
              }),
            ),
            outbox: [
              {
                messageId: `${context.turnId}:delivery`,
                topic: "record.events.committed",
                dedupeKey: `${context.turnId}:delivery:v1`,
                payload: {
                  recordId: context.command.recordId,
                  eventIds: context.candidate.body.characterResponses.map(
                    (_response, index) => `${context.turnId}:interjection:${index + 1}`,
                  ),
                },
              },
            ],
          };
        }
        const selfPlay = context.command.payload.selfPlay;
        if (selfPlay) {
          // 批次 T7 自演拍：不产出玩家事件；行动事务（含 T5 骰点物化）+
          // 旁白 + 角色事件照常发布，旁白与角色事件载荷附 selfPlay 标记
          // （既有事件形态，不是新事件类型，T3 presence 先例）。
          const selfPlayNarrationEventId = `${context.turnId}:narration`;
          return {
            formalEvents: [
              ...context.candidate.body.actionTransactions.map(
                (transaction, index) => ({
                  eventId: toolEventId(context.turnId, index),
                  kind: "action.transaction.committed",
                  payload: {
                    schemaVersion: 1 as const,
                    role: "system" as const,
                    speaker: "行动裁决",
                    participantId: null,
                    content: transaction.receipt.summary,
                    segments: [
                      {
                        id: "fact-1",
                        kind: "fact" as const,
                        content: transaction.receipt.summary,
                        speechMode: "none" as const,
                      },
                    ],
                    actionTransaction: transaction,
                  },
                }),
              ),
              ...(context.candidate.body.narration
                ? [{
                    eventId: selfPlayNarrationEventId,
                    kind: "narration.committed",
                    payload: {
                      schemaVersion: 1 as const,
                      role: "narrator" as const,
                      speaker: context.candidate.body.narration.speaker,
                      participantId: null,
                      content: context.candidate.body.narration.content,
                      segments: context.candidate.body.narration.segments,
                      ...(context.candidate.body.narration.suggestions?.length
                        ? { suggestions: context.candidate.body.narration.suggestions }
                        : {}),
                      selfPlay: { beat: selfPlay.beat },
                    },
                  }]
                : []),
              ...context.candidate.body.characterResponses.map(
                (response, index) => ({
                  eventId: `${context.turnId}:character:${index + 1}`,
                  kind: "utterance.committed",
                  payload: {
                    schemaVersion: 1 as const,
                    role: "character" as const,
                    speaker: response.speaker,
                    participantId: response.participantId,
                    content: response.content,
                    segments: response.segments,
                    ...(response.recipientId
                      ? { recipientId: response.recipientId }
                      : {}),
                    selfPlay: { beat: selfPlay.beat },
                  },
                }),
              ),
            ],
            outbox: [
              {
                messageId: `${context.turnId}:delivery`,
                topic: "record.events.committed",
                dedupeKey: `${context.turnId}:delivery:v1`,
                payload: {
                  recordId: context.command.recordId,
                  eventIds: [
                    ...context.candidate.body.actionTransactions.map(
                      (_transaction, index) => toolEventId(context.turnId, index),
                    ),
                    ...(context.candidate.body.narration
                      ? [selfPlayNarrationEventId]
                      : []),
                    ...context.candidate.body.characterResponses.map(
                      (_response, index) => `${context.turnId}:character:${index + 1}`,
                    ),
                  ],
                },
              },
            ],
          };
        }
        const playerEventId = `${context.turnId}:player`;
        const narrationEventId = `${context.turnId}:narration`;
        const consequence = context.candidate.body.narration?.narrativeConsequence;
        let narrativeState: RecordNarrativeState | null = null;
        if (consequence) {
          if (context.plan.body.visibility.kind !== "public") {
            throw new FatalTurnError("NARRATIVE_AUTHORITY_REQUIRED", "Private narration cannot publish public world state.");
          }
          const previous = scope.brief.narrativeState
            ? decodeNarrativeState(JSON.parse(scope.brief.narrativeState)) : emptyNarrativeState();
          const head = await repository.loadRecordHead(scope.recordId);
          if (!head || head.version !== context.command.expectedRecordVersion) {
            throw new FatalTurnError("NARRATIVE_WRITE_CONFLICT", "The Record changed before consequence release.");
          }
          narrativeState = planNarrativeConsequence({
            scope, previous, expectedRevision: previous.revision, sourceEventId: narrationEventId,
            // Eventless Records use the same zero cursor as their initial head;
            // there is no negative formal-event ordinal to authorize as evidence.
            observedHead: { recordVersion: head.version, ordinal: Math.max(0, head.nextOrdinal - 1) },
            sourceRole: "narrator", turnKind: "player", timeAdvanceAuthorized: false,
            committedEventIds: [...new Set(previous.situations.flatMap(item =>
              [item.originEventId, item.lastEventId, ...item.basisEventIds]))],
            proposal: consequence,
          });
        }
        const playerSegments = fallbackCompositeSemanticSegments(
          context.command.payload.text,
          "action",
        );
        return {
          formalEvents: [
            {
              eventId: playerEventId,
              kind: "utterance.committed",
              payload: {
                schemaVersion: 1,
                role: "player",
                speaker: scope.playerActor.displayName,
                participantId: scope.playerActor.participantId,
                content: context.command.payload.text,
                segments: playerSegments,
                ...(context.command.payload.profileUpdate
                  ? { profileUpdate: context.command.payload.profileUpdate }
                  : {}),
              },
            },
            ...context.candidate.body.actionTransactions.map((transaction, index) => ({
              eventId: toolEventId(context.turnId, index),
              kind: "action.transaction.committed",
              payload: {
                schemaVersion: 1 as const,
                role: "system" as const,
                speaker: "行动裁决",
                participantId: null,
                content: transaction.receipt.summary,
                segments: [
                  {
                    id: "fact-1",
                    kind: "fact" as const,
                    content: transaction.receipt.summary,
                    speechMode: "none" as const,
                  },
                ],
                actionTransaction: transaction,
              },
            })),
            ...(context.candidate.body.narration
              ? [{
                  eventId: narrationEventId,
                  kind: "narration.committed",
                  payload: {
                    schemaVersion: 1 as const,
                    role: "narrator" as const,
                    speaker: context.candidate.body.narration.speaker,
                    participantId: null,
                    content: context.candidate.body.narration.content,
                    segments: context.candidate.body.narration.segments,
                    ...(narrativeState ? { narrativeState, narrativeConsequence: consequence! } : {}),
                    ...(context.candidate.body.narration.suggestions?.length
                      ? { suggestions: context.candidate.body.narration.suggestions }
                      : {}),
                  },
                }]
              : []),
            ...context.candidate.body.characterResponses.map((response, index) => ({
              eventId: `${context.turnId}:character:${index + 1}`,
              kind: "utterance.committed",
              payload: {
                schemaVersion: 1 as const,
                role: "character" as const,
                speaker: response.speaker,
                participantId: response.participantId,
                content: response.content,
                segments: response.segments,
                ...(response.recipientId
                  ? { recipientId: response.recipientId }
                  : {}),
              },
            })),
          ],
          outbox: [
            {
              messageId: `${context.turnId}:delivery`,
              topic: "record.events.committed",
              dedupeKey: `${context.turnId}:delivery:v1`,
              payload: {
                recordId: context.command.recordId,
                eventIds: [
                  playerEventId,
                  ...context.candidate.body.actionTransactions.map(
                    (_transaction, index) => toolEventId(context.turnId, index),
                  ),
                  ...(context.candidate.body.narration ? [narrationEventId] : []),
                  ...context.candidate.body.characterResponses.map(
                    (_response, index) => `${context.turnId}:character:${index + 1}`,
                  ),
                ],
              },
            },
          ],
        };
      },
    },
    clock: () => clock().toISOString(),
    idFactory,
  };
}

function toolEventId(turnId: string, index: number): string {
  return `${turnId}:tool:${index + 1}`;
}

/**
 * 批次 T4：选择解析目录化——提交授权与回合规划都以「当前能力目录
 * 实时投影」为准；静态名单已退役。查无该能力 → INVALID_ACTION_SELECTION。
 */
async function resolvePlayerAction(
  catalog: ActionAffordanceCatalog,
  scope: RecordRuntimeScope,
  turnId: string,
  playerText: string,
  selection: ActionSelection,
): Promise<{ actor: RuntimeActor; call: ActorToolCall }> {
  const affordances = await listAuthorizedAffordances(catalog, scope);
  const affordance = affordances.find((item) => item.id === selection.affordanceId);
  if (!affordance) {
    throw new LocalRecordServiceError(
      "INVALID_ACTION_SELECTION",
      "The selected action is no longer available in this Scene.",
    );
  }
  const callId = `${turnId}:${scope.playerActor.characterInstanceId}:${affordance.kind}:player`;
  const parsed = parseAffordanceId(affordance);
  let call: ActorToolCall;
  if (affordance.kind === "skill") {
    call = {
      callId,
      name: "use_skill",
      arguments: {
        skillId: parsed.key,
        targetId: parsed.targetId,
        intent: playerText,
      },
    };
  } else if (affordance.kind === "asset") {
    call = {
      callId,
      name: "use_asset",
      arguments: {
        assetId: parsed.key,
        targetId: null,
        intent: playerText,
      },
    };
  } else if (affordance.kind === "stance") {
    call = {
      callId,
      name: "take_stance",
      arguments: {
        stanceId: parsed.key,
        intent: playerText,
      },
    };
  } else {
    call = {
      callId,
      name: "act",
      arguments: {
        intent: playerText,
        targetId: "scene_surroundings",
        approach: "cautious",
      },
    };
  }
  return { actor: scope.playerActor, call };
}

/**
 * 能力 id 反解：skill.<skill_key>[.<defaultTargetId>] / asset.<asset_key> /
 * stance.<effect_key> / scene.<scene_action>。
 */
function parseAffordanceId(affordance: ActionAffordance): {
  key: string;
  targetId: string | null;
} {
  const [prefix, ...rest] = affordance.id.split(".");
  const remainder = rest.join(".");
  if (affordance.kind === "skill") {
    const [skillKey, ...targetParts] = remainder.split(".");
    return {
      key: skillKey ?? remainder,
      targetId: targetParts.length > 0 ? targetParts.join(".") : null,
    };
  }
  void prefix;
  return { key: remainder, targetId: null };
}
