import assert from "node:assert/strict";
import test from "node:test";
import type { JsonValue } from "../modules/runtime/public.ts";
import * as memoryContracts from "../modules/world-transfer/realm-runtime-save.ts";
import type { RealmRuntimeSaveDomainV1 } from "../modules/world-transfer/realm-runtime-domain-save.ts";
import { unzipSync, zipSync } from "fflate";
import {
  buildRealmRuntimeSaveArchive,
  computeRealmRuntimeSaveContentHash,
  normalizeRealmRuntimeSaveEventForRestore,
  parseRealmRuntimeSaveArchive,
  parseRealmRuntimeSaveManifestV2,
  realmRuntimeSaveManifestFromData,
  serializeRealmRuntimeSaveActionReceiptsV1,
  serializeRealmRuntimeSaveCharacterEffectsV1,
  serializeRealmRuntimeSaveGoalsV1,
  serializeRealmRuntimeSaveManifestV2,
  serializeRealmRuntimeSaveMemoryV1,
  serializeRealmRuntimeSaveObservationsV1,
  serializeRealmRuntimeSaveOutboxV1,
  serializeRealmRuntimeSaveFirstNightV1,
  serializeRealmRuntimeSaveSelfPlayV1,
  serializeRealmRuntimeSaveRecordV1,
  serializeRealmRuntimeSaveTopologyV1,
  RealmRuntimeSaveError,
  type RealmRuntimeSaveActionReceiptsV1,
  type RealmRuntimeSaveCharacterEffectsV1,
  type RealmRuntimeSaveFirstNightV1,
  type RealmRuntimeSaveGoalsV1,
  type RealmRuntimeSaveManifestV2,
  type RealmRuntimeSaveMemoryV1,
  type RealmRuntimeSaveObservationsV1,
  type RealmRuntimeSaveOutboxV1,
  type RealmRuntimeSaveRecordV1,
  type RealmRuntimeSaveSelfPlayV1,
  type RealmRuntimeSaveTopologyV1,
} from "../modules/world-transfer/realm-runtime-save.ts";

const record: RealmRuntimeSaveRecordV1 = {
  format: "realm-runtime-record",
  schemaVersion: 1,
  scope: {
    worldId: "world-harbor",
    worldlineId: "worldline-main",
    recordId: "record-harbor",
  },
  head: { recordVersion: 3, nextRecordOrdinal: 8 },
  events: [
    {
      eventId: "event-1",
      recordVersion: 1,
      ordinal: 1,
      kind: "utterance.committed",
      payload: { content: "hello" },
    },
  ],
};

const goals: RealmRuntimeSaveGoalsV1 = {
  format: "realm-runtime-goals",
  schemaVersion: 1,
  instances: [{
    id: "goal-instance-1",
    goalKey: "harbor-letter",
    state: "active",
    revision: 0,
  }],
  assessments: [],
};

const topology: RealmRuntimeSaveTopologyV1 = {
  format: "realm-runtime-topology",
  schemaVersion: 1,
  participants: [{
    sourceParticipantId: "participant_scout",
    participantKind: "character",
    sourcePrincipalId: null,
    controllerMode: "ai",
    isActive: true,
    speakingOrder: 1,
    sharedControlEnabled: false,
    character: {
      sourceCharacterInstanceId: "instance_scout",
      sourceContinuityId: "continuity_scout",
      sourcePredecessorInstanceId: null,
      sourceDefinitionId: "definition_scout",
      definition: {
        displayName: "Scout",
        sourceFormat: "native",
        profile: { role: "scout" },
      },
      continuity: {
        continuityKey: "scout",
        status: "active",
        bornTick: 0,
        bornOrdinal: 0,
        endedTick: null,
        endedOrdinal: null,
      },
      instance: {
        controllerMode: "ai",
        status: "present",
        instantiatedTick: 0,
        instantiatedOrdinal: 0,
        inheritanceCutoffTick: 0,
        inheritanceCutoffOrdinal: 0,
        retiredTick: null,
        retiredOrdinal: null,
        state: { mood: "alert" },
      },
    },
  }],
  scenes: [],
  visibilityPolicies: [],
};

const manifest: RealmRuntimeSaveManifestV2 = {
  format: "realm-save",
  formatVersion: 2,
  engineApi: "1.x",
  mode: "world-bound",
  world: { worldId: "world-harbor", worldVersion: "1.2.0" },
  scope: {
    workspaceId: "workspace-main",
    worldlineId: "worldline-main",
    recordId: "record-harbor",
  },
  snapshot: {
    recordVersion: record.head.recordVersion,
    nextRecordOrdinal: record.head.nextRecordOrdinal,
    runtimeHash: "0".repeat(64),
  },
};

function finalizedManifest(): RealmRuntimeSaveManifestV2 {
  const files = new Map<string, Uint8Array>([
    ["runtime/goals.json", Buffer.from(serializeRealmRuntimeSaveGoalsV1(goals))],
    ["runtime/record.json", Buffer.from(serializeRealmRuntimeSaveRecordV1(record))],
  ]);
  return {
    ...manifest,
    snapshot: {
      ...manifest.snapshot,
      runtimeHash: computeRealmRuntimeSaveContentHash(files),
    },
  };
}

test("Realm save v2 manifest is canonical and preserves WorldBinding scope", () => {
  const value = finalizedManifest();
  const serialized = serializeRealmRuntimeSaveManifestV2(value);
  assert.equal(
    serialized,
    '{"format":"realm-save","formatVersion":2,"engineApi":"1.x",'
      + '"mode":"world-bound","world":{"worldId":"world-harbor","worldVersion":"1.2.0"},'
      + '"scope":{"workspaceId":"workspace-main","worldlineId":"worldline-main",'
      + '"recordId":"record-harbor"},"snapshot":{"recordVersion":3,"nextRecordOrdinal":8,'
      + `"runtimeHash":"${value.snapshot.runtimeHash}"}}`,
  );
  assert.equal(serializeRealmRuntimeSaveManifestV2(parseRealmRuntimeSaveManifestV2(serialized)), serialized);
});

test("Realm save v2 archive round-trips Record events and Goal runtime facts", () => {
  const value = finalizedManifest();
  const archive = buildRealmRuntimeSaveArchive({ manifest: value, record, goals });
  const restored = parseRealmRuntimeSaveArchive(archive);
  assert.deepEqual(restored.manifest, value);
  assert.deepEqual(restored.record, record);
  assert.deepEqual(restored.goals, goals);
});

test("Realm save v2 rejects scope/head/hash tampering and unknown runtime entries", () => {
  const value = finalizedManifest();
  assert.throws(
    () => parseRealmRuntimeSaveManifestV2(
      serializeRealmRuntimeSaveManifestV2({
        ...value,
        snapshot: { ...value.snapshot, runtimeHash: "f".repeat(63) },
      }),
    ),
    (error: unknown) => error instanceof RealmRuntimeSaveError
      && error.code === "INVALID_SAVE",
  );

  const archive = buildRealmRuntimeSaveArchive({ manifest: value, record, goals });
  const tampered = zipSync({
    "realm-save-manifest.json": Buffer.from(serializeRealmRuntimeSaveManifestV2(value)),
    "runtime/record.json": Buffer.from(serializeRealmRuntimeSaveRecordV1({
      ...record,
      head: { recordVersion: 3, nextRecordOrdinal: 7 },
    })),
    "runtime/goals.json": Buffer.from(serializeRealmRuntimeSaveGoalsV1(goals)),
  });
  assert.notDeepEqual(tampered, archive);
  assert.throws(
    () => parseRealmRuntimeSaveArchive(tampered),
    (error: unknown) => error instanceof RealmRuntimeSaveError
      && error.code === "RUNTIME_HASH_MISMATCH",
  );

  assert.throws(
    () => parseRealmRuntimeSaveArchive(archive.slice(0, -2)),
    (error: unknown) => error instanceof RealmRuntimeSaveError
      && error.code === "INVALID_SAVE",
  );
});

test("Realm save v2 supports base mode but never silently changes a world binding", () => {
  const value = finalizedManifest();
  const base: RealmRuntimeSaveManifestV2 = {
    ...value,
    mode: "base",
    world: null,
  };
  assert.deepEqual(parseRealmRuntimeSaveManifestV2(serializeRealmRuntimeSaveManifestV2(base)), base);
  for (const source of [
    { ...value, mode: "base" as const, world: value.world },
    { ...value, mode: "world-bound" as const, world: null },
  ]) {
    assert.throws(
      () => serializeRealmRuntimeSaveManifestV2(source),
      (error: unknown) => error instanceof RealmRuntimeSaveError
        && error.code === "INVALID_SAVE",
    );
  }
});

test("Realm save restore normalizes full event projections and preserves colon event ids", () => {
  const event = {
    eventId: "goal-transition:job-1:1",
    recordVersion: 1,
    ordinal: 0,
    kind: "goal.transition.committed",
    payload: {
      content: "Goal completed",
      speakerName: "",
      actorParticipantId: null,
      sceneId: "scene-source",
      visibilityPolicyId: "policy-source",
      worldTick: 4,
      worldOrdinal: 2,
      calendarId: "native_calendar",
      displayTime: "Night",
      eventPayload: { __realmRuntimePayload: { evidenceEventIds: ["event-source"] } },
    },
  } as const;
  assert.deepEqual(normalizeRealmRuntimeSaveEventForRestore(event), {
    eventId: event.eventId,
    recordVersion: 1,
    ordinal: 0,
    kind: "goal.transition.committed",
    content: "Goal completed",
    speakerName: "",
    sourceActorParticipantId: null,
    sourceSceneId: "scene-source",
    sourceVisibilityPolicyId: "policy-source",
    worldTick: 4,
    worldOrdinal: 2,
    calendarId: "native_calendar",
    displayTime: "Night",
    eventPayload: { __realmRuntimePayload: { evidenceEventIds: ["event-source"] } },
  });
  assert.throws(
    () => normalizeRealmRuntimeSaveEventForRestore(record.events[0]!),
    (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE",
  );
});

test("Realm save v2 carries declarative participant and character topology", () => {
  const value = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "world-bound",
    world: manifest.world,
    scope: manifest.scope,
    record,
    goals,
    topology,
  });
  const archive = buildRealmRuntimeSaveArchive({ manifest: value, record, goals, topology });
  const restored = parseRealmRuntimeSaveArchive(archive);
  assert.deepEqual(restored.topology, topology);
  assert.match(serializeRealmRuntimeSaveTopologyV1(topology), /sourceCharacterInstanceId/);
});

