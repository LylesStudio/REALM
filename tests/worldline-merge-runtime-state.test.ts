/**
 * worldline merge/reconcile 运行态契约（纯规划器层，无数据库）。
 *
 * 覆盖 ENGINE-BACKEND-REMAINING Slice 4 的 merge 运行态审计：
 * - 支持物化的运行态（action receipts / character effects / observations）
 *   在目标 Record 中按作用域引用重映射，载荷与游标逐字节保留；
 * - 本切片不支持物化的持久运行态（Goal 实例/评估/评估作业、outbox、
 *   first-night、self-play、memory conclusions/snapshots/relationship
 *   states）在源拓扑中出现时，规划器在任何目标写入前整体 fail-closed，
 *   产出稳定机器码且零目标拓扑（status='unsupported' 不携带 topology）；
 * - 无法安全重映射的引用（被 none 去重的 source event、跨 Record 引用、
 *   缺失的 receipt/实例、不支持的事件类型、未知 payload recipientId）
 *   同样 fail-closed，绝不静默丢弃运行态。
 *
 * 仓储探针（database/postgres/worldline-merge-repository.ts）把九类持久
 * 运行态记到 record.unsupported；本文件逐一断言规划器对这些稳定码的
 * fail-closed 语义。PG 级零残留（行数前后一致）由
 * tests/postgres-worldline-merge-runtime.test.ts 覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  mergePayloadKey,
  planMergeMaterialization,
  type MergeManifestEntry,
  type MergeRecordPlan,
  type MergeSourceEvent,
  type MergeSourceSnapshot,
  type MergeUnsupportedReason,
} from "../modules/worldline/merge.ts";

const WORLDLINE_A = "worldline_origin";
const WORLDLINE_B = "worldline_branch";
const RECORD_A = "record_a";
const RECORD_B = "record_b";

/** 仓储探针可上报的全部 Record 级不支持运行态稳定机器码。 */
const PROBE_UNSUPPORTED_REASONS = [
  "goal_instances",
  "goal_assessments",
  "goal_assessment_jobs",
  "outbox",
  "record_first_nights",
  "record_self_play_sessions",
  "durable_jobs",
  "memory_conclusions",
  "memory_snapshots",
  "relationship_states",
] as const satisfies readonly MergeUnsupportedReason[];

interface SnapshotOptions {
  worldlineId: string;
  recordId: string;
  events?: readonly MergeSourceEvent[];
  unsupported?: readonly MergeUnsupportedReason[];
  actionReceipts?: MergeSourceSnapshot["actionReceipts"];
  characterEffects?: MergeSourceSnapshot["characterEffects"];
  observations?: MergeSourceSnapshot["observations"];
}

function makeEvent(
  recordId: string,
  worldlineId: string,
  suffix: string,
  overrides: Partial<MergeSourceEvent> = {},
): MergeSourceEvent {
  return {
    eventId: `event_${recordId}_${suffix}`,
    recordId,
    worldlineId,
    tick: 10,
    ordinal: 1,
    speaker: "narrator",
    payloadKey: `payload_${recordId}_${suffix}`,
    eventKind: "narration.committed",
    recordVersion: 1,
    recordOrdinal: 1,
    batchIndex: 0,
    actorParticipantId: null,
    content: `narration ${suffix}`,
    payload: { narration: `narration ${suffix}` },
    sceneId: `scene_${recordId}`,
    visibilityPolicyId: `policy_${recordId}`,
    calendarId: "calendar_default",
    displayTime: "night watch",
    ...overrides,
  };
}

