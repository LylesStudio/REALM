/**
 * Local Record self-play coordinator（Phase 2F-A）：从
 * local-record-service.ts 拆出的世界自演拍循环调度边界——session load、
 * terminal/stopping/beat budget 判定、Record 发言租约、一致性快照、
 * payload.selfPlay command、AbortController + ActiveTurnSignal 登记/清理、
 * executeTurn/retryTurn、RECORD_VERSION_CONFLICT 一次重读重试、
 * completeBeat、memorySync 与场景晶化 fire-and-forget、failed/SELFPLAY_ABORTED
 * 收束，以及 record 级 single-flight 守卫。行为保持——所有语义与拆分前
 * 逐行一致；本模块不复制 runtime 状态机、PG store 或晶化实现，只做
 * 编排调用。
 *
 * 依赖方向硬边界：本模块只依赖 runtime/self-play 状态机契约、read-model
 * 的共享类型与 turn-runtime bridge 的窄类型，经回调/窄接口解开 facade；
 * 绝不 import local-record-service.ts（反向依赖由 facade 以 import/调用
 * 维持公开 API 与类型路径不变）。
 */
import { type RecordRuntimeScope } from "../../database/postgres/public.ts";
import {
  executeTurn,
  retryTurn,
  type RuntimeCommand,
  type TurnRuntimeDependencies,
} from "../runtime/public.ts";
import { type TurnControl } from "../runtime/turn-control.ts";
import {
  type M2TurnCandidate,
  type M2TurnPlan,
  type M2TurnValidation,
  type TurnVisibilityPlan,
} from "../orchestration/public.ts";
import {
  isSelfPlayTerminal,
  selfPlayInstruction,
  selfPlaySessionNeedsBeats,
  type SelfPlayStore,
} from "./self-play.ts";
import {
  parseSelfPlayBeatJobPayload,
} from "./unified-durable-job-host.ts";
import {
  type ActiveTurnSignal,
  type FormalEventPayload,
  type LocalTurnRun,
  type OutboxPayload,
  type PlayerUtterancePayload,
} from "./local-record-turn-runtime.ts";

/** 拍循环所需的 runtime dependencies 形状（facade 既有组装的透传）。 */
export type LocalSelfPlayRuntimeDependencies = TurnRuntimeDependencies<
  PlayerUtterancePayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation,
  FormalEventPayload,
  OutboxPayload
>;

/**
 * 拍循环对一致性快照的窄视图：只需要 canonicalVersion（command 期望版本）
 * 与世界语言（instruction 取稿）；facade 的 ConsistentSnapshot 结构上兼容。
 */
export interface SelfPlaySnapshotView {
  canonicalVersion: number;
  projection: { world: { language?: string } };
}

/** 拍后场景晶化调度请求（与 facade 晶化调度输入同形，fire-and-forget）。 */
export interface SelfPlayCrystallizationRequest {
  recordId: string;
  playerText: string;
  runtimeScope: RecordRuntimeScope;
  principalId?: string;
  /** 自演拍恒为公开自治回合（允许公共 growth）。 */
  visibility?: TurnVisibilityPlan;
  /** growth claim 的来源事件 id（本拍已提交事件；审计追踪）。 */
  sourceEventId?: string;
}

