import assert from "node:assert/strict";
import test from "node:test";

import {
  CommittedFactCommandError,
  createCommittedFactCommandService,
  type CommittedFactCommandStore,
} from "../modules/application/committed-fact-command.ts";
import { createReplayContext, type FactKind } from "../modules/application/command-replay-lineage.ts";
import { committedFactRequestFingerprintFor } from "../modules/application/committed-fact-command.ts";
import { committedFactCommandIdFor, evidenceHash } from "../modules/application/committed-fact-command.ts";
import type { ProjectScope } from "../modules/projects/public.ts";

const scope: ProjectScope = {
  workspaceId: "ws_demo",
  worldId: "world_demo",
  worldlineId: "worldline_demo",
};

function memoryStore() {
  const groups = new Map<string, { fingerprint: string; result: unknown; request: unknown }>();
  const assets = new Map<string, { quantity: number; revision: number }>([
    ["record_1\0member_1\0asset_1", { quantity: 2, revision: 0 }],
  ]);
  const events = new Set(["event_1", "event_2"]);
  const goalWrites = 0;
  const store: CommittedFactCommandStore = {
    async loadCommand(_scope, idempotencyKey) {
      const found = groups.get(idempotencyKey);
      return found
        ? { requestFingerprint: found.fingerprint, result: found.result as never, request: found.request as never }
        : null;
    },
    async adjustInventory(input) {
      if (!events.has(input.sourceEventId)) {
        throw new CommittedFactCommandError("EVENT_NOT_FOUND", "missing");
      }
      const key = `${input.recordId}\0${input.characterInstanceId}\0${input.assetDefinitionId}`;
      const holding = assets.get(key);
      if (!holding) throw new CommittedFactCommandError("ASSET_NOT_FOUND", "missing");
      if (holding.revision !== input.expectedRevision) {
        throw new CommittedFactCommandError("WRITE_CONFLICT", "conflict");
      }
      if (holding.quantity + input.delta < 0) {
        throw new CommittedFactCommandError("INSUFFICIENT_QUANTITY", "short");
      }
      holding.quantity += input.delta;
      holding.revision += 1;
      const result = {
        status: "committed" as const,
        commandId: input.commandId,
        quantity: holding.quantity,
        revision: holding.revision,
      };
      groups.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result, request: input.request });
      return result;
    },
    async grantInventory(input) {
      if (!events.has(input.sourceEventId)) {
        throw new CommittedFactCommandError("EVENT_NOT_FOUND", "missing");
      }
      const key = `${input.recordId}\0${input.characterInstanceId}\0${input.assetDefinitionId}`;
      if (assets.has(key)) {
        throw new CommittedFactCommandError("ASSET_ALREADY_HELD", "held");
      }
      assets.set(key, { quantity: input.quantity, revision: 0 });
      const result = {
        status: "committed" as const,
        commandId: input.commandId,
        quantity: input.quantity,
        revision: 0,
      };
      groups.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result, request: input.request });
      return result;
    },
    async reviseRelationship(input) {
      if (!events.has(input.sourceEventId)) {
        throw new CommittedFactCommandError("EVENT_NOT_FOUND", "missing");
      }
      const result = {
        status: "committed" as const,
        commandId: input.commandId,
        relationKind: input.relationKind,
        revisionOrdinal: 1,
        occurred: { worldTick: 4, worldOrdinal: 2 },
      };
      groups.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result, request: input.request });
      return result;
    },
    async loadPerformanceFacts(input) {
      const found = input.evidenceEventIds.filter((eventId) => events.has(eventId));
      if (found.length !== input.evidenceEventIds.length) {
        throw new CommittedFactCommandError("EVENT_NOT_FOUND", "missing");
      }
      return { evidenceCount: found.length, milestoneCompleted: true };
    },
    async recordPerformanceAssessment(input) {
      for (const eventId of input.evidenceEventIds) {
        if (!events.has(eventId)) throw new CommittedFactCommandError("EVENT_NOT_FOUND", "missing");
      }
      const result = {
        status: "committed" as const,
        commandId: input.commandId,
        assessmentId: `${input.commandId}:assessment`,
        score: input.score,
        evidenceSnapshotHash: input.evidenceSnapshotHash,
        goalTransition: null,
      };
      groups.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result, request: input.request });
      return result;
    },
  };
  return { store, assets, get goalWrites() { return goalWrites; } };
}

