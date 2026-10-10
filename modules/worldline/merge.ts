/**
 * M5 batch 2: general worldline merge.
 *
 * Two source worldlines' committed events are merged into one timeline by
 * (world_tick, world_ordinal). Conflicts follow the existing
 * none/bridgeable/hard/high-risk vocabulary: identical payloads at one cursor
 * dedupe (none), one speaker contradicting itself at one cursor is hard
 * (merge refused), different speakers at one cursor are bridgeable (the B
 * side is rescheduled to the next free slot — ordering changes, content
 * never does). Merging only ever inserts new rows; source Records and
 * events stay immutable, and the merge itself is an auditable, idempotent
 * snapshot.
 */

import { createHash } from "node:crypto";
import type { WorldScope } from "../world-knowledge/public.ts";

export type MergeEventRef = {
  eventId: string;
  recordId: string;
  worldlineId: string;
  tick: number;
  ordinal: number;
  speaker: string;
  payloadKey: string;
};

export type MergeConflict = {
  tick: number;
  ordinal: number;
  severity: "none" | "bridgeable" | "hard";
  aEventId: string;
  bEventId: string;
  reason: string;
};

export type MergeManifestEntry = {
  ordinal: number;
  tick: number;
  /** 目标世界游标的 ordinal（同 tick 内）；bridgeable 顺移后与源 ordinal 不同。 */
  worldOrdinal: number;
  sourceWorldlineId: string;
  sourceRecordId: string;
  eventId: string;
  resolution: "kept" | "rescheduled";
  /** 物化后填入的目标事件 ID；preview/未物化报告不携带。 */
  targetEventId?: string;
};

export type MergeReport = {
  mergeable: boolean;
  conflicts: readonly MergeConflict[];
  manifest: readonly MergeManifestEntry[];
  /** preview/rejected 报告可携带不支持物化的源 Record 清单（稳定机器码）。 */
  unsupported?: readonly MergeUnsupportedRecord[];
};

/**
 * Pure merge planner. Deterministic: same inputs always produce the same
 * report and manifest.
 */
export function planWorldlineMerge(input: {
  sourceA: string;
  sourceB: string;
  eventsA: readonly MergeEventRef[];
  eventsB: readonly MergeEventRef[];
}): MergeReport {
  const tagged = [
    ...input.eventsA.map((event) => ({ ...event, side: 0 })),
    ...input.eventsB.map((event) => ({ ...event, side: 1 })),
  ].sort((left, right) =>
    left.tick - right.tick
    || left.ordinal - right.ordinal
    || left.side - right.side
    || left.eventId.localeCompare(right.eventId)
  );

  const conflicts: MergeConflict[] = [];
  const merged: { event: MergeEventRef; tick: number; ordinal: number; resolution: "kept" | "rescheduled" }[] = [];
  const occupied = new Set<string>();
  const seenPayloadAt = new Map<string, MergeEventRef>();

  function slotKey(tick: number, ordinal: number): string {
    return `${tick}:${ordinal}`;
  }

  for (const event of tagged) {
    const key = slotKey(event.tick, event.ordinal);
    const prior = seenPayloadAt.get(`${key}:${event.payloadKey}`);
    if (prior) {
      // none：同游标同载荷，去重保留先者。
      conflicts.push({
        tick: event.tick,
        ordinal: event.ordinal,
        severity: "none",
        aEventId: prior.eventId,
        bEventId: event.eventId,
        reason: "同游标同载荷，去重。",
      });
      continue;
    }
    if (occupied.has(key)) {
      const blocker = merged.find(
        (entry) => entry.tick === event.tick && entry.ordinal === event.ordinal,
      )!.event;
      if (blocker.speaker === event.speaker) {
        // hard：同一主体同一时刻两个矛盾动作。
        conflicts.push({
          tick: event.tick,
          ordinal: event.ordinal,
          severity: "hard",
          aEventId: blocker.eventId,
          bEventId: event.eventId,
          reason: `同一发言者 ${event.speaker} 在同一游标存在两个不同动作。`,
        });
        continue;
      }
      // bridgeable：顺移到下一个空闲游标。
      const tick = event.tick;
      let ordinal = event.ordinal + 1;
      while (occupied.has(slotKey(tick, ordinal))) {
        ordinal += 1;
      }
      conflicts.push({
        tick: event.tick,
        ordinal: event.ordinal,
        severity: "bridgeable",
        aEventId: blocker.eventId,
        bEventId: event.eventId,
        reason: `同游标不同发言者，事件 ${event.eventId} 顺移至 ${tick}:${ordinal}。`,
      });
      occupied.add(slotKey(tick, ordinal));
      seenPayloadAt.set(`${slotKey(tick, ordinal)}:${event.payloadKey}`, event);
      merged.push({ event, tick, ordinal, resolution: "rescheduled" });
      continue;
    }
    occupied.add(key);
    seenPayloadAt.set(`${key}:${event.payloadKey}`, event);
    merged.push({
      event,
      tick: event.tick,
      ordinal: event.ordinal,
      resolution: "kept",
    });
  }

  const mergeable = conflicts.every((conflict) => conflict.severity !== "hard");
  // ordinal 从 1 连续且唯一。
  const manifest: MergeManifestEntry[] = merged
    .sort((left, right) => left.tick - right.tick || left.ordinal - right.ordinal)
    .map((entry, index) => ({
      ordinal: index + 1,
      tick: entry.tick,
      worldOrdinal: entry.ordinal,
      sourceWorldlineId: entry.event.worldlineId,
      sourceRecordId: entry.event.recordId,
      eventId: entry.event.eventId,
      resolution: entry.resolution,
    }));
  return { mergeable, conflicts, manifest };
}

/**
 * 本 slice 明确不支持物化的持久运行态/不可安全重映射引用。
 * 这些值是稳定的机器码：进入审计 conflict_report 与 RECONCILE_UNSUPPORTED
 * 业务错误，绝不携带 SQL、路径或源数据原文。
 */
export type MergeUnsupportedReason =
  // 仓库探测到的 Record 级持久运行态（本 slice 不复制）。
  | "goal_instances"
  | "goal_assessments"
  | "goal_assessment_jobs"
  // 仓库探测到的投递/会话/初夜运行态（本 slice 不复制）。
  | "outbox"
  | "record_first_nights"
  | "record_self_play_sessions"
  // 仓库探测到的世界线级记忆运行态（本 slice 不复制；世界线级行
  // 归属到该世界线全部 Record 报告，任一存在即整体拒绝）。
  | "memory_conclusions"
  | "memory_snapshots"
  | "relationship_states"
  // 物化规划期的 fail-closed 检测。
  | "unsupported_event_kind"
  | "unmappable_actor"
  | "unmappable_scene"
  | "unmappable_visibility_policy"
  | "unmappable_character_instance"
  | "unmappable_event_reference"
  | "external_character_predecessor"
  | "conflicting_continuity";

