import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  FatalTurnError,
  RuntimeConcurrencyError,
  RuntimeIdempotencyConflictError,
  RuntimeInvariantError,
  createReleaseFingerprint,
  type AcceptCommandInput,
  type AcceptCommandResult,
  type AdvanceTurnInput,
  type BeginStageAttemptInput,
  type ClaimOutboxInput,
  type CommitRuntimeReleaseInput,
  type JsonValue,
  type MarkTurnFailureInput,
  type RestartTurnInput,
  type RuntimeCommittedEvent,
  type RuntimeFormalEventDraft,
  type RuntimeOutboxMessage,
  type RuntimeOutboxState,
  type RuntimeRecordHead,
  type RuntimeReleaseReceipt,
  type RuntimeRepository,
  type SettleOutboxInput,
  type TurnCandidate,
  type TurnPlan,
  type TurnRun,
  type TurnRunState,
  type TurnStage,
  type TurnValidation,
} from "../../modules/runtime/public.ts";
import {
  applyEffect,
  consumeResource,
  type ActionLedgerScope,
} from "../../modules/actions/engine.ts";
import {
  gateRecordActive,
  gateWorldWrite,
  isWorldWriteGateError,
} from "./world-write-gate.ts";

const RUNTIME_PAYLOAD_KEY = "__realmRuntimePayload";

export type PostgresCommittedEventKind =
  | "utterance.committed"
  | "narration.committed"
  | "action.transaction.committed"
  | "system.correction.committed";

export type PostgresObservationKind =
  | "direct"
  | "inferred"
  | "rumor"
  | "system_grant";

export interface PostgresWorldCursor {
  tick: number;
  ordinal: number;
  calendarId: string;
  display: string;
}

export interface PostgresObservationDraft {
  observationId: string;
  observerCharacterInstanceId: string;
  dedupeKey: string;
  kind: PostgresObservationKind;
  content: string;
  fidelity?: number;
  availableFrom?: Pick<PostgresWorldCursor, "tick" | "ordinal">;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface PostgresActionStateWrite {
  receiptId: string;
  transactionId: string;
  actorCharacterInstanceId: string;
  callFingerprint: string;
  receipt: JsonValue;
  costs: readonly {
    resourceId: string;
    amount: number;
  }[];
  effects: readonly {
    effectId: string;
    targetId: string;
    operation: "apply" | "remove";
  }[];
}

export interface PostgresVisibilityPolicyWrite {
  id: string;
  policyKey: string;
  kind: "restricted";
  restrictedDomainId: string;
  audienceCharacterInstanceIds: readonly string[];
}

export interface PostgresCharacterStateUpdate {
  characterInstanceId: string;
  statePatch: Readonly<Record<string, JsonValue>>;
}

export interface PostgresFormalEventWrite {
  sceneId: string;
  visibilityPolicyId: string;
  visibilityPolicy?: PostgresVisibilityPolicyWrite;
  eventKind: PostgresCommittedEventKind;
  actorParticipantId?: string | null;
  speakerName?: string;
  content?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
  observations?: readonly PostgresObservationDraft[];
  characterStateUpdates?: readonly PostgresCharacterStateUpdate[];
  actionState?: PostgresActionStateWrite;
}

export interface PostgresFormalEventMappingContext<
  TCommandPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
  TEvent extends JsonValue,
> {
  draft: Readonly<RuntimeFormalEventDraft<TEvent>>;
  run: Readonly<TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>>;
  eventIndex: number;
  recordVersion: number;
  recordOrdinal: number;
  worldCursor: Readonly<PostgresWorldCursor>;
  committedAt: string;
}

export interface PostgresWorldCursorAllocationContext<
  TCommandPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
> {
  run: Readonly<TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>>;
  previous: Readonly<
    Pick<PostgresWorldCursor, "tick" | "ordinal" | "calendarId" | "display">
  >;
  eventCount: number;
}

export interface PostgresRuntimeRepositoryOptions<
  TCommandPayload extends JsonValue,
  TPlan extends JsonValue,
  TCandidate extends JsonValue,
  TValidation extends JsonValue,
  TEvent extends JsonValue,
> {
  pool: Pool;
  workspaceId: string;
  /** Pure synchronous mapper. Model calls and other I/O must finish before commit. */
  mapFormalEvent(
    context: PostgresFormalEventMappingContext<
      TCommandPayload,
      TPlan,
      TCandidate,
      TValidation,
      TEvent
    >,
  ): PostgresFormalEventWrite;
  /** Optional pure allocator; the default advances ordinal at the current tick. */
  allocateWorldCursors?(
    context: PostgresWorldCursorAllocationContext<
      TCommandPayload,
      TPlan,
      TCandidate,
      TValidation
    >,
  ): readonly PostgresWorldCursor[];
}

interface ScopeRow extends QueryResultRow {
  world_id: string;
  worldline_id: string;
  calendar_id: string;
  display_time: string;
}

interface TurnRow extends QueryResultRow {
  run_checkpoint: unknown;
}

interface HeadRow extends QueryResultRow {
  record_version: string | number;
  next_record_ordinal: string | number;
}

interface WorldlineHeadRow extends QueryResultRow {
  head_tick: string | number;
  head_ordinal: string | number;
}

interface EventRow extends QueryResultRow {
  turn_run_id: string;
  record_id: string;
  record_version: string | number;
  record_ordinal: string | number;
  id: string;
  event_kind: string;
  payload: unknown;
  recorded_at: Date | string;
}

interface OutboxRow extends QueryResultRow {
  id: string;
  turn_run_id: string;
  record_id: string;
  topic: string;
  dedupe_key: string;
  payload: unknown;
  state: string;
  revision: string | number;
  attempt_count: number;
  available_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  published_at: Date | string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: Date | string | null;
}

/**
 * PostgreSQL adapter for the persistence-neutral RuntimeRepository port.
 * Every operation establishes an RLS workspace inside its own transaction.
 */
export function createPostgresRuntimeRepository<
  TCommandPayload extends JsonValue = JsonValue,
  TPlan extends JsonValue = JsonValue,
  TCandidate extends JsonValue = JsonValue,
  TValidation extends JsonValue = JsonValue,
  TEvent extends JsonValue = JsonValue,
  TOutbox extends JsonValue = JsonValue,
>(
  options: PostgresRuntimeRepositoryOptions<
    TCommandPayload,
    TPlan,
    TCandidate,
    TValidation,
    TEvent
  >,
): RuntimeRepository<
  TCommandPayload,
  TPlan,
  TCandidate,
  TValidation,
  TEvent,
  TOutbox
> {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) {
    throw new RuntimeInvariantError(
      "WORKSPACE_ID_INVALID",
      "PostgreSQL repositories require a Workspace identifier.",
    );
  }

