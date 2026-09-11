import assert from "node:assert/strict";
import test from "node:test";
import {
  FatalTurnError,
  RetryableTurnError,
  RuntimeConcurrencyError,
  RuntimeIdempotencyConflictError,
  RuntimeInvariantError,
  createCommandFingerprint,
  createInMemoryRuntimeRepository,
  executeTurn,
  resumeTurn,
  retryTurn,
  type RuntimeCommand,
  type RuntimeRepository,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";

type CommandPayload = { text: string; options?: { quiet: boolean } };
type PlanBody = { objective: string };
type CandidateBody = { speaker: string; text: string };
type ValidationBody = { accepted: boolean; rule: string };
type EventPayload = {
  candidateId: string;
  speaker: string;
  content: string;
};
type OutboxPayload = { recordId: string; eventId: string };

type TestRepository = RuntimeRepository<
  CommandPayload,
  PlanBody,
  CandidateBody,
  ValidationBody,
  EventPayload,
  OutboxPayload
>;

function createCommand(
  overrides: Partial<RuntimeCommand<CommandPayload>> = {},
): RuntimeCommand<CommandPayload> {
  return {
    commandType: "player.utterance",
    recordId: "record-1",
    expectedRecordVersion: 0,
    idempotencyKey: "command-1",
    actorId: "participant-player",
    payload: { text: "检查蜡封。" },
    ...overrides,
  };
}

function deterministicIds(prefix = "runtime") {
  let sequence = 0;
  return () => `${prefix}-${++sequence}`;
}

function tickingClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 13, 0, 0, tick++)).toISOString();
}

function createRepository(): TestRepository {
  return createInMemoryRuntimeRepository<
    CommandPayload,
    PlanBody,
    CandidateBody,
    ValidationBody,
    EventPayload,
    OutboxPayload
  >({
    recordHeads: [{ recordId: "record-1", version: 0, nextOrdinal: 7 }],
  });
}

function createDependencies(
  repository: TestRepository,
  overrides: Partial<
    TurnRuntimeDependencies<
      CommandPayload,
      PlanBody,
      CandidateBody,
      ValidationBody,
      EventPayload,
      OutboxPayload
    >
  > = {},
) {
  const calls = { planning: 0, drafting: 0, validating: 0, releasing: 0 };
  const dependencies: TurnRuntimeDependencies<
    CommandPayload,
    PlanBody,
    CandidateBody,
    ValidationBody,
    EventPayload,
    OutboxPayload
  > = {
    repository,
    planner: {
      async plan(context) {
        calls.planning += 1;
        return { objective: `respond:${context.command.payload.text}` };
      },
    },
    drafter: {
      async draft(context) {
        calls.drafting += 1;
        return {
          speaker: "塞娜",
          text: `候选:${context.plan.body.objective}`,
        };
      },
    },
    validator: {
      async validate() {
        calls.validating += 1;
        return { accepted: true, rule: "semantic-boundary-v1" };
      },
    },
    releaseBuilder: {
      async build(context) {
        calls.releasing += 1;
        const eventId = `${context.turnId}-event`;
        return {
          formalEvents: [
            {
              eventId,
              kind: "utterance.committed",
              payload: {
                candidateId: context.candidate.candidateId,
                speaker: context.candidate.body.speaker,
                content: context.candidate.body.text,
              },
            },
          ],
          outbox: [
            {
              messageId: `${context.turnId}-outbox`,
              topic: "record.event.committed",
              dedupeKey: `${context.turnId}:projection`,
              payload: { recordId: context.command.recordId, eventId },
            },
          ],
        };
      },
    },
    clock: tickingClock(),
    idFactory: deterministicIds(),
    ...overrides,
  };
  return { calls, dependencies };
}

test("a Turn follows every durable state and releases events plus Outbox atomically", async () => {
  const repository = createRepository();
  const { calls, dependencies } = createDependencies(repository);

  const run = await executeTurn(createCommand(), dependencies);

  assert.equal(run.state, "completed");
  assert.deepEqual(
    run.transitions.map((transition) => transition.to),
    [
      "accepted",
      "planning",
      "drafting",
      "validating",
      "releasing",
      "completed",
    ],
  );
  assert.deepEqual(run.attempts, {
    planning: 1,
    drafting: 1,
    validating: 1,
    releasing: 1,
  });
  assert.deepEqual(calls, run.attempts);

  const events = await repository.listCommittedEvents("record-1");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.ordinal, 7);
  assert.equal(events[0]?.recordVersion, 1);
  assert.equal(events[0]?.payload.candidateId, run.candidate?.candidateId);
  assert.notEqual(events[0]?.eventId, run.candidate?.candidateId);
  assert.deepEqual(await repository.loadRecordHead("record-1"), {
    recordId: "record-1",
    version: 1,
    nextOrdinal: 8,
  });

  const messages = await repository.listOutboxMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.state, "pending");
  assert.deepEqual(run.release?.eventIds, [events[0]?.eventId]);
  assert.deepEqual(run.release?.outboxMessageIds, [messages[0]?.messageId]);
});

