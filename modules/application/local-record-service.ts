import type { RecordProjection, ProjectionEvent } from "./legacy-record-projection-types.ts";
import { createHash } from "node:crypto";
import {
  POSTGRES_DEMO_IDS,
  createLocalPostgresPool,
  createPostgresAccountRepository,
  createPostgresDeliveryProjectionRepository,
  createPostgresCharacterMemoryRepository,
  createPostgresActionAffordanceCatalog,
  createPostgresCharacterSkillProvider,
  createPostgresRulePack,
  createPostgresRuntimeRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresSceneCrystallizationStore,
  createPostgresSceneImageStore,
  createPostgresSceneImageQueue,
  type PlayerDeliveryScope,
  type PostgresDeliveryProjectionRepository,
  type PostgresFormalEventMappingContext,
  type PostgresFormalEventWrite,
  type PostgresVisibilityPolicyWrite,
  type RecordRuntimeScope,
  type RecordRuntimeScopeRepository,
  type RuntimeActor,
  type SceneCrystallizationStore,
  type SceneImageQueue,
  type SceneImageStore,
} from "../../database/postgres/public.ts";
import {
  RuntimeIdempotencyConflictError,
  RuntimeInvariantError,
  RetryableTurnError,
  executeTurn,
  retryTurn,
  FatalTurnError,
  type RuntimeCommand,
  type RuntimeRepository,
  type TurnRuntimeDependencies,
  type TurnRun,
} from "../runtime/public.ts";
import {
  createTurnControl,
  type TurnControl,
} from "../runtime/turn-control.ts";
import {
  createSceneImageAutoTrigger,
  deltaChangesScene,
  type SceneImageAutoTrigger,
} from "./scene-image-trigger.ts";
import {
  fallbackCompositeSemanticSegments,
  semanticPresentation,
  type SemanticSegment,
} from "../presentation/semantic-segments.ts";
import {
  createLocalM2TurnOrchestrator,
  createModelDynamicDiscoveryGenerator,
  createModelPoweredM2TurnOrchestrator,
  createModelPresenceAssessor,
  createModelVisibilityAssessor,
  createRuleBasedDMController,
  type ActivatedCharacter,
  type M2TurnCandidate,
  type M2TurnOrchestrator,
  type M2TurnPlan,
  type M2TurnValidation,
  type SemanticOutputDraft,
  type TurnVisibilityAssessment,
  type TurnVisibilityPlan,
} from "../orchestration/public.ts";
import {
  createRuleBasedInterjectionPolicy,
  type InterjectionPolicy,
} from "../orchestration/interjection.ts";
import {
  PRESENCE_HARD_CAP_PER_TURN,
  PRESENCE_MAX_PER_TURN,
  extractPresenceContext,
  filterPresenceCandidates,
  presenceContextIsEmpty,
  presenceTriggerText,
  type PresenceAssessor,
  type PresenceTriggerKind,
} from "../orchestration/presence.ts";
import {
  createPreviewSession,
  type PreviewSession,
} from "../streaming/preview-session.ts";
import {
  createDeterministicActionResolver,
  type ActionAffordance,
  type ActionAffordanceCatalog,
  type ActionSelection,
  type ActionTransaction,
  type ActorToolCall,
} from "../actions/public.ts";
import { getModelSettingsService } from "./model-settings-service.ts";
import { getFirstNightRuntime } from "./first-night-runtime.ts";
import { createPostgresSelfPlayStore } from "../../database/postgres/self-play-store.ts";
import { createPostgresWorldKnowledgeRepository } from "../../database/postgres/world-knowledge-repository.ts";
import { createWorldKnowledgeService } from "../world-knowledge/public.ts";
import {
  isSelfPlayTerminal,
  SELF_PLAY_BEAT_BUDGET,
  SELF_PLAY_STALE_MS,
  selfPlayInstruction,
  selfPlaySessionNeedsBeats,
  type SelfPlaySession,
  type SelfPlayStore,
} from "./self-play.ts";
import {
  createCharacterMemoryService,
  formatMemoryPrefetchLines,
  type CharacterMemoryService,
} from "../memory/public.ts";
import {
  createMemorySyncScheduler,
  createMemoryPrefetchHub,
  type MemoryPrefetchHandle,
} from "../memory/pipeline.ts";
import {
  buildCrystallizationClaimDrafts,
  createSceneCrystallizer,
  crystallizationWorldEntityId,
  type GrowthDialogueLine,
  type GrowthParticipant,
  type SceneExtraction,
  type SceneCrystallizer,
  type SceneStateSnapshot,
} from "./scene-crystallization.ts";
import type { WorldKnowledgeService } from "../world-knowledge/public.ts";
import {
  createPostgresCharacterGrowthStore,
  type CharacterGrowthStore,
} from "../../database/postgres/character-growth-store.ts";
import {
  extractExplicitCharacterProfileUpdate,
  type CharacterProfileUpdate,
} from "./character-profile.ts";

const WRITE_TOKEN_TTL_MS = 15 * 60 * 1_000;
const VISIBILITY_PROPOSAL_TTL_MS = 5 * 60 * 1_000;
const SNAPSHOT_ATTEMPTS = 3;

const LOCAL_AI_CHARACTERS = [
  {
    characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
    participantId: POSTGRES_DEMO_IDS.scoutParticipant,
    displayName: "塞娜",
    profileSummary: "谨慎的斥候。",
  },
  {
    characterInstanceId: POSTGRES_DEMO_IDS.scholarInstance,
    participantId: POSTGRES_DEMO_IDS.scholarParticipant,
    displayName: "弥洛",
    profileSummary: "研究旧世界文字的学者。",
  },
] as const;

const LOCAL_PLAYER_ACTOR = {
  characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
  participantId: POSTGRES_DEMO_IDS.playerParticipant,
  displayName: "洛川",
  profileSummary: "在北岸谋生的旅人。",
} as const;

function demoRecordRuntimeScope(): RecordRuntimeScope {
  return {
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    principalId: LOCAL_RECORD_SCOPE.principalId,
    worldId: POSTGRES_DEMO_IDS.world,
    worldlineId: POSTGRES_DEMO_IDS.worldline,
    storyId: POSTGRES_DEMO_IDS.story,
    recordId: LOCAL_RECORD_SCOPE.recordId,
    sceneId: POSTGRES_DEMO_IDS.scene,
    publicPolicyId: POSTGRES_DEMO_IDS.publicPolicy,
    calendarId: "truce_calendar",
    displayTime: "停战纪元17年 · 雾月12日 · 入夜",
    style: "classical",
    language: "zh-CN",
    worldStatus: "active",
    brief: {
      worldName: "烬海诸国",
      era: "停战纪元 17 年",
      summary: "人魔停战十七年后，烬海诸国在脆弱的和平中重建。",
      storyTitle: "无声钟的来客",
      premise: "北岸灯塔在无风夜自行点亮，一封不属于任何阵营的密函被送上岸。",
      location: "灰鲸港 · 北防波堤",
      weather: "冷雾，无风",
      tension: "钟声已经响过三次",
      objective: "决定是否当众拆开密函",
      // 批次 T9：demo scope 无 canon 数据，空串保持 prompt 兼容。
      canon: "",
      worldLore: "",
    },
    playerActor: LOCAL_PLAYER_ACTOR,
    aiCharacters: LOCAL_AI_CHARACTERS,
    observerCharacterInstanceIds: [
      POSTGRES_DEMO_IDS.playerInstance,
      POSTGRES_DEMO_IDS.scoutInstance,
      POSTGRES_DEMO_IDS.scholarInstance,
    ],
    recentPublicEvents: [],
    recentPublicDialogue: [],
    recordKnowledge: [],
  };
}

const LOCAL_NON_STATEFUL_AFFORDANCES = [
  {
    id: "skill.careful_observation.letter_seal",
    kind: "skill",
    actorCharacterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
    actorName: "洛川",
    title: "细致观察",
    description: "在不拆开密函的前提下辨认蜡封边缘。",
    suggestedText: "我在不拆开密函的前提下，仔细观察蜡封边缘。",
  },
  {
    id: "scene.observe_surroundings",
    kind: "scene",
    actorCharacterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
    actorName: "洛川",
    title: "观察四周",
    description: "留意防波堤、灯塔、雾气与潮痕的变化。",
    suggestedText: "我保持谨慎，观察防波堤四周的变化。",
  },
] as const satisfies readonly ActionAffordance[];

export const LOCAL_RECORD_SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  principalId: POSTGRES_DEMO_IDS.principal,
  recordId: POSTGRES_DEMO_IDS.record,
  characterInstanceId: undefined,
} as const satisfies PlayerDeliveryScope;

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

type LocalRuntimeRepository = RuntimeRepository<
  PlayerUtterancePayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation,
  FormalEventPayload,
  OutboxPayload
>;

export interface WriteScope {
  workspaceId: string;
  recordId: string;
  principalId: string;
  characterInstanceId: string | null;
}

interface WriteTokenEntry extends WriteScope {
  canonicalVersion: number;
  expiresAt: number;
  usedByIdempotencyKey?: string;
}

export interface WriteTokenRegistry {
  issue(scope: WriteScope, canonicalVersion: number): string;
  authorize(input: {
    token: string;
    scope: WriteScope;
    canonicalVersion: number;
    idempotencyKey: string;
  }): { replay: boolean; expectedRecordVersion: number };
  bind(token: string, idempotencyKey: string): void;
}

export interface LocalRecordEnvelope {
  record: RecordProjection;
  writeToken: string;
  viewer: {
    cursor: "viewer-local";
    perspective: "omniscient" | "character";
    dynamicKnowledgeVisible: boolean;
    characterInstanceId: string | null;
    /** 批次 S：membership.role——前端渲染执笔者徽标与姿态开关。 */
    membershipRole: "owner" | "player" | "observer";
  };
  affordances: readonly ActionAffordance[];
  /** 回合后的下一步对话提案；从最新可见 Narration 事件持久化读取。 */
  suggestions?: readonly string[];
  /**
   * 批次 T1：世界初夜状态。旧世界无状态行 → null（前端行为零变化）；
   * pending 期间前端轻量轮询，ready/degraded 后呈现初夜事件。
   * openingSuggestions：初夜开场提案（composer 回合提案为空时的补位）。
   */
  firstNight?: {
    state: "pending" | "ready" | "degraded";
    hookContent: string;
    openingSuggestions: string[];
  } | null;
  /**
   * 批次 T7：世界自演会话状态。无会话行 → null（完全向后兼容）；
   * running/stopping 期间前端轻量轮询信封刷新状态（T1 轮询先例）。
   */
  selfPlay?: {
    state: "running" | "stopping" | "completed" | "failed" | "cancelled";
    beatBudget: number;
    beatsCompleted: number;
    lastError: string | null;
  } | null;
  /**
   * 场景建立图（Stage 3）：当前 Record 最新 ready 场景背景；无图 → null
   * （完全向后兼容）。fileUrl 恒为服务端生成的 /api/files/<id> 相对路径，
   * 绝不携带 provider 远端 URL/路径。
   */
  sceneImage?: {
    fileId: string;
    fileUrl: string;
    status: "ready";
  } | null;
  /**
   * 场景图自动请求状态（0050 队列最新行的安全摘要：queued/running/ready/
   * failed + triggerKind）；不透出 prompt_id/provider 路径/body/key。
   * 无请求 → null（完全向后兼容）。
   */
  sceneImageJob?: {
    status: "queued" | "running" | "ready" | "failed";
    triggerKind: "scene_change" | "every_turn";
  } | null;
}

export interface SubmitLocalMessageInput {
  recordId: string;
  content: string;
  idempotencyKey: string;
  writeToken: string;
  actionSelection?: ActionSelection;
  visibilityConfirmation?: LocalVisibilityConfirmation;
  /** 请求级身份；缺省回落本地单用户 principal。 */
  principalId?: string;
}

export type LocalVisibilityConfirmation = {
  proposalId: string;
  decision: "public" | "restricted";
};

export interface LocalVisibilityProposal {
  proposalId: string;
  kind: "restricted";
  audienceCharacterInstanceIds: readonly string[];
  audienceNames: readonly string[];
  reason: string;
}

export interface SubmitLocalMessageResult extends LocalRecordEnvelope {
  disposition: "committed" | "duplicate";
}

/**
 * 批次 S：默认入口解析结果。无「最近打开」记忆（或记忆已失效）时
 * 返回 onboarding 信号，由前端渲染创世引导屏，而不是硬编码演示记录。
 */
export type OpenDefaultRecordResult =
  | { kind: "record"; envelope: LocalRecordEnvelope }
  | { kind: "onboarding" };

export interface LocalRecordService {
  loadRecord(recordId?: string, principalId?: string): Promise<LocalRecordEnvelope>;
  /**
   * Preview/cancel 授权：Record scope + world membership + viewer 可见性
   * 的只读窄检查——无副作用（不写 account last-opened、不签发 writeToken、
   * 不订阅、不返回 envelope）。未知 Record / 非成员 / 无 viewer projection
   * 统一 NOT_FOUND（安全 404，不泄漏存在性）；runtime 未初始化保持
   * LOCAL_RUNTIME_NOT_INITIALIZED（503 形态）。
   */
  authorizeRecordViewer(recordId: string, principalId?: string): Promise<void>;
  /**
   * 批次 S：打开账号「上次打开的记录」；无记忆或记忆失效时返回
   * onboarding 信号（不抛错、不落演示记录）。
   */
  openDefaultRecord(principalId?: string): Promise<OpenDefaultRecordResult>;
  submitMessage(input: SubmitLocalMessageInput): Promise<SubmitLocalMessageResult>;
  listCommittedEvents(
    recordId: string,
    afterOrdinal: number,
    principalId?: string,
  ): Promise<readonly ProjectionEvent[]>;
  /** M4：打断进行中的回合；返回是否找到对应回合。 */
  cancelMessage(recordId: string, idempotencyKey: string): boolean;
  /**
   * 批次 T7：开始一次世界自演（bounded budget 的自治拍循环）。
   * 幂等：活动会话在 → 返回现状不重复起拍。无 membership/记录不存在 → 404 形态。
   */
  startSelfPlay(recordId: string, principalId?: string): Promise<SelfPlaySession>;
  /** 批次 T7：请求停止自演（幂等；在途拍跑完，拍边界收束 cancelled）。 */
  stopSelfPlay(
    recordId: string,
    principalId?: string,
  ): Promise<SelfPlaySession | null>;
  /** M4：订阅某 Record 的流式 Preview 事件（内存广播，不持久化）。 */
  subscribePreviews(
    recordId: string,
    listener: (event: LocalPreviewEvent) => void,
  ): () => void;
}

