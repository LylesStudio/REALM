import type { ProjectionEvent } from "./legacy-record-projection-types.ts";
import type { Pool } from "pg";
import { createHash } from "node:crypto";
import {
  POSTGRES_DEMO_IDS,
  createLocalPostgresPool,
  createPostgresAccountRepository,
  createPostgresDeliveryProjectionRepository,
  createPostgresCharacterMemoryRepository,
  createPostgresActionAffordanceCatalog,
  createPostgresCharacterSkillProvider,
  createPostgresRuleDefinitionProvider,
  createPostgresRuntimeRepository,
  createPostgresRecordRuntimeScopeRepository,
  createPostgresSceneCrystallizationStore,
  createPostgresSceneImageStore,
  createPostgresSceneImageQueue,
  type PostgresDeliveryProjectionRepository,
  type PostgresFormalEventMappingContext,
  type PostgresFormalEventWrite,
  type PostgresVisibilityPolicyWrite,
  type RecordRuntimeScope,
  type RecordRuntimeScopeRepository,
  type SceneCrystallizationStore,
  type SceneImageQueue,
  type SceneImageStore,
} from "../../database/postgres/public.ts";
import { reconcileGoalAssessmentJobsForCommittedEvents } from "../../database/postgres/goal-runtime-materialization.ts";
import {
  RuntimeIdempotencyConflictError,
  RuntimeInvariantError,
  acceptTurn,
  executeTurn,
  resumeTurn,
  retryTurn,
  FatalTurnError,
  type RuntimeCommand,
} from "../runtime/public.ts";
import {
  createTurnControl,
  type TurnControl,
} from "../runtime/turn-control.ts";
import { parseRecordTurnJobPayload } from "./unified-durable-job-host.ts";
import {
  createPostgresTurnCancellation,
  type TurnCancellationStore,
} from "../../database/postgres/turn-cancellation.ts";
import {
  createSceneImageAutoTrigger,
  deltaChangesScene,
  type SceneImageAutoTrigger,
} from "./scene-image-trigger.ts";
import {
  semanticPresentation,
} from "../presentation/semantic-segments.ts";
import {
  createModelDynamicDiscoveryGenerator,
  createModelPoweredM2TurnOrchestrator,
  createModelPresenceAssessor,
  createModelVisibilityAssessor,
  normalizeM2TurnCheckpoint,
  type ActivatedCharacter,
  type M2TurnCandidate,
  type M2TurnOrchestrator,
  type M2TurnPlan,
  type M2TurnValidation,
  type SemanticOutputDraft,
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
} from "../orchestration/presence.ts";
// Phase 2B：preview 内存广播/可见性过滤生命周期已拆入
// local-record-preview.ts；本 facade 只做编排调用并保持公开导出不变。
import {
  createLocalPreviewHub,
  type LocalPreviewEvent,
  type LocalPreviewHub,
} from "./local-record-preview.ts";
import {
  createDeterministicActionResolver,
  type ActionAffordance,
  type ActionAffordanceCatalog,
  type ActionSelection,
  type ActionTransaction,
} from "../actions/public.ts";
import { createDataDrivenRulePack } from "../actions/rule-pack.ts";
// Slice 2.5：运行时定义读取经内容解析层——按 Record 的 WorldBinding
// 选定 ContentResolver（base → BaseContentResolver；world-bound → 已挂载
// 签名 RealmWorld 包的 RealmWorldContentResolver），与 DB 物化定义组合。
import {
  createContentRuleDefinitionProvider,
} from "../actions/content-rule-provider.ts";
import {
  createRecordContentResolverSource,
  narrowWorldBinding,
} from "./record-content-resolver.ts";
import {
  createRealmWorldSignatureVerifierFromTrustStoreFile,
  readRealmWorldTrustStoreFile,
} from "../world-transfer/realmworld-trust-store.ts";
import type {
  RealmWorldSignatureVerifier,
} from "../world-transfer/realmworld-loader.ts";
import { getModelSettingsService } from "./model-settings-service.ts";
import { createRecordGoalContextScopeRepository } from "./record-goal-projection.ts";
import { createProjectionDefinitionResolver } from "./record-goal-content.ts";
import { resolveBaseGoalDefinition } from "../world-transfer/base-content.ts";
import { LOCAL_WORLD_VERSION } from "../world-transfer/realm-save.ts";
import { getFirstNightRuntime } from "./first-night-runtime.ts";
import {
  closeDurableJobRuntime,
  getDurableJobRuntime,
} from "./durable-job-runtime.ts";
import {
  parseMemoryPrefetchJobPayload,
  type DurableJobEnqueueInput,
  type DurableJobHandler,
  type DurableJobKind,
} from "./unified-durable-job-host.ts";
import { createPostgresSelfPlayStore } from "../../database/postgres/self-play-store.ts";
import { createPostgresWorldKnowledgeRepository } from "../../database/postgres/world-knowledge-repository.ts";
import { createWorldKnowledgeService } from "../world-knowledge/public.ts";
import {
  SELF_PLAY_BEAT_BUDGET,
  type SelfPlaySession,
  type SelfPlayStore,
} from "./self-play.ts";
// Phase 2F-A：自演拍循环 coordinator（session 判定/租约/快照/turn signal/
// 版本冲突重试/收束/单飞）已拆入 local-record-self-play.ts；本 facade 只做
// 依赖组装与 start/stopSelfPlay 公开 API 编排。
import {
  createLocalSelfPlayCoordinator,
  createSelfPlayBeatHandler,
} from "./local-record-self-play.ts";
// Phase 2F-B：回合 memory prefetch 生命周期（玩家回合仅非 replay begin、
// 成功后按既有角色顺序 consume、提交/失败/异常 finally 一律 end；插话回合
// 开始即 begin、退出清理不泄漏）已拆入 local-record-memory-prefetch.ts；
// 本 facade 只做依赖组装与调用，不再持有第二份 prefetch lifecycle 实现。
import {
  createLocalMemoryPrefetchCoordinator,
} from "./local-record-memory-prefetch.ts";
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
} from "./character-profile.ts";
// Phase 2A：读侧一致性快照 / envelope 组装边界已拆入
// local-record-read-model.ts；本 facade 只做编排调用并保持公开导出不变。
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  demoRecordRuntimeScope,
  listAuthorizedAffordances,
  loadConsistentEnvelope,
  loadConsistentSnapshot,
  notInitialized,
  resolveRuntimeScope,
  sameWriteScope,
  writeScope,
  type LocalRecordEnvelope,
  type LocalTurnFailureDiagnostic,
  type WriteScope,
  type WriteTokenRegistry,
} from "./local-record-read-model.ts";
export {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
} from "./local-record-read-model.ts";
export type {
  LocalRecordEnvelope,
  LocalTurnFailureDiagnostic,
  LocalVisibilityProposal,
  WriteScope,
  WriteTokenRegistry,
} from "./local-record-read-model.ts";
export { createLocalPreviewHub } from "./local-record-preview.ts";
export type {
  LocalPreviewEvent,
  LocalPreviewHub,
} from "./local-record-preview.ts";
// Phase 2C：受限可见性提案签发/授权/绑定（issue/authorize/bind + TTL +
// 校验）已拆入 local-record-visibility-proposals.ts；本 facade 只做编排
// 调用并保持公开导出不变。
import {
  createMemoryVisibilityProposalRegistry,
  type VisibilityProposalRegistry,
} from "./local-record-visibility-proposals.ts";
export { createMemoryVisibilityProposalRegistry } from "./local-record-visibility-proposals.ts";
export type { VisibilityProposalRegistry } from "./local-record-visibility-proposals.ts";
// Phase 2D：visibility resolution（assessor → plan/proposal 裁决、诊断
// 分类）已拆入 local-record-visibility.ts；本 facade 只做编排调用并
// 保持公开导出/类型路径不变。
import {
  formatTurnFailureMessage,
  resolveTurnVisibility,
  type LocalVisibilityAssessor,
  type LocalVisibilityConfirmation,
} from "./local-record-visibility.ts";
export type {
  LocalVisibilityAssessor,
  LocalVisibilityConfirmation,
} from "./local-record-visibility.ts";
// Phase 2E：turn runtime dependency bridge（planner/drafter/validator/
// releaser、presence/interjection 固定计划、取消 signal 检查、orchestrator
// 选择、action catalog 接线）已拆入 local-record-turn-runtime.ts；本 facade
// 只做依赖组装与调用并保持公开导出/类型路径不变。
import {
  createLocalTurnDependencies,
  type ActiveTurnSignal,
  type FormalEventPayload,
  type LocalRuntimeRepository,
  type LocalTurnRun,
  type OutboxPayload,
  type PlayerUtterancePayload,
} from "./local-record-turn-runtime.ts";
export type {
  FormalEventPayload,
  OutboxPayload,
  PlayerUtterancePayload,
} from "./local-record-turn-runtime.ts";