export type MergeUnsupportedRecord = {
  worldlineId: string;
  recordId: string;
  reasons: readonly MergeUnsupportedReason[];
};

/** 物化支持的事件类型：其余（action.transaction/goal.transition/未来类型）一律拒绝。 */
const SUPPORTED_EVENT_KINDS = new Set([
  "utterance.committed",
  "narration.committed",
  "system.correction.committed",
]);

export type MergeSourceEvent = MergeEventRef & {
  eventKind: string;
  recordVersion: number;
  recordOrdinal: number;
  batchIndex: number;
  actorParticipantId: string | null;
  content: string;
  payload: unknown;
  sceneId: string;
  visibilityPolicyId: string;
  calendarId: string;
  displayTime: string;
};

export type MergeSourceScene = {
  id: string;
  recordId: string;
  title: string;
  status: string;
  location: string;
  objective: string;
  tension: string;
  weather: string;
  displayTime: string;
  startTick: number;
  startOrdinal: number;
  endTick: number | null;
  endOrdinal: number | null;
};

export type MergeSourceContinuity = {
  id: string;
  definitionId: string;
  continuityKey: string;
  status: string;
  bornTick: number;
  bornOrdinal: number;
  endedTick: number | null;
  endedOrdinal: number | null;
};

export type MergeSourceCharacterInstance = {
  id: string;
  recordId: string;
  continuityId: string;
  predecessorInstanceId: string | null;
  controllerMode: string;
  status: string;
  instantiatedTick: number;
  instantiatedOrdinal: number;
  inheritanceCutoffTick: number;
  inheritanceCutoffOrdinal: number;
  retiredTick: number | null;
  retiredOrdinal: number | null;
  state: unknown;
};

export type MergeSourceParticipant = {
  id: string;
  recordId: string;
  participantKind: "character" | "narrator";
  characterInstanceId: string | null;
  principalId: string | null;
  controllerMode: string;
  isActive: boolean;
  speakingOrder: number;
  sharedControlEnabled: boolean;
};

export type MergeSourceVisibilityPolicy = {
  id: string;
  recordId: string;
  policyKey: string;
  policyVersion: number;
  policyKind: "public" | "scene" | "restricted" | "private" | "dm_only";
  sceneId: string | null;
  restrictedDomainId: string | null;
  privateCharacterInstanceId: string | null;
  audienceCharacterInstanceIds: readonly string[];
};

export type MergeSourceCharacterSkill = {
  recordId: string;
  characterInstanceId: string;
  skillDefinitionId: string;
  acquiredTick: number;
  acquiredOrdinal: number;
  metadata: unknown;
};

export type MergeSourceCharacterAsset = {
  recordId: string;
  characterInstanceId: string;
  assetDefinitionId: string;
  quantity: number;
  revision: number;
  metadata: unknown;
};

/**
 * 源 Action Receipt（append-only 规则回执）。receipt 载荷是已物化的
 * 事实（骰点/消耗/效果结果），物化时逐字节复制绝不重掷；游标
 * （worldTick/worldOrdinal/recordedAt）是源侧历史坐标，同样原样保留——
 * 只有作用域引用（source event / actor character instance）重映射到
 * 目标 Record 的 ID。
 */
export type MergeSourceActionReceipt = {
  recordId: string;
  id: string;
  actorCharacterInstanceId: string;
  sourceEventId: string;
  transactionId: string;
  callFingerprint: string;
  receipt: unknown;
  worldTick: number;
  worldOrdinal: number;
  recordedAt: string;
};

/**
 * 源 Character Effect。effect definition 是 World 级规则数据（合并双侧
 * 同属一个 World），快照只携带 effectKey；目标写入前在目标 World 内按
 * effectKey 重解析 definition，缺失即整体回滚。游标与 revision 原样
 * 保留，只有作用域引用（character instance / source action receipt）
 * 重映射。
 */
export type MergeSourceCharacterEffect = {
  recordId: string;
  id: string;
  characterInstanceId: string;
  /** world 级 effect_definitions.effect_key（读取时 JOIN 解析）。 */
  effectKey: string;
  sourceActionReceiptId: string;
  status: string;
  appliedTick: number;
  appliedOrdinal: number;
  endedTick: number | null;
  endedOrdinal: number | null;
  revision: number;
  metadata: unknown;
};

/**
 * 源 Observation。内容/fidelity/游标/learnedAt 原样保留；只有作用域
 * 引用（observer character instance / source event）重映射。source
 * event 必须落在同一 Record 被复制的事件集合内——跨 Record 或被
 * none 去重的引用一律 fail-closed。
 */
export type MergeSourceObservation = {
  recordId: string;
  id: string;
  observerCharacterInstanceId: string;
  sourceEventId: string | null;
  dedupeKey: string;
  observationKind: string;
  content: string;
  fidelity: number;
  occurredTick: number;
  occurredOrdinal: number;
  availableFromTick: number;
  availableFromOrdinal: number;
  learnedAt: string;
  metadata: unknown;
};

export type MergeSourceRecord = {
  id: string;
  title: string;
  status: string;
  worldVersion: string;
  /** 仓库在读取时探测到的 Record 级不支持运行态（已去重）。 */
  unsupported: readonly MergeUnsupportedReason[];
};

/**
 * 一条源世界线的完整合并输入快照。事件行不可变，拓扑行只读复制；
 * 快照同时充当 planWorldlineMerge 的事件来源与物化规划的依据。
 */
export type MergeSourceSnapshot = {
  worldlineId: string;
  records: readonly MergeSourceRecord[];
  continuities: readonly MergeSourceContinuity[];
  scenes: readonly MergeSourceScene[];
  instances: readonly MergeSourceCharacterInstance[];
  participants: readonly MergeSourceParticipant[];
  visibilityPolicies: readonly MergeSourceVisibilityPolicy[];
  skills: readonly MergeSourceCharacterSkill[];
  assets: readonly MergeSourceCharacterAsset[];
  actionReceipts: readonly MergeSourceActionReceipt[];
  characterEffects: readonly MergeSourceCharacterEffect[];
  observations: readonly MergeSourceObservation[];
  events: readonly MergeSourceEvent[];
};