export type LocalPreviewEvent =
  | { kind: "chunk"; previewId: string; speaker: string; content: string }
  | { kind: "end"; previewId: string; outcome: "committed" | "aborted" };

export interface LocalPreviewHub {
  begin(recordId: string, previewId: string, signal?: AbortSignal): void;
  publishChunk(recordId: string, speaker: string, content: string): void;
  end(recordId: string, outcome: "committed" | "aborted"): void;
  subscribe(
    recordId: string,
    listener: (event: LocalPreviewEvent) => void,
  ): () => void;
}

/**
 * In-memory preview广播枢纽。每个 Record 同一时间只有一个活动 Preview
 * 会话；会话由 PreviewSession 状态机守护：aborted 会话不再接受 chunk，
 * 其部分内容不可读取、不可提交。
 */
export function createLocalPreviewHub(): LocalPreviewHub {
  const listeners = new Map<string, Set<(event: LocalPreviewEvent) => void>>();
  const sessions = new Map<string, PreviewSession>();

  function emit(recordId: string, event: LocalPreviewEvent) {
    for (const listener of listeners.get(recordId) ?? []) listener(event);
  }

  return {
    begin(recordId, previewId, signal) {
      sessions.set(recordId, createPreviewSession({ id: previewId, signal }));
    },
    publishChunk(recordId, speaker, content) {
      const session = sessions.get(recordId);
      if (!session || session.state !== "streaming" || !content) return;
      session.push(content);
      emit(recordId, {
        kind: "chunk",
        previewId: session.id,
        speaker,
        content,
      });
    },
    end(recordId, outcome) {
      const session = sessions.get(recordId);
      if (!session) return;
      sessions.delete(recordId);
      // Batch 2D：已 aborted 的会话绝不因迟到的 success cleanup 发出
      // committed end；partial 已被会话状态机清空且不可读取。
      const effectiveOutcome = session.state === "aborted" ? "aborted" : outcome;
      if (session.state === "streaming") {
        if (effectiveOutcome === "committed") session.complete();
        else session.abort(effectiveOutcome);
      }
      emit(recordId, { kind: "end", previewId: session.id, outcome: effectiveOutcome });
    },
    subscribe(recordId, listener) {
      const set = listeners.get(recordId) ?? new Set();
      set.add(listener);
      listeners.set(recordId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(recordId);
      };
    },
  };
}

export type LocalTurnFailureDiagnostic = {
  stage: "visibility" | "planning" | "drafting" | "validating" | "releasing";
  code: string;
  message: string;
  disposition: "retryable" | "failed";
  attempt?: number;
};

export class LocalRecordServiceError extends Error {
  readonly code:
    | "NOT_FOUND"
    | "LOCAL_RUNTIME_NOT_INITIALIZED"
    | "INVALID_WRITE_TOKEN"
    | "WRITE_CONFLICT"
    | "IDEMPOTENCY_CONFLICT"
    | "INVALID_ACTION_SELECTION"
    | "VISIBILITY_CONFIRMATION_REQUIRED"
    | "INVALID_VISIBILITY_CONFIRMATION"
    | "WORLD_ARCHIVED"
    | "TURN_FAILED";
  readonly currentVersion?: number;
  readonly visibilityProposal?: LocalVisibilityProposal;
  readonly diagnostic?: LocalTurnFailureDiagnostic;

  constructor(
    code:
      | "NOT_FOUND"
      | "LOCAL_RUNTIME_NOT_INITIALIZED"
      | "INVALID_WRITE_TOKEN"
      | "WRITE_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_ACTION_SELECTION"
      | "VISIBILITY_CONFIRMATION_REQUIRED"
      | "INVALID_VISIBILITY_CONFIRMATION"
      | "WORLD_ARCHIVED"
      | "TURN_FAILED",
    message: string,
    currentVersion?: number,
    visibilityProposal?: LocalVisibilityProposal,
    diagnostic?: LocalTurnFailureDiagnostic,
  ) {
    super(message);
    this.name = "LocalRecordServiceError";
    this.code = code;
    this.currentVersion = currentVersion;
    this.visibilityProposal = visibilityProposal;
    this.diagnostic = diagnostic;
  }
}

export interface LocalVisibilityAssessor {
  assess(input: {
    playerText: string;
  }): Promise<TurnVisibilityAssessment>;
}

interface VisibilityProposalEntry extends WriteScope {
  canonicalVersion: number;
  content: string;
  expiresAt: number;
  assessment: Extract<TurnVisibilityPlan, { kind: "restricted" }>;
  reason: string;
  usedByIdempotencyKey?: string;
}

export interface VisibilityProposalRegistry {
  issue(input: {
    scope: WriteScope;
    canonicalVersion: number;
    content: string;
    assessment: TurnVisibilityAssessment;
    audienceNames?: readonly string[];
  }): LocalVisibilityProposal;
  authorize(input: {
    proposalId: string;
    scope: WriteScope;
    canonicalVersion: number;
    content: string;
    idempotencyKey: string;
  }): VisibilityProposalEntry;
  bind(proposalId: string, idempotencyKey: string): void;
}

/** 批次 S：账号级「最近打开」记忆仓储（accounts.last_world_id/last_record_id）。 */
export interface AccountMemoryStore {
  findLastOpened(
    workspaceId: string,
    principalId: string,
  ): Promise<{ worldId: string; recordId: string } | null>;
  saveLastOpened(
    workspaceId: string,
    principalId: string,
    worldId: string,
    recordId: string,
  ): Promise<void>;
}

export interface LocalRecordServiceDependencies {
  repository: LocalRuntimeRepository;
  projection: PostgresDeliveryProjectionRepository;
  tokens?: WriteTokenRegistry;
  visibilityProposals?: VisibilityProposalRegistry;
  clock?: () => Date;
  idFactory?: () => string;
  orchestrator?: M2TurnOrchestrator;
  orchestratorFactory?: (scope: RecordRuntimeScope) => M2TurnOrchestrator;
  runtimeScopeProvider?: RecordRuntimeScopeRepository;
  actionCatalog?: ActionAffordanceCatalog;
  visibilityAssessor?: LocalVisibilityAssessor;
  visibilityAssessorFactory?: (
    scope: RecordRuntimeScope,
  ) => LocalVisibilityAssessor;
  turnControl?: TurnControl;
  interjectionPolicy?: InterjectionPolicy;
  previewHub?: LocalPreviewHub;
  /** 设定结晶：提取/裁决器与写回仓储；缺省不启用（既有测试零变化）。 */
  sceneCrystallizer?: SceneCrystallizer;
  sceneCrystallizationStore?: SceneCrystallizationStore;
  /** 批次 S：账号级世界记忆；缺省不启用（内存测试零变化）。 */
  accountMemory?: AccountMemoryStore;
  /**
   * 批次 T1：初夜状态读取与调度；缺省不启用（内存测试零变化）。
   * load 返回 null 表示旧世界无状态行；pending 时触发一次懒重试调度。
   */
  firstNight?: {
    load(
      recordId: string,
    ): Promise<
      | {
          state: "pending" | "ready" | "degraded";
          hookContent: string;
          suggestions: readonly string[];
        }
      | null
    >;
    schedule?: (recordId: string) => void;
  };
  /**
   * 批次 T2 sync_turn：回合提交完成后异步萃取 observations→conclusions。
   * schedule 为 fire-and-forget（单飞按 workspace+record 去重），失败只留
   * 日志，绝不影响回合提交与响应；缺省不启用（内存测试零变化）。
   */
  memorySync?: {
    schedule(scope: {
      workspaceId: string;
      worldId: string;
      worldlineId: string;
      recordId: string;
    }): void;
    idle(): Promise<void>;
  };
  /**
   * 批次 T2 prefetch：回合开始时并行发起各在场角色召回，请求体组装时同步
   * 消费已就绪结果；pending/failed/无会话 fail-closed 返回 ""（不阻塞模型
   * 调用、不抛错）；缺省不启用（内存测试零变化）。
   */
  memoryPrefetch?: {
    begin(input: {
      recordId: string;
      workspaceId: string;
      worldId: string;
      worldlineId: string;
      playerText: string;
      characters: readonly { characterInstanceId: string }[];
    }): MemoryPrefetchHandle;
    consume(recordId: string, characterInstanceId: string): string;
    end(handle: MemoryPrefetchHandle): void;
  };
  /**
   * 场景建立图（Stage 3）：最新 ready 背景读取；缺省不启用（既有测试
   * 零变化），读取失败 fail-closed 为 null（绝不影响信封主路径）。
   */
  sceneImageStore?: Pick<SceneImageStore, "findLatestReady">;
  /** 自动模式请求状态（0050 队列最新行）；缺省不启用（内存测试零变化）。 */
  sceneImageQueue?: Pick<SceneImageQueue, "findLatestForRecord">;
  /**
   * 场景图自动模式（0049/0050）：玩家回合/场景变化后的幂等入队触发器；
   * 缺省不启用（内存测试零变化）。
   */
  sceneImageAuto?: SceneImageAutoTrigger;
  /**
   * 批次 T3 在场：回合后在场门禁；缺省不启用（内存测试零变化）。
   * factory 与单实例二选一，factory 优先（可携带 scope 的 brief/style）。
   */
  presenceAssessor?: PresenceAssessor;
  presenceAssessorFactory?: (scope: RecordRuntimeScope) => PresenceAssessor;
  /** 批次 T3：每回合在场发声预算；缺省 1，硬上限 2（可降不可升）。 */
  presenceBudget?: number;
  /**
   * 批次 T3：关系视图读取与关系落库（消费 T2 既有接口）；缺省不启用。
   * 读取失败按空注入（F5），写入失败只留日志（F8）。
   */
  characterMemory?: Pick<CharacterMemoryService, "relationships" | "recordRelationship">;
  /**
   * 批次 T7：世界自演会话账本；缺省不启用（内存测试零变化——
   * startSelfPlay 在未装配时抛 LOCAL_RUNTIME_NOT_INITIALIZED）。
   */
  selfPlayStore?: SelfPlayStore;
  /** 批次 T7：每次 start 的自演拍数预算；缺省 3，硬上限 5（可降不可升）。 */
  selfPlayBeatBudget?: number;
  /**
   * 批次 T9：晶化入图谱（世界知识服务）；缺省不启用（内存测试零变化）。
   * 入图是晶化落库后的独立 best-effort 步骤：失败只留日志，不回滚晶化。
   */
  worldKnowledge?: Pick<
    WorldKnowledgeService,
    | "upsertEntity"
    | "appendClaim"
    | "appendClaims"
    | "appendClaimsIdempotent"
    | "appendDialogueGrowth"
  >;
  /**
   * 对话 growth：人物 profile note 追加/合并进当前 Record 的
   * character_instances.state.profileNotes（绝不覆盖定义与显式自述）；
   * 缺省不启用（内存测试零变化）。
   */
  characterGrowth?: CharacterGrowthStore;
}

export function createMemoryWriteTokenRegistry(options: {
  clock?: () => Date;
  randomToken?: () => string;
  ttlMs?: number;
} = {}): WriteTokenRegistry {
  const entries = new Map<string, WriteTokenEntry>();
  const clock = options.clock ?? (() => new Date());
  const randomToken = options.randomToken ?? (() => crypto.randomUUID());
  const ttlMs = options.ttlMs ?? WRITE_TOKEN_TTL_MS;

  function prune(now: number): void {
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(token);
    }
  }

  return {
    issue(scope, canonicalVersion) {
      const now = clock().getTime();
      prune(now);
      const token = randomToken();
      entries.set(token, {
        ...scope,
        canonicalVersion,
        expiresAt: now + ttlMs,
      });
      return token;
    },

    authorize({ token, scope, canonicalVersion, idempotencyKey }) {
      const now = clock().getTime();
      prune(now);
      const entry = entries.get(token);
      if (!entry || !sameWriteScope(entry, scope)) {
        throw new LocalRecordServiceError(
          "INVALID_WRITE_TOKEN",
          "The write authorization is missing or expired. Reload the Record and retry.",
        );
      }
      const replay = entry.usedByIdempotencyKey === idempotencyKey;
      if (
        (entry.usedByIdempotencyKey !== undefined && !replay)
        || (!replay && entry.canonicalVersion !== canonicalVersion)
      ) {
        throw new LocalRecordServiceError(
          "WRITE_CONFLICT",
          "The Record changed after this view was loaded.",
        );
      }
      return { replay, expectedRecordVersion: entry.canonicalVersion };
    },
    bind(token, idempotencyKey) {
      const now = clock().getTime();
      prune(now);
      const entry = entries.get(token);
      if (!entry) {
        throw new LocalRecordServiceError(
          "INVALID_WRITE_TOKEN",
          "The write authorization is missing or expired. Reload the Record and retry.",
        );
      }
      if (
        entry.usedByIdempotencyKey !== undefined
        && entry.usedByIdempotencyKey !== idempotencyKey
      ) {
        throw new LocalRecordServiceError(
          "WRITE_CONFLICT",
          "The write authorization was already used by another Command.",
        );
      }
      entry.usedByIdempotencyKey ??= idempotencyKey;
    },
  };
}

