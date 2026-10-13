/**
 * Engine backend Slice 5：World Command / 跨 Record 领域事务的公共契约
 * （docs/development/CROSS-RECORD-DOMAIN-TRANSACTION.md）。
 *
 * 本模块只含纯契约与纯函数：
 * - WorldCommandRequest：请求层唯一接受的输入（可信服务端注入 scope 与
 *   principal；客户端不得提交可信余额/权限结果/Worldline cursor）。
 * - CommandPlan：服务端在事务外生成并校验的有界计划——不携带 SQL、表名、
 *   函数名或可执行代码。
 * - 确定性身份：commandGroupIdFor / subCommandIdFor /
 *   createWorldCommandFingerprint 全部由规范化输入派生，幂等重放自然收敛。
 * - planWorldCommandLockOrder：全局锁序（Worldline → Command Group →
 *   按 record_id 升序的 Record heads）的纯计划函数，输入顺序无关。
 * - toPlayerSafeWorldCommandResult：player-safe 投影——不暴露内部
 *   manifest、子命令身份、event/outbox id 清单或控制面细节。
 */
import { createHash } from "node:crypto";
import type { JsonValue } from "../runtime/public.ts";

export const WORLD_COMMAND_POLICY_VERSION = "world-command.v1";

/** 计划有界围栏：任何超限都在写入前以稳定码拒绝。 */
export const WORLD_COMMAND_LIMITS = Object.freeze({
  maxTouchedRecords: 8,
  maxEventsPerRecord: 16,
  maxOutboxMessagesPerRecord: 8,
  maxObservationsPerEvent: 16,
  maxCharacterStateUpdatesPerEvent: 8,
  maxActionCostsPerEvent: 8,
  maxActionEffectsPerEvent: 8,
  maxIdempotencyKeyLength: 128,
  maxIdentifierLength: 256,
  maxContentLength: 4096,
  maxPayloadBytes: 8192,
  maxMetadataBytes: 4096,
  maxTotalPayloadBytes: 65536,
});

export const WORLD_COMMAND_EVENT_KINDS = [
  "utterance.committed",
  "narration.committed",
  "action.transaction.committed",
  "system.correction.committed",
] as const;
export type WorldCommandEventKind = (typeof WORLD_COMMAND_EVENT_KINDS)[number];

export type WorldCommandObservationKind =
  | "direct"
  | "inferred"
  | "rumor"
  | "system_grant";

export interface WorldCommandScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
}

export interface WorldCommandCursor {
  tick: number;
  ordinal: number;
}

/** 请求层的 touched Record：identity + expected head（服务端事务内复核）。 */
export interface WorldCommandTouchedRecord {
  recordId: string;
  expectedRecordVersion: number;
}

export interface WorldCommandRequest {
  scope: WorldCommandScope;
  primaryRecordId: string;
  touchedRecords: readonly WorldCommandTouchedRecord[];
  idempotencyKey: string;
  /** 玩家输入/结构化行动的受限 payload；指纹覆盖，payload 有界。 */
  payload: JsonValue;
}

