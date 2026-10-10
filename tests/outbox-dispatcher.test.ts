import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PermanentOutboxPublishError,
  RetryableOutboxPublishError,
  createOutboxDispatcher,
  type OutboxDispatchReport,
  type OutboxPublishRequest,
  type OutboxPublishSink,
} from "../modules/application/outbox-dispatcher.ts";
import {
  RuntimeConcurrencyError,
  RuntimeInvariantError,
  createCommandFingerprint,
  createInMemoryRuntimeRepository,
  createReleaseFingerprint,
  type RuntimeCommand,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";

type CommandPayload = { text: string };
type PlanBody = { objective: string };
type CandidateBody = { speaker: string; text: string };
type ValidationBody = { accepted: boolean };
type EventPayload = { recordId: string };
type OutboxPayload = { recordId: string; eventId: string };

type TestRepository = RuntimeRepository<
  CommandPayload,
  PlanBody,
  CandidateBody,
  ValidationBody,
  EventPayload,
  OutboxPayload
>;

const T0 = "2026-09-01T00:00:00.000Z";
const T0_EPOCH = Date.parse(T0);

function at(offsetMs: number): string {
  return new Date(T0_EPOCH + offsetMs).toISOString();
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
    recordHeads: [{ recordId: "record-1", version: 0, nextOrdinal: 1 }],
  });
}

interface SeedDraft {
  messageId: string;
  topic?: string;
  payload?: OutboxPayload;
}

/** Seeds Outbox messages through the real accept → advance → commitRelease path. */
async function seedOutbox(
  repository: TestRepository,
  drafts: readonly SeedDraft[],
  now: string = T0,
): Promise<void> {
  assert.ok(drafts.length > 0);
  const command: RuntimeCommand<CommandPayload> = {
    commandType: "player.utterance",
    recordId: "record-1",
    expectedRecordVersion: 0,
    idempotencyKey: `seed-${drafts[0]!.messageId}`,
    actorId: null,
    payload: { text: "seed" },
  };
  const turnId = `turn-${drafts[0]!.messageId}`;
  let run = (
    await repository.acceptCommand({
      turnId,
      command,
      commandFingerprint: createCommandFingerprint(command),
      now,
    })
  ).run;
  run = await repository.advanceTurn({
    turnId,
    expectedRevision: run.revision,
    expectedState: "accepted",
    nextState: "planning",
    now,
  });
  run = await repository.advanceTurn({
    turnId,
    expectedRevision: run.revision,
    expectedState: "planning",
    nextState: "drafting",
    plan: { planId: `${turnId}-plan`, body: { objective: "seed" }, createdAt: now },
    now,
  });
  run = await repository.advanceTurn({
    turnId,
    expectedRevision: run.revision,
    expectedState: "drafting",
    nextState: "validating",
    candidate: {
      candidateId: `${turnId}-candidate`,
      body: { speaker: "塞娜", text: "seed" },
      createdAt: now,
      draftingAttempt: 1,
    },
    now,
  });
  run = await repository.advanceTurn({
    turnId,
    expectedRevision: run.revision,
    expectedState: "validating",
    nextState: "releasing",
    validation: {
      validationId: `${turnId}-validation`,
      body: { accepted: true },
      createdAt: now,
    },
    now,
  });
  const bundle = {
    formalEvents: [
      {
        eventId: `${turnId}-event`,
        kind: "utterance.committed",
        payload: { recordId: "record-1" },
      },
    ],
    outbox: drafts.map((draft) => ({
      messageId: draft.messageId,
      topic: draft.topic ?? "record.event.committed",
      dedupeKey: `${draft.messageId}:dedupe`,
      payload: draft.payload ?? {
        recordId: "record-1",
        eventId: `${draft.messageId}-event`,
      },
    })),
  };
  await repository.commitRelease({
    turnId,
    expectedRevision: run.revision,
    releaseFingerprint: createReleaseFingerprint(bundle),
    bundle,
    now,
  });
}

function createRecordingSink(
  behavior?: (request: OutboxPublishRequest<OutboxPayload>) => Promise<void>,
): {
  calls: OutboxPublishRequest<OutboxPayload>[];
  sink: OutboxPublishSink<OutboxPayload>;
} {
  const calls: OutboxPublishRequest<OutboxPayload>[] = [];
  return {
    calls,
    sink: {
      async publish(request) {
        calls.push(request);
        await behavior?.(request);
      },
    },
  };
}

