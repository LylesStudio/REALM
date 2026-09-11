export type MemoryRefreshSchedulerOptions = {
  isEnabled: () => boolean;
  invalidate: () => void;
  delaysMs?: readonly number[];
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
};

const DEFAULT_DELAYS_MS = [700, 1500, 3000] as const;

/**
 * A committed event means the turn is visible, not that asynchronous sync_turn
 * has finished. Coalesce the burst and reread a small bounded number of times.
 */
export function createMemoryRefreshScheduler(options: MemoryRefreshSchedulerOptions) {
  const delays = options.delaysMs && options.delaysMs.length > 0
    ? options.delaysMs
    : DEFAULT_DELAYS_MS;
  const setTimer = options.setTimeoutFn
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimeoutFn
    ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let timer: unknown = null;
  let disposed = false;

  function clear() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  function arm(attempt: number) {
    const delayMs = delays[attempt];
    if (delayMs === undefined || disposed || !options.isEnabled()) return;
    timer = setTimer(() => {
      timer = null;
      if (disposed || !options.isEnabled()) return;
      options.invalidate();
      arm(attempt + 1);
    }, delayMs);
  }

  return {
    schedule() {
      if (disposed) return;
      clear();
      arm(0);
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