export interface WorldCommandObservationWrite {
  observationId: string;
  observerCharacterInstanceId: string;
  dedupeKey: string;
  kind: WorldCommandObservationKind;
  content: string;
  fidelity?: number;
  availableFrom?: WorldCommandCursor;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface WorldCommandActionStateWrite {
  receiptId: string;
  transactionId: string;
  actorCharacterInstanceId: string;
  callFingerprint: string;
  receipt: Readonly<Record<string, JsonValue>>;
  costs: readonly { resourceId: string; amount: number }[];
  effects: readonly {
    effectId: string;
    targetId: string;
    operation: "apply" | "remove";
  }[];
}

export interface WorldCommandVisibilityPolicyWrite {
  id: string;
  policyKey: string;
  restrictedDomainId: string;
  audienceCharacterInstanceIds: readonly string[];
}

export interface WorldCommandEventWrite {
  eventId: string;
  kind: WorldCommandEventKind;
  sceneId: string;
  visibilityPolicyId: string;
  /** 动态 restricted 策略随事件首次物化（与 commitRelease 同语义）。 */
  visibilityPolicy?: WorldCommandVisibilityPolicyWrite;
  actorParticipantId?: string | null;
  speakerName?: string;
  content?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
  payload: JsonValue;
  observations?: readonly WorldCommandObservationWrite[];
  characterStateUpdates?: readonly {
    characterInstanceId: string;
    statePatch: Readonly<Record<string, JsonValue>>;
  }[];
  actionState?: WorldCommandActionStateWrite;
}

export interface WorldCommandOutboxWrite {
  messageId: string;
  dedupeKey: string;
  topic: string;
  payload: JsonValue;
}

export interface CommandPlanRecord {
  recordId: string;
  expectedRecordVersion: number;
  /** 每个 touched Record 至少一条正式事件（v1 语义：触及即提交正式事实）。 */
  events: readonly WorldCommandEventWrite[];
  outbox: readonly WorldCommandOutboxWrite[];
}

/**
 * 服务端生成并校验的有界计划。records 必须按 recordId 严格升序；
 * 计划不携带 SQL/表名/函数名，所有写都是数据。
 */
export interface CommandPlan {
  scope: WorldCommandScope;
  commandGroupId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  primaryRecordId: string;
  expectedWorldCursor: WorldCommandCursor;
  records: readonly CommandPlanRecord[];
  policyVersion: string;
}

export type WorldCommandGroupState = "committed" | "rejected";

/** Group ↔ Record 关联（结果清单内部形态，含审计身份）。 */
export interface CommandGroupRecordResult {
  recordId: string;
  role: "primary" | "touched";
  subCommandId: string;
  expectedRecordVersion: number;
  finalRecordVersion: number;
  firstRecordOrdinal: number;
  nextRecordOrdinal: number;
  eventIds: readonly string[];
}

export interface WorldCommandCommittedResult {
  state: "committed";
  commandGroupId: string;
  scope: WorldCommandScope;
  worldCursor: WorldCommandCursor;
  committedAt: string;
  records: readonly CommandGroupRecordResult[];
  outboxMessageIds: readonly string[];
}

export interface WorldCommandRejectedResult {
  state: "rejected";
  commandGroupId: string;
  scope: WorldCommandScope;
  code: string;
  message: string;
  rejectedAt: string;
}

export type WorldCommandResult =
  | WorldCommandCommittedResult
  | WorldCommandRejectedResult;

/** player-safe 投影：无内部 manifest、无子命令身份、无 event/outbox id。 */
export interface PlayerSafeWorldCommandResult {
  commandGroupId: string;
  state: WorldCommandGroupState;
  records: readonly {
    recordId: string;
    recordVersion: number;
    nextOrdinal: number;
    eventCount: number;
  }[];
  worldCursor?: WorldCommandCursor;
  committedAt?: string;
  rejection?: { code: string; message: string };
}

export type WorldCommandErrorCode =
  | "WORLD_COMMAND_REQUEST_INVALID"
  | "WORLD_COMMAND_SCOPE_MISMATCH"
  | "WORLD_COMMAND_RECORD_UNKNOWN"
  | "WORLD_COMMAND_RECORD_ARCHIVED"
  | "WORLD_COMMAND_PLAN_INVALID"
  | "WRITE_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSE"
  | "WORLD_COMMAND_IDENTITY_CONFLICT"
  | "WORLD_COMMAND_COMMIT_UNAVAILABLE";

export class WorldCommandError extends Error {
  readonly code: WorldCommandErrorCode | (string & {});
  readonly safeMessage: string;
  /** true = 上层可以重读状态后重试（版本/游标冲突与瞬态提交失败）。 */
  readonly retryable: boolean;