test("Realm save v2 carries scene and visibility topology with source references", () => {
  const topologyWithRuntimeGeometry = {
    ...topology,
    scenes: [{
      sourceSceneId: "scene-source",
      title: "Harbor",
      status: "active",
      location: "North pier",
      objective: "Wait for the tide",
      tension: "A storm approaches",
      weather: "Salt rain",
      displayTime: "Night watch",
      startTick: 0,
      startOrdinal: 0,
      endTick: null,
      endOrdinal: null,
    }],
    visibilityPolicies: [{
      sourceVisibilityPolicyId: "policy-source",
      policyKey: "public",
      policyVersion: 1,
      policyKind: "public",
      sourceSceneId: null,
      restrictedDomainId: null,
      sourcePrivateCharacterInstanceId: null,
      sourceAudienceCharacterInstanceIds: [],
    }],
  } as unknown as RealmRuntimeSaveTopologyV1;
  const value = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "world-bound",
    world: manifest.world,
    scope: manifest.scope,
    record,
    goals,
    topology: topologyWithRuntimeGeometry,
  });
  const archive = buildRealmRuntimeSaveArchive({
    manifest: value,
    record,
    goals,
    topology: topologyWithRuntimeGeometry,
  });
  const restored = parseRealmRuntimeSaveArchive(archive);
  assert.deepEqual(restored.topology?.scenes, topologyWithRuntimeGeometry.scenes);
  assert.deepEqual(restored.topology?.visibilityPolicies, topologyWithRuntimeGeometry.visibilityPolicies);

  const restrictedTopology = {
    ...topologyWithRuntimeGeometry,
    visibilityPolicies: [{
      ...topologyWithRuntimeGeometry.visibilityPolicies[0]!,
      policyKey: "secret-scene",
      policyKind: "restricted" as const,
      restrictedDomainId: "secret:player:scout",
      sourceAudienceCharacterInstanceIds: ["instance_scout"],
    }],
  } as unknown as RealmRuntimeSaveTopologyV1;
  const restrictedManifest = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "world-bound",
    world: manifest.world,
    scope: manifest.scope,
    record,
    goals,
    topology: restrictedTopology,
  });
  const restrictedArchive = buildRealmRuntimeSaveArchive({
    manifest: restrictedManifest,
    record,
    goals,
    topology: restrictedTopology,
  });
  assert.equal(parseRealmRuntimeSaveArchive(restrictedArchive).topology?.visibilityPolicies[0]?.restrictedDomainId,
    "secret:player:scout");
});

const actionReceipts: RealmRuntimeSaveActionReceiptsV1 = {
  format: "realm-runtime-action-receipts",
  schemaVersion: 1,
  receipts: [{
    sourceReceiptId: "txn-1:receipt",
    sourceEventId: "event-1",
    sourceActorCharacterInstanceId: "instance_scout",
    transactionId: "txn-1",
    callFingerprint: "fingerprint-1",
    receipt: {
      mechanic: { system: "d20", rolls: [11], modifier: 2, total: 13, target: 12, success: true },
      costs: [{ resourceId: "asset:asset_signal_lantern", amount: 1 }],
      effects: [{ effectId: "effect_watchful_guard", targetId: "instance_scout", operation: "apply" }],
      privateObservations: [],
    },
    worldTick: 4,
    worldOrdinal: 2,
    recordedAt: "2026-08-20T03:00:00.000Z",
  }],
};

const characterEffects: RealmRuntimeSaveCharacterEffectsV1 = {
  format: "realm-runtime-character-effects",
  schemaVersion: 1,
  effects: [{
    sourceCharacterEffectId: "txn-1:effect_watchful_guard",
    sourceCharacterInstanceId: "instance_scout",
    sourceEffectDefinitionId: "effect_watchful_guard",
    effectKey: "watchful_guard",
    sourceActionReceiptId: "txn-1:receipt",
    status: "removed",
    appliedTick: 4,
    appliedOrdinal: 2,
    endedTick: 5,
    endedOrdinal: 1,
    revision: 1,
    metadata: {},
  }],
};

const observations: RealmRuntimeSaveObservationsV1 = {
  format: "realm-runtime-observations",
  schemaVersion: 1,
  observations: [{
    sourceObservationId: "event-1:private:1",
    sourceObserverCharacterInstanceId: "instance_scout",
    sourceEventId: "event-1",
    dedupeKey: "event-1:instance_scout:action-receipt:v1",
    observationKind: "direct",
    content: "蜡封边缘存在一处被重新压合的细痕。",
    fidelity: 0.75,
    occurredTick: 4,
    occurredOrdinal: 2,
    availableFromTick: 4,
    availableFromOrdinal: 3,
    learnedAt: "2026-08-20T03:00:01.000Z",
    metadata: { channel: "action-receipt" },
  }],
};

const embedding384 = (seed: number): readonly number[] => (
  Array.from({ length: 384 }, (_, index) => Math.sin(seed + index) * 0.5)
);

const memory: RealmRuntimeSaveMemoryV1 = {
  format: "realm-runtime-memory",
  schemaVersion: 1,
  conclusions: [
    {
      sourceMemoryId: "mem-harbor-1",
      sourceObserverContinuityId: "continuity_scout",
      observedEntityKey: "harbormaster",
      sourceRecordId: "record-harbor",
      sourceObservationId: "event-1:private:1",
      sourceSupersedesMemoryId: null,
      operation: "add",
      memoryKind: "explicit",
      content: "港务长的蜡封被重新压合过。",
      keywords: ["蜡封", "压合"],
      semanticEmbedding: embedding384(1),
      embeddingModel: "realm-lexical-v1",
      fidelity: 0.75,
      occurredTick: 4,
      occurredOrdinal: 2,
      availableFromTick: 4,
      availableFromOrdinal: 3,
      metadata: { sourceObservationKind: "direct" },
    },
    {
      sourceMemoryId: "mem-harbor-2",
      sourceObserverContinuityId: "continuity_scout",
      observedEntityKey: "harbormaster",
      sourceRecordId: null,
      sourceObservationId: null,
      sourceSupersedesMemoryId: "mem-harbor-1",
      operation: "update",
      memoryKind: "summary",
      content: "修订：蜡封在离港前被压合。",
      keywords: ["蜡封", "离港"],
      semanticEmbedding: embedding384(2),
      embeddingModel: "realm-lexical-v1",
      fidelity: 0.9,
      occurredTick: 4,
      occurredOrdinal: 2,
      availableFromTick: 4,
      availableFromOrdinal: 4,
      metadata: {},
    },
  ],
  snapshots: [{
    sourceSnapshotId: "snap-harbor-1",
    sourceObserverContinuityId: "continuity_scout",
    snapshotKind: "recall",
    content: "关于港务长的已知事实摘要。",
    sourceItemIds: ["mem-harbor-1", "mem-harbor-2"],
    cursorTick: 4,
    cursorOrdinal: 4,
    cacheEpoch: 1,
    tokenCount: 42,
  }],
  relationshipStates: [{
    sourceObserverContinuityId: "continuity_scout",
    targetEntityKey: "harbormaster",
    relationKind: "trust",
    content: "港务长隐瞒过什么，但仍可信。",
    fidelity: 0.6,
    sourceRecordId: "record-harbor",
    sourceObservationId: "event-1:private:1",
    occurredTick: 4,
    occurredOrdinal: 2,
    availableFromTick: 4,
    availableFromOrdinal: 3,
  }],
};

test("Realm save v2 round-trips memory conclusions, snapshots and relationship states", () => {
  const value = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "world-bound",
    world: manifest.world,
    scope: manifest.scope,
    record,
    goals,
    topology,
    observations,
    memory,
  });
  const archive = buildRealmRuntimeSaveArchive({
    manifest: value,
    record,
    goals,
    topology,
    observations,
    memory,
  });
  const restored = parseRealmRuntimeSaveArchive(archive);
  assert.deepEqual(restored.memory, memory);
});