function createDispatcher(
  repository: TestRepository,
  sink: OutboxPublishSink<OutboxPayload>,
  overrides: Record<string, unknown> = {},
) {
  return createOutboxDispatcher<OutboxPayload>({
    repository,
    sink,
    clock: () => T0,
    leaseOwner: "dispatcher-1",
    leaseDurationMs: 60_000,
    batchLimit: 10,
    retryDelayMs: 500,
    maxAttempts: 3,
    ...overrides,
  });
}

test("dispatcher module keeps the public contract boundary", () => {
  const moduleSource = readFileSync(
    new URL("../modules/application/outbox-dispatcher.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    moduleSource.includes('from "../runtime/public.ts"'),
    "dispatcher 必须只依赖 runtime/public.ts 的公开契约",
  );
  assert.ok(
    !/from\s+["'][^"']*local-record-service/.test(moduleSource) &&
      !/import\(\s*["'][^"']*local-record-service/.test(moduleSource),
    "dispatcher 不得反向 import local-record-service",
  );
  assert.ok(
    !/from\s+["'][^"']*database\/postgres/.test(moduleSource),
    "dispatcher 不得依赖 PostgreSQL 适配层",
  );
  assert.ok(
    !/\b(INSERT INTO|UPDATE\s+\w+\s+SET|SELECT\s+.+\s+FROM|CREATE TABLE)\b/i.test(
      moduleSource,
    ),
    "dispatcher 不得复制 SQL 或 outbox 状态机实现",
  );
});

test("a pending message is claimed, published, and settled delivered", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  const { calls, sink } = createRecordingSink();
  const dispatcher = createDispatcher(repository, sink);

  const report = await dispatcher.runOnce();

  assert.deepEqual(report, {
    now: T0,
    scanned: 1,
    candidates: 1,
    claimed: 1,
    delivered: 1,
    retryable: 0,
    failed: 0,
    claimConflicts: 0,
    settleConflicts: 0,
  } satisfies OutboxDispatchReport);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    messageId: "m-1",
    turnId: "turn-m-1",
    recordId: "record-1",
    topic: "record.event.committed",
    dedupeKey: "m-1:dedupe",
    payload: { recordId: "record-1", eventId: "m-1-event" },
    attempt: 1,
  });

  const message = await repository.loadOutboxMessage("m-1");
  assert.equal(message?.state, "delivered");
  assert.equal(message?.attempts, 1);
  assert.equal(message?.deliveredAt, T0);
  assert.equal(message?.leaseOwner, undefined);
  assert.equal(message?.leaseExpiresAt, undefined);
  assert.equal(message?.lastFailure, undefined);
});

test("a retryable publish failure reschedules the message for a later run", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  let currentEpoch = T0_EPOCH;
  let failures = 1;
  const { sink } = createRecordingSink(async () => {
    if (failures > 0) {
      failures -= 1;
      throw new RetryableOutboxPublishError(
        "PROJECTOR_BUSY",
        "The projector is busy.",
      );
    }
  });
  const dispatcher = createDispatcher(repository, sink, {
    clock: () => new Date(currentEpoch).toISOString(),
  });

  const first = await dispatcher.runOnce();
  assert.equal(first.retryable, 1);
  assert.equal(first.delivered, 0);

  const retryable = await repository.loadOutboxMessage("m-1");
  assert.equal(retryable?.state, "retryable");
  assert.equal(retryable?.attempts, 1);
  assert.ok(retryable);
  assert.ok(
    Date.parse(retryable.availableAt) > T0_EPOCH,
    "retryAt 必须晚于 now",
  );
  assert.equal(retryable.availableAt, at(500));
  assert.deepEqual(retryable.lastFailure, {
    code: "PROJECTOR_BUSY",
    message: "The projector is busy.",
    occurredAt: T0,
  });

  // retryAt 之前再次运行：消息仍不可用。
  currentEpoch = T0_EPOCH + 250;
  const early = await dispatcher.runOnce();
  assert.equal(early.candidates, 0);
  assert.equal((await repository.loadOutboxMessage("m-1"))?.state, "retryable");

  // retryAt 之后再次消费成功。
  currentEpoch = T0_EPOCH + 500;
  const second = await dispatcher.runOnce();
  assert.equal(second.delivered, 1);
  const delivered = await repository.loadOutboxMessage("m-1");
  assert.equal(delivered?.state, "delivered");
  assert.equal(delivered?.attempts, 2);
  assert.equal(delivered?.lastFailure, undefined);
});

test("a permanent publish error settles the message failed", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  const { sink } = createRecordingSink(async () => {
    throw new PermanentOutboxPublishError(
      "PAYLOAD_REJECTED",
      "The payload is not publishable.",
    );
  });
  const dispatcher = createDispatcher(repository, sink);

  const report = await dispatcher.runOnce();

  assert.equal(report.failed, 1);
  const message = await repository.loadOutboxMessage("m-1");
  assert.equal(message?.state, "failed");
  assert.equal(message?.attempts, 1);
  assert.deepEqual(message?.lastFailure, {
    code: "PAYLOAD_REJECTED",
    message: "The payload is not publishable.",
    occurredAt: T0,
  });

  const again = await dispatcher.runOnce();
  assert.equal(again.candidates, 0);
  assert.equal((await repository.loadOutboxMessage("m-1"))?.state, "failed");
});