export type WorldlineMergeRow = {
  id: string;
  idempotencyKey: string;
  sourceWorldlineA: string;
  sourceWorldlineB: string;
  mergedWorldlineId: string | null;
  operator: string;
  status: "merged" | "rejected";
  conflictReport: unknown;
  manifest: readonly MergeManifestEntry[];
  createdAt: string;
};

export type MergeContinuityPlan = {
  id: string;
  definitionId: string;
  continuityKey: string;
  status: string;
  bornTick: number;
  bornOrdinal: number;
  endedTick: number | null;
  endedOrdinal: number | null;
};

export type MergeScenePlan = Omit<MergeSourceScene, "recordId">;

export type MergeInstancePlan = Omit<MergeSourceCharacterInstance, "recordId" | "continuityId" | "predecessorInstanceId"> & {
  continuityId: string;
  predecessorInstanceId: string | null;
};

export type MergeParticipantPlan = Omit<MergeSourceParticipant, "recordId">;

export type MergeVisibilityPolicyPlan = Omit<MergeSourceVisibilityPolicy, "recordId">;

export type MergeSkillPlan = Omit<MergeSourceCharacterSkill, "recordId">;

export type MergeAssetPlan = Omit<MergeSourceCharacterAsset, "recordId">;

/** 目标 Action Receipt：全部作用域引用已重映射为目标 ID；载荷逐字节复制。 */
export type MergeActionReceiptPlan = {
  id: string;
  /** 目标事件 ID（本 Record 内 manifest 命中的复制事件）。 */
  sourceEventId: string;
  /** 目标 character instance ID。 */
  actorCharacterInstanceId: string;
  transactionId: string;
  callFingerprint: string;
  receipt: unknown;
  worldTick: number;
  worldOrdinal: number;
  recordedAt: string;
};

/**
 * 目标 Character Effect：definition 不携带目标 ID——写事务在目标
 * World 内按 effectKey 重解析（缺失即整体回滚）。
 */
export type MergeCharacterEffectPlan = {
  id: string;
  characterInstanceId: string;
  effectKey: string;
  /** 目标 action receipt ID（本 Record 内已重映射的回执）。 */
  sourceActionReceiptId: string;
  status: string;
  appliedTick: number;
  appliedOrdinal: number;
  endedTick: number | null;
  endedOrdinal: number | null;
  revision: number;
  metadata: unknown;
};

/** 目标 Observation：observer/ source event 已重映射为目标 ID。 */
export type MergeObservationPlan = {
  id: string;
  observerCharacterInstanceId: string;
  sourceEventId: string | null;
  dedupeKey: string;
  observationKind: string;
  content: string;
  fidelity: number;
  occurredTick: number;
  occurredOrdinal: number;
  availableFromTick: number;
  availableFromOrdinal: number;
  learnedAt: string;
  metadata: unknown;
};

export type MergeEventPlan = {
  id: string;
  sourceEventId: string;
  sceneId: string;
  recordVersion: number;
  recordOrdinal: number;
  batchIndex: number;
  eventKind: string;
  actorParticipantId: string | null;
  speakerName: string;
  content: string;
  payload: unknown;
  visibilityPolicyId: string;
  worldTick: number;
  worldOrdinal: number;
  calendarId: string;
  displayTime: string;
};

export type MergeRecordHeadPlan = {
  recordVersion: number;
  nextRecordOrdinal: number;
  lastEventId: string | null;
  lastWorldTick: number | null;
  lastWorldOrdinal: number | null;
};

export type MergeRecordPlan = {
  id: string;
  title: string;
  sourceRecordId: string;
  worldVersion: string;
  scenes: readonly MergeScenePlan[];
  /** 依赖序：predecessor 先于后继（character_instances 自引用 FK）。 */
  instances: readonly MergeInstancePlan[];
  participants: readonly MergeParticipantPlan[];
  visibilityPolicies: readonly MergeVisibilityPolicyPlan[];
  skills: readonly MergeSkillPlan[];
  assets: readonly MergeAssetPlan[];
  actionReceipts: readonly MergeActionReceiptPlan[];
  characterEffects: readonly MergeCharacterEffectPlan[];
  observations: readonly MergeObservationPlan[];
  events: readonly MergeEventPlan[];
  head: MergeRecordHeadPlan;
};

/**
 * 物化写事务的源侧防漂指纹：写入前在同一事务内重数源 Record 事件，
 * 不一致即整体回滚（源事件 append-only，计数+最大 ordinal 是充分指纹）。
 */
export type MergeSourceFingerprint = {
  recordId: string;
  eventCount: number;
  maxRecordOrdinal: number;
};

export type MergeTopologyPlan = {
  worldlineId: string;
  label: string;
  storyId: string;
  storyTitle: string;
  headTick: number;
  headOrdinal: number;
  /** 目标世界线级 continuity（源双侧同 continuity_key 合并为一行）。 */
  continuities: readonly MergeContinuityPlan[];
  records: readonly MergeRecordPlan[];
  sourceFingerprints: readonly MergeSourceFingerprint[];
};

export type MergeMaterializationResult =
  | {
      status: "ok";
      topology: MergeTopologyPlan;
      /** 与目标事件游标/目标事件 ID 一致的物化 manifest。 */
      manifest: readonly MergeManifestEntry[];
    }
  | { status: "unsupported"; records: readonly MergeUnsupportedRecord[] };

function compareCursor(
  left: { tick: number; ordinal: number },
  right: { tick: number; ordinal: number },
): number {
  return left.tick - right.tick || left.ordinal - right.ordinal;
}

/**
 * 纯物化规划：把 manifest 命中的源事件复制进目标 scope，全部外键
 * （scene/visibility policy/actor participant/character instance/continuity）
 * 重映射到目标 ID；Record 级运行态（action receipts/character effects/
 * observations）随行物化，作用域引用同样重映射、载荷与游标原样保留。
 * 任何无法安全重映射的引用或本 slice 不支持的运行态都记为
 * unsupported——调用方必须在任何写入前拒绝，绝不静默丢失。
 */