const WRITE_TOKEN_TTL_MS = 15 * 60 * 1_000;

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

interface WriteTokenEntry extends WriteScope {
  canonicalVersion: number;
  expiresAt: number;
  usedByIdempotencyKey?: string;
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

export interface SubmitLocalMessageResult extends LocalRecordEnvelope {
  disposition: "committed" | "duplicate";
}

/** 玩家可见的回合状态。不含 prompt、候选、推理或内部堆栈。 */
export interface PlayerTurnStatus {
  turnId: string;
  recordId: string;
  status: "accepted" | "planning" | "drafting" | "validating" | "releasing" | "completed" | "failed";
  phase: string;
  message?: string;
}

/**
 * 批次 S：默认入口解析结果。无「最近打开」记忆（或记忆已失效）时
 * 返回 onboarding 信号，由前端渲染创世引导屏，而不是硬编码演示记录。
 */
export type OpenDefaultRecordResult =
  | { kind: "record"; envelope: LocalRecordEnvelope }
  | { kind: "onboarding" };

export interface LocalRecordService {
  /**
   * Slice 2.5：recordId 必填——公共方法不再以演示 Record 为缺省。
   * 「打开上次记录/新手引导」的缺省入口是 openDefaultRecord。
   */
  loadRecord(recordId: string, principalId?: string): Promise<LocalRecordEnvelope>;
  /**
   * Preview/cancel 授权：Record scope + world membership + viewer 可见性
   * 的只读窄检查——无副作用（不写 account last-opened、不签发 writeToken、
   * 不订阅、不返回 envelope）。未知 Record / 非成员 / 无 viewer projection
   * 统一 NOT_FOUND（安全 404，不泄漏存在性）；runtime 未初始化保持
   * LOCAL_RUNTIME_NOT_INITIALIZED（503 形态）。返回值仅是明确绑定到该 principal
   * 的 viewer character id；legacy fallback seat 没有此身份，返回 undefined。
   */
  authorizeRecordViewer(
    recordId: string,
    principalId?: string,
  ): Promise<string | undefined>;
  /**
   * 批次 S：打开账号「上次打开的记录」；无记忆或记忆失效时返回
   * onboarding 信号（不抛错、不落演示记录）。
   */
  openDefaultRecord(principalId?: string): Promise<OpenDefaultRecordResult>;
  submitMessage(input: SubmitLocalMessageInput): Promise<SubmitLocalMessageResult>;
  /**
   * 受理玩家命令并返回稳定 turnId。不在这个调用里跑完模型。
   * 相同幂等键和相同正文返回同一个回合；正文不同则冲突。
   */
  admitMessage(input: SubmitLocalMessageInput): Promise<PlayerTurnStatus>;
  /** 从已提交的检查点继续回合。供 durable job 调用。 */
  runAdmittedTurn(turnId: string): Promise<PlayerTurnStatus | null>;
  readTurnStatus(recordId: string, turnId: string, principalId?: string): Promise<PlayerTurnStatus>;
  noteTurnCancelled?(recordId: string, idempotencyKey: string): Promise<boolean>;
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
    viewerCharacterInstanceId?: string,
  ): () => void;
}