  constructor(
    code: WorldCommandErrorCode | (string & {}),
    safeMessage: string,
    options: { retryable?: boolean } = {},
  ) {
    super(safeMessage);
    this.name = "WorldCommandError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.retryable = options.retryable === true;
  }
}

export function isWorldCommandError(error: unknown): error is WorldCommandError {
  return error instanceof WorldCommandError;
}

/** 去重 + 稳定升序排序 + primary 成员校验；输入顺序无关。 */
export function normalizeTouchedRecords(
  request: Pick<
    WorldCommandRequest,
    "primaryRecordId" | "touchedRecords"
  >,
): readonly WorldCommandTouchedRecord[] {
  const primaryRecordId = request.primaryRecordId.trim();
  if (!primaryRecordId) {
    throw new WorldCommandError(
      "WORLD_COMMAND_REQUEST_INVALID",
      "A World Command requires a primary Record.",
    );
  }
  const byRecordId = new Map<string, number>();
  for (const touched of request.touchedRecords) {
    const recordId = typeof touched?.recordId === "string" ? touched.recordId.trim() : "";
    if (!recordId || recordId.length > WORLD_COMMAND_LIMITS.maxIdentifierLength) {
      throw new WorldCommandError(
        "WORLD_COMMAND_REQUEST_INVALID",
        "Every touched Record requires a bounded identifier.",
      );
    }
    if (
      !Number.isSafeInteger(touched.expectedRecordVersion)
      || touched.expectedRecordVersion < 0
    ) {
      throw new WorldCommandError(
        "WORLD_COMMAND_REQUEST_INVALID",
        "Every touched Record requires a non-negative expected head.",
      );
    }
    const existing = byRecordId.get(recordId);
    if (existing !== undefined && existing !== touched.expectedRecordVersion) {
      throw new WorldCommandError(
        "WORLD_COMMAND_REQUEST_INVALID",
        "Duplicate touched Records must carry the same expected head.",
      );
    }
    byRecordId.set(recordId, touched.expectedRecordVersion);
  }
  if (byRecordId.size === 0) {
    throw new WorldCommandError(
      "WORLD_COMMAND_REQUEST_INVALID",
      "A World Command must touch at least one Record.",
    );
  }
  if (byRecordId.size > WORLD_COMMAND_LIMITS.maxTouchedRecords) {
    throw new WorldCommandError(
      "WORLD_COMMAND_REQUEST_INVALID",
      "A World Command touches too many Records.",
    );
  }
  if (!byRecordId.has(primaryRecordId)) {
    throw new WorldCommandError(
      "WORLD_COMMAND_REQUEST_INVALID",
      "The primary Record must be part of the touched Record set.",
    );
  }
  return [...byRecordId.entries()]
    .map(([recordId, expectedRecordVersion]) => ({ recordId, expectedRecordVersion }))
    .sort((left, right) => compareIdentifiers(left.recordId, right.recordId));
}

/** 确定性 Command Group 身份：同 scope + key 恒同 id（replay 自然收敛）。 */
export function commandGroupIdFor(
  scope: WorldCommandScope,
  idempotencyKey: string,
): string {
  return `wcg_${digest([
    scope.workspaceId,
    scope.worldId,
    scope.worldlineId,
    idempotencyKey,
  ])}`;
}

/** 确定性 per-Record 子命令身份（command_inbox/turn_runs 行 id）。 */
export function subCommandIdFor(commandGroupId: string, recordId: string): string {
  return `wcs_${digest([commandGroupId, recordId])}`;
}

/**
 * 请求指纹：覆盖 scope、primary、排序后的 touched 集合与 payload；
 * 刻意不含 idempotencyKey（key 是身份，指纹绑定内容）。
 */
export function createWorldCommandFingerprint(
  request: WorldCommandRequest,
): string {
  const touched = normalizeTouchedRecords(request);
  return `wcmd_${sha256(canonicalJson({
    scope: {
      workspaceId: request.scope.workspaceId,
      worldId: request.scope.worldId,
      worldlineId: request.scope.worldlineId,
    },
    primaryRecordId: request.primaryRecordId,
    touchedRecords: touched,
    payload: request.payload,
  }))}`;
}

/**
 * 全局锁序计划（CROSS-RECORD-DOMAIN-TRANSACTION §6.1）：Worldline →
 * Command Group → 按 record_id 升序的 Record heads。纯函数；同一 touched
 * 集合的任意输入顺序产出同一锁序。
 */
export function planWorldCommandLockOrder(
  plan: Pick<CommandPlan, "scope" | "records"> | {
    scope: WorldCommandScope;
    records: readonly { recordId: string }[];
  },
): { worldlineId: string; recordIds: readonly string[] } {
  const recordIds = [...new Set(plan.records.map((record) => record.recordId))]
    .sort(compareIdentifiers);
  return { worldlineId: plan.scope.worldlineId, recordIds };
}

export function buildCommandPlan(input: {
  request: WorldCommandRequest;
  effects: readonly {
    recordId: string;
    events: readonly WorldCommandEventWrite[];
    outbox?: readonly WorldCommandOutboxWrite[];
  }[];
  expectedWorldCursor: WorldCommandCursor;
  policyVersion?: string;
}): CommandPlan {
  const touched = normalizeTouchedRecords(input.request);
  const effectsByRecord = new Map<string, (typeof input.effects)[number]>();
  for (const effect of input.effects) {
    if (effectsByRecord.has(effect.recordId)) {
      throw new WorldCommandError(
        "WORLD_COMMAND_PLAN_INVALID",
        "Command effects must be declared once per touched Record.",
      );
    }
    effectsByRecord.set(effect.recordId, effect);
  }
  for (const record of touched) {
    if (!effectsByRecord.has(record.recordId)) {
      throw new WorldCommandError(
        "WORLD_COMMAND_PLAN_INVALID",
        "Every touched Record requires declared command effects.",
      );
    }
  }
  for (const recordId of effectsByRecord.keys()) {
    if (!touched.some((record) => record.recordId === recordId)) {
      throw new WorldCommandError(
        "WORLD_COMMAND_PLAN_INVALID",
        "Command effects must not target Records outside the touched set.",
      );
    }
  }
  const plan: CommandPlan = {
    scope: {
      workspaceId: input.request.scope.workspaceId,
      worldId: input.request.scope.worldId,
      worldlineId: input.request.scope.worldlineId,
    },
    commandGroupId: commandGroupIdFor(
      input.request.scope,
      input.request.idempotencyKey,
    ),
    idempotencyKey: input.request.idempotencyKey,
    requestFingerprint: createWorldCommandFingerprint(input.request),
    primaryRecordId: input.request.primaryRecordId.trim(),
    expectedWorldCursor: { ...input.expectedWorldCursor },
    records: touched.map((record) => {
      const effect = effectsByRecord.get(record.recordId)!;
      return {
        recordId: record.recordId,
        expectedRecordVersion: record.expectedRecordVersion,
        events: [...effect.events],
        outbox: [...(effect.outbox ?? [])],
      };
    }),
    policyVersion: input.policyVersion ?? WORLD_COMMAND_POLICY_VERSION,
  };
  validateCommandPlan(plan);
  return plan;
}

/** 计划结构校验（纯、确定性）；事务内外都执行（纵深防御）。 */
export function validateCommandPlan(plan: CommandPlan): void {
  const invalid = (message: string): never => {
    throw new WorldCommandError("WORLD_COMMAND_PLAN_INVALID", message);
  };
  if (
    !plan.scope.workspaceId.trim()
    || !plan.scope.worldId.trim()
    || !plan.scope.worldlineId.trim()
  ) {
    invalid("A Command Plan requires a complete Worldline scope.");
  }
  if (
    !plan.commandGroupId.trim()
    || !plan.requestFingerprint.trim()
    || !plan.idempotencyKey.trim()
    || plan.idempotencyKey.length > WORLD_COMMAND_LIMITS.maxIdempotencyKeyLength
  ) {
    invalid("A Command Plan requires a bounded idempotency identity.");
  }
  if (!plan.policyVersion.trim()) {
    invalid("A Command Plan requires a policy version.");
  }
  if (
    !Number.isSafeInteger(plan.expectedWorldCursor.tick)
    || !Number.isSafeInteger(plan.expectedWorldCursor.ordinal)
    || plan.expectedWorldCursor.tick < 0
    || plan.expectedWorldCursor.ordinal < 0
  ) {
    invalid("A Command Plan requires a valid expected Worldline cursor.");
  }
  if (plan.records.length === 0) {
    invalid("A Command Plan must touch at least one Record.");
  }
  if (plan.records.length > WORLD_COMMAND_LIMITS.maxTouchedRecords) {
    invalid("A Command Plan touches too many Records.");
  }
  if (!plan.records.some((record) => record.recordId === plan.primaryRecordId)) {
    invalid("The primary Record must be part of the touched Record set.");
  }

  const eventIds = new Set<string>();
  const outboxMessageIds = new Set<string>();
  const outboxDedupeKeys = new Set<string>();
  let totalPayloadBytes = 0;

  let previousRecordId: string | null = null;
  for (const record of plan.records) {
    if (
      previousRecordId !== null
      && compareIdentifiers(previousRecordId, record.recordId) >= 0
    ) {
      invalid("Touched Records must be unique and sorted by Record identifier.");
    }
    previousRecordId = record.recordId;
    if (
      !Number.isSafeInteger(record.expectedRecordVersion)
      || record.expectedRecordVersion < 0
    ) {
      invalid("Every touched Record requires a non-negative expected head.");
    }
    if (
      record.events.length < 1
      || record.events.length > WORLD_COMMAND_LIMITS.maxEventsPerRecord
    ) {
      invalid("Every touched Record commits a bounded non-empty event batch.");
    }
    if (record.outbox.length > WORLD_COMMAND_LIMITS.maxOutboxMessagesPerRecord) {
      invalid("A touched Record commits too many Outbox messages.");
    }
    for (const event of record.events) {
      totalPayloadBytes += validateEventWrite(event, invalid);
      if (eventIds.has(event.eventId)) {
        invalid("Formal event identifiers must be unique within a Command Plan.");
      }
      eventIds.add(event.eventId);
    }
    for (const message of record.outbox) {
      if (
        !message.messageId.trim()
        || !message.dedupeKey.trim()
        || !message.topic.trim()
      ) {
        invalid("Outbox messages require identity, dedupe key and topic.");
      }
      totalPayloadBytes += payloadBytes(message.payload, invalid);
      if (outboxMessageIds.has(message.messageId)) {
        invalid("Outbox message identifiers must be unique within a Command Plan.");
      }
      outboxMessageIds.add(message.messageId);
      if (outboxDedupeKeys.has(message.dedupeKey)) {
        invalid("Outbox dedupe keys must be unique within a Command Plan.");
      }
      outboxDedupeKeys.add(message.dedupeKey);
    }
  }
  if (totalPayloadBytes > WORLD_COMMAND_LIMITS.maxTotalPayloadBytes) {
    invalid("A Command Plan exceeds the total payload budget.");
  }
}

function validateEventWrite(
  event: WorldCommandEventWrite,
  invalid: (message: string) => never,
): number {
  if (
    !event.eventId.trim()
    || event.eventId.length > WORLD_COMMAND_LIMITS.maxIdentifierLength
    || !event.sceneId.trim()
    || !event.visibilityPolicyId.trim()
  ) {
    invalid("Formal events require identity, Scene and visibility policy.");
  }
  if (!WORLD_COMMAND_EVENT_KINDS.includes(event.kind)) {
    invalid("Formal event kind is not part of the World Command contract.");
  }
  if (
    event.content !== undefined
    && event.content.length > WORLD_COMMAND_LIMITS.maxContentLength
  ) {
    invalid("Formal event content exceeds the bounded length.");
  }
  if (event.metadata !== undefined) {
    if (!isJsonObject(event.metadata)) {
      invalid("Formal event metadata must be an object.");
    }
    if (canonicalBytes(event.metadata) > WORLD_COMMAND_LIMITS.maxMetadataBytes) {
      invalid("Formal event metadata exceeds the bounded size.");
    }
  }
  if (event.visibilityPolicy) {
    const policy = event.visibilityPolicy;
    const audience = policy.audienceCharacterInstanceIds;
    if (
      policy.id !== event.visibilityPolicyId
      || !policy.id.trim()
      || !policy.policyKey.trim()
      || !policy.restrictedDomainId.trim()
      || audience.length === 0
      || new Set(audience).size !== audience.length
      || audience.some((id) => !id.trim())
    ) {
      invalid("Dynamic visibility policies require a restricted domain and unique audience.");
    }
  }
  const observations = event.observations ?? [];
  if (observations.length > WORLD_COMMAND_LIMITS.maxObservationsPerEvent) {
    invalid("Formal events carry too many observations.");
  }
  for (const observation of observations) {
    if (
      !observation.observationId.trim()
      || !observation.observerCharacterInstanceId.trim()
      || !observation.dedupeKey.trim()
      || !observation.content.trim()
    ) {
      invalid("Observations require identity, observer, dedupe key and content.");
    }
    if (
      observation.fidelity !== undefined
      && (!Number.isFinite(observation.fidelity)
        || observation.fidelity < 0
        || observation.fidelity > 1)
    ) {
      invalid("Observation fidelity must stay within [0, 1].");
    }
    if (observation.availableFrom !== undefined) {
      const available = observation.availableFrom;
      if (
        !Number.isSafeInteger(available.tick)
        || !Number.isSafeInteger(available.ordinal)
        || available.tick < 0
        || available.ordinal < 0
      ) {
        invalid("Observation availability requires a valid cursor.");
      }
    }
  }
  const stateUpdates = event.characterStateUpdates ?? [];
  if (stateUpdates.length > WORLD_COMMAND_LIMITS.maxCharacterStateUpdatesPerEvent) {
    invalid("Formal events carry too many Character state updates.");
  }
  for (const update of stateUpdates) {
    if (!update.characterInstanceId.trim() || !isJsonObject(update.statePatch)) {
      invalid("Character state updates require a target and an object patch.");
    }
    if (canonicalBytes(update.statePatch) > WORLD_COMMAND_LIMITS.maxMetadataBytes) {
      invalid("Character state patches exceed the bounded size.");
    }
  }
  if (event.actionState) {
    validateActionStateWrite(event.actionState, event.kind, invalid);
  }
  return payloadBytes(event.payload, invalid);
}

function validateActionStateWrite(
  write: WorldCommandActionStateWrite,
  eventKind: WorldCommandEventKind,
  invalid: (message: string) => never,
): void {
  if (eventKind !== "action.transaction.committed") {
    invalid("Durable Action state must attach to its Action Transaction event.");
  }
  if (
    !write.receiptId.trim()
    || !write.transactionId.trim()
    || !write.actorCharacterInstanceId.trim()
    || !write.callFingerprint.trim()
    || !isJsonObject(write.receipt)
  ) {
    invalid("Durable Action state requires receipt, actor and call identity.");
  }
  if (write.costs.length > WORLD_COMMAND_LIMITS.maxActionCostsPerEvent) {
    invalid("Durable Action state carries too many resource costs.");
  }
  for (const cost of write.costs) {
    if (
      !cost.resourceId.trim()
      || !Number.isSafeInteger(cost.amount)
      || cost.amount <= 0
    ) {
      invalid("Resource costs require a resource and a positive amount.");
    }
  }
  if (write.effects.length > WORLD_COMMAND_LIMITS.maxActionEffectsPerEvent) {
    invalid("Durable Action state carries too many effects.");
  }
  for (const effect of write.effects) {
    if (
      !effect.effectId.trim()
      || !effect.targetId.trim()
      || (effect.operation !== "apply" && effect.operation !== "remove")
    ) {
      invalid("Effects require identity, target and a supported operation.");
    }
  }
}

function payloadBytes(
  payload: JsonValue,
  invalid: (message: string) => never,
): number {
  let bytes: number;
  try {
    bytes = canonicalBytes(payload);
  } catch {
    invalid("Command payloads must be JSON-serializable values.");
  }
  if (bytes! > WORLD_COMMAND_LIMITS.maxPayloadBytes) {
    invalid("Command payloads exceed the bounded size.");
  }
  return bytes!;
}

/** player-safe 投影：白名单字段，绝不回显内部 manifest/子命令身份。 */
export function toPlayerSafeWorldCommandResult(
  result: WorldCommandResult,
): PlayerSafeWorldCommandResult {
  if (result.state === "rejected") {
    return {
      commandGroupId: result.commandGroupId,
      state: "rejected",
      records: [],
      rejection: { code: result.code, message: result.message },
    };
  }
  return {
    commandGroupId: result.commandGroupId,
    state: "committed",
    records: result.records.map((record) => ({
      recordId: record.recordId,
      recordVersion: record.finalRecordVersion,
      nextOrdinal: record.nextRecordOrdinal,
      eventCount: record.eventIds.length,
    })),
    worldCursor: { ...result.worldCursor },
    committedAt: result.committedAt,
  };
}

function compareIdentifiers(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(parts: readonly string[]): string {
  return sha256(parts.join("\u0000")).slice(0, 24);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8");
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