  type Run = TurnRun<TCommandPayload, TPlan, TCandidate, TValidation>;

  async function lockedRun(client: PoolClient, turnId: string): Promise<Run> {
    const result = await client.query<TurnRow>(
      `SELECT run_checkpoint
       FROM turn_runs
       WHERE workspace_id = $1 AND id = $2
       FOR UPDATE`,
      [workspaceId, turnId],
    );
    if (result.rowCount !== 1) {
      throw new RuntimeInvariantError("TURN_NOT_FOUND", "Turn not found.");
    }
    return decodeRun<Run>(result.rows[0]!.run_checkpoint);
  }

  /**
   * v37 §D.0 两拍模式（C 面：archived 拒绝）：
   * ① 无锁只读 record 行取 worldId → ② gateWorldWrite（worlds FOR KEY
   * SHARE + active）→ ③ gateRecordActive（records FOR UPDATE + 非
   * archived）。锁序 worlds(KS)→records(FU) 全局一致；后续 record_heads
   * /worldlines/turn_runs 锁接在其后。gate 错误映射为 FatalTurnError
   * （archived admission 拒绝是确定性终态，非并发重试）。
   */
  async function gateRecordWritePath(
    client: PoolClient,
    recordId: string,
  ): Promise<void> {
    const record = await client.query<{ world_id: string }>(
      `SELECT world_id FROM records
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, recordId],
    );
    const recordRow = record.rows[0];
    if (!recordRow) {
      throw new FatalTurnError(
        "RECORD_NOT_FOUND",
        "The target Record no longer exists.",
      );
    }
    try {
      await gateWorldWrite(client, {
        workspaceId,
        worldId: recordRow.world_id,
      });
      await gateRecordActive(client, { workspaceId, recordId });
    } catch (error) {
      if (isWorldWriteGateError(error)) {
        throw new FatalTurnError(error.code, error.message);
      }
      throw error;
    }
  }

  /** 两拍①的 turnId→recordId 无锁预读（turn_runs 行锁保持 CAS 复核）。 */
  async function readTurnRecordId(
    client: PoolClient,
    turnId: string,
  ): Promise<string> {
    const result = await client.query<TurnRow>(
      `SELECT run_checkpoint
       FROM turn_runs
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, turnId],
    );
    if (result.rowCount !== 1) {
      throw new RuntimeInvariantError("TURN_NOT_FOUND", "Turn not found.");
    }
    return decodeRun<Run>(result.rows[0]!.run_checkpoint).command.recordId;
  }

  async function saveRun(client: PoolClient, run: Run): Promise<void> {
    const result = await client.query(
      `UPDATE turn_runs
       SET state = $3,
           revision = $4,
           attempts = $5::jsonb,
           plan_payload = $6::jsonb,
           candidate_payload = $7::jsonb,
           validation_summary = $8::jsonb,
           run_checkpoint = $9::jsonb,
           failure_history = $10::jsonb,
           transition_history = $11::jsonb,
           release_receipt = $12::jsonb,
           release_fingerprint = $13,
           completed_record_version = $14,
           last_error_code = $15,
           updated_at = $16::timestamptz,
           completed_at = $17::timestamptz
       WHERE workspace_id = $1 AND id = $2`,
      [
        workspaceId,
        run.turnId,
        run.state,
        run.revision,
        json(run.attempts),
        nullableArtifact(run.plan),
        nullableArtifact(run.candidate),
        nullableArtifact(run.validation),
        json(run),
        json(run.failures),
        json(run.transitions),
        run.release ? json(run.release) : null,
        run.release?.releaseFingerprint ?? null,
        run.release?.recordVersion ?? null,
        run.currentFailure?.code ?? null,
        run.updatedAt,
        run.completedAt ?? null,
      ],
    );
    if (result.rowCount !== 1) throw new RuntimeConcurrencyError();
  }

  function assertRun(
    run: Run,
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
    async acceptCommand(input: AcceptCommandInput<TCommandPayload>) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        // v37 §D.0：C 面 admission——archived 世界/记录拒绝（锁内重读）。
        await gateRecordWritePath(client, input.command.recordId);
        const scope = await requireRecordScope(client, workspaceId, input.command.recordId);
        const inserted = await client.query(
          `INSERT INTO command_inbox (
             workspace_id, world_id, worldline_id, record_id, id,
             principal_id, idempotency_key, request_fingerprint, command_kind,
             payload, expected_record_version, state, accepted_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, NULL, $6, $7, $8,
             $9::jsonb, $10, 'accepted', $11::timestamptz, $11::timestamptz
           )
           ON CONFLICT DO NOTHING`,
          [
            workspaceId,
            scope.world_id,
            scope.worldline_id,
            input.command.recordId,
            input.turnId,
            input.command.idempotencyKey,
            input.commandFingerprint,
            input.command.commandType,
            json({
              actorId: input.command.actorId,
              [RUNTIME_PAYLOAD_KEY]: input.command.payload,
            }),
            input.command.expectedRecordVersion,
            input.now,
          ],
        );

        if (inserted.rowCount === 1) {
          const run: Run = {
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
          await client.query(
            `INSERT INTO turn_runs (
               workspace_id, world_id, worldline_id, record_id, command_id, id,
               attempt_number, state, revision, attempts, run_checkpoint,
               failure_history, transition_history, created_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, $5, 1, 'accepted', 0,
               $6::jsonb, $7::jsonb, '[]'::jsonb, $8::jsonb,
               $9::timestamptz, $9::timestamptz
             )`,
            [
              workspaceId,
              scope.world_id,
              scope.worldline_id,
              input.command.recordId,
              input.turnId,
              json(run.attempts),
              json(run),
              json(run.transitions),
              input.now,
            ],
          );
          return { run: clone(run), created: true } satisfies AcceptCommandResult<TCommandPayload>;
        }

        const existing = await client.query<
          QueryResultRow & { request_fingerprint: string; run_checkpoint: unknown }
        >(
          `SELECT command.request_fingerprint, turn.run_checkpoint
           FROM command_inbox AS command
           JOIN turn_runs AS turn
             ON turn.workspace_id = command.workspace_id
            AND turn.command_id = command.id
           WHERE command.workspace_id = $1
             AND command.record_id = $2
             AND command.idempotency_key = $3
           ORDER BY turn.attempt_number DESC
           LIMIT 1`,
          [workspaceId, input.command.recordId, input.command.idempotencyKey],
        );
        if (existing.rowCount !== 1) {
          throw new RuntimeInvariantError(
            "TURN_ID_CONFLICT",
            "The generated Turn identifier already exists.",
          );
        }
        const row = existing.rows[0]!;
        if (row.request_fingerprint !== input.commandFingerprint) {
          throw new RuntimeIdempotencyConflictError();
        }
        return {
          run: clone(decodeRun<Run>(row.run_checkpoint)),
          created: false,
        } satisfies AcceptCommandResult<TCommandPayload>;
      });
    },

    async loadTurn(turnId) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query<TurnRow>(
          `SELECT run_checkpoint
           FROM turn_runs
           WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, turnId],
        );
        return result.rowCount === 1
          ? clone(decodeRun<Run>(result.rows[0]!.run_checkpoint))
          : null;
      });
    },

    async advanceTurn(input: AdvanceTurnInput<TPlan, TCandidate, TValidation>) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        await gateRecordWritePath(client, await readTurnRecordId(client, input.turnId));
        const run = await lockedRun(client, input.turnId);
        assertRun(run, input.expectedRevision, input.expectedState);
        assertTransition(input.expectedState, input.nextState);
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
        await saveRun(client, run);
        await markCommandProcessing(client, workspaceId, run, input.now);
        return clone(run);
      });
    },

    async beginStageAttempt(input: BeginStageAttemptInput) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        await gateRecordWritePath(client, await readTurnRecordId(client, input.turnId));
        const run = await lockedRun(client, input.turnId);
        assertRun(run, input.expectedRevision, input.stage);
        run.attempts = {
          ...run.attempts,
          [input.stage]: run.attempts[input.stage] + 1,
        };
        run.revision += 1;
        run.updatedAt = input.now;
        await saveRun(client, run);
        return clone(run);
      });
    },

    async markTurnFailure(input: MarkTurnFailureInput) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const run = await lockedRun(client, input.turnId);
        assertRun(run, input.expectedRevision, input.expectedState);
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
        await saveRun(client, run);
        await client.query(
          `UPDATE command_inbox
           SET state = $3, last_error_code = $4, updated_at = $5::timestamptz
           WHERE workspace_id = $1 AND id = $2`,
          [
            workspaceId,
            run.turnId,
            run.state === "failed" ? "failed" : "processing",
            input.failure.code,
            input.now,
          ],
        );
        return clone(run);
      });
    },

    async restartTurn(input: RestartTurnInput) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        await gateRecordWritePath(client, await readTurnRecordId(client, input.turnId));
        const run = await lockedRun(client, input.turnId);
        assertRun(run, input.expectedRevision, "retryable");
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
        await saveRun(client, run);
        await markCommandProcessing(client, workspaceId, run, input.now);
        return clone(run);
      });
    },

    async commitRelease(input: CommitRuntimeReleaseInput<TEvent, TOutbox>) {
      const computedFingerprint = createReleaseFingerprint(input.bundle);
      if (computedFingerprint !== input.releaseFingerprint) {
        throw new RuntimeInvariantError(
          "RELEASE_FINGERPRINT_INVALID",
          "Release fingerprint does not match the formal effect bundle.",
        );
      }
      assertDraftIdentifiers(input.bundle.formalEvents, input.bundle.outbox);

      try {
        return await inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
          // Record metadata is read without a row lock. Formal writer locks are
          // then acquired in the one global order: Record head, Worldline.
          const initial = await client.query<TurnRow>(
            `SELECT run_checkpoint FROM turn_runs
             WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, input.turnId],
          );
          if (initial.rowCount !== 1) {
            throw new RuntimeInvariantError("TURN_NOT_FOUND", "Turn not found.");
          }
          const initialRun = decodeRun<Run>(initial.rows[0]!.run_checkpoint);
          // v37 §D.0：C 面两拍——worlds(KEY SHARE)→records(FOR UPDATE)
          // gate 先于 record_heads/worldlines 锁（锁序全局一致）；
          // archived 世界/记录在此拒绝。
          await gateRecordWritePath(client, initialRun.command.recordId);
          const scope = await requireRecordScope(
            client,
            workspaceId,
            initialRun.command.recordId,
          );
          const headResult = await client.query<HeadRow>(
            `SELECT record_version, next_record_ordinal
             FROM record_heads
             WHERE workspace_id = $1 AND record_id = $2
             FOR UPDATE`,
            [workspaceId, initialRun.command.recordId],
          );
          if (headResult.rowCount !== 1) {
            throw new FatalTurnError(
              "RECORD_NOT_FOUND",
              "The target Record no longer exists.",
            );
          }
          const worldlineResult = await client.query<WorldlineHeadRow>(
            `SELECT head_tick, head_ordinal
             FROM worldlines
             WHERE workspace_id = $1 AND id = $2
             FOR UPDATE`,
            [workspaceId, scope.worldline_id],
          );
          if (worldlineResult.rowCount !== 1) {
            throw new FatalTurnError(
              "WORLDLINE_NOT_FOUND",
              "The target Worldline no longer exists.",
            );
          }

          const run = await lockedRun(client, input.turnId);
          if (run.state === "completed") {
            if (run.release?.releaseFingerprint !== input.releaseFingerprint) {
              throw new RuntimeInvariantError(
                "RELEASE_FINGERPRINT_CONFLICT",
                "Completed Turn was released with different formal effects.",
              );
            }
            return clone(run);
          }
          assertRun(run, input.expectedRevision, "releasing");

          const head = headResult.rows[0]!;
          const currentVersion = safeInteger(head.record_version, "RECORD_VERSION_INVALID");
          const firstOrdinal = safeInteger(
            head.next_record_ordinal,
            "RECORD_ORDINAL_INVALID",
          );
          if (currentVersion !== run.command.expectedRecordVersion) {
            throw new FatalTurnError(
              "RECORD_VERSION_CONFLICT",
              "The Record changed before this Turn could be released.",
            );
          }

          const worldlineHead = worldlineResult.rows[0]!;
          const previousCursor = {
            tick: safeInteger(worldlineHead.head_tick, "WORLD_CURSOR_INVALID"),
            ordinal: safeInteger(
              worldlineHead.head_ordinal,
              "WORLD_CURSOR_INVALID",
            ),
            calendarId: scope.calendar_id,
            display: scope.display_time,
          };
          const cursors = options.allocateWorldCursors?.({
            run: clone(run),
            previous: previousCursor,
            eventCount: input.bundle.formalEvents.length,
          }) ?? defaultWorldCursors(previousCursor, input.bundle.formalEvents.length);
          validateWorldCursors(cursors, previousCursor, input.bundle.formalEvents.length);

          const recordVersion = currentVersion + 1;
          const mapped = input.bundle.formalEvents.map((draft, eventIndex) => {
            const worldCursor = cursors[eventIndex]!;
            const write = options.mapFormalEvent({
              draft: clone(draft),
              run: clone(run),
              eventIndex,
              recordVersion,
              recordOrdinal: firstOrdinal + eventIndex,
              worldCursor,
              committedAt: input.now,
            });
            validateMappedEvent(write);
            return { draft, write, worldCursor, eventIndex };
          });

          const insertedVisibilityPolicies = new Set<string>();
          for (const item of mapped) {
            const policy = item.write.visibilityPolicy;
            if (!policy || insertedVisibilityPolicies.has(policy.id)) continue;
            insertedVisibilityPolicies.add(policy.id);
            await client.query(
              `INSERT INTO visibility_policies (
                 workspace_id, world_id, worldline_id, record_id, id,
                 policy_key, policy_version, policy_kind, restricted_domain_id,
                 audience_character_instance_ids
               ) VALUES (
                 $1, $2, $3, $4, $5,
                 $6, 1, $7, $8, $9::text[]
               )`,
              [
                workspaceId,
                scope.world_id,
                scope.worldline_id,
                run.command.recordId,
                policy.id,
                policy.policyKey,
                policy.kind,
                policy.restrictedDomainId,
                [...policy.audienceCharacterInstanceIds],
              ],
            );
          }

          // Clean-up Phase 2：全回合观察跨事件单条批量 INSERT——循环内只
          // 校验+收集，循环后一次写入（events 已在循环内逐条落库，FK 安全）。
          const pendingObservations: {
            observerId: string;
            sourceEventId: string;
            observationId: string;
            dedupeKey: string;
            kind: string;
            content: string;
            fidelity: number;
            occurredTick: number;
            occurredOrdinal: number;
            availableTick: number;
            availableOrdinal: number;
            metadata: string;
          }[] = [];
          for (const item of mapped) {
            await client.query(
              `INSERT INTO events (
                 workspace_id, world_id, worldline_id, record_id, scene_id, id,
                 record_version, record_ordinal, batch_index, event_kind,
                 actor_participant_id, speaker_name, content, payload,
                 visibility_policy_id, world_tick, world_ordinal, calendar_id,
                 display_time, causation_command_id, turn_run_id, recorded_at
               ) VALUES (
                 $1, $2, $3, $4, $5, $6,
                 $7, $8, $9, $10, $11, $12, $13, $14::jsonb,
                 $15, $16, $17, $18, $19, $20, $21, $22::timestamptz
               )`,
              [
                workspaceId,
                scope.world_id,
                scope.worldline_id,
                run.command.recordId,
                item.write.sceneId,
                item.draft.eventId,
                recordVersion,
                firstOrdinal + item.eventIndex,
                item.eventIndex,
                item.write.eventKind,
                item.write.actorParticipantId ?? null,
                item.write.speakerName ?? "",
                item.write.content ?? "",
                json(runtimeEnvelope(item.draft.payload, item.write.metadata)),
                item.write.visibilityPolicyId,
                item.worldCursor.tick,
                item.worldCursor.ordinal,
                item.worldCursor.calendarId,
                item.worldCursor.display,
                run.turnId,
                run.turnId,
                input.now,
              ],
            );

            const observationBatch = (item.write.observations ?? []).map(
              (observation) => {
                validateObservation(observation, item.worldCursor);
                const available = observation.availableFrom ?? item.worldCursor;
                return {
                  observerId: observation.observerCharacterInstanceId,
                  sourceEventId: item.draft.eventId,
                  observationId: observation.observationId,
                  dedupeKey: observation.dedupeKey,
                  kind: observation.kind,
                  content: observation.content,
                  fidelity: observation.fidelity ?? 1,
                  occurredTick: item.worldCursor.tick,
                  occurredOrdinal: item.worldCursor.ordinal,
                  availableTick: available.tick,
                  availableOrdinal: available.ordinal,
                  metadata: json(observation.metadata ?? {}),
                };
              },
            );
            pendingObservations.push(...observationBatch);

            if (item.write.actionState) {
              await applyActionState(
                client,
                workspaceId,
                scope,
                run.command.recordId,
                item.draft.eventId,
                item.worldCursor,
                item.write.actionState,
                input.now,
              );
            }
            for (const update of item.write.characterStateUpdates ?? []) {
              const updated = await client.query(
                `UPDATE character_instances
                 SET state = state || $5::jsonb,
                     updated_at = $6::timestamptz
                 WHERE workspace_id = $1
                   AND world_id = $2
                   AND worldline_id = $3
                   AND record_id = $4
                   AND id = $7`,
                [
                  workspaceId,
                  scope.world_id,
                  scope.worldline_id,
                  run.command.recordId,
                  json(update.statePatch),
                  input.now,
                  update.characterInstanceId,
                ],
              );
              if (updated.rowCount !== 1) {
                throw new FatalTurnError(
                  "CHARACTER_STATE_TARGET_NOT_FOUND",
                  "The character state target no longer exists in this Record.",
                );
              }
            }
          }

          if (pendingObservations.length > 0) {
            await client.query(
              `INSERT INTO observations (
                 workspace_id, world_id, worldline_id, record_id,
                 observer_character_instance_id, source_event_id, id,
                 dedupe_key, observation_kind, content, fidelity,
                 occurred_tick, occurred_ordinal,
                 available_from_tick, available_from_ordinal, learned_at,
                 metadata
               )
               SELECT
                 $1, $2, $3, $4,
                 batch.observer_id, batch.source_event_id, batch.observation_id,
                 batch.dedupe_key, batch.kind, batch.content, batch.fidelity,
                 batch.occurred_tick, batch.occurred_ordinal,
                 batch.available_tick, batch.available_ordinal,
                 $12::timestamptz, batch.metadata
               FROM unnest(
                 $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
                 $10::text[], $11::double precision[], $13::bigint[],
                 $14::bigint[], $15::bigint[], $16::bigint[], $17::jsonb[]
               ) AS batch(
                 observer_id, source_event_id, observation_id, dedupe_key,
                 kind, content, fidelity, occurred_tick, occurred_ordinal,
                 available_tick, available_ordinal, metadata
               )`,
              [
                workspaceId,
                scope.world_id,
                scope.worldline_id,
                run.command.recordId,
                pendingObservations.map((row) => row.observerId),
                pendingObservations.map((row) => row.sourceEventId),
                pendingObservations.map((row) => row.observationId),
                pendingObservations.map((row) => row.dedupeKey),
                pendingObservations.map((row) => row.kind),
                pendingObservations.map((row) => row.content),
                pendingObservations.map((row) => row.fidelity),
                input.now,
                pendingObservations.map((row) => row.occurredTick),
                pendingObservations.map((row) => row.occurredOrdinal),
                pendingObservations.map((row) => row.availableTick),
                pendingObservations.map((row) => row.availableOrdinal),
                pendingObservations.map((row) => row.metadata),
              ],
            );
          }

          const lastEvent = mapped.at(-1)!;
          const nextOrdinal = firstOrdinal + mapped.length;
          await client.query(
            `UPDATE record_heads
             SET record_version = $3,
                 next_record_ordinal = $4,
                 last_event_id = $5,
                 last_world_tick = $6,
                 last_world_ordinal = $7,
                 updated_at = $8::timestamptz
             WHERE workspace_id = $1 AND record_id = $2`,
            [
              workspaceId,
              run.command.recordId,
              recordVersion,
              nextOrdinal,
              lastEvent.draft.eventId,
              lastEvent.worldCursor.tick,
              lastEvent.worldCursor.ordinal,
              input.now,
            ],
          );
          await client.query(
            `UPDATE worldlines
             SET head_tick = $3, head_ordinal = $4, updated_at = $5::timestamptz
             WHERE workspace_id = $1 AND id = $2`,
            [
              workspaceId,
              scope.worldline_id,
              lastEvent.worldCursor.tick,
              lastEvent.worldCursor.ordinal,
              input.now,
            ],
          );

          for (const draft of input.bundle.outbox) {
            await client.query(
              `INSERT INTO outbox (
                 workspace_id, world_id, worldline_id, record_id,
                 event_id, turn_run_id, id, dedupe_key, topic, payload,
                 state, revision, attempt_count, available_at, created_at, updated_at
               ) VALUES (
                 $1, $2, $3, $4, NULL, $5, $6, $7, $8, $9::jsonb,
                 'pending', 0, 0, $10::timestamptz, $10::timestamptz, $10::timestamptz
               )`,
              [
                workspaceId,
                scope.world_id,
                scope.worldline_id,
                run.command.recordId,
                run.turnId,
                draft.messageId,
                draft.dedupeKey,
                draft.topic,
                json(runtimeEnvelope(draft.payload)),
                input.now,
              ],
            );
          }

          const previousState = run.state;
          const receipt: RuntimeReleaseReceipt = {
            turnId: run.turnId,
            recordId: run.command.recordId,
            recordVersion,
            firstOrdinal,
            nextOrdinal,
            eventIds: input.bundle.formalEvents.map((event) => event.eventId),
            outboxMessageIds: input.bundle.outbox.map((message) => message.messageId),
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
            { from: previousState, to: "completed", at: input.now },
          ];
          await saveRun(client, run);
          await client.query(
            `UPDATE command_inbox
             SET state = 'completed', result_event_ids = $3::text[],
                 completed_at = $4::timestamptz, updated_at = $4::timestamptz,
                 last_error_code = NULL
             WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, run.turnId, receipt.eventIds, input.now],
          );
          return clone(run);
        });
      } catch (error) {
        throw translatePostgresConflict(error);
      }
    },

    async loadRecordHead(recordId) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query<HeadRow>(
          `SELECT record_version, next_record_ordinal
           FROM record_heads
           WHERE workspace_id = $1 AND record_id = $2`,
          [workspaceId, recordId],
        );
        if (result.rowCount !== 1) return null;
        return {
          recordId,
          version: safeInteger(result.rows[0]!.record_version, "RECORD_VERSION_INVALID"),
          nextOrdinal: safeInteger(
            result.rows[0]!.next_record_ordinal,
            "RECORD_ORDINAL_INVALID",
          ),
        } satisfies RuntimeRecordHead;
      });
    },

    async listCommittedEvents(recordId) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query<EventRow>(
          `SELECT turn_run_id, record_id, record_version, record_ordinal,
                  id, event_kind, payload, recorded_at
           FROM events
           WHERE workspace_id = $1 AND record_id = $2
             AND turn_run_id IS NOT NULL
           ORDER BY record_ordinal`,
          [workspaceId, recordId],
        );
        return result.rows.map((row): RuntimeCommittedEvent<TEvent> => ({
          turnId: row.turn_run_id,
          recordId: row.record_id,
          recordVersion: safeInteger(row.record_version, "RECORD_VERSION_INVALID"),
          ordinal: safeInteger(row.record_ordinal, "RECORD_ORDINAL_INVALID"),
          eventId: row.id,
          kind: row.event_kind,
          payload: runtimePayload<TEvent>(row.payload),
          committedAt: iso(row.recorded_at),
        }));
      });
    },

    async loadOutboxMessage(messageId) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query<OutboxRow>(
          `${outboxSelect()}
           WHERE workspace_id = $1 AND id = $2
             AND turn_run_id IS NOT NULL`,
          [workspaceId, messageId],
        );
        return result.rowCount === 1
          ? toOutboxMessage<TOutbox>(result.rows[0]!)
          : null;
      });
    },

    async listOutboxMessages() {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const result = await client.query<OutboxRow>(
          `${outboxSelect()}
           WHERE workspace_id = $1
             AND turn_run_id IS NOT NULL
           ORDER BY id`,
          [workspaceId],
        );
        return result.rows.map(toOutboxMessage<TOutbox>);
      });
    },

    async claimOutbox(input: ClaimOutboxInput) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const row = await lockedOutbox(client, workspaceId, input.messageId);
        const message = toOutboxMessage<TOutbox>(row);
        const nowEpoch = epoch(input.now, "OUTBOX_NOW_INVALID");
        const leaseEpoch = epoch(input.leaseExpiresAt, "OUTBOX_LEASE_TIME_INVALID");
        if (!input.leaseOwner.trim() || leaseEpoch <= nowEpoch) {
          throw new RuntimeInvariantError(
            "OUTBOX_LEASE_INVALID",
            "Outbox claims require an owner and a future lease expiry.",
          );
        }
        const ready =
          ["pending", "retryable"].includes(message.state) &&
          epoch(message.availableAt, "OUTBOX_AVAILABLE_TIME_INVALID") <= nowEpoch;
        const expired =
          message.state === "delivering" &&
          message.leaseExpiresAt !== undefined &&
          epoch(message.leaseExpiresAt, "OUTBOX_LEASE_TIME_INVALID") <= nowEpoch;
        if (message.revision !== input.expectedRevision || (!ready && !expired)) {
          throw new RuntimeConcurrencyError();
        }
        const result = await client.query<OutboxRow>(
          `${outboxUpdateReturning(`
             state = 'delivering', revision = revision + 1,
             attempt_count = attempt_count + 1,
             lease_owner = $3, lease_expires_at = $4::timestamptz,
             updated_at = $5::timestamptz
           `)}`,
          [
            workspaceId,
            input.messageId,
            input.leaseOwner.trim(),
            input.leaseExpiresAt,
            input.now,
          ],
        );
        return toOutboxMessage<TOutbox>(result.rows[0]!);
      });
    },

    async settleOutbox(input: SettleOutboxInput) {
      return inWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        const row = await lockedOutbox(client, workspaceId, input.messageId);
        const message = toOutboxMessage<TOutbox>(row);
        if (
          message.revision !== input.expectedRevision ||
          message.state !== "delivering" ||
          message.leaseOwner !== input.leaseOwner ||
          message.leaseExpiresAt === undefined ||
          epoch(message.leaseExpiresAt, "OUTBOX_LEASE_TIME_INVALID") <=
            epoch(input.now, "OUTBOX_NOW_INVALID")
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
          epoch(input.retryAt!, "OUTBOX_RETRY_TIME_INVALID") <=
            epoch(input.now, "OUTBOX_NOW_INVALID")
        ) {
          throw new RuntimeInvariantError(
            "OUTBOX_RETRY_TIME_INVALID",
            "Outbox retry time must be later than the settlement time.",
          );
        }

        const delivered = input.outcome === "delivered";
        const result = await client.query<OutboxRow>(
          `${outboxUpdateReturning(`
             state = $3, revision = revision + 1,
             available_at = CASE WHEN $3 = 'retryable'
               THEN $4::timestamptz ELSE available_at END,
             lease_owner = NULL, lease_expires_at = NULL,
             published_at = CASE WHEN $3 = 'delivered'
               THEN $5::timestamptz ELSE published_at END,
             last_error_code = $6,
             last_error_message = $7,
             last_error_at = $8::timestamptz,
             updated_at = $5::timestamptz
           `)}`,
          [
            workspaceId,
            input.messageId,
            input.outcome,
            input.retryAt ?? null,
            input.now,
            delivered ? null : input.failure!.code,
            delivered ? null : input.failure!.message,
            delivered ? null : input.failure!.occurredAt,
          ],
        );
        return toOutboxMessage<TOutbox>(result.rows[0]!);
      });
    },
  };
}

async function inWorkspaceTransaction<T>(
  pool: Pool,
  workspaceId: string,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('realm.workspace_id', $1, true)",
      [workspaceId],
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Releasing the client is the final transaction cleanup fence.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function requireRecordScope(
  client: PoolClient,
  workspaceId: string,
  recordId: string,
): Promise<ScopeRow> {
  const result = await client.query<ScopeRow>(
    `SELECT record.world_id, record.worldline_id, world.calendar_id,
       COALESCE(world.settings->>'displayTime', '') AS display_time
     FROM records AS record
     JOIN worlds AS world
       ON world.workspace_id = record.workspace_id
      AND world.id = record.world_id
     WHERE record.workspace_id = $1 AND record.id = $2
       AND record.status <> 'archived'`,
    [workspaceId, recordId],
  );
  if (result.rowCount !== 1) {
    throw new FatalTurnError("RECORD_NOT_FOUND", "The target Record no longer exists.");
  }
  return result.rows[0]!;
}

async function markCommandProcessing(
  client: PoolClient,
  workspaceId: string,
  run: TurnRun,
  now: string,
): Promise<void> {
  await client.query(
    `UPDATE command_inbox
     SET state = 'processing', started_at = COALESCE(started_at, $3::timestamptz),
         updated_at = $3::timestamptz, last_error_code = NULL
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, run.turnId, now],
  );
}