/** 最小合法源快照：单 Record + 完整拓扑链（continuity/instance/participant/policy/scene）。 */
function makeSnapshot(options: SnapshotOptions): MergeSourceSnapshot {
  const { worldlineId, recordId } = options;
  const continuityId = `continuity_${recordId}`;
  const instanceId = `char_instance_${recordId}`;
  return {
    worldlineId,
    records: [{
      id: recordId,
      title: `Record ${recordId}`,
      status: "active",
      worldVersion: "1",
      unsupported: options.unsupported ?? [],
    }],
    continuities: [{
      id: continuityId,
      definitionId: "char_def_player",
      continuityKey: "player",
      status: "active",
      bornTick: 0,
      bornOrdinal: 0,
      endedTick: null,
      endedOrdinal: null,
    }],
    scenes: [{
      id: `scene_${recordId}`,
      recordId,
      title: "North breakwater",
      status: "active",
      location: "breakwater",
      objective: "keep the watch",
      tension: "calm",
      weather: "fog",
      displayTime: "night watch",
      startTick: 0,
      startOrdinal: 0,
      endTick: null,
      endOrdinal: null,
    }],
    instances: [{
      id: instanceId,
      recordId,
      continuityId,
      predecessorInstanceId: null,
      controllerMode: "player",
      status: "active",
      instantiatedTick: 0,
      instantiatedOrdinal: 0,
      inheritanceCutoffTick: 0,
      inheritanceCutoffOrdinal: 0,
      retiredTick: null,
      retiredOrdinal: null,
      state: { stance: "watching" },
    }],
    participants: [{
      id: `participant_${recordId}`,
      recordId,
      participantKind: "character",
      characterInstanceId: instanceId,
      principalId: "principal_demo_player",
      controllerMode: "player",
      isActive: true,
      speakingOrder: 1,
      sharedControlEnabled: false,
    }],
    visibilityPolicies: [{
      id: `policy_${recordId}`,
      recordId,
      policyKey: "public",
      policyVersion: 1,
      policyKind: "public",
      sceneId: null,
      restrictedDomainId: null,
      privateCharacterInstanceId: null,
      audienceCharacterInstanceIds: [],
    }],
    skills: [],
    assets: [],
    actionReceipts: options.actionReceipts ?? [],
    characterEffects: options.characterEffects ?? [],
    observations: options.observations ?? [],
    events: options.events ?? [],
  };
}

/** 全局 merge manifest：目标 ordinal 从 1 连续，按 tick/worldOrdinal 排序。 */
function makeManifest(
  entries: readonly { worldlineId: string; recordId: string; event: MergeSourceEvent }[],
): MergeManifestEntry[] {
  return entries.map((entry, index) => ({
    ordinal: index + 1,
    tick: entry.event.tick,
    worldOrdinal: entry.event.ordinal,
    sourceWorldlineId: entry.worldlineId,
    sourceRecordId: entry.recordId,
    eventId: entry.event.eventId,
    resolution: "kept",
  }));
}

function plan(
  sources: readonly [MergeSourceSnapshot, MergeSourceSnapshot],
  manifest: readonly MergeManifestEntry[],
  dedupedEventIds: ReadonlySet<string> = new Set(),
) {
  let counter = 0;
  return planMergeMaterialization({
    worldlineId: "worldline_merged",
    label: "merged",
    storyId: "story_merged",
    storyTitle: "Merged timeline",
    sources,
    manifest,
    dedupedEventIds,
    idFactory: () => `test_${++counter}`,
  });
}

function recordPlan(
  result: Extract<ReturnType<typeof plan>, { status: "ok" }>,
  sourceRecordId: string,
): MergeRecordPlan {
  const found = result.topology.records.find(
    (record) => record.sourceRecordId === sourceRecordId,
  );
  assert.ok(found, `target plan for ${sourceRecordId} must exist`);
  return found;
}

/** 基线夹具：双侧各一 Record 各一事件，无冲突无去重。 */
function baseline() {
  const eventA = makeEvent(RECORD_A, WORLDLINE_A, "one", { tick: 10, ordinal: 1 });
  const eventB = makeEvent(RECORD_B, WORLDLINE_B, "one", { tick: 20, ordinal: 1 });
  const snapshotA = makeSnapshot({ worldlineId: WORLDLINE_A, recordId: RECORD_A, events: [eventA] });
  const snapshotB = makeSnapshot({ worldlineId: WORLDLINE_B, recordId: RECORD_B, events: [eventB] });
  const manifest = makeManifest([
    { worldlineId: WORLDLINE_A, recordId: RECORD_A, event: eventA },
    { worldlineId: WORLDLINE_B, recordId: RECORD_B, event: eventB },
  ]);
  return { eventA, eventB, snapshotA, snapshotB, manifest };
}

