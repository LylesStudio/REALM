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
  sourceWorldlineId: string;
  sourceRecordId: string;
  eventId: string;
  resolution: "kept" | "rescheduled";
};

export type MergeReport = {
  mergeable: boolean;
  conflicts: readonly MergeConflict[];
  manifest: readonly MergeManifestEntry[];
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
      sourceWorldlineId: entry.event.worldlineId,
      sourceRecordId: entry.event.recordId,
      eventId: entry.event.eventId,
      resolution: entry.resolution,
    }));
  return { mergeable, conflicts, manifest };
}

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

export type MergedTopologyInput = {
  worldlineId: string;
  label: string;
  storyId: string;
  storyTitle: string;
  records: readonly { id: string; title: string; sourceRecordId: string }[];
  headTick: number;
  headOrdinal: number;
};

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
  listWorldlineEvents(
    scope: WorldScope,
  ): Promise<readonly MergeEventRef[]>;
  listWorldlineRecordTitles(
    scope: WorldScope,
  ): Promise<readonly { id: string; title: string }[]>;
  createMergedTopology(
    scope: Omit<WorldScope, "worldlineId">,
    input: MergedTopologyInput,
  ): Promise<void>;
  /** PG 实现将 topology 与 audit row 放在同一事务；内存实现可省略。 */
  createMergedTopologyAndAudit?(
    scope: Omit<WorldScope, "worldlineId">,
    topology: MergedTopologyInput,
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
      const [eventsA, eventsB] = await Promise.all([
        repository.listWorldlineEvents(scopeA),
        repository.listWorldlineEvents(scopeB),
      ]);
      const report = planWorldlineMerge({
        sourceA: input.sourceA,
        sourceB: input.sourceB,
        eventsA,
        eventsB,
      });

      if (input.dryRun) {
        return { status: "preview", report };
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
      const [titlesA, titlesB] = await Promise.all([
        repository.listWorldlineRecordTitles(scopeA),
        repository.listWorldlineRecordTitles(scopeB),
      ]);
      const records = [...titlesA, ...titlesB].map((record) => ({
        id: `record_merge_${idFactory()}`,
        title: record.title,
        sourceRecordId: record.id,
      }));
      const headTick = Math.max(
        0,
        ...report.manifest.map((entry) => entry.tick),
      );
      const topology: MergedTopologyInput = {
        worldlineId: mergedWorldlineId,
        label: `合并：${input.sourceA} + ${input.sourceB}`,
        storyId: `story_merge_${idFactory()}`,
        storyTitle: "合并时间线",
        records,
        headTick,
        headOrdinal: report.manifest.length,
      };
      const auditRow: MergeAuditRow = {
        id: mergeId,
        idempotencyKey: input.idempotencyKey,
        sourceWorldlineA: input.sourceA,
        sourceWorldlineB: input.sourceB,
        mergedWorldlineId,
        operator: input.operator,
        status: "merged",
        conflictReport: report,
        manifest: report.manifest,
      };
      try {
        if (repository.createMergedTopologyAndAudit) {
          await repository.createMergedTopologyAndAudit(input, topology, auditRow);
        } else {
          await repository.createMergedTopology(input, topology);
          await repository.insertMerge(input, auditRow);
        }
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
      return { status: "merged", mergeId, mergedWorldlineId, report };
    },
  };
}

function mergeResultFromExisting(existing: WorldlineMergeRow): MergeResult {
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