export interface LocalSelfPlayCoordinatorDependencies {
  /**
   * 自演会话账本；缺省不启用——schedule 结构性 no-op（fail-closed，
   * 与拆分前 runSelfPlaySession 的 `if (!store) return` 同语义）。
   */
  store?: SelfPlayStore;
  /**
   * Slice 3：durable beat 队列。装配后 scheduleSelfPlay 不再进入进程内
   * 拍循环，而是把下一拍入队为 self-play-beat durable job（确定性 id
   * `self-play-beat:{sessionId}:{beat}`，terminal 行可重排）；claimed
   * job 由 createSelfPlayBeatHandler 执行单拍并链式入队下一拍；worker
   * 崩溃的 claimed 行租约过期后被回收重跑（stale recovery，拍内回合以
   * 幂等键去重、落账以 expectedBeat CAS 防重复计拍）。
   */
  beatQueue?: {
    enqueueBeat(input: {
      sessionId: string;
      recordId: string;
      beat: number;
      principalId?: string;
    }): void;
  };
  /** Record 发言租约（与玩家回合/插话/在场互斥，FIFO）。 */
  turnControl: TurnControl;
  /** 进行中回合的取消信号登记表（与玩家回合/presence/插话共享）。 */
  turnSignals: Map<string, ActiveTurnSignal>;
  /** facade 既有 turn runtime 组装（拍内以独立 signal 派生副本）。 */
  runtimeDependencies: LocalSelfPlayRuntimeDependencies;
  /** 一致性快照读取回调（拍前与版本冲突重读各调一次）。 */
  loadSnapshot(
    recordId: string,
    principalId?: string,
    scope?: RecordRuntimeScope,
  ): Promise<SelfPlaySnapshotView>;
  /** 批次 T2 sync_turn：拍后异步萃取；fire-and-forget。 */
  memorySync?: {
    schedule(scope: {
      workspaceId: string;
      worldId: string;
      worldlineId: string;
      recordId: string;
    }): void;
  };
  /** 场景晶化调度回调；fire-and-forget，失败只留日志。 */
  scheduleSceneCrystallization(input: SelfPlayCrystallizationRequest): void;
}

export interface LocalSelfPlayScheduleInput {
  sessionId: string;
  recordId: string;
  runtimeScope: RecordRuntimeScope;
  principalId?: string;
}

export interface LocalSelfPlayCoordinator {
  /** 批次 T7：自演调度入口——record 级单飞守卫去重，重复触发不重入。 */
  scheduleSelfPlay(input: LocalSelfPlayScheduleInput): void;
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

/** 单拍执行输入（拍循环与 durable beat handler 共用）。 */
interface SelfPlayBeatExecutionInput {
  sessionId: string;
  recordId: string;
  runtimeScope: RecordRuntimeScope;
  principalId?: string;
  beat: number;
  /** durable 路径：completeBeat 以拍号 CAS 防崩溃重放重复计拍。 */
  durable?: boolean;
}

/**
 * 单拍执行体工厂（拍循环与 durable beat handler 共用一份实现）：Record
 * 发言租约 → 一致性快照 → payload.selfPlay 自治回合 → 版本冲突重读重试
 * 一次 → 落账（durable 路径带 expectedBeat CAS）→ memorySync/晶化
 * fire-and-forget。返回 true=拍已提交并计拍；false=拍失败且会话已收
 * failed（规范失败矩阵 F2–F9）。
 */
function createBeatExecutor(
  dependencies: LocalSelfPlayCoordinatorDependencies,
): (input: SelfPlayBeatExecutionInput) => Promise<boolean> {
  return async (input) => {
    const store = dependencies.store;
    if (!store) return false;
    const { beat } = input;
    // 与玩家回合/插话/在场互斥：同一 Record 只有一个写者（FIFO 租约）。
    const lease = await dependencies.turnControl.acquire(
      input.recordId,
      `self-play:${input.sessionId}`,
    );
    try {
      const before = await dependencies.loadSnapshot(
        input.recordId,
        input.principalId,
        input.runtimeScope,
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
      dependencies.turnSignals.set(activeKey, { recordId: input.recordId, controller: selfPlayController });
      // Batch 2D：独立 controller 的 signal 贯通 self-play 模型链。
      const selfPlayDependencies = { ...dependencies.runtimeDependencies, signal: selfPlayController.signal };
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
          dependencies.turnSignals.delete(activeKey);
          const refreshed = await dependencies.loadSnapshot(
            input.recordId,
            input.principalId,
            input.runtimeScope,
          );
          activeKey = `selfplay-${input.sessionId}-${beat}-retry`;
          const retryController = new AbortController();
          dependencies.turnSignals.set(activeKey, { recordId: input.recordId, controller: retryController });
          const retryDependencies = { ...dependencies.runtimeDependencies, signal: retryController.signal };
          run = await executeTurn(
            buildSelfPlayCommand(refreshed.canonicalVersion, activeKey),
            retryDependencies,
          );
          if (run.state === "retryable") {
            run = await retryTurn(run.turnId, retryDependencies);
          }
        }
      } finally {
        dependencies.turnSignals.delete(activeKey);
      }
      if (run.state !== "completed") {
        const code = run.currentFailure?.code ?? "TURN_FAILED";
        console.warn(
          `[realm] self-play beat ${beat} of session ${input.sessionId} did not complete: ${code}`,
        );
        await store.finish(input.sessionId, "failed", code);
        return false;
      }
      // 拍落账（仅 running 行可被 +1；中途 stop 的行留待拍边界收束）。
      // durable 路径以拍号 CAS：崩溃重放/租约回收的重复落账返回 null。
      await store.completeBeat(
        input.sessionId,
        ...(input.durable ? [beat] : []),
      );
      // 与玩家回合后同型：sync_turn 萃取 + 场景晶化（均 fire-and-forget）。
      dependencies.memorySync?.schedule({
        workspaceId: input.runtimeScope.workspaceId,
        worldId: input.runtimeScope.worldId,
        worldlineId: input.runtimeScope.worldlineId,
        recordId: input.recordId,
      });
      void dependencies.scheduleSceneCrystallization({
        recordId: input.recordId,
        playerText: instruction,
        runtimeScope: input.runtimeScope,
        principalId: input.principalId,
        // 自演拍是公开自治回合（无玩家私密输入），允许公共 growth。
        visibility: { kind: "public" },
        sourceEventId: selfPlaySourceEventId(run) ?? undefined,
      });
      return true;
    } finally {
      lease.release();
    }
  };
}