test("an unknown publish error settles failed without leaking internals", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  const { sink } = createRecordingSink(async () => {
    throw new Error("connect postgres://user:super-secret@db.internal:5432/realm");
  });
  const dispatcher = createDispatcher(repository, sink);

  const report = await dispatcher.runOnce();

  assert.equal(report.failed, 1);
  const message = await repository.loadOutboxMessage("m-1");
  assert.equal(message?.state, "failed");
  assert.equal(message?.lastFailure?.code, "OUTBOX_PUBLISH_FAILED");
  assert.ok(message?.lastFailure?.message);
  assert.ok(!message.lastFailure.message.includes("super-secret"));
  assert.ok(!message.lastFailure.message.includes("postgres://"));
});

test("retryable failures beyond maxAttempts settle failed", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  let currentEpoch = T0_EPOCH;
  const { sink } = createRecordingSink(async () => {
    throw new RetryableOutboxPublishError("PROJECTOR_BUSY", "Busy.");
  });
  const dispatcher = createDispatcher(repository, sink, {
    clock: () => new Date(currentEpoch).toISOString(),
    maxAttempts: 2,
  });

  const first = await dispatcher.runOnce();
  assert.equal(first.retryable, 1);
  assert.equal((await repository.loadOutboxMessage("m-1"))?.state, "retryable");

  currentEpoch = T0_EPOCH + 500;
  const second = await dispatcher.runOnce();
  assert.equal(second.failed, 1);
  const message = await repository.loadOutboxMessage("m-1");
  assert.equal(message?.state, "failed");
  assert.equal(message?.attempts, 2);
  assert.equal(message?.lastFailure?.code, "PROJECTOR_BUSY");
});

test("an expired delivering lease is recovered and the stale worker settle is fenced", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  const [pending] = await repository.listOutboxMessages();
  assert.ok(pending);
  const abandoned = await repository.claimOutbox({
    messageId: "m-1",
    expectedRevision: pending.revision,
    leaseOwner: "worker-stale",
    leaseExpiresAt: at(10_000),
    now: T0,
  });

  const { sink } = createRecordingSink(async () => {
    // 旧 worker 在 lease 被回收后尝试 settle：必须被 fencing 拒绝。
    await assert.rejects(
      repository.settleOutbox({
        messageId: "m-1",
        expectedRevision: abandoned.revision,
        outcome: "delivered",
        leaseOwner: "worker-stale",
        now: at(11_500),
      }),
      RuntimeConcurrencyError,
    );
  });
  const dispatcher = createDispatcher(repository, sink, {
    clock: () => at(11_000),
  });

  const report = await dispatcher.runOnce();

  assert.equal(report.candidates, 1);
  assert.equal(report.delivered, 1);
  const message = await repository.loadOutboxMessage("m-1");
  assert.equal(message?.state, "delivered");
  assert.equal(message?.attempts, 2);
  assert.equal(message?.deliveredAt, at(11_000));
});

test("a slow publisher loses its lease and its stale settle cannot overwrite the new worker", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  let currentEpoch = T0_EPOCH;
  const { sink } = createRecordingSink(async (request) => {
    // 发布耗时超过 lease：另一个 worker 已回收并完成投递。
    currentEpoch = T0_EPOCH + 2_000;
    const latest = await repository.loadOutboxMessage(request.messageId);
    assert.ok(latest);
    const reclaimed = await repository.claimOutbox({
      messageId: request.messageId,
      expectedRevision: latest.revision,
      leaseOwner: "worker-b",
      leaseExpiresAt: new Date(currentEpoch + 10_000).toISOString(),
      now: new Date(currentEpoch).toISOString(),
    });
    await repository.settleOutbox({
      messageId: request.messageId,
      expectedRevision: reclaimed.revision,
      outcome: "delivered",
      leaseOwner: "worker-b",
      now: new Date(currentEpoch).toISOString(),
    });
  });
  const dispatcher = createDispatcher(repository, sink, {
    clock: () => new Date(currentEpoch).toISOString(),
    leaseDurationMs: 1_000,
  });

  const report = await dispatcher.runOnce();

  assert.equal(report.claimed, 1);
  assert.equal(report.delivered, 0);
  assert.equal(report.settleConflicts, 1);
  const message = await repository.loadOutboxMessage("m-1");
  assert.equal(message?.state, "delivered");
  assert.equal(message?.attempts, 2);
  assert.equal(message?.deliveredAt, at(2_000));
});