function assertTransition(from: TurnRunState, to: TurnRunState): void {
  const allowed: Readonly<Record<string, string>> = {
    accepted: "planning",
    planning: "drafting",
    drafting: "validating",
    validating: "releasing",
  };
  if (allowed[from] !== to) {
    throw new RuntimeInvariantError(
      "TURN_TRANSITION_INVALID",
      "The requested Turn state transition is invalid.",
    );
  }
}

function defaultWorldCursors(
  previous: Pick<PostgresWorldCursor, "tick" | "ordinal" | "calendarId">,
  count: number,
): readonly PostgresWorldCursor[] {
  return Array.from({ length: count }, (_, index) => ({
    tick: previous.tick,
    ordinal: previous.ordinal + index + 1,
    calendarId: previous.calendarId,
    display: "",
  }));
}

function validateWorldCursors(
  cursors: readonly PostgresWorldCursor[],
  previous: Pick<PostgresWorldCursor, "tick" | "ordinal">,
  expectedCount: number,
): void {
  if (cursors.length !== expectedCount) {
    throw new RuntimeInvariantError(
      "WORLD_CURSOR_ALLOCATION_INVALID",
      "World cursor allocation must return one cursor per formal event.",
    );
  }
  let prior = previous;
  for (const cursor of cursors) {
    if (
      !Number.isSafeInteger(cursor.tick) ||
      !Number.isSafeInteger(cursor.ordinal) ||
      cursor.tick < 0 ||
      cursor.ordinal < 0 ||
      !cursor.calendarId.trim() ||
      compareCursor(cursor, prior) <= 0
    ) {
      throw new RuntimeInvariantError(
        "WORLD_CURSOR_ALLOCATION_INVALID",
        "Allocated world cursors must be valid and strictly increasing.",
      );
    }
    prior = cursor;
  }
}

