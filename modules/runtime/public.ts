/**
 * Persistence-neutral, recoverable Turn runtime.
 *
 * A Turn candidate is a durable proposal, never a committed Record event.
 * Only RuntimeRepository.commitRelease may atomically publish formal events,
 * advance the Record head, create Outbox messages, and complete the Turn.
 */

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type TurnActiveState =
  | "accepted"
  | "planning"
  | "drafting"
  | "validating"
  | "releasing";
export type TurnTerminalState = "completed" | "failed";
export type TurnRunState =
  | TurnActiveState
  | TurnTerminalState
  | "retryable";
export type TurnStage = Exclude<TurnActiveState, "accepted">;
export type TurnFailureDisposition = "retryable" | "failed";

export interface RuntimeCommand<TPayload extends JsonValue = JsonValue> {
  commandType: string;
  recordId: string;
  expectedRecordVersion: number;
  idempotencyKey: string;
  actorId: string | null;
  payload: TPayload;
}

export interface TurnPlan<TBody extends JsonValue = JsonValue> {
  planId: string;
  body: TBody;
  createdAt: string;
}

/** Draft output persisted outside the formal Record event plane. */
export interface TurnCandidate<TBody extends JsonValue = JsonValue> {
  candidateId: string;
  body: TBody;
  createdAt: string;
  draftingAttempt: number;
}

export interface TurnValidation<TBody extends JsonValue = JsonValue> {
  validationId: string;
  body: TBody;
  createdAt: string;
}

export interface TurnFailure {
  disposition: TurnFailureDisposition;
  stage: TurnStage;
  resumeFrom: TurnStage;
  code: string;
  /** Safe control-plane summary; raw provider errors are not persisted. */
  message: string;
  attempt: number;
  occurredAt: string;
}

export interface TurnStateTransition {
  from: TurnRunState | null;
  to: TurnRunState;
  at: string;
}

export interface RuntimeReleaseReceipt {
  turnId: string;
  recordId: string;
  recordVersion: number;
  firstOrdinal: number;
  nextOrdinal: number;
  eventIds: readonly string[];
  outboxMessageIds: readonly string[];
  releaseFingerprint: string;
  committedAt: string;
}

export interface TurnRun<
  TCommandPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