export function planMergeMaterialization(input: {
  worldlineId: string;
  label: string;
  storyId: string;
  storyTitle: string;
  sources: readonly [MergeSourceSnapshot, MergeSourceSnapshot];
  manifest: readonly MergeManifestEntry[];
  /** 被 none 去重丢弃的源事件 ID（conflicts 中 severity='none' 的 bEventId）。 */
  dedupedEventIds: ReadonlySet<string>;
  idFactory: () => string;
}): MergeMaterializationResult {
  const unsupported = new Map<string, Set<MergeUnsupportedReason>>();
  const worldlineByRecord = new Map<string, string>();
  const markUnsupported = (
    recordId: string,
    reason: MergeUnsupportedReason,
  ) => {
    const existing = unsupported.get(recordId) ?? new Set<MergeUnsupportedReason>();
    existing.add(reason);
    unsupported.set(recordId, existing);
  };

  for (const snapshot of input.sources) {
    for (const record of snapshot.records) {
      worldlineByRecord.set(record.id, snapshot.worldlineId);
      for (const reason of record.unsupported) {
        markUnsupported(record.id, reason);
      }
    }
  }

  // continuity 合并：continuity_key 在世界线内唯一；合并世界线把双侧
  // 同 key 的 continuity 折成一行（同一角色跨世界线的同一连续体）。
  // 同 key 不同 definition 无法安全合并 → 引用它的所有 Record 拒绝。
  const recordIdsByContinuityId = new Map<string, string[]>();
  for (const snapshot of input.sources) {
    for (const instance of snapshot.instances) {
      const list = recordIdsByContinuityId.get(instance.continuityId) ?? [];
      if (!list.includes(instance.recordId)) list.push(instance.recordId);
      recordIdsByContinuityId.set(instance.continuityId, list);
    }
  }
  const continuityStatusRank = (status: string) =>
    status === "active" ? 2 : status === "inactive" ? 1 : 0;
  const continuityMergeByKey = new Map<string, {
    definitionId: string;
    status: string;
    bornTick: number;
    bornOrdinal: number;
    endedTick: number | null;
    endedOrdinal: number | null;
    sourceIds: string[];
  }>();
  const conflictedContinuityIds = new Set<string>();
  for (const snapshot of input.sources) {
    for (const continuity of snapshot.continuities) {
      const existing = continuityMergeByKey.get(continuity.continuityKey);
      if (!existing) {
        continuityMergeByKey.set(continuity.continuityKey, {
          definitionId: continuity.definitionId,
          status: continuity.status,
          bornTick: continuity.bornTick,
          bornOrdinal: continuity.bornOrdinal,
          endedTick: continuity.endedTick,
          endedOrdinal: continuity.endedOrdinal,
          sourceIds: [continuity.id],
        });
        continue;
      }
      if (existing.definitionId !== continuity.definitionId) {
        for (const sourceId of [...existing.sourceIds, continuity.id]) {
          conflictedContinuityIds.add(sourceId);
          for (const recordId of recordIdsByContinuityId.get(sourceId) ?? []) {
            markUnsupported(recordId, "conflicting_continuity");
          }
        }
        continue;
      }
      const born = compareCursor(
        { tick: existing.bornTick, ordinal: existing.bornOrdinal },
        { tick: continuity.bornTick, ordinal: continuity.bornOrdinal },
      ) <= 0
        ? { tick: existing.bornTick, ordinal: existing.bornOrdinal }
        : { tick: continuity.bornTick, ordinal: continuity.bornOrdinal };
      existing.bornTick = born.tick;
      existing.bornOrdinal = born.ordinal;
      if (existing.endedTick === null || continuity.endedTick === null) {
        existing.endedTick = null;
        existing.endedOrdinal = null;
      } else if (
        compareCursor(
          { tick: existing.endedTick, ordinal: existing.endedOrdinal ?? 0 },
          { tick: continuity.endedTick, ordinal: continuity.endedOrdinal ?? 0 },
        ) < 0
      ) {
        existing.endedTick = continuity.endedTick;
        existing.endedOrdinal = continuity.endedOrdinal;
      }
      if (continuityStatusRank(continuity.status) > continuityStatusRank(existing.status)) {
        existing.status = continuity.status;
      }
      existing.sourceIds.push(continuity.id);
    }
  }
  // 只为被实例引用的 continuity 分配目标行；冲突 continuity 不分配。
  const continuityPlans: MergeContinuityPlan[] = [];
  const continuityTargetIdBySourceId = new Map<string, string>();
  for (const [continuityKey, merged] of continuityMergeByKey) {
    if (merged.sourceIds.some((sourceId) => conflictedContinuityIds.has(sourceId))) {
      continue;
    }
    const referenced = merged.sourceIds.some(
      (sourceId) => (recordIdsByContinuityId.get(sourceId) ?? []).length > 0,
    );
    if (!referenced) continue;
    const targetContinuityId = `continuity_merge_${input.idFactory()}`;
    continuityPlans.push({
      id: targetContinuityId,
      definitionId: merged.definitionId,
      continuityKey,
      status: merged.status,
      bornTick: merged.bornTick,
      bornOrdinal: merged.bornOrdinal,
      endedTick: merged.endedTick,
      endedOrdinal: merged.endedOrdinal,
    });
    for (const sourceId of merged.sourceIds) {
      continuityTargetIdBySourceId.set(sourceId, targetContinuityId);
    }
  }

  // manifest 索引：eventId 只在世界线内唯一，按 record 定位。
  const manifestByRecord = new Map<string, MergeManifestEntry[]>();
  for (const entry of input.manifest) {
    if (!worldlineByRecord.has(entry.sourceRecordId)) {
      // manifest 与快照来自同一次读取；不一致即内部不变量破坏。
      throw new Error("Merge manifest references a record outside the source snapshot.");
    }
    const list = manifestByRecord.get(entry.sourceRecordId) ?? [];
    list.push(entry);
    manifestByRecord.set(entry.sourceRecordId, list);
  }
  const manifestEventIds = new Set(
    input.manifest.map((entry) => `${entry.sourceRecordId}${entry.eventId}`),
  );

  const enrichedManifest: MergeManifestEntry[] = [];
  const recordPlans: MergeRecordPlan[] = [];

  for (const snapshot of input.sources) {
    for (const record of snapshot.records) {
      const targetRecordId = `record_merge_${input.idFactory()}`;
      const scenes = snapshot.scenes.filter((scene) => scene.recordId === record.id);
      const instances = snapshot.instances.filter(
        (instance) => instance.recordId === record.id,
      );
      const participants = snapshot.participants.filter(
        (participant) => participant.recordId === record.id,
      );
      const policies = snapshot.visibilityPolicies.filter(
        (policy) => policy.recordId === record.id,
      );
      const skills = snapshot.skills.filter((skill) => skill.recordId === record.id);
      const assets = snapshot.assets.filter((asset) => asset.recordId === record.id);
      const receipts = snapshot.actionReceipts.filter(
        (receipt) => receipt.recordId === record.id,
      );
      const effects = snapshot.characterEffects.filter(
        (effect) => effect.recordId === record.id,
      );
      const observations = snapshot.observations.filter(
        (observation) => observation.recordId === record.id,
      );
      const recordEvents = snapshot.events.filter(
        (event) => event.recordId === record.id,
      );

      const sceneIds = new Map<string, string>();
      const scenePlans: MergeScenePlan[] = scenes.map((scene) => {
        const targetSceneId = `scene_merge_${input.idFactory()}`;
        sceneIds.set(scene.id, targetSceneId);
        return {
          id: targetSceneId,
          title: scene.title,
          status: scene.status,
          location: scene.location,
          objective: scene.objective,
          tension: scene.tension,
          weather: scene.weather,
          displayTime: scene.displayTime,
          startTick: scene.startTick,
          startOrdinal: scene.startOrdinal,
          endTick: scene.endTick,
          endOrdinal: scene.endOrdinal,
        };
      });

      const instanceIds = new Map<string, string>();
      for (const instance of instances) {
        instanceIds.set(instance.id, `char_instance_merge_${input.idFactory()}`);
      }
      const instancePlans: MergeInstancePlan[] = instances.map((instance) => {
        let continuityId = "";
        if (conflictedContinuityIds.has(instance.continuityId)) {
          // 已在 continuity 合并阶段记 unsupported。
          continuityId = "";
        } else {
          const mapped = continuityTargetIdBySourceId.get(instance.continuityId);
          if (!mapped) {
            // 源 FK 保证 continuity 存在；缺失即数据腐化，fail-closed。
            markUnsupported(record.id, "unmappable_character_instance");
          } else {
            continuityId = mapped;
          }
        }
        let predecessorInstanceId: string | null = null;
        if (instance.predecessorInstanceId !== null) {
          const mapped = instanceIds.get(instance.predecessorInstanceId);
          if (!mapped) {
            markUnsupported(record.id, "external_character_predecessor");
          } else {
            predecessorInstanceId = mapped;
          }
        }
        return {
          id: instanceIds.get(instance.id)!,
          continuityId,
          predecessorInstanceId,
          controllerMode: instance.controllerMode,
          status: instance.status,
          instantiatedTick: instance.instantiatedTick,
          instantiatedOrdinal: instance.instantiatedOrdinal,
          inheritanceCutoffTick: instance.inheritanceCutoffTick,
          inheritanceCutoffOrdinal: instance.inheritanceCutoffOrdinal,
          retiredTick: instance.retiredTick,
          retiredOrdinal: instance.retiredOrdinal,
          state: instance.state,
        };
      });
      // 依赖序：predecessor 先行（character_instances 自引用 FK）。
      const orderedInstancePlans: MergeInstancePlan[] = [];
      const placed = new Set<string>();
      let pending = [...instancePlans];
      while (pending.length > 0) {
        const ready = pending.filter(
          (instance) => instance.predecessorInstanceId === null
            || placed.has(instance.predecessorInstanceId),
        );
        if (ready.length === 0) {
          // predecessor 环只在源数据腐化时出现；fail-closed。
          pending.forEach(() => markUnsupported(record.id, "external_character_predecessor"));
          orderedInstancePlans.push(...pending.map((instance) => ({
            ...instance,
            predecessorInstanceId: null,
          })));
          break;
        }
        for (const instance of ready) {
          placed.add(instance.id);
          orderedInstancePlans.push(instance);
        }
        pending = pending.filter((instance) => !placed.has(instance.id));
      }

      const participantIds = new Map<string, string>();
      const participantPlans: MergeParticipantPlan[] = participants.map((participant) => {
        const targetParticipantId = `participant_merge_${input.idFactory()}`;
        participantIds.set(participant.id, targetParticipantId);
        let characterInstanceId: string | null = null;
        if (participant.characterInstanceId !== null) {
          const mapped = instanceIds.get(participant.characterInstanceId);
          if (!mapped) {
            markUnsupported(record.id, "unmappable_character_instance");
          } else {
            characterInstanceId = mapped;
          }
        }
        return {
          id: targetParticipantId,
          participantKind: participant.participantKind,
          characterInstanceId,
          principalId: participant.principalId,
          controllerMode: participant.controllerMode,
          isActive: participant.isActive,
          speakingOrder: participant.speakingOrder,
          sharedControlEnabled: participant.sharedControlEnabled,
        };
      });

      const policyIds = new Map<string, string>();
      const policyPlans: MergeVisibilityPolicyPlan[] = policies.map((policy) => {
        const targetPolicyId = `policy_merge_${input.idFactory()}`;
        policyIds.set(policy.id, targetPolicyId);
        let sceneId: string | null = null;
        if (policy.sceneId !== null) {
          const mapped = sceneIds.get(policy.sceneId);
          if (!mapped) {
            markUnsupported(record.id, "unmappable_scene");
          } else {
            sceneId = mapped;
          }
        }
        let privateCharacterInstanceId: string | null = null;
        if (policy.privateCharacterInstanceId !== null) {
          const mapped = instanceIds.get(policy.privateCharacterInstanceId);
          if (!mapped) {
            markUnsupported(record.id, "unmappable_character_instance");
          } else {
            privateCharacterInstanceId = mapped;
          }
        }
        const audienceCharacterInstanceIds = policy.audienceCharacterInstanceIds.map(
          (sourceId) => {
            const mapped = instanceIds.get(sourceId);
            if (!mapped) {
              markUnsupported(record.id, "unmappable_character_instance");
              return sourceId;
            }
            return mapped;
          },
        );
        return {
          id: targetPolicyId,
          policyKey: policy.policyKey,
          policyVersion: policy.policyVersion,
          policyKind: policy.policyKind,
          sceneId,
          restrictedDomainId: policy.restrictedDomainId,
          privateCharacterInstanceId,
          audienceCharacterInstanceIds,
        };
      });

      const skillPlans: MergeSkillPlan[] = skills.map((skill) => {
        const mapped = instanceIds.get(skill.characterInstanceId);
        if (!mapped) markUnsupported(record.id, "unmappable_character_instance");
        return {
          characterInstanceId: mapped ?? skill.characterInstanceId,
          skillDefinitionId: skill.skillDefinitionId,
          acquiredTick: skill.acquiredTick,
          acquiredOrdinal: skill.acquiredOrdinal,
          metadata: skill.metadata,
        };
      });
      const assetPlans: MergeAssetPlan[] = assets.map((asset) => {
        const mapped = instanceIds.get(asset.characterInstanceId);
        if (!mapped) markUnsupported(record.id, "unmappable_character_instance");
        return {
          characterInstanceId: mapped ?? asset.characterInstanceId,
          assetDefinitionId: asset.assetDefinitionId,
          quantity: asset.quantity,
          revision: asset.revision,
          metadata: asset.metadata,
        };
      });

      // 事件物化：只复制 manifest 命中的事件（none 去重的源事件不复制）。
      const sourceEventById = new Map(recordEvents.map((event) => [event.eventId, event]));
      const recordManifest = manifestByRecord.get(record.id) ?? [];
      const eventPlans: MergeEventPlan[] = [];
      // 本 Record 已复制事件的 源事件 ID → 目标事件 ID：运行态
      // （receipt/observation）的 source event 引用据此重映射。
      const targetEventIdBySourceId = new Map<string, string>();
      let recordOrdinal = 0;
      for (const entry of recordManifest) {
        const sourceEvent = sourceEventById.get(entry.eventId);
        if (!sourceEvent) {
          // manifest 与快照来自同一次读取；不一致即内部不变量破坏。
          throw new Error("Merge manifest references an event outside the source snapshot.");
        }
        if (!SUPPORTED_EVENT_KINDS.has(sourceEvent.eventKind)) {
          markUnsupported(record.id, "unsupported_event_kind");
          continue;
        }
        const sceneId = sceneIds.get(sourceEvent.sceneId);
        if (!sceneId) {
          markUnsupported(record.id, "unmappable_scene");
          continue;
        }
        const visibilityPolicyId = policyIds.get(sourceEvent.visibilityPolicyId);
        if (!visibilityPolicyId) {
          markUnsupported(record.id, "unmappable_visibility_policy");
          continue;
        }
        let actorParticipantId: string | null = null;
        if (sourceEvent.actorParticipantId !== null) {
          const mapped = participantIds.get(sourceEvent.actorParticipantId);
          if (!mapped) {
            markUnsupported(record.id, "unmappable_actor");
            continue;
          }
          actorParticipantId = mapped;
        }
        const payload = remapEventPayload(
          sourceEvent.payload,
          participantIds,
          () => markUnsupported(record.id, "unmappable_event_reference"),
        );
        recordOrdinal += 1;
        const targetEventId = `event_merge_${input.idFactory()}`;
        targetEventIdBySourceId.set(sourceEvent.eventId, targetEventId);
        eventPlans.push({
          id: targetEventId,
          sourceEventId: sourceEvent.eventId,
          sceneId,
          recordVersion: sourceEvent.recordVersion,
          recordOrdinal,
          batchIndex: sourceEvent.batchIndex,
          eventKind: sourceEvent.eventKind,
          actorParticipantId,
          speakerName: sourceEvent.speaker,
          content: sourceEvent.content,
          payload,
          visibilityPolicyId,
          worldTick: entry.tick,
          worldOrdinal: entry.worldOrdinal,
          calendarId: sourceEvent.calendarId,
          displayTime: sourceEvent.displayTime,
        });
        enrichedManifest.push({ ...entry, targetEventId });
      }

      // 运行态物化：receipt/effect/observation 的全部作用域引用重映射到
      // 本 Record 的目标 ID；载荷与游标原样保留。引用落在本 Record 被
      // 复制的事件/实例/回执集合之外（跨 Record、被 none 去重、源数据
      // 腐化）一律 fail-closed——宁可整体拒绝，绝不静默丢失运行态。
      const receiptIds = new Map<string, string>();
      const receiptPlans: MergeActionReceiptPlan[] = [];
      for (const receipt of receipts) {
        const actorCharacterInstanceId = instanceIds.get(
          receipt.actorCharacterInstanceId,
        );
        if (!actorCharacterInstanceId) {
          markUnsupported(record.id, "unmappable_character_instance");
          continue;
        }
        const sourceEventId = targetEventIdBySourceId.get(receipt.sourceEventId);
        if (!sourceEventId) {
          markUnsupported(record.id, "unmappable_event_reference");
          continue;
        }
        const targetReceiptId = `action_receipt_merge_${input.idFactory()}`;
        receiptIds.set(receipt.id, targetReceiptId);
        receiptPlans.push({
          id: targetReceiptId,
          sourceEventId,
          actorCharacterInstanceId,
          transactionId: receipt.transactionId,
          callFingerprint: receipt.callFingerprint,
          receipt: receipt.receipt,
          worldTick: receipt.worldTick,
          worldOrdinal: receipt.worldOrdinal,
          recordedAt: receipt.recordedAt,
        });
      }
      const effectPlans: MergeCharacterEffectPlan[] = [];
      for (const effect of effects) {
        const characterInstanceId = instanceIds.get(effect.characterInstanceId);
        if (!characterInstanceId) {
          markUnsupported(record.id, "unmappable_character_instance");
          continue;
        }
        const sourceActionReceiptId = receiptIds.get(effect.sourceActionReceiptId);
        if (!sourceActionReceiptId) {
          markUnsupported(record.id, "unmappable_event_reference");
          continue;
        }
        effectPlans.push({
          id: `character_effect_merge_${input.idFactory()}`,
          characterInstanceId,
          effectKey: effect.effectKey,
          sourceActionReceiptId,
          status: effect.status,
          appliedTick: effect.appliedTick,
          appliedOrdinal: effect.appliedOrdinal,
          endedTick: effect.endedTick,
          endedOrdinal: effect.endedOrdinal,
          revision: effect.revision,
          metadata: effect.metadata,
        });
      }
      const observationPlans: MergeObservationPlan[] = [];
      for (const observation of observations) {
        const observerCharacterInstanceId = instanceIds.get(
          observation.observerCharacterInstanceId,
        );
        if (!observerCharacterInstanceId) {
          markUnsupported(record.id, "unmappable_character_instance");
          continue;
        }
        let sourceEventId: string | null = null;
        if (observation.sourceEventId !== null) {
          const mapped = targetEventIdBySourceId.get(observation.sourceEventId);
          if (!mapped) {
            markUnsupported(record.id, "unmappable_event_reference");
            continue;
          }
          sourceEventId = mapped;
        }
        observationPlans.push({
          id: `observation_merge_${input.idFactory()}`,
          observerCharacterInstanceId,
          sourceEventId,
          dedupeKey: observation.dedupeKey,
          observationKind: observation.observationKind,
          content: observation.content,
          fidelity: observation.fidelity,
          occurredTick: observation.occurredTick,
          occurredOrdinal: observation.occurredOrdinal,
          availableFromTick: observation.availableFromTick,
          availableFromOrdinal: observation.availableFromOrdinal,
          learnedAt: observation.learnedAt,
          metadata: observation.metadata,
        });
      }

      const lastEvent = eventPlans.at(-1);
      recordPlans.push({
        id: targetRecordId,
        title: record.title,
        sourceRecordId: record.id,
        worldVersion: record.worldVersion,
        scenes: scenePlans,
        instances: orderedInstancePlans,
        participants: participantPlans,
        visibilityPolicies: policyPlans,
        skills: skillPlans,
        assets: assetPlans,
        actionReceipts: receiptPlans,
        characterEffects: effectPlans,
        observations: observationPlans,
        events: eventPlans,
        head: lastEvent
          ? {
              recordVersion: lastEvent.recordVersion,
              nextRecordOrdinal: lastEvent.recordOrdinal + 1,
              lastEventId: lastEvent.id,
              lastWorldTick: lastEvent.worldTick,
              lastWorldOrdinal: lastEvent.worldOrdinal,
            }
          : {
              recordVersion: 0,
              nextRecordOrdinal: 0,
              lastEventId: null,
              lastWorldTick: null,
              lastWorldOrdinal: null,
            },
      });

      // 覆盖不变量：快照中的每个源事件必须被 manifest 命中或被 none 去重。
      for (const event of recordEvents) {
        if (
          !manifestEventIds.has(`${record.id}${event.eventId}`)
          && !input.dedupedEventIds.has(event.eventId)
        ) {
          throw new Error("Merge manifest does not cover a source snapshot event.");
        }
      }
    }
  }

  if (unsupported.size > 0) {
    const records = [...unsupported.entries()]
      .map(([recordId, reasons]) => ({
        worldlineId: worldlineByRecord.get(recordId) ?? "",
        recordId,
        reasons: [...reasons].sort(),
      }))
      .sort(
        (left, right) =>
          left.worldlineId.localeCompare(right.worldlineId)
          || left.recordId.localeCompare(right.recordId),
      );
    return { status: "unsupported", records };
  }

  const lastEntry = input.manifest.at(-1);
  const sourceFingerprints: MergeSourceFingerprint[] = input.sources.flatMap(
    (snapshot) =>
      snapshot.records.map((record) => {
        const events = snapshot.events.filter((event) => event.recordId === record.id);
        return {
          recordId: record.id,
          eventCount: events.length,
          maxRecordOrdinal: events.reduce(
            (maximum, event) => Math.max(maximum, event.recordOrdinal),
            0,
          ),
        };
      }),
  );
  return {
    status: "ok",
    topology: {
      worldlineId: input.worldlineId,
      label: input.label,
      storyId: input.storyId,
      storyTitle: input.storyTitle,
      headTick: lastEntry?.tick ?? 0,
      headOrdinal: lastEntry?.worldOrdinal ?? 0,
      continuities: continuityPlans,
      records: recordPlans,
      sourceFingerprints,
    },
    manifest: enrichedManifest,
  };
}