function compareCursor(
  left: Pick<PostgresWorldCursor, "tick" | "ordinal">,
  right: Pick<PostgresWorldCursor, "tick" | "ordinal">,
): number {
  return left.tick === right.tick
    ? left.ordinal - right.ordinal
    : left.tick - right.tick;
}

function validateMappedEvent(write: PostgresFormalEventWrite): void {
  if (!write.sceneId.trim() || !write.visibilityPolicyId.trim()) {
    throw new RuntimeInvariantError(
      "POSTGRES_EVENT_MAPPING_INVALID",
      "Committed events require a Scene and immutable visibility policy.",
    );
  }
  if (write.visibilityPolicy) {
    const policy = write.visibilityPolicy;
    const audience = policy.audienceCharacterInstanceIds;
    if (
      policy.kind !== "restricted"
      || !policy.id.trim()
      || !policy.policyKey.trim()
      || !policy.restrictedDomainId.trim()
      || policy.id !== write.visibilityPolicyId
      || audience.length === 0
      || new Set(audience).size !== audience.length
      || audience.some((id) => !id.trim())
    ) {
      throw new RuntimeInvariantError(
        "POSTGRES_EVENT_MAPPING_INVALID",
        "Dynamic visibility policies require a restricted domain and unique audience.",
      );
    }
  }
  const kinds: readonly string[] = [
    "utterance.committed",
    "narration.committed",
    "action.transaction.committed",
    "system.correction.committed",
  ];
  if (!kinds.includes(write.eventKind)) {
    throw new RuntimeInvariantError(
      "POSTGRES_EVENT_MAPPING_INVALID",
      "Mapped event kind is not part of Runtime Contract v1.",
    );
  }
  if (write.actionState) {
    validateActionState(write.actionState);
    if (write.eventKind !== "action.transaction.committed") {
      throw new RuntimeInvariantError(
        "POSTGRES_ACTION_STATE_MAPPING_INVALID",
        "Durable Action state must be attached to its Action Transaction Event.",
      );
    }
  }
}