test("inventory delta rejects a client possession and does not invent a holding", async () => {
  const memory = memoryStore();
  const service = createCommittedFactCommandService({ store: memory.store });
  await assert.rejects(
    service.adjustInventory({
      scope,
      recordId: "record_1",
      characterInstanceId: "member_1",
      assetDefinitionId: "asset_1",
      delta: -1,
      sourceEventId: "event_1",
      expectedRevision: 0,
      idempotencyKey: "inv-1",
      possession: 9,
    }),
    (error: unknown) => error instanceof CommittedFactCommandError && error.code === "COMMAND_INVALID",
  );
  const adjusted = await service.adjustInventory({
    scope,
    recordId: "record_1",
    characterInstanceId: "member_1",
    assetDefinitionId: "asset_1",
    delta: -1,
    sourceEventId: "event_1",
    expectedRevision: 0,
    idempotencyKey: "inv-1",
  });
  assert.equal(adjusted.quantity, 1);
  assert.equal(adjusted.revision, 1);
  const replay = await service.adjustInventory({
    scope,
    recordId: "record_1",
    characterInstanceId: "member_1",
    assetDefinitionId: "asset_1",
    delta: -1,
    sourceEventId: "event_1",
    expectedRevision: 0,
    idempotencyKey: "inv-1",
  });
  assert.equal(replay.status, "replayed");
  assert.equal(memory.assets.get("record_1\0member_1\0asset_1")?.quantity, 1);
  await assert.rejects(
    service.grantInventory({
      scope,
      recordId: "record_1",
      characterInstanceId: "member_1",
      assetDefinitionId: "asset_new",
      quantity: 1,
      sourceEventId: "event_1",
      idempotencyKey: "grant-1",
      possession: 9,
    }),
    (error: unknown) => error instanceof CommittedFactCommandError && error.code === "COMMAND_INVALID",
  );
  const granted = await service.grantInventory({
    scope,
    recordId: "record_1",
    characterInstanceId: "member_1",
    assetDefinitionId: "asset_new",
    quantity: 1,
    sourceEventId: "event_1",
    idempotencyKey: "grant-1",
  });
  assert.equal(granted.quantity, 1);
  assert.equal(granted.revision, 0);
  await assert.rejects(
    service.adjustInventory({
      scope,
      recordId: "record_1",
      characterInstanceId: "member_1",
      assetDefinitionId: "asset_missing",
      delta: 1,
      sourceEventId: "event_1",
      expectedRevision: 0,
      idempotencyKey: "inv-missing",
    }),
    (error: unknown) => error instanceof CommittedFactCommandError && error.code === "ASSET_NOT_FOUND",
  );
});

test("relationship revision rejects a numeric delta and does not use observer memory", async () => {
  const memory = memoryStore();
  const service = createCommittedFactCommandService({ store: memory.store });
  await assert.rejects(
    service.reviseRelationship({
      scope,
      subjectEntityKey: "member_a",
      objectEntityKey: "member_b",
      relationKind: "kept_word",
      sourceEventId: "event_1",
      idempotencyKey: "rel-1",
      relationshipDelta: 3,
    }),
    (error: unknown) => error instanceof CommittedFactCommandError && error.code === "COMMAND_INVALID",
  );
  await assert.rejects(
    service.reviseRelationship({
      scope,
      subjectEntityKey: "member_a",
      objectEntityKey: "member_b",
      relationKind: "kept_word",
      sourceEventId: "event_1",
      idempotencyKey: "rel-1",
      observerContinuityId: "observer_1",
    }),
    (error: unknown) => error instanceof CommittedFactCommandError && error.code === "COMMAND_INVALID",
  );
  const revised = await service.reviseRelationship({
    scope,
    subjectEntityKey: "member_a",
    objectEntityKey: "member_b",
    relationKind: "kept_word",
    sourceEventId: "event_1",
    idempotencyKey: "rel-1",
  });
  assert.equal(revised.revisionOrdinal, 1);
  assert.deepEqual(revised.occurred, { worldTick: 4, worldOrdinal: 2 });
});