/**
 * 事件 payload 重映射：唯一承载作用域引用的键是顶层 recipientId
 * （参与者 ID，见 record-scope/delivery-projection 读侧）。其余内容
 * （presentation 段、文本）逐字节复制；未知 recipientId 一律 fail-closed。
 */
function remapEventPayload(
  payload: unknown,
  participantIds: ReadonlyMap<string, string>,
  onUnmappable: () => void,
): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return payload;
  }
  const object = payload as Record<string, unknown>;
  const recipientId = object.recipientId;
  if (typeof recipientId !== "string" || recipientId === "") {
    return payload;
  }
  const mapped = participantIds.get(recipientId);
  if (!mapped) {
    onUnmappable();
    return payload;
  }
  return { ...object, recipientId: mapped };
}

export type MergeAuditRow = Omit<WorldlineMergeRow, "createdAt">;

export interface WorldlineMergeRepository {
  findMergeByIdempotencyKey(
    workspaceId: string,
    key: string,
  ): Promise<WorldlineMergeRow | null>;
  insertMerge(
    scope: Omit<WorldScope, "worldlineId">,
    row: MergeAuditRow,
  ): Promise<void>;
  /** 读取一条源世界线的完整合并快照（拓扑 + 事件 + 不支持运行态探测）。 */
  loadMergeSource(
    scope: WorldScope,
  ): Promise<MergeSourceSnapshot>;
  /**
   * 物化 + 审计在同一 workspace 事务内原子提交；写入前重数源 Record
   * 事件指纹，漂移即整体回滚（RECONCILE_SOURCE_CHANGED）。
   */
  createMergedTopologyAndAudit(
    scope: Omit<WorldScope, "worldlineId">,
    topology: MergeTopologyPlan,
    row: MergeAuditRow,
  ): Promise<void>;
  worldlineExists(scope: WorldScope): Promise<boolean>;
}