/** A cancellation key is insufficient authority without its Record scope. */
export function cancelActiveTurn(
  signals: Map<string, ActiveTurnSignal>,
  recordId: string,
  idempotencyKey: string,
): boolean {
  const active = signals.get(idempotencyKey);
  if (!active || active.recordId !== recordId) return false;
  active.controller.abort();
  return true;
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
  /**
   * Slice 2.5：本地运行工作区身份（RLS 事务边界/scope 解析入参）。
   * 由装配根显式注入；缺省回落本地 demo 工作区（内存测试语义不变）。
   */
  workspaceId?: string;
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
   * Record Goal A 批（A3）：loadHookFreshness 以持久事件游标判定 hook
   * 新鲜度；未装配证据读取时不提供 hook 触发素材，生产 PG 装配必须提供。
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
    /**
     * A3：返回 hook 内容与新鲜度；fresh=false 表示该 hook 已被先前玩家
     * 回合应答（留作背景，不作本轮触发素材）；null 表示无 hook 素材。
     */
    loadHookFreshness?(
      recordId: string,
      currentTurnId: string | null,
    ): Promise<{ content: string; fresh: boolean } | null>;
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
   * Slice 3：统一 durable job runtime（realm_durable_jobs，迁移 0058）。
   * 装配后：self-play 拍调度入队 self-play-beat durable job（替代进程内
   * ad-hoc 拍循环），并注册对应 beat handler；缺省保持既有进程内拍循环
   * （内存/demo 装配零行为变化）。
   */
  durableJobRuntime?: {
    enqueue(input: DurableJobEnqueueInput): Promise<unknown>;
    registerHandler(kind: DurableJobKind, handler: DurableJobHandler): void;
  };
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
  /** 跨进程取消表。缺省时只使用本进程 AbortSignal。 */
  turnCancellation?: TurnCancellationStore;
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
  const turnSignals = new Map<string, ActiveTurnSignal>();
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
  // Phase 2F-A：自演拍循环由独立 coordinator 承载；facade 只组装窄依赖
  // （快照/晶化走本文件既有函数，单飞守卫在 coordinator 内部）。
  // Slice 3：装配 durable job runtime 时，拍调度改为入队 self-play-beat
  // durable job（确定性 id 去重 + terminal 重排），并注册统一 host 的
  // beat handler；缺省保持进程内拍循环（内存/demo 装配零行为变化）。
  const selfPlayBeatQueue = dependencies.durableJobRuntime
    ? {
      enqueueBeat(input: {
        sessionId: string;
        recordId: string;
        beat: number;
        principalId?: string;
      }) {
        void dependencies.durableJobRuntime!.enqueue({
          jobId: `self-play-beat:${input.sessionId}:${input.beat}`,
          kind: "self-play-beat",
          recordId: input.recordId,
          payload: {
            sessionId: input.sessionId,
            beat: input.beat,
            ...(input.principalId !== undefined
              ? { principalId: input.principalId }
              : {}),
          },
          requeueTerminal: true,
        }).catch(() => {
          // 入队失败只告警：会话保持 running，由 stale 恢复/链式修复收束。
          console.warn("[realm] self-play beat enqueue failed");
        });
      },
    }
    : undefined;
  const selfPlayCoordinator = createLocalSelfPlayCoordinator({
    ...(dependencies.selfPlayStore ? { store: dependencies.selfPlayStore } : {}),
    ...(selfPlayBeatQueue ? { beatQueue: selfPlayBeatQueue } : {}),
    turnControl,
    turnSignals,
    runtimeDependencies,
    loadSnapshot: (recordId, principalId, scope) =>
      loadConsistentSnapshot(dependencies, recordId, principalId, scope),
    ...(dependencies.memorySync ? { memorySync: dependencies.memorySync } : {}),
    scheduleSceneCrystallization,
  });
  if (dependencies.durableJobRuntime && dependencies.selfPlayStore && selfPlayBeatQueue) {
    dependencies.durableJobRuntime.registerHandler(
      "self-play-beat",
      createSelfPlayBeatHandler({
        store: dependencies.selfPlayStore,
        turnControl,
        turnSignals,
        runtimeDependencies,
        loadSnapshot: (recordId, principalId, scope) =>
          loadConsistentSnapshot(dependencies, recordId, principalId, scope),
        ...(dependencies.memorySync ? { memorySync: dependencies.memorySync } : {}),
        scheduleSceneCrystallization,
        // durable 拍按 recordId+principal 现场重解析 scope（payload 不承载
        // 大体量 scope；归档/权限变化在拍边界 fail-closed）。
        resolveRuntimeScope: (recordId, principalId) =>
          resolveRuntimeScope(dependencies, recordId, principalId),
        beatQueue: selfPlayBeatQueue,
      }),
    );
  }
  // Phase 2F-B：回合预取生命周期由独立 coordinator 承载；facade 只组装窄
  // 依赖（hub 仍是 LocalRecordServiceDependencies.memoryPrefetch 既有类型）。
  const memoryPrefetchCoordinator = createLocalMemoryPrefetchCoordinator({
    ...(dependencies.memoryPrefetch
      ? { memoryPrefetch: dependencies.memoryPrefetch }
      : {}),
  });

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
      const interjectionPrefetch = memoryPrefetchCoordinator.beginTurn({
        recordId: input.recordId,
        runtimeScope: input.runtimeScope,
        playerText: input.playerText,
      });
      try {
        const lease = await turnControl.acquire(
          input.recordId,
          decision.character.characterInstanceId,
        );
        try {
          const before = await loadConsistentSnapshot(dependencies, input.recordId, input.principalId);
          const key = `interjection-${dependencies.idFactory?.() ?? crypto.randomUUID()}`;
          const controller = new AbortController();
          turnSignals.set(key, { recordId: input.recordId, controller });
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
        memoryPrefetchCoordinator.endTurn(interjectionPrefetch);
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
    /**
     * 触发来源回合 id，供 hook evidence reader 追踪来源。
     * 当前玩家回合自身也算正式应答，不作为游标排除项。
     */
    currentTurnId?: string;
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
      // A3：当前玩家回合也算应答；没有游标证据时不回退旧状态行。
      // 历史 hook 仍由授权历史/初夜状态透出，不在此重播。
      async function loadFreshHookContent(): Promise<string | null> {
        try {
          const hook = await dependencies.firstNight?.loadHookFreshness?.(
            input.recordId,
            input.currentTurnId ?? null,
          );
          return hook?.fresh ? hook.content : null;
        } catch {
          return null;
        }
      }
      // A1: bracket authorization/context resolution with a stable record head.
      // Never pair a scope from before an interleaved commit with its new version.
      async function loadPresenceSnapshot() {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const head = await dependencies.repository.loadRecordHead(input.recordId);
          const scope = await resolveRuntimeScope(dependencies, input.recordId, input.principalId);
          if (!head
            || scope.workspaceId !== input.runtimeScope.workspaceId
            || scope.principalId !== (input.principalId ?? input.runtimeScope.principalId)
            || scope.worldId !== input.runtimeScope.worldId
            || scope.worldlineId !== input.runtimeScope.worldlineId
            || scope.recordId !== input.recordId) {
            throw new Error("presence scope identity mismatch");
          }
          const hookContent = await loadFreshHookContent();
          const snapshot = await loadConsistentSnapshot(dependencies, input.recordId, input.principalId);
          if (snapshot.canonicalVersion === head.version) return { scope, snapshot, hookContent };
        }
        throw new Error("presence scope could not reach a stable head");
      }
      const { scope: freshScope, snapshot: before, hookContent } = await loadPresenceSnapshot();
      const context = extractPresenceContext({
        narration: input.committed.narration,
        characterResponses: input.committed.characterResponses,
        actionTransactions: input.committed.actionTransactions,
        hookContent,
      });
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
        characters: freshScope.aiCharacters,
        excludedCharacterInstanceIds: excluded,
        turnControl,
      });
      if (candidates.length === 0) return;
      const decision = await presenceAssessorFor(freshScope).assess({
        context,
        candidates,
        budget,
      });
      if (decision.kind !== "speak") return;
      const selectedCharacter = candidates.find(
        (candidate) => candidate.characterInstanceId === decision.characterInstanceId,
      );
      // 双保险：确定性规整已拦截越候选选人（F4）。
      if (!selectedCharacter) return;
      let character = selectedCharacter;
      const lease = await turnControl.acquire(
        input.recordId,
        character.characterInstanceId,
      );
      try {
        let activeScope = freshScope;
        // Re-read observer context as well if a version conflict rebuilds scope.
        async function loadPresenceRelationships(): Promise<string> {
          try {
            return await dependencies.characterMemory?.relationships({
              workspaceId: activeScope.workspaceId,
              worldId: activeScope.worldId,
              worldlineId: activeScope.worldlineId,
              recordId: input.recordId,
              characterInstanceId: character.characterInstanceId,
            }) ?? "";
          } catch {
            return "";
          }
        }
        let relationships = await loadPresenceRelationships();
        const buildPresenceCommand = (
          expectedRecordVersion: number,
          idempotencyKey: string,
          scope: RecordRuntimeScope,
        ): RuntimeCommand<PlayerUtterancePayload> => ({
          commandType: "player.utterance",
          recordId: input.recordId,
          expectedRecordVersion,
          idempotencyKey,
          actorId: character.participantId,
          payload: {
            text: input.playerText,
            visibility: { kind: "public" as const },
            runtimeScope: scope,
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
        turnSignals.set(activeKey, { recordId: input.recordId, controller: presenceController });
        // Batch 2D：独立 controller 的 signal 贯通 presence 模型链；
        // 其取消与玩家回合互不影响。
        const presenceDependencies = { ...runtimeDependencies, signal: presenceController.signal };
        try {
          let run = await executeTurn(
            buildPresenceCommand(before.canonicalVersion, activeKey, activeScope),
            presenceDependencies,
          );
          if (run.state === "retryable") {
            run = await retryTurn(run.turnId, presenceDependencies);
          }
          // 批次 T3：生成期间若有异步落库（场景晶化、初夜补录等）推进版本，
          // 重读最新快照重试一次；重试仍冲突则维持 fail-closed 沉默（F9）。
          // A1：版本冲突必须重建 scope（叙事上下文随 head 变化），不能只换
          // expectedRecordVersion；重建失败同样 fail-closed 放弃。
          if (
            run.state !== "completed"
            && run.currentFailure?.code === "RECORD_VERSION_CONFLICT"
          ) {
            console.warn(
              `[realm] presence turn ${run.turnId} hit version conflict; retrying on fresh snapshot`,
            );
            turnSignals.delete(activeKey);
            const rebuilt = await loadPresenceSnapshot();
            if (decision.triggerKind === "hook" && !rebuilt.hookContent) return;
            activeScope = rebuilt.scope;
            const refreshed = rebuilt.snapshot;
            const refreshedCharacter = filterPresenceCandidates({
              characters: activeScope.aiCharacters,
              excludedCharacterInstanceIds: excluded,
              turnControl,
            }).find((candidate) => candidate.characterInstanceId === character.characterInstanceId
              && candidate.participantId === character.participantId);
            if (!refreshedCharacter) return;
            character = refreshedCharacter;
            relationships = await loadPresenceRelationships();
            activeKey = `presence-${dependencies.idFactory?.() ?? crypto.randomUUID()}`;
            const retryController = new AbortController();
            turnSignals.set(activeKey, { recordId: input.recordId, controller: retryController });
            const retryDependencies = { ...runtimeDependencies, signal: retryController.signal };
            run = await executeTurn(
              buildPresenceCommand(refreshed.canonicalVersion, activeKey, activeScope),
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
            workspaceId: activeScope.workspaceId,
            worldId: activeScope.worldId,
            worldlineId: activeScope.worldlineId,
            recordId: input.recordId,
          });
          // 关系落库（F8）：target 须精确匹配在场名册；写入失败只留日志。
          await recordPresenceRelationship({
            run,
            character,
            runtimeScope: activeScope,
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
          // Slice 2.5：授权读身份以已解析 scope 的 principal 为准（任意
          // Record 的真实身份），不再回落演示 principal。
          principalId: input.principalId ?? input.runtimeScope.principalId,
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

  function playerTurnStatus(run: LocalTurnRun): PlayerTurnStatus {
    const failed = run.state === "failed" || run.state === "retryable";
    const status = run.state === "retryable" ? "failed" : run.state;
    return {
      turnId: run.turnId,
      recordId: run.command.recordId,
      status,
      phase: run.state === "completed" ? "committed" : failed ? "failed" : run.state,
      ...(failed && run.currentFailure?.message
        ? { message: run.currentFailure.message }
        : {}),
    };
  }

  async function isTurnCancelled(turnId: string): Promise<boolean> {
    if (!dependencies.turnCancellation) return false;
    const run = await dependencies.repository.loadTurn(turnId);
    if (!run) return false;
    return dependencies.turnCancellation.isRequested({
      recordId: run.command.recordId,
      turnId,
    });
  }

  async function runAdmittedTurn(turnId: string): Promise<PlayerTurnStatus | null> {
    const existing = await dependencies.repository.loadTurn(turnId);
    if (!existing) return null;
    if (existing.state === "completed" || existing.state === "failed") {
      return playerTurnStatus(existing as LocalTurnRun);
    }
    const recordId = existing.command.recordId;
    const idempotencyKey = existing.command.idempotencyKey;
    const controller = new AbortController();
    turnSignals.set(idempotencyKey, { recordId, controller });
    const visibility = existing.command.payload.visibility ?? { kind: "public" as const };
    previewHub.begin(recordId, idempotencyKey, controller.signal, visibility);
    try {
      const turnDependencies = {
        ...runtimeDependencies,
        signal: controller.signal,
        isCancelled: isTurnCancelled,
      };
      let run = await resumeTurn(turnId, turnDependencies);
      if (run.state === "retryable") {
        run = await retryTurn(turnId, turnDependencies);
      }
      if (run.state !== "completed" || !run.release) {
        previewHub.end(recordId, "aborted");
        return playerTurnStatus(run);
      }
      previewHub.end(recordId, "committed");
      const scope = existing.command.payload.runtimeScope;
      const visibility = existing.command.payload.visibility;
      if (
        scope
        && visibility.kind === "public"
        && !existing.command.payload.selfPlay
        && !existing.command.payload.interjection
        && !existing.command.payload.presence
      ) {
        const playerText = existing.command.payload.text;
        const activatedCharacters = run.plan?.body.activatedCharacters ?? [];
        const interjectionDecision = interjectionPolicy.evaluate({
          recordId,
          playerText,
          activatedCharacters,
          availableCharacters: scope.aiCharacters,
        });
        if (interjectionDecision.kind === "interject") {
          void scheduleInterjection({
            recordId,
            playerText,
            activatedCharacters,
            runtimeScope: scope,
            principalId: scope.principalId,
          });
        } else {
          void schedulePresence({
            recordId,
            playerText,
            runtimeScope: scope,
            principalId: scope.principalId,
            currentTurnId: run.turnId,
            committed: {
              narration: run.candidate?.body.narration ?? null,
              characterResponses: run.candidate?.body.characterResponses ?? [],
              actionTransactions: run.candidate?.body.actionTransactions ?? [],
              activatedCharacters,
            },
            prefetchedMemories: new Map(),
          });
        }
        dependencies.memorySync?.schedule({
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
          worldlineId: scope.worldlineId,
          recordId,
        });
        void scheduleSceneCrystallization({
          recordId,
          playerText,
          runtimeScope: scope,
          principalId: scope.principalId,
          visibility,
          sourceEventId: playerSourceEventId(run) ?? undefined,
        });
        void dependencies.sceneImageAuto?.afterPlayerTurn({
          runtimeScope: scope,
          principalId: scope.principalId,
          sourceEventId: idempotencyKey,
        });
      }
      return playerTurnStatus(run);
    } finally {
      if (turnSignals.get(idempotencyKey)?.controller === controller) {
        turnSignals.delete(idempotencyKey);
      }
    }
  }

  if (dependencies.durableJobRuntime) {
    dependencies.durableJobRuntime.registerHandler("record-turn", async (job) => {
      const payload = parseRecordTurnJobPayload(job.payload);
      if (!payload) {
        throw new Error("JOB_PAYLOAD_INVALID");
      }
      await runAdmittedTurn(payload.turnId);
    });
  }

  return {
    async loadRecord(recordId, principalId) {
      const envelope = await loadConsistentEnvelope(
        dependencies,
        tokens,
        actionCatalog,
        recordId,
        principalId,
      );
      await rememberLastOpened(
        dependencies,
        // 会话身份缺省仍为本地单用户 principal（与路由层一致）；
        // Record 身份不再参与缺省推导。
        principalId ?? LOCAL_RECORD_SCOPE.principalId,
        envelope.record.world.id,
        envelope.record.record.id,
      );
      return envelope;
    },

    async authorizeRecordViewer(recordId, principalId) {
      // 未装配 DB scope provider 时只允许本地 demo Record；不要依赖
      // projection stub/客户端参数推断本地 Record 的存在性。
      if (!dependencies.runtimeScopeProvider && recordId !== LOCAL_RECORD_SCOPE.recordId) {
        throw new LocalRecordServiceError("NOT_FOUND", "Record not found.");
      }
      // ① 先用 delivery META 验证 Record + membership（只读、无副作用）；
      // 非成员 / 不存在的 Record 同形为安全 404。
      const identity = principalId ?? LOCAL_RECORD_SCOPE.principalId;
      const workspaceId = dependencies.workspaceId ?? LOCAL_RECORD_SCOPE.workspaceId;
      const authorized = await dependencies.projection.hasViewerProjection({
        workspaceId,
        recordId,
        principalId: identity,
      });
      if (!authorized) {
        throw new LocalRecordServiceError("NOT_FOUND", "Record not found.");
      }

      // ② 只解析 principal 绑定的 viewer character，不装载完整 turn scope、
      // recent events、Canon 或 Lore。缺少绑定不拒绝 public SSE，但 restricted
      // preview hub 会 fail-closed 丢弃该 viewer 的 chunk/end。
      const viewerCharacterInstanceId = dependencies.runtimeScopeProvider
        ? await dependencies.runtimeScopeProvider.resolveViewerCharacterInstanceId({
            workspaceId,
            principalId: identity,
            recordId,
          })
        : recordId === LOCAL_RECORD_SCOPE.recordId
          && identity === LOCAL_RECORD_SCOPE.principalId
          ? demoRecordRuntimeScope().viewerCharacterInstanceId
          : null;

      // ③ runtime 未初始化（record head 缺失）保持既有 503 形态。
      const head = await dependencies.repository.loadRecordHead(recordId);
      if (!head) throw notInitialized();
      return viewerCharacterInstanceId || undefined;
    },

    async openDefaultRecord(principalId) {
      const identity = principalId ?? LOCAL_RECORD_SCOPE.principalId;
      const memory = dependencies.accountMemory;
      if (memory) {
        try {
          const last = await memory.findLastOpened(
            dependencies.workspaceId ?? LOCAL_RECORD_SCOPE.workspaceId,
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
      // Slice 2.5：scope 先行（与 loadConsistentEnvelope 的 T12-B 语义同序）
      // ——归档/不存在/非成员 Record 在此 fail-closed 为 NOT_FOUND；快照读
      // 复用已解析 scope 的 workspace/principal，任意 Record 走同一身份链。
      const runtimeScope = await resolveRuntimeScope(
        dependencies,
        input.recordId,
        input.principalId,
      );
      const before = await loadConsistentSnapshot(
        dependencies,
        input.recordId,
        input.principalId,
        runtimeScope,
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
            input.principalId ?? runtimeScope.principalId,
            runtimeScope.workspaceId,
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

      // A retry reuses the admitted execution context, not today's mutable
      // scene/Goal/narrative snapshot. Keep Core's full-payload fingerprint:
      // substitute only user command fields so altered content/actions still fail.
      let replayCommand: LocalTurnRun["command"] | undefined;
      if (authorization.replay) {
        const existing = await dependencies.repository.findTurnByIdempotency(input.recordId, input.idempotencyKey);
        if (!existing || existing.command.commandType !== "player.utterance"
          || existing.command.actorId !== runtimeScope.playerActor.participantId
          || existing.command.expectedRecordVersion !== authorization.expectedRecordVersion) {
          throw new LocalRecordServiceError("IDEMPOTENCY_CONFLICT", "The idempotency key belongs to a different command.");
        }
        const payload = { ...existing.command.payload, text: input.content };
        delete payload.actionSelection;
        if (input.actionSelection) payload.actionSelection = input.actionSelection;
        replayCommand = { ...existing.command, payload };
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
        input.principalId ?? runtimeScope.principalId,
        runtimeScope.workspaceId,
      );
      // 批次 T2 prefetch：回合开始并行发起各在场角色召回，与可见性裁决/DM
      // 规划等模型调用重叠；replay 回合没有模型调用，不预取。
      const prefetchHandle = memoryPrefetchCoordinator.beginTurn({
        recordId: input.recordId,
        runtimeScope,
        playerText: input.content,
        replay: authorization.replay,
      });
      // Batch 2D：Turn controller 在任何模型调用（prefetch/可见性裁决）之前
      // 注册，使 cancelMessage 能命中整条主链路；所有出口统一 finally 清理。
      const turnController = new AbortController();
      turnSignals.set(input.idempotencyKey, { recordId: input.recordId, controller: turnController });
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
        previewHub.begin(
          input.recordId,
          input.idempotencyKey,
          turnController.signal,
          visibility.plan,
        );
        const turnDependencies = {
        ...runtimeDependencies,
        signal: turnController.signal,
        isCancelled: isTurnCancelled,
      };
        try {
          run = await executeTurn(
            replayCommand ?? {
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
              runtimeScope,
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
        const prefetchedMemories = memoryPrefetchCoordinator.consumeTurn({
          recordId: input.recordId,
          handle: prefetchHandle,
          characters: runtimeScope.aiCharacters,
        });
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
              currentTurnId: run.turnId,
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
        memoryPrefetchCoordinator.endTurn(prefetchHandle);
        // Batch 2D：早注册的 Turn controller 统一清理（幂等；presence/插话
        // 的独立 key 不受本回合影响）。
        if (turnSignals.get(input.idempotencyKey)?.controller === turnController) {
          turnSignals.delete(input.idempotencyKey);
        }
      }
    },

    async admitMessage(input) {
      const runtimeScope = await resolveRuntimeScope(
        dependencies,
        input.recordId,
        input.principalId,
      );
      const before = await loadConsistentSnapshot(
        dependencies,
        input.recordId,
        input.principalId,
        runtimeScope,
      );
      if (runtimeScope.worldStatus === "archived") {
        throw new LocalRecordServiceError(
          "WORLD_ARCHIVED",
          "The world is archived and read-only.",
        );
      }
      const existing = await dependencies.repository.findTurnByIdempotency(
        input.recordId,
        input.idempotencyKey,
      );
      if (existing) {
        const previous = existing.command.payload.text;
        if (previous !== input.content || existing.command.recordId !== input.recordId) {
          throw new LocalRecordServiceError(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for different content.",
          );
        }
        return playerTurnStatus(existing as LocalTurnRun);
      }
      let authorization: ReturnType<WriteTokenRegistry["authorize"]>;
      try {
        authorization = tokens.authorize({
          token: input.writeToken,
          scope: writeScope(
            input.recordId,
            before.viewer.characterInstanceId,
            input.principalId ?? runtimeScope.principalId,
            runtimeScope.workspaceId,
          ),
          canonicalVersion: before.canonicalVersion,
          idempotencyKey: input.idempotencyKey,
        });
      } catch (error) {
        if (error instanceof LocalRecordServiceError && error.code === "WRITE_CONFLICT") {
          throw new LocalRecordServiceError(
            "WRITE_CONFLICT",
            error.message,
            before.projection.version,
          );
        }
        throw error;
      }
      const profileUpdate = extractExplicitCharacterProfileUpdate(
        input.content,
        runtimeScope.playerActor,
      );
      const scope = writeScope(
        input.recordId,
        before.viewer.characterInstanceId,
        input.principalId ?? runtimeScope.principalId,
        runtimeScope.workspaceId,
      );
      const visibility = await resolveTurnVisibility({
        input,
        scope,
        runtimeScope,
        canonicalVersion: authorization.expectedRecordVersion,
        assessor: dependencies.visibilityAssessor,
        assessorFactory: dependencies.visibilityAssessorFactory,
        proposals: visibilityProposals,
        signal: undefined,
      });
      const accepted = await acceptTurn(
        {
          commandType: "player.utterance",
          recordId: input.recordId,
          expectedRecordVersion: authorization.expectedRecordVersion,
          idempotencyKey: input.idempotencyKey,
          actorId: runtimeScope.playerActor.participantId,
          payload: {
            text: input.content,
            ...(input.actionSelection ? { actionSelection: input.actionSelection } : {}),
            visibility: visibility.plan,
            runtimeScope,
            ...(profileUpdate ? { profileUpdate } : {}),
          },
        },
        runtimeDependencies,
      );
      const status = playerTurnStatus(accepted.run as LocalTurnRun);
      const terminal = status.status === "completed" || status.status === "failed";
      if (!terminal && dependencies.durableJobRuntime) {
        await dependencies.durableJobRuntime.enqueue({
          jobId: `record-turn:${accepted.run.turnId}`,
          kind: "record-turn",
          recordId: input.recordId,
          payload: {
            turnId: accepted.run.turnId,
            idempotencyKey: input.idempotencyKey,
            principalId: input.principalId ?? runtimeScope.principalId,
          },
        });
      } else if (!terminal) {
        void runAdmittedTurn(accepted.run.turnId).catch((error) => {
          console.warn(
            `[realm] admitted turn ${accepted.run.turnId} failed: ${
              error instanceof Error ? error.name : "error"
            }`,
          );
        });
      }
      return status;
    },

    runAdmittedTurn,

    async readTurnStatus(recordId, turnId, principalId) {
      await resolveRuntimeScope(dependencies, recordId, principalId);
      const run = await dependencies.repository.loadTurn(turnId);
      if (!run || run.command.recordId !== recordId) {
        throw new LocalRecordServiceError("NOT_FOUND", "Turn was not found.");
      }
      return playerTurnStatus(run);
    },

    async noteTurnCancelled(recordId, idempotencyKey) {
      const run = await dependencies.repository.findTurnByIdempotency(
        recordId,
        idempotencyKey,
      );
      if (!run || run.command.recordId !== recordId) return false;
      await dependencies.turnCancellation?.request({ recordId, turnId: run.turnId });
      return true;
    },

    cancelMessage(recordId, idempotencyKey) {
      return cancelActiveTurn(turnSignals, recordId, idempotencyKey);
    },

    async startSelfPlay(recordId, principalId) {
      const store = dependencies.selfPlayStore;
      if (!store) throw notInitialized();
      // 权限链与读取路径同源：runtimeScope 解析（无 membership → 404 形态）
      // + 快照；快照读复用已解析 scope 的身份（Slice 2.5）。
      const runtimeScope = await resolveRuntimeScope(
        dependencies,
        recordId,
        principalId,
      );
      await loadConsistentSnapshot(dependencies, recordId, principalId, runtimeScope);
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
        selfPlayCoordinator.scheduleSelfPlay({
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
      const runtimeScope = await resolveRuntimeScope(
        dependencies,
        recordId,
        principalId,
      );
      await loadConsistentSnapshot(dependencies, recordId, principalId, runtimeScope);
      const stopped = await store.requestStop(recordId);
      // 幂等：无活动会话 → 返回最近一条（含 null）。
      return stopped ?? store.findLatest(recordId);
    },

    subscribePreviews(recordId, listener, viewerCharacterInstanceId) {
      return previewHub.subscribe(
        recordId,
        listener,
        viewerCharacterInstanceId,
      );
    },

    async listCommittedEvents(recordId, afterOrdinal, principalId) {
      if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
        throw new LocalRecordServiceError(
          "NOT_FOUND",
          "The requested delivery cursor is invalid.",
        );
      }
      const projection = await dependencies.projection.loadForPlayer({
        workspaceId: dependencies.workspaceId ?? LOCAL_RECORD_SCOPE.workspaceId,
        recordId,
        principalId: principalId ?? LOCAL_RECORD_SCOPE.principalId,
      });
      if (!projection) throw notInitialized();
      return projection.events.filter((event) => event.ordinal > afterOrdinal);
    },
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
      dependencies.workspaceId ?? LOCAL_RECORD_SCOPE.workspaceId,
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
let defaultServicePool: Pool | undefined;

export function getLocalRecordService(): Promise<LocalRecordService> {
  defaultService ??= createDefaultLocalRecordService().catch((error) => {
    defaultService = undefined;
    throw error;
  });
  return defaultService;
}

/** 关停/测试路径：释放默认服务持有的连接池（幂等；与 endSharedRuntimePools 同义）。 */
export async function closeDefaultLocalRecordService(): Promise<void> {
  defaultService = undefined;
  const pool = defaultServicePool;
  defaultServicePool = undefined;
  // Slice 3：统一 durable job host 随服务关停（advisory lock 释放、host
  // 幂等 stop）；pool 由 host.close 负责。
  await closeDurableJobRuntime().catch(() => undefined);
  await pool?.end().catch(() => undefined);
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
  defaultServicePool = pool;
  const modelSettings = getModelSettingsService();
  // Slice 2.5：world-bound Record 的运行时定义读取经已挂载签名
  // RealmWorld 包的 ContentResolver（与 app/api/realmworld/env.ts 同一
  // 信任链环境变量）。安装根/trust-store 缺失或初始校验失败 → verifier
  // 缺省（fail-closed：world-bound 内容层无贡献，绝不退化为未验签）。
  const realmWorldInstallRoot = process.env.REALM_REALMWORLD_INSTALL_ROOT
    ?? process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  const realmWorldTrustStorePath = process.env.REALM_REALMWORLD_TRUST_STORE;
  let realmWorldVerifier: RealmWorldSignatureVerifier | undefined;
  if (realmWorldInstallRoot && realmWorldTrustStorePath) {
    try {
      await readRealmWorldTrustStoreFile(realmWorldTrustStorePath);
      realmWorldVerifier = createRealmWorldSignatureVerifierFromTrustStoreFile({
        path: realmWorldTrustStorePath,
      });
    } catch (error) {
      console.warn(
        `[realm] RealmWorld trust store unavailable; world-bound content resolution disabled: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const recordContentResolvers = createRecordContentResolverSource({
    ...(realmWorldInstallRoot ? { installRoot: realmWorldInstallRoot } : {}),
    ...(realmWorldVerifier ? { verifySignature: realmWorldVerifier } : {}),
  });
  const memoryRepository = createPostgresCharacterMemoryRepository(pool);
  const memory = createCharacterMemoryService({
    repository: memoryRepository,
  });
  const memorySync = createMemorySyncScheduler({
    extract: (scope) => memoryRepository.extractAuthorized(scope),
  });
  // Slice 3：统一 durable job runtime（realm_durable_jobs，迁移 0058）。
  // first-night/self-play-beat/memory-prefetch 三类重活经它入队与执行；
  // envelope/回合快路径不变（prefetch 消费仍同步 fail-closed）。
  const durableJobs = getDurableJobRuntime(LOCAL_RECORD_SCOPE.workspaceId);
  // 批次 T2 prefetch：回合开始并行发起各在场角色召回，请求体组装时只消费
  // 已就绪结果（fail-closed）；注入位置与格式不变。
  const recallPrefetchedMemories = async ({
    workspaceId,
    worldId,
    worldlineId,
    recordId,
    characterInstanceId,
    query,
  }: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
    query: string;
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
  };
  const memoryPrefetch = createMemoryPrefetchHub({
    recall: recallPrefetchedMemories,
    // Slice 3：重召回经 durable job host 执行；begin 只入队（fire-and-forget，
    // 入队失败该角色本轮无预取，与召回失败同型 fail-closed）。
    dispatch: (input) => {
      void durableJobs.enqueue({
        jobId: `memory-prefetch:${durableJobs.instanceId}:${input.recordId}:${input.sessionId}:${input.characterInstanceId}`,
        kind: "memory-prefetch",
        recordId: input.recordId,
        payload: {
          sessionId: input.sessionId,
          worldId: input.worldId,
          worldlineId: input.worldlineId,
          characterInstanceId: input.characterInstanceId,
          query: input.playerText.slice(0, 500),
        },
      }).catch(() => {
        console.warn("[realm] memory prefetch enqueue failed");
      });
    },
  });
  // memory-prefetch claimed job：执行召回并把格式化结果回灌 hub 当前会话
  //（会话标识隔离——被替换/已结束会话的迟到结果直接丢弃）。
  durableJobs.registerHandler("memory-prefetch", async (job) => {
    const payload = parseMemoryPrefetchJobPayload(job.payload);
    if (!payload) {
      throw Object.assign(
        new Error("memory prefetch job payload invalid"),
        { code: "PREFETCH_JOB_PAYLOAD_INVALID" },
      );
    }
    const content = await recallPrefetchedMemories({
      workspaceId: job.workspaceId,
      worldId: payload.worldId,
      worldlineId: payload.worldlineId,
      recordId: job.recordId,
      characterInstanceId: payload.characterInstanceId,
      query: payload.query,
    });
    memoryPrefetch.deliver?.({
      recordId: job.recordId,
      sessionId: payload.sessionId,
      characterInstanceId: payload.characterInstanceId,
      content,
    });
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
    normalizeCheckpoint: normalizeM2TurnCheckpoint,
    // Goal runtime materialization：commitRelease 同一事务内对该 Record
    // reconcile 仍 active 的 Goal × 每条正式事件，生成 durable assessment
    // job（0055 schema；无 Goal 零写入；hook 失败即整事务回滚）。
    onFormalEventsCommitted: async (client, committed) => {
      await reconcileGoalAssessmentJobsForCommittedEvents(client, committed);
    },
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
    // Slice 3：统一 durable job host——self-play 拍调度入队 durable job，
    // beat handler 在本服务装配点注册（拍内仍走既有 executeTurn 编排）。
    durableJobRuntime: durableJobs,
    turnCancellation: createPostgresTurnCancellation(pool, LOCAL_RECORD_SCOPE.workspaceId),
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
            // A3：hook 新鲜度由持久事件游标判定（first-night-store 只读）。
            loadHookFreshness: (recordId: string, currentTurnId: string | null) =>
              firstNightRuntime.store.resolveHookFreshness?.(recordId, currentTurnId)
                ?? Promise.resolve(null),
          },
        }
      : {}),
    runtimeScopeProvider: createRecordGoalContextScopeRepository(pool, createPostgresRecordRuntimeScopeRepository(pool), {
      resolveContentDefinition: async binding => {
        const resolver = await createProjectionDefinitionResolver()
          ?? (binding.worldVersion === LOCAL_WORLD_VERSION ? resolveBaseGoalDefinition : null);
        if (!resolver) throw new RuntimeInvariantError("GOAL_CONTENT_UNAVAILABLE", "Goal content is unavailable.");
        return resolver(binding);
      },
    }),
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
    orchestratorFactory: (scope) => {
      // Slice 2.5：运行时内容身份——base/缺省 → BaseContentResolver；
      // world-bound（身份完整）→ 已挂载 RealmWorld 包的 resolver；畸形
      // world binding → null（内容层禁用，仅 DB 物化定义，fail-closed）。
      const contentBinding = narrowWorldBinding(scope.worldBinding);
      return createModelPoweredM2TurnOrchestrator({
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
        // 批次 T4 + Slice 2.5：真实模型路径注入数据驱动规则包——定义读取
        // 按 Record 的 WorldBinding 经内容解析层分流（base →
        // BaseContentResolver；world-bound → 已挂载 RealmWorld 包的
        // RealmWorldContentResolver），DB 物化定义（含账本 definitionId
        // 与抽牌账本）在冲突时优先；扣减/状态经引擎工具走账本闭环。
        actionResolver: createDeterministicActionResolver({
          rulePack: createDataDrivenRulePack(
            createContentRuleDefinitionProvider({
              resolver: contentBinding
                ? () => recordContentResolvers.forBinding(contentBinding, scope.language)
                : null,
              binding: contentBinding ?? { kind: "base" },
              language: scope.language,
              location: scope.brief.location,
              fallback: createPostgresRuleDefinitionProvider(pool, {
                workspaceId: scope.workspaceId,
                worldId: scope.worldId,
                worldlineId: scope.worldlineId,
                recordId: scope.recordId,
                location: scope.brief.location,
              }),
            }),
          ),
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
          previewHub.publishChunk(scope.recordId, event.speaker, event.content, event.phase);
        },
        async recallMemory(character) {
          // 批次 T2 prefetch：同步消费回合开始时的预取结果；pending/failed
          // fail-closed 返回 ""——模型调用前不再挂任何数据库串行等待。
          return memoryPrefetch.consume(scope.recordId, character.characterInstanceId);
        },
      });
    },
  });
}