test("merge materializes supported runtime states with byte-identical payloads and remapped references", () => {
  const receiptPayload = {
    roll: { die: "d20", result: 17, modifier: 3 },
    cost: { item: "char_def_lamp_oil", quantity: 1 },
    facts: ["lantern lit"],
  };
  const effectMetadata = { magnitude: 2, notes: ["stance", "focused"] };
  const observationMetadata = { source: "watch", confidenceNote: "firsthand" };

  const eventA = makeEvent(RECORD_A, WORLDLINE_A, "one", {
    tick: 10,
    ordinal: 1,
    actorParticipantId: `participant_${RECORD_A}`,
    payload: {
      narration: "the watchman lights the lantern",
      recipientId: `participant_${RECORD_A}`,
    },
  });
  const eventB = makeEvent(RECORD_B, WORLDLINE_B, "one", { tick: 20, ordinal: 1 });
  const snapshotA = makeSnapshot({
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    events: [eventA],
    actionReceipts: [{
      recordId: RECORD_A,
      id: "receipt_a_1",
      actorCharacterInstanceId: `char_instance_${RECORD_A}`,
      sourceEventId: eventA.eventId,
      transactionId: "txn_a_1",
      callFingerprint: "fingerprint_a_1",
      receipt: receiptPayload,
      worldTick: 10,
      worldOrdinal: 1,
      recordedAt: "2026-10-01T00:00:00.000Z",
    }],
    characterEffects: [{
      recordId: RECORD_A,
      id: "effect_a_1",
      characterInstanceId: `char_instance_${RECORD_A}`,
      effectKey: "stance_focused",
      sourceActionReceiptId: "receipt_a_1",
      status: "active",
      appliedTick: 10,
      appliedOrdinal: 1,
      endedTick: null,
      endedOrdinal: null,
      revision: 3,
      metadata: effectMetadata,
    }],
    observations: [{
      recordId: RECORD_A,
      id: "observation_a_1",
      observerCharacterInstanceId: `char_instance_${RECORD_A}`,
      sourceEventId: eventA.eventId,
      dedupeKey: "obs:watchman:lantern",
      observationKind: "firsthand",
      content: "The watchman lit the lantern.",
      fidelity: 0.9,
      occurredTick: 10,
      occurredOrdinal: 1,
      availableFromTick: 10,
      availableFromOrdinal: 1,
      learnedAt: "2026-10-01T00:00:01.000Z",
      metadata: observationMetadata,
    }],
  });
  const snapshotB = makeSnapshot({ worldlineId: WORLDLINE_B, recordId: RECORD_B, events: [eventB] });
  const manifest = makeManifest([
    { worldlineId: WORLDLINE_A, recordId: RECORD_A, event: eventA },
    { worldlineId: WORLDLINE_B, recordId: RECORD_B, event: eventB },
  ]);

  const result = plan([snapshotA, snapshotB], manifest);
  assert.equal(result.status, "ok");
  const record = recordPlan(result, RECORD_A);

  // Action receipt：载荷逐字节一致，游标/时间戳/溯源字段原样，作用域引用
  // 重映射到目标 ID。
  assert.equal(record.actionReceipts.length, 1);
  const receipt = record.actionReceipts[0]!;
  assert.equal(mergePayloadKey(receipt.receipt), mergePayloadKey(receiptPayload));
  assert.equal(JSON.stringify(receipt.receipt), JSON.stringify(receiptPayload));
  assert.equal(receipt.transactionId, "txn_a_1");
  assert.equal(receipt.callFingerprint, "fingerprint_a_1");
  assert.equal(receipt.worldTick, 10);
  assert.equal(receipt.worldOrdinal, 1);
  assert.equal(receipt.recordedAt, "2026-10-01T00:00:00.000Z");
  assert.ok(receipt.id.startsWith("action_receipt_merge_"));
  const targetEvent = record.events[0]!;
  assert.equal(receipt.sourceEventId, targetEvent.id);
  assert.equal(receipt.actorCharacterInstanceId, record.instances[0]!.id);

  // Character effect：effectKey/游标/revision/metadata 原样，引用重映射。
  assert.equal(record.characterEffects.length, 1);
  const effect = record.characterEffects[0]!;
  assert.equal(effect.effectKey, "stance_focused");
  assert.equal(effect.status, "active");
  assert.equal(effect.appliedTick, 10);
  assert.equal(effect.appliedOrdinal, 1);
  assert.equal(effect.endedTick, null);
  assert.equal(effect.endedOrdinal, null);
  assert.equal(effect.revision, 3);
  assert.equal(JSON.stringify(effect.metadata), JSON.stringify(effectMetadata));
  assert.equal(effect.characterInstanceId, record.instances[0]!.id);
  assert.equal(effect.sourceActionReceiptId, receipt.id);

  // Observation：内容/dedupe key/fidelity/游标/learnedAt/metadata 逐字节
  // 一致，observer 与 source event 重映射。
  assert.equal(record.observations.length, 1);
  const observation = record.observations[0]!;
  assert.equal(observation.dedupeKey, "obs:watchman:lantern");
  assert.equal(observation.observationKind, "firsthand");
  assert.equal(observation.content, "The watchman lit the lantern.");
  assert.equal(observation.fidelity, 0.9);
  assert.equal(observation.occurredTick, 10);
  assert.equal(observation.occurredOrdinal, 1);
  assert.equal(observation.availableFromTick, 10);
  assert.equal(observation.availableFromOrdinal, 1);
  assert.equal(observation.learnedAt, "2026-10-01T00:00:01.000Z");
  assert.equal(JSON.stringify(observation.metadata), JSON.stringify(observationMetadata));
  assert.equal(observation.observerCharacterInstanceId, record.instances[0]!.id);
  assert.equal(observation.sourceEventId, targetEvent.id);

  // 事件 payload：仅 recipientId 重映射到目标参与者，其余逐字节保留。
  const payload = targetEvent.payload as Record<string, unknown>;
  assert.equal(payload.recipientId, record.participants[0]!.id);
  assert.equal(payload.narration, "the watchman lights the lantern");
  assert.equal(targetEvent.actorParticipantId, record.participants[0]!.id);
  assert.deepEqual(record.head, {
    recordVersion: 1,
    nextRecordOrdinal: 2,
    lastEventId: targetEvent.id,
    lastWorldTick: 10,
    lastWorldOrdinal: 1,
  });
});

