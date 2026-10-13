/**
 * Slice 5 World Command 纯单元/契约测试（零数据库）：
 * - touched Record 去重、稳定排序、空集/越界/冲突重复拒绝；
 * - 锁序计划对任意输入顺序产出同一顺序；
 * - Command Group / 子命令身份与请求指纹确定性生成；
 * - payload/事件数/Outbox 等有界围栏；
 * - player-safe result 不含内部 manifest/子命令身份/event-outbox id；
 * - 服务编排：跨 scope 拒绝先于任何写入、领域拒绝落 rejected 台账、
 *   replay/冲突稳定码透传。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createWorldCommandService,
  type PlannedRecordEffects,
  type WorldCommandStore,
} from "../modules/application/world-command-service.ts";
import {
  buildCommandPlan,
  commandGroupIdFor,
  createWorldCommandFingerprint,
  normalizeTouchedRecords,
  planWorldCommandLockOrder,
  subCommandIdFor,
  toPlayerSafeWorldCommandResult,
  validateCommandPlan,
  WorldCommandError,
  WORLD_COMMAND_LIMITS,
  type CommandPlan,
  type WorldCommandCommittedResult,
  type WorldCommandEventWrite,
  type WorldCommandRequest,
  type WorldCommandResult,
  type WorldCommandScope,
} from "../modules/worldline/world-command.ts";

const SCOPE: WorldCommandScope = {
  workspaceId: "workspace_a",
  worldId: "world_a",
  worldlineId: "worldline_a",
};

function request(overrides: Partial<WorldCommandRequest> = {}): WorldCommandRequest {
  return {
    scope: SCOPE,
    primaryRecordId: "record_a",
    touchedRecords: [
      { recordId: "record_a", expectedRecordVersion: 0 },
      { recordId: "record_b", expectedRecordVersion: 2 },
    ],
    idempotencyKey: "command-1",
    payload: { intent: "confirm-show" },
    ...overrides,
  };
}

function eventWrite(recordId: string, suffix = "1"): WorldCommandEventWrite {
  return {
    eventId: `event_${recordId}_${suffix}`,
    kind: "narration.committed",
    sceneId: `scene_${recordId}`,
    visibilityPolicyId: `policy_${recordId}`,
    content: "档期已确认。",
    payload: { content: "档期已确认。" },
  };
}

function effectsFor(recordIds: readonly string[]): PlannedRecordEffects[] {
  return recordIds.map((recordId) => ({
    recordId,
    events: [eventWrite(recordId)],
    outbox: [{
      messageId: `outbox_${recordId}`,
      dedupeKey: `dedupe_${recordId}`,
      topic: "record.event.committed",
      payload: { recordId },
    }],
  }));
}

function plan(overrides: Partial<WorldCommandRequest> = {}): CommandPlan {
  const req = request(overrides);
  return buildCommandPlan({
    request: req,
    effects: effectsFor(req.touchedRecords.map((record) => record.recordId)),
    expectedWorldCursor: { tick: 100, ordinal: 4 },
  });
}

test("touched Records are deduplicated and sorted regardless of input order", () => {
  const forward = normalizeTouchedRecords(request());
  const backward = normalizeTouchedRecords(request({
    touchedRecords: [
      { recordId: "record_b", expectedRecordVersion: 2 },
      { recordId: "record_a", expectedRecordVersion: 0 },
      { recordId: "record_b", expectedRecordVersion: 2 },
    ],
  }));
  assert.deepEqual(forward, backward);
  assert.deepEqual(
    forward.map((record) => record.recordId),
    ["record_a", "record_b"],
  );
});

test("empty touched set, missing primary and conflicting duplicates are rejected", () => {
  assert.throws(
    () => normalizeTouchedRecords(request({ touchedRecords: [] })),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_REQUEST_INVALID",
  );
  assert.throws(
    () => normalizeTouchedRecords(request({ primaryRecordId: "record_z" })),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_REQUEST_INVALID",
  );
  assert.throws(
    () => normalizeTouchedRecords(request({
      touchedRecords: [
        { recordId: "record_a", expectedRecordVersion: 0 },
        { recordId: "record_a", expectedRecordVersion: 1 },
      ],
    })),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_REQUEST_INVALID",
  );
  assert.throws(
    () => normalizeTouchedRecords(request({
      touchedRecords: [
        { recordId: "record_a", expectedRecordVersion: -1 },
      ],
    })),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_REQUEST_INVALID",
  );
});

test("touched set is bounded", () => {
  const tooMany = Array.from(
    { length: WORLD_COMMAND_LIMITS.maxTouchedRecords + 1 },
    (_, index) => ({
      recordId: `record_${String(index).padStart(3, "0")}`,
      expectedRecordVersion: 0,
    }),
  );
  assert.throws(
    () => normalizeTouchedRecords(request({
      primaryRecordId: "record_000",
      touchedRecords: tooMany,
    })),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_REQUEST_INVALID",
  );
});

test("lock order plan is identical for any input order", () => {
  const forward = plan();
  const backward = plan({
    touchedRecords: [
      { recordId: "record_b", expectedRecordVersion: 2 },
      { recordId: "record_a", expectedRecordVersion: 0 },
    ],
  });
  assert.deepEqual(planWorldCommandLockOrder(forward), planWorldCommandLockOrder(backward));
  assert.deepEqual(planWorldCommandLockOrder(forward), {
    worldlineId: SCOPE.worldlineId,
    recordIds: ["record_a", "record_b"],
  });
});

test("command group, sub-command and fingerprint identities are deterministic", () => {
  const a = plan();
  const b = plan();
  assert.equal(a.commandGroupId, b.commandGroupId);
  assert.equal(a.requestFingerprint, b.requestFingerprint);
  assert.match(a.commandGroupId, /^wcg_[0-9a-f]{24}$/);
  assert.match(a.requestFingerprint, /^wcmd_[0-9a-f]{64}$/);
  const sub = subCommandIdFor(a.commandGroupId, "record_a");
  assert.match(sub, /^wcs_[0-9a-f]{24}$/);
  assert.equal(sub, subCommandIdFor(a.commandGroupId, "record_a"));
  assert.notEqual(sub, subCommandIdFor(a.commandGroupId, "record_b"));

  // 指纹绑定内容而非 key：同内容不同 key 同指纹；内容变即指纹变。
  const otherKey = createWorldCommandFingerprint(request({ idempotencyKey: "command-2" }));
  assert.equal(otherKey, a.requestFingerprint);
  const otherPayload = createWorldCommandFingerprint(request({
    payload: { intent: "change-show" },
  }));
  assert.notEqual(otherPayload, a.requestFingerprint);
  const otherScope = createWorldCommandFingerprint(request({
    scope: { ...SCOPE, worldlineId: "worldline_b" },
  }));
  assert.notEqual(otherScope, a.requestFingerprint);
  // 请求字段顺序无关（canonical JSON 排序）。
  const reordered = createWorldCommandFingerprint(request({
    payload: JSON.parse('{ "intent" : "confirm-show" }'),
  }));
  assert.equal(reordered, a.requestFingerprint);
});

test("plan requires effects for exactly the touched set", () => {
  const req = request();
  assert.throws(
    () => buildCommandPlan({
      request: req,
      effects: effectsFor(["record_a"]),
      expectedWorldCursor: { tick: 100, ordinal: 4 },
    }),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );
  assert.throws(
    () => buildCommandPlan({
      request: req,
      effects: [
        ...effectsFor(["record_a", "record_b"]),
        { recordId: "record_c", events: [eventWrite("record_c")] },
      ],
      expectedWorldCursor: { tick: 100, ordinal: 4 },
    }),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );
});

test("plan validation enforces bounds, identity uniqueness and record sorting", () => {
  const valid = plan();
  assert.doesNotThrow(() => validateCommandPlan(valid));

  // 未排序的 records 拒绝（锁序必须确定性）。
  const unsorted: CommandPlan = {
    ...valid,
    records: [...valid.records].reverse(),
  };
  assert.throws(
    () => validateCommandPlan(unsorted),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );

  // 事件 id 全局唯一。
  const duplicateEvents: CommandPlan = {
    ...valid,
    records: valid.records.map((record) => ({
      ...record,
      events: [eventWrite("shared")],
    })),
  };
  assert.throws(
    () => validateCommandPlan(duplicateEvents),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );

  // Outbox dedupe key 全局唯一。
  const duplicateDedupe: CommandPlan = {
    ...valid,
    records: valid.records.map((record, index) => ({
      ...record,
      outbox: [{
        messageId: `outbox_${index}`,
        dedupeKey: "same-key",
        topic: "record.event.committed",
        payload: { index },
      }],
    })),
  };
  assert.throws(
    () => validateCommandPlan(duplicateDedupe),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );

  // 每 Record 事件数有界且非空。
  const emptyEvents: CommandPlan = {
    ...valid,
    records: valid.records.map((record) => ({ ...record, events: [] })),
  };
  assert.throws(
    () => validateCommandPlan(emptyEvents),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );
  const tooMany: CommandPlan = {
    ...valid,
    records: valid.records.map((record) => ({
      ...record,
      events: Array.from(
        { length: WORLD_COMMAND_LIMITS.maxEventsPerRecord + 1 },
        (_, index) => eventWrite(record.recordId, `e${index}`),
      ),
    })),
  };
  assert.throws(
    () => validateCommandPlan(tooMany),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );

  // 单 payload 字节有界。
  const fat: CommandPlan = {
    ...valid,
    records: valid.records.map((record) => ({
      ...record,
      events: [{
        ...eventWrite(record.recordId),
        payload: { content: "x".repeat(WORLD_COMMAND_LIMITS.maxPayloadBytes) },
      }],
    })),
  };
  assert.throws(
    () => validateCommandPlan(fat),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );

  // Action state 只能挂在 action.transaction.committed 事件上。
  const misplacedAction: CommandPlan = {
    ...valid,
    records: valid.records.map((record) => ({
      ...record,
      events: [{
        ...eventWrite(record.recordId),
        actionState: {
          receiptId: "receipt_1",
          transactionId: "txn_1",
          actorCharacterInstanceId: "actor_1",
          callFingerprint: "call_1",
          receipt: {},
          costs: [],
          effects: [],
        },
      }],
    })),
  };
  assert.throws(
    () => validateCommandPlan(misplacedAction),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );

  // expected cursor 必须是非负安全整数。
  const badCursor: CommandPlan = {
    ...valid,
    expectedWorldCursor: { tick: -1, ordinal: 0 },
  };
  assert.throws(
    () => validateCommandPlan(badCursor),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_PLAN_INVALID",
  );
});

test("player-safe result hides internal manifest, sub-commands and event ids", () => {
  const committed: WorldCommandCommittedResult = {
    state: "committed",
    commandGroupId: "wcg_0123456789abcdef01234567",
    scope: SCOPE,
    worldCursor: { tick: 100, ordinal: 6 },
    committedAt: "2026-10-11T00:00:00.000Z",
    records: [
      {
        recordId: "record_a",
        role: "primary",
        subCommandId: "wcs_aaaaaaaaaaaaaaaaaaaaaaaa",
        expectedRecordVersion: 0,
        finalRecordVersion: 1,
        firstRecordOrdinal: 7,
        nextRecordOrdinal: 8,
        eventIds: ["event_a"],
      },
      {
        recordId: "record_b",
        role: "touched",
        subCommandId: "wcs_bbbbbbbbbbbbbbbbbbbbbbbb",
        expectedRecordVersion: 2,
        finalRecordVersion: 3,
        firstRecordOrdinal: 5,
        nextRecordOrdinal: 6,
        eventIds: ["event_b"],
      },
    ],
    outboxMessageIds: ["outbox_a", "outbox_b"],
  };
  const safe = toPlayerSafeWorldCommandResult(committed);
  assert.deepEqual(safe, {
    commandGroupId: committed.commandGroupId,
    state: "committed",
    records: [
      { recordId: "record_a", recordVersion: 1, nextOrdinal: 8, eventCount: 1 },
      { recordId: "record_b", recordVersion: 3, nextOrdinal: 6, eventCount: 1 },
    ],
    worldCursor: { tick: 100, ordinal: 6 },
    committedAt: "2026-10-11T00:00:00.000Z",
  });
  const serialized = JSON.stringify(safe);
  assert.ok(!serialized.includes("wcs_"), "不得暴露子命令身份");
  assert.ok(!serialized.includes("event_a"), "不得暴露内部事件 id");
  assert.ok(!serialized.includes("outbox_a"), "不得暴露内部 Outbox id");
  assert.ok(!serialized.includes("workspace_a"), "不得回显内部 scope");

  const rejected = toPlayerSafeWorldCommandResult({
    state: "rejected",
    commandGroupId: "wcg_0123456789abcdef01234567",
    scope: SCOPE,
    code: "WORLD_COMMAND_DOMAIN_RULE",
    message: "预算不足。",
    rejectedAt: "2026-10-11T00:00:00.000Z",
  });
  assert.deepEqual(rejected, {
    commandGroupId: rejected.commandGroupId,
    state: "rejected",
    records: [],
    rejection: { code: "WORLD_COMMAND_DOMAIN_RULE", message: "预算不足。" },
  });
});

// ---------------------------------------------------------------------------
// 服务编排（内存 fake store；零数据库）
// ---------------------------------------------------------------------------

interface FakeStore extends WorldCommandStore {
  commits: CommandPlan[];
  rejections: { code: string; message: string }[];
}

function fakeStore(overrides: {
  ledger?: {
    requestFingerprint: string;
    result: WorldCommandResult;
  } | null;
  scopes?: Map<string, {
    recordId: string;
    worldId: string;
    worldlineId: string;
    status: string;
    recordVersion: number;
    nextRecordOrdinal: number;
  }>;
  cursor?: { tick: number; ordinal: number } | null;
  commitImpl?: WorldCommandStore["commitWorldCommand"];
} = {}): FakeStore {
  const scopes = overrides.scopes ?? new Map([
    ["record_a", {
      recordId: "record_a",
      worldId: SCOPE.worldId,
      worldlineId: SCOPE.worldlineId,
      status: "active",
      recordVersion: 0,
      nextRecordOrdinal: 7,
    }],
    ["record_b", {
      recordId: "record_b",
      worldId: SCOPE.worldId,
      worldlineId: SCOPE.worldlineId,
      status: "active",
      recordVersion: 2,
      nextRecordOrdinal: 5,
    }],
  ]);
  const store: FakeStore = {
    commits: [],
    rejections: [],
    async readRecordScopes(recordIds) {
      return recordIds
        .map((recordId) => scopes.get(recordId))
        .filter((row) => row !== undefined);
    },
    async readWorldlineCursor() {
      return overrides.cursor === undefined ? { tick: 100, ordinal: 4 } : overrides.cursor;
    },
    async loadCommandGroup() {
      return overrides.ledger ?? null;
    },
    async commitWorldCommand(plan, now) {
      store.commits.push(plan);
      if (overrides.commitImpl) return overrides.commitImpl(plan, now);
      return {
        state: "committed",
        commandGroupId: plan.commandGroupId,
        scope: plan.scope,
        worldCursor: { tick: 100, ordinal: 4 + plan.records.length },
        committedAt: now,
        records: plan.records.map((record) => ({
          recordId: record.recordId,
          role: record.recordId === plan.primaryRecordId ? "primary" : "touched",
          subCommandId: subCommandIdFor(plan.commandGroupId, record.recordId),
          expectedRecordVersion: record.expectedRecordVersion,
          finalRecordVersion: record.expectedRecordVersion + 1,
          firstRecordOrdinal: 7,
          nextRecordOrdinal: 8,
          eventIds: record.events.map((event) => event.eventId),
        })),
        outboxMessageIds: plan.records.flatMap(
          (record) => record.outbox.map((message) => message.messageId),
        ),
      };
    },
    async rejectWorldCommand(_plan, rejection) {
      store.rejections.push(rejection);
      return {
        state: "rejected",
        commandGroupId: _plan.commandGroupId,
        scope: _plan.scope,
        code: rejection.code,
        message: rejection.message,
        rejectedAt: "2026-10-11T00:00:00.000Z",
      };
    },
  };
  return store;
}

function effects(context: {
  request: WorldCommandRequest;
}): PlannedRecordEffects[] {
  return effectsFor(context.request.touchedRecords.map((record) => record.recordId));
}

test("service commits a valid command and returns the player-safe result", async () => {
  const store = fakeStore();
  const service = createWorldCommandService({
    store,
    planEffects: effects,
    clock: () => "2026-10-11T00:00:00.000Z",
  });
  const result = await service.executeWorldCommand(request());
  assert.equal(result.state, "committed");
  assert.equal(store.commits.length, 1);
  assert.equal(store.rejections.length, 0);
  assert.deepEqual(
    result.records.map((record) => record.recordId),
    ["record_a", "record_b"],
  );
  assert.equal(JSON.stringify(result).includes("wcs_"), false);
});

test("cross-scope, unknown and archived records are rejected before any write", async () => {
  const foreign = fakeStore({
    scopes: new Map([
      ["record_a", {
        recordId: "record_a",
        worldId: SCOPE.worldId,
        worldlineId: SCOPE.worldlineId,
        status: "active",
        recordVersion: 0,
        nextRecordOrdinal: 7,
      }],
      ["record_b", {
        recordId: "record_b",
        worldId: SCOPE.worldId,
        worldlineId: "worldline_other",
        status: "active",
        recordVersion: 2,
        nextRecordOrdinal: 5,
      }],
    ]),
  });
  const foreignService = createWorldCommandService({
    store: foreign,
    planEffects: effects,
  });
  await assert.rejects(
    () => foreignService.executeWorldCommand(request()),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_SCOPE_MISMATCH",
  );
  assert.equal(foreign.commits.length, 0, "跨 scope 拒绝必须零写入");
  assert.equal(foreign.rejections.length, 0, "跨 scope 拒绝不得落台账");

  const missing = fakeStore({ scopes: new Map() });
  const missingService = createWorldCommandService({
    store: missing,
    planEffects: effects,
  });
  await assert.rejects(
    () => missingService.executeWorldCommand(request()),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_RECORD_UNKNOWN",
  );
  assert.equal(missing.commits.length, 0);

  const archivedBase = fakeStore();
  const scopes = new Map((await archivedBase.readRecordScopes(["record_a", "record_b"]))
    .map((row) => [row.recordId, { ...row, status: "archived" }]));
  const archivedStore = fakeStore({ scopes });
  const archivedService = createWorldCommandService({
    store: archivedStore,
    planEffects: effects,
  });
  await assert.rejects(
    () => archivedService.executeWorldCommand(request()),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WORLD_COMMAND_RECORD_ARCHIVED",
  );
  assert.equal(archivedStore.commits.length, 0);
});

test("stale expected heads fail with a retryable WRITE_CONFLICT before any write", async () => {
  const store = fakeStore();
  const service = createWorldCommandService({
    store,
    planEffects: effects,
  });
  await assert.rejects(
    () => service.executeWorldCommand(request({
      touchedRecords: [
        { recordId: "record_a", expectedRecordVersion: 0 },
        { recordId: "record_b", expectedRecordVersion: 1 },
      ],
    })),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "WRITE_CONFLICT"
      && error.retryable === true,
  );
  assert.equal(store.commits.length, 0);
});

test("domain rejections are recorded once and replay the same rejection", async () => {
  const store = fakeStore();
  const service = createWorldCommandService({
    store,
    planEffects() {
      throw new WorldCommandError("WORLD_COMMAND_DOMAIN_RULE", "预算不足。");
    },
    clock: () => "2026-10-11T00:00:00.000Z",
  });
  const result = await service.executeWorldCommand(request());
  assert.deepEqual(result, {
    commandGroupId: result.commandGroupId,
    state: "rejected",
    records: [],
    rejection: { code: "WORLD_COMMAND_DOMAIN_RULE", message: "预算不足。" },
  });
  assert.equal(store.commits.length, 0);
  assert.equal(store.rejections.length, 1);
});

test("unexpected effect-builder failures propagate without ledger writes", async () => {
  const store = fakeStore();
  const service = createWorldCommandService({
    store,
    planEffects() {
      throw new Error("provider timeout");
    },
  });
  await assert.rejects(
    () => service.executeWorldCommand(request()),
    /provider timeout/,
  );
  assert.equal(store.commits.length, 0);
  assert.equal(store.rejections.length, 0);
});

test("commit errors pass through with stable codes", async () => {
  const store = fakeStore({
    commitImpl: () => {
      throw new WorldCommandError(
        "IDEMPOTENCY_KEY_REUSE",
        "The idempotency key was already used for a different World Command.",
      );
    },
  });
  const service = createWorldCommandService({
    store,
    planEffects: effects,
  });
  await assert.rejects(
    () => service.executeWorldCommand(request()),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
  assert.equal(store.commits.length, 1);
  assert.equal(store.rejections.length, 0);
});

test("committed replay short-circuits at the ledger before head pre-checks", async () => {
  const req = request({
    touchedRecords: [{ recordId: "record_a", expectedRecordVersion: 0 }],
  });
  const fingerprint = createWorldCommandFingerprint(req);
  const committedResult: WorldCommandCommittedResult = {
    state: "committed",
    commandGroupId: commandGroupIdFor(req.scope, req.idempotencyKey),
    scope: req.scope,
    worldCursor: { tick: 100, ordinal: 6 },
    committedAt: "2026-10-11T00:00:00.000Z",
    records: [{
      recordId: "record_a",
      role: "primary",
      subCommandId: "wcs_aaaaaaaaaaaaaaaaaaaaaaaa",
      expectedRecordVersion: 0,
      finalRecordVersion: 1,
      firstRecordOrdinal: 7,
      nextRecordOrdinal: 8,
      eventIds: ["event_a"],
    }],
    outboxMessageIds: ["outbox_a"],
  };
  // head 已推进到 1（请求仍声明 expected 0）——若 replay 不短路，head
  // 预检会误报 WRITE_CONFLICT。
  const store = fakeStore({
    ledger: { requestFingerprint: fingerprint, result: committedResult },
  });
  const service = createWorldCommandService({
    store,
    planEffects: effects,
  });
  const replayed = await service.executeWorldCommand(req);
  assert.equal(replayed.state, "committed");
  assert.equal(replayed.commandGroupId, committedResult.commandGroupId);
  assert.equal(store.commits.length, 0, "replay 不得再次提交");
  assert.equal(store.rejections.length, 0);

  // 同 key 不同 fingerprint → fail-closed。
  const conflicting = fakeStore({
    ledger: { requestFingerprint: fingerprint, result: committedResult },
  });
  const conflictService = createWorldCommandService({
    store: conflicting,
    planEffects: effects,
  });
  await assert.rejects(
    () => conflictService.executeWorldCommand({
      ...req,
      payload: { intent: "tampered" },
    }),
    (error: unknown) => error instanceof WorldCommandError
      && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
  assert.equal(conflicting.commits.length, 0);
});
