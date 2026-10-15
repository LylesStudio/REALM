import assert from "node:assert/strict";
import test from "node:test";

import {
  CommittedFactCommandError,
  createCommittedFactCommandService,
  type CommittedFactCommandStore,
} from "../modules/application/committed-fact-command.ts";
import type { ProjectScope } from "../modules/projects/public.ts";

const scope: ProjectScope = {
  workspaceId: "ws_demo",
  worldId: "world_demo",
  worldlineId: "worldline_demo",
};

function memoryStore() {
  const groups = new Map<string, { fingerprint: string; result: unknown }>();
  const assets = new Map<string, { quantity: number; revision: number }>([
    ["record_1\0member_1\0asset_1", { quantity: 2, revision: 0 }],
  ]);
  const events = new Set(["event_1", "event_2"]);
  const goalWrites = 0;
  const store: CommittedFactCommandStore = {
    async loadCommand(_scope, idempotencyKey) {
      const found = groups.get(idempotencyKey);
      return found
        ? { requestFingerprint: found.fingerprint, result: found.result as never }
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
      groups.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result });
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
      groups.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result });
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
      groups.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result });
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
      groups.set(input.idempotencyKey, { fingerprint: input.requestFingerprint, result });
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
  const service = createCommittedFactCommandService({ store: memory.store });
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
