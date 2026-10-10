import { createHash } from "node:crypto";
import type { JsonValue } from "../runtime/public.ts";

export type GoalState = "active" | "completed" | "failed" | "settled";
export type GoalMode = "deterministic" | "semantic";

/** Record-scoped Goal runtime 作用域（精确 Record binding，不读 worlds）。 */
export interface GoalRuntimeScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
}

/**
 * Goal instance id 规则：`goal_` + sha256 域分隔 digest 前 24 hex，
 * digest 输入为完整 Record scope + goalKey。
 *
 * - 稳定：同一 Record 的同一 goalKey 永远派生同一 id——RealmWorld
 *   instantiate 的确定性 runtime identity / 幂等重放不会因重试而产生
 *   不同 id；
 * - collision-safe：唯一性由 PK (workspace_id, id) 与
 *   UNIQUE (workspace_id, record_id, goal_key) 兜底——digest 碰撞或重复
 *   goalKey 会令 INSERT 冲突并中止整个 workspace 事务（fail-closed），
 *   绝不静默合并两个 Goal，也不残留半个 topology。
 */
export function goalInstanceIdFor(scope: GoalRuntimeScope, goalKey: string): string {
  const digest = createHash("sha256")
    .update([
      "goal-instance:v1",
      scope.workspaceId,
      scope.worldId,
      scope.worldlineId,
      scope.recordId,
      goalKey,
    ].join("\0"))
    .digest("hex");
  return `goal_${digest.slice(0, 24)}`;
}

/**
 * Goal assessment job id 规则：`goal_job_` + sha256 域分隔 digest 前 24
 * hex，digest 输入为 workspace + goal instance id + source event id。
 *
 * - 稳定/dedupe：同一 (goal_instance_id, source_event_id) 永远派生同一
 *   job id，逻辑去重由
 *   UNIQUE (workspace_id, goal_instance_id, source_event_id) +
 *   只接受确定性 id 的 identity-checked upsert 执行——release replay /
 *   opening 重放不重复 enqueue；natural-key 对应非派生 id 会 fail-closed
 *   抛出 identity conflict，不静默合并；
 * - collision-safe：不同逻辑对的 digest 碰撞会撞 PK (workspace_id, id)
 *   并中止事务（fail-closed），绝不静默合并两个 job。
 */
export function goalAssessmentJobIdFor(
  workspaceId: string,
  goalInstanceId: string,
  sourceEventId: string,
): string {
  const digest = createHash("sha256")
    .update([
      "goal-assessment-job:v1",
      workspaceId,
      goalInstanceId,
      sourceEventId,
    ].join("\0"))
    .digest("hex");
  return `goal_job_${digest.slice(0, 24)}`;
}

export interface GoalEvent {
  eventId: string;
  recordId: string;
  recordVersion: number;
  ordinal: number;
  kind: string;
  payload: JsonValue;
}

export interface GoalEventCountRubric {
  kind: "event_count";
  eventKind: string;
  progressKey: string;
  threshold: number;
}

export interface GoalSemanticRubric {
  kind: "semantic";
  promptKey: string;
}

export type GoalRubric = GoalEventCountRubric | GoalSemanticRubric;

export interface GoalDefinition {
  goalKey: string;
  policyVersion: string;
  mode: GoalMode;
  visible: boolean;
  rubric: GoalRubric;
  outcome: Readonly<Record<string, JsonValue>>;
}

export interface GoalInstanceSnapshot {
  goalInstanceId: string;
  recordId: string;
  state: GoalState;
  revision: number;
  progress: Readonly<Record<string, JsonValue>>;
  outcome: Readonly<Record<string, JsonValue>> | null;
}

export interface GoalEvidenceSummary {
  progress: Readonly<Record<string, JsonValue>>;
  evidenceEventIds: readonly string[];
  evidenceHead: { recordVersion: number; ordinal: number } | null;
  evidenceSnapshotHash: string;
}

export interface GoalTransition extends GoalEvidenceSummary {
  from: GoalState;
  to: "completed";
  revision: number;
  outcome: Readonly<Record<string, JsonValue>>;
  policyVersion: string;
}

export interface GoalAssessmentCandidate {
  decision: "complete" | "continue" | "reject";
  policyVersion: string;
  evidenceEventIds: readonly string[];
  evidenceSnapshotHash: string;
  progress: Readonly<Record<string, JsonValue>>;
  outcome: Readonly<Record<string, JsonValue>> | null;
}

export type GoalAssessmentValidation =
  | { kind: "accepted"; transition: GoalTransition }
  | { kind: "rejected"; code: string }
  | { kind: "stale"; code: string }
  | { kind: "terminal"; code: string };