test("performance assessment computes the score from committed factors", async () => {
  const memory = memoryStore();
  // Explicit in-memory atomic adapter fixture; production atomicity is covered by the executor protocol test.
  const service = createCommittedFactCommandService({ store: memory.store, atomicPerformanceExecutor: async (scope, intent) => {
    const request = { command: "performance.assessed", recordId: intent.recordId, policyVersion: intent.policyVersion, score: intent.evidenceEventIds.length * 10 + 20, evidenceEventIds: intent.evidenceEventIds };
    const requestFingerprint = committedFactRequestFingerprintFor(scope, request);
    return memory.store.recordPerformanceAssessment({ scope, ...intent, commandId: committedFactCommandIdFor(scope, intent.idempotencyKey, requestFingerprint), requestFingerprint, score: request.score, evidenceSnapshotHash: evidenceHash(intent.evidenceEventIds), request });
  } });
  await assert.rejects(
    service.recordPerformanceAssessment({
      scope,
      recordId: "record_1",
      policyVersion: "structured-factors:v1",
      evidenceEventIds: ["event_1"],
      idempotencyKey: "judge-1",
      score: 80,
    }),
    (error: unknown) => error instanceof CommittedFactCommandError && error.code === "COMMAND_INVALID",
  );
  const assessed = await service.recordPerformanceAssessment({
    scope,
    recordId: "record_1",
    policyVersion: "structured-factors:v1",
    evidenceEventIds: ["event_2", "event_1"],
    idempotencyKey: "judge-1",
  });
  assert.equal(assessed.score, 40);
  assert.equal(assessed.goalTransition, null);
  assert.equal(memory.goalWrites, 0);
  assert.equal(assessed.evidenceSnapshotHash.length, 64);
});