function validateActionState(write: PostgresActionStateWrite): void {
  if (
    !write.receiptId.trim()
    || !write.transactionId.trim()
    || !write.actorCharacterInstanceId.trim()
    || !write.callFingerprint.trim()
    || !isObject(write.receipt)
    || write.costs.some((cost) =>
      !cost.resourceId.trim()
      || !Number.isSafeInteger(cost.amount)
      || cost.amount <= 0
    )
    || write.effects.some((effect) =>
      !effect.effectId.trim()
      || !effect.targetId.trim()
      || !["apply", "remove"].includes(effect.operation)
    )
  ) {
    throw new RuntimeInvariantError(
      "POSTGRES_ACTION_STATE_MAPPING_INVALID",
      "Durable Action state requires valid receipt, actor, cost and effect data.",
    );
  }
}

async function applyActionState(
  client: PoolClient,
  workspaceId: string,
  scope: ScopeRow,
  recordId: string,
  sourceEventId: string,
  cursor: PostgresWorldCursor,
  write: PostgresActionStateWrite,
  now: string,
): Promise<void> {
  await client.query(
    `INSERT INTO action_receipts (
       workspace_id, world_id, worldline_id, record_id,
       actor_character_instance_id, source_event_id, id, transaction_id,
       call_fingerprint, receipt, world_tick, world_ordinal, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
       $13::timestamptz
     )`,
    [
      workspaceId,
      scope.world_id,
      scope.worldline_id,
      recordId,
      write.actorCharacterInstanceId,
      sourceEventId,
      write.receiptId,
      write.transactionId,
      write.callFingerprint,
      json(write.receipt),
      cursor.tick,
      cursor.ordinal,
      now,
    ],
  );

  const ledgerScope: ActionLedgerScope = {
    workspaceId,
    worldId: scope.world_id,
    worldlineId: scope.worldline_id,
    recordId,
    actorCharacterInstanceId: write.actorCharacterInstanceId,
  };

  for (const cost of write.costs) {
    await consumeResource(client, ledgerScope, cost, now);
  }

  for (const effect of write.effects) {
    await applyEffect(
      client,
      ledgerScope,
      effect,
      {
        receiptId: write.receiptId,
        transactionId: write.transactionId,
        tick: cursor.tick,
        ordinal: cursor.ordinal,
      },
      now,
    );
  }
}

