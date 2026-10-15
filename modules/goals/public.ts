import { createHash } from "node:crypto";
import { RuntimeInvariantError, type JsonValue } from "../runtime/public.ts";

export type GoalState = "active" | "completed" | "failed" | "settled";
export type GoalTerminalState = "completed" | "failed" | "settled";
export type GoalMode = "deterministic" | "semantic";

/** Goal runtime scope 判别位：record | story | worldline。 */
export type GoalScopeKind = "record" | "story" | "worldline";

/**
 * Record-scoped Goal runtime 作用域（精确 Record binding，不读 worlds）。
 *
 * `kind` 判别位允许缺省：历史 Record-only 调用方（事件提交 hook、分支
 * 克隆）不传 `kind` 时等价于 "record"，旧 Record 实例身份与读取路径
 * 逐字节兼容。
 */
export interface GoalRuntimeScope {
  kind?: "record";
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
}

/** story scope：绑定 worldline + storyId（Story Graph 成员解析在 B2）。 */
export interface GoalStoryScope {
  kind: "story";
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  storyId: string;
}

/** worldline scope：绑定整条 worldline。 */
export interface GoalWorldlineScope {
  kind: "worldline";
  workspaceId: string;
  worldId: string;
  worldlineId: string;
}

/** Goal runtime scope 判别联合。 */
export type GoalScope = GoalRuntimeScope | GoalStoryScope | GoalWorldlineScope;

/** 归一化 scope 判别位（缺省 kind 的 Record-shaped scope 视为 "record"）。 */
export function goalScopeKind(scope: GoalScope): GoalScopeKind {
  if ("recordId" in scope && typeof scope.recordId === "string") return "record";
  return scope.kind ?? "record";
}

/** scope 的锚 id：record→recordId，story→storyId，worldline→空串。 */
export function goalScopeAnchorId(scope: GoalScope): string {
  const kind = goalScopeKind(scope);
  if (kind === "record") return (scope as GoalRuntimeScope).recordId;
  if (kind === "story") return (scope as GoalStoryScope).storyId;
  return "";
}

/**
 * Goal instance id 规则：`goal_` + sha256 域分隔 digest 前 24 hex。
 *
 * - Record scope 的首个 attempt（attempt=1）保持历史 digest
 *   `goal-instance:v1`（完整 Record scope + goalKey）——旧 Record 实例
 *   身份逐字节不变，绝不静默改身份；
 * - story / worldline scope 与任何 attempt>1 使用域分隔的
 *   `goal-instance:v2` digest（scopeKind + scope 锚 + goalKey +
 *   attempt）——跨 scopeKind 永不撞身份，终态重试的新 attempt 永远得到
 *   新确定性 id；
 *
 * - 稳定：同一 scope 的同一 goalKey + attempt 永远派生同一 id——
 *   RealmWorld instantiate 的确定性 runtime identity / 幂等重放不会产生
 *   隐式重复；终态重试通过 attempt 显式开启新身份，重复 materialize
 *   仍由 DB unique constraint fail-closed；
 * - collision-safe：唯一性由 PK (workspace_id, id) 与 0060 的 scope-aware
 *   UNIQUE index（scope + goalKey + attempt）兜底——digest 碰撞或重复
 *   materialize 会令 INSERT 冲突并中止整个 workspace 事务（fail-closed），
 *   绝不静默合并两个 Goal，也不残留半个 topology。
 */
