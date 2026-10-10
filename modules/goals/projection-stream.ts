import type { GoalProjection } from "./projection.ts";

const encoder = new TextEncoder();

export interface GoalProjectionStreamSnapshot {
  headOrdinal: number;
  goals: readonly GoalProjection[];
}

export interface GoalProjectionStreamInput {
  recordId: string;
  initialCursor: number;
  signal: AbortSignal;
  load(): Promise<GoalProjectionStreamSnapshot>;
  listGoalTransitionOrdinalsAfter(cursor: number): Promise<readonly number[]>;
  waitForWakeup(): Promise<boolean>;
  closeWakeup?(): Promise<void>;
  heartbeatIntervalMs?: number;
}

/**
 * Stream only player-safe Goal snapshots. NOTIFY is supplied as a wakeup; the
 * committed Goal transition ledger remains the source of truth for deciding
 * whether a new snapshot is needed.
 */
export function createGoalProjectionStream(
  input: GoalProjectionStreamInput,
): ReadableStream<Uint8Array> {
  if (!Number.isSafeInteger(input.initialCursor) || input.initialCursor < 0) {
    throw new Error("Goal projection cursor is invalid.");
  }
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 15_000;
  let stopped = false;
  let wakeupClosed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let detachAbort: (() => void) | undefined;

  const closeWakeup = async (): Promise<void> => {
    if (wakeupClosed) return;
    wakeupClosed = true;
    if (input.closeWakeup) await input.closeWakeup().catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = input.initialCursor;

      const close = () => {
        if (stopped) return;
        stopped = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        heartbeat = undefined;
        void closeWakeup();
        try {
          controller.close();
        } catch {
          // The consumer already closed the stream.
        }
      };
      input.signal.addEventListener("abort", close, { once: true });
      detachAbort = () => input.signal.removeEventListener("abort", close);
      if (input.signal.aborted) {
        close();
        return;
      }

      const emit = (snapshot: GoalProjectionStreamSnapshot): void => {
        if (stopped) return;
        if (!Number.isSafeInteger(snapshot.headOrdinal) || snapshot.headOrdinal < 0) {
          close();
          return;
        }
        cursor = Math.max(cursor, snapshot.headOrdinal);
        controller.enqueue(encoder.encode(
          `id: ${snapshot.headOrdinal}\n`
          + "event: goal.projection\n"
          + `data: ${JSON.stringify({
            recordId: input.recordId,
            headOrdinal: snapshot.headOrdinal,
            goals: snapshot.goals,
          })}\n\n`,
        ));
      };

      if (Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
        heartbeat = setInterval(() => {
          if (stopped) return;
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            close();
          }
        }, heartbeatIntervalMs);
      }

      void (async () => {
        try {
          // Always establish an initial snapshot. It gives a reconnecting client
          // a complete state without exposing assessment/evidence internals.
          emit(await input.load());
          while (!stopped) {
            if (!(await input.waitForWakeup())) break;
            const changed = await input.listGoalTransitionOrdinalsAfter(cursor);
            if (changed.length === 0) continue;
            const snapshot = await input.load();
            if (snapshot.headOrdinal > cursor) emit(snapshot);
          }
        } catch {
          // Reconnects replay the latest committed projection; no internal
          // database/provider error enters the SSE body.
        } finally {
          detachAbort?.();
          detachAbort = undefined;
          close();
        }
      })();
    },
    cancel() {
      stopped = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      heartbeat = undefined;
      detachAbort?.();
      detachAbort = undefined;
      void closeWakeup();
    },
  });
}