function validateObservation(
  observation: PostgresObservationDraft,
  occurred: Pick<PostgresWorldCursor, "tick" | "ordinal">,
): void {
  const available = observation.availableFrom ?? occurred;
  if (
    !observation.observationId.trim() ||
    !observation.observerCharacterInstanceId.trim() ||
    !observation.dedupeKey.trim() ||
    !observation.content.trim() ||
    compareCursor(available, occurred) < 0 ||
    (observation.fidelity !== undefined &&
      (!Number.isFinite(observation.fidelity) ||
        observation.fidelity < 0 ||
        observation.fidelity > 1))
  ) {
    throw new RuntimeInvariantError(
      "POSTGRES_OBSERVATION_MAPPING_INVALID",
      "Mapped observations must have valid identity, content, fidelity, and availability.",
    );
  }
}

function assertDraftIdentifiers(
  events: readonly { eventId: string }[],
  messages: readonly { messageId: string; dedupeKey: string }[],
): void {
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    throw new RuntimeInvariantError(
      "FORMAL_EVENT_ID_CONFLICT",
      "Formal event identifier is not unique.",
    );
  }
  if (new Set(messages.map((message) => message.messageId)).size !== messages.length) {
    throw new RuntimeInvariantError(
      "OUTBOX_MESSAGE_ID_CONFLICT",
      "Outbox message identifier is not unique.",
    );
  }
  if (new Set(messages.map((message) => message.dedupeKey)).size !== messages.length) {
    throw new RuntimeInvariantError(
      "OUTBOX_DEDUPE_CONFLICT",
      "Outbox dedupe key is not unique.",
    );
  }
}

