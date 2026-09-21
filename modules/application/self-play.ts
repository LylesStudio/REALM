/**
 * 批次 T7：世界自演（observer 之眼的内容供给）——纯类型、常量与状态机契约。
 * 设计规范：docs/development/T7-OBSERVATION-VISION.md。
 *
 * 自演会话 = 记录级账本行（record_self_play_sessions，迁移 0020）+ 单飞
 * 调度器逐拍推进；每拍是一次完整 executeTurn 自治回合（payload.selfPlay），
 * 与玩家回合共享同一套 DM/角色/旁白编排，不产生玩家事件。
 */

export const SELF_PLAY_STATES = [
  "running",
  "stopping",
  "completed",
  "failed",
  "cancelled",
] as const;
export type SelfPlayState = (typeof SELF_PLAY_STATES)[number];

export const SELF_PLAY_TERMINAL_STATES = [
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly SelfPlayState[];

/** 每次显式 start 的默认拍数（依赖注入可降）；硬上限防预算泛滥。 */
export const SELF_PLAY_BEAT_BUDGET = 3;
export const SELF_PLAY_BEAT_HARD_CAP = 5;
/** 活动会话心跳超过该时长即判死（进程崩溃/重启残留），信封懒恢复落 failed。 */
export const SELF_PLAY_STALE_MS = 5 * 60 * 1000;
export const SELF_PLAY_STALE_ERROR = "SELFPLAY_STALE";

export interface SelfPlaySession {
  id: string;
  recordId: string;
  worldId: string;
  state: SelfPlayState;
  beatBudget: number;
  beatsCompleted: number;
  requestedBy: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export function normalizeSelfPlayState(value: unknown): SelfPlayState | null {
  return typeof value === "string"
    && (SELF_PLAY_STATES as readonly string[]).includes(value)
    ? value as SelfPlayState
    : null;
}

export function isSelfPlayTerminal(state: SelfPlayState): boolean {
  return (SELF_PLAY_TERMINAL_STATES as readonly string[]).includes(state);
}

export function isSelfPlayActive(state: SelfPlayState): boolean {
  return state === "running" || state === "stopping";
}

/** 预算钳制：非法/负数归 0（调度器视为无可执行拍），上限硬顶。 */
export function clampSelfPlayBeatBudget(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : SELF_PLAY_BEAT_BUDGET;
  return Math.min(Math.max(numeric, 0), SELF_PLAY_BEAT_HARD_CAP);
}

/**
 * 自演拍的固定引导语（只作模型上下文，不作为玩家事件落库）。
 * 按世界语言取稿（投影 world.language，缺省 zh-CN）。
 */
const SELF_PLAY_INSTRUCTIONS = {
  "zh-CN":
    "（本轮没有玩家输入：让世界自行继续——在场角色继续他们的行动与对话，旁白推进环境与局势。）",
  "en":
    "(No player input this beat: let the world carry on — the characters continue their actions and dialogue while the narration advances the scene.)",
  "ja":
    "（今回合はプレイヤー入力がありません。世界を自律的に進めてください——キャラクターは行動と対話を続け、語りが場を前に進めます。）",
} as const;

export function selfPlayInstruction(language: string): string {
  return SELF_PLAY_INSTRUCTIONS[language as keyof typeof SELF_PLAY_INSTRUCTIONS]
    ?? SELF_PLAY_INSTRUCTIONS["zh-CN"];
}

/**
 * 会话账本仓储契约（PG 实现：database/postgres/self-play-store.ts）。
 * 状态迁移由 SQL WHERE 守卫 fail-closed：非法迁移返回 null/零影响而非抛错。
 */
export interface SelfPlayStore {
  /** 最新一条会话（含终态）；无行返回 null（旧记录完全向后兼容）。 */
  findLatest(recordId: string): Promise<SelfPlaySession | null>;
  /**
   * 幂等 start：活动会话（running/stopping）在 → 返回现状且 created=false；
   * 否则插入 running 新行。预算在写入前经 clampSelfPlayBeatBudget 钳制。
   */
  start(input: {
    sessionId: string;
    recordId: string;
    worldId: string;
    beatBudget: number;
    requestedBy: string;
  }): Promise<{ session: SelfPlaySession; created: boolean }>;
  /** 按 id 读当前行（拍边界的 stopping/预算判定）。 */
  load(sessionId: string): Promise<SelfPlaySession | null>;
  /** 拍完成：活动行（running/stopping）beats_completed+1 并心跳；终态行返回 null。 */
  completeBeat(sessionId: string): Promise<SelfPlaySession | null>;
  /** running → stopping；无 running 行返回 null（幂等）。 */
  requestStop(recordId: string): Promise<SelfPlaySession | null>;
  /** 终态收束：running/stopping → completed/failed/cancelled。 */
  finish(
    sessionId: string,
    state: (typeof SELF_PLAY_TERMINAL_STATES)[number],
    lastError?: string | null,
  ): Promise<void>;
  /** 懒恢复：活动行 updated_at 早于 cutoff → failed（SELFPLAY_STALE）。 */
  failStale(recordId: string, cutoff: Date): Promise<void>;
}

/** 会话是否仍需继续起拍（活动态且预算未耗尽）。 */
export function selfPlaySessionNeedsBeats(session: SelfPlaySession): boolean {
  return isSelfPlayActive(session.state)
    && session.beatsCompleted < session.beatBudget;
}