test("legacy rows with an unprovable scope fingerprint fail closed", async () => {
  const memory = memoryStore();
  const base = createCommittedFactCommandService({ store: memory.store });
  await base.grantInventory({
    scope,
    recordId: "record_1",
    characterInstanceId: "member_1",
    assetDefinitionId: "asset_2",
    quantity: 3,
    sourceEventId: "event_1",
    idempotencyKey: "legacy-grant",
  });
  await base.adjustInventory({
    scope,
    recordId: "record_1",
    characterInstanceId: "member_1",
    assetDefinitionId: "asset_1",
    delta: -1,
    sourceEventId: "event_1",
    expectedRevision: 0,
    idempotencyKey: "legacy-adjust",
  });
  // Simulate a pre-provenance / legacy-restored row: no canonical request and
  // a fingerprint that no longer matches the current scope.
  const legacyStore: CommittedFactCommandStore = {
    ...memory.store,
    async loadCommand(commandScope, idempotencyKey) {
      const found = await memory.store.loadCommand(commandScope, idempotencyKey);
      return found
        ? { ...found, request: null, requestFingerprint: "0".repeat(64) }
        : null;
    },
  };
  const before = structuredClone(memory.assets);
  const legacy = createCommittedFactCommandService({ store: legacyStore });
  await assert.rejects(legacy.grantInventory({
    scope,
    recordId: "record_1",
    characterInstanceId: "member_1",
    assetDefinitionId: "asset_2",
    quantity: 3,
    sourceEventId: "event_1",
    idempotencyKey: "legacy-grant",
  }), { code: "IDEMPOTENCY_KEY_REUSE" });
  // A changed candidate under the same legacy key is also refused.
  await assert.rejects(
    legacy.grantInventory({
      scope,
      recordId: "record_1",
      characterInstanceId: "member_1",
      assetDefinitionId: "asset_2",
      quantity: 4,
      sourceEventId: "event_1",
      idempotencyKey: "legacy-grant",
    }),
    (error: unknown) => error instanceof CommittedFactCommandError && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
  // A mismatched scope hash also refuses the original adjustment.
  await assert.rejects(
    legacy.adjustInventory({
      scope,
      recordId: "record_1",
      characterInstanceId: "member_1",
      assetDefinitionId: "asset_1",
      delta: -1,
      sourceEventId: "event_1",
      expectedRevision: 0,
      idempotencyKey: "legacy-adjust",
    }),
    (error: unknown) => error instanceof CommittedFactCommandError && error.code === "IDEMPOTENCY_KEY_REUSE",
  );
  assert.deepEqual(memory.assets, before, "unprovable replays leave holdings unchanged");
});


test("F2b2 every fact service operation compares the full original hash through typed lineage", async () => {
  const targetScope = { ...scope, worldlineId: "restored_line" };
  const context = createReplayContext({ format: "realm-command-lineage-context", version: 1, family: "fact",
    originScope: scope, currentScope: targetScope, identities: {
      record: [["target_record", "record_1"]], event: [["target_event", "event_1"]],
      characterInstance: [["target_member", "member_1"]], assetDefinition: [["target_asset", "asset_1"]],
      scene: [], project: [], financeAccount: [], milestone: [], obligation: [],
    } });
  const cases: { method: "grantInventory" | "adjustInventory" | "reviseRelationship" | "recordPerformanceAssessment"; kind: FactKind; request: Record<string, unknown>; changed: Record<string, unknown> }[] = [
    { method: "grantInventory", kind: "inventory_granted", request: { command: "inventory.granted", recordId: "record_1", characterInstanceId: "member_1", assetDefinitionId: "asset_1", quantity: 3, sourceEventId: "event_1" }, changed: { quantity: 4 } },
    { method: "adjustInventory", kind: "inventory_adjusted", request: { command: "inventory.adjusted", recordId: "record_1", characterInstanceId: "member_1", assetDefinitionId: "asset_1", delta: -1, expectedRevision: 0, sourceEventId: "event_1" }, changed: { expectedRevision: 1 } },
    { method: "reviseRelationship", kind: "relationship_revised", request: { command: "relationship.revised", subjectEntityKey: "member:a", objectEntityKey: "member:b", relationKind: "trust", sourceEventId: "event_1" }, changed: { objectEntityKey: "member:c" } },
    { method: "recordPerformanceAssessment", kind: "performance_assessed", request: { command: "performance.assessed", recordId: "record_1", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["event_1"] }, changed: { evidenceEventIds: ["target_event", "target_event_2"] } },
  ];
  for (const item of cases) {
    const originalHash = committedFactRequestFingerprintFor(scope, item.request);
    const result = { status: "committed", commandId: `stored_${item.kind}`, ...(item.kind === "performance_assessed" ? { score: 10 } : {}) };
    let writes = 0;
    const memory = memoryStore();
    const store: CommittedFactCommandStore = { ...memory.store,
      loadCommand: async () => ({ requestFingerprint: originalHash, request: null, result: result as never, kind: item.kind,
        provenance: "legacy-result-v1", replayProof: { binding: { version: 1, contextId: context.id, originalRequestFingerprint: originalHash }, context } }),
      loadPerformanceFacts: async () => ({ evidenceCount: 1, milestoneCompleted: false }),
      grantInventory: async () => { writes++; throw new Error("unexpected commit"); },
      adjustInventory: async () => { writes++; throw new Error("unexpected commit"); },
      reviseRelationship: async () => { writes++; throw new Error("unexpected commit"); },
      recordPerformanceAssessment: async () => { writes++; throw new Error("unexpected commit"); },
    };
    const input: Record<string, unknown> = { ...item.request, scope: targetScope, idempotencyKey: "original-key" };
    delete input.command; delete input.score;
    for (const [field, value] of [["recordId", "target_record"], ["characterInstanceId", "target_member"], ["assetDefinitionId", "target_asset"], ["sourceEventId", "target_event"]]) {
      if (Object.hasOwn(input, field!)) input[field!] = value;
    }
    if (Array.isArray(input.evidenceEventIds)) input.evidenceEventIds = ["target_event"];
    const service = createCommittedFactCommandService({ store });
    assert.deepEqual(await Reflect.apply(service[item.method], service, [input]), { ...result, status: "replayed" });
    await assert.rejects(Reflect.apply(service[item.method], service, [{ ...input, ...item.changed }]), { code: "IDEMPOTENCY_KEY_REUSE" });
    const wrongKind = createCommittedFactCommandService({ store: { ...store, loadCommand: async (...args) => ({ ...(await store.loadCommand(...args))!, kind: item.kind === "inventory_granted" ? "inventory_adjusted" : "inventory_granted" }) } });
    await assert.rejects(Reflect.apply(wrongKind[item.method], wrongKind, [input]), { code: "IDEMPOTENCY_KEY_REUSE" });
    assert.equal(writes, 0);
  }
});