test("Realm save v2 memory section fails closed on schema violations", () => {
  const reject = (build: () => unknown) => {
    assert.throws(
      build,
      (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE",
    );
  };
  const serialize = (section: unknown) => (
    serializeRealmRuntimeSaveMemoryV1(section as RealmRuntimeSaveMemoryV1)
  );
  const firstConclusion = memory.conclusions[0]!;
  const lastConclusion = memory.conclusions[1]!;
  // 未知键。
  reject(() => serialize({
    ...memory,
    conclusions: [{ ...firstConclusion, extra: true }],
  }));
  // embedding 维度/分量非法。
  reject(() => serialize({
    ...memory,
    conclusions: [{ ...firstConclusion, semanticEmbedding: [0.1, 0.2] }],
  }));
  reject(() => serialize({
    ...memory,
    conclusions: [{
      ...firstConclusion,
      semanticEmbedding: embedding384(1).map((value, index) => index === 0 ? Number.NaN : value),
    }],
  }));
  // 非法 operation / memory_kind / snapshot_kind / relation_kind。
  reject(() => serialize({
    ...memory,
    conclusions: [{ ...firstConclusion, operation: "erase" }],
  }));
  reject(() => serialize({
    ...memory,
    conclusions: [{ ...firstConclusion, memoryKind: "dream" }],
  }));
  reject(() => serialize({
    ...memory,
    snapshots: [{ ...memory.snapshots[0]!, snapshotKind: "diff" }],
  }));
  reject(() => serialize({
    ...memory,
    relationshipStates: [{ ...memory.relationshipStates[0]!, relationKind: "love" }],
  }));
  // revision 形状：add 不得携带 supersedes，update/retract 必须携带。
  reject(() => serialize({
    ...memory,
    conclusions: [{ ...firstConclusion, sourceSupersedesMemoryId: "mem-harbor-2" }],
  }));
  reject(() => serialize({
    ...memory,
    conclusions: [memory.conclusions[1]!, { ...lastConclusion, sourceMemoryId: "mem-harbor-3", sourceSupersedesMemoryId: null }],
  }));
  // source record/observation 必须成对出现。
  reject(() => serialize({
    ...memory,
    conclusions: [{ ...firstConclusion, sourceObservationId: null }],
  }));
  // supersedes 指向存档外结论 / supersedes 环。
  reject(() => serialize({
    ...memory,
    conclusions: [memory.conclusions[0]!, { ...lastConclusion, sourceSupersedesMemoryId: "mem-elsewhere" }],
  }));
  reject(() => serialize({
    ...memory,
    conclusions: [
      { ...firstConclusion, operation: "update" as const, sourceSupersedesMemoryId: "mem-harbor-2" },
      { ...lastConclusion, sourceSupersedesMemoryId: "mem-harbor-1" },
    ],
  }));
  // snapshot item_ids 指向存档外结论。
  reject(() => serialize({
    ...memory,
    snapshots: [{ ...memory.snapshots[0]!, sourceItemIds: ["mem-harbor-1", "mem-elsewhere"] }],
  }));
  // availability 游标倒置 / fidelity 越界 / 重复身份。
  reject(() => serialize({
    ...memory,
    conclusions: [{ ...firstConclusion, availableFromOrdinal: 1 }],
  }));
  reject(() => serialize({
    ...memory,
    relationshipStates: [{ ...memory.relationshipStates[0]!, fidelity: -0.1 }],
  }));
  reject(() => serialize({
    ...memory,
    relationshipStates: [memory.relationshipStates[0]!, memory.relationshipStates[0]!],
  }));
  reject(() => serialize({
    ...memory,
    snapshots: [memory.snapshots[0]!, { ...memory.snapshots[0]!, cacheEpoch: -1 }],
  }));
});

test("Realm save v2 memory section rejects cross-Record and dangling references", () => {
  const build = (section: RealmRuntimeSaveMemoryV1) => {
    const value = realmRuntimeSaveManifestFromData({
      engineApi: "1.x",
      mode: "world-bound",
      world: manifest.world,
      scope: manifest.scope,
      record,
      goals,
      topology,
      observations,
      memory: section,
    });
    return buildRealmRuntimeSaveArchive({
      manifest: value,
      record,
      goals,
      topology,
      observations,
      memory: section,
    });
  };
  const reject = (section: RealmRuntimeSaveMemoryV1) => {
    assert.throws(
      () => build(section),
      (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE",
    );
  };
  // 跨 Record 引用。
  reject({
    ...memory,
    conclusions: [{ ...memory.conclusions[0]!, sourceRecordId: "record-elsewhere" }],
  });
  reject({
    ...memory,
    relationshipStates: [{ ...memory.relationshipStates[0]!, sourceRecordId: "record-elsewhere" }],
  });
  // 指向未随存档恢复的 source observation。
  reject({
    ...memory,
    conclusions: [{ ...memory.conclusions[0]!, sourceObservationId: "obs-not-saved" }],
  });
  // observer continuity 不在已保存 topology 内。
  reject({
    ...memory,
    conclusions: [{ ...memory.conclusions[0]!, sourceObserverContinuityId: "continuity-stranger" }],
  });
  reject({
    ...memory,
    snapshots: [{ ...memory.snapshots[0]!, sourceObserverContinuityId: "continuity-stranger" }],
  });
  reject({
    ...memory,
    relationshipStates: [{ ...memory.relationshipStates[0]!, sourceObserverContinuityId: "continuity-stranger" }],
  });
});

test("Realm save v2 round-trips action receipts, character effects and observations", () => {
  const value = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "world-bound",
    world: manifest.world,
    scope: manifest.scope,
    record,
    goals,
    topology,
    actionReceipts,
    characterEffects,
    observations,
  });
  const archive = buildRealmRuntimeSaveArchive({
    manifest: value,
    record,
    goals,
    topology,
    actionReceipts,
    characterEffects,
    observations,
  });
  const restored = parseRealmRuntimeSaveArchive(archive);
  assert.deepEqual(restored.actionReceipts, actionReceipts);
  assert.deepEqual(restored.characterEffects, characterEffects);
  assert.deepEqual(restored.observations, observations);
});

test("Realm save v2 ledger sections fail closed on schema violations", () => {
  const reject = (build: () => unknown) => {
    assert.throws(
      build,
      (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE",
    );
  };
  // 未知键。
  reject(() => serializeRealmRuntimeSaveActionReceiptsV1({
    ...actionReceipts,
    receipts: [{ ...actionReceipts.receipts[0]!, extra: true }],
  } as unknown as RealmRuntimeSaveActionReceiptsV1));
  // 重复 transactionId。
  reject(() => serializeRealmRuntimeSaveActionReceiptsV1({
    ...actionReceipts,
    receipts: [
      actionReceipts.receipts[0]!,
      { ...actionReceipts.receipts[0]!, sourceReceiptId: "txn-1b:receipt" },
    ],
  }));
  // 非 JSON object 的 receipt payload。
  reject(() => serializeRealmRuntimeSaveActionReceiptsV1({
    ...actionReceipts,
    receipts: [{ ...actionReceipts.receipts[0]!, receipt: [1, 2, 3] }],
  } as unknown as RealmRuntimeSaveActionReceiptsV1));
  // 非规范时间戳。
  reject(() => serializeRealmRuntimeSaveActionReceiptsV1({
    ...actionReceipts,
    receipts: [{ ...actionReceipts.receipts[0]!, recordedAt: "2026-08-20 03:00:00" }],
  }));
  // ended 游标半截 / 倒置。
  reject(() => serializeRealmRuntimeSaveCharacterEffectsV1({
    ...characterEffects,
    effects: [{ ...characterEffects.effects[0]!, endedOrdinal: null }],
  }));
  reject(() => serializeRealmRuntimeSaveCharacterEffectsV1({
    ...characterEffects,
    effects: [{ ...characterEffects.effects[0]!, endedTick: 3, endedOrdinal: 9 }],
  }));
  // 非法 status。
  reject(() => serializeRealmRuntimeSaveCharacterEffectsV1({
    ...characterEffects,
    effects: [{ ...characterEffects.effects[0]!, status: "paused" }],
  } as unknown as RealmRuntimeSaveCharacterEffectsV1));
  // 非法 observation kind / fidelity 越界 / availability 倒置。
  reject(() => serializeRealmRuntimeSaveObservationsV1({
    ...observations,
    observations: [{ ...observations.observations[0]!, observationKind: "whisper" }],
  } as unknown as RealmRuntimeSaveObservationsV1));
  reject(() => serializeRealmRuntimeSaveObservationsV1({
    ...observations,
    observations: [{ ...observations.observations[0]!, fidelity: 1.5 }],
  }));
  reject(() => serializeRealmRuntimeSaveObservationsV1({
    ...observations,
    observations: [{ ...observations.observations[0]!, availableFromOrdinal: 1 }],
  }));
  // (observer, dedupeKey) 重复。
  reject(() => serializeRealmRuntimeSaveObservationsV1({
    ...observations,
    observations: [
      observations.observations[0]!,
      { ...observations.observations[0]!, sourceObservationId: "event-1:private:2" },
    ],
  }));
});

test("Realm save v2 rejects unknown runtime entries and corrupted ledger sections", () => {
  const files = new Map<string, Uint8Array>([
    ["runtime/record.json", Buffer.from(serializeRealmRuntimeSaveRecordV1(record))],
    ["runtime/goals.json", Buffer.from(serializeRealmRuntimeSaveGoalsV1(goals))],
    ["runtime/action-receipts.json", Buffer.from(serializeRealmRuntimeSaveActionReceiptsV1(actionReceipts))],
    ["runtime/extra.json", Buffer.from("{}")],
  ]);
  const value: RealmRuntimeSaveManifestV2 = {
    ...manifest,
    snapshot: {
      ...manifest.snapshot,
      runtimeHash: computeRealmRuntimeSaveContentHash(files),
    },
  };
  const withUnknownEntry = zipSync({
    "realm-save-manifest.json": Buffer.from(serializeRealmRuntimeSaveManifestV2(value)),
    "runtime/record.json": files.get("runtime/record.json")!,
    "runtime/goals.json": files.get("runtime/goals.json")!,
    "runtime/action-receipts.json": files.get("runtime/action-receipts.json")!,
    "runtime/extra.json": files.get("runtime/extra.json")!,
  });
  assert.throws(
    () => parseRealmRuntimeSaveArchive(withUnknownEntry),
    (error: unknown) => error instanceof RealmRuntimeSaveError
      && error.code === "INVALID_SAVE",
  );

  // schema 损坏的 observations 段（hash 正确重算）→ parse fail-closed。
  const corruptedObservations = Buffer.from(JSON.stringify({
    format: "realm-runtime-observations",
    schemaVersion: 1,
    observations: [{ sourceObservationId: "obs-1" }],
  }));
  const corruptedFiles = new Map<string, Uint8Array>([
    ["runtime/record.json", files.get("runtime/record.json")!],
    ["runtime/goals.json", files.get("runtime/goals.json")!],
    ["runtime/observations.json", corruptedObservations],
  ]);
  const corruptedManifest: RealmRuntimeSaveManifestV2 = {
    ...manifest,
    snapshot: {
      ...manifest.snapshot,
      runtimeHash: computeRealmRuntimeSaveContentHash(corruptedFiles),
    },
  };
  const corrupted = zipSync({
    "realm-save-manifest.json": Buffer.from(serializeRealmRuntimeSaveManifestV2(corruptedManifest)),
    "runtime/record.json": corruptedFiles.get("runtime/record.json")!,
    "runtime/goals.json": corruptedFiles.get("runtime/goals.json")!,
    "runtime/observations.json": corruptedObservations,
  });
  assert.throws(
    () => parseRealmRuntimeSaveArchive(corrupted),
    (error: unknown) => error instanceof RealmRuntimeSaveError
      && error.code === "INVALID_SAVE",
  );
});

const outbox: RealmRuntimeSaveOutboxV1 = {
  format: "realm-runtime-outbox",
  schemaVersion: 1,
  messages: [
    {
      sourceMessageId: "msg-pending-1",
      dedupeKey: "turn-1:event-1",
      topic: "record.event.available",
      envelope: { kind: "record.event.available", recordId: "record-harbor" },
      state: "pending",
      deliveryAttempts: 0,
      nextAttemptAt: "2026-08-20T04:00:00.000Z",
      sourceEventId: "event-1",
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
    },
    {
      sourceMessageId: "msg-delivering-1",
      dedupeKey: "turn-2:hook",
      topic: "record.first-night.ready",
      envelope: { kind: "record.first-night.ready" },
      state: "delivering",
      deliveryAttempts: 1,
      nextAttemptAt: "2026-08-20T04:01:00.000Z",
      sourceEventId: null,
      leaseOwner: "worker-1",
      leaseExpiresAt: "2026-08-20T05:00:00.000Z",
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
    },
    {
      sourceMessageId: "msg-failed-1",
      dedupeKey: "turn-3:beat",
      topic: "record.self-play.beat",
      envelope: { kind: "record.self-play.beat" },
      state: "failed",
      deliveryAttempts: 5,
      nextAttemptAt: "2026-08-20T04:10:00.000Z",
      sourceEventId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: "SINK_REJECTED",
      lastErrorMessage: "sink rejected the envelope",
      lastErrorAt: "2026-08-20T04:12:00.000Z",
    },
  ],
};

const firstNight: RealmRuntimeSaveFirstNightV1 = {
  format: "realm-runtime-first-night",
  schemaVersion: 1,
  entry: {
    state: "pending",
    attempts: 1,
    hookContent: "",
    suggestions: [],
    context: { world: { name: "雾港" }, opening: "雾夜栈桥。" },
  },
};

const selfPlay: RealmRuntimeSaveSelfPlayV1 = {
  format: "realm-runtime-self-play",
  schemaVersion: 1,
  sessions: [
    {
      sourceSessionId: "sp-completed-1",
      state: "completed",
      beatBudget: 3,
      beatsCompleted: 3,
      requestedBy: "principal_demo_player",
      lastError: null,
    },
    {
      sourceSessionId: "sp-failed-1",
      state: "failed",
      beatBudget: 5,
      beatsCompleted: 2,
      requestedBy: "principal_demo_player",
      lastError: "scheduler heartbeat lost",
    },
  ],
};

test("Realm save v2 round-trips outbox, first-night and self-play sections", () => {
  const value = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "world-bound",
    world: manifest.world,
    scope: manifest.scope,
    record,
    goals,
    topology,
    outbox,
    firstNight,
    selfPlay,
  });
  const archive = buildRealmRuntimeSaveArchive({
    manifest: value,
    record,
    goals,
    topology,
    outbox,
    firstNight,
    selfPlay,
  });
  const restored = parseRealmRuntimeSaveArchive(archive);
  assert.deepEqual(restored.outbox, outbox);
  assert.deepEqual(restored.firstNight, firstNight);
  assert.deepEqual(restored.selfPlay, selfPlay);
  // first-night 状态行缺省（旧 Record 无状态行）也合法 round-trip。
  const emptyFirstNight: RealmRuntimeSaveFirstNightV1 = {
    format: "realm-runtime-first-night",
    schemaVersion: 1,
    entry: null,
  };
  const emptyValue = realmRuntimeSaveManifestFromData({
    engineApi: "1.x",
    mode: "world-bound",
    world: manifest.world,
    scope: manifest.scope,
    record,
    goals,
    firstNight: emptyFirstNight,
  });
  const emptyArchive = buildRealmRuntimeSaveArchive({
    manifest: emptyValue,
    record,
    goals,
    firstNight: emptyFirstNight,
  });
  assert.deepEqual(parseRealmRuntimeSaveArchive(emptyArchive).firstNight, emptyFirstNight);
});