export type GoalEvaluation =
  | (GoalEvidenceSummary & { kind: "unchanged" })
  | (GoalEvidenceSummary & { kind: "terminal" })
  | (GoalEvidenceSummary & { kind: "unsupported" })
  | (GoalEvidenceSummary & { kind: "invalid" })
  | {
      kind: "transition";
      transition: GoalTransition;
      evidenceSnapshotHash: string;
    };

/**
 * Evaluate the first deterministic Goal rubric without mutating persistence.
 *
 * This is intentionally a narrow public engine primitive: content provides a
 * typed definition, the runtime provides committed events, and this function
 * returns either a validated transition or an auditable no-op. It never writes
 * a Goal fact and it never treats a semantic/Judge Goal as deterministic.
 */
export function evaluateDeterministicGoal(input: {
  definition: GoalDefinition;
  instance: GoalInstanceSnapshot;
  events: readonly GoalEvent[];
}): GoalEvaluation {
  const { definition, instance } = input;
  const eventKind = definition.rubric.kind === "event_count"
    ? definition.rubric.eventKind
    : "";
  const progressKey = definition.rubric.kind === "event_count"
    ? definition.rubric.progressKey
    : "events";
  const baseEvents = input.events.filter((event) => event?.recordId === instance.recordId);
  const evidenceEvents = baseEvents
    .filter((event) => event.kind === eventKind)
    .sort(compareEvents);
  const evidenceEventIds = uniqueEventIds(evidenceEvents);
  const evidenceHead = evidenceEvents.length > 0
    ? {
        recordVersion: evidenceEvents[evidenceEvents.length - 1]!.recordVersion,
        ordinal: evidenceEvents[evidenceEvents.length - 1]!.ordinal,
      }
    : null;
  const evidenceSnapshotHash = hashEvidence(
    definition,
    instance,
    evidenceEvents,
    evidenceHead,
  );
  const progress = {
    [progressKey]: evidenceEventIds.length,
  };
  const evidence: GoalEvidenceSummary = {
    progress,
    evidenceEventIds,
    evidenceHead,
    evidenceSnapshotHash,
  };

  if (definition.mode !== "deterministic") {
    return { kind: "unsupported", ...evidence };
  }
  if (!isValidDefinition(definition)) {
    return { kind: "invalid", ...evidence };
  }
  if (definition.rubric.kind !== "event_count") {
    return { kind: "invalid", ...evidence };
  }
  if (instance.state !== "active") {
    return { kind: "terminal", ...evidence };
  }
  if (evidenceEventIds.length < definition.rubric.threshold) {
    return { kind: "unchanged", ...evidence };
  }

  return {
    kind: "transition",
    evidenceSnapshotHash,
    transition: {
      from: instance.state,
      to: "completed",
      revision: instance.revision + 1,
      progress,
      outcome: definition.outcome,
      evidenceEventIds,
      evidenceHead,
      evidenceSnapshotHash,
      policyVersion: definition.policyVersion,
    },
  };
}

export function goalEvidenceSnapshotHash(input: {
  definition: GoalDefinition;
  instance: GoalInstanceSnapshot;
  events: readonly GoalEvent[];
  evidenceHead: { recordVersion: number; ordinal: number } | null;
}): string {
  return hashEvidence(input.definition, input.instance, input.events, input.evidenceHead);
}

/**
 * Validate a semantic Judge candidate against the committed Record evidence.
 * The candidate can propose a transition, but it cannot write a Goal fact or
 * bypass record scope, head ordering, policy version, or evidence hashing.
 */
