import assert from "node:assert/strict";
import test from "node:test";
import { zipSync } from "fflate";
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