function runtimeEnvelope(
  payload: JsonValue,
  metadata: Readonly<Record<string, JsonValue>> = {},
): Record<string, JsonValue> {
  return { ...metadata, [RUNTIME_PAYLOAD_KEY]: clone(payload) };
}

function runtimePayload<T extends JsonValue>(value: unknown): T {
  if (!isObject(value) || !(RUNTIME_PAYLOAD_KEY in value)) {
    throw new RuntimeInvariantError(
      "POSTGRES_RUNTIME_PAYLOAD_INVALID",
      "Persisted runtime payload envelope is missing.",
    );
  }
  return clone(value[RUNTIME_PAYLOAD_KEY] as T);
}

function nullableArtifact(value: unknown): string | null {
  return value === undefined ? null : json({ value });
}

function decodeRun<T>(value: unknown): T {
  if (!isObject(value) || typeof value.turnId !== "string") {
    throw new RuntimeInvariantError(
      "TURN_CHECKPOINT_INVALID",
      "Persisted Turn checkpoint is missing or invalid.",
    );
  }
  return clone(value as T);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function emptyAttempts(): Record<TurnStage, number> {
  return { planning: 0, drafting: 0, validating: 0, releasing: 0 };
}

function safeInteger(value: string | number, code: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RuntimeInvariantError(code, "Persisted integer is outside the safe range.");
  }
  return result;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new RuntimeInvariantError("RUNTIME_TIMESTAMP_INVALID", "Persisted timestamp is invalid.");
  }
  return date.toISOString();
}