test("future, delivered, failed, and leased messages are ignored", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [
    { messageId: "m-ready" },
    { messageId: "m-delivered" },
    { messageId: "m-failed" },
    { messageId: "m-future" },
    { messageId: "m-leased" },
  ]);
  for (const messageId of ["m-delivered", "m-failed", "m-future", "m-leased"]) {
    const [message] = (await repository.listOutboxMessages()).filter(
      (candidate) => candidate.messageId === messageId,
    );
    assert.ok(message);
    const claim = await repository.claimOutbox({
      messageId,
      expectedRevision: message.revision,
      leaseOwner: "setup-worker",
      leaseExpiresAt: at(60_000),
      now: T0,
    });
    if (messageId === "m-delivered") {
      await repository.settleOutbox({
        messageId,
        expectedRevision: claim.revision,
        outcome: "delivered",
        leaseOwner: "setup-worker",
        now: T0,
      });
    } else if (messageId === "m-failed") {
      await repository.settleOutbox({
        messageId,
        expectedRevision: claim.revision,
        outcome: "failed",
        leaseOwner: "setup-worker",
        now: T0,
        failure: { code: "X", message: "x", occurredAt: T0 },
      });
    } else if (messageId === "m-future") {
      await repository.settleOutbox({
        messageId,
        expectedRevision: claim.revision,
        outcome: "retryable",
        leaseOwner: "setup-worker",
        now: T0,
        retryAt: at(3_600_000),
        failure: { code: "X", message: "x", occurredAt: T0 },
      });
    }
    // m-leased 保持 delivering 且 lease 未过期。
  }
  const { calls, sink } = createRecordingSink();
  const dispatcher = createDispatcher(repository, sink);

  const report = await dispatcher.runOnce();

  assert.equal(report.scanned, 5);
  assert.equal(report.candidates, 1);
  assert.equal(report.delivered, 1);
  assert.deepEqual(
    calls.map((call) => call.messageId),
    ["m-ready"],
  );
  assert.equal(
    (await repository.loadOutboxMessage("m-delivered"))?.state,
    "delivered",
  );
  assert.equal((await repository.loadOutboxMessage("m-failed"))?.state, "failed");
  assert.equal(
    (await repository.loadOutboxMessage("m-future"))?.state,
    "retryable",
  );
  assert.equal(
    (await repository.loadOutboxMessage("m-leased"))?.state,
    "delivering",
  );
});

test("batch limit and stable ordering are deterministic", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [
    { messageId: "m-c" },
    { messageId: "m-a" },
    { messageId: "m-b" },
  ]);
  const { calls, sink } = createRecordingSink();
  const dispatcher = createDispatcher(repository, sink, { batchLimit: 2 });

  const report = await dispatcher.runOnce();

  assert.equal(report.candidates, 2);
  assert.equal(report.delivered, 2);
  assert.deepEqual(
    calls.map((call) => call.messageId),
    ["m-a", "m-b"],
  );
  assert.equal((await repository.loadOutboxMessage("m-c"))?.state, "pending");

  const second = await dispatcher.runOnce();
  assert.equal(second.delivered, 1);
  assert.equal((await repository.loadOutboxMessage("m-c"))?.state, "delivered");
});

