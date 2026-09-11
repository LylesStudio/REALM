/**
 * M4 TurnControlLease — per-Record speaking rights, FIFO queue and
 * per-character interjection cooldowns.
 *
 * This is an in-process reference implementation: it governs speaking order
 * only. Formal writes remain guarded by the Record single-writer lock from
 * the M1 contract; multi-instance coordination is a later batch.
 */

export type TurnControlLease = {
  readonly recordId: string;
  readonly holder: string;
  release(): void;
};

export type TurnControl = {
  /**
   * Acquires the speaking lease for a Record. If another holder is active,
   * the caller is queued FIFO until the lease is released.
   */
  acquire(recordId: string, holder: string): Promise<TurnControlLease>;
  /** True when no holder is active for the Record. */
  isFree(recordId: string): boolean;
  /** Current holder of the Record lease, if any. */
  currentHolder(recordId: string): string | null;
  /** Number of queued waiters for the Record. */
  queuedCount(recordId: string): number;
  /** Marks an interjection; starts the character cooldown. */
  recordInterjection(characterInstanceId: string): void;
  /** True when the character is outside its cooldown window. */
  canInterject(characterInstanceId: string): boolean;
};

export class TurnControlError extends Error {
  readonly code: "LEASE_NOT_HELD" | "LEASE_ALREADY_HELD";

  constructor(code: TurnControlError["code"], message: string) {
    super(message);
    this.name = "TurnControlError";
    this.code = code;
  }
}

export function createTurnControl(options: {
  now?: () => number;
  cooldownMs?: number;
}): TurnControl {
  const now = options.now ?? (() => Date.now());
  const cooldownMs = options.cooldownMs ?? 60_000;
  const active = new Map<string, string>();
  const queues = new Map<string, { holder: string; grant: (lease: TurnControlLease) => void }[]>();
  const cooldowns = new Map<string, number>();

  function grantNext(recordId: string) {
    const queue = queues.get(recordId);
    const next = queue?.shift();
    if (!next) return;
    active.set(recordId, next.holder);
    next.grant(createLease(recordId, next.holder));
  }

  function createLease(recordId: string, holder: string): TurnControlLease {
    let released = false;
    return {
      recordId,
      holder,
      release() {
        if (released) return;
        released = true;
        if (active.get(recordId) !== holder) {
          throw new TurnControlError(
            "LEASE_NOT_HELD",
            `Holder ${holder} does not hold the lease for ${recordId}.`,
          );
        }
        active.delete(recordId);
        grantNext(recordId);
      },
    };
  }

  return {
    acquire(recordId, holder) {
      if (active.get(recordId) === holder) {
        throw new TurnControlError(
          "LEASE_ALREADY_HELD",
          `Holder ${holder} already holds the lease for ${recordId}.`,
        );
      }
      if (!active.has(recordId)) {
        active.set(recordId, holder);
        return Promise.resolve(createLease(recordId, holder));
      }
      return new Promise<TurnControlLease>((resolve) => {
        const queue = queues.get(recordId) ?? [];
        queue.push({ holder, grant: resolve });
        queues.set(recordId, queue);
      });
    },
    isFree(recordId) {
      return !active.has(recordId);
    },
    currentHolder(recordId) {
      return active.get(recordId) ?? null;
    },
    queuedCount(recordId) {
      return queues.get(recordId)?.length ?? 0;
    },
    recordInterjection(characterInstanceId) {
      cooldowns.set(characterInstanceId, now() + cooldownMs);
    },
    canInterject(characterInstanceId) {
      const until = cooldowns.get(characterInstanceId);
      return until === undefined || now() >= until;
    },
  };
}