test("Realm save v2 outbox section fails closed on schema violations", () => {
  const reject = (build: () => unknown) => {
    assert.throws(
      build,
      (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE",
    );
  };
  const serialize = (section: unknown) => (
    serializeRealmRuntimeSaveOutboxV1(section as RealmRuntimeSaveOutboxV1)
  );
  const pending = outbox.messages[0]!;
  const delivering = outbox.messages[1]!;
  const failed = outbox.messages[2]!;
  // 未知键。
  reject(() => serialize({ ...outbox, messages: [{ ...pending, extra: true }] }));
  // delivered 终态消息不得进入存档。
  reject(() => serialize({ ...outbox, messages: [{ ...pending, state: "delivered" }] }));
  // lease 形状：delivering 必须携带 lease，非 delivering 不得携带。
  reject(() => serialize({
    ...outbox,
    messages: [{ ...delivering, leaseOwner: null, leaseExpiresAt: null }],
  }));
  reject(() => serialize({
    ...outbox,
    messages: [{ ...pending, leaseOwner: "worker-1", leaseExpiresAt: "2026-08-20T05:00:00.000Z" }],
  }));
  // lease 时间戳必须规范。
  reject(() => serialize({
    ...outbox,
    messages: [{ ...delivering, leaseExpiresAt: "not-a-timestamp" }],
  }));
  // 失败形状：pending 不得携带失败细节；failed/retryable 必须携带完整三元组。
  reject(() => serialize({
    ...outbox,
    messages: [{ ...pending, lastErrorCode: "SINK_TIMEOUT" }],
  }));
  reject(() => serialize({
    ...outbox,
    messages: [{ ...failed, lastErrorMessage: null }],
  }));
  // deliveryAttempts 下界 / nextAttemptAt 规范时间戳。
  reject(() => serialize({ ...outbox, messages: [{ ...pending, deliveryAttempts: -1 }] }));
  reject(() => serialize({ ...outbox, messages: [{ ...pending, nextAttemptAt: "2026-08-20" }] }));
  // 空 dedupeKey / topic、超长 dedupeKey。
  reject(() => serialize({ ...outbox, messages: [{ ...pending, dedupeKey: " " }] }));
  reject(() => serialize({ ...outbox, messages: [{ ...pending, topic: "" }] }));
  reject(() => serialize({ ...outbox, messages: [{ ...pending, dedupeKey: "x".repeat(513) }] }));
  // envelope 必须是 JSON object。
  reject(() => serialize({ ...outbox, messages: [{ ...pending, envelope: [] }] }));
  // 身份与 dedupeKey 唯一。
  reject(() => serialize({ ...outbox, messages: [pending, pending] }));
  reject(() => serialize({
    ...outbox,
    messages: [pending, { ...delivering, dedupeKey: pending.dedupeKey }],
  }));
});

test("Realm save v2 outbox section rejects references outside the saved Record", () => {
  const build = (section: RealmRuntimeSaveOutboxV1) => {
    const value = realmRuntimeSaveManifestFromData({
      engineApi: "1.x",
      mode: "world-bound",
      world: manifest.world,
      scope: manifest.scope,
      record,
      goals,
      outbox: section,
    });
    return buildRealmRuntimeSaveArchive({ manifest: value, record, goals, outbox: section });
  };
  // 指向存档外 Event（跨 Record 引用的等效形态）→ build 期 fail-closed。
  assert.throws(
    () => build({
      ...outbox,
      messages: [{ ...outbox.messages[0]!, sourceEventId: "event-elsewhere" }],
    }),
    (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE",
  );
});

test("Realm save v2 first-night and self-play sections fail closed on schema violations", () => {
  const reject = (build: () => unknown) => {
    assert.throws(
      build,
      (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE",
    );
  };
  const serializeFirstNight = (section: unknown) => (
    serializeRealmRuntimeSaveFirstNightV1(section as RealmRuntimeSaveFirstNightV1)
  );
  const serializeSelfPlay = (section: unknown) => (
    serializeRealmRuntimeSaveSelfPlayV1(section as RealmRuntimeSaveSelfPlayV1)
  );
  const entry = firstNight.entry!;
  // first-night：非法状态枚举 / 负 attempts / 超长 hook / 空 suggestion / context 非 object。
  reject(() => serializeFirstNight({ ...firstNight, entry: { ...entry, state: "corrupted" } }));
  reject(() => serializeFirstNight({ ...firstNight, entry: { ...entry, attempts: -1 } }));
  reject(() => serializeFirstNight({ ...firstNight, entry: { ...entry, hookContent: "x".repeat(8193) } }));
  reject(() => serializeFirstNight({ ...firstNight, entry: { ...entry, suggestions: ["  "] } }));
  reject(() => serializeFirstNight({ ...firstNight, entry: { ...entry, context: [] } }));
  // self-play：非法状态 / 拍预算下界 / 已拍数超预算 / 空 requestedBy / 重复身份。
  const completed = selfPlay.sessions[0]!;
  reject(() => serializeSelfPlay({ ...selfPlay, sessions: [{ ...completed, state: "ready" }] }));
  reject(() => serializeSelfPlay({ ...selfPlay, sessions: [{ ...completed, beatBudget: 0 }] }));
  reject(() => serializeSelfPlay({
    ...selfPlay,
    sessions: [{ ...completed, beatBudget: 3, beatsCompleted: 4 }],
  }));
  reject(() => serializeSelfPlay({ ...selfPlay, sessions: [{ ...completed, requestedBy: " " }] }));
  reject(() => serializeSelfPlay({ ...selfPlay, sessions: [completed, completed] }));
});


// F4a1 pure fixtures: these do not assert PostgreSQL reader/restore integration.
function emptyMemoryV2() {
  return {
    format: "realm-runtime-memory" as const,
    schemaVersion: 2 as const,
    scope: { workspaceId: "workspace-main", worldId: "world-harbor", worldlineId: "worldline-main" },
    worldlineHead: { tick: 4, ordinal: 4 },
    conclusions: [], snapshots: [], relationshipStates: [], cacheEpochs: [],
  };
}

test("F4a1 structural V2 API normalizes a detached strict canonical document", () => {
  assert.equal(typeof memoryContracts.normalizeRealmRuntimeSaveMemoryV2, "function", "missing pure V2 API, not the live PG product RED");
  const input = emptyMemoryV2();
  const normalized = memoryContracts.normalizeRealmRuntimeSaveMemoryV2(input);
  assert.deepEqual(normalized, input);
  assert.notEqual(normalized, input);
  assert.notEqual(normalized.scope, input.scope);
  assert.equal(memoryContracts.serializeRealmRuntimeSaveMemoryV2(input),
    '{"cacheEpochs":[],"conclusions":[],"format":"realm-runtime-memory","relationshipStates":[],"schemaVersion":2,"scope":{"workspaceId":"workspace-main","worldId":"world-harbor","worldlineId":"worldline-main"},"snapshots":[],"worldlineHead":{"ordinal":4,"tick":4}}');
  for (const bad of [{ ...input, extra: 1 }, { ...input, schemaVersion: 3 }, { ...input, scope: { ...input.scope, extra: true } }, { ...input, worldlineHead: { tick: -1, ordinal: 0 } }]) {
    assert.throws(() => memoryContracts.normalizeRealmRuntimeSaveMemoryV2(bad), (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE");
  }
});


function pureMemoryV2(): memoryContracts.RealmRuntimeSaveMemoryV2 {
  return {
    ...emptyMemoryV2(),
    conclusions: structuredClone(memory.conclusions),
    snapshots: [{ ...structuredClone(memory.snapshots[0]!), sourceItemIds: ["mem-harbor-1", "mem-harbor-2", "mem-harbor-1"] },
      { ...structuredClone(memory.snapshots[0]!), sourceSnapshotId: "empty-snapshot", content: "", sourceItemIds: [], tokenCount: 0 }],
    relationshipStates: [{ ...memory.relationshipStates[0]!, sourceObservationId: null }],
    cacheEpochs: [{ sourceObserverContinuityId: "continuity_scout", epoch: 1 }],
  };
}

function invalidPureMemory(action: () => unknown, message?: string) {
  assert.throws(action, (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE" && (message === undefined || error.message === message));
}

test("F4a1 V2 rows preserve legitimate values and enforce SQL int32 and bounded identifier scalars", () => {
  const source = pureMemoryV2();
  const normalized = memoryContracts.normalizeRealmRuntimeSaveMemoryV2(source);
  assert.equal(normalized.snapshots.find((row) => row.sourceSnapshotId === "empty-snapshot")!.content, "");
  assert.equal(normalized.relationshipStates[0]!.sourceObservationId, null);
  assert.deepEqual(normalized.snapshots.find((row) => row.sourceSnapshotId === "snap-harbor-1")!.sourceItemIds, ["mem-harbor-1", "mem-harbor-2", "mem-harbor-1"]);
  const bads = [
    { ...source, cacheEpochs: [{ ...source.cacheEpochs[0]!, epoch: 2147483648 }] },
    { ...source, snapshots: [{ ...source.snapshots[0]!, cacheEpoch: 2147483648 }] },
    { ...source, snapshots: [{ ...source.snapshots[0]!, tokenCount: 2147483648 }] },
    { ...source, scope: { ...source.scope, worldId: "x".repeat(513) } },
    { ...source, conclusions: [{ ...source.conclusions[0]!, sourceMemoryId: "x".repeat(513) }] },
  ];
  for (const bad of bads) invalidPureMemory(() => memoryContracts.normalizeRealmRuntimeSaveMemoryV2(bad));
  const limit = { ...source, cacheEpochs: [{ ...source.cacheEpochs[0]!, epoch: 2147483647 }] };
  assert.equal(memoryContracts.normalizeRealmRuntimeSaveMemoryV2(limit).cacheEpochs[0]!.epoch, 2147483647);
});


function globalMemoryFixture(reverse = false) {
  const a = { record: structuredClone(record), topology: structuredClone(topology), observations: structuredClone(observations), goals: structuredClone(goals) };
  const b = structuredClone(a);
  b.record.scope.recordId = "record-sibling";
  b.record.events = b.record.events.map((event) => ({ ...event, eventId: "event-sibling" }));
  b.topology.participants = b.topology.participants.map((participant) => ({ ...participant, sourceParticipantId: "participant_sibling", character: participant.character ? { ...participant.character, sourceCharacterInstanceId: "instance_sibling" } : null }));
  b.observations.observations = b.observations.observations.map((observation) => ({ ...observation, sourceObservationId: "observation-sibling", sourceObserverCharacterInstanceId: "instance_sibling", sourceEventId: "event-1" }));
  const doc = pureMemoryV2();
  doc.conclusions = [
    { ...structuredClone(doc.conclusions[1]!), sourceMemoryId: "mem-harbor-3", sourceSupersedesMemoryId: "mem-harbor-2", availableFromTick: 20 },
    { ...structuredClone(doc.conclusions[1]!), sourceRecordId: b.record.scope.recordId, sourceObservationId: "observation-sibling" },
    structuredClone(doc.conclusions[0]!),
  ];
  const primary = reverse ? b : a, sibling = reverse ? a : b;
  return {
    manifest: { ...structuredClone(manifest), scope: { ...manifest.scope, recordId: primary.record.scope.recordId } },
    record: primary.record, topology: primary.topology, observations: primary.observations,
    memory: doc, siblings: [sibling],
  };
}

test("F4a1 complete-context resolver resolves two Records and a forward-declared global chain independently of primary order", () => {
  assert.equal(typeof memoryContracts.resolveRealmRuntimeSaveArchiveMemory, "function", "missing pure global API, not repaired runtime behavior");
  for (const reverse of [false, true]) {
    const input = globalMemoryFixture(reverse);
    if (reverse) input.memory.conclusions = [...input.memory.conclusions].reverse();
    const result = memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input);
    assert.equal(result.sourceFormat, "v2");
    assert.deepEqual(result.worldlineHead, { tick: 4, ordinal: 4 });
    assert.deepEqual(result.supersedesOrder, ["mem-harbor-1", "mem-harbor-2", "mem-harbor-3"]);
    assert.equal(result.conclusions.find((row) => row.sourceMemoryId === "mem-harbor-2")!.sourceRecordId, "record-sibling");
    assert.equal(result.conclusions.find((row) => row.sourceMemoryId === "mem-harbor-3")!.availableFromTick, 20);
    assert.deepEqual(result.observationOwners.find((row) => row.sourceObservationId === "observation-sibling"), {
      sourceObservationId: "observation-sibling", sourceRecordId: "record-sibling", sourceCharacterInstanceId: "instance_sibling", sourceObserverContinuityId: "continuity_scout", sourceEventId: "event-1", sourceEventRecordId: "record-harbor",
    });
    assert.deepEqual(result.snapshots.find((row) => row.sourceSnapshotId === "snap-harbor-1")!.sourceItemIds, ["mem-harbor-1", "mem-harbor-2", "mem-harbor-1"]);
  }
});


function multiObserverMemoryFixture() {
  const input = globalMemoryFixture();
  const participant = structuredClone(input.topology.participants[0]!);
  participant.sourceParticipantId = "participant_other";
  participant.character!.sourceCharacterInstanceId = "instance_other";
  participant.character!.sourceContinuityId = "continuity_other";
  participant.character!.sourceDefinitionId = "definition_other";
  participant.character!.continuity.continuityKey = "other";
  input.topology.participants = [...input.topology.participants, participant];
  input.memory.conclusions = [...input.memory.conclusions, { ...structuredClone(memory.conclusions[0]!), sourceMemoryId: "memory_other", sourceObserverContinuityId: "continuity_other", sourceRecordId: null, sourceObservationId: null }];
  input.memory.cacheEpochs = [...input.memory.cacheEpochs, { sourceObserverContinuityId: "continuity_other", epoch: 0 }];
  return input;
}

test("F4a1 a globally present same-scope other-observer snapshot item rejects with the frozen error", () => {
  const input = multiObserverMemoryFixture();
  assert.equal(memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input).conclusions.length, 4);
  input.memory.snapshots = [{ ...input.memory.snapshots[0]!, sourceItemIds: ["mem-harbor-1", "memory_other", "mem-harbor-1"] }];
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input), "Memory snapshot item observer does not match.");
});


test("F4a1 V2 carries exact per-topology epochs and refuses future retained epochs", () => {
  const input = multiObserverMemoryFixture();
  const exact = memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input);
  assert.deepEqual(exact.cacheEpochs, [{ sourceObserverContinuityId: "continuity_other", epoch: 0 }, { sourceObserverContinuityId: "continuity_scout", epoch: 1 }]);
  const lower = structuredClone(input);
  lower.memory.cacheEpochs = lower.memory.cacheEpochs.map((row) => ({ ...row, epoch: 0 }));
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(lower), "Memory cache epoch precedes a retained snapshot.");
  for (const epochs of [input.memory.cacheEpochs.slice(0, 1), [...input.memory.cacheEpochs, { sourceObserverContinuityId: "orphan", epoch: 0 }]]) {
    invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory({ ...input, memory: { ...input.memory, cacheEpochs: epochs } }));
  }
  const stale = structuredClone(input);
  stale.memory.cacheEpochs = stale.memory.cacheEpochs.map((row) => ({ ...row, epoch: 2147483647 }));
  assert.equal(memoryContracts.resolveRealmRuntimeSaveArchiveMemory(stale).cacheEpochs[0]!.epoch, 2147483647);
});