export type MergeResult =
  | { status: "preview"; report: MergeReport }
  | { status: "rejected"; mergeId: string; report: MergeReport }
  | { status: "merged"; mergeId: string; mergedWorldlineId: string; report: MergeReport };

export class WorldlineMergeError extends Error {
  readonly code = "WORLDLINE_NOT_FOUND";

  constructor(message: string) {
    super(message);
    this.name = "WorldlineMergeError";
  }
}

/**
 * 源 Record 携带本 slice 不支持物化的运行态/引用。审计行已落库
 * （status='rejected'，conflict_report.unsupported 记录稳定机器码），
 * 路由沿现有错误映射返回 409 + RECONCILE_UNSUPPORTED，不泄露细节。
 */
export class WorldlineMergeUnsupportedError extends Error {
  readonly code = "RECONCILE_UNSUPPORTED";
  readonly records: readonly MergeUnsupportedRecord[];

  constructor(records: readonly MergeUnsupportedRecord[]) {
    super("合并源含有本切片不支持安全重映射的运行态。");
    this.name = "WorldlineMergeUnsupportedError";
    this.records = records;
  }
}

/** 物化写事务内发现源 Record 事件漂移（快照后被并发提交）→ 整体回滚。 */
export class WorldlineMergeSourceChangedError extends Error {
  readonly code = "RECONCILE_SOURCE_CHANGED";