> {
  turnId: string;
  command: RuntimeCommand<TCommandPayload>;
  commandFingerprint: string;
  state: TurnRunState;
  revision: number;
  attempts: Readonly<Record<TurnStage, number>>;
  plan?: TurnPlan<TPlan>;
  candidate?: TurnCandidate<TCandidate>;
  validation?: TurnValidation<TValidation>;
  release?: RuntimeReleaseReceipt;
  currentFailure?: TurnFailure;
  failures: readonly TurnFailure[];
  transitions: readonly TurnStateTransition[];
  acceptedAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface RuntimeFormalEventDraft<TPayload extends JsonValue = JsonValue> {
  eventId: string;
  kind: string;
  payload: TPayload;
}

export interface RuntimeOutboxDraft<TPayload extends JsonValue = JsonValue> {
  messageId: string;
  topic: string;
  dedupeKey: string;
  payload: TPayload;
}

export interface RuntimeReleaseBundle<
  TEvent extends JsonValue = JsonValue,
  TOutbox extends JsonValue = JsonValue,
> {
  formalEvents: readonly RuntimeFormalEventDraft<TEvent>[];
  outbox: readonly RuntimeOutboxDraft<TOutbox>[];
}

export interface RuntimeCommittedEvent<TPayload extends JsonValue = JsonValue> {
  turnId: string;
  recordId: string;
  recordVersion: number;
  ordinal: number;
  eventId: string;
  kind: string;
  payload: TPayload;
  committedAt: string;
}

export type RuntimeOutboxState =
  | "pending"
  | "delivering"
  | "retryable"
  | "delivered"
  | "failed";

export interface RuntimeOutboxFailure {
  code: string;
  message: string;
  occurredAt: string;
}

export interface RuntimeOutboxMessage<TPayload extends JsonValue = JsonValue> {
  messageId: string;
  turnId: string;
  recordId: string;
  topic: string;
  dedupeKey: string;
  payload: TPayload;
  state: RuntimeOutboxState;
  revision: number;
  attempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  lastFailure?: RuntimeOutboxFailure;
}

export interface RuntimeRecordHead {
  recordId: string;
  version: number;
  nextOrdinal: number;
}

export interface AcceptCommandInput<TPayload extends JsonValue = JsonValue> {
  turnId: string;
  command: RuntimeCommand<TPayload>;
  commandFingerprint: string;
  now: string;
}

export interface AcceptCommandResult<
  TCommandPayload extends JsonValue = JsonValue,
> {
  run: TurnRun<TCommandPayload>;
  created: boolean;
}

export type AdvanceTurnInput<
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
> =
  | {
      turnId: string;
      expectedRevision: number;
      expectedState: "accepted";
      nextState: "planning";
      now: string;
    }
  | {
      turnId: string;
      expectedRevision: number;
      expectedState: "planning";
      nextState: "drafting";
      plan: TurnPlan<TPlan>;
      now: string;
    }
  | {
      turnId: string;
      expectedRevision: number;
      expectedState: "drafting";
      nextState: "validating";
      candidate: TurnCandidate<TCandidate>;
      now: string;
    }
  | {
      turnId: string;
      expectedRevision: number;
      expectedState: "validating";
      nextState: "releasing";
      validation: TurnValidation<TValidation>;
      now: string;
    };

export interface BeginStageAttemptInput {
  turnId: string;
  expectedRevision: number;
  stage: TurnStage;
  now: string;
}

export interface MarkTurnFailureInput {
  turnId: string;
  expectedRevision: number;
  expectedState: TurnStage;
  failure: TurnFailure;
  now: string;
}

export interface RestartTurnInput {
  turnId: string;
  expectedRevision: number;
  now: string;
}

export interface CommitRuntimeReleaseInput<
  TEvent extends JsonValue = JsonValue,
  TOutbox extends JsonValue = JsonValue,
> {
  turnId: string;
  expectedRevision: number;
  releaseFingerprint: string;
  bundle: RuntimeReleaseBundle<TEvent, TOutbox>;
  now: string;
}

export interface ClaimOutboxInput {
  messageId: string;
  expectedRevision: number;
  leaseOwner: string;
  leaseExpiresAt: string;
  now: string;
}

export interface SettleOutboxInput {
  messageId: string;
  expectedRevision: number;
  outcome: "delivered" | "retryable" | "failed";
  leaseOwner: string;
  now: string;
  retryAt?: string;
  failure?: RuntimeOutboxFailure;
}

/**
 * Persistence port for Command Inbox, Turn checkpoints, formal release, and
 * Outbox state. commitRelease is the only formal publication boundary.
 */
export interface RuntimeRepository<
  TCommandPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
  TEvent extends JsonValue = JsonValue,
  TOutbox extends JsonValue = JsonValue,
> {
  acceptCommand(
    input: AcceptCommandInput<TCommandPayload>,
  ): Promise<AcceptCommandResult<TCommandPayload>>;
  loadTurn(
    turnId: string,
  ): Promise<
    TurnRun<TCommandPayload, TPlan, TCandidate, TValidation> | null
  >;
  advanceTurn(
    input: AdvanceTurnInput<TPlan, TCandidate, TValidation>,
  ): Promise<TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>>;
  beginStageAttempt(
    input: BeginStageAttemptInput,
  ): Promise<TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>>;
  markTurnFailure(
    input: MarkTurnFailureInput,
  ): Promise<TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>>;
  restartTurn(
    input: RestartTurnInput,
  ): Promise<TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>>;
  commitRelease(
    input: CommitRuntimeReleaseInput<TEvent, TOutbox>,
  ): Promise<TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>>;
  loadRecordHead(recordId: string): Promise<RuntimeRecordHead | null>;
  listCommittedEvents(
    recordId: string,
  ): Promise<readonly RuntimeCommittedEvent<TEvent>[]>;
  loadOutboxMessage(
    messageId: string,
  ): Promise<RuntimeOutboxMessage<TOutbox> | null>;
  listOutboxMessages(): Promise<readonly RuntimeOutboxMessage<TOutbox>[]>;
  claimOutbox(
    input: ClaimOutboxInput,
  ): Promise<RuntimeOutboxMessage<TOutbox>>;
  settleOutbox(
    input: SettleOutboxInput,
  ): Promise<RuntimeOutboxMessage<TOutbox>>;
}

export interface RuntimePlanningContext<
  TPayload extends JsonValue = JsonValue,
> {
  turnId: string;
  command: Readonly<RuntimeCommand<TPayload>>;
  attempt: number;
  /** Cleanup Phase 4 / Batch 2D：本地取消信号（可选，向后兼容）。 */
  signal?: AbortSignal;
}

export interface RuntimeDraftingContext<
  TPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
> extends RuntimePlanningContext<TPayload> {
  plan: Readonly<TurnPlan<TPlan>>;
}

export interface RuntimeValidationContext<
  TPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
> extends RuntimeDraftingContext<TPayload, TPlan> {
  candidate: Readonly<TurnCandidate<TCandidate>>;
}

export interface RuntimeReleasingContext<
  TPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
> extends RuntimeValidationContext<TPayload, TPlan, TCandidate> {
  validation: Readonly<TurnValidation<TValidation>>;
}

export interface RuntimePlanner<
  TPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
> {
  plan(context: RuntimePlanningContext<TPayload>): Promise<TPlan>;
}

export interface RuntimeDrafter<
  TPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
> {
  draft(
    context: RuntimeDraftingContext<TPayload, TPlan>,
  ): Promise<TCandidate>;
}

export interface RuntimeValidator<
  TPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
> {
  validate(
    context: RuntimeValidationContext<TPayload, TPlan, TCandidate>,
  ): Promise<TValidation>;
}

export interface RuntimeReleaseBuilder<
  TPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
  TEvent extends JsonValue = JsonValue,
  TOutbox extends JsonValue = JsonValue,
> {
  build(
    context: RuntimeReleasingContext<
      TPayload,
      TPlan,
      TCandidate,
      TValidation
    >,
  ): Promise<RuntimeReleaseBundle<TEvent, TOutbox>>;
}

export interface RuntimeFailureClassification {
  disposition: TurnFailureDisposition;
  code: string;
  message: string;
}

export type RuntimeFailureClassifier = (
  error: unknown,
  stage: TurnStage,
) => RuntimeFailureClassification;

export interface TurnRuntimeDependencies<
  TPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
  TEvent extends JsonValue = JsonValue,
  TOutbox extends JsonValue = JsonValue,
> {
  repository: RuntimeRepository<
    TPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent,
    TOutbox
  >;
  planner: RuntimePlanner<TPayload, TPlan>;
  drafter: RuntimeDrafter<TPayload, TPlan, TCandidate>;
  validator: RuntimeValidator<TPayload, TPlan, TCandidate, TValidation>;
  releaseBuilder: RuntimeReleaseBuilder<
    TPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent,
    TOutbox
  >;
  failureClassifier?: RuntimeFailureClassifier;
  clock?: () => string;
  idFactory?: () => string;
  /**
   * Cleanup Phase 4 / Batch 2D：本 Turn 的本地取消信号（可选）。
   * continueTurn 在阶段开始/阶段失败 catch/进入下一阶段前检查；
   * retryTurn 在 signal 已 aborted 时拒绝重启 provider 请求。
   */
  signal?: AbortSignal;
}

export class RuntimeInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeInvariantError";
    this.code = code;
  }
}