for (const reason of PROBE_UNSUPPORTED_REASONS) {
  test(`merge fails closed with stable code ${reason} and zero target topology`, () => {
    const { snapshotA, snapshotB, manifest } = baseline();
    const tainted: MergeSourceSnapshot = {
      ...snapshotA,
      records: [{ ...snapshotA.records[0]!, unsupported: [reason] }],
    };
    const result = plan([tainted, snapshotB], manifest);
    assert.equal(result.status, "unsupported");
    // 零目标拓扑残留：unsupported 结果不携带任何物化计划。
    assert.ok(!("topology" in result), "unsupported result must not carry a topology plan");
    assert.deepEqual(result.records, [{
      worldlineId: WORLDLINE_A,
      recordId: RECORD_A,
      reasons: [reason],
    }]);
  });
}

test("merge aggregates unsupported runtime states from both source records deterministically", () => {
  const { snapshotA, snapshotB, manifest } = baseline();
  const taintedA: MergeSourceSnapshot = {
    ...snapshotA,
    records: [{ ...snapshotA.records[0]!, unsupported: ["outbox", "goal_instances"] }],
  };
  const taintedB: MergeSourceSnapshot = {
    ...snapshotB,
    records: [{
      ...snapshotB.records[0]!,
      unsupported: ["memory_conclusions", "record_self_play_sessions"],
    }],
  };
  const result = plan([taintedA, taintedB], manifest);
  assert.equal(result.status, "unsupported");
  assert.ok(!("topology" in result));
  // 稳定排序：records 按 worldlineId/recordId，reasons 字典序去重。
  assert.deepEqual(result.records, [
    {
      worldlineId: WORLDLINE_B,
      recordId: RECORD_B,
      reasons: ["memory_conclusions", "record_self_play_sessions"],
    },
    { worldlineId: WORLDLINE_A, recordId: RECORD_A, reasons: ["goal_instances", "outbox"] },
  ]);
});