test("same command is idempotent and canonical payload key order has one fingerprint", async () => {
  const repository = createRepository();
  const { calls, dependencies } = createDependencies(repository);
  const firstCommand = createCommand({
    payload: { text: "检查蜡封。", options: { quiet: true } },
  });
  const reordered = createCommand({
    payload: { options: { quiet: true }, text: "检查蜡封。" },
  });

  assert.equal(
    createCommandFingerprint(firstCommand),
    createCommandFingerprint(reordered),
  );
  const first = await executeTurn(firstCommand, dependencies);
  const duplicate = await executeTurn(reordered, dependencies);

  assert.equal(duplicate.turnId, first.turnId);
  assert.equal(duplicate.release?.releaseFingerprint, first.release?.releaseFingerprint);
  assert.deepEqual(calls, {
    planning: 1,
    drafting: 1,
    validating: 1,
    releasing: 1,
  });
  assert.equal((await repository.listCommittedEvents("record-1")).length, 1);
});

test("an idempotency key cannot be reused for changed command content", async () => {
  const repository = createRepository();
  const { dependencies } = createDependencies(repository);
  await executeTurn(createCommand(), dependencies);

  await assert.rejects(
    executeTurn(
      createCommand({ payload: { text: "烧掉蜡封。" } }),
      dependencies,
    ),
    RuntimeIdempotencyConflictError,
  );
  assert.equal((await repository.listCommittedEvents("record-1")).length, 1);
});

test("a retryable drafting failure resumes from drafting and preserves its plan", async () => {
  const repository = createRepository();
  let draftingCalls = 0;
  const base = createDependencies(repository);
  const { dependencies } = createDependencies(repository, {
    planner: base.dependencies.planner,
    drafter: {
      async draft(context) {
        draftingCalls += 1;
        if (draftingCalls === 1) {
          throw new RetryableTurnError(
            "MODEL_TEMPORARILY_UNAVAILABLE",
            "The local model can be retried.",
          );
        }
        return {
          speaker: "塞娜",
          text: `恢复候选:${context.plan.body.objective}`,
        };
      },
    },
  });

  const paused = await executeTurn(createCommand(), dependencies);
  assert.equal(paused.state, "retryable");
  assert.equal(paused.currentFailure?.resumeFrom, "drafting");
  assert.equal(paused.currentFailure?.attempt, 1);
  assert.ok(paused.plan);
  assert.equal(paused.candidate, undefined);
  assert.equal((await repository.listCommittedEvents("record-1")).length, 0);

  const same = await executeTurn(createCommand(), dependencies);
  assert.equal(same.state, "retryable");
  assert.equal(draftingCalls, 1);

  const completed = await retryTurn(paused.turnId, dependencies);
  assert.equal(completed.state, "completed");
  assert.equal(completed.plan?.planId, paused.plan?.planId);
  assert.equal(completed.attempts.planning, 1);
  assert.equal(completed.attempts.drafting, 2);
  assert.equal(draftingCalls, 2);
  assert.deepEqual(
    completed.transitions.map((transition) => transition.to),
    [
      "accepted",
      "planning",
      "drafting",
      "retryable",
      "drafting",
      "validating",
      "releasing",
      "completed",
    ],
  );
});

test("a fatal validation failure publishes neither formal events nor Outbox", async () => {
  const repository = createRepository();
  const base = createDependencies(repository);
  const { dependencies } = createDependencies(repository, {
    planner: base.dependencies.planner,
    drafter: base.dependencies.drafter,
    validator: {
      async validate() {
        throw new FatalTurnError(
          "WORLD_RULE_VIOLATION",
          "The candidate violates the world contract.",
        );
      },
    },
  });

  const run = await executeTurn(createCommand(), dependencies);
  assert.equal(run.state, "failed");
  assert.equal(run.currentFailure?.code, "WORLD_RULE_VIOLATION");
  assert.ok(run.candidate);
  assert.equal(run.validation, undefined);
  assert.equal((await repository.listCommittedEvents("record-1")).length, 0);
  assert.equal((await repository.listOutboxMessages()).length, 0);
  assert.equal((await repository.loadRecordHead("record-1"))?.version, 0);
  await assert.rejects(
    retryTurn(run.turnId, dependencies),
    (error) =>
      error instanceof RuntimeInvariantError &&
      error.code === "TURN_NOT_RETRYABLE",
  );
});

