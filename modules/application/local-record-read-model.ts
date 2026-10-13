/**
 * Local Record 读模型（Phase 2A）：从 local-record-service.ts 拆出的
 * 读侧一致性快照与 envelope 组装边界。行为保持——所有语义（快照重试
 * 次数、WRITE_CONFLICT/NOT_FOUND/LOCAL_RUNTIME_NOT_INITIALIZED 分类、
 * fail-closed 读取、字段映射）与拆分前逐行一致。
 *
 * 依赖方向硬边界：本模块只依赖 runtime/postgres/actions/self-play 的
 * 公开类型与常量，绝不 import local-record-service.ts（反向依赖由
 * facade 以 re-export 维持公开 API 不变）。
 * Phase 2G-C：初夜读取/懒调度边界已抽入 local-record-first-night.ts
 * coordinator，本模块只装配依赖并在 envelope 路径真实调用。
 */
import type { RecordProjection } from "./legacy-record-projection-types.ts";
import {
  POSTGRES_DEMO_IDS,
  type PlayerDeliveryScope,
  type PostgresDeliveryProjectionRepository,
  type RecordRuntimeScope,
  type RecordRuntimeScopeRepository,
  type SceneImageQueue,
  type SceneImageStore,
} from "../../database/postgres/public.ts";
import type { RuntimeRecordHead } from "../runtime/public.ts";
import type {
  ActionAffordance,
  ActionAffordanceCatalog,
} from "../actions/public.ts";
import { SELF_PLAY_STALE_MS, type SelfPlayStore } from "./self-play.ts";
import {
  createFirstNightCoordinator,
  type FirstNightMarkerSource,
} from "./local-record-first-night.ts";

const SNAPSHOT_ATTEMPTS = 3;

export const LOCAL_RECORD_SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  principalId: POSTGRES_DEMO_IDS.principal,
  recordId: POSTGRES_DEMO_IDS.record,
  characterInstanceId: undefined,
} as const satisfies PlayerDeliveryScope;

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

/** 本 Record 演示席位的固定角色名册（可见性提案缺省角色名等使用）。 */
export const LOCAL_RECORD_DEMO_ACTORS = [
  LOCAL_PLAYER_ACTOR,
  ...LOCAL_AI_CHARACTERS,
] as const;