function epoch(value: string, code: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) {
    throw new RuntimeInvariantError(code, "Runtime timestamp is invalid.");
  }
  return result;
}

function outboxSelect(): string {
  return `SELECT id, turn_run_id, record_id, topic, dedupe_key, payload,
                 state, revision, attempt_count, available_at,
                 lease_owner, lease_expires_at, created_at, updated_at,
                 published_at, last_error_code, last_error_message, last_error_at
          FROM outbox`;
}

async function lockedOutbox(
  client: PoolClient,
  workspaceId: string,
  messageId: string,
): Promise<OutboxRow> {
  const result = await client.query<OutboxRow>(
    `${outboxSelect()} WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, messageId],
  );
  if (result.rowCount !== 1) {
    throw new RuntimeInvariantError("OUTBOX_NOT_FOUND", "Outbox message not found.");
  }
  return result.rows[0]!;
}

function outboxUpdateReturning(setClause: string): string {
  return `UPDATE outbox SET ${setClause}
          WHERE workspace_id = $1 AND id = $2
          RETURNING id, turn_run_id, record_id, topic, dedupe_key, payload,
                    state, revision, attempt_count, available_at,
                    lease_owner, lease_expires_at, created_at, updated_at,
                    published_at, last_error_code, last_error_message, last_error_at`;
}

function toOutboxMessage<T extends JsonValue>(
  row: OutboxRow,
): RuntimeOutboxMessage<T> {
  const state = normalizeOutboxState(row.state);
  const message: RuntimeOutboxMessage<T> = {
    messageId: row.id,
    turnId: row.turn_run_id,
    recordId: row.record_id,
    topic: row.topic,
    dedupeKey: row.dedupe_key,
    payload: runtimePayload<T>(row.payload),
    state,
    revision: safeInteger(row.revision, "OUTBOX_REVISION_INVALID"),
    attempts: safeInteger(row.attempt_count, "OUTBOX_ATTEMPT_INVALID"),
    availableAt: iso(row.available_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
  if (row.lease_owner !== null) message.leaseOwner = row.lease_owner;
  if (row.lease_expires_at !== null) message.leaseExpiresAt = iso(row.lease_expires_at);
  if (row.published_at !== null) message.deliveredAt = iso(row.published_at);
  if (
    row.last_error_code !== null &&
    row.last_error_message !== null &&
    row.last_error_at !== null
  ) {
    message.lastFailure = {
      code: row.last_error_code,
      message: row.last_error_message,
      occurredAt: iso(row.last_error_at),
    };
  }
  return message;
}

function normalizeOutboxState(value: string): RuntimeOutboxState {
  const compatibility: Readonly<Record<string, RuntimeOutboxState>> = {
    dispatching: "delivering",
    published: "delivered",
    dead_letter: "failed",
  };
  const normalized = compatibility[value] ?? value;
  if (!["pending", "delivering", "retryable", "delivered", "failed"].includes(normalized)) {
    throw new RuntimeInvariantError("OUTBOX_STATE_INVALID", "Persisted Outbox state is invalid.");
  }
  return normalized as RuntimeOutboxState;
}

function translatePostgresConflict(error: unknown): unknown {
  if (!isObject(error) || error.code !== "23505") return error;
  const constraint = typeof error.constraint === "string" ? error.constraint : "";
  if (constraint.includes("events") || constraint.includes("event")) {
    return new RuntimeInvariantError(
      "FORMAL_EVENT_ID_CONFLICT",
      "Formal event identifier is not unique.",
    );
  }
  if (constraint.includes("dedupe")) {
    return new RuntimeInvariantError(
      "OUTBOX_DEDUPE_CONFLICT",
      "Outbox dedupe key is not unique.",
    );
  }
  if (constraint.includes("outbox")) {
    return new RuntimeInvariantError(
      "OUTBOX_MESSAGE_ID_CONFLICT",
      "Outbox message identifier is not unique.",
    );
  }
  return error;
}