  constructor() {
    super("合并源在物化期间发生了变化。");
    this.name = "WorldlineMergeSourceChangedError";
  }
}

export function createWorldlineMergeService(options: {
  repository: WorldlineMergeRepository;
  idFactory?: () => string;
}): {
  merge(input: {
    workspaceId: string;
    worldId: string;
    sourceA: string;
    sourceB: string;
    idempotencyKey: string;
    operator: string;
    dryRun?: boolean;
  }): Promise<MergeResult>;
} {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());
  const repository = options.repository;

  return {
    async merge(input) {
      // 幂等重放：同一幂等键直接返回既有合并结果。
      const existing = await repository.findMergeByIdempotencyKey(
        input.workspaceId,
        input.idempotencyKey,
      );
      if (existing) {
        return mergeResultFromExisting(existing);
      }

      const scopeA = {
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        worldlineId: input.sourceA,
      };
      const scopeB = { ...scopeA, worldlineId: input.sourceB };
      if (
        !(await repository.worldlineExists(scopeA))
        || !(await repository.worldlineExists(scopeB))
      ) {
        throw new WorldlineMergeError(
          `Worldline ${input.sourceA} 或 ${input.sourceB} 不存在。`,
        );
      }
      // 单次快照同时喂给冲突规划器与物化规划器：manifest 覆盖与
      // 目标拓扑引用同一批只读源行，不存在两次读取间的漂移窗口。
      const [snapshotA, snapshotB] = await Promise.all([
        repository.loadMergeSource(scopeA),
        repository.loadMergeSource(scopeB),
      ]);
      const report = planWorldlineMerge({
        sourceA: input.sourceA,
        sourceB: input.sourceB,
        eventsA: snapshotA.events.map(toMergeEventRef),
        eventsB: snapshotB.events.map(toMergeEventRef),
      });

      if (input.dryRun) {
        // 预览物化可行性（不写库、不消耗真实 ID）：unsupported 清单
        // 随 report 返回，调用方可在提交前发现 RECONCILE_UNSUPPORTED。
        // hard 冲突的报告本来就不覆盖全部事件，不做物化探测。
        if (!report.mergeable) {
          return { status: "preview", report };
        }
        const probe = planMergeMaterialization({
          worldlineId: "worldline_merge_preview",
          label: "",
          storyId: "story_merge_preview",
          storyTitle: "",
          sources: [snapshotA, snapshotB],
          manifest: report.manifest,
          dedupedEventIds: dedupedNoneEventIds(report),
          idFactory,
        });
        return {
          status: "preview",
          report: probe.status === "unsupported"
            ? { ...report, unsupported: probe.records }
            : report,
        };
      }

      const mergeId = `merge_${idFactory()}`;
      if (!report.mergeable) {
        // hard 冲突：拒绝合并但保留不可变审计行与冲突清单。
        const auditRow: MergeAuditRow = {
          id: mergeId,
          idempotencyKey: input.idempotencyKey,
          sourceWorldlineA: input.sourceA,
          sourceWorldlineB: input.sourceB,
          mergedWorldlineId: null,
          operator: input.operator,
          status: "rejected",
          conflictReport: report,
          manifest: [],
        };
        try {
          await repository.insertMerge(input, auditRow);
        } catch (error) {
          if (isUniqueViolation(error)) {
            const concurrent = await repository.findMergeByIdempotencyKey(
              input.workspaceId,
              input.idempotencyKey,
            );
            if (concurrent) return mergeResultFromExisting(concurrent);
          }
          throw error;
        }
        return { status: "rejected", mergeId, report };
      }

      const mergedWorldlineId = `worldline_merge_${idFactory()}`;
      // 物化规划（纯函数）：全部目标 ID/游标/重映射在此决定；
      // unsupported → 在任何拓扑写入前落 rejected 审计并拒绝。
      const materialization = planMergeMaterialization({
        worldlineId: mergedWorldlineId,
        label: `合并：${input.sourceA} + ${input.sourceB}`,
        storyId: `story_merge_${idFactory()}`,
        storyTitle: "合并时间线",
        sources: [snapshotA, snapshotB],
        manifest: report.manifest,
        dedupedEventIds: dedupedNoneEventIds(report),
        idFactory,
      });
      if (materialization.status === "unsupported") {
        const conflictReport: MergeReport = {
          ...report,
          unsupported: materialization.records,
        };
        const rejectedRow: MergeAuditRow = {
          id: mergeId,
          idempotencyKey: input.idempotencyKey,
          sourceWorldlineA: input.sourceA,
          sourceWorldlineB: input.sourceB,
          mergedWorldlineId: null,
          operator: input.operator,
          status: "rejected",
          conflictReport,
          manifest: [],
        };
        try {
          await repository.insertMerge(input, rejectedRow);
        } catch (error) {
          if (isUniqueViolation(error)) {
            const concurrent = await repository.findMergeByIdempotencyKey(
              input.workspaceId,
              input.idempotencyKey,
            );
            if (concurrent) return mergeResultFromExisting(concurrent);
          }
          throw error;
        }
        throw new WorldlineMergeUnsupportedError(materialization.records);
      }
      const mergedReport: MergeReport = { ...report, manifest: materialization.manifest };
      const auditRow: MergeAuditRow = {
        id: mergeId,
        idempotencyKey: input.idempotencyKey,
        sourceWorldlineA: input.sourceA,
        sourceWorldlineB: input.sourceB,
        mergedWorldlineId,
        operator: input.operator,
        status: "merged",
        conflictReport: mergedReport,
        manifest: materialization.manifest,
      };
      try {
        await repository.createMergedTopologyAndAudit(
          input,
          materialization.topology,
          auditRow,
        );
      } catch (error) {
        if (isUniqueViolation(error)) {
          const concurrent = await repository.findMergeByIdempotencyKey(
            input.workspaceId,
            input.idempotencyKey,
          );
          if (concurrent) return mergeResultFromExisting(concurrent);
        }
        throw error;
      }
      return { status: "merged", mergeId, mergedWorldlineId, report: mergedReport };
    },
  };
}