test("merge fails closed when an observation references a none-deduplicated source event", () => {
  const eventA = makeEvent(RECORD_A, WORLDLINE_A, "one", { tick: 10, ordinal: 1 });
  const dedupedEvent = makeEvent(RECORD_A, WORLDLINE_A, "dup", { tick: 10, ordinal: 2 });
  const snapshotA = makeSnapshot({
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    events: [eventA, dedupedEvent],
    observations: [{
      recordId: RECORD_A,
      id: "observation_a_1",
      observerCharacterInstanceId: `char_instance_${RECORD_A}`,
      sourceEventId: dedupedEvent.eventId,
      dedupeKey: "obs:dup",
      observationKind: "firsthand",
      content: "saw the deduplicated event",
      fidelity: 1,
      occurredTick: 10,
      occurredOrdinal: 2,
      availableFromTick: 10,
      availableFromOrdinal: 2,
      learnedAt: "2026-10-01T00:00:02.000Z",
      metadata: {},
    }],
  });
  const { snapshotB, manifest: baseManifest } = baseline();
  const manifest = [
    ...baseManifest.filter((entry) => entry.sourceRecordId !== RECORD_A),
    ...makeManifest([{ worldlineId: WORLDLINE_A, recordId: RECORD_A, event: eventA }]),
  ];
  // 被 none 去重的事件不复制，引用它的 observation 无法安全重映射。
  const result = plan([snapshotA, snapshotB], manifest, new Set([dedupedEvent.eventId]));
  assert.equal(result.status, "unsupported");
  assert.ok(!("topology" in result));
  assert.deepEqual(result.records, [{
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    reasons: ["unmappable_event_reference"],
  }]);
});

test("merge fails closed when an observation references a cross-record source event", () => {
  const eventA = makeEvent(RECORD_A, WORLDLINE_A, "one", { tick: 10, ordinal: 1 });
  const eventB = makeEvent(RECORD_B, WORLDLINE_B, "one", { tick: 20, ordinal: 1 });
  const snapshotA = makeSnapshot({
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    events: [eventA],
    observations: [{
      recordId: RECORD_A,
      id: "observation_a_1",
      observerCharacterInstanceId: `char_instance_${RECORD_A}`,
      // 跨 Record 引用：事件属于 RECORD_B，不在 RECORD_A 的复制集合内。
      sourceEventId: eventB.eventId,
      dedupeKey: "obs:cross",
      observationKind: "firsthand",
      content: "saw the other record event",
      fidelity: 1,
      occurredTick: 20,
      occurredOrdinal: 1,
      availableFromTick: 20,
      availableFromOrdinal: 1,
      learnedAt: "2026-10-01T00:00:03.000Z",
      metadata: {},
    }],
  });
  const snapshotB = makeSnapshot({ worldlineId: WORLDLINE_B, recordId: RECORD_B, events: [eventB] });
  const manifest = makeManifest([
    { worldlineId: WORLDLINE_A, recordId: RECORD_A, event: eventA },
    { worldlineId: WORLDLINE_B, recordId: RECORD_B, event: eventB },
  ]);
  const result = plan([snapshotA, snapshotB], manifest);
  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.records, [{
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    reasons: ["unmappable_event_reference"],
  }]);
});

test("merge fails closed when an action receipt references a none-deduplicated source event", () => {
  const eventA = makeEvent(RECORD_A, WORLDLINE_A, "one", { tick: 10, ordinal: 1 });
  const dedupedEvent = makeEvent(RECORD_A, WORLDLINE_A, "dup", { tick: 10, ordinal: 2 });
  const snapshotA = makeSnapshot({
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    events: [eventA, dedupedEvent],
    actionReceipts: [{
      recordId: RECORD_A,
      id: "receipt_a_1",
      actorCharacterInstanceId: `char_instance_${RECORD_A}`,
      sourceEventId: dedupedEvent.eventId,
      transactionId: "txn_a_1",
      callFingerprint: "fingerprint_a_1",
      receipt: { roll: { die: "d20", result: 17 } },
      worldTick: 10,
      worldOrdinal: 2,
      recordedAt: "2026-10-01T00:00:00.000Z",
    }],
  });
  const { snapshotB, manifest: baseManifest } = baseline();
  const manifest = [
    ...baseManifest.filter((entry) => entry.sourceRecordId !== RECORD_A),
    ...makeManifest([{ worldlineId: WORLDLINE_A, recordId: RECORD_A, event: eventA }]),
  ];
  const result = plan([snapshotA, snapshotB], manifest, new Set([dedupedEvent.eventId]));
  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.records, [{
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    reasons: ["unmappable_event_reference"],
  }]);
});