function legacyMemoryContext() {
  return { manifest: structuredClone(manifest), record: structuredClone(record), topology: structuredClone(topology), observations: structuredClone(observations), memory: structuredClone(memory) };
}

test("F4a1 legacy effective counters use checked observer max+1 while retaining bytes and unknown head", () => {
  const input = legacyMemoryContext();
  input.memory.snapshots = [0, 1, 7].map((epoch) => ({ ...input.memory.snapshots[0]!, sourceSnapshotId: `legacy-${epoch}`, cacheEpoch: epoch }));
  const bytes = serializeRealmRuntimeSaveMemoryV1(input.memory);
  const result = memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input);
  assert.equal(result.sourceFormat, "legacy");
  assert.equal(result.worldlineHead, null);
  assert.deepEqual(result.cacheEpochs, [{ sourceObserverContinuityId: "continuity_scout", epoch: 8 }]);
  assert.deepEqual(result.snapshots, input.memory.snapshots);
  assert.equal(serializeRealmRuntimeSaveMemoryV1(input.memory), bytes);
  assert.equal(memoryContracts.resolveRealmRuntimeSaveArchiveMemory({ ...input, memory: { ...input.memory, snapshots: [] } }).cacheEpochs[0]!.epoch, 0);
  const boundary = (epoch: number) => ({ ...input, memory: { ...input.memory, snapshots: [{ ...input.memory.snapshots[0]!, cacheEpoch: epoch }] } });
  assert.equal(memoryContracts.resolveRealmRuntimeSaveArchiveMemory(boundary(2147483646)).cacheEpochs[0]!.epoch, 2147483647);
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(boundary(2147483647)), "Legacy memory cache epoch is exhausted.");
  assert.equal(memoryContracts.resolveRealmRuntimeSaveArchiveMemory({ ...input, memory: undefined }).cacheEpochs[0]!.epoch, 0);
});