export function createLocalSelfPlayCoordinator(
  dependencies: LocalSelfPlayCoordinatorDependencies,
): LocalSelfPlayCoordinator {
  // 批次 T7：自演单飞守卫（进程内按 recordId 去重；DB 部分唯一索引兜底）。
  const selfPlayInFlight = new Set<string>();
  const executeSelfPlayBeat = createBeatExecutor(dependencies);

  /**
   * 批次 T7：自演会话拍循环（fire-and-forget）。每拍是一次完整 executeTurn
   * 自治回合（payload.selfPlay），拍边界重读会话行判定 stopping/预算；
   * 版本冲突重读快照重试一次（T3 模式）；任何失败落 failed 只留日志，
   * 绝不阻塞页面与玩家回合（规范失败矩阵 F2–F9）。
   */
  async function runSelfPlaySession(
    input: LocalSelfPlayScheduleInput,
  ): Promise<void> {
    const store = dependencies.store;
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
        const committed = await executeSelfPlayBeat({
          sessionId: input.sessionId,
          recordId: input.recordId,
          runtimeScope: input.runtimeScope,
          ...(input.principalId !== undefined
            ? { principalId: input.principalId }
            : {}),
          beat,
        });
        if (!committed) return;
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

  return {
    scheduleSelfPlay(input) {
      // Slice 3：durable beat 路径——入队下一拍（fire-and-forget），拍执行
      // 与链式推进由统一 durable job host 承载；确定性 job id 去重即单飞。
      const beatQueue = dependencies.beatQueue;
      if (beatQueue) {
        const store = dependencies.store;
        if (!store) return;
        void (async () => {
          try {
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
            beatQueue.enqueueBeat({
              sessionId: input.sessionId,
              recordId: input.recordId,
              beat: session.beatsCompleted + 1,
              ...(input.principalId !== undefined
                ? { principalId: input.principalId }
                : {}),
            });
          } catch {
            // 入队/账本读取失败只告警：会话保持 running，由 stale 恢复或
            // 下一次 start/stop 收束（fail-closed，不影响调用方）。
            console.warn("[realm] self-play beat schedule failed: skipped enqueue");
          }
        })();
        return;
      }
      if (selfPlayInFlight.has(input.recordId)) return;
      selfPlayInFlight.add(input.recordId);
      void runSelfPlaySession(input);
    },
  };
}

/**
 * Slice 3：self-play-beat durable job handler。claimed job 读会话账本决定
 * 真实拍号（beatsCompleted+1 为准，payload.beat 仅作入队时刻提示）：
 * - 会话终态 → 幂等 no-op（job 正常收 completed）；
 * - stopping/预算耗尽 → 拍边界收束 cancelled/completed（与拍循环同语义）；
 * - 否则重解析 runtime scope 执行单拍并链式入队下一拍（确定性 id +
 *   terminal 重排即链式修复：崩溃丢链时任何后续 handler 都能补链）；
 * - scope 解析/拍执行抛错向上抛，由 host 以有界 code 落 failed（会话账本
 *   尽力收 failed；worker 崩溃的 claimed 行租约过期后被回收重跑，回合以
 *   幂等键去重、计拍以 expectedBeat CAS 防重复）。
 */
export function createSelfPlayBeatHandler(
  dependencies: LocalSelfPlayCoordinatorDependencies & {
    /** durable 拍按 recordId+principal 现场重解析 scope（payload 不承载大体量 scope）。 */
    resolveRuntimeScope(
      recordId: string,
      principalId?: string,
    ): Promise<RecordRuntimeScope>;
    beatQueue: NonNullable<LocalSelfPlayCoordinatorDependencies["beatQueue"]>;
  },
): (job: {
  recordId: string;
  payload: unknown;
}) => Promise<void> {
  // 拍执行体与拍循环共用一份实现（本模块内独立 coordinator 实例仅承载
  // executeSelfPlayBeat，不经 scheduleSelfPlay）。
  const executor = createBeatExecutor(dependencies);
  return async (job) => {
    const payload = parseSelfPlayBeatJobPayload(job.payload);
    if (!payload) {
      throw Object.assign(
        new Error("self-play beat job payload invalid"),
        { code: "SELFPLAY_JOB_PAYLOAD_INVALID" },
      );
    }
    const store = dependencies.store;
    if (!store) {
      throw Object.assign(
        new Error("self-play store unavailable"),
        { code: "SELFPLAY_STORE_UNAVAILABLE" },
      );
    }
    const session = await store.load(payload.sessionId);
    if (!session || isSelfPlayTerminal(session.state)) return;
    if (session.state === "stopping") {
      await store.finish(session.id, "cancelled");
      return;
    }
    if (!selfPlaySessionNeedsBeats(session)) {
      await store.finish(session.id, "completed");
      return;
    }
    const beat = session.beatsCompleted + 1;
    let runtimeScope: RecordRuntimeScope;
    try {
      runtimeScope = await dependencies.resolveRuntimeScope(
        session.recordId,
        payload.principalId,
      );
    } catch (error) {
      // scope 解析失败（归档/权限/读取故障）：会话收 failed，错误继续上抛
      // 让 job 落 failed（有界 code），不影响其他会话。
      await store.finish(session.id, "failed", "SELFPLAY_SCOPE_UNAVAILABLE")
        .catch(() => undefined);
      throw error;
    }
    const committed = await executor({
      sessionId: session.id,
      recordId: session.recordId,
      runtimeScope,
      ...(payload.principalId !== undefined
        ? { principalId: payload.principalId }
        : {}),
      beat,
      durable: true,
    });
    if (!committed) return;
    // 链式推进：拍后重读账本，stopping/预算收束，否则入队下一拍。
    const after = await store.load(session.id);
    if (!after || isSelfPlayTerminal(after.state)) return;
    if (after.state === "stopping") {
      await store.finish(after.id, "cancelled");
      return;
    }
    if (!selfPlaySessionNeedsBeats(after)) {
      await store.finish(after.id, "completed");
      return;
    }
    dependencies.beatQueue.enqueueBeat({
      sessionId: after.id,
      recordId: after.recordId,
      beat: after.beatsCompleted + 1,
      ...(payload.principalId !== undefined
        ? { principalId: payload.principalId }
        : {}),
    });
  };
}