test("a validated candidate remains non-canonical until an atomic release succeeds", async () => {
  const repository = createRepository();
  let releaseCalls = 0;
  const base = createDependencies(repository);
  const { dependencies } = createDependencies(repository, {
    planner: base.dependencies.planner,
    drafter: base.dependencies.drafter,
    validator: base.dependencies.validator,
    releaseBuilder: {
      async build(context) {
        releaseCalls += 1;
        if (releaseCalls === 1) {
          throw new RetryableTurnError(
            "RELEASE_PREPARATION_INTERRUPTED",
            "Release preparation can be retried.",
          );
        }
        return base.dependencies.releaseBuilder.build(context);
      },
    },
  });

  const paused = await executeTurn(createCommand(), dependencies);
  assert.equal(paused.state, "retryable");
  assert.equal(paused.currentFailure?.resumeFrom, "releasing");
  assert.ok(paused.candidate);
  assert.ok(paused.validation);
  assert.equal((await repository.listCommittedEvents("record-1")).length, 0);
  assert.equal((await repository.listOutboxMessages()).length, 0);
  assert.equal((await repository.loadRecordHead("record-1"))?.version, 0);

  const completed = await retryTurn(paused.turnId, dependencies);
  assert.equal(completed.state, "completed");
  assert.equal(completed.attempts.drafting, 1);
  assert.equal(completed.attempts.validating, 1);
  assert.equal(completed.attempts.releasing, 2);
  assert.equal((await repository.listCommittedEvents("record-1")).length, 1);
  assert.equal((await repository.listOutboxMessages()).length, 1);
});

test("recovery observes completed when the release response is lost after commit", async () => {
  const baseRepository = createRepository();
  let loseResponse = true;
  const repository: TestRepository = {
    ...baseRepository,
    async commitRelease(input) {
      const committed = await baseRepository.commitRelease(input);
      if (loseResponse) {
        loseResponse = false;
        throw new Error("simulated transport loss after commit");
      }
      return committed;
    },
  };
  const { dependencies } = createDependencies(repository);

  const run = await executeTurn(createCommand(), dependencies);

  assert.equal(run.state, "completed");
  assert.equal(run.failures.length, 0);
  assert.equal((await baseRepository.listCommittedEvents("record-1")).length, 1);
  assert.equal((await baseRepository.listOutboxMessages()).length, 1);
  assert.equal((await baseRepository.loadRecordHead("record-1"))?.version, 1);
});

test("an accepted or planning checkpoint can be resumed after process interruption", async () => {
  const repository = createRepository();
  const command = createCommand();
  const accepted = await repository.acceptCommand({
    turnId: "interrupted-turn",
    command,
    commandFingerprint: createCommandFingerprint(command),
    now: "2026-08-13T00:00:00.000Z",
  });
  await repository.advanceTurn({
    turnId: accepted.run.turnId,
    expectedRevision: accepted.run.revision,
    expectedState: "accepted",
    nextState: "planning",
    now: "2026-08-13T00:00:01.000Z",
  });
  const { calls, dependencies } = createDependencies(repository);

  const recovered = await resumeTurn(accepted.run.turnId, dependencies);

  assert.equal(recovered.state, "completed");
  assert.deepEqual(calls, {
    planning: 1,
    drafting: 1,
    validating: 1,
    releasing: 1,
  });
  assert.equal((await repository.listCommittedEvents("record-1")).length, 1);
});

test("Record single-writer release rejects a stale competing Turn", async () => {
  const repository = createRepository();
  const runtime = createDependencies(repository);

  const winner = await executeTurn(
    createCommand({ idempotencyKey: "writer-a" }),
    runtime.dependencies,
  );
  const loser = await executeTurn(
    createCommand({ idempotencyKey: "writer-b" }),
    runtime.dependencies,
  );

  assert.equal(winner.state, "completed");
  assert.equal(loser.state, "failed");
  assert.equal(loser.currentFailure?.code, "RECORD_VERSION_CONFLICT");
  assert.equal((await repository.listCommittedEvents("record-1")).length, 1);
  assert.equal((await repository.listOutboxMessages()).length, 1);
  assert.deepEqual(await repository.loadRecordHead("record-1"), {
    recordId: "record-1",
    version: 1,
    nextOrdinal: 8,
  });
});