function sharedLegacyMemoryFixture() {
  const input = legacyMemoryContext();
  input.memory.conclusions = input.memory.conclusions.map((row) => ({ ...row, sourceRecordId: null, sourceObservationId: null }));
  input.memory.relationshipStates = input.memory.relationshipStates.map((row) => ({ ...row, sourceRecordId: null, sourceObservationId: null }));
  return { ...input, siblings: [{ ...globalMemoryFixture().siblings[0]!, memory: structuredClone(input.memory) }] };
}

test("F4a1 identical legacy rows collapse only across documents and all conflicting typed values reject", () => {
  const input = sharedLegacyMemoryFixture();
  const result = memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input);
  assert.equal(result.conclusions.length, 2);
  assert.equal(result.snapshots.length, 1);
  assert.equal(result.relationshipStates.length, 1);
  const mutate = [
    (doc: RealmRuntimeSaveMemoryV1) => { doc.conclusions = [{ ...doc.conclusions[0]!, content: "contradiction" }, doc.conclusions[1]!]; },
    (doc: RealmRuntimeSaveMemoryV1) => { doc.conclusions = [{ ...doc.conclusions[0]!, metadata: { concealed: true } }, doc.conclusions[1]!]; },
    (doc: RealmRuntimeSaveMemoryV1) => { doc.conclusions = [{ ...doc.conclusions[0]!, semanticEmbedding: embedding384(99) }, doc.conclusions[1]!]; },
    (doc: RealmRuntimeSaveMemoryV1) => { doc.snapshots = [{ ...doc.snapshots[0]!, sourceItemIds: [...doc.snapshots[0]!.sourceItemIds].reverse() }]; },
    (doc: RealmRuntimeSaveMemoryV1) => { doc.snapshots = [{ ...doc.snapshots[0]!, cacheEpoch: 5 }]; },
    (doc: RealmRuntimeSaveMemoryV1) => { doc.relationshipStates = [{ ...doc.relationshipStates[0]!, content: "contradiction" }]; },
  ];
  for (const change of mutate) { const bad = structuredClone(input); change(bad.siblings[0]!.memory); invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(bad)); }
  const repeated = structuredClone(input);
  repeated.memory.conclusions = [...repeated.memory.conclusions, repeated.memory.conclusions[0]!];
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(repeated));
});


test("F4a1 canonical memory rejects mixing any sibling legacy document even when empty", () => {
  const input = globalMemoryFixture();
  const sibling = input.siblings[0]!;
  const mixed = { ...input, siblings: [{ ...sibling, memory: { format: "realm-runtime-memory" as const, schemaVersion: 1 as const, conclusions: [], snapshots: [], relationshipStates: [] } }] };
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(mixed));
});


test("F4a1 exact source head must cover recorded cursors but never future availability", () => {
  const input = globalMemoryFixture();
  assert.equal(memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input).worldlineHead!.tick, 4);
  input.memory.snapshots = [{ ...input.memory.snapshots[0]!, cursorTick: 5 }];
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input));
  input.memory.worldlineHead = { tick: 5, ordinal: 4 };
  assert.deepEqual(memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input).worldlineHead, { tick: 5, ordinal: 4 });
});


test("F4a1 global ownership, scope, DAG and canonical duplicate adversaries fail closed", () => {
  const changes: ((input: ReturnType<typeof globalMemoryFixture>) => void)[] = [
    (input) => { input.memory.scope.workspaceId = "other-workspace"; },
    (input) => { input.memory.scope.worldId = "other-world"; },
    (input) => { input.memory.scope.worldlineId = "other-line"; },
    (input) => { input.siblings[0]!.record.scope.worldId = "other-world"; },
    (input) => { input.siblings[0]!.record.scope.worldlineId = "other-line"; },
    (input) => { input.memory.conclusions = input.memory.conclusions.map((row) => row.sourceMemoryId === "mem-harbor-1" ? { ...row, sourceRecordId: "record-sibling" } : row); },
    (input) => { input.memory.conclusions = input.memory.conclusions.map((row) => ({ ...row, sourceObserverContinuityId: "missing-observer" })); },
    (input) => { input.memory.relationshipStates = [{ ...input.memory.relationshipStates[0]!, sourceRecordId: "missing-record" }]; },
    (input) => { input.memory.relationshipStates = [{ ...input.memory.relationshipStates[0]!, sourceRecordId: "record-sibling", sourceObservationId: observations.observations[0]!.sourceObservationId }]; },
    (input) => { input.siblings[0]!.observations.observations = [{ ...input.siblings[0]!.observations.observations[0]!, sourceObserverCharacterInstanceId: "instance_scout" }]; },
    (input) => { input.siblings[0]!.observations.observations = [{ ...input.siblings[0]!.observations.observations[0]!, sourceEventId: "missing-event" }]; },
    (input) => { input.siblings[0]!.observations.observations = [{ ...input.siblings[0]!.observations.observations[0]!, sourceObservationId: observations.observations[0]!.sourceObservationId }]; },
    (input) => { input.siblings[0]!.topology.participants[0]!.character!.sourceCharacterInstanceId = "instance_scout"; },
    (input) => { input.siblings[0]!.topology.participants[0]!.character!.continuity.bornTick = 1; },
    (input) => { input.siblings[0]!.topology.participants[0]!.character!.definition.profile = { different: true }; },
    (input) => { input.siblings[0]!.record.events = [{ ...input.siblings[0]!.record.events[0]!, eventId: "event-1" }]; },
    (input) => { input.memory.conclusions = input.memory.conclusions.map((row) => row.operation === "add" ? { ...row, operation: "update", sourceSupersedesMemoryId: "mem-harbor-3" } : row); },
    (input) => { input.memory.conclusions = input.memory.conclusions.map((row) => row.sourceMemoryId === "mem-harbor-3" ? { ...row, sourceSupersedesMemoryId: row.sourceMemoryId } : row); },
    (input) => { input.memory.conclusions = input.memory.conclusions.map((row) => row.sourceMemoryId === "mem-harbor-3" ? { ...row, sourceSupersedesMemoryId: "missing-memory" } : row); },
    (input) => { input.memory.snapshots = [{ ...input.memory.snapshots[0]!, sourceItemIds: ["missing-memory"] }]; },
    (input) => { input.memory.conclusions = [...input.memory.conclusions, input.memory.conclusions[0]!]; },
    (input) => { input.memory.snapshots = [...input.memory.snapshots, input.memory.snapshots[0]!]; },
    (input) => { input.memory.relationshipStates = [...input.memory.relationshipStates, input.memory.relationshipStates[0]!]; },
    (input) => { input.memory.cacheEpochs = [...input.memory.cacheEpochs, input.memory.cacheEpochs[0]!]; },
  ];
  for (const change of changes) { const input = globalMemoryFixture(); change(input); invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input)); }
  const crossObserver = multiObserverMemoryFixture();
  crossObserver.memory.conclusions = crossObserver.memory.conclusions.map((row) => row.sourceMemoryId === "mem-harbor-2" ? { ...row, sourceObserverContinuityId: "continuity_other" } : row);
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(crossObserver));
  const successor = multiObserverMemoryFixture();
  successor.memory.conclusions = successor.memory.conclusions.map((row) => row.sourceMemoryId === "memory_other" ? { ...row, operation: "update", sourceSupersedesMemoryId: "mem-harbor-1" } : row);
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(successor));
});

test("F4a1 strict scalar/shape adversaries preserve the separate V1 rejection contract", () => {
  const doc = pureMemoryV2(), first = doc.conclusions[0]!;
  const rowChanges = [
    { extra: true }, { sourceMemoryId: "bad/id" }, { sourceObserverContinuityId: "colon:observer" },
    { sourceMemoryId: " leading" }, { sourceRecordId: ".." }, { operation: "unknown" }, { memoryKind: "unknown" },
    { sourceRecordId: null, sourceObservationId: "dangling" }, { sourceSupersedesMemoryId: "not-null" },
    { semanticEmbedding: [1] }, { semanticEmbedding: Array(384) }, { semanticEmbedding: Array(384).fill(Infinity) },
    { fidelity: -1 }, { fidelity: NaN }, { fidelity: 1.1 }, { occurredTick: Number.MAX_SAFE_INTEGER + 1 },
    { occurredOrdinal: -1 }, { occurredTick: 5, availableFromTick: 4 }, { metadata: { invalid: Infinity } },
    { content: " " }, { keywords: [42] }, { embeddingModel: "" },
  ];
  for (const change of rowChanges) invalidPureMemory(() => memoryContracts.normalizeRealmRuntimeSaveMemoryV2({ ...doc, conclusions: [{ ...first, ...change }] }));
  for (const change of [{ schemaVersion: 1 }, { snapshots: [{ ...doc.snapshots[0]!, snapshotKind: "unknown" }] }, { relationshipStates: [{ ...doc.relationshipStates[0]!, sourceRecordId: null, sourceObservationId: "observation" }] }, { cacheEpochs: [{ sourceObserverContinuityId: "continuity_scout", epoch: -1 }] }, { cacheEpochs: [{ sourceObserverContinuityId: "continuity_scout", epoch: 0.5 }] }]) {
    invalidPureMemory(() => memoryContracts.normalizeRealmRuntimeSaveMemoryV2({ ...doc, ...change }));
  }
  invalidPureMemory(() => serializeRealmRuntimeSaveMemoryV1({ ...memory, snapshots: [{ ...memory.snapshots[0]!, content: "" }] }));
  invalidPureMemory(() => serializeRealmRuntimeSaveMemoryV1({ ...memory, relationshipStates: [{ ...memory.relationshipStates[0]!, sourceObservationId: null }] }));
  const idLimit = { ...doc, conclusions: [{ ...first, sourceMemoryId: "x".repeat(512) }] };
  assert.equal(memoryContracts.normalizeRealmRuntimeSaveMemoryV2(idLimit).conclusions[0]!.sourceMemoryId.length, 512);
});