export function demoRecordRuntimeScope(): RecordRuntimeScope {
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
    worldBinding: { kind: "base" },
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
    viewerCharacterInstanceId: LOCAL_PLAYER_ACTOR.characterInstanceId,
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

export interface WriteScope {
  workspaceId: string;
  recordId: string;
  principalId: string;
  characterInstanceId: string | null;
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

export interface LocalVisibilityProposal {
  proposalId: string;
  kind: "restricted";
  audienceCharacterInstanceIds: readonly string[];
  audienceNames: readonly string[];
  reason: string;
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

export function notInitialized(): LocalRecordServiceError {
  return new LocalRecordServiceError(
    "LOCAL_RUNTIME_NOT_INITIALIZED",
    "The local PostgreSQL demo has not been initialized.",
  );
}

export function writeScope(
  recordId: string,
  characterInstanceId: string | null,
  principalId?: string,
  workspaceId?: string,
): WriteScope {
  return {
    workspaceId: workspaceId ?? LOCAL_RECORD_SCOPE.workspaceId,
    recordId,
    principalId: principalId ?? LOCAL_RECORD_SCOPE.principalId,
    characterInstanceId,
  };
}

export function sameWriteScope(left: WriteScope, right: WriteScope): boolean {
  return left.workspaceId === right.workspaceId
    && left.recordId === right.recordId
    && left.principalId === right.principalId
    && left.characterInstanceId === right.characterInstanceId;
}

/**
 * 读模型依赖窄接口：facade 的 LocalRecordServiceDependencies 结构上
 * 满足本接口（repository/projection 为必需，其余缺省不启用）。本模块
 * 不 import facade 的完整依赖类型，避免反向边界。
 */
export interface LocalRecordReadModelDependencies {
  repository: {
    loadRecordHead(recordId: string): Promise<RuntimeRecordHead | null>;
  };
  projection: Pick<
    PostgresDeliveryProjectionRepository,
    "loadDeliveryForPlayer"
  >;
  /**
   * Slice 2.5：本地运行工作区身份（RLS 事务边界）。由装配根显式注入；
   * 缺省回落本地 demo 工作区（无 DB 装配的内存/demo 模式语义不变）。
   */
  workspaceId?: string;
  runtimeScopeProvider?: Pick<RecordRuntimeScopeRepository, "resolve">;
  /**
   * 批次 T1：初夜状态读取与调度；缺省不启用（内存测试零变化）。
   * load 返回 null 表示旧世界无状态行；pending 时触发一次懒重试调度。
   * Phase 2G-C：语义由 local-record-first-night.ts 的 coordinator 独占，
   * 此处仅保留窄 source 依赖 shape（结构兼容，薄 adapter）。
   */
  firstNight?: FirstNightMarkerSource;
  /** 批次 T7：世界自演会话账本；缺省不启用。 */
  selfPlayStore?: Pick<SelfPlayStore, "failStale" | "findLatest">;
  /** 场景建立图（Stage 3）：最新 ready 背景读取；缺省不启用。 */
  sceneImageStore?: Pick<SceneImageStore, "findLatestReady">;
  /** 自动模式请求状态（0050 队列最新行）；缺省不启用。 */
  sceneImageQueue?: Pick<SceneImageQueue, "findLatestForRecord">;
}

export interface ConsistentSnapshot {
  projection: RecordProjection;
  viewer: LocalRecordEnvelope["viewer"];
  suggestions: readonly string[];
  canonicalVersion: number;
}

/**
 * 一致性快照：先读 record head → 读 player delivery projection → 再读
 * head；两端版本一致才返回。head 在读取期间被推进则重试，超过
 * SNAPSHOT_ATTEMPTS 保持 WRITE_CONFLICT 语义。
 */
export async function loadConsistentSnapshot(
  dependencies: LocalRecordReadModelDependencies,
  recordId: string,
  principalId?: string,
  /**
   * Slice 2.5：调用方已解析的 runtime scope 作为读取身份来源——携带后
   * 快照读以 scope 的 workspace/principal 为准（任意 Record 经
   * runtimeScopeProvider 解析后的真实身份），不再回落演示身份；缺省
   * 保持本地 demo 回落（无 provider 的内存/demo 模式语义不变）。
   */
  scope?: RecordRuntimeScope,
): Promise<ConsistentSnapshot> {
  const workspaceId = scope?.workspaceId
    ?? dependencies.workspaceId
    ?? LOCAL_RECORD_SCOPE.workspaceId;
  const principal = principalId
    ?? scope?.principalId
    ?? LOCAL_RECORD_SCOPE.principalId;
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await dependencies.repository.loadRecordHead(recordId);
    if (!before) throw notInitialized();
    const delivery = await dependencies.projection.loadDeliveryForPlayer({
      workspaceId,
      recordId,
      principalId: principal,
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

/**
 * 回合读侧聚合：运行时作用域解析。无 scope provider 时只允许本地
 * demo Record；归档/不存在 Record 由 provider fail-closed 为 NOT_FOUND。
 */
export async function resolveRuntimeScope(
  dependencies: LocalRecordReadModelDependencies,
  recordId: string,
  principalId?: string,
): Promise<RecordRuntimeScope> {
  // Slice 2.5：无 provider 时仅本地 demo Record 可用（demoRecordRuntimeScope
  // 是本地 demo 模式的唯一回落）；其余 recordId fail-closed NOT_FOUND。
  // 有 provider 时任意 recordId 均经 provider 解析 scope/principal/viewer
  // ——本函数不再按演示 ID 白名单放行。
  if (!dependencies.runtimeScopeProvider) {
    if (recordId !== LOCAL_RECORD_SCOPE.recordId) {
      throw new LocalRecordServiceError("NOT_FOUND", "Record not found.");
    }
    return demoRecordRuntimeScope();
  }
  const scope = await dependencies.runtimeScopeProvider.resolve({
    workspaceId: dependencies.workspaceId ?? LOCAL_RECORD_SCOPE.workspaceId,
    principalId: principalId ?? LOCAL_RECORD_SCOPE.principalId,
    recordId,
  });
  if (!scope) {
    throw new LocalRecordServiceError("NOT_FOUND", "Record not found.");
  }
  return scope;
}

export function listAuthorizedAffordances(
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
 * 批次 T7：自演会话状态读取（fail-closed，读失败只告警不影响读取路径）。
 * 先懒恢复（活动行心跳超时落 failed，SELFPLAY_STALE），再读最新会话。
 */
async function loadSelfPlayState(
  dependencies: LocalRecordReadModelDependencies,
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
 * envelope 组装：一致性快照 + runtime scope + authorized affordances +
 * first-night/self-play + scene image/job + writeToken。scope 先行
 * （归档/不存在 fail-closed），之后互不依赖的读取并行发起。
 * Phase 2G-C：初夜读取/懒调度/suggestions 归一化/fail-closed 全部委托
 * local-record-first-night.ts 的 coordinator，本模块只装配依赖并调用。
 */
export async function loadConsistentEnvelope(
  dependencies: LocalRecordReadModelDependencies,
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
  // Phase 2G-C：firstNight 读取经 coordinator（独占归一化/调度/fail-closed）。
  // 场景图（Stage 3）：latest ready 背景随信封透出；缺 store（内存测试）
  // 或读取失败一律 fail-closed null，绝不影响信封主路径。
  const sceneImageStore = dependencies.sceneImageStore;
  const sceneImageQueue = dependencies.sceneImageQueue;
  const firstNight = createFirstNightCoordinator(dependencies.firstNight);
  const [snapshot, affordances, firstNightState, selfPlay, sceneImage, sceneImageJob] = await Promise.all([
    // Slice 2.5：快照读复用已解析 scope 的 workspace/principal（任意
    // Record 的真实身份），不再从演示常量二次派生。
    loadConsistentSnapshot(dependencies, recordId, principalId, scope),
    listAuthorizedAffordances(actionCatalog, scope),
    firstNight.load(recordId),
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
      writeScope(
        recordId,
        snapshot.viewer.characterInstanceId,
        principalId ?? scope.principalId,
        scope.workspaceId,
      ),
      snapshot.canonicalVersion,
    ),
    viewer: snapshot.viewer,
    affordances,
    suggestions: snapshot.suggestions,
    firstNight: firstNightState,
    selfPlay,
    sceneImage,
    sceneImageJob,
  };
}