function toMergeEventRef(event: MergeSourceEvent): MergeEventRef {
  return {
    eventId: event.eventId,
    recordId: event.recordId,
    worldlineId: event.worldlineId,
    tick: event.tick,
    ordinal: event.ordinal,
    speaker: event.speaker,
    payloadKey: event.payloadKey,
  };
}

function dedupedNoneEventIds(report: MergeReport): ReadonlySet<string> {
  return new Set(
    report.conflicts
      .filter((conflict) => conflict.severity === "none")
      .map((conflict) => conflict.bEventId),
  );
}

function mergeResultFromExisting(existing: WorldlineMergeRow): MergeResult {
  // 幂等重放必须返回首次结果：unsupported 拒绝重放同一业务错误。
  if (existing.status === "rejected") {
    const unsupported = (
      existing.conflictReport as MergeReport | undefined
    )?.unsupported;
    if (Array.isArray(unsupported) && unsupported.length > 0) {
      throw new WorldlineMergeUnsupportedError(unsupported);
    }
  }
  return existing.status === "merged"
    ? {
        status: "merged",
        mergeId: existing.id,
        mergedWorldlineId: existing.mergedWorldlineId!,
        report: existing.conflictReport as MergeReport,
      }
    : {
        status: "rejected",
        mergeId: existing.id,
        report: existing.conflictReport as MergeReport,
      };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

export function mergePayloadKey(payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
}