test("F4a1 outputs own nested data and retain opaque literals, Unicode, numeric JSON and typed namespace coincidences", () => {
  const input = globalMemoryFixture();
  const metadata = JSON.parse('{"z":["record-sibling",{"a":1e-7,"z":-0}],"__proto__":{"safe":true}}');
  input.memory.conclusions = input.memory.conclusions.map((row) => ({ ...row, content: "record-sibling / instance_scout / \"港\"\n", keywords: ["record-sibling", "record-sibling"], observedEntityKey: "instance_scout", metadata }));
  input.memory.relationshipStates = [{ ...input.memory.relationshipStates[0]!, targetEntityKey: "record-sibling" }];
  input.memory.snapshots = input.memory.snapshots.map((row) => ({ ...row, sourceSnapshotId: row.sourceSnapshotId === "snap-harbor-1" ? "mem-harbor-1" : row.sourceSnapshotId }));
  const normalized = memoryContracts.normalizeRealmRuntimeSaveMemoryV2(input.memory);
  const result = memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input);
  const image = JSON.stringify(result);
  assert.equal(result.conclusions[0]!.content, input.memory.conclusions[0]!.content);
  assert.deepEqual(result.conclusions[0]!.metadata, metadata);
  assert.equal(result.relationshipStates[0]!.targetEntityKey, "record-sibling");
  metadata.z[1].a = 2;
  input.memory.conclusions[0]!.semanticEmbedding = Array(384).fill(0);
  input.memory.snapshots[0]!.sourceItemIds = [];
  input.topology.participants[0]!.character!.definition.profile = { changed: true };
  input.observations.observations = [];
  assert.equal(JSON.stringify(result), image);
  assert.deepEqual(normalized.conclusions[0]!.metadata.z, ["record-sibling", { a: 1e-7, z: -0 }]);
  let getterCalls = 0;
  const accessor = { ...pureMemoryV2(), get conclusions() { getterCalls++; return []; } };
  invalidPureMemory(() => memoryContracts.normalizeRealmRuntimeSaveMemoryV2(accessor));
  assert.equal(getterCalls, 0);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  invalidPureMemory(() => memoryContracts.normalizeRealmRuntimeSaveMemoryV2({ ...pureMemoryV2(), conclusions: [{ ...firstPureConclusion(), metadata: cycle }] }));
});

function firstPureConclusion() { return structuredClone(memory.conclusions[0]!); }

function domainMemoryFixture(): memoryContracts.RealmRuntimeSaveArchiveMemoryInput {
  const input = globalMemoryFixture();
  const domain: RealmRuntimeSaveDomainV1 = {
    format: "realm-runtime-domain", schemaVersion: 1,
    source: { ...input.record.scope, storyId: "story-main" },
    stories: [{ id: "story-main", title: "Main", status: "active", premise: "Pure fixture" }, { id: "story-other", title: "Other", status: "active", premise: "Pure fixture" }],
    records: [{ recordId: "record-sibling", storyId: "story-other", title: "Sibling", status: "active", worldVersion: "1.2.0", startTick: 0, startOrdinal: 0, timelineKind: "primary", linkedRecordId: null, lastEventId: null, lastWorldTick: 4, lastWorldOrdinal: 4, bundle: input.siblings[0]! }],
    storyDefinitions: [], projects: [], milestones: [], projectStoryLinks: [], budgetAllocations: [], financeAccounts: [], ledgerEntries: [], financeCommandGroups: [], obligations: [], obligationSettlements: [], storyNodes: [], storyUnlockLedger: [], committedFactCommands: [], performanceAssessments: [], memberRelationshipRevisions: [], characterAssets: [],
  };
  return { ...input, siblings: undefined, domain };
}

test("F4a1 complete existing domain bundles provide cross-Story memory context without mutating the domain", () => {
  const input = domainMemoryFixture(), before = JSON.stringify(input);
  const result = memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input);
  assert.equal(result.observationOwners.length, 2);
  assert.equal(result.conclusions.length, 3);
  assert.equal(JSON.stringify(input), before);
  const bad = structuredClone(input); bad.domain!.source.worldId = "other-world";
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(bad));
});

test("F4a1 legacy observer ownership and independent multi-observer maxima are explicit compatibility rules", () => {
  const input = legacyMemoryContext(), additional = multiObserverMemoryFixture().topology.participants[1]!;
  input.topology.participants = [...input.topology.participants, additional];
  input.memory.conclusions = [...input.memory.conclusions, { ...firstPureConclusion(), sourceMemoryId: "other-memory", sourceObserverContinuityId: "continuity_other", sourceRecordId: null, sourceObservationId: null }];
  input.memory.snapshots = [...input.memory.snapshots, { ...input.memory.snapshots[0]!, sourceSnapshotId: "other-snapshot", sourceObserverContinuityId: "continuity_other", sourceItemIds: ["other-memory", "other-memory"], cacheEpoch: 9 }];
  const result = memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input);
  assert.deepEqual(result.cacheEpochs, [{ sourceObserverContinuityId: "continuity_other", epoch: 10 }, { sourceObserverContinuityId: "continuity_scout", epoch: 2 }]);
  const bad = structuredClone(input);
  bad.memory.snapshots = [{ ...bad.memory.snapshots[0]!, sourceItemIds: ["other-memory"] }];
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(bad), "Memory snapshot item observer does not match.");
});


test("F4a1 canonical row order compares literal UTF8 keys before JSON escaping", () => {
  const input = pureMemoryV2(), row = input.relationshipStates[0]!;
  input.relationshipStates = [{ ...row, targetEntityKey: "a b" }, { ...row, targetEntityKey: "a\nb" }];
  assert.deepEqual(memoryContracts.normalizeRealmRuntimeSaveMemoryV2(input).relationshipStates.map((entry) => entry.targetEntityKey), ["a\nb", "a b"]);
});


test("F4a1 pure serializer accepts REAL 64MiB canonical UTF8 and rejects exactly one more byte", (t) => {
  const limit = 64 * 1024 * 1024;
  const input = pureMemoryV2();
  const first = { ...input.conclusions[0]!, content: "x", metadata: { z: [1e-7, -0, "\\\"\n港"], a: { y: 1e21, b: true } } };
  input.conclusions = [first, input.conclusions[1]!];
  const base = Buffer.byteLength(memoryContracts.serializeRealmRuntimeSaveMemoryV2(input), "utf8");
  first.content = "xx";
  assert.equal(Buffer.byteLength(memoryContracts.serializeRealmRuntimeSaveMemoryV2(input), "utf8") - base, 1);
  first.content = "x".repeat(limit - base + 1);
  const encoded = memoryContracts.serializeRealmRuntimeSaveMemoryV2(input);
  const exactBytes = Buffer.byteLength(encoded, "utf8");
  assert.equal(exactBytes, 67108864);
  first.content += "x";
  invalidPureMemory(() => memoryContracts.serializeRealmRuntimeSaveMemoryV2(input), "MemoryV2 exceeds the runtime file byte limit.");
  t.diagnostic(JSON.stringify({ codecOnly: true, realLimit: limit, measuredBaseBytes: base, fillerBytesAtLimit: first.content.length - 1, exactBytes, oneByteOverRejected: 67108865, unicodeEscapesAndNumericMetadata: true, pgCapacityProved: false }));
});


test("F4a1 a large forward-declared legacy DAG resolves globally across identical complete bundles", () => {
  const input = sharedLegacyMemoryFixture();
  const count = 2048;
  const conclusions = Array.from({ length: count }, (_, i) => ({
    ...firstPureConclusion(), sourceMemoryId: `chain-${String(i).padStart(5, "0")}`,
    sourceRecordId: null, sourceObservationId: null, semanticEmbedding: Array(384).fill(0),
    operation: i === 0 ? "add" as const : "update" as const,
    sourceSupersedesMemoryId: i === 0 ? null : `chain-${String(i - 1).padStart(5, "0")}`,
  })).reverse();
  input.memory.conclusions = conclusions;
  input.memory.snapshots = [{ ...input.memory.snapshots[0]!, sourceItemIds: [conclusions[0]!.sourceMemoryId] }];
  input.siblings[0]!.memory = structuredClone(input.memory);
  const result = memoryContracts.resolveRealmRuntimeSaveArchiveMemory(input);
  assert.equal(result.conclusions.length, count);
  assert.deepEqual(result.supersedesOrder, [...conclusions].reverse().map((row) => row.sourceMemoryId));
});


test("F4a1 pure context failures retain the INVALID_SAVE error surface", () => {
  const input = globalMemoryFixture();
  const invalid = { ...input, manifest: { ...input.manifest, formatVersion: 3 } };
  invalidPureMemory(() => memoryContracts.resolveRealmRuntimeSaveArchiveMemory(invalid as unknown as memoryContracts.RealmRuntimeSaveArchiveMemoryInput));
});


// R1 derivatives of Iris's two preserved interruption probes. The replacement
// positive uses domain.records; the historical siblings ZIP is never accepted.
function runtimeDomainMemoryInput() {
  const fixture = domainMemoryFixture();
  delete fixture.siblings;
  return { ...fixture, ...fixture.manifest, goals: structuredClone(goals) };
}

function forgeRuntimeEntry(bytes: Uint8Array, path: string, value: unknown): Uint8Array {
  const entries = unzipSync(bytes);
  entries[path] = Buffer.from(JSON.stringify(value));
  const manifest = JSON.parse(Buffer.from(entries["realm-save-manifest.json"]!).toString("utf8"));
  manifest.snapshot.runtimeHash = computeRealmRuntimeSaveContentHash(new Map(
    Object.entries(entries).filter(([name]) => name.startsWith("runtime/")),
  ));
  entries["realm-save-manifest.json"] = Buffer.from(JSON.stringify(manifest));
  return zipSync(entries, { mtime: new Date(1980, 0, 1) });
}

test("R1 manifest validates complete domain memory before hashing known epochs", () => {
  const input = runtimeDomainMemoryInput();
  const manifest = realmRuntimeSaveManifestFromData(input);
  assert.ok(buildRealmRuntimeSaveArchive({ ...input, manifest }).length > 0);
  const memory = structuredClone(input.memory!);
  assert.equal(memory.schemaVersion, 2);
  if (memory.schemaVersion !== 2) throw new Error("fixture requires V2");
  memory.cacheEpochs = memory.cacheEpochs.map((row) => ({ ...row, epoch: 0 }));
  invalidPureMemory(() => realmRuntimeSaveManifestFromData({ ...input, memory }),
    "Memory cache epoch precedes a retained snapshot.");
});

