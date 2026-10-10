/**
 * Shared durable worker lifecycle host (persistence-neutral).
 *
 * The host owns only the lifecycle orchestration that every durable worker
 * runtime otherwise re-implements by hand:
 *
 * - single-instance advisory-lock seam: the runtime supplies `acquireLock`,
 *   which resolves a release handle; the host guarantees the release runs
 *   exactly once, on stop or on any startup failure;
 * - startup health hook and optional startup work (e.g. stale recovery);
 * - the workspace/job cycle loop with exponential idle backoff bounded by
 *   `idleMaxMs` and reset after a productive cycle;
 * - bounded error-classification logging: an unexpected cycle failure is
 *   logged as a bounded machine code only — never the raw driver/provider
 *   message, so connection strings, endpoints, tokens, secrets and provider
 *   payloads cannot reach logs through the host;
 * - idempotent stop/wake shutdown: `stop()` is memoized, wakes the idle
 *   sleeper immediately and releases the lock before closing resources. The
 *   host is single-use and not restartable: `stop()` before `start()` (or
 *   racing in-flight startup) shuts the host down permanently, a later
 *   `start()` fails closed, and a lock handle resolving after the concurrent
 *   stop is released immediately instead of leaking.
 *
 * The host holds no business dependencies: it never opens connections, reads
 * the environment or creates queues. Each runtime keeps owning its pool,
 * queue/repository, health query, cycle content and safe business log lines;
 * only the lifecycle moves here.
 */
export interface DurableWorkerHostHooks {
  /**
   * Acquire the runtime's single-instance advisory lock and resolve the
   * release handle. Reject (with the runtime's own lock-conflict error) when
   * another instance holds the lock; the hook must not leak a held lock on
   * the contention path.
   */
  acquireLock(): Promise<() => Promise<void>>;
  /** Startup health probe; reject to abort the start and release everything. */
  checkHealth(): Promise<void>;
  /**
   * Optional startup work after the health probe passes (e.g. stale lease
   * recovery). Rejecting aborts the start the same way as a health failure.
   */
  onStart?(): Promise<void>;
  /**
   * One workspace/job cycle. Resolve `true` when the cycle performed work
   * (resets the idle backoff). Runtime-owned failures should be classified
   * and logged by the runtime inside the cycle; an unexpected rejection is
   * contained by the host as a bounded `cycle error=<code>` line and the
   * loop continues with the bounded idle backoff.
   */
  runCycle(): Promise<boolean>;
  /** Release runtime-owned resources (pool etc.). Called at most once. */
  close(): Promise<void>;
  /** Error thrown when `start()` is called more than once. */
  alreadyStartedError(): Error;
  /**
   * Error thrown when `start()` is called after the host has been shut down
   * (stop-before-start). Optional; defaults to a generic shutdown error.
   */
  alreadyStoppedError?(): Error;
}

export interface DurableWorkerHostOptions {
  idleMinMs: number;
  idleMaxMs: number;
  hooks: DurableWorkerHostHooks;
  logger?: (line: string) => void;
}

export interface DurableWorkerHost {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDurableWorkerHost(
  options: DurableWorkerHostOptions,
): DurableWorkerHost {
  const hooks = options.hooks;
  const log = options.logger ?? (() => {});
  const stoppedError = () =>
    hooks.alreadyStoppedError?.()
    ?? new Error("durable worker host has been shut down and cannot be started");

  let started = false;
  let stopped = false;
  let stopping: Promise<void> | undefined;
  let releaseLock: (() => Promise<void>) | null = null;
  let closed = false;
  let wake: (() => void) | undefined;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        if (wake === done) wake = undefined;
        resolve();
      }
      wake = done;
    });
  }

  async function closeOnce(): Promise<void> {
    if (closed) return;
    closed = true;
    if (releaseLock) {
      const release = releaseLock;
      releaseLock = null;
      await release().catch(() => undefined);
    }
    await hooks.close().catch(() => undefined);
  }

  return {
    async start() {
      if (started) {
        throw hooks.alreadyStartedError();
      }
      if (stopping) {
        // Fail closed: a stopped host is never reusable, so a late start
        // cannot resurrect closed resources or re-acquire the lock.
        throw stoppedError();
      }
      started = true;
      stopped = false;
      try {
        const release = await hooks.acquireLock();
        if (closed) {
          // stop() raced this in-flight startup and already closed the
          // runtime resources; release the late lock handle immediately so
          // the advisory lock cannot leak, then exit quietly.
          await release().catch(() => undefined);
          return;
        }
        releaseLock = release;
      } catch (error) {
        // Lock contention or a connect failure must not leak runtime
        // resources (pool, clients) behind the rejected start.
        await closeOnce();
        throw error;
      }
      try {
        await hooks.checkHealth();
        if (hooks.onStart) await hooks.onStart();
      } catch (error) {
        await closeOnce();
        throw error;
      }
      let backoff = options.idleMinMs;
      while (!stopped) {
        let didWork = false;
        try {
          didWork = await hooks.runCycle();
        } catch (error) {
          // Bounded classification only: the raw error message may contain
          // connection strings, endpoints or provider payloads.
          log(`cycle error=${safeWorkerErrorCode(error)}`);
        }
        if (stopped) break;
        if (didWork) {
          backoff = options.idleMinMs;
        } else {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, options.idleMaxMs);
        }
      }
    },
    async stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        stopped = true;
        wake?.();
        await closeOnce();
      })();
      await stopping;
    },
  };
}

/**
 * Bounded machine-code predicate: only a restricted charset/length is safe
 * to write into logs. Anything else — URLs, tokens, whitespace, newlines,
 * free-form messages smuggled into `code` — degrades to `unknown`.
 */
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isSafeWorkerErrorCode(code: unknown): code is string {
  return typeof code === "string" && SAFE_ERROR_CODE_PATTERN.test(code);
}

/**
 * Shared bounded error classification for every worker runtime: only the
 * error's machine code reaches logs, and only when it passes the restricted
 * predicate above; the raw message is never logged.
 */
export function safeWorkerErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return isSafeWorkerErrorCode(code) ? code : "unknown";
}
