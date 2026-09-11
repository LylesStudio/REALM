/**
 * 骰点揭示动效的一次性追踪（纯逻辑，组件与测试共用）。
 *
 * 语义：同一稳定 event id 只允许揭示一次——SSE 重放、轮询重渲染、
 * 面板重挂载都不会让同一事件的掷骰动效重播。前端绝不修改、重算或
 * 随机化服务端骰点；这里只记录「揭示过没有」。
 */
export interface DiceRevealTracker {
  /** 首次调用返回 true（应播放揭示）并登记；同 id 之后恒返回 false。 */
  claim(eventId: string): boolean;
  /** 只读查询（不登记）：本事件是否已揭示过。 */
  has(eventId: string): boolean;
}

export function createDiceRevealTracker(): DiceRevealTracker {
  const seen = new Set<string>();
  return {
    claim(eventId) {
      if (seen.has(eventId)) return false;
      seen.add(eventId);
      return true;
    },
    has(eventId) {
      return seen.has(eventId);
    },
  };
}

export type DiceRevealPhase = "rolling" | "revealed";

/**
 * 计算初始阶段：已揭示 / 非 committed / reduced-motion 一律直接给结果。
 * reducedMotion 由调用方从 matchMedia 读取后传入（组件外可测）。
 */
export function resolveDiceRevealPhase(input: {
  tracker: DiceRevealTracker;
  eventId: string;
  committed: boolean;
  reducedMotion: boolean;
}): DiceRevealPhase {
  if (!input.committed || input.reducedMotion) return "revealed";
  return input.tracker.claim(input.eventId) ? "rolling" : "revealed";
}