test("a claim race skips the contested message without failing the batch", async () => {
  const base = createRepository();
  await seedOutbox(base, [{ messageId: "m-a" }, { messageId: "m-b" }]);
  // 包一层真实仓储：m-a 在 dispatcher claim 前被竞争者取走并完成投递。
  const repository: TestRepository = {
    ...base,
    async claimOutbox(input) {
      if (input.messageId === "m-a") {
        const competitor = await base.claimOutbox({
          ...input,
          leaseOwner: "worker-competitor",
        });
        await base.settleOutbox({
          messageId: "m-a",
          expectedRevision: competitor.revision,
          outcome: "delivered",
          leaseOwner: "worker-competitor",
          now: input.now,
        });
        throw new RuntimeConcurrencyError();
      }
      return base.claimOutbox(input);
    },
  };
  const { calls, sink } = createRecordingSink();
  const dispatcher = createDispatcher(repository, sink);

  const report = await dispatcher.runOnce();

  assert.equal(report.candidates, 2);
  assert.equal(report.claimed, 1);
  assert.equal(report.claimConflicts, 1);
  assert.equal(report.delivered, 1);
  assert.deepEqual(
    calls.map((call) => call.messageId),
    ["m-b"],
  );
  assert.equal((await base.loadOutboxMessage("m-a"))?.state, "delivered");
  assert.equal((await base.loadOutboxMessage("m-b"))?.state, "delivered");
});

test("one failing message does not block the rest of the batch", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [
    { messageId: "m-a" },
    { messageId: "m-b" },
    { messageId: "m-c" },
  ]);
  const { sink } = createRecordingSink(async (request) => {
    if (request.messageId === "m-b") {
      throw new PermanentOutboxPublishError("PAYLOAD_REJECTED", "Rejected.");
    }
  });
  const dispatcher = createDispatcher(repository, sink);

  const report = await dispatcher.runOnce();

  assert.equal(report.delivered, 2);
  assert.equal(report.failed, 1);
  assert.equal((await repository.loadOutboxMessage("m-a"))?.state, "delivered");
  assert.equal((await repository.loadOutboxMessage("m-b"))?.state, "failed");
  assert.equal((await repository.loadOutboxMessage("m-c"))?.state, "delivered");
});

test("runOnce is single-flight and rejects overlapping runs", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { sink } = createRecordingSink(() => gate);
  const dispatcher = createDispatcher(repository, sink);

  const first = dispatcher.runOnce();
  await assert.rejects(
    dispatcher.runOnce(),
    (error: unknown) =>
      error instanceof RuntimeInvariantError &&
      error.code === "OUTBOX_DISPATCHER_BUSY",
  );
  release();
  const report = await first;
  assert.equal(report.delivered, 1);

  const drained = await dispatcher.runOnce();
  assert.equal(drained.candidates, 0);
});

test("an empty outbox produces a deterministic empty report", async () => {
  const repository = createRepository();
  const { calls, sink } = createRecordingSink();
  const dispatcher = createDispatcher(repository, sink);

  const report = await dispatcher.runOnce();

  assert.deepEqual(report, {
    now: T0,
    scanned: 0,
    candidates: 0,
    claimed: 0,
    delivered: 0,
    retryable: 0,
    failed: 0,
    claimConflicts: 0,
    settleConflicts: 0,
  } satisfies OutboxDispatchReport);
  assert.equal(calls.length, 0);
});

test("invalid configuration fails closed at the factory boundary", () => {
  const repository = createRepository();
  const { sink } = createRecordingSink();
  const base = {
    repository,
    sink,
    clock: () => T0,
    leaseOwner: "dispatcher-1",
    leaseDurationMs: 60_000,
    batchLimit: 10,
    retryDelayMs: 500,
    maxAttempts: 3,
  };
  const invalid: Record<string, unknown>[] = [
    { sink: undefined },
    { repository: undefined },
    { leaseOwner: "  " },
    { leaseDurationMs: 0 },
    { leaseDurationMs: Number.NaN },
    { batchLimit: 0 },
    { retryDelayMs: 0 },
    { maxAttempts: 0 },
    { clock: "not-a-clock" },
  ];
  for (const override of invalid) {
    assert.throws(
      () =>
        createOutboxDispatcher({
          ...base,
          ...override,
        } as never),
      RuntimeInvariantError,
      `配置 ${JSON.stringify(override)} 必须 fail-closed`,
    );
  }
});

test("an invalid clock reading fails closed inside runOnce", async () => {
  const repository = createRepository();
  await seedOutbox(repository, [{ messageId: "m-1" }]);
  const { calls, sink } = createRecordingSink();
  const dispatcher = createDispatcher(repository, sink, {
    clock: () => "not-a-timestamp",
  });

  await assert.rejects(
    dispatcher.runOnce(),
    (error: unknown) =>
      error instanceof RuntimeInvariantError &&
      error.code === "OUTBOX_DISPATCHER_NOW_INVALID",
  );
  assert.equal(calls.length, 0);
  assert.equal((await repository.loadOutboxMessage("m-1"))?.state, "pending");
});