export function goalInstanceIdFor(
  scope: GoalScope,
  goalKey: string,
  attempt = 1,
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new RuntimeInvariantError(
      "GOAL_INSTANCE_ATTEMPT_INVALID",
      "Goal instance attempt must be a positive integer.",
    );
  }
  const scopeKind = goalScopeKind(scope);
  if (scopeKind === "record" && attempt === 1) {
    const recordScope = scope as GoalRuntimeScope;
    const digest = createHash("sha256")
      .update([
        "goal-instance:v1",
        recordScope.workspaceId,
        recordScope.worldId,
        recordScope.worldlineId,
        recordScope.recordId,
        goalKey,
      ].join("\0"))
      .digest("hex");
    return `goal_${digest.slice(0, 24)}`;
  }
  const digest = createHash("sha256")
    .update([
      "goal-instance:v2",
      scopeKind,
      scope.workspaceId,
      scope.worldId,
      scope.worldlineId,
      goalScopeAnchorId(scope),
      goalKey,
      String(attempt),
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
  /**
   * 可选失败条件：同一 Record scope 内 failure.eventKind 的 committed
   * 事件达到 threshold 时，Goal 迁移到 failed 终态（仍需
   * definition.terminals 允许 failed）。failure.progressKey 记录失败
   * 证据计数。failure.eventKind 必须与完成条件的 eventKind 不同。
   */
  failure?: {
    eventKind: string;
    progressKey: string;
    threshold: number;
  };
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
  /**
   * 允许的终态集合（缺省三个终态全允许）。R6+ 内容可收窄——例如声明
   * terminals 不含 failed；校验器/求值器必须 fail-closed 拒绝产生不被
   * 允许的终态。
   */
  terminals?: readonly GoalTerminalState[];
  /**
   * 终态后是否允许重试：允许时以新 attempt（新确定性 instance id +
   * supersedes_instance_id）开启新实例，终态实例绝不原地复活。
   */
  retryable?: boolean;
}

export interface GoalInstanceSnapshot {
  goalInstanceId: string;
  /** Record anchor for record-scoped instances; absent for story/worldline scope. */
  recordId?: string;
  /** Story anchor for story-scoped instances. */
  storyId?: string;
  /** Worldline anchor for story/worldline-scoped instances. */
  worldlineId?: string;
  state: GoalState;
  revision: number;
  progress: Readonly<Record<string, JsonValue>>;
  outcome: Readonly<Record<string, JsonValue>> | null;
  /** scope 判别位（缺省 "record"，兼容历史 Record-only 行）。 */
  scopeKind?: GoalScopeKind;
  /** 当前 attempt（缺省 1）。 */
  attempt?: number;
  /** 本 attempt 取代的前序终态实例 id（首个 attempt 为 null）。 */
  supersedesInstanceId?: string | null;
}

export interface GoalEvidenceSummary {
  progress: Readonly<Record<string, JsonValue>>;
  evidenceEventIds: readonly string[];
  evidenceHead: { recordVersion: number; ordinal: number } | null;
  evidenceSnapshotHash: string;
}

export interface GoalTransition extends GoalEvidenceSummary {
  from: GoalState;
  to: GoalTerminalState;
  revision: number;
  outcome: Readonly<Record<string, JsonValue>>;
  policyVersion: string;
}

export interface GoalAssessmentCandidate {
  decision: "complete" | "continue" | "reject" | "fail" | "settle";
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
  const failureRule = definition.rubric.kind === "event_count"
    ? definition.rubric.failure
    : undefined;
  const baseEvents = input.events.filter((event) => event?.recordId === instance.recordId);
  const evidenceEvents = baseEvents
    .filter((event) => event.kind === eventKind)
    .sort(compareEvents);
  const failureEvents = failureRule
    ? baseEvents
        .filter((event) => event.kind === failureRule.eventKind)
        .sort(compareEvents)
    : [];
  const evidenceEventIds = uniqueEventIds(evidenceEvents);
  const failureEventIds = uniqueEventIds(failureEvents);
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
    ...(failureRule ? { [failureRule.progressKey]: failureEventIds.length } : {}),
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
  if ((instance.scopeKind ?? "record") !== "record") {
    // story/worldline scope 的求值随 Story Graph（B2）落地；B1 引擎只对
    // Record scope 求值，其余 fail-closed 为 unsupported，绝不跨 scope
    // 猜测证据归属。
    return { kind: "unsupported", ...evidence };
  }
  const terminals = goalAllowedTerminals(definition);
  if (
    failureRule
    && failureEventIds.length >= failureRule.threshold
  ) {
    if (!terminals.has("failed")) {
      // 内容声明了失败条件却不允许 failed 终态：内容/策略不一致，
      // fail-closed 为 invalid，绝不静默改成别的终态。
      return { kind: "invalid", ...evidence };
    }
    const failureHead = failureEvents.length > 0
      ? {
          recordVersion: failureEvents[failureEvents.length - 1]!.recordVersion,
          ordinal: failureEvents[failureEvents.length - 1]!.ordinal,
        }
      : null;
    const failureSnapshotHash = hashEvidence(
      definition,
      instance,
      failureEvents,
      failureHead,
    );
    return {
      kind: "transition",
      evidenceSnapshotHash: failureSnapshotHash,
      transition: {
        from: instance.state,
        to: "failed",
        revision: instance.revision + 1,
        progress,
        outcome: definition.outcome,
        evidenceEventIds: failureEventIds,
        evidenceHead: failureHead,
        evidenceSnapshotHash: failureSnapshotHash,
        policyVersion: definition.policyVersion,
      },
    };
  }
  if (evidenceEventIds.length < definition.rubric.threshold) {
    return { kind: "unchanged", ...evidence };
  }
  if (!terminals.has("completed")) {
    return { kind: "invalid", ...evidence };
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

/** 内容声明允许的终态集合（缺省三个终态全允许）。 */
export function goalAllowedTerminals(
  definition: Pick<GoalDefinition, "terminals">,
): ReadonlySet<GoalTerminalState> {
  return new Set(definition.terminals ?? ["completed", "failed", "settled"]);
}

/**
 * Validate a semantic Judge candidate against the committed Record evidence.
 * The candidate can propose a transition (complete/fail/settle), but it
 * cannot write a Goal fact or bypass record scope, head ordering, policy
 * version, terminal allow-list, or evidence hashing.
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
  if ((instance.scopeKind ?? "record") !== "record") {
    // story/worldline scope 的 semantic 评估随 Story Graph（B2）落地；
    // B1 fail-closed，绝不跨 scope 猜测证据归属。
    return { kind: "rejected", code: "GOAL_SCOPE_UNSUPPORTED" };
  }
  if (candidate.policyVersion !== definition.policyVersion) {
    return { kind: "rejected", code: "GOAL_POLICY_VERSION_MISMATCH" };
  }
  const target: GoalTerminalState | null = candidate.decision === "complete"
    ? "completed"
    : candidate.decision === "fail"
      ? "failed"
      : candidate.decision === "settle"
        ? "settled"
        : null;
  if (target === null) {
    return { kind: "rejected", code: "GOAL_ASSESSMENT_NOT_COMPLETE" };
  }
  if (!goalAllowedTerminals(definition).has(target)) {
    return { kind: "rejected", code: "GOAL_TERMINAL_NOT_ALLOWED" };
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
      to: target,
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
  if (!isValidTerminals(definition.terminals)) {
    return false;
  }
  if (definition.mode === "semantic") {
    return rubric.kind === "semantic"
      && rubric.promptKey.trim().length > 0;
  }
  if (
    rubric.kind !== "event_count"
    || rubric.eventKind.trim().length === 0
    || rubric.progressKey.trim().length === 0
    || !Number.isSafeInteger(rubric.threshold)
    || rubric.threshold <= 0
  ) {
    return false;
  }
  const failure = rubric.failure;
  if (failure !== undefined) {
    if (
      failure === null
      || typeof failure !== "object"
      || failure.eventKind.trim().length === 0
      || failure.eventKind === rubric.eventKind
      || failure.progressKey.trim().length === 0
      || failure.progressKey === rubric.progressKey
      || !Number.isSafeInteger(failure.threshold)
      || failure.threshold <= 0
    ) {
      return false;
    }
  }
  return true;
}

function isValidTerminals(terminals: readonly GoalTerminalState[] | undefined): boolean {
  if (terminals === undefined) return true;
  if (!Array.isArray(terminals) || terminals.length === 0) return false;
  const seen = new Set<string>();
  for (const terminal of terminals) {
    if (
      terminal !== "completed"
      && terminal !== "failed"
      && terminal !== "settled"
    ) {
      return false;
    }
    if (seen.has(terminal)) return false;
    seen.add(terminal);
  }
  return true;
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

function goalScopeKindFromSnapshot(instance: GoalInstanceSnapshot): GoalScopeKind {
  return instance.scopeKind ?? (instance.recordId !== undefined ? "record" : "worldline");
}

function hashEvidence(
  definition: GoalDefinition,
  instance: GoalInstanceSnapshot,
  events: readonly GoalEvent[],
  evidenceHead: { recordVersion: number; ordinal: number } | null,
): string {
  // Preserve the historical Record-scope digest byte-for-byte. New scopes
  // must bind their anchor into the evidence hash, otherwise identical event
  // selections from two Stories/worldlines would share a Judge evidence
  // identity.
  const scope = goalScopeKindFromSnapshot(instance);
  const scopeIdentity = scope === "record"
    ? { recordId: instance.recordId }
    : {
        scopeKind: scope,
        storyId: instance.storyId,
        worldlineId: instance.worldlineId,
      };
  const digestInput = stableJson({
    goalKey: definition.goalKey,
    policyVersion: definition.policyVersion,
    ...scopeIdentity,
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