export class RuntimeIdempotencyConflictError extends RuntimeInvariantError {
  constructor() {
    super(
      "COMMAND_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different command.",
    );
    this.name = "RuntimeIdempotencyConflictError";
  }
}

export class RuntimeConcurrencyError extends RuntimeInvariantError {
  constructor() {
    super(
      "TURN_REVISION_CONFLICT",
      "The Turn changed while this operation was in progress.",
    );
    this.name = "RuntimeConcurrencyError";
  }
}

export class RetryableTurnError extends Error {
  readonly code: string;
  readonly safeMessage: string;

  constructor(code: string, safeMessage = "The Turn step can be retried.") {
    super(safeMessage);
    this.name = "RetryableTurnError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

export class FatalTurnError extends Error {
  readonly code: string;
  readonly safeMessage: string;

  constructor(code: string, safeMessage = "The Turn cannot continue.") {
    super(safeMessage);
    this.name = "FatalTurnError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

export function createCommandFingerprint(
  command: RuntimeCommand,
): string {
  const normalized = normalizeCommand(command);
  return `cmd_${hash(
    canonicalJson({
      commandType: normalized.commandType,
      recordId: normalized.recordId,
      expectedRecordVersion: normalized.expectedRecordVersion,
      actorId: normalized.actorId,
      payload: normalized.payload,
    }),
  )}`;
}

export function createReleaseFingerprint(
  bundle: RuntimeReleaseBundle,
): string {
  validateReleaseBundle(bundle);
  return `release_${hash(canonicalJson(bundle))}`;
}

/** Accepts idempotently, then resumes every durable active checkpoint. */
export async function executeTurn<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
  TEvent extends JsonValue,
  TOutbox extends JsonValue,
>(
  command: RuntimeCommand<TPayload>,
  dependencies: TurnRuntimeDependencies<
    TPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent,
    TOutbox
  >,
): Promise<TurnRun<TPayload, TPlan, TCandidate, TValidation>> {
  const normalized = normalizeCommand(command);
  const commandFingerprint = createCommandFingerprint(normalized);
  const accepted = await dependencies.repository.acceptCommand({
    turnId: (dependencies.idFactory ?? defaultIdFactory)(),
    command: normalized,
    commandFingerprint,
    now: now(dependencies),
  });
  return continueTurn(accepted.run.turnId, dependencies);
}

/**
 * Recovers an accepted or in-progress Turn. retryable is intentionally not
 * restarted here; a caller must explicitly invoke retryTurn.
 */
export async function resumeTurn<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
  TEvent extends JsonValue,
  TOutbox extends JsonValue,
>(
  turnId: string,
  dependencies: TurnRuntimeDependencies<
    TPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent,
    TOutbox
  >,
): Promise<TurnRun<TPayload, TPlan, TCandidate, TValidation>> {
  return continueTurn(turnId, dependencies);
}

/** Explicitly restarts a retryable Turn from its failed durable stage. */
export async function retryTurn<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
  TEvent extends JsonValue,
  TOutbox extends JsonValue,
>(
  turnId: string,
  dependencies: TurnRuntimeDependencies<
    TPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent,
    TOutbox
  >,
): Promise<TurnRun<TPayload, TPlan, TCandidate, TValidation>> {
  // Batch 2D：已取消的 Turn 不重启 provider 请求（统一的取消终态）。
  if (dependencies.signal?.aborted) {
    throw new FatalTurnError(
      "TURN_CANCELLED",
      "已打断本次生成，内容没有写入记录。",
    );
  }
  let run = await requireTurn(dependencies.repository, turnId);
  if (run.state === "completed") return run;
  if (run.state !== "retryable") {
    throw new RuntimeInvariantError(
      "TURN_NOT_RETRYABLE",
      "Only a retryable Turn can be explicitly retried.",
    );
  }
  run = await dependencies.repository.restartTurn({
    turnId,
    expectedRevision: run.revision,
    now: now(dependencies),
  });
  return continueTurn(run.turnId, dependencies);
}

async function continueTurn<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
  TEvent extends JsonValue,
  TOutbox extends JsonValue,
>(
  turnId: string,
  dependencies: TurnRuntimeDependencies<
    TPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent,
    TOutbox
  >,
): Promise<TurnRun<TPayload, TPlan, TCandidate, TValidation>> {
  let run = await requireTurn(dependencies.repository, turnId);

  while (!isPausedOrTerminal(run.state)) {
    // Batch 2D：阶段开始前检查取消信号——取消后以统一终态 markTurnFailure，
    // 不进入下一阶段，不提交正式 release。
    if (dependencies.signal?.aborted) {
      if (run.state === "accepted") {
        // durable accepted 行保留（本批不新增 cancel 状态写入）；仅以内存
        // 失败形态返回统一的取消终态，不产生正式 Event/Outbox。
        return {
          ...run,
          currentFailure: {
            disposition: "failed",
            code: "TURN_CANCELLED",
            message: "已打断本次生成，内容没有写入记录。",
            stage: "planning",
            resumeFrom: "planning",
            attempt: 0,
            occurredAt: now(dependencies),
          },
        };
      }
      const stage: TurnStage = run.state as TurnStage;
      run = await pauseAfterFailure(
        run,
        stage,
        new FatalTurnError(
          "TURN_CANCELLED",
          "已打断本次生成，内容没有写入记录。",
        ),
        dependencies,
      );
      break;
    }
    switch (run.state) {
      case "accepted":
        run = await dependencies.repository.advanceTurn({
          turnId,
          expectedRevision: run.revision,
          expectedState: "accepted",
          nextState: "planning",
          now: now(dependencies),
        });
        break;

      case "planning": {
        run = await dependencies.repository.beginStageAttempt({
          turnId,
          expectedRevision: run.revision,
          stage: "planning",
          now: now(dependencies),
        });
        try {
          const body = await dependencies.planner.plan({
            turnId,
            command: clone(run.command),
            attempt: run.attempts.planning,
            ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          });
          assertJsonValue(body, "PLAN_NOT_JSON");
          run = await dependencies.repository.advanceTurn({
            turnId,
            expectedRevision: run.revision,
            expectedState: "planning",
            nextState: "drafting",
            plan: {
              planId: (dependencies.idFactory ?? defaultIdFactory)(),
              body,
              createdAt: now(dependencies),
            },
            now: now(dependencies),
          });
        } catch (error) {
          run = await pauseAfterFailure(
            run,
            "planning",
            cancelledOrOriginal(error, dependencies.signal),
            dependencies,
          );
        }
        break;
      }

      case "drafting": {
        const plan = requirePlan(run);
        run = await dependencies.repository.beginStageAttempt({
          turnId,
          expectedRevision: run.revision,
          stage: "drafting",
          now: now(dependencies),
        });
        try {
          const body = await dependencies.drafter.draft({
            turnId,
            command: clone(run.command),
            plan: clone(plan),
            attempt: run.attempts.drafting,
            ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          });
          assertJsonValue(body, "CANDIDATE_NOT_JSON");
          run = await dependencies.repository.advanceTurn({
            turnId,
            expectedRevision: run.revision,
            expectedState: "drafting",
            nextState: "validating",
            candidate: {
              candidateId: (dependencies.idFactory ?? defaultIdFactory)(),
              body,
              createdAt: now(dependencies),
              draftingAttempt: run.attempts.drafting,
            },
            now: now(dependencies),
          });
        } catch (error) {
          run = await pauseAfterFailure(
            run,
            "drafting",
            cancelledOrOriginal(error, dependencies.signal),
            dependencies,
          );
        }
        break;
      }

      case "validating": {
        const plan = requirePlan(run);
        const candidate = requireCandidate(run);
        run = await dependencies.repository.beginStageAttempt({
          turnId,
          expectedRevision: run.revision,
          stage: "validating",
          now: now(dependencies),
        });
        try {
          const body = await dependencies.validator.validate({
            turnId,
            command: clone(run.command),
            plan: clone(plan),
            candidate: clone(candidate),
            attempt: run.attempts.validating,
            ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          });
          assertJsonValue(body, "VALIDATION_NOT_JSON");
          run = await dependencies.repository.advanceTurn({
            turnId,
            expectedRevision: run.revision,
            expectedState: "validating",
            nextState: "releasing",
            validation: {
              validationId: (dependencies.idFactory ?? defaultIdFactory)(),
              body,
              createdAt: now(dependencies),
            },
            now: now(dependencies),
          });
        } catch (error) {
          run = await pauseAfterFailure(
            run,
            "validating",
            cancelledOrOriginal(error, dependencies.signal),
            dependencies,
          );
        }
        break;
      }

      case "releasing": {
        const plan = requirePlan(run);
        const candidate = requireCandidate(run);
        const validation = requireValidation(run);
        run = await dependencies.repository.beginStageAttempt({
          turnId,
          expectedRevision: run.revision,
          stage: "releasing",
          now: now(dependencies),
        });
        try {
          const bundle = await dependencies.releaseBuilder.build({
            turnId,
            command: clone(run.command),
            plan: clone(plan),
            candidate: clone(candidate),
            validation: clone(validation),
            attempt: run.attempts.releasing,
            ...(dependencies.signal ? { signal: dependencies.signal } : {}),
          });
          validateReleaseBundle(bundle);
          run = await dependencies.repository.commitRelease({
            turnId,
            expectedRevision: run.revision,
            bundle,
            releaseFingerprint: createReleaseFingerprint(bundle),
            now: now(dependencies),
          });
        } catch (error) {
          // A storage response may be lost after an atomic commit. Reload before
          // recording failure so a completed Turn is never downgraded.
          const latest = await requireTurn(dependencies.repository, turnId);
          if (latest.state === "completed") {
            run = latest;
          } else if (latest.state === "releasing") {
            run = await pauseAfterFailure(
              latest,
              "releasing",
              cancelledOrOriginal(error, dependencies.signal),
              dependencies,
            );
          } else {
            run = latest;
          }
        }
        break;
      }
    }
  }

  return run;
}

/** Batch 2D：阶段失败时若取消信号已 aborted，一律归为统一的取消终态。 */
function cancelledOrOriginal(error: unknown, signal?: AbortSignal): unknown {
  return signal?.aborted
    ? new FatalTurnError(
        "TURN_CANCELLED",
        "已打断本次生成，内容没有写入记录。",
      )
    : error;
}

async function pauseAfterFailure<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
  TEvent extends JsonValue,
  TOutbox extends JsonValue,
>(
  run: TurnRun<TPayload, TPlan, TCandidate, TValidation>,
  stage: TurnStage,
  error: unknown,
  dependencies: TurnRuntimeDependencies<
    TPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent,
    TOutbox
  >,
): Promise<TurnRun<TPayload, TPlan, TCandidate, TValidation>> {
  const classified = (dependencies.failureClassifier ?? classifyFailure)(
    error,
    stage,
  );
  const occurredAt = now(dependencies);
  return dependencies.repository.markTurnFailure({
    turnId: run.turnId,
    expectedRevision: run.revision,
    expectedState: stage,
    failure: {
      ...classified,
      stage,
      resumeFrom: stage,
      attempt: run.attempts[stage],
      occurredAt,
    },
    now: occurredAt,
  });
}

export function classifyFailure(error: unknown): RuntimeFailureClassification {
  if (error instanceof RetryableTurnError) {
    return {
      disposition: "retryable",
      code: error.code,
      message: error.safeMessage,
    };
  }
  if (error instanceof FatalTurnError) {
    return {
      disposition: "failed",
      code: error.code,
      message: error.safeMessage,
    };
  }
  if (error instanceof RuntimeInvariantError) {
    return {
      disposition: "failed",
      code: error.code,
      message: "The Turn violated a runtime invariant.",
    };
  }
  return {
    disposition: "failed",
    code: "TURN_STEP_FAILED",
    message: "The Turn step failed.",
  };
}

export interface InMemoryRuntimeRepositoryOptions {
  recordHeads?: readonly RuntimeRecordHead[];
}

/** Deterministic local adapter used by unit tests and local-only prototypes. */
export function createInMemoryRuntimeRepository<
  TCommandPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
  TEvent extends JsonValue = JsonValue,
  TOutbox extends JsonValue = JsonValue,
>(
  options: InMemoryRuntimeRepositoryOptions = {},
): RuntimeRepository<
  TCommandPayload,
  TPlan,
  TCandidate,
  TValidation,
  TEvent,
  TOutbox
> {
  const turns = new Map<
    string,
    TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>
  >();
  const commandIndex = new Map<string, string>();
  const heads = new Map(
    (options.recordHeads ?? []).map((head) => [head.recordId, clone(head)]),
  );
  const events = new Map<string, RuntimeCommittedEvent<TEvent>>();
  const outbox = new Map<string, RuntimeOutboxMessage<TOutbox>>();
  const outboxDedupe = new Map<string, string>();

  function getMutableTurn(
    turnId: string,
  ): TurnRun<TCommandPayload, TPlan, TCandidate, TValidation> {
    const run = turns.get(turnId);
    if (!run) {
      throw new RuntimeInvariantError("TURN_NOT_FOUND", "Turn not found.");
    }
    return run;
  }

  function assertTurnVersion(
    run: TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>,
    expectedRevision: number,
    expectedState?: TurnRunState,
  ): void {
    if (
      run.revision !== expectedRevision ||
      (expectedState !== undefined && run.state !== expectedState)
    ) {
      throw new RuntimeConcurrencyError();
    }
  }

  return {
    async acceptCommand(input) {
      const key = commandKey(input.command.recordId, input.command.idempotencyKey);
      const existingId = commandIndex.get(key);
      if (existingId) {
        const existing = getMutableTurn(existingId);
        if (existing.commandFingerprint !== input.commandFingerprint) {
          throw new RuntimeIdempotencyConflictError();
        }
        return { run: clone(existing), created: false };
      }
      if (turns.has(input.turnId)) {
        throw new RuntimeInvariantError(
          "TURN_ID_CONFLICT",
          "The generated Turn identifier already exists.",
        );
      }
      const run: TurnRun<
        TCommandPayload,
        TPlan,
        TCandidate,
        TValidation
      > = {
        turnId: input.turnId,
        command: clone(input.command),
        commandFingerprint: input.commandFingerprint,
        state: "accepted",
        revision: 0,
        attempts: emptyAttempts(),
        failures: [],
        transitions: [{ from: null, to: "accepted", at: input.now }],
        acceptedAt: input.now,
        updatedAt: input.now,
      };
      turns.set(run.turnId, run);
      commandIndex.set(key, run.turnId);
      return { run: clone(run), created: true };
    },

    async loadTurn(turnId) {
      const run = turns.get(turnId);
      return run ? clone(run) : null;
    },

    async advanceTurn(input) {
      const run = getMutableTurn(input.turnId);
      assertTurnVersion(run, input.expectedRevision, input.expectedState);
      const previous = run.state;
      if (input.nextState === "drafting") {
        run.plan = clone(input.plan) as TurnPlan<TPlan>;
      } else if (input.nextState === "validating") {
        run.candidate = clone(input.candidate) as TurnCandidate<TCandidate>;
      } else if (input.nextState === "releasing") {
        run.validation = clone(input.validation) as TurnValidation<TValidation>;
      }
      run.state = input.nextState;
      run.revision += 1;
      run.updatedAt = input.now;
      run.transitions = [
        ...run.transitions,
        { from: previous, to: input.nextState, at: input.now },
      ];
      return clone(run);
    },

    async beginStageAttempt(input) {
      const run = getMutableTurn(input.turnId);
      assertTurnVersion(run, input.expectedRevision, input.stage);
      run.attempts = {
        ...run.attempts,
        [input.stage]: run.attempts[input.stage] + 1,
      };
      run.revision += 1;
      run.updatedAt = input.now;
      return clone(run);
    },

    async markTurnFailure(input) {
      const run = getMutableTurn(input.turnId);
      assertTurnVersion(run, input.expectedRevision, input.expectedState);
      const previous = run.state;
      run.state = input.failure.disposition;
      run.currentFailure = clone(input.failure);
      run.failures = [...run.failures, clone(input.failure)];
      run.revision += 1;
      run.updatedAt = input.now;
      run.transitions = [
        ...run.transitions,
        { from: previous, to: run.state, at: input.now },
      ];
      return clone(run);
    },

    async restartTurn(input) {
      const run = getMutableTurn(input.turnId);
      assertTurnVersion(run, input.expectedRevision, "retryable");
      if (!run.currentFailure) {
        throw new RuntimeInvariantError(
          "RETRY_CHECKPOINT_MISSING",
          "Retryable Turn has no resume checkpoint.",
        );
      }
      const previous = run.state;
      run.state = run.currentFailure.resumeFrom;
      run.currentFailure = undefined;
      run.revision += 1;
      run.updatedAt = input.now;
      run.transitions = [
        ...run.transitions,
        { from: previous, to: run.state, at: input.now },
      ];
      return clone(run);
    },

    async commitRelease(input) {
      const run = getMutableTurn(input.turnId);
      if (run.state === "completed") {
        if (run.release?.releaseFingerprint !== input.releaseFingerprint) {
          throw new RuntimeInvariantError(
            "RELEASE_FINGERPRINT_CONFLICT",
            "Completed Turn was released with different formal effects.",
          );
        }
        return clone(run);
      }
      assertTurnVersion(run, input.expectedRevision, "releasing");
      validateReleaseBundle(input.bundle);
      if (createReleaseFingerprint(input.bundle) !== input.releaseFingerprint) {
        throw new RuntimeInvariantError(
          "RELEASE_FINGERPRINT_INVALID",
          "Release fingerprint does not match the formal effect bundle.",
        );
      }

      const head = heads.get(run.command.recordId);
      if (!head) {
        throw new FatalTurnError(
          "RECORD_NOT_FOUND",
          "The target Record no longer exists.",
        );
      }
      if (head.version !== run.command.expectedRecordVersion) {
        throw new FatalTurnError(
          "RECORD_VERSION_CONFLICT",
          "The Record changed before this Turn could be released.",
        );
      }
      assertUniqueReleaseIdentifiers(input.bundle, events, outbox, outboxDedupe);

      // This synchronous mutation block models one authoritative transaction:
      // formal events, Record head, Outbox, and completed Turn commit together.
      const nextVersion = head.version + 1;
      const committedEvents = input.bundle.formalEvents.map(
        (draft, index): RuntimeCommittedEvent<TEvent> => ({
          turnId: run.turnId,
          recordId: run.command.recordId,
          recordVersion: nextVersion,
          ordinal: head.nextOrdinal + index,
          eventId: draft.eventId,
          kind: draft.kind,
          payload: clone(draft.payload),
          committedAt: input.now,
        }),
      );
      const messages = input.bundle.outbox.map(
        (draft): RuntimeOutboxMessage<TOutbox> => ({
          messageId: draft.messageId,
          turnId: run.turnId,
          recordId: run.command.recordId,
          topic: draft.topic,
          dedupeKey: draft.dedupeKey,
          payload: clone(draft.payload),
          state: "pending",
          revision: 0,
          attempts: 0,
          availableAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        }),
      );

      for (const event of committedEvents) events.set(event.eventId, event);
      for (const message of messages) {
        outbox.set(message.messageId, message);
        outboxDedupe.set(message.dedupeKey, message.messageId);
      }
      heads.set(head.recordId, {
        ...head,
        version: nextVersion,
        nextOrdinal: head.nextOrdinal + committedEvents.length,
      });

      const previous = run.state;
      const receipt: RuntimeReleaseReceipt = {
        turnId: run.turnId,
        recordId: run.command.recordId,
        recordVersion: nextVersion,
        firstOrdinal: head.nextOrdinal,
        nextOrdinal: head.nextOrdinal + committedEvents.length,
        eventIds: committedEvents.map((event) => event.eventId),
        outboxMessageIds: messages.map((message) => message.messageId),
        releaseFingerprint: input.releaseFingerprint,
        committedAt: input.now,
      };
      run.release = receipt;
      run.state = "completed";
      run.revision += 1;
      run.updatedAt = input.now;
      run.completedAt = input.now;
      run.transitions = [
        ...run.transitions,
        { from: previous, to: "completed", at: input.now },
      ];
      return clone(run);
    },

    async loadRecordHead(recordId) {
      const head = heads.get(recordId);
      return head ? clone(head) : null;
    },

    async listCommittedEvents(recordId) {
      return clone(
        [...events.values()]
          .filter((event) => event.recordId === recordId)
          .sort((left, right) => left.ordinal - right.ordinal),
      );
    },

    async loadOutboxMessage(messageId) {
      const message = outbox.get(messageId);
      return message ? clone(message) : null;
    },

    async listOutboxMessages() {
      return clone(
        [...outbox.values()].sort((left, right) =>
          left.messageId.localeCompare(right.messageId),
        ),
      );
    },

    async claimOutbox(input) {
      const message = outbox.get(input.messageId);
      if (!message) {
        throw new RuntimeInvariantError(
          "OUTBOX_NOT_FOUND",
          "Outbox message not found.",
        );
      }
      const nowEpoch = timestampEpoch(input.now, "OUTBOX_NOW_INVALID");
      const leaseEpoch = timestampEpoch(
        input.leaseExpiresAt,
        "OUTBOX_LEASE_TIME_INVALID",
      );
      if (!input.leaseOwner.trim() || leaseEpoch <= nowEpoch) {
        throw new RuntimeInvariantError(
          "OUTBOX_LEASE_INVALID",
          "Outbox claims require an owner and a future lease expiry.",
        );
      }
      const ready =
        ["pending", "retryable"].includes(message.state) &&
        timestampEpoch(message.availableAt, "OUTBOX_AVAILABLE_TIME_INVALID") <=
          nowEpoch;
      const expiredDelivery =
        message.state === "delivering" &&
        message.leaseExpiresAt !== undefined &&
        timestampEpoch(
          message.leaseExpiresAt,
          "OUTBOX_LEASE_TIME_INVALID",
        ) <= nowEpoch;
      if (
        message.revision !== input.expectedRevision ||
        (!ready && !expiredDelivery)
      ) {
        throw new RuntimeConcurrencyError();
      }
      message.state = "delivering";
      message.revision += 1;
      message.attempts += 1;
      message.leaseOwner = input.leaseOwner.trim();
      message.leaseExpiresAt = input.leaseExpiresAt;
      message.updatedAt = input.now;
      return clone(message);
    },

    async settleOutbox(input) {
      const message = outbox.get(input.messageId);
      if (!message) {
        throw new RuntimeInvariantError(
          "OUTBOX_NOT_FOUND",
          "Outbox message not found.",
        );
      }
      if (
        message.revision !== input.expectedRevision ||
        message.state !== "delivering" ||
        message.leaseOwner !== input.leaseOwner ||
        message.leaseExpiresAt === undefined ||
        timestampEpoch(message.leaseExpiresAt, "OUTBOX_LEASE_TIME_INVALID") <=
          timestampEpoch(input.now, "OUTBOX_NOW_INVALID")
      ) {
        throw new RuntimeConcurrencyError();
      }
      if (input.outcome !== "delivered" && !input.failure) {
        throw new RuntimeInvariantError(
          "OUTBOX_FAILURE_REQUIRED",
          "Retryable and failed deliveries require a safe failure summary.",
        );
      }
      if (input.outcome === "retryable" && !input.retryAt) {
        throw new RuntimeInvariantError(
          "OUTBOX_RETRY_TIME_REQUIRED",
          "Retryable delivery requires a retry time.",
        );
      }
      if (
        input.outcome === "retryable" &&
        timestampEpoch(input.retryAt!, "OUTBOX_RETRY_TIME_INVALID") <=
          timestampEpoch(input.now, "OUTBOX_NOW_INVALID")
      ) {
        throw new RuntimeInvariantError(
          "OUTBOX_RETRY_TIME_INVALID",
          "Outbox retry time must be later than the settlement time.",
        );
      }
      message.state = input.outcome;
      message.revision += 1;
      message.updatedAt = input.now;
      message.leaseOwner = undefined;
      message.leaseExpiresAt = undefined;
      if (input.outcome === "delivered") {
        message.deliveredAt = input.now;
        message.lastFailure = undefined;
      } else {
        message.lastFailure = clone(input.failure!);
        if (input.outcome === "retryable") message.availableAt = input.retryAt!;
      }
      return clone(message);
    },
  };
}

function normalizeCommand<TPayload extends JsonValue>(
  command: RuntimeCommand<TPayload>,
): RuntimeCommand<TPayload> {
  const normalized = {
    ...command,
    commandType: command.commandType.trim(),
    recordId: command.recordId.trim(),
    idempotencyKey: command.idempotencyKey.trim(),
    actorId: command.actorId?.trim() || null,
    payload: clone(command.payload),
  };
  if (!normalized.commandType || !normalized.recordId) {
    throw new RuntimeInvariantError(
      "COMMAND_INVALID",
      "Command type and Record are required.",
    );
  }
  if (
    !normalized.idempotencyKey ||
    normalized.idempotencyKey.length > 128
  ) {
    throw new RuntimeInvariantError(
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency key must contain 1–128 characters.",
    );
  }
  if (
    !Number.isSafeInteger(normalized.expectedRecordVersion) ||
    normalized.expectedRecordVersion < 0
  ) {
    throw new RuntimeInvariantError(
      "RECORD_VERSION_INVALID",
      "Expected Record version must be a non-negative safe integer.",
    );
  }
  assertJsonValue(normalized.payload, "COMMAND_PAYLOAD_NOT_JSON");
  return normalized;
}

function validateReleaseBundle(bundle: RuntimeReleaseBundle): void {
  if (!Array.isArray(bundle.formalEvents) || bundle.formalEvents.length === 0) {
    throw new RuntimeInvariantError(
      "EMPTY_FORMAL_RELEASE",
      "A Turn release must contain at least one formal event.",
    );
  }
  if (!Array.isArray(bundle.outbox)) {
    throw new RuntimeInvariantError(
      "OUTBOX_INVALID",
      "Release Outbox drafts must be an array.",
    );
  }
  for (const event of bundle.formalEvents) {
    if (!event.eventId.trim() || !event.kind.trim()) {
      throw new RuntimeInvariantError(
        "FORMAL_EVENT_INVALID",
        "Formal events require an identifier and kind.",
      );
    }
    assertJsonValue(event.payload, "FORMAL_EVENT_PAYLOAD_NOT_JSON");
  }
  for (const message of bundle.outbox) {
    if (
      !message.messageId.trim() ||
      !message.topic.trim() ||
      !message.dedupeKey.trim()
    ) {
      throw new RuntimeInvariantError(
        "OUTBOX_DRAFT_INVALID",
        "Outbox drafts require message, topic, and dedupe identifiers.",
      );
    }
    assertJsonValue(message.payload, "OUTBOX_PAYLOAD_NOT_JSON");
  }
}

function assertUniqueReleaseIdentifiers<
  TEvent extends JsonValue,
  TOutbox extends JsonValue,
>(
  bundle: RuntimeReleaseBundle<TEvent, TOutbox>,
  events: ReadonlyMap<string, RuntimeCommittedEvent<TEvent>>,
  outbox: ReadonlyMap<string, RuntimeOutboxMessage<TOutbox>>,
  outboxDedupe: ReadonlyMap<string, string>,
): void {
  const eventIds = new Set<string>();
  for (const event of bundle.formalEvents) {
    if (eventIds.has(event.eventId) || events.has(event.eventId)) {
      throw new RuntimeInvariantError(
        "FORMAL_EVENT_ID_CONFLICT",
        "Formal event identifier is not unique.",
      );
    }
    eventIds.add(event.eventId);
  }
  const messageIds = new Set<string>();
  const dedupeKeys = new Set<string>();
  for (const message of bundle.outbox) {
    if (messageIds.has(message.messageId) || outbox.has(message.messageId)) {
      throw new RuntimeInvariantError(
        "OUTBOX_MESSAGE_ID_CONFLICT",
        "Outbox message identifier is not unique.",
      );
    }
    if (
      dedupeKeys.has(message.dedupeKey) ||
      outboxDedupe.has(message.dedupeKey)
    ) {
      throw new RuntimeInvariantError(
        "OUTBOX_DEDUPE_CONFLICT",
        "Outbox dedupe key is not unique.",
      );
    }
    messageIds.add(message.messageId);
    dedupeKeys.add(message.dedupeKey);
  }
}

function assertJsonValue(value: unknown, code: string): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new RuntimeInvariantError(
      code,
      "Persisted runtime artifacts must be finite JSON values.",
    );
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function requirePlan<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
>(
  run: TurnRun<TPayload, TPlan, TCandidate, TValidation>,
): TurnPlan<TPlan> {
  if (!run.plan) {
    throw new RuntimeInvariantError(
      "TURN_PLAN_MISSING",
      "The drafting checkpoint has no plan.",
    );
  }
  return run.plan;
}

function requireCandidate<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
>(
  run: TurnRun<TPayload, TPlan, TCandidate, TValidation>,
): TurnCandidate<TCandidate> {
  if (!run.candidate) {
    throw new RuntimeInvariantError(
      "TURN_CANDIDATE_MISSING",
      "The validation checkpoint has no candidate.",
    );
  }
  return run.candidate;
}

function requireValidation<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
>(
  run: TurnRun<TPayload, TPlan, TCandidate, TValidation>,
): TurnValidation<TValidation> {
  if (!run.validation) {
    throw new RuntimeInvariantError(
      "TURN_VALIDATION_MISSING",
      "The release checkpoint has no validation result.",
    );
  }
  return run.validation;
}

async function requireTurn<
  TPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
  TEvent extends JsonValue,
  TOutbox extends JsonValue,
>(
  repository: RuntimeRepository<
    TPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent,
    TOutbox
  >,
  turnId: string,
): Promise<TurnRun<TPayload, TPlan, TCandidate, TValidation>> {
  const run = await repository.loadTurn(turnId);
  if (!run) {
    throw new RuntimeInvariantError("TURN_NOT_FOUND", "Turn not found.");
  }
  return run;
}

function isPausedOrTerminal(state: TurnRunState): boolean {
  return ["retryable", "failed", "completed"].includes(state);
}

function emptyAttempts(): Record<TurnStage, number> {
  return { planning: 0, drafting: 0, validating: 0, releasing: 0 };
}

function commandKey(recordId: string, idempotencyKey: string): string {
  return `${recordId}\u0000${idempotencyKey}`;
}

function now(dependencies: { clock?: () => string }): string {
  return dependencies.clock?.() ?? new Date().toISOString();
}

function defaultIdFactory(): string {
  return crypto.randomUUID();
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function timestampEpoch(value: string, code: string): number {
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) {
    throw new RuntimeInvariantError(code, "Runtime timestamp is invalid.");
  }
  return epoch;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