test("R1 accepted domain archive rejects hash-correct removed siblings entries of either shape", () => {
  const input = runtimeDomainMemoryInput();
  const bytes = buildRealmRuntimeSaveArchive({ ...input, manifest: realmRuntimeSaveManifestFromData(input) });
  const archive = parseRealmRuntimeSaveArchive(bytes);
  assert.equal(archive.domain!.records!.length, 1);
  assert.equal("siblings" in archive, false);
  assert.equal("runtime/siblings.json" in unzipSync(bytes), false);
  for (const value of [[], { notAnArray: true }]) {
    invalidPureMemory(() => parseRealmRuntimeSaveArchive(forgeRuntimeEntry(bytes, "runtime/siblings.json", value)));
  }
});

test("R1 manifest builder and hash-correct parser share scope owner shape and epoch validation", () => {
  const input = runtimeDomainMemoryInput();
  const manifest = realmRuntimeSaveManifestFromData(input);
  const bytes = buildRealmRuntimeSaveArchive({ ...input, manifest });
  const changes: ((value: memoryContracts.RealmRuntimeSaveMemoryV2) => void)[] = [
    (value) => { value.scope.worldId = "wrong-world"; },
    (value) => { value.conclusions = value.conclusions.map((row) => row.sourceObservationId === "observation-sibling" ? { ...row, sourceRecordId: input.record.scope.recordId } : row); },
    (value) => { value.cacheEpochs = value.cacheEpochs.map((row) => ({ ...row, epoch: 0 })); },
  ];
  for (const change of changes) {
    const memory = structuredClone(input.memory!) as memoryContracts.RealmRuntimeSaveMemoryV2;
    change(memory);
    invalidPureMemory(() => realmRuntimeSaveManifestFromData({ ...input, memory }));
    invalidPureMemory(() => buildRealmRuntimeSaveArchive({ ...input, manifest, memory }));
    invalidPureMemory(() => parseRealmRuntimeSaveArchive(forgeRuntimeEntry(bytes, "runtime/memory.json", memory)));
  }
  for (const memory of [{ ...input.memory, conclusions: {} }, { ...input.memory, schemaVersion: 3 }]) {
    invalidPureMemory(() => parseRealmRuntimeSaveArchive(forgeRuntimeEntry(bytes, "runtime/memory.json", memory)));
  }
});


test("R1 removed root siblings input rejects at manifest and builder", () => {
  const input = runtimeDomainMemoryInput();
  const manifest = realmRuntimeSaveManifestFromData(input);
  for (const siblings of [[], {}, undefined]) {
    const bad = { ...input, manifest, siblings };
    invalidPureMemory(() => realmRuntimeSaveManifestFromData(bad));
    invalidPureMemory(() => buildRealmRuntimeSaveArchive(bad));
  }
});

// F4a3-M additive bounded JSONB/count controls; native parsing is the reference.
test("F4a3-M bounded JSON chunks preserve native Unicode escapes, arrays, objects and binary64",()=>{
  const raws=[
    ' { "z": [true, null, false, "港😀\\\\\\"\\b\\f\\n\\r\\t\\u0000", ["A","B","A"]], "a": {"2":-0,"__proto__":{"x":1},"1":9007199254740993} } ',
    '[1.00000000000000011102230246251565404236316680908203125,1.00000000000000011102230246251565404236316680908203126,4.9406564584124654e-324,-2.4703282292062327e-324,1e-7,1e21]',
    JSON.stringify({"鍵😀":"\ud800","low":"\udfff","nested":[{},[],"/",0.000001,Number.MAX_VALUE]}),
  ];
  for(const raw of raws){
    const expected=JSON.parse(raw) as JsonValue,bytes=memoryContracts.countMemoryCanonicalBytes(expected),utf8=Buffer.from(raw);
    for(let split=0;split<=utf8.length;split++){
      const parser=new memoryContracts.MemoryPgJsonStream(bytes);parser.write(utf8.subarray(0,split));parser.write(utf8.subarray(split));
      assert.deepEqual(parser.finish(),expected);assert.equal(parser.bytes,bytes);
    }
    for(let split=0;split<=raw.length;split++){
      const parser=new memoryContracts.MemoryPgJsonStream(bytes);parser.write(raw.slice(0,split));parser.write(raw.slice(split));
      assert.deepEqual(parser.finish(),expected);assert.equal(parser.bytes,bytes);
    }
    assert.throws(()=>{const parser=new memoryContracts.MemoryPgJsonStream(bytes-1);parser.write(raw);parser.finish();},{code:"INVALID_SAVE"});
  }
  for(const raw of ['1e309','[1,]','{"x":}','"unterminated','true false','[NaN]'])assert.throws(()=>{
    const parser=new memoryContracts.MemoryPgJsonStream(1000);parser.write(raw);parser.finish();
  },{code:"INVALID_SAVE"});
});

test("F4a3-M PostgreSQL-scale numeric tokens use full native rounding and count only normalized bytes",()=>{
  for(const token of ['0.'+'0'.repeat(16382)+'1','1.'+'0'.repeat(16383),'-0.'+'0'.repeat(16383),
    '0.'+'0'.repeat(322)+'247032822920623272088284396434110686182529901307162382212792841250337']){
    const expected=JSON.parse(token) as number,bytes=JSON.stringify(expected).length;
    for(const size of [1,7,16384]){
      const parser=new memoryContracts.MemoryPgJsonStream(bytes);
      for(let at=0;at<token.length;at+=size)parser.write(token.slice(at,at+size));
      assert.equal(Object.is(parser.finish(),expected),true);assert.equal(parser.bytes,bytes);
    }
  }
  assert.ok(memoryContracts.MEMORY_PG_NUMBER_TOKEN_CHARS>=131072+16383+2);
  const decimal='1.'+'0'.repeat(16383),raw=`{"small":${decimal},"array":["A","B","A"]}`;
  const expected=JSON.parse(raw) as JsonValue,bytes=memoryContracts.countMemoryCanonicalBytes(expected);
  assert.ok(Buffer.byteLength(raw)>bytes+16000);
  const parser=new memoryContracts.MemoryPgJsonStream(bytes);parser.write(raw);assert.deepEqual(parser.finish(),expected);
});

test("F4a3-M memory wire ledger exactly matches existing canonical formatter",()=>{
  const document=pureMemoryV2();
  const ledger=new memoryContracts.MemoryWireByteLedger({...document,conclusions:[],snapshots:[],relationshipStates:[],cacheEpochs:[]});
  for(const key of ['conclusions','snapshots','relationshipStates','cacheEpochs'] as const){
    document[key].forEach((row,index)=>ledger.add(memoryContracts.countMemoryCanonicalBytes(row as unknown as JsonValue)+(index?1:0)));
  }
  ledger.verify(document);
  assert.equal(ledger.bytes,Buffer.byteLength(memoryContracts.serializeRealmRuntimeSaveMemoryV2(document)));
  for(const value of ['港😀"\\\b\f\n\r\t\u0000','\ud800','\udfff','x'.repeat(20000)])assert.equal(memoryContracts.memoryJsonStringBytes(value),Buffer.byteLength(JSON.stringify(value)));
});

test("F4a3-M highly compressible memory stays within unchanged strict ZIP ratio policy",()=>{
  const input=runtimeDomainMemoryInput();input.memory!.conclusions[0]!.content='a'.repeat(2*1024*1024);
  const actualManifest=realmRuntimeSaveManifestFromData(input),bytes=buildRealmRuntimeSaveArchive({...input,manifest:actualManifest});
  const parsed=parseRealmRuntimeSaveArchive(bytes);assert.equal(parsed.manifest.snapshot.runtimeHash,actualManifest.snapshot.runtimeHash);
  assert.equal(parsed.memory!.conclusions.find(row=>row.sourceMemoryId===input.memory!.conclusions[0]!.sourceMemoryId)!.content.length,2*1024*1024);
  const decoded=unzipSync(bytes);
  const oldPackaging=zipSync(decoded,{level:6,mtime:new Date(1980,0,1)});
  assert.throws(()=>parseRealmRuntimeSaveArchive(oldPackaging),{code:'INVALID_SAVE',message:'runtime save archive failed ZIP validation'});
  assert.ok(bytes.length>oldPackaging.length);
  assert.deepEqual(unzipSync(bytes),unzipSync(oldPackaging),'padding has zero decoded content; every runtime byte and hash remains exact');
});

test("F4a3-M bounded JSON/count property vectors match ordinary native JSON",()=>{
  let state=8191;const next=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state;};
  for(let i=0;i<200;i++){
    const value={['鍵'+next()]:['港😀',String.fromCharCode(92,34,10,9),next()/7,next()%2===0,null],
      n:[Number.MIN_VALUE,Number.MAX_VALUE,Number("9007199254740993"),-0,0.000001],nested:{z:next(),a:['A','B','A']}};
    const raw=JSON.stringify(value),reference=JSON.parse(raw) as JsonValue,limit=memoryContracts.countMemoryCanonicalBytes(reference);
    const parser=new memoryContracts.MemoryPgJsonStream(limit),bytes=Buffer.from(raw),step=1+next()%23;
    for(let at=0;at<bytes.length;at+=step)parser.write(bytes.subarray(at,at+step));
    assert.deepEqual(parser.finish(),reference);assert.equal(parser.bytes,limit);
  }
});

test("F4a3-M legacy V1 small archive bytes remain exactly the existing zipSync encoding",()=>{
  const input={engineApi:'1.x',mode:'world-bound' as const,world:manifest.world,scope:manifest.scope,record,goals,topology,observations,memory};
  const actualManifest=realmRuntimeSaveManifestFromData(input);
  const bytes=buildRealmRuntimeSaveArchive({...input,manifest:actualManifest});
  assert.deepEqual(bytes,zipSync(unzipSync(bytes),{level:6,mtime:new Date(1980,0,1)}));
  assert.deepEqual(parseRealmRuntimeSaveArchive(bytes).memory,memory);
});