export function createMemoryVisibilityProposalRegistry(options: {
  clock?: () => Date;
  randomToken?: () => string;
  ttlMs?: number;
} = {}): VisibilityProposalRegistry {
  const entries = new Map<string, VisibilityProposalEntry>();
  const clock = options.clock ?? (() => new Date());
  const randomToken = options.randomToken ?? (() => crypto.randomUUID());
  const ttlMs = options.ttlMs ?? VISIBILITY_PROPOSAL_TTL_MS;

  function prune(now: number): void {
    for (const [proposalId, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(proposalId);
    }
  }

  return {
    issue({ scope, canonicalVersion, content, assessment, audienceNames: proposedNames }) {
      if (assessment.visibility.kind !== "restricted") {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "Only a restricted visibility assessment can be confirmed.",
        );
      }
      const now = clock().getTime();
      prune(now);
      const proposalId = randomToken();
      entries.set(proposalId, {
        ...scope,
        canonicalVersion,
        content,
        expiresAt: now + ttlMs,
        assessment: assessment.visibility,
        reason: assessment.reason,
      });
      return {
        proposalId,
        kind: "restricted",
        audienceCharacterInstanceIds: assessment.visibility.audienceCharacterInstanceIds,
        audienceNames: proposedNames
          ?? audienceNames(assessment.visibility.audienceCharacterInstanceIds),
        reason: assessment.reason,
      };
    },

    authorize({ proposalId, scope, canonicalVersion, content, idempotencyKey }) {
      const now = clock().getTime();
      prune(now);
      const entry = entries.get(proposalId);
      if (
        !entry
        || !sameWriteScope(entry, scope)
        || entry.canonicalVersion !== canonicalVersion
        || entry.content !== content
      ) {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "The visibility confirmation is missing, expired, or no longer matches this draft.",
        );
      }
      if (
        entry.usedByIdempotencyKey !== undefined
        && entry.usedByIdempotencyKey !== idempotencyKey
      ) {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "The visibility confirmation was already used by another Command.",
        );
      }
      return entry;
    },

    bind(proposalId, idempotencyKey) {
      const now = clock().getTime();
      prune(now);
      const entry = entries.get(proposalId);
      if (!entry) {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "The visibility confirmation is missing or expired.",
        );
      }
      if (
        entry.usedByIdempotencyKey !== undefined
        && entry.usedByIdempotencyKey !== idempotencyKey
      ) {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "The visibility confirmation was already used by another Command.",
        );
      }
      entry.usedByIdempotencyKey ??= idempotencyKey;
    },
  };
}