test("merge fails closed when a character effect references an unmappable action receipt", () => {
  const { eventA, eventB, snapshotB, manifest } = baseline();
  const snapshotA = makeSnapshot({
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    events: [eventA],
    characterEffects: [{
      recordId: RECORD_A,
      id: "effect_a_1",
      characterInstanceId: `char_instance_${RECORD_A}`,
      effectKey: "stance_focused",
      // 回执不在本 Record 的已物化集合内（跨 Record/腐化），fail-closed。
      sourceActionReceiptId: "receipt_elsewhere",
      status: "active",
      appliedTick: 10,
      appliedOrdinal: 1,
      endedTick: null,
      endedOrdinal: null,
      revision: 1,
      metadata: {},
    }],
  });
  void eventB;
  const result = plan([snapshotA, snapshotB], manifest);
  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.records, [{
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    reasons: ["unmappable_event_reference"],
  }]);
});

test("merge fails closed on unsupported event kinds instead of copying them", () => {
  const unsupportedEvent = makeEvent(RECORD_A, WORLDLINE_A, "goal", {
    tick: 10,
    ordinal: 1,
    eventKind: "goal.transition.committed",
  });
  const { snapshotB, manifest: baseManifest } = baseline();
  const snapshotA = makeSnapshot({
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    events: [unsupportedEvent],
  });
  const manifest = [
    ...baseManifest.filter((entry) => entry.sourceRecordId !== RECORD_A),
    ...makeManifest([{ worldlineId: WORLDLINE_A, recordId: RECORD_A, event: unsupportedEvent }]),
  ];
  const result = plan([snapshotA, snapshotB], manifest);
  assert.equal(result.status, "unsupported");
  assert.ok(!("topology" in result));
  assert.deepEqual(result.records, [{
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    reasons: ["unsupported_event_kind"],
  }]);
});

test("merge fails closed when an event payload references an unknown recipient participant", () => {
  const eventA = makeEvent(RECORD_A, WORLDLINE_A, "one", {
    tick: 10,
    ordinal: 1,
    payload: { narration: "whisper", recipientId: "participant_unknown" },
  });
  const snapshotA = makeSnapshot({ worldlineId: WORLDLINE_A, recordId: RECORD_A, events: [eventA] });
  const { snapshotB, manifest: baseManifest } = baseline();
  const manifest = [
    ...baseManifest.filter((entry) => entry.sourceRecordId !== RECORD_A),
    ...makeManifest([{ worldlineId: WORLDLINE_A, recordId: RECORD_A, event: eventA }]),
  ];
  const result = plan([snapshotA, snapshotB], manifest);
  assert.equal(result.status, "unsupported");
  assert.deepEqual(result.records, [{
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    reasons: ["unmappable_event_reference"],
  }]);
});

test("merge fails closed when a source record carries every unsupported runtime state at once", () => {
  const { snapshotA, snapshotB, manifest } = baseline();
  const tainted: MergeSourceSnapshot = {
    ...snapshotA,
    records: [{
      ...snapshotA.records[0]!,
      unsupported: [...PROBE_UNSUPPORTED_REASONS].reverse(),
    }],
  };
  const result = plan([tainted, snapshotB], manifest);
  assert.equal(result.status, "unsupported");
  assert.ok(!("topology" in result));
  // 全部九类稳定码一次性上报、字典序去重，绝不静默丢弃任何一类。
  assert.deepEqual(result.records, [{
    worldlineId: WORLDLINE_A,
    recordId: RECORD_A,
    reasons: [...PROBE_UNSUPPORTED_REASONS].sort(),
  }]);
});