test("Outbox has an independent claim, retry, and terminal delivery state machine", async () => {
  const repository = createRepository();
  const { dependencies } = createDependencies(repository);
  await executeTurn(createCommand(), dependencies);
  const [pending] = await repository.listOutboxMessages();
  assert.ok(pending);

  const firstClaim = await repository.claimOutbox({
    messageId: pending.messageId,
    expectedRevision: pending.revision,
    leaseOwner: "projector-a",
    leaseExpiresAt: "2026-08-13T01:00:20.000Z",
    now: "2026-08-13T01:00:00.000Z",
  });
  assert.equal(firstClaim.state, "delivering");
  assert.equal(firstClaim.attempts, 1);

  const retryable = await repository.settleOutbox({
    messageId: pending.messageId,
    expectedRevision: firstClaim.revision,
    outcome: "retryable",
    leaseOwner: "projector-a",
    now: "2026-08-13T01:00:01.000Z",
    retryAt: "2026-08-13T01:01:00.000Z",
    failure: {
      code: "PROJECTOR_BUSY",
      message: "The local projector is busy.",
      occurredAt: "2026-08-13T01:00:01.000Z",
    },
  });
  assert.equal(retryable.state, "retryable");

  await assert.rejects(
    repository.claimOutbox({
      messageId: pending.messageId,
      expectedRevision: retryable.revision,
      leaseOwner: "projector-a",
      leaseExpiresAt: "2026-08-13T01:00:50.000Z",
      now: "2026-08-13T01:00:30.000Z",
    }),
    RuntimeConcurrencyError,
  );
  const secondClaim = await repository.claimOutbox({
    messageId: pending.messageId,
    expectedRevision: retryable.revision,
    leaseOwner: "projector-b",
    leaseExpiresAt: "2026-08-13T01:01:20.000Z",
    now: "2026-08-13T01:01:00.000Z",
  });
  const delivered = await repository.settleOutbox({
    messageId: pending.messageId,
    expectedRevision: secondClaim.revision,
    outcome: "delivered",
    leaseOwner: "projector-b",
    now: "2026-08-13T01:01:01.000Z",
  });
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.attempts, 2);
  assert.equal(delivered.lastFailure, undefined);

  await assert.rejects(
    repository.claimOutbox({
      messageId: pending.messageId,
      expectedRevision: delivered.revision,
      leaseOwner: "projector-b",
      leaseExpiresAt: "2026-08-13T01:02:20.000Z",
      now: "2026-08-13T01:02:00.000Z",
    }),
    RuntimeConcurrencyError,
  );
});

test("an expired Outbox delivery lease can be reclaimed without stale settlement", async () => {
  const repository = createRepository();
  const { dependencies } = createDependencies(repository);
  await executeTurn(createCommand(), dependencies);
  const [pending] = await repository.listOutboxMessages();
  assert.ok(pending);

  const abandoned = await repository.claimOutbox({
    messageId: pending.messageId,
    expectedRevision: pending.revision,
    leaseOwner: "projector-abandoned",
    leaseExpiresAt: "2026-08-13T02:00:10.000Z",
    now: "2026-08-13T02:00:00.000Z",
  });
  const reclaimed = await repository.claimOutbox({
    messageId: pending.messageId,
    expectedRevision: abandoned.revision,
    leaseOwner: "projector-recovery",
    leaseExpiresAt: "2026-08-13T02:00:40.000Z",
    now: "2026-08-13T02:00:11.000Z",
  });

  assert.equal(reclaimed.state, "delivering");
  assert.equal(reclaimed.attempts, 2);
  assert.equal(reclaimed.leaseOwner, "projector-recovery");
  await assert.rejects(
    repository.settleOutbox({
      messageId: pending.messageId,
      expectedRevision: abandoned.revision,
      outcome: "delivered",
      leaseOwner: "projector-abandoned",
      now: "2026-08-13T02:00:12.000Z",
    }),
    RuntimeConcurrencyError,
  );

  const delivered = await repository.settleOutbox({
    messageId: pending.messageId,
    expectedRevision: reclaimed.revision,
    outcome: "delivered",
    leaseOwner: "projector-recovery",
    now: "2026-08-13T02:00:20.000Z",
  });
  assert.equal(delivered.state, "delivered");
  assert.equal(delivered.leaseOwner, undefined);
  assert.equal(delivered.leaseExpiresAt, undefined);
});