export function createLocalRecordService(
  dependencies: LocalRecordServiceDependencies,
): LocalRecordService {
  const clock = dependencies.clock ?? (() => new Date());
  const tokens = dependencies.tokens ?? createMemoryWriteTokenRegistry({ clock });
  const visibilityProposals = dependencies.visibilityProposals
    ?? createMemoryVisibilityProposalRegistry({ clock });
  const orchestratorForRuntime = dependencies.orchestratorFactory
    ? (scope: RecordRuntimeScope) => dependencies.orchestratorFactory!(scope)
    : dependencies.orchestrator;
  const turnControl = dependencies.turnControl ?? createTurnControl({});
  const interjectionPolicy = dependencies.interjectionPolicy
    ?? createRuleBasedInterjectionPolicy({ turnControl });
  // 批次 T3：在场门禁解析；未装配 → 在场整体禁用（既有测试零变化）。
  const presenceAssessorFor: ((scope: RecordRuntimeScope) => PresenceAssessor) | null =
    dependencies.presenceAssessorFactory
      ? (scope) => dependencies.presenceAssessorFactory!(scope)
      : dependencies.presenceAssessor
        ? () => dependencies.presenceAssessor!
        : null;
  const previewHub = dependencies.previewHub ?? createLocalPreviewHub();
  const turnSignals = new Map<string, AbortController>();
  // 批次 T7：自演单飞守卫（进程内按 recordId 去重；DB 部分唯一索引兜底）。
  const selfPlayInFlight = new Set<string>();
  const actionCatalog = dependencies.actionCatalog ?? {
    async listAuthorized() {
      return LOCAL_NON_STATEFUL_AFFORDANCES.map((item) => ({ ...item }));
    },
  } satisfies ActionAffordanceCatalog;
  const runtimeDependencies = createLocalTurnDependencies(
    dependencies.repository,
    clock,
    dependencies.idFactory,
    orchestratorForRuntime,
    turnSignals,
    actionCatalog,
  );

  async function scheduleInterjection(input: {
    recordId: string;
    playerText: string;
    activatedCharacters: readonly ActivatedCharacter[];
    runtimeScope: RecordRuntimeScope;
    /** 发起回合的 principal；快照加载按真实 membership 解析。 */
    principalId?: string;
  }): Promise<void> {
    try {
      const decision = interjectionPolicy.evaluate({
        recordId: input.recordId,
        playerText: input.playerText,
        activatedCharacters: input.activatedCharacters,
        availableCharacters: input.runtimeScope.aiCharacters,
      });
      if (decision.kind !== "interject") return;
      // 批次 T2 prefetch：插话回合的 react 同样消费召回——回合开始即并行
      // 发起，与租约获取/快照加载/模型调用重叠。
      const interjectionPrefetch = dependencies.memoryPrefetch
        ? dependencies.memoryPrefetch.begin({
            recordId: input.recordId,
            workspaceId: input.runtimeScope.workspaceId,
            worldId: input.runtimeScope.worldId,
            worldlineId: input.runtimeScope.worldlineId,
            playerText: input.playerText,
            characters: input.runtimeScope.aiCharacters,
          })
        : null;
      try {
        const lease = await turnControl.acquire(
          input.recordId,
          decision.character.characterInstanceId,
        );
        try {
          const before = await loadConsistentSnapshot(dependencies, input.recordId, input.principalId);
          const key = `interjection-${dependencies.idFactory?.() ?? crypto.randomUUID()}`;
          const controller = new AbortController();
          turnSignals.set(key, controller);
          // Batch 2D：独立 controller 的 signal 贯通插话模型链；
          // 其取消与玩家回合互不影响。
          const interjectionDependencies = { ...runtimeDependencies, signal: controller.signal };
          try {
            let run = await executeTurn(
              {
                commandType: "player.utterance",
                recordId: input.recordId,
                expectedRecordVersion: before.canonicalVersion,
                idempotencyKey: key,
                actorId: decision.character.participantId,
                payload: {
                  text: input.playerText,
                  visibility: { kind: "public" as const },
                  runtimeScope: input.runtimeScope,
                  interjection: {
                    characterInstanceId: decision.character.characterInstanceId,
                    triggerText: input.playerText,
                  },
                },
              },
              interjectionDependencies,
            );
            if (run.state === "retryable") {
              run = await retryTurn(run.turnId, interjectionDependencies);
            }
            if (run.state !== "completed") {
              console.warn(
                `[realm] interjection turn ${run.turnId} did not complete: ${run.currentFailure?.code ?? "unknown"}`,
              );
              return;
            }
            turnControl.recordInterjection(decision.character.characterInstanceId);
            // 批次 T2 sync_turn：插话回合同样写 observations，提交后触发萃取。
            dependencies.memorySync?.schedule({
              workspaceId: input.runtimeScope.workspaceId,
              worldId: input.runtimeScope.worldId,
              worldlineId: input.runtimeScope.worldlineId,
              recordId: input.recordId,
            });
          } finally {
            turnSignals.delete(key);
          }
        } finally {
          lease.release();
        }
      } finally {
        if (interjectionPrefetch) {
          dependencies.memoryPrefetch?.end(interjectionPrefetch);
        }
      }
    } catch (error) {
      // 自动插话永远不得影响玩家回合；失败只留本机日志。
      console.warn(
        `[realm] interjection skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 批次 T3 角色在场（docs/development/T3-CHARACTER-PRESENCE.md §2.1）：
   * public 回合提交后，确定性抽取触发素材 → 候选过滤 → 模型门禁 →
   * 若裁决发声则取发言租约执行 presence 回合。任何失败只留日志，
   * 绝不影响玩家回合（F9）。
   */
  async function schedulePresence(input: {
    recordId: string;
    playerText: string;
    runtimeScope: RecordRuntimeScope;
    /** 发起回合的 principal；快照加载按真实 membership 解析。 */
    principalId?: string;
    committed: {
      narration: SemanticOutputDraft | null;
      characterResponses: readonly SemanticOutputDraft[];
      actionTransactions: readonly ActionTransaction[];
      activatedCharacters: readonly ActivatedCharacter[];
    };
    prefetchedMemories: ReadonlyMap<string, string>;
  }): Promise<void> {
    try {
      if (!presenceAssessorFor) return; // 未装配 → 在场禁用（内存测试零变化）
      const budget = Math.min(
        Math.max(dependencies.presenceBudget ?? PRESENCE_MAX_PER_TURN, 0),
        PRESENCE_HARD_CAP_PER_TURN,
      );
      if (budget < 1) return;
      // 钩子素材只取 ready/degraded 初夜状态；load 失败按空 fail-closed（F2）。
      let hookContent: string | null = null;
      if (dependencies.firstNight) {
        try {
          const firstNight = await dependencies.firstNight.load(input.recordId);
          if (firstNight && firstNight.state !== "pending") {
            hookContent = firstNight.hookContent;
          }
        } catch {
          hookContent = null;
        }
      }
      const context = extractPresenceContext({
        narration: input.committed.narration,
        characterResponses: input.committed.characterResponses,
        actionTransactions: input.committed.actionTransactions,
        hookContent,
      });
      // 三类素材全空 → 确定性沉默，不发起模型门禁调用。
      if (presenceContextIsEmpty(context)) return;
      // 候选排除：本回合被 DM 激活或已发声的角色不重复在场；冷却复用 TurnControl。
      const excluded = new Set<string>([
        ...input.committed.activatedCharacters.map(
          (character) => character.characterInstanceId,
        ),
        ...input.committed.characterResponses
          .map((response) => response.characterInstanceId)
          .filter((characterInstanceId): characterInstanceId is string =>
            characterInstanceId !== null),
      ]);
      const candidates = filterPresenceCandidates({
        characters: input.runtimeScope.aiCharacters,
        excludedCharacterInstanceIds: excluded,
        turnControl,
      });
      if (candidates.length === 0) return;
      const decision = await presenceAssessorFor(input.runtimeScope).assess({
        context,
        candidates,
        budget,
      });
      if (decision.kind !== "speak") return;
      const character = candidates.find(
        (candidate) => candidate.characterInstanceId === decision.characterInstanceId,
      );
      // 双保险：确定性规整已拦截越候选选人（F4）。
      if (!character) return;
      const lease = await turnControl.acquire(
        input.recordId,
        character.characterInstanceId,
      );
      try {
        const before = await loadConsistentSnapshot(dependencies, input.recordId, input.principalId);
        // 关系视图读取失败 → 按空注入（F5）。
        let relationships = "";
        if (dependencies.characterMemory) {
          try {
            relationships = await dependencies.characterMemory.relationships({
              workspaceId: input.runtimeScope.workspaceId,
              worldId: input.runtimeScope.worldId,
              worldlineId: input.runtimeScope.worldlineId,
              recordId: input.recordId,
              characterInstanceId: character.characterInstanceId,
            });
          } catch {
            relationships = "";
          }
        }
        const buildPresenceCommand = (
          expectedRecordVersion: number,
          idempotencyKey: string,
        ): RuntimeCommand<PlayerUtterancePayload> => ({
          commandType: "player.utterance",
          recordId: input.recordId,
          expectedRecordVersion,
          idempotencyKey,
          actorId: character.participantId,
          payload: {
            text: input.playerText,
            visibility: { kind: "public" as const },
            runtimeScope: input.runtimeScope,
            presence: {
              characterInstanceId: character.characterInstanceId,
              triggerKind: decision.triggerKind,
              triggerText: presenceTriggerText(context, decision.triggerKind),
              memories:
                input.prefetchedMemories.get(character.characterInstanceId) ?? "",
              relationships,
            },
          },
        });
        let activeKey = `presence-${dependencies.idFactory?.() ?? crypto.randomUUID()}`;
        const presenceController = new AbortController();
        turnSignals.set(activeKey, presenceController);
        // Batch 2D：独立 controller 的 signal 贯通 presence 模型链；
        // 其取消与玩家回合互不影响。
        const presenceDependencies = { ...runtimeDependencies, signal: presenceController.signal };
        try {
          let run = await executeTurn(
            buildPresenceCommand(before.canonicalVersion, activeKey),
            presenceDependencies,
          );
          if (run.state === "retryable") {
            run = await retryTurn(run.turnId, presenceDependencies);
          }
          // 批次 T3：生成期间若有异步落库（场景晶化、初夜补录等）推进版本，
          // 重读最新快照重试一次；重试仍冲突则维持 fail-closed 沉默（F9）。
          if (
            run.state !== "completed"
            && run.currentFailure?.code === "RECORD_VERSION_CONFLICT"
          ) {
            console.warn(
              `[realm] presence turn ${run.turnId} hit version conflict; retrying on fresh snapshot`,
            );
            turnSignals.delete(activeKey);
            const refreshed = await loadConsistentSnapshot(
              dependencies,
              input.recordId,
              input.principalId,
            );
            activeKey = `presence-${dependencies.idFactory?.() ?? crypto.randomUUID()}`;
            const retryController = new AbortController();
            turnSignals.set(activeKey, retryController);
            const retryDependencies = { ...runtimeDependencies, signal: retryController.signal };
            run = await executeTurn(
              buildPresenceCommand(refreshed.canonicalVersion, activeKey),
              retryDependencies,
            );
            if (run.state === "retryable") {
              run = await retryTurn(run.turnId, retryDependencies);
            }
          }
          if (run.state !== "completed") {
            console.warn(
              `[realm] presence turn ${run.turnId} did not complete: ${
                run.currentFailure?.code ?? "unknown"
              }`,
            );
            return;
          }
          turnControl.recordInterjection(character.characterInstanceId);
          // 批次 T2 sync_turn：在场回合同样写 observations，提交后再触发萃取。
          dependencies.memorySync?.schedule({
            workspaceId: input.runtimeScope.workspaceId,
            worldId: input.runtimeScope.worldId,
            worldlineId: input.runtimeScope.worldlineId,
            recordId: input.recordId,
          });
          // 关系落库（F8）：target 须精确匹配在场名册；写入失败只留日志。
          await recordPresenceRelationship({
            run,
            character,
            runtimeScope: input.runtimeScope,
            recordId: input.recordId,
          });
        } finally {
          turnSignals.delete(activeKey);
        }
      } finally {
        lease.release();
      }
    } catch (error) {
      // 自主在场永远不得影响玩家回合；失败只留本机日志（F9）。
      console.warn(
        `[realm] presence skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 批次 T3 关系落库：presence 回合附带且 target 匹配名册才走 recordRelationship。 */
  async function recordPresenceRelationship(input: {
    run: LocalTurnRun;
    character: ActivatedCharacter;
    runtimeScope: RecordRuntimeScope;
    recordId: string;
  }): Promise<void> {
    const memory = dependencies.characterMemory;
    if (!memory) return;
    const relationship = input.run.candidate?.body.characterResponses.find(
      (response) =>
        response.characterInstanceId === input.character.characterInstanceId,
    )?.relationship;
    if (!relationship) return;
    const knownNames = new Set([
      input.runtimeScope.playerActor.displayName,
      ...input.runtimeScope.aiCharacters.map((actor) => actor.displayName),
    ]);
    if (!knownNames.has(relationship.target)) return;
    try {
      await memory.recordRelationship({
        workspaceId: input.runtimeScope.workspaceId,
        worldId: input.runtimeScope.worldId,
        worldlineId: input.runtimeScope.worldlineId,
        recordId: input.recordId,
        characterInstanceId: input.character.characterInstanceId,
        targetKey: relationship.target,
        content: relationship.note,
      });
    } catch (error) {
      console.warn(
        `[realm] presence relationship record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * growth 实体/claim 的确定性身份（重复调度幂等的依据；不加盐）。
   * 实体 ID 纳入 worldlineId：world_entities 主键是 (workspace_id, id)，
   * 跨 worldline 同名实体必须各自独立，避免 claim subject FK 错配。
   */
  function growthEntityId(
    worldId: string,
    worldlineId: string,
    entityName: string,
  ): string {
    const digest = createHash("sha256")
      .update(`${worldId}|${worldlineId}|${entityName.trim().toLowerCase()}`)
      .digest("hex")
      .slice(0, 18);
    return `entity_growth_${digest}`;
  }

  function growthClaimId(
    recordId: string,
    entityId: string,
    predicate: string,
    value: string,
  ): string {
    const digest = createHash("sha256")
      .update(`${recordId}|${entityId}|${predicate}|${value}`)
      .digest("hex")
      .slice(0, 18);
    return `claim_growth_${digest}`;
  }

  /**
   * 自演拍 growth 的来源事件：只从真实已提交事件中选——优先旁白，
   * 其次最后一个事件，空则 null（无旁白的自演拍不产生悬空来源）。
   */
  function selfPlaySourceEventId(run: LocalTurnRun): string | null {
    const eventIds = run.release?.eventIds ?? [];
    return eventIds.find((id) => id.endsWith(":narration"))
      ?? eventIds.at(-1)
      ?? null;
  }

  /**
   * 玩家回合 growth 的来源事件：只从真实已提交 release 的 eventIds 选择。
   * 有旁白优先旁白，其次玩家事件，最后才退回 release 列表末项；release
   * 为空返回 null，绝不拼接猜测的 `${turnId}:...`。
   */
  function playerSourceEventId(run: LocalTurnRun): string | null {
    const eventIds = run.release?.eventIds ?? [];
    return (run.candidate?.body.narration
      ? eventIds.find((id) => id.endsWith(":narration"))
      : undefined)
      ?? eventIds.find((id) => id.endsWith(":player"))
      ?? eventIds.at(-1)
      ?? null;
  }

  /**
   * 对话 growth 落库（best-effort）：世界知识 entity/claim（record 级
   * record_confirmed，确定性身份 + 幂等）与人物 profile note（追加/合并，
   * 不覆盖既有设定）。Batch 4A：entity/claim 的 valid_from_tick 由 repo
   * 在写事务内用已验证的来源 Event（sourceEventId）派生——缺失/跨 scope
   * 一律 fail-closed 零写入，绝不回退 0、绝不自动升级 story/world canon。
   * 任何失败只留日志，绝不阻断或污染已提交回合。
   */
  async function applyDialogueGrowth(input: {
    extraction: SceneExtraction;
    runtimeScope: RecordRuntimeScope;
    recordId: string;
    sourceEventId: string | null;
  }): Promise<void> {
    const knowledgeScope = {
      workspaceId: input.runtimeScope.workspaceId,
      worldId: input.runtimeScope.worldId,
      worldlineId: input.runtimeScope.worldlineId,
    };
    const knowledge = dependencies.worldKnowledge;
    if (knowledge && input.extraction.worldClaims.length > 0) {
      try {
        // fail-closed：无真实来源事件（self-play 空 release 等异常路径）
        // 不做世界 growth——宁可缺一条知识，不可写假时序。
        if (!input.sourceEventId) {
          console.warn(
            "[realm] dialogue world growth skipped: no committed source event",
          );
        } else {
          const entities = [];
          const claims = [];
          for (const draft of input.extraction.worldClaims) {
            const entityId = growthEntityId(
              knowledgeScope.worldId,
              knowledgeScope.worldlineId,
              draft.entity,
            );
            // 实体按名称确定性生成/复用（upsert 幂等）；valid_from 由 repo
            // 按来源 Event 派生并统一盖章（entity 与 claim 同一 cursor）。
            entities.push({
              id: entityId,
              entityKind: draft.entityKind,
              name: draft.entity,
              summary: "",
            });
            claims.push({
              id: growthClaimId(input.recordId, entityId, draft.predicate, draft.value),
              subjectEntityId: entityId,
              predicate: draft.predicate,
              objectValue: draft.value,
              scope: "record" as const,
              truthStatus: "record_confirmed" as const,
              confidence: 1,
              supersedesClaimId: null,
            });
          }
          const written = await knowledge.appendDialogueGrowth(knowledgeScope, {
            recordId: input.recordId,
            sourceEventId: input.sourceEventId,
            entities,
            claims,
          });
          if (!written) {
            console.warn(
              "[realm] dialogue world growth skipped: source event not found in scope",
            );
          }
        }
      } catch (error) {
        console.warn(
          `[realm] dialogue world growth skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const growth = dependencies.characterGrowth;
    if (growth && input.extraction.characterNotes.length > 0) {
      try {
        // Batch 4B：profile note 与世界 growth 同一 fail-closed 边界——
        // 无真实来源事件不写无来源 note；store 在写事务内校验完整 scope
        // 并用 DB 侧 cursor/时间戳盖章，跨 scope/不可解析返回 false 零写入。
        if (!input.sourceEventId) {
          console.warn(
            "[realm] dialogue profile growth skipped: no committed source event",
          );
        } else {
          const notesWritten = await growth.appendProfileNotes(
            { ...knowledgeScope, recordId: input.recordId },
            input.extraction.characterNotes.map((note) => ({
              characterInstanceId: note.characterInstanceId,
              note: note.note,
            })),
            { sourceEventId: input.sourceEventId },
          );
          if (!notesWritten) {
            console.warn(
              "[realm] dialogue profile growth skipped: source event not found in scope",
            );
          }
        }
      } catch (error) {
        console.warn(
          `[realm] dialogue profile growth skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** 晶化调度输入：在途 run 与 pending 共用同一形状。 */
  type SceneCrystallizationScheduleInput = {
    recordId: string;
    playerText: string;
    runtimeScope: RecordRuntimeScope;
    principalId?: string;
    /** 回合可见性：restricted/private 回合不做公共 growth（场景结晶照旧）。 */
    visibility?: TurnVisibilityPlan;
    /** growth claim 的来源事件 id（审计追踪；本回合已提交事件）。 */
    sourceEventId?: string;
  };

  // Batch 3D：per-record 晶化单飞（参照 memorySync 的
  // inFlight + pending + finally re-arm）：同一 (workspaceId, recordId)
  // 已有在途晶化时不并发重跑，只保留最新一个 pending 输入，当前 run
  // 结束（成功/返回 null/抛错）后恰好 re-arm 一次；不同 Record 互不
  // 阻塞。进程内守卫，不改任何 SQL/事务边界，也不新增模型调用。
  const crystallizationInFlight = new Set<string>();
  const crystallizationPending = new Map<
    string,
    { input: SceneCrystallizationScheduleInput; generation: number }
  >();
  // P0（stale-generation write suppression）：每个 public schedule 递增
  // 该 key 的 generation——在途 run 随之失效（stale）。stale run 的模型
  // 调用允许完成（本批不取消 provider），但所有写入点（growth /
  // adjudicate / recordRejection / applyDelta / graph inflow）在写入前
  // fail-closed 静默返回；re-arm 只跑最新 generation。token 仅作进程内
  // 写入资格，绝不进入 prompt/请求/观测/数据库。
  const crystallizationGenerations = new Map<string, number>();

  function scheduleSceneCrystallization(
    input: SceneCrystallizationScheduleInput,
  ): void {
    if (!dependencies.sceneCrystallizer) return;
    // 私密边界（入队前）：restricted/private 回合的玩家原文与授权素材绝不
    // 进入提取器——场景写回是公共面、growth 是公共面，同一次提取无法做到
    // 只见公开素材；最小不泄漏实现是整个管线在读取 recent events / 进入
    // flight/pending 之前结构性跳过。public/self-play 路径不变。
    if ((input.visibility?.kind ?? "public") !== "public") return;
    const key = `${input.runtimeScope.workspaceId}:${input.recordId}`;
    // 新的 public schedule 使当前 generation 失效；pending 只保留最新
    // input+generation（覆盖旧 pending），不改写在途 run 已捕获的 input。
    const generation = (crystallizationGenerations.get(key) ?? 0) + 1;
    crystallizationGenerations.set(key, generation);
    if (crystallizationInFlight.has(key)) {
      crystallizationPending.set(key, { input, generation });
      return;
    }
    startCrystallizationRun(key, input, generation);
  }

  function startCrystallizationRun(
    key: string,
    input: SceneCrystallizationScheduleInput,
    generation: number,
  ): void {
    crystallizationInFlight.add(key);
    // re-arm 沿用 pending 保存的 generation（不重新分配 token）。
    const isCurrentGeneration = () =>
      crystallizationGenerations.get(key) === generation;
    void runSceneCrystallization(input, isCurrentGeneration)
      .catch((error: unknown) => {
        // run 内部已全量 catch；此处仅防御 unhandled rejection。
        console.warn(
          `[realm] scene crystallization skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        // 只释放自己这次 flight；若已有更新 schedule（generation 更大），
        // 其 pending 在本 finally 恰好启动一次，状态不被旧 finally 清除。
        crystallizationInFlight.delete(key);
        const next = crystallizationPending.get(key);
        crystallizationPending.delete(key);
        if (next) {
          startCrystallizationRun(key, next.input, next.generation);
        } else if (isCurrentGeneration()) {
          // map 有界：无 pending 且自己仍是最新时清理 token。
          crystallizationGenerations.delete(key);
        }
      });
  }

  /**
   * 设定结晶（docs/development/SCENE-CRYSTALLIZATION.md）：
   * 回合成功后异步提取场景增量并经逻辑一致性裁决后才写回；
   * 任一环节失败都只留日志，绝不中断或污染玩家回合。
   * 同一次结构化提取还带出 bounded 的世界知识/人物设定 growth
   * （仅公共回合落库，record 级 record_confirmed，幂等）。
   * re-arm 重新进入本函数：bounded recent read / current / delta / verdict
   * 全部按最新上下文重建，不复用旧 run 的任何中间结果。
   * P0：`isCurrentGeneration` 是本次 run 的写入资格——任一写点（growth /
   * adjudicate / recordRejection / applyDelta / graph inflow）前发现已
   * stale 即 fail-closed 静默返回；不回滚 stale 之前已完成的写入。
   */
  async function runSceneCrystallization(
    input: SceneCrystallizationScheduleInput,
    isCurrentGeneration: () => boolean,
  ): Promise<void> {
    const crystallizer = dependencies.sceneCrystallizer;
    if (!crystallizer) return;
    try {
      // Clean-up Phase 2：晶化不再为拿最近几条摘要重读完整投影（META+CAST+
      // EVENTS 全量+navigation）。当前场景状态来自本回合已解析的 runtimeScope
      // （晶化前场景不会被本回合改变——场景只由晶化自身推进）；最近事件走
      // 授权瘦读（同一授权 WHERE，DESC LIMIT 有界）。
      const brief = input.runtimeScope.brief;
      const recentEvents = await dependencies.projection.loadRecentAuthorizedEvents(
        {
          workspaceId: input.runtimeScope.workspaceId,
          recordId: input.recordId,
          principalId: input.principalId ?? LOCAL_RECORD_SCOPE.principalId,
        },
        6,
      );
      // growth 门禁：提取输入只含 public 事件——owner omniscient 视角可读
      // 的 restricted/private 素材绝不进入 growth extractor（场景状态是
      // 世界公开面，turnSummary 同步收紧为 public-only）。
      const publicEvents = recentEvents.filter(
        (event) => event.policyKind === undefined || event.policyKind === "public",
      );
      const current: SceneStateSnapshot = {
        worldName: brief.worldName,
        era: brief.era,
        displayTime: recentEvents.at(-1)?.displayTime?.trim()
          || input.runtimeScope.displayTime,
        location: brief.location,
        weather: brief.weather,
        tension: brief.tension,
        objective: brief.objective,
      };
      const turnSummary = publicEvents
        .map((event) => `${event.speaker}：${event.content}`)
        .join("\n")
        .slice(0, 1_200);
      const recentDialogue: GrowthDialogueLine[] = publicEvents
        .map((event) => ({
          speaker: event.speaker,
          speakerParticipantId: event.speakerParticipantId ?? null,
          recipientId: event.recipientId ?? null,
          text: event.content,
        }))
        .filter((line) => line.text.trim().length > 0);
      const participants: GrowthParticipant[] = [
        input.runtimeScope.playerActor,
        ...input.runtimeScope.aiCharacters,
      ].map((actor) => ({
        characterInstanceId: actor.characterInstanceId,
        participantId: actor.participantId,
        displayName: actor.displayName,
        profileSummary: actor.profileSummary ?? "",
      }));
      const extraction = await crystallizer.extract({
        playerText: input.playerText,
        // Batch 2C：结构化 recentDialogue 是 extraction 的 canonical 事件
        // 表示；turnSummary 只留给 adjudication/rejection（非重复注入）。
        current,
        recentDialogue,
        participants,
      });
      if (!extraction) return;
      // P0 写点守护①：growth（world knowledge entity/claim + profile
      // notes）写入前——stale 即静默返回，绝不写过期知识。
      if (!isCurrentGeneration()) return;
      // growth：本函数已在提取前对非公共回合结构性跳过，这里恒为公共回合；
      // 失败只 warn，绝不阻断已提交回合。
      await applyDialogueGrowth({
        extraction,
        runtimeScope: input.runtimeScope,
        recordId: input.recordId,
        sourceEventId: input.sourceEventId ?? null,
      });
      const delta = extraction.delta;
      if (!delta) return;
      const store = dependencies.sceneCrystallizationStore;
      if (!store) return;
      // P0 写点守护②：adjudicate 调用前——stale 不再浪费第二个模型逻辑调用。
      if (!isCurrentGeneration()) return;
      const verdict = await crystallizer.adjudicate({
        playerText: input.playerText,
        turnSummary,
        current,
        delta,
      });
      if (!verdict) return;
      if (!verdict.approved) {
        // P0 写点守护③：recordRejection 前。
        if (!isCurrentGeneration()) return;
        await store.recordRejection({
          workspaceId: input.runtimeScope.workspaceId,
          model: verdict.model,
          playerText: input.playerText,
          turnSummary,
          delta,
          reason: verdict.reason,
        });
        return;
      }
      // P0 写点守护④：applyDelta 前。
      if (!isCurrentGeneration()) return;
      const finalDelta = verdict.adjusted ?? delta;
      const written = await store.applyDelta(
        {
          workspaceId: input.runtimeScope.workspaceId,
          worldId: input.runtimeScope.worldId,
          worldlineId: input.runtimeScope.worldlineId,
          recordId: input.recordId,
          calendarId: input.runtimeScope.calendarId,
          publicPolicyId: input.runtimeScope.publicPolicyId,
          style: input.runtimeScope.style,
        },
        finalDelta,
      );
      // P0 写点守护⑤：graph inflow（applyDelta 后的实体/claims 写入）前——
      // stale 不得继续扩大写面。
      if (!isCurrentGeneration()) return;
      // 场景图自动模式（scene_change，0049/0050）：晶化真正写出且 delta 含
      // 场景字段才入队（source = 晶化事件 id，幂等证据）；拒绝/无场景变化/
      // 失败不触发。self-play 产生的新场景按同一规则触发（方案 §2）。
      if (deltaChangesScene(finalDelta)) {
        void dependencies.sceneImageAuto?.afterSceneChange({
          runtimeScope: input.runtimeScope,
          sceneId: written.sceneId,
          principalId: input.principalId ?? input.runtimeScope.principalId,
          sourceEventId: written.eventId,
        });
      }
      // 批次 T9 晶化入图谱（缺陷 #14 产生侧）：晶化主事务成功后的独立
      // best-effort 步骤——世界本体实体 upsert 幂等 + 白名单谓词 Claim
      // （record 级 record_confirmed，来源=结晶事件）；任何失败只留日志，
      // 不回滚晶化、不阻断回合（规范 F2/F5）。
      const knowledge = dependencies.worldKnowledge;
      if (knowledge) {
        try {
          const drafts = buildCrystallizationClaimDrafts(finalDelta);
          if (drafts.length > 0) {
            const knowledgeScope = {
              workspaceId: input.runtimeScope.workspaceId,
              worldId: input.runtimeScope.worldId,
              worldlineId: input.runtimeScope.worldlineId,
            };
            await knowledge.upsertEntity(knowledgeScope, {
              id: crystallizationWorldEntityId(input.runtimeScope.worldId),
              entityKind: "setting",
              name: brief.worldName,
              summary: "",
              validFromTick: written.tick,
              validToTick: null,
            });
            // Clean-up Phase 2：同源 claim 单事务批量（原逐 claim 独立事务
            // N+1）；批内失败整批回滚并由外层 catch 记录（best-effort 语义
            // 不变：不回滚晶化、不阻断回合）。
            await knowledge.appendClaims(
              knowledgeScope,
              drafts.map((draft) => ({
                id: `claim_${(dependencies.idFactory?.() ?? crypto.randomUUID()).replaceAll("-", "").slice(0, 18)}`,
                subjectEntityId: crystallizationWorldEntityId(
                  input.runtimeScope.worldId,
                ),
                predicate: draft.predicate,
                objectValue: draft.objectValue,
                scope: "record",
                truthStatus: "record_confirmed",
                confidence: 1,
                validFromTick: written.tick,
                validToTick: null,
                sourceRecordId: input.recordId,
                sourceEventId: written.eventId,
                supersedesClaimId: null,
              })),
            );
          }
        } catch (inflowError) {
          console.warn(
            `[realm] crystallization graph inflow skipped: ${
              inflowError instanceof Error
                ? inflowError.message
                : String(inflowError)
            }`,
          );
        }
      }
    } catch (error) {
      console.warn(
        `[realm] scene crystallization skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 批次 T7：自演会话拍循环（fire-and-forget）。每拍是一次完整 executeTurn
   * 自治回合（payload.selfPlay），拍边界重读会话行判定 stopping/预算；
   * 版本冲突重读快照重试一次（T3 模式）；任何失败落 failed 只留日志，
   * 绝不阻塞页面与玩家回合（规范失败矩阵 F2–F9）。
   */
  async function runSelfPlaySession(input: {
    sessionId: string;
    recordId: string;
    runtimeScope: RecordRuntimeScope;
    principalId?: string;
  }): Promise<void> {
    const store = dependencies.selfPlayStore;
    if (!store) return;
    try {
      for (;;) {
        const session = await store.load(input.sessionId);
        if (!session || isSelfPlayTerminal(session.state)) return;
        if (session.state === "stopping") {
          await store.finish(input.sessionId, "cancelled");
          return;
        }
        if (!selfPlaySessionNeedsBeats(session)) {
          await store.finish(input.sessionId, "completed");
          return;
        }
        const beat = session.beatsCompleted + 1;
        // 与玩家回合/插话/在场互斥：同一 Record 只有一个写者（FIFO 租约）。
        const lease = await turnControl.acquire(
          input.recordId,
          `self-play:${input.sessionId}`,
        );
        try {
          const before = await loadConsistentSnapshot(
            dependencies,
            input.recordId,
            input.principalId,
          );
          const instruction = selfPlayInstruction(
            input.runtimeScope.brief.language
              ?? before.projection.world.language
              ?? "zh-CN",
          );
          const buildSelfPlayCommand = (
            expectedRecordVersion: number,
            idempotencyKey: string,
          ): RuntimeCommand<PlayerUtterancePayload> => ({
            commandType: "player.utterance",
            recordId: input.recordId,
            expectedRecordVersion,
            idempotencyKey,
            actorId: input.runtimeScope.playerActor.participantId,
            payload: {
              text: instruction,
              visibility: { kind: "public" as const },
              runtimeScope: input.runtimeScope,
              selfPlay: { beat, instruction },
            },
          });
          let activeKey = `selfplay-${input.sessionId}-${beat}`;
          const selfPlayController = new AbortController();
          turnSignals.set(activeKey, selfPlayController);
          // Batch 2D：独立 controller 的 signal 贯通 self-play 模型链。
          const selfPlayDependencies = { ...runtimeDependencies, signal: selfPlayController.signal };
          let run: LocalTurnRun;
          try {
            run = await executeTurn(
              buildSelfPlayCommand(before.canonicalVersion, activeKey),
              selfPlayDependencies,
            );
            if (run.state === "retryable") {
              run = await retryTurn(run.turnId, selfPlayDependencies);
            }
            // T3 模式：生成期间异步写者（场景晶化/初夜补录/玩家回合）推进
            // 版本 → 重读最新快照重试一次；再撞则本拍失败（F5）。
            if (
              run.state !== "completed"
              && run.currentFailure?.code === "RECORD_VERSION_CONFLICT"
            ) {
              console.warn(
                `[realm] self-play turn ${run.turnId} hit version conflict; retrying on fresh snapshot`,
              );
              turnSignals.delete(activeKey);
              const refreshed = await loadConsistentSnapshot(
                dependencies,
                input.recordId,
                input.principalId,
              );
              activeKey = `selfplay-${input.sessionId}-${beat}-retry`;
              const retryController = new AbortController();
              turnSignals.set(activeKey, retryController);
              const retryDependencies = { ...runtimeDependencies, signal: retryController.signal };
              run = await executeTurn(
                buildSelfPlayCommand(refreshed.canonicalVersion, activeKey),
                retryDependencies,
              );
              if (run.state === "retryable") {
                run = await retryTurn(run.turnId, retryDependencies);
              }
            }
          } finally {
            turnSignals.delete(activeKey);
          }
          if (run.state !== "completed") {
            const code = run.currentFailure?.code ?? "TURN_FAILED";
            console.warn(
              `[realm] self-play beat ${beat} of session ${input.sessionId} did not complete: ${code}`,
            );
            await store.finish(input.sessionId, "failed", code);
            return;
          }
          // 拍落账（仅 running 行可被 +1；中途 stop 的行留待拍边界收束）。
          await store.completeBeat(input.sessionId);
          // 与玩家回合后同型：sync_turn 萃取 + 场景晶化（均 fire-and-forget）。
          dependencies.memorySync?.schedule({
            workspaceId: input.runtimeScope.workspaceId,
            worldId: input.runtimeScope.worldId,
            worldlineId: input.runtimeScope.worldlineId,
            recordId: input.recordId,
          });
          void scheduleSceneCrystallization({
            recordId: input.recordId,
            playerText: instruction,
            runtimeScope: input.runtimeScope,
            principalId: input.principalId,
            // 自演拍是公开自治回合（无玩家私密输入），允许公共 growth。
            visibility: { kind: "public" },
            sourceEventId: selfPlaySourceEventId(run) ?? undefined,
          });
        } finally {
          lease.release();
        }
      }
    } catch (error) {
      // 调度器任何未捕获异常：日志收场，会话尽力落 failed（F9）。
      console.warn(
        `[realm] self-play session ${input.sessionId} aborted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      try {
        await store.finish(input.sessionId, "failed", "SELFPLAY_ABORTED");
      } catch {
        // 账本不可写时不再扩散失败。
      }
    } finally {
      selfPlayInFlight.delete(input.recordId);
    }
  }

  /** 批次 T7：自演调度入口——单飞守卫去重，重复触发不重入。 */
  function scheduleSelfPlay(input: {
    sessionId: string;
    recordId: string;
    runtimeScope: RecordRuntimeScope;
    principalId?: string;
  }): void {
    if (selfPlayInFlight.has(input.recordId)) return;
    selfPlayInFlight.add(input.recordId);
    void runSelfPlaySession(input);
  }

  return {
    async loadRecord(recordId = LOCAL_RECORD_SCOPE.recordId, principalId) {
      const envelope = await loadConsistentEnvelope(
        dependencies,
        tokens,
        actionCatalog,
        recordId,
        principalId,
      );
      await rememberLastOpened(
        dependencies,
        principalId ?? LOCAL_RECORD_SCOPE.principalId,
        envelope.record.world.id,
        envelope.record.record.id,
      );
      return envelope;
    },

    async authorizeRecordViewer(recordId, principalId) {
      // 与读取路径同源的三步窄授权（只读，零副作用）：
      // ① Record scope——未知 Record / 无可用席位 → NOT_FOUND（404）；
      await resolveRuntimeScope(dependencies, recordId, principalId);
      // ② world membership + viewer 可见性——与 delivery META 同一道
      //    membership JOIN/归档过滤（META-only，不扫描 EVENTS）；
      //    非成员 / 无 viewer projection 返回 false → 安全 404（与未知
      //    Record 同形，不泄漏存在性）。
      const authorized = await dependencies.projection.hasViewerProjection({
        ...LOCAL_RECORD_SCOPE,
        recordId,
        principalId: principalId ?? LOCAL_RECORD_SCOPE.principalId,
      });
      if (!authorized) {
        throw new LocalRecordServiceError("NOT_FOUND", "Record not found.");
      }
      // ③ runtime 未初始化（record head 缺失）保持既有 503 形态。
      const head = await dependencies.repository.loadRecordHead(recordId);
      if (!head) throw notInitialized();
    },

    async openDefaultRecord(principalId) {
      const identity = principalId ?? LOCAL_RECORD_SCOPE.principalId;
      const memory = dependencies.accountMemory;
      if (memory) {
        try {
          const last = await memory.findLastOpened(
            LOCAL_RECORD_SCOPE.workspaceId,
            identity,
          );
          if (last?.recordId) {
            try {
              const envelope = await loadConsistentEnvelope(
                dependencies,
                tokens,
                actionCatalog,
                last.recordId,
                identity,
              );
              await rememberLastOpened(
                dependencies,
                identity,
                envelope.record.world.id,
                envelope.record.record.id,
              );
              return { kind: "record" as const, envelope };
            } catch (error) {
              // 记忆指向的记录已不可打开（被删/装配不全）：视为无记忆。
              console.warn(
                `[realm] last-opened record ${last.recordId} could not be opened: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
          }
        } catch (error) {
          console.warn(
            `[realm] account memory read failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      return { kind: "onboarding" as const };
    },

    async submitMessage(input) {
      const before = await loadConsistentSnapshot(
        dependencies,
        input.recordId,
        input.principalId,
      );
      const runtimeScope = await resolveRuntimeScope(
        dependencies,
        input.recordId,
        input.principalId,
      );
      const profileUpdate = extractExplicitCharacterProfileUpdate(
        input.content,
        runtimeScope.playerActor,
      );
      // 批次 T8：归档世界只读——回合提交 fail-closed（读取/投影不受影响）。
      if (runtimeScope.worldStatus === "archived") {
        throw new LocalRecordServiceError(
          "WORLD_ARCHIVED",
          "The world is archived and read-only.",
        );
      }
      let authorization: ReturnType<WriteTokenRegistry["authorize"]>;
      try {
        authorization = tokens.authorize({
          token: input.writeToken,
          scope: writeScope(
            input.recordId,
            before.viewer.characterInstanceId,
            input.principalId,
          ),
          canonicalVersion: before.canonicalVersion,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        if (
          error instanceof LocalRecordServiceError
          && error.code === "WRITE_CONFLICT"
        ) {
          throw new LocalRecordServiceError(
            "WRITE_CONFLICT",
            error.message,
            before.projection.version,
          );
        }
        throw error;
      }

      if (input.actionSelection && !authorization.replay) {
        const available = await listAuthorizedAffordances(
          actionCatalog,
          runtimeScope,
        );
        if (!available.some((item) =>
          item.id === input.actionSelection!.affordanceId
          && item.actorCharacterInstanceId === runtimeScope.playerActor.characterInstanceId
        )) {
          throw new LocalRecordServiceError(
            "INVALID_ACTION_SELECTION",
            "The selected action is no longer available in this Scene.",
          );
        }
      }
      const scope = writeScope(
        input.recordId,
        before.viewer.characterInstanceId,
        input.principalId,
      );
      // 批次 T2 prefetch：回合开始并行发起各在场角色召回，与可见性裁决/DM
      // 规划等模型调用重叠；replay 回合没有模型调用，不预取。
      const prefetchHandle =
        !authorization.replay && dependencies.memoryPrefetch
          ? dependencies.memoryPrefetch.begin({
              recordId: input.recordId,
              workspaceId: runtimeScope.workspaceId,
              worldId: runtimeScope.worldId,
              worldlineId: runtimeScope.worldlineId,
              playerText: input.content,
              characters: runtimeScope.aiCharacters,
            })
          : null;
      // Batch 2D：Turn controller 在任何模型调用（prefetch/可见性裁决）之前
      // 注册，使 cancelMessage 能命中整条主链路；所有出口统一 finally 清理。
      const turnController = new AbortController();
      turnSignals.set(input.idempotencyKey, turnController);
      try {
        const visibility = authorization.replay
          ? { plan: { kind: "public" as const }, proposalId: null }
          : await resolveTurnVisibility({
              input,
              scope,
              runtimeScope,
              canonicalVersion: authorization.expectedRecordVersion,
              assessor: dependencies.visibilityAssessor,
              assessorFactory: dependencies.visibilityAssessorFactory,
              proposals: visibilityProposals,
              signal: turnController.signal,
            });
        let run: LocalTurnRun;
        previewHub.begin(input.recordId, input.idempotencyKey, turnController.signal);
        const turnDependencies = { ...runtimeDependencies, signal: turnController.signal };
        try {
          run = await executeTurn(
            {
              commandType: "player.utterance",
              recordId: input.recordId,
              expectedRecordVersion: authorization.expectedRecordVersion,
              idempotencyKey: input.idempotencyKey,
              actorId: runtimeScope.playerActor.participantId,
              payload: {
                text: input.content,
                ...(input.actionSelection
                  ? { actionSelection: input.actionSelection }
                  : {}),
                visibility: visibility.plan,
                runtimeScope,
                ...(profileUpdate ? { profileUpdate } : {}),
              },
            },
            turnDependencies,
          );
          if (run.state === "retryable") {
            run = await retryTurn(run.turnId, turnDependencies);
          }
        } catch (error) {
          previewHub.end(input.recordId, "aborted");
          turnSignals.delete(input.idempotencyKey);
          throw translateRuntimeError(error);
        }

        if (run.state !== "completed" || !run.release) {
          previewHub.end(input.recordId, "aborted");
          turnSignals.delete(input.idempotencyKey);
          if (run.currentFailure) {
            console.warn(
              `[realm] turn ${run.turnId} failed: ${run.currentFailure.code} — ${run.currentFailure.message}`,
            );
          }
          if (run.currentFailure?.code === "RECORD_VERSION_CONFLICT") {
            const current = await loadConsistentSnapshot(
              dependencies,
              input.recordId,
              input.principalId,
            );
            throw new LocalRecordServiceError(
              "WRITE_CONFLICT",
              "The Record changed before this Turn could be committed.",
              current.projection.version,
            );
          }
          if (run.currentFailure?.code === "TURN_CANCELLED") {
            throw new LocalRecordServiceError(
              "TURN_FAILED",
              "已打断本次生成，内容没有写入记录。",
            );
          }
          const diagnostic = run.currentFailure
            ? diagnosticFromRuntimeFailure(run.currentFailure)
            : undefined;
          throw new LocalRecordServiceError(
            "TURN_FAILED",
            diagnostic
              ? formatTurnFailureMessage(diagnostic)
              : "本轮没有完成，系统没有写入内容；请查看阶段诊断后重试。",
            undefined,
            undefined,
            diagnostic,
          );
        }
        previewHub.end(input.recordId, "committed");
        turnSignals.delete(input.idempotencyKey);

        tokens.bind(input.writeToken, input.idempotencyKey);
        if (visibility.proposalId) {
          visibilityProposals.bind(visibility.proposalId, input.idempotencyKey);
        }

        const envelope = await loadConsistentEnvelope(
          dependencies,
          tokens,
          actionCatalog,
          input.recordId,
          input.principalId,
          // Clean-up Phase 2：复用本回合提交前已解析的 scope（fail-closed
          // 校验已在回合开始时完成），避免二次 resolve 与 canon 重复事务。
          runtimeScope,
        );
        // 批次 T3：在 prefetch 会话结束前同步 consume 各候选角色的预取记忆
        // （fail-closed，不等待、不抛错），带入在场载荷；prefetch 生命周期不变。
        const prefetchedMemories = new Map<string, string>();
        if (prefetchHandle && dependencies.memoryPrefetch) {
          for (const character of runtimeScope.aiCharacters) {
            prefetchedMemories.set(
              character.characterInstanceId,
              dependencies.memoryPrefetch.consume(
                input.recordId,
                character.characterInstanceId,
              ),
            );
          }
        }
        if (!authorization.replay && visibility.plan.kind === "public") {
          // M4/T3：插话优先——显式点名高于自主反应。插话评估是纯同步四道门，
          // 此处先裁决再分流，保证同一回合后自治发声至多一次（预算语义）。
          const interjectionDecision = interjectionPolicy.evaluate({
            recordId: input.recordId,
            playerText: input.content,
            activatedCharacters: run.plan?.body.activatedCharacters ?? [],
            availableCharacters: runtimeScope.aiCharacters,
          });
          if (interjectionDecision.kind === "interject") {
            // M4：玩家回合成功后按四道门评估自动插话；失败只记录日志。
            void scheduleInterjection({
              recordId: input.recordId,
              playerText: input.content,
              activatedCharacters: run.plan?.body.activatedCharacters ?? [],
              runtimeScope,
              principalId: input.principalId,
            });
          } else {
            // 批次 T3：未插话 → 在场评估（fire-and-forget，失败只留日志）。
            void schedulePresence({
              recordId: input.recordId,
              playerText: input.content,
              runtimeScope,
              principalId: input.principalId,
              committed: {
                narration: run.candidate?.body.narration ?? null,
                characterResponses: run.candidate?.body.characterResponses ?? [],
                actionTransactions: run.candidate?.body.actionTransactions ?? [],
                activatedCharacters: run.plan?.body.activatedCharacters ?? [],
              },
              prefetchedMemories,
            });
          }
        }
        if (!authorization.replay) {
          // 批次 T2 sync_turn：回合提交完成后后台萃取；失败只留日志。
          dependencies.memorySync?.schedule({
            workspaceId: runtimeScope.workspaceId,
            worldId: runtimeScope.worldId,
            worldlineId: runtimeScope.worldlineId,
            recordId: input.recordId,
          });
          // 设定结晶：异步两段式管线，永不阻塞回合响应。
          void scheduleSceneCrystallization({
            recordId: input.recordId,
            playerText: input.content,
            runtimeScope,
            principalId: input.principalId,
            // growth 仅公共回合落库；来源事件供审计追踪。
            visibility: visibility.plan,
            sourceEventId: playerSourceEventId(run) ?? undefined,
          });
          // 场景图自动模式（every_turn，0049/0050）：成功 committed 非 replay
          // 玩家回合后幂等入队（source = 提交幂等键）；模式读取触发
          // principal 的账号偏好；入队失败只留日志，绝不阻塞回合。
          void dependencies.sceneImageAuto?.afterPlayerTurn({
            runtimeScope,
            principalId: input.principalId ?? runtimeScope.principalId,
            sourceEventId: input.idempotencyKey,
          });
        }
        return {
          ...envelope,
          disposition: authorization.replay ? "duplicate" : "committed",
          // 提案随本次回合产出；事件 metadata 与本次 envelope 同时提供。
          ...(!authorization.replay
            && (run.candidate?.body.narration?.suggestions?.length ?? 0) > 0
            ? { suggestions: run.candidate!.body.narration!.suggestions! }
            : {}),
        };
      } finally {
        // 回合退出（提交成功/失败/异常）一律清理预取会话。
        if (prefetchHandle) dependencies.memoryPrefetch?.end(prefetchHandle);
        // Batch 2D：早注册的 Turn controller 统一清理（幂等；presence/插话
        // 的独立 key 不受本回合影响）。
        if (turnSignals.get(input.idempotencyKey) === turnController) {
          turnSignals.delete(input.idempotencyKey);
        }
      }
    },

    cancelMessage(recordId, idempotencyKey) {
      const controller = turnSignals.get(idempotencyKey);
      if (!controller) return false;
      controller.abort();
      return true;
    },

    async startSelfPlay(recordId, principalId) {
      const store = dependencies.selfPlayStore;
      if (!store) throw notInitialized();
      // 权限链与读取路径同源：快照 + runtimeScope 解析（无 membership → 404 形态）。
      await loadConsistentSnapshot(dependencies, recordId, principalId);
      const runtimeScope = await resolveRuntimeScope(
        dependencies,
        recordId,
        principalId,
      );
      // 批次 T8：归档世界只读——不得开自演。
      if (runtimeScope.worldStatus === "archived") {
        throw new LocalRecordServiceError(
          "WORLD_ARCHIVED",
          "The world is archived and read-only.",
        );
      }
      const { session, created } = await store.start({
        sessionId: `selfplay_${(dependencies.idFactory?.() ?? crypto.randomUUID()).replaceAll("-", "").slice(0, 24)}`,
        recordId,
        worldId: runtimeScope.worldId,
        beatBudget: dependencies.selfPlayBeatBudget ?? SELF_PLAY_BEAT_BUDGET,
        requestedBy: principalId ?? LOCAL_RECORD_SCOPE.principalId,
      });
      if (created && session.state === "running") {
        scheduleSelfPlay({
          sessionId: session.id,
          recordId,
          runtimeScope,
          principalId,
        });
      }
      return session;
    },

    async stopSelfPlay(recordId, principalId) {
      const store = dependencies.selfPlayStore;
      if (!store) throw notInitialized();
      await loadConsistentSnapshot(dependencies, recordId, principalId);
      const stopped = await store.requestStop(recordId);
      // 幂等：无活动会话 → 返回最近一条（含 null）。
      return stopped ?? store.findLatest(recordId);
    },

    subscribePreviews(recordId, listener) {
      return previewHub.subscribe(recordId, listener);
    },

    async listCommittedEvents(recordId, afterOrdinal, principalId) {
      if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
        throw new LocalRecordServiceError(
          "NOT_FOUND",
          "The requested delivery cursor is invalid.",
        );
      }
      const projection = await dependencies.projection.loadForPlayer({
        ...LOCAL_RECORD_SCOPE,
        recordId,
        principalId: principalId ?? LOCAL_RECORD_SCOPE.principalId,
      });
      if (!projection) throw notInitialized();
      return projection.events.filter((event) => event.ordinal > afterOrdinal);
    },
  };
}

type LocalTurnRun = TurnRun<
  PlayerUtterancePayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation
>;

async function resolveRuntimeScope(
  dependencies: LocalRecordServiceDependencies,
  recordId: string,
  principalId?: string,
): Promise<RecordRuntimeScope> {
  if (!dependencies.runtimeScopeProvider) {
    if (recordId !== LOCAL_RECORD_SCOPE.recordId) {
      throw new LocalRecordServiceError("NOT_FOUND", "Record not found.");
    }
    return demoRecordRuntimeScope();
  }
  const scope = await dependencies.runtimeScopeProvider.resolve({
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    principalId: principalId ?? LOCAL_RECORD_SCOPE.principalId,
    recordId,
  });
  if (!scope) {
    throw new LocalRecordServiceError("NOT_FOUND", "Record not found.");
  }
  return scope;
}

async function resolveTurnVisibility(input: {
  input: SubmitLocalMessageInput;
  scope: WriteScope;
  runtimeScope: RecordRuntimeScope;
  canonicalVersion: number;
  assessor?: LocalVisibilityAssessor;
  assessorFactory?: (scope: RecordRuntimeScope) => LocalVisibilityAssessor;
  proposals: VisibilityProposalRegistry;
  /** Batch 2D：本 Turn 的取消信号（可选；取消即停可见性模型调用）。 */
  signal?: AbortSignal;
}): Promise<{
  plan: TurnVisibilityPlan;
  proposalId: string | null;
}> {
  if (input.input.visibilityConfirmation) {
    const confirmation = input.input.visibilityConfirmation;
    const proposal = input.proposals.authorize({
      proposalId: confirmation.proposalId,
      scope: input.scope,
      canonicalVersion: input.canonicalVersion,
      content: input.input.content,
      idempotencyKey: input.input.idempotencyKey,
    });
    return {
      plan: confirmation.decision === "restricted"
        ? proposal.assessment
        : { kind: "public" },
      proposalId: confirmation.proposalId,
    };
  }
  const assessor = input.assessorFactory
    ? input.assessorFactory(input.runtimeScope)
    : input.assessor;
  if (!assessor) {
    return { plan: { kind: "public" }, proposalId: null };
  }

  let assessment: TurnVisibilityAssessment;
  try {
    assessment = await assessor.assess({
      playerText: input.input.content,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    const diagnostic = diagnosticFromError(error, "visibility");
    throw new LocalRecordServiceError(
      "TURN_FAILED",
      formatTurnFailureMessage(diagnostic),
      undefined,
      undefined,
      diagnostic,
    );
  }
  if (assessment.visibility.kind === "public") {
    return { plan: assessment.visibility, proposalId: null };
  }
  const proposal = input.proposals.issue({
    scope: input.scope,
    canonicalVersion: input.canonicalVersion,
    content: input.input.content,
    assessment,
    audienceNames: runtimeActorNames(
      input.runtimeScope,
      assessment.visibility.audienceCharacterInstanceIds,
    ),
  });
  throw new LocalRecordServiceError(
    "VISIBILITY_CONFIRMATION_REQUIRED",
    "DM 判断这条内容可能只适合部分角色知道；请确认可见范围后再提交。",
    undefined,
    proposal,
  );
}

function createLocalTurnDependencies(
  repository: LocalRuntimeRepository,
  clock: () => Date,
  idFactory?: () => string,
  orchestration?: M2TurnOrchestrator | ((scope: RecordRuntimeScope) => M2TurnOrchestrator),
  turnSignals?: ReadonlyMap<string, AbortController>,
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
    if (turnSignals?.get(idempotencyKey)?.signal.aborted) {
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
            goal: `让 ${character.displayName} 对刚发生的变化自发作出一个简短反应。`,
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
            goal: `让 ${character.displayName} 对触发内容作出简短插话回应。`,
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

export function mapLocalFormalEvent(
  context: PostgresFormalEventMappingContext<
    PlayerUtterancePayload,
    M2TurnPlan,
    M2TurnCandidate,
    M2TurnValidation,
    FormalEventPayload
  >,
): PostgresFormalEventWrite {
  const payload = context.draft.payload;
  const actionTransaction = payload.actionTransaction;
  const runtimeScope = context.run.command.payload.runtimeScope
    ?? demoRecordRuntimeScope();
  const visibility = context.run.plan?.body.visibility ?? { kind: "public" as const };
  const visibilityPolicy: PostgresVisibilityPolicyWrite | undefined =
    visibility.kind === "restricted"
      ? {
          id: dynamicVisibilityPolicyId(context.run.turnId),
          policyKey: `${visibility.domainId}:${context.run.turnId}`,
          kind: "restricted",
          restrictedDomainId: visibility.domainId,
          audienceCharacterInstanceIds: visibility.audienceCharacterInstanceIds,
        }
      : undefined;
  const observers = visibility.kind === "restricted"
    ? visibility.audienceCharacterInstanceIds
    : runtimeScope.observerCharacterInstanceIds;
  return {
    sceneId: runtimeScope.sceneId,
    visibilityPolicyId: visibilityPolicy?.id ?? runtimeScope.publicPolicyId,
    ...(visibilityPolicy ? { visibilityPolicy } : {}),
    eventKind: context.draft.kind as PostgresFormalEventWrite["eventKind"],
    actorParticipantId: payload.participantId,
    speakerName: payload.speaker,
    content: payload.content,
    metadata: {
      schemaVersion: 1,
      presentation: semanticPresentation(payload.segments),
      // 对话主体标记随元数据落库（内部字段；UI 不展示；旧事件读作 null）。
      ...(payload.recipientId ? { recipientId: payload.recipientId } : {}),
      // 批次 T3：在场标记随元数据落库（不新增事件类型）。
      ...(payload.presence ? { presence: payload.presence } : {}),
      // 批次 T7：自演拍标记同型落库。
      ...(payload.selfPlay ? { selfPlay: payload.selfPlay } : {}),
      // 旁白提案作为交付 metadata 持久化，GET 投影可直接读取。
      ...(payload.suggestions?.length ? { suggestions: payload.suggestions } : {}),
      ...(actionTransaction
        ? { actionTransaction }
        : {}),
    },
    ...(actionTransaction
      ? {
          actionState: {
            receiptId: `${actionTransaction.transactionId}:receipt`,
            transactionId: actionTransaction.transactionId,
            actorCharacterInstanceId:
              actionTransaction.actor.characterInstanceId,
            callFingerprint: actionTransaction.receipt.callFingerprint,
            receipt: actionTransaction.receipt,
            costs: actionTransaction.receipt.costs,
            effects: actionTransaction.receipt.effects,
          },
        }
      : {}),
    ...(payload.role === "player" && payload.profileUpdate
      ? {
          characterStateUpdates: [{
            characterInstanceId: payload.profileUpdate.characterInstanceId,
            statePatch: {
              profileSummary: payload.profileUpdate.profileSummary,
              profileIdentity: payload.profileUpdate.identity,
              profileEvidence: payload.profileUpdate.evidence,
            },
          }],
        }
      : {}),
    observations: actionTransaction
      ? actionTransaction.receipt.privateObservations.map(
          (observation, index) => ({
            observationId: `${context.draft.eventId}:private:${index + 1}`,
            observerCharacterInstanceId: observation.characterInstanceId,
            dedupeKey: `${context.draft.eventId}:${observation.characterInstanceId}:action-receipt:v1`,
            kind: "direct" as const,
            content: observation.content,
            fidelity: 1,
            metadata: {
              channel: "action-receipt",
              transactionId: actionTransaction.transactionId,
            },
          }),
        )
      : observers.map((observerCharacterInstanceId) => ({
          observationId: `${context.draft.eventId}:observed:${observerCharacterInstanceId}`,
          observerCharacterInstanceId,
          dedupeKey: `${context.draft.eventId}:${observerCharacterInstanceId}:direct:v1`,
          kind: "direct" as const,
          content: payload.content,
          fidelity: 1,
          metadata: {
            channel: visibility.kind === "restricted"
              ? "restricted-scene"
              : "public-scene",
            sourceRole: payload.role,
          },
        })),
  };
}

function dynamicVisibilityPolicyId(turnId: string): string {
  const normalized = turnId.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `visibility_secret_${normalized.slice(-96) || "turn"}`;
}

function toolEventId(turnId: string, index: number): string {
  return `${turnId}:tool:${index + 1}`;
}

interface ConsistentSnapshot {
  projection: RecordProjection;
  viewer: LocalRecordEnvelope["viewer"];
  suggestions: readonly string[];
  canonicalVersion: number;
}

async function loadConsistentSnapshot(
  dependencies: LocalRecordServiceDependencies,
  recordId: string,
  principalId?: string,
): Promise<ConsistentSnapshot> {
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await dependencies.repository.loadRecordHead(recordId);
    if (!before) throw notInitialized();
    const delivery = await dependencies.projection.loadDeliveryForPlayer({
      ...LOCAL_RECORD_SCOPE,
      recordId,
      principalId: principalId ?? LOCAL_RECORD_SCOPE.principalId,
    });
    if (!delivery) throw notInitialized();
    const after = await dependencies.repository.loadRecordHead(recordId);
    if (!after) throw notInitialized();
    if (before.version === after.version) {
      return {
        projection: delivery.record,
        viewer: delivery.viewer,
        suggestions: delivery.suggestions ?? [],
        canonicalVersion: after.version,
      };
    }
  }
  throw new LocalRecordServiceError(
    "WRITE_CONFLICT",
    "The Record changed while its delivery view was being prepared.",
  );
}

async function loadConsistentEnvelope(
  dependencies: LocalRecordServiceDependencies,
  tokens: WriteTokenRegistry,
  actionCatalog: ActionAffordanceCatalog,
  recordId: string,
  principalId?: string,
  /**
   * Clean-up Phase 2：调用方已在本回合解析过的 scope 可复用（affordances
   * 只依赖 workspace/world/record/席位，不依赖游标），免去二次 resolve
   * （含 canon 的第二个事务）。缺省仍现场解析（GET 路径语义不变）。
   */
  preResolvedScope?: RecordRuntimeScope,
): Promise<LocalRecordEnvelope> {
  // 批次 T12-B：先解析运行时作用域——归档/不存在 Record 在此 fail-closed
  // 为 NOT_FOUND（404），而非投影空快照误导成「运行未初始化」（503）。
  const scope = preResolvedScope
    ?? await resolveRuntimeScope(dependencies, recordId, principalId);
  // Batch 3C：scope 先行（归档/不存在 fail-closed 语义不变）之后，四项读取
  // 互相无数据依赖，并行发起。提交后快照仍单独重读（writeToken 依赖新
  // canonicalVersion），不新增任何 SQL/query；firstNight 懒调度与
  // selfPlay failStale→findLatest、warn→null 语义均保持不变。
  // 场景图（Stage 3）：latest ready 背景随信封透出；缺 store（内存测试）
  // 或读取失败一律 fail-closed null，绝不影响信封主路径。
  const sceneImageStore = dependencies.sceneImageStore;
  const sceneImageQueue = dependencies.sceneImageQueue;
  const [snapshot, affordances, firstNight, selfPlay, sceneImage, sceneImageJob] = await Promise.all([
    loadConsistentSnapshot(dependencies, recordId, principalId),
    listAuthorizedAffordances(actionCatalog, scope),
    loadFirstNightState(dependencies, recordId),
    loadSelfPlayState(dependencies, recordId),
    sceneImageStore
      ? sceneImageStore
        .findLatestReady({ workspaceId: scope.workspaceId, recordId })
        .then((generation) =>
          generation?.fileId
            ? {
              fileId: generation.fileId,
              fileUrl: `/api/files/${generation.fileId}`,
              status: "ready" as const,
            }
            : null
        )
        .catch(() => null)
      : Promise.resolve(null),
    sceneImageQueue
      ? sceneImageQueue
        .findLatestForRecord({ workspaceId: scope.workspaceId, recordId })
        .then((request) =>
          request
            ? {
              status: request.status === "leased"
                ? "running" as const
                : request.status === "completed"
                  ? "ready" as const
                  : request.status,
              triggerKind: request.triggerKind,
            }
            : null
        )
        .catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    record: snapshot.projection,
    writeToken: tokens.issue(
      writeScope(recordId, snapshot.viewer.characterInstanceId, principalId),
      snapshot.canonicalVersion,
    ),
    viewer: snapshot.viewer,
    affordances,
    suggestions: snapshot.suggestions,
    firstNight,
    selfPlay,
    sceneImage,
    sceneImageJob,
  };
}

/**
 * 批次 T7：自演会话状态读取（fail-closed，读失败只告警不影响读取路径）。
 * 先懒恢复（活动行心跳超时落 failed，SELFPLAY_STALE），再读最新会话。
 */
async function loadSelfPlayState(
  dependencies: LocalRecordServiceDependencies,
  recordId: string,
): Promise<
  | {
      state: "running" | "stopping" | "completed" | "failed" | "cancelled";
      beatBudget: number;
      beatsCompleted: number;
      lastError: string | null;
    }
  | null
> {
  const store = dependencies.selfPlayStore;
  if (!store) return null;
  try {
    await store.failStale(
      recordId,
      new Date(Date.now() - SELF_PLAY_STALE_MS),
    );
    const session = await store.findLatest(recordId);
    if (!session) return null;
    return {
      state: session.state,
      beatBudget: session.beatBudget,
      beatsCompleted: session.beatsCompleted,
      lastError: session.lastError,
    };
  } catch (error) {
    console.warn(
      `[realm] self-play session read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * 批次 T1：初夜状态行读取（fail-closed，读失败只告警不影响读取路径）。
 * pending 且未在途 → 触发一次懒重试调度（进程重启等场景的自愈）。
 */
async function loadFirstNightState(
  dependencies: LocalRecordServiceDependencies,
  recordId: string,
): Promise<
  | { state: "pending" | "ready" | "degraded"; hookContent: string; openingSuggestions: string[] }
  | null
> {
  const hook = dependencies.firstNight;
  if (!hook) return null;
  try {
    const marker = await hook.load(recordId);
    if (!marker) return null;
    if (marker.state === "pending" && hook.schedule) {
      hook.schedule(recordId);
    }
    return {
      state: marker.state,
      hookContent: marker.hookContent,
      openingSuggestions: marker.suggestions
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    };
  } catch (error) {
    console.warn(
      `[realm] first night marker read failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/**
 * 批次 S：成功加载后把 (worldId, recordId) 写回账号记忆。
 * fail-closed——写失败只告警，绝不影响读取路径。
 */
async function rememberLastOpened(
  dependencies: LocalRecordServiceDependencies,
  principalId: string,
  worldId: string,
  recordId: string,
): Promise<void> {
  const memory = dependencies.accountMemory;
  if (!memory || !worldId.trim() || !recordId.trim()) return;
  try {
    await memory.saveLastOpened(
      LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      worldId,
      recordId,
    );
  } catch (error) {
    console.warn(
      `[realm] account memory write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function listAuthorizedAffordances(
  catalog: ActionAffordanceCatalog,
  scope: RecordRuntimeScope,
): Promise<readonly ActionAffordance[]> {
  // 批次 S：观察者席位没有角色实例，行动目录的非空校验不适用。
  if (!scope.playerActor.characterInstanceId.trim()) {
    return Promise.resolve([]);
  }
  return catalog.listAuthorized({
    workspaceId: scope.workspaceId,
    worldId: scope.worldId,
    worldlineId: scope.worldlineId,
    recordId: scope.recordId,
    principalId: scope.principalId,
    characterInstanceId: scope.playerActor.characterInstanceId,
  });
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

function audienceNames(characterInstanceIds: readonly string[]): readonly string[] {
  const actors = [LOCAL_PLAYER_ACTOR, ...LOCAL_AI_CHARACTERS] as const;
  return characterInstanceIds.map((id) =>
    actors.find((actor) => actor.characterInstanceId === id)?.displayName
    ?? "未知角色"
  );
}

function runtimeActorNames(
  scope: RecordRuntimeScope,
  characterInstanceIds: readonly string[],
): readonly string[] {
  const actors = [scope.playerActor, ...scope.aiCharacters];
  return characterInstanceIds.map((id) =>
    actors.find((actor) => actor.characterInstanceId === id)?.displayName
    ?? "未知角色"
  );
}

function writeScope(
  recordId: string,
  characterInstanceId: string | null,
  principalId?: string,
): WriteScope {
  return {
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    recordId,
    principalId: principalId ?? LOCAL_RECORD_SCOPE.principalId,
    characterInstanceId,
  };
}

function sameWriteScope(left: WriteScope, right: WriteScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.recordId === right.recordId
    && left.principalId === right.principalId
    && left.characterInstanceId === right.characterInstanceId;
}

function diagnosticFromRuntimeFailure(
  failure: NonNullable<LocalTurnRun["currentFailure"]>,
): LocalTurnFailureDiagnostic {
  return {
    stage: failure.stage,
    code: failure.code,
    message: failure.message,
    disposition: failure.disposition,
    attempt: failure.attempt,
  };
}

function diagnosticFromError(
  error: unknown,
  stage: LocalTurnFailureDiagnostic["stage"],
): LocalTurnFailureDiagnostic {
  if (error instanceof LocalRecordServiceError && error.diagnostic) {
    return error.diagnostic;
  }
  if (error instanceof RetryableTurnError) {
    return {
      stage,
      code: error.code,
      message: error.safeMessage,
      disposition: "retryable",
    };
  }
  if (error instanceof FatalTurnError) {
    return {
      stage,
      code: error.code,
      message: error.safeMessage,
      disposition: "failed",
    };
  }
  if (error instanceof RuntimeInvariantError) {
    return {
      stage,
      code: error.code,
      message: "运行时约束未满足；底层错误已脱敏。",
      disposition: "failed",
    };
  }
  return {
    stage,
    code: "TURN_STEP_FAILED",
    message: "该阶段没有返回可安全展示的结构化结果。",
    disposition: "failed",
  };
}

function formatTurnFailureMessage(diagnostic: LocalTurnFailureDiagnostic): string {
  const labels: Record<LocalTurnFailureDiagnostic["stage"], string> = {
    visibility: "可见性判断",
    planning: "回合规划",
    drafting: "内容生成",
    validating: "结构化验证",
    releasing: "写入提交",
  };
  const attempt = diagnostic.attempt === undefined ? "" : `，第 ${diagnostic.attempt} 次尝试`;
  return `本轮在「${labels[diagnostic.stage]}」阶段未完成${attempt}（${diagnostic.code}）：${diagnostic.message}`;
}

function notInitialized(): LocalRecordServiceError {
  return new LocalRecordServiceError(
    "LOCAL_RUNTIME_NOT_INITIALIZED",
    "The local PostgreSQL demo has not been initialized.",
  );
}

function translateRuntimeError(error: unknown): Error {
  if (error instanceof RuntimeIdempotencyConflictError) {
    return new LocalRecordServiceError(
      "IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for different content.",
    );
  }
  if (error instanceof RuntimeInvariantError) {
    if (error.code === "COMMAND_IDEMPOTENCY_CONFLICT") {
      return new LocalRecordServiceError(
        "IDEMPOTENCY_CONFLICT",
        "The idempotency key was already used for different content.",
      );
    }
    return new LocalRecordServiceError(
      "TURN_FAILED",
      "The local Turn could not be completed safely.",
    );
  }
  // Batch 2D：取消信号直达路径（retryTurn gate / provider abort 归一）——
  // 与 currentFailure 路径同一取消诊断形态。
  if (error instanceof FatalTurnError && error.code === "TURN_CANCELLED") {
    return new LocalRecordServiceError(
      "TURN_FAILED",
      "已打断本次生成，内容没有写入记录。",
    );
  }
  return error instanceof Error ? error : new Error("Unknown local runtime error");
}

let defaultService: Promise<LocalRecordService> | undefined;

export function getLocalRecordService(): Promise<LocalRecordService> {
  defaultService ??= createDefaultLocalRecordService().catch((error) => {
    defaultService = undefined;
    throw error;
  });
  return defaultService;
}

async function createDefaultLocalRecordService(): Promise<LocalRecordService> {
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) throw notInitialized();
  const url = new URL(connectionString);
  if (decodeURIComponent(url.username) !== "realm_runtime") {
    throw new LocalRecordServiceError(
      "LOCAL_RUNTIME_NOT_INITIALIZED",
      "REALM_RUNTIME_DATABASE_URL must use the restricted realm_runtime role.",
    );
  }
  const pool = createLocalPostgresPool(connectionString);
  const modelSettings = getModelSettingsService();
  const memoryRepository = createPostgresCharacterMemoryRepository(pool);
  const memory = createCharacterMemoryService({
    repository: memoryRepository,
  });
  const memorySync = createMemorySyncScheduler({
    extract: (scope) => memoryRepository.extractAuthorized(scope),
  });
  // 批次 T2 prefetch：回合开始并行发起各在场角色召回，请求体组装时只消费
  // 已就绪结果（fail-closed）；注入位置与格式不变。
  const memoryPrefetch = createMemoryPrefetchHub({
    recall: async ({
      workspaceId,
      worldId,
      worldlineId,
      recordId,
      characterInstanceId,
      query,
    }) => {
      const memories = await memory.recall({
        workspaceId,
        worldId,
        worldlineId,
        recordId,
        characterInstanceId,
        query,
        limit: 6,
      });
      // Cleanup Phase 4 / Batch 2C：prefetch 注入统一走预算格式化（recall
      // 顺序 + `- ...` 行形 + 320 token 预算），不再裸拼接；recall 的
      // limit/授权/查询语义不变。
      return formatMemoryPrefetchLines(memories.map((item) => item.content));
    },
  });
  const previewHub = createLocalPreviewHub();
  const repository = createPostgresRuntimeRepository<
    PlayerUtterancePayload,
    M2TurnPlan,
    M2TurnCandidate,
    M2TurnValidation,
    FormalEventPayload,
    OutboxPayload
  >({
    pool,
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    mapFormalEvent: mapLocalFormalEvent,
    allocateWorldCursors({ previous, eventCount }) {
      return Array.from({ length: eventCount }, (_, index) => ({
        tick: previous.tick,
        ordinal: previous.ordinal + index + 1,
        calendarId: previous.calendarId,
        // 事件时间跟随世界当前状态（设定结晶写回后的 displayTime），
        // 不再硬编码演示世界的时间串。
        display: previous.display,
      }));
    },
  });
  const firstNightRuntime = process.env.REALM_RUNTIME_DATABASE_URL
    ? getFirstNightRuntime(LOCAL_RECORD_SCOPE.workspaceId)
    : undefined;
  return createLocalRecordService({
    repository,
    projection: createPostgresDeliveryProjectionRepository(pool),
    accountMemory: createPostgresAccountRepository(pool),
    // 批次 T7：自演会话账本（受限 realm_runtime 角色，0020 授权）。
    selfPlayStore: createPostgresSelfPlayStore(pool, LOCAL_RECORD_SCOPE.workspaceId),
    // 批次 T9：晶化入图谱（世界知识服务，0010 既有表，无新迁移）。
    worldKnowledge: createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(pool),
    ),
    // 对话 growth：人物 profile note 追加/合并（state JSONB，无新迁移）。
    characterGrowth: createPostgresCharacterGrowthStore(pool),
    ...(firstNightRuntime
      ? {
          firstNight: {
            load: (recordId) => firstNightRuntime.store.find(recordId),
            schedule: firstNightRuntime.schedule,
          },
        }
      : {}),
    runtimeScopeProvider: createPostgresRecordRuntimeScopeRepository(pool),
    // 场景建立图（Stage 3）：envelope 透出 latest ready 背景（0048 台账）。
    sceneImageStore: createPostgresSceneImageStore(pool),
    // 场景图自动模式（0049/0050）：账号级模式 + 幂等队列触发器。
    sceneImageAuto: createSceneImageAutoTrigger({
      queue: createPostgresSceneImageQueue(pool),
      accounts: createPostgresAccountRepository(pool),
    }),
    sceneImageQueue: createPostgresSceneImageQueue(pool),
    actionCatalog: createPostgresActionAffordanceCatalog(pool),
    sceneCrystallizationStore: createPostgresSceneCrystallizationStore(pool),
    sceneCrystallizer: createSceneCrystallizer({
      getGateway: () => modelSettings.gateway(),
    }),
    previewHub,
    memorySync,
    memoryPrefetch,
    visibilityAssessorFactory: (scope) => createModelVisibilityAssessor({
      player: scope.playerActor,
      characters: scope.aiCharacters,
      getGateway: () => modelSettings.gateway(),
      brief: scope.brief,
      style: scope.style,
      language: scope.language,
    }),
    // 批次 T3：回合后在场门禁（fail-closed）+ 关系读写走 T2 既有接口。
    presenceAssessorFactory: (scope) => createModelPresenceAssessor({
      getGateway: () => modelSettings.gateway(),
      brief: scope.brief,
      style: scope.style,
      language: scope.language,
    }),
    characterMemory: memory,
    orchestratorFactory: (scope) => createModelPoweredM2TurnOrchestrator({
      characters: scope.aiCharacters,
      getGateway: () => modelSettings.gateway(),
      brief: scope.brief,
      style: scope.style,
      language: scope.language,
      // 对话主体上下文：当前 Record 可寻址名册（player/NPC 复用既有
      // participantId）+ 带主体信息的最近公开对话摘要（仅 public 事件，
      // 由 record-scope 的授权查询保证）。
      subjectContext: {
        roster: [scope.playerActor, ...scope.aiCharacters].map((actor) => ({
          participantId: actor.participantId,
          characterInstanceId: actor.characterInstanceId,
          displayName: actor.displayName,
        })),
        recentPublicDialogue: scope.recentPublicDialogue,
        // 当前记录的 record_confirmed 知识（record-local 背景，绝非 canon）。
        recordKnowledge: scope.recordKnowledge,
      },
      // 批次 T4：真实模型路径注入 PostgreSQL 数据驱动规则包——判定参数
      // 来自 skill_definitions.metadata，扣减/状态经引擎工具走账本闭环。
      actionResolver: createDeterministicActionResolver({
        rulePack: createPostgresRulePack(pool, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
          worldlineId: scope.worldlineId,
          recordId: scope.recordId,
          location: scope.brief.location,
        }),
        dynamicDiscoveryGenerator: createModelDynamicDiscoveryGenerator({
          getGateway: () => modelSettings.gateway(),
          style: scope.style,
          language: scope.language,
        }),
        dynamicDiscoveryContext: {
          ...scope.brief,
          language: scope.language,
          canon: typeof scope.brief.canon === "string" ? scope.brief.canon : "",
          recentPublicEvents: scope.recentPublicEvents,
        },
        allowStatefulReceipts: true,
      }),
      // 批次 T4：角色 use_skill 提示词按世界数据中的实际持有技能生成。
      characterSkillProvider: createPostgresCharacterSkillProvider(pool, {
        workspaceId: scope.workspaceId,
        worldId: scope.worldId,
        worldlineId: scope.worldlineId,
        recordId: scope.recordId,
      }),
      previewSink: (event) => {
        previewHub.publishChunk(scope.recordId, event.speaker, event.content);
      },
      async recallMemory(character) {
        // 批次 T2 prefetch：同步消费回合开始时的预取结果；pending/failed
        // fail-closed 返回 ""——模型调用前不再挂任何数据库串行等待。
        return memoryPrefetch.consume(scope.recordId, character.characterInstanceId);
      },
    }),
  });
}
