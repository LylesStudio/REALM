/**
 * M4 parallel candidate racing.
 *
 * @runtime-status contract-only-deferred — 批次 T10-B5：全库零生产调用方；
 * 当前单模型配置无真实并发候选业务场景，接线前置条件见
 * docs/development/T10-B5-M4-RUNTIME-STATUS.md §二。函数行为不变。
 *
 * Producers run in parallel (same configured provider, concurrent requests,
 * or fake providers in tests). The first candidate — in completion order —
 * passing structural acceptance wins; losers are aborted and discarded.
 * Winners still commit through the Record single-writer path, so parallel
 * generation can never double-write a Record.
 */

export class CandidateRaceError extends Error {
  readonly code = "CANDIDATE_RACE_EXHAUSTED";

  constructor(message: string) {
    super(message);
    this.name = "CandidateRaceError";
  }
}

export type CandidateProducer<T> = (signal: AbortSignal) => Promise<T>;

export async function raceCandidates<T>(
  producers: readonly CandidateProducer<T>[],
  accept: (candidate: T) => boolean,
): Promise<{ winner: T; winnerIndex: number }> {
  if (producers.length === 0) {
    throw new CandidateRaceError("At least one candidate producer is required.");
  }
  const controllers = producers.map(() => new AbortController());
  let winner: { winner: T; winnerIndex: number } | null = null;
  let failures = 0;

  await new Promise<void>((resolveRace, rejectRace) => {
    producers.forEach((producer, index) => {
      producer(controllers[index]!.signal)
        .then((candidate) => {
          if (winner) return;
          if (accept(candidate)) {
            winner = { winner: candidate, winnerIndex: index };
            for (const controller of controllers) controller.abort();
            resolveRace();
            return;
          }
          failures += 1;
          if (failures === producers.length) {
            rejectRace(
              new CandidateRaceError(
                "All parallel candidates failed structural acceptance.",
              ),
            );
          }
        })
        .catch(() => {
          if (winner) return;
          failures += 1;
          if (failures === producers.length) {
            rejectRace(
              new CandidateRaceError(
                "All parallel candidates failed or were aborted.",
              ),
            );
          }
        });
    });
  });

  if (!winner) {
    throw new CandidateRaceError("Candidate race settled without a winner.");
  }
  return winner;
}