export function validateGoalAssessment(input: {
  definition: GoalDefinition;
  instance: GoalInstanceSnapshot;
  candidate: GoalAssessmentCandidate;
  events: readonly GoalEvent[];
  head: { recordVersion: number; ordinal: number };
}): GoalAssessmentValidation {
  const { definition, instance, candidate, events, head } = input;
  if (
    definition.mode !== "semantic"
    || !isValidDefinition(definition)
    || definition.rubric.kind !== "semantic"
  ) {
    return { kind: "rejected", code: "GOAL_MODE_UNSUPPORTED" };
  }
  if (instance.state !== "active") {
    return { kind: "terminal", code: "GOAL_ALREADY_TERMINAL" };
  }
  if (candidate.policyVersion !== definition.policyVersion) {
    return { kind: "rejected", code: "GOAL_POLICY_VERSION_MISMATCH" };
  }
  if (candidate.decision !== "complete") {
    return { kind: "rejected", code: "GOAL_ASSESSMENT_NOT_COMPLETE" };
  }
  if (
    !Array.isArray(candidate.evidenceEventIds)
    || candidate.evidenceEventIds.length === 0
  ) {
    return { kind: "rejected", code: "GOAL_EVIDENCE_EMPTY" };
  }
  const uniqueIds = new Set(candidate.evidenceEventIds);
  if (uniqueIds.size !== candidate.evidenceEventIds.length) {
    return { kind: "rejected", code: "GOAL_EVIDENCE_DUPLICATE" };
  }
  const selectedEvents: GoalEvent[] = [];
  for (const eventId of candidate.evidenceEventIds) {
    const event = events.find((item) => item.eventId === eventId);
    if (!event) {
      return { kind: "rejected", code: "GOAL_EVIDENCE_EVENT_NOT_FOUND" };
    }
    if (event.recordId !== instance.recordId) {
      return { kind: "rejected", code: "GOAL_EVIDENCE_SCOPE_MISMATCH" };
    }
    if (compareCursor(event, head) > 0) {
      return { kind: "stale", code: "GOAL_EVIDENCE_AHEAD_OF_HEAD" };
    }
    selectedEvents.push(event);
  }
  const expectedHash = goalEvidenceSnapshotHash({
    definition,
    instance,
    events: selectedEvents,
    evidenceHead: head,
  });
  if (candidate.evidenceSnapshotHash !== expectedHash) {
    return { kind: "rejected", code: "GOAL_EVIDENCE_HASH_MISMATCH" };
  }
  if (!isJsonObject(candidate.progress)) {
    return { kind: "rejected", code: "GOAL_PROGRESS_INVALID" };
  }
  if (candidate.outcome !== null && !isJsonObject(candidate.outcome)) {
    return { kind: "rejected", code: "GOAL_OUTCOME_INVALID" };
  }
  return {
    kind: "accepted",
    transition: {
      from: instance.state,
      to: "completed",
      revision: instance.revision + 1,
      progress: candidate.progress,
      outcome: candidate.outcome ?? definition.outcome,
      evidenceEventIds: [...candidate.evidenceEventIds],
      evidenceHead: head,
      evidenceSnapshotHash: expectedHash,
      policyVersion: definition.policyVersion,
    },
  };
}

function isValidDefinition(definition: GoalDefinition): boolean {
  const rubric = definition.rubric;
  if (
    definition.goalKey.trim().length === 0
    || definition.policyVersion.trim().length === 0
    || rubric === null
    || typeof rubric !== "object"
    || definition.outcome === null
    || typeof definition.outcome !== "object"
  ) {
    return false;
  }
  if (definition.mode === "semantic") {
    return rubric.kind === "semantic"
      && rubric.promptKey.trim().length > 0;
  }
  return rubric.kind === "event_count"
    && rubric.eventKind.trim().length > 0
    && rubric.progressKey.trim().length > 0
    && Number.isSafeInteger(rubric.threshold)
    && rubric.threshold > 0;
}

function uniqueEventIds(events: readonly GoalEvent[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const event of events) {
    if (typeof event.eventId !== "string" || event.eventId.trim() === "") continue;
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    ids.push(event.eventId);
  }
  return ids;
}

function compareEvents(left: GoalEvent, right: GoalEvent): number {
  return left.recordVersion - right.recordVersion
    || left.ordinal - right.ordinal
    || left.eventId.localeCompare(right.eventId);
}

function compareCursor(
  event: GoalEvent,
  head: { recordVersion: number; ordinal: number },
): number {
  return event.recordVersion - head.recordVersion
    || event.ordinal - head.ordinal;
}

function isJsonObject(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashEvidence(
  definition: GoalDefinition,
  instance: GoalInstanceSnapshot,
  events: readonly GoalEvent[],
  evidenceHead: { recordVersion: number; ordinal: number } | null,
): string {
  const digestInput = stableJson({
    goalKey: definition.goalKey,
    policyVersion: definition.policyVersion,
    recordId: instance.recordId,
    rubric: definition.rubric,
    evidenceHead,
    events: events.map((event) => ({
      eventId: event.eventId,
      recordVersion: event.recordVersion,
      ordinal: event.ordinal,
      kind: event.kind,
      payload: event.payload,
    })),
  });
  return createHash("sha256").update(digestInput).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  )).join(",")}}`;
}

export { projectGoal } from "./projection.ts";
export type { GoalProjection, GoalProjectionInstance } from "./projection.ts";
export {
  createGoalProjectionStream,
  type GoalProjectionStreamInput,
  type GoalProjectionStreamSnapshot,
} from "./projection-stream.ts";
