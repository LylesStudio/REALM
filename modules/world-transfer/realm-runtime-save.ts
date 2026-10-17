/**
 * `.realm` runtime-save v2 contract.
 *
 * This is deliberately separate from `.realmworld`: it carries a Record's
 * runtime event/Goal facts plus the WorldBinding needed to restore it. It never
 * treats content files as runtime facts and never installs a RealmWorld.
 */
import { createHash } from "node:crypto";
import { zipSync, type ZipOptions } from "fflate";
import {
  RealmPackError,
  validateStrictZipArchive,
} from "./realm-pack.ts";
import type { JsonValue } from "../runtime/public.ts";
import { decodeRecordGoalDefinition } from "../goals/record-authoring.ts";
import {
  normalizeRealmRuntimeSaveDomainV1,
  parseRealmRuntimeSaveDomainV1,
  serializeRealmRuntimeSaveDomainV1,
  type RealmRuntimeSaveDomainV1,
} from "./realm-runtime-domain-save.ts";

export type RealmRuntimeSaveErrorCode =
  | "INVALID_SAVE"
  | "UNSUPPORTED_FORMAT_VERSION"
  | "RUNTIME_HASH_MISMATCH";

export class RealmRuntimeSaveError extends Error {
  readonly code: RealmRuntimeSaveErrorCode;

  constructor(code: RealmRuntimeSaveErrorCode, message: string) {
    super(message);
    this.name = "RealmRuntimeSaveError";
    this.code = code;
  }
}

export interface RealmRuntimeSaveWorldRef {
  worldId: string;
  worldVersion: string;
}

export interface RealmRuntimeSaveScope {
  workspaceId: string;
  worldlineId: string;
  recordId: string;
}

export interface RealmRuntimeSaveRecordScope {
  worldId: string;
  worldlineId: string;
  recordId: string;
}

export interface RealmRuntimeSaveSnapshot {
  recordVersion: number;
  nextRecordOrdinal: number;
  runtimeHash: string;
}

export type RealmRuntimeSaveMode = "base" | "world-bound";

export interface RealmRuntimeSaveManifestV2 {
  format: "realm-save";
  formatVersion: 2;
  engineApi: string;
  mode: RealmRuntimeSaveMode;
  world: RealmRuntimeSaveWorldRef | null;
  scope: RealmRuntimeSaveScope;
  snapshot: RealmRuntimeSaveSnapshot;
}

export interface RealmRuntimeSaveEventV1 {
  eventId: string;
  recordVersion: number;
  ordinal: number;
  kind: string;
  payload: JsonValue;
}

/** The event kinds accepted by the current PostgreSQL facts plane. */
export type RealmRuntimeSaveRestorableEventKind =
  | "utterance.committed"
  | "narration.committed"
  | "action.transaction.committed"
  | "system.correction.committed"
  | "goal.transition.committed";

/**
 * The stable payload projection emitted by the PostgreSQL runtime reader.
 * Source scene/participant/policy identifiers are metadata only: restore maps
 * them into the newly instantiated Record topology instead of trusting them as
 * foreign keys in the target workspace.
 */
export interface RealmRuntimeSaveRestorableEvent {
  eventId: string;
  recordVersion: number;
  ordinal: number;
  kind: RealmRuntimeSaveRestorableEventKind;
  content: string;
  speakerName: string;
  sourceActorParticipantId: string | null;
  sourceSceneId: string;
  sourceVisibilityPolicyId: string;
  worldTick: number;
  worldOrdinal: number;
  calendarId: string;
  displayTime: string;
  eventPayload: JsonValue;
}

export interface RealmRuntimeSaveRecordV1 {
  format: "realm-runtime-record";
  schemaVersion: 1;
  scope: RealmRuntimeSaveRecordScope;
  head: Pick<RealmRuntimeSaveSnapshot, "recordVersion" | "nextRecordOrdinal">;
  events: readonly RealmRuntimeSaveEventV1[];
}

export interface RealmRuntimeSaveGoalsV1 {
  format: "realm-runtime-goals";
  schemaVersion: 1;
  instances: readonly JsonValue[];
  assessments: readonly JsonValue[];
  definitions?: readonly JsonValue[];
}

/**
 * Durable Action Receipt projection. The receipt payload is carried verbatim
 * (materialized dice/costs/effects are facts); all foreign-key references are
 * exposed as source identifiers that restore must remap into the target
 * Record topology, never trust as target SQL identifiers.
 */
export interface RealmRuntimeSaveActionReceiptV1 {
  sourceReceiptId: string;
  sourceEventId: string;
  sourceActorCharacterInstanceId: string;
  transactionId: string;
  callFingerprint: string;
  receipt: Readonly<Record<string, JsonValue>>;
  worldTick: number;
  worldOrdinal: number;
  recordedAt: string;
}

export interface RealmRuntimeSaveActionReceiptsV1 {
  format: "realm-runtime-action-receipts";
  schemaVersion: 1;
  receipts: readonly RealmRuntimeSaveActionReceiptV1[];
}

export type RealmRuntimeSaveCharacterEffectStatus = "active" | "expired" | "removed";

/**
 * Durable character effect projection. `sourceEffectDefinitionId` is metadata
 * only: effect definitions are World-scoped rule data outside the save, so
 * restore resolves the target definition by `effectKey` inside the target
 * World and fails closed when it is absent.
 */
export interface RealmRuntimeSaveCharacterEffectV1 {
  sourceCharacterEffectId: string;
  sourceCharacterInstanceId: string;
  sourceEffectDefinitionId: string;
  effectKey: string;
  sourceActionReceiptId: string;
  status: RealmRuntimeSaveCharacterEffectStatus;
  appliedTick: number;
  appliedOrdinal: number;
  endedTick: number | null;
  endedOrdinal: number | null;
  revision: number;
  metadata: Readonly<Record<string, JsonValue>>;
}

export interface RealmRuntimeSaveCharacterEffectsV1 {
  format: "realm-runtime-character-effects";
  schemaVersion: 1;
  effects: readonly RealmRuntimeSaveCharacterEffectV1[];
}

export type RealmRuntimeSaveObservationKind = "direct" | "inferred" | "rumor" | "system_grant";

export interface RealmRuntimeSaveObservationV1 {
  sourceObservationId: string;
  sourceObserverCharacterInstanceId: string;
  sourceEventId: string | null;
  dedupeKey: string;
  observationKind: RealmRuntimeSaveObservationKind;
  content: string;
  fidelity: number;
  occurredTick: number;
  occurredOrdinal: number;
  availableFromTick: number;
  availableFromOrdinal: number;
  learnedAt: string;
  metadata: Readonly<Record<string, JsonValue>>;
}

export interface RealmRuntimeSaveObservationsV1 {
  format: "realm-runtime-observations";
  schemaVersion: 1;
  observations: readonly RealmRuntimeSaveObservationV1[];
}

export type RealmRuntimeSaveMemoryOperation = "add" | "update" | "retract";

export type RealmRuntimeSaveMemoryKind =
  | "explicit"
  | "inferred"
  | "summary"
  | "preference"
  | "relationship";

export type RealmRuntimeSaveMemorySnapshotKind = "representation" | "recall";

export type RealmRuntimeSaveRelationshipKind =
  | "trust"
  | "hostile"
  | "alliance"
  | "kinship"
  | "debt"
  | "acquaintance"
  | "note";

/**
 * Durable memory conclusion projection. `semanticEmbedding` is carried as a
 * plain number array (384 finite values in v1) so the archive stays
 * self-describing; restore writes it back verbatim via a vector literal.
 * All foreign-key references are exposed as source identifiers that restore
 * must remap into the target Record/Worldline scope, never trust as target
 * SQL identifiers.
 */
export interface RealmRuntimeSaveMemoryConclusionV1 {
  sourceMemoryId: string;
  sourceObserverContinuityId: string;
  observedEntityKey: string;
  sourceRecordId: string | null;
  sourceObservationId: string | null;
  sourceSupersedesMemoryId: string | null;
  operation: RealmRuntimeSaveMemoryOperation;
  memoryKind: RealmRuntimeSaveMemoryKind;
  content: string;
  keywords: readonly string[];
  semanticEmbedding: readonly number[];
  embeddingModel: string;
  fidelity: number;
  occurredTick: number;
  occurredOrdinal: number;
  availableFromTick: number;
  availableFromOrdinal: number;
  metadata: Readonly<Record<string, JsonValue>>;
}

export interface RealmRuntimeSaveMemorySnapshotV1 {
  sourceSnapshotId: string;
  sourceObserverContinuityId: string;
  snapshotKind: RealmRuntimeSaveMemorySnapshotKind;
  content: string;
  /** Conclusion source ids; restore remaps them inside the target scope. */
  sourceItemIds: readonly string[];
  cursorTick: number;
  cursorOrdinal: number;
  cacheEpoch: number;
  tokenCount: number;
}

export interface RealmRuntimeSaveRelationshipStateV1 {
  sourceObserverContinuityId: string;
  targetEntityKey: string;
  relationKind: RealmRuntimeSaveRelationshipKind;
  content: string;
  fidelity: number;
  sourceRecordId: string | null;
  sourceObservationId: string | null;
  occurredTick: number;
  occurredOrdinal: number;
  availableFromTick: number;
  availableFromOrdinal: number;
}

export interface RealmRuntimeSaveMemoryV1 {
  format: "realm-runtime-memory";
  schemaVersion: 1;
  conclusions: readonly RealmRuntimeSaveMemoryConclusionV1[];
  snapshots: readonly RealmRuntimeSaveMemorySnapshotV1[];
  relationshipStates: readonly RealmRuntimeSaveRelationshipStateV1[];
}

/**
 * Non-terminal Outbox message states carried by a runtime save. `delivered`
 * is a terminal fact (the message already reached its consumers) and is never
 * archived; restore always re-materializes archived messages as fresh
 * `pending` rows so an independent worker can claim them.
 */
export type RealmRuntimeSaveOutboxState = "pending" | "delivering" | "retryable" | "failed";

/**
 * Durable Outbox message projection. `dedupeKey` is the delivery idempotency
 * key and is preserved verbatim; `envelope` is the message payload carried as
 * a JSON object. Lease metadata (`leaseOwner`/`leaseExpiresAt`) and failure
 * details are archived for fidelity but never trusted as restore state:
 * restore drops the lease/fencing token so the message becomes claimable by
 * a fresh worker. `sourceEventId` references an Event inside the saved
 * Record; restore remaps it into the target Record topology and fails closed
 * on any reference outside the save.
 */
export interface RealmRuntimeSaveOutboxMessageV1 {
  sourceMessageId: string;
  dedupeKey: string;
  topic: string;
  envelope: Readonly<Record<string, JsonValue>>;
  state: RealmRuntimeSaveOutboxState;
  deliveryAttempts: number;
  nextAttemptAt: string;
  sourceEventId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastErrorAt: string | null;
}

export interface RealmRuntimeSaveOutboxV1 {
  format: "realm-runtime-outbox";
  schemaVersion: 1;
  messages: readonly RealmRuntimeSaveOutboxMessageV1[];
}

export type RealmRuntimeSaveFirstNightState = "pending" | "ready" | "degraded";

/**
 * Per-Record first-night enrichment state. `entry` is null when the source
 * Record never sealed a first-night state row; restore copies the entry
 * verbatim (state, opening hook, suggestions and the genesis context) into
 * the target Record.
 */
export interface RealmRuntimeSaveFirstNightV1 {
  format: "realm-runtime-first-night";
  schemaVersion: 1;
  entry: {
    state: RealmRuntimeSaveFirstNightState;
    attempts: number;
    hookContent: string;
    suggestions: readonly string[];
    context: Readonly<Record<string, JsonValue>>;
  } | null;
}

export type RealmRuntimeSaveSelfPlayState =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Self-play session ledger projection. In-flight states (`running` /
 * `stopping`) carry no worker lease and are collapsed to the terminal
 * `cancelled` state on restore; terminal states are copied verbatim together
 * with the beat budget / completed beat ledger.
 */
export interface RealmRuntimeSaveSelfPlaySessionV1 {
  sourceSessionId: string;
  state: RealmRuntimeSaveSelfPlayState;
  beatBudget: number;
  beatsCompleted: number;
  requestedBy: string;
  lastError: string | null;
}

export interface RealmRuntimeSaveSelfPlayV1 {
  format: "realm-runtime-self-play";
  schemaVersion: 1;
  sessions: readonly RealmRuntimeSaveSelfPlaySessionV1[];
}

export type RealmRuntimeSaveControllerMode = "human" | "ai" | "hybrid";

export type RealmRuntimeSaveParticipantKind = "character" | "narrator";

export interface RealmRuntimeSaveCharacterV1 {
  sourceCharacterInstanceId: string;
  sourceContinuityId: string;
  sourcePredecessorInstanceId: string | null;
  sourceDefinitionId: string;
  definition: {
    displayName: string;
    sourceFormat: "native" | "sillytavern_character_card";
    profile: Readonly<Record<string, JsonValue>>;
  };
  continuity: {
    continuityKey: string;
    status: "active" | "inactive" | "ended";
    bornTick: number;
    bornOrdinal: number;
    endedTick: number | null;
    endedOrdinal: number | null;
  };
  instance: {
    controllerMode: RealmRuntimeSaveControllerMode;
    status: "planned" | "present" | "absent" | "retired";
    instantiatedTick: number;
    instantiatedOrdinal: number;
    inheritanceCutoffTick: number;
    inheritanceCutoffOrdinal: number;
    retiredTick: number | null;
    retiredOrdinal: number | null;
    state: Readonly<Record<string, JsonValue>>;
  };
}

export interface RealmRuntimeSaveParticipantV1 {
  sourceParticipantId: string;
  participantKind: RealmRuntimeSaveParticipantKind;
  sourcePrincipalId: string | null;
  controllerMode: RealmRuntimeSaveControllerMode;
  isActive: boolean;
  speakingOrder: number;
  sharedControlEnabled: boolean;
  character: RealmRuntimeSaveCharacterV1 | null;
}

export type RealmRuntimeSaveSceneStatus = "planned" | "active" | "closed" | "cancelled";

export interface RealmRuntimeSaveSceneV1 {
  sourceSceneId: string;
  title: string;
  status: RealmRuntimeSaveSceneStatus;
  location: string;
  objective: string;
  tension: string;
  weather: string;
  displayTime: string;
  startTick: number;
  startOrdinal: number;
  endTick: number | null;
  endOrdinal: number | null;
}

export type RealmRuntimeSaveVisibilityPolicyKind =
  | "public"
  | "scene"
  | "restricted"
  | "private"
  | "dm_only";

export interface RealmRuntimeSaveVisibilityPolicyV1 {
  sourceVisibilityPolicyId: string;
  policyKey: string;
  policyVersion: number;
  policyKind: RealmRuntimeSaveVisibilityPolicyKind;
  sourceSceneId: string | null;
  restrictedDomainId: string | null;
  sourcePrivateCharacterInstanceId: string | null;
  sourceAudienceCharacterInstanceIds: readonly string[];
}

export interface RealmRuntimeSaveTopologyV1 {
  format: "realm-runtime-topology";
  schemaVersion: 1;
  participants: readonly RealmRuntimeSaveParticipantV1[];
  scenes: readonly RealmRuntimeSaveSceneV1[];
  visibilityPolicies: readonly RealmRuntimeSaveVisibilityPolicyV1[];
}

export interface RealmRuntimeSaveArchive {
  manifest: RealmRuntimeSaveManifestV2;
  record: RealmRuntimeSaveRecordV1;
  goals: RealmRuntimeSaveGoalsV1;
  /** Optional for reading pre-topology v2 saves; new exports always include it. */
  topology?: RealmRuntimeSaveTopologyV1;
  /** Optional for reading pre-ledger v2 saves; new exports always include them. */
  actionReceipts?: RealmRuntimeSaveActionReceiptsV1;
  characterEffects?: RealmRuntimeSaveCharacterEffectsV1;
  observations?: RealmRuntimeSaveObservationsV1;
  /** Optional for reading pre-memory v2 saves; new exports always include it. */
  memory?: RealmRuntimeSaveMemoryV1;
  /** Optional for reading pre-async-runtime v2 saves; new exports always include them. */
  outbox?: RealmRuntimeSaveOutboxV1;
  firstNight?: RealmRuntimeSaveFirstNightV1;
  selfPlay?: RealmRuntimeSaveSelfPlayV1;
  /** Server-owned Project/Finance, Story Graph, and committed-fact runtime. */
  domain?: RealmRuntimeSaveDomainV1;
}

const MANIFEST_ENTRY = "realm-save-manifest.json" as const;
const RECORD_ENTRY = "runtime/record.json" as const;
const GOALS_ENTRY = "runtime/goals.json" as const;
const TOPOLOGY_ENTRY = "runtime/topology.json" as const;
const ACTION_RECEIPTS_ENTRY = "runtime/action-receipts.json" as const;
const CHARACTER_EFFECTS_ENTRY = "runtime/character-effects.json" as const;
const OBSERVATIONS_ENTRY = "runtime/observations.json" as const;
const MEMORY_ENTRY = "runtime/memory.json" as const;
const OUTBOX_ENTRY = "runtime/outbox.json" as const;
const FIRST_NIGHT_ENTRY = "runtime/first-night.json" as const;
const SELF_PLAY_ENTRY = "runtime/self-play.json" as const;
const DOMAIN_ENTRY = "runtime/domain.json" as const;
const KNOWN_ENTRIES: ReadonlySet<string> = new Set([
  MANIFEST_ENTRY,
  RECORD_ENTRY,
  GOALS_ENTRY,
  TOPOLOGY_ENTRY,
  ACTION_RECEIPTS_ENTRY,
  CHARACTER_EFFECTS_ENTRY,
  OBSERVATIONS_ENTRY,
  MEMORY_ENTRY,
  OUTBOX_ENTRY,
  FIRST_NIGHT_ENTRY,
  SELF_PLAY_ENTRY,
  DOMAIN_ENTRY,
]);
const ARCHIVE_ENTRY_RE = /^(realm-save-manifest\.json|runtime\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)$/;
const SAFE_IDENTITY = /^[A-Za-z0-9._-]+$/;
const SAFE_REFERENCE = /^[A-Za-z0-9._:-]+$/;
const SAFE_EVENT_ID = /^[A-Za-z0-9._:-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENGINE_API = /^1\./;
const MAX_RUNTIME_FILE_BYTES = 64 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `unknown save key ${where}.${key}`);
    }
  }
}

function requireField(value: Record<string, unknown>, key: string, where: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save key ${where}.${key} is required`);
  }
  return value[key];
}

function requireIdentity(value: unknown, where: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || !SAFE_IDENTITY.test(value)
    || value === "."
    || value === ".."
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} is not a safe identity`);
  }
  return value;
}

function requireReference(value: unknown, where: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || !SAFE_REFERENCE.test(value)
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} is not a safe reference`);
  }
  return value;
}

function requireEventId(value: unknown, where: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || !SAFE_EVENT_ID.test(value)
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} is not a safe event id`);
  }
  return value;
}

function requireInteger(value: unknown, where: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function requireHash(value: unknown, where: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be lowercase sha256 hex`);
  }
  return value;
}

function requireMode(value: unknown): RealmRuntimeSaveMode {
  if (value !== "base" && value !== "world-bound") {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save mode must be base|world-bound");
  }
  return value;
}

function normalizeManifest(value: unknown): RealmRuntimeSaveManifestV2 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save manifest must be an object");
  }
  assertExactKeys(
    value,
    ["format", "formatVersion", "engineApi", "mode", "world", "scope", "snapshot"],
    "manifest",
  );
  if (value.format !== "realm-save") {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save manifest format must be realm-save");
  }
  const formatVersion = requireField(value, "formatVersion", "manifest");
  if (!Number.isSafeInteger(formatVersion)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save manifest formatVersion must be an integer");
  }
  const formatVersionNumber = formatVersion as number;
  if (formatVersionNumber > 2) {
    throw new RealmRuntimeSaveError("UNSUPPORTED_FORMAT_VERSION", "save manifest formatVersion is newer than v2");
  }
  if (formatVersionNumber !== 2) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save manifest formatVersion must be 2");
  }
  if (typeof value.engineApi !== "string" || !ENGINE_API.test(value.engineApi)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save manifest engineApi is unsupported");
  }
  const mode = requireMode(value.mode);

  let world: RealmRuntimeSaveWorldRef | null = null;
  if (value.world === null) {
    if (mode === "world-bound") {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "world-bound save must carry a WorldBinding");
    }
  } else {
    if (mode === "base" || !isPlainObject(value.world)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "base save must not carry a WorldBinding");
    }
    assertExactKeys(value.world, ["worldId", "worldVersion"], "manifest.world");
    world = {
      worldId: requireIdentity(requireField(value.world, "worldId", "manifest.world"), "world.worldId"),
      worldVersion: requireIdentity(
        requireField(value.world, "worldVersion", "manifest.world"),
        "world.worldVersion",
      ),
    };
  }

  const scopeRaw = requireField(value, "scope", "manifest");
  if (!isPlainObject(scopeRaw)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save manifest scope must be an object");
  }
  assertExactKeys(scopeRaw, ["workspaceId", "worldlineId", "recordId"], "manifest.scope");
  const scope = {
    workspaceId: requireIdentity(requireField(scopeRaw, "workspaceId", "manifest.scope"), "scope.workspaceId"),
    worldlineId: requireIdentity(requireField(scopeRaw, "worldlineId", "manifest.scope"), "scope.worldlineId"),
    recordId: requireIdentity(requireField(scopeRaw, "recordId", "manifest.scope"), "scope.recordId"),
  };

  const snapshotRaw = requireField(value, "snapshot", "manifest");
  if (!isPlainObject(snapshotRaw)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save manifest snapshot must be an object");
  }
  assertExactKeys(snapshotRaw, ["recordVersion", "nextRecordOrdinal", "runtimeHash"], "manifest.snapshot");
  const snapshot = {
    recordVersion: requireInteger(
      requireField(snapshotRaw, "recordVersion", "manifest.snapshot"),
      "snapshot.recordVersion",
      0,
    ),
    nextRecordOrdinal: requireInteger(
      requireField(snapshotRaw, "nextRecordOrdinal", "manifest.snapshot"),
      "snapshot.nextRecordOrdinal",
      0,
    ),
    runtimeHash: requireHash(
      requireField(snapshotRaw, "runtimeHash", "manifest.snapshot"),
      "snapshot.runtimeHash",
    ),
  };
  return {
    format: "realm-save",
    formatVersion: 2,
    engineApi: value.engineApi,
    mode,
    world,
    scope,
    snapshot,
  };
}

export function serializeRealmRuntimeSaveManifestV2(
  manifest: RealmRuntimeSaveManifestV2,
): string {
  const valid = normalizeManifest(manifest);
  return JSON.stringify({
    format: valid.format,
    formatVersion: valid.formatVersion,
    engineApi: valid.engineApi,
    mode: valid.mode,
    world: valid.world === null
      ? null
      : { worldId: valid.world.worldId, worldVersion: valid.world.worldVersion },
    scope: {
      workspaceId: valid.scope.workspaceId,
      worldlineId: valid.scope.worldlineId,
      recordId: valid.scope.recordId,
    },
    snapshot: {
      recordVersion: valid.snapshot.recordVersion,
      nextRecordOrdinal: valid.snapshot.nextRecordOrdinal,
      runtimeHash: valid.snapshot.runtimeHash,
    },
  });
}

export function parseRealmRuntimeSaveManifestV2(
  input: string | Uint8Array,
): RealmRuntimeSaveManifestV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof input === "string" ? input : Buffer.from(input).toString("utf8"));
  } catch {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save manifest is not valid JSON");
  }
  return normalizeManifest(parsed);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function runtimeEntries(files: ReadonlyMap<string, Uint8Array>): { path: string; bytes: Uint8Array }[] {
  const entries = [...files.entries()].map(([path, bytes]) => ({ path, bytes }));
  if (entries.length === 0 || entries.some(({ path, bytes }) => (
    !/^runtime\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)
    || bytes.byteLength > MAX_RUNTIME_FILE_BYTES
  ))) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime save entries are invalid");
  }
  return entries.sort((left, right) => compareUtf8(left.path, right.path));
}

export function computeRealmRuntimeSaveContentHash(
  files: ReadonlyMap<string, Uint8Array>,
): string {
  const preimage = runtimeEntries(files)
    .map(({ path, bytes }) => `${path}\n${bytes.byteLength}\n${hashBytes(bytes)}\n`)
    .join("");
  return hashBytes(Buffer.from(preimage, "utf8"));
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object).sort(compareUtf8).map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`
  )).join(",")}}`;
}

export function serializeRealmRuntimeSaveRecordV1(record: RealmRuntimeSaveRecordV1): string {
  return canonicalJson(record as unknown as JsonValue);
}

export function serializeRealmRuntimeSaveGoalsV1(goals: RealmRuntimeSaveGoalsV1): string {
  return canonicalJson(validateGoals(goals) as unknown as JsonValue);
}

export function serializeRealmRuntimeSaveActionReceiptsV1(
  section: RealmRuntimeSaveActionReceiptsV1,
): string {
  return canonicalJson(validateActionReceipts(section) as unknown as JsonValue);
}

export function serializeRealmRuntimeSaveCharacterEffectsV1(
  section: RealmRuntimeSaveCharacterEffectsV1,
): string {
  return canonicalJson(validateCharacterEffects(section) as unknown as JsonValue);
}

export function serializeRealmRuntimeSaveObservationsV1(
  section: RealmRuntimeSaveObservationsV1,
): string {
  return canonicalJson(validateObservations(section) as unknown as JsonValue);
}

function validateRecord(value: unknown, manifest: RealmRuntimeSaveManifestV2): RealmRuntimeSaveRecordV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime record must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "scope", "head", "events"], "record");
  if (value.format !== "realm-runtime-record" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime record schema is unsupported");
  }
  const scopeRaw = requireField(value, "scope", "record");
  if (!isPlainObject(scopeRaw)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime record scope is invalid");
  }
  assertExactKeys(scopeRaw, ["worldId", "worldlineId", "recordId"], "record.scope");
  const scope = {
    worldId: requireIdentity(requireField(scopeRaw, "worldId", "record.scope"), "record.scope.worldId"),
    worldlineId: requireIdentity(requireField(scopeRaw, "worldlineId", "record.scope"), "record.scope.worldlineId"),
    recordId: requireIdentity(requireField(scopeRaw, "recordId", "record.scope"), "record.scope.recordId"),
  };
  if (
    scope.worldlineId !== manifest.scope.worldlineId
    || scope.recordId !== manifest.scope.recordId
    || (manifest.world && scope.worldId !== manifest.world.worldId)
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime record scope does not match save manifest");
  }
  const headRaw = requireField(value, "head", "record");
  if (!isPlainObject(headRaw)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime record head is invalid");
  }
  assertExactKeys(headRaw, ["recordVersion", "nextRecordOrdinal"], "record.head");
  const head = {
    recordVersion: requireInteger(requireField(headRaw, "recordVersion", "record.head"), "record.head.recordVersion", 0),
    nextRecordOrdinal: requireInteger(
      requireField(headRaw, "nextRecordOrdinal", "record.head"),
      "record.head.nextRecordOrdinal",
      0,
    ),
  };
  if (
    head.recordVersion !== manifest.snapshot.recordVersion
    || head.nextRecordOrdinal !== manifest.snapshot.nextRecordOrdinal
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime record head does not match save snapshot");
  }
  if (!Array.isArray(value.events)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime record events must be an array");
  }
  const eventIds = new Set<string>();
  const events: RealmRuntimeSaveEventV1[] = [];
  for (const [index, raw] of value.events.entries()) {
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime record event ${index} is invalid`);
    }
    assertExactKeys(raw, ["eventId", "recordVersion", "ordinal", "kind", "payload"], `record.events[${index}]`);
    const eventId = requireEventId(requireField(raw, "eventId", `record.events[${index}]`), `record.events[${index}].eventId`);
    if (eventIds.has(eventId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime record event ids must be unique");
    }
    eventIds.add(eventId);
    const recordVersion = requireInteger(
      requireField(raw, "recordVersion", `record.events[${index}]`),
      `record.events[${index}].recordVersion`,
      0,
    );
    const ordinal = requireInteger(
      requireField(raw, "ordinal", `record.events[${index}]`),
      `record.events[${index}].ordinal`,
      0,
    );
    const kind = requireIdentity(requireField(raw, "kind", `record.events[${index}]`), `record.events[${index}].kind`);
    if (!isJsonValue(raw.payload)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime record event ${index} payload is not JSON`);
    }
    if (recordVersion > head.recordVersion || ordinal >= head.nextRecordOrdinal) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime event is ahead of save head");
    }
    events.push({ eventId, recordVersion, ordinal, kind, payload: raw.payload });
  }
  return {
    format: "realm-runtime-record",
    schemaVersion: 1,
    scope,
    head,
    events,
  };
}

const RESTORABLE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "utterance.committed",
  "narration.committed",
  "action.transaction.committed",
  "system.correction.committed",
  "goal.transition.committed",
]);

/**
 * Validate the PostgreSQL event projection before any restore transaction is
 * opened. This keeps foreign-key identifiers from the source archive as data,
 * never as target SQL identifiers, and rejects old/minimal fixtures that do
 * not contain enough information for a faithful event-row restore.
 */
export function normalizeRealmRuntimeSaveEventForRestore(
  event: RealmRuntimeSaveEventV1,
  index = 0,
): RealmRuntimeSaveRestorableEvent {
  if (!RESTORABLE_EVENT_KINDS.has(event.kind)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} kind is not restorable`);
  }
  if (event.recordVersion <= 0) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} recordVersion must be > 0 for restore`);
  }
  if (!isPlainObject(event.payload)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} payload projection is invalid`);
  }
  assertExactKeys(
    event.payload,
    [
      "content",
      "speakerName",
      "actorParticipantId",
      "sceneId",
      "visibilityPolicyId",
      "worldTick",
      "worldOrdinal",
      "calendarId",
      "displayTime",
      "eventPayload",
    ],
    `record.events[${index}].payload`,
  );
  const content = requireField(event.payload, "content", `record.events[${index}].payload`);
  const speakerName = requireField(event.payload, "speakerName", `record.events[${index}].payload`);
  const actorParticipantId = requireField(event.payload, "actorParticipantId", `record.events[${index}].payload`);
  const sceneId = requireField(event.payload, "sceneId", `record.events[${index}].payload`);
  const visibilityPolicyId = requireField(event.payload, "visibilityPolicyId", `record.events[${index}].payload`);
  const worldTick = requireField(event.payload, "worldTick", `record.events[${index}].payload`);
  const worldOrdinal = requireField(event.payload, "worldOrdinal", `record.events[${index}].payload`);
  const calendarId = requireField(event.payload, "calendarId", `record.events[${index}].payload`);
  const displayTime = requireField(event.payload, "displayTime", `record.events[${index}].payload`);
  const eventPayload = requireField(event.payload, "eventPayload", `record.events[${index}].payload`);
  if (
    typeof content !== "string"
    || typeof speakerName !== "string"
    || (actorParticipantId !== null && typeof actorParticipantId !== "string")
    || typeof calendarId !== "string"
    || typeof displayTime !== "string"
    || typeof sceneId !== "string"
    || typeof visibilityPolicyId !== "string"
    || !isPlainObject(eventPayload)
    || !isJsonValue(eventPayload)
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} payload fields are invalid`);
  }
  if (!calendarId.trim()) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} calendarId is empty`);
  }
  return {
    eventId: event.eventId,
    recordVersion: event.recordVersion,
    ordinal: event.ordinal,
    kind: event.kind as RealmRuntimeSaveRestorableEventKind,
    content,
    speakerName,
    sourceActorParticipantId: actorParticipantId,
    sourceSceneId: requireIdentity(sceneId, `record.events[${index}].payload.sceneId`),
    sourceVisibilityPolicyId: requireIdentity(
      visibilityPolicyId,
      `record.events[${index}].payload.visibilityPolicyId`,
    ),
    worldTick: requireInteger(worldTick, `record.events[${index}].payload.worldTick`, 0),
    worldOrdinal: requireInteger(worldOrdinal, `record.events[${index}].payload.worldOrdinal`, 0),
    calendarId: calendarId.trim(),
    displayTime,
    eventPayload,
  };
}

function validateGoals(value: unknown, expectedScope?: RealmRuntimeSaveRecordScope & {workspaceId:string}): RealmRuntimeSaveGoalsV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime goals must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "instances", "assessments", "definitions"], "goals");
  if (value.format !== "realm-runtime-goals" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime Goal schema is unsupported");
  }
  if (!Array.isArray(value.instances) || !Array.isArray(value.assessments)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime Goal rows must be arrays");
  }
  if (![...value.instances, ...value.assessments].some((row) => !isPlainObject(row) || !isJsonValue(row))) {
    const definitions = validateAuthoredGoalSaveBindings(value,expectedScope);
    return {
      format: "realm-runtime-goals",
      schemaVersion: 1,
      instances: value.instances,
      assessments: value.assessments,
      ...(definitions === undefined ? {} : {definitions}),
    };
  }
  throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime Goal rows must be JSON objects");
}

function validateAuthoredGoalSaveBindings(value: Record<string, unknown>, expectedScope?: RealmRuntimeSaveRecordScope & {workspaceId:string}): readonly JsonValue[] | undefined {
  const fail = (): never => { throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime Goal definition binding is invalid"); };
  if (value.definitions !== undefined && (!Array.isArray(value.definitions) || value.definitions.length > 10000)) fail();
  const definitions = value.definitions as unknown[] | undefined;
  const byId = new Map<string, ReturnType<typeof decodeRecordGoalDefinition>>();
  for (const raw of definitions ?? []) {
    const definition = (()=>{try {return decodeRecordGoalDefinition(raw);} catch {return fail();}})();
    if(expectedScope && (definition.scope.workspaceId !== expectedScope.workspaceId
      || definition.scope.worldId !== expectedScope.worldId || definition.scope.worldlineId !== expectedScope.worldlineId
      || definition.scope.recordId !== expectedScope.recordId)) fail();
    if (byId.has(definition.definitionId)) fail();
    byId.set(definition.definitionId, definition);
  }
  const bound = new Set<string>();
  for (const raw of value.instances as Record<string, unknown>[]) {
    if (raw.definitionSource !== 'record') continue;
    const definition = byId.get(typeof raw.definitionId === 'string' ? raw.definitionId : '');
    if (!definition || bound.has(definition.definitionId)
      || raw.id !== definition.goalInstanceId || raw.goalKey !== definition.goalKey
      || raw.policyVersion !== definition.policyVersion
      || raw.evidenceStartVersion !== definition.activationHead.recordVersion
      || raw.evidenceStartOrdinal !== definition.activationHead.ordinal
      || !['active','completed','failed','settled'].includes(String(raw.state))
      || !['natural','withdrawn','superseded'].includes(String(raw.resolutionKind))
      || (raw.resolutionKind !== 'natural' && raw.state !== 'settled')) return fail();
    bound.add(definition.definitionId);
  }
  if (bound.size !== byId.size) fail();
  for (const definition of byId.values()) {
    if (definition.supersedesDefinitionId === null) continue;
    const previous = byId.get(definition.supersedesDefinitionId);
    if (!previous || previous.goalId !== definition.goalId
      || previous.definitionVersion + 1 !== definition.definitionVersion
      || JSON.stringify(previous.scope) !== JSON.stringify(definition.scope)) fail();
  }
  return definitions as readonly JsonValue[] | undefined;
}

const CONTROLLER_MODES = new Set<RealmRuntimeSaveControllerMode>(["human", "ai", "hybrid"]);
const PARTICIPANT_KINDS = new Set<RealmRuntimeSaveParticipantKind>(["character", "narrator"]);
const CONTINUITY_STATUSES = new Set(["active", "inactive", "ended"]);
const INSTANCE_STATUSES = new Set(["planned", "present", "absent", "retired"]);
const CHARACTER_SOURCE_FORMATS = new Set(["native", "sillytavern_character_card"]);
const SCENE_STATUSES = new Set<RealmRuntimeSaveSceneStatus>(["planned", "active", "closed", "cancelled"]);
const VISIBILITY_POLICY_KINDS = new Set<RealmRuntimeSaveVisibilityPolicyKind>([
  "public",
  "scene",
  "restricted",
  "private",
  "dm_only",
]);
const CHARACTER_EFFECT_STATUSES = new Set<RealmRuntimeSaveCharacterEffectStatus>([
  "active",
  "expired",
  "removed",
]);
const OBSERVATION_KINDS = new Set<RealmRuntimeSaveObservationKind>([
  "direct",
  "inferred",
  "rumor",
  "system_grant",
]);
const MEMORY_OPERATIONS = new Set<RealmRuntimeSaveMemoryOperation>(["add", "update", "retract"]);
const MEMORY_KINDS = new Set<RealmRuntimeSaveMemoryKind>([
  "explicit",
  "inferred",
  "summary",
  "preference",
  "relationship",
]);
const MEMORY_SNAPSHOT_KINDS = new Set<RealmRuntimeSaveMemorySnapshotKind>(["representation", "recall"]);
const RELATIONSHIP_KINDS = new Set<RealmRuntimeSaveRelationshipKind>([
  "trust",
  "hostile",
  "alliance",
  "kinship",
  "debt",
  "acquaintance",
  "note",
]);
const MEMORY_EMBEDDING_DIMENSIONS = 384;

function validateNullableInteger(value: unknown, where: string, minimum: number): number | null {
  if (value === null) return null;
  return requireInteger(value, where, minimum);
}

function requireTimestamp(value: unknown, where: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 64
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} is not a canonical timestamp`);
  }
  return value;
}

function requireFidelity(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be a fidelity in [0, 1]`);
  }
  return value;
}

function requireBoundedText(value: unknown, where: string, maxLength = 4096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be bounded non-empty text`);
  }
  return value;
}

function requireJsonObject(value: unknown, where: string): Readonly<Record<string, JsonValue>> {
  if (!isPlainObject(value) || !isJsonValue(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be a JSON object`);
  }
  return value;
}

function validateActionReceipts(value: unknown): RealmRuntimeSaveActionReceiptsV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime action receipts must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "receipts"], "actionReceipts");
  if (value.format !== "realm-runtime-action-receipts" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime action receipts schema is unsupported");
  }
  if (!Array.isArray(value.receipts)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime action receipts must be an array");
  }
  const receiptIds = new Set<string>();
  const transactionIds = new Set<string>();
  const receipts = value.receipts.map((raw, index) => {
    const where = `actionReceipts.receipts[${index}]`;
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime action receipt ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceReceiptId",
        "sourceEventId",
        "sourceActorCharacterInstanceId",
        "transactionId",
        "callFingerprint",
        "receipt",
        "worldTick",
        "worldOrdinal",
        "recordedAt",
      ],
      where,
    );
    const sourceReceiptId = requireReference(
      requireField(raw, "sourceReceiptId", where),
      `${where}.sourceReceiptId`,
    );
    const sourceEventId = requireEventId(requireField(raw, "sourceEventId", where), `${where}.sourceEventId`);
    const sourceActorCharacterInstanceId = requireIdentity(
      requireField(raw, "sourceActorCharacterInstanceId", where),
      `${where}.sourceActorCharacterInstanceId`,
    );
    const transactionId = requireBoundedText(requireField(raw, "transactionId", where), `${where}.transactionId`, 512);
    const callFingerprint = requireBoundedText(
      requireField(raw, "callFingerprint", where),
      `${where}.callFingerprint`,
    );
    if (receiptIds.has(sourceReceiptId) || transactionIds.has(transactionId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime action receipt identities must be unique");
    }
    receiptIds.add(sourceReceiptId);
    transactionIds.add(transactionId);
    return {
      sourceReceiptId,
      sourceEventId,
      sourceActorCharacterInstanceId,
      transactionId,
      callFingerprint,
      receipt: requireJsonObject(requireField(raw, "receipt", where), `${where}.receipt`),
      worldTick: requireInteger(requireField(raw, "worldTick", where), `${where}.worldTick`, 0),
      worldOrdinal: requireInteger(requireField(raw, "worldOrdinal", where), `${where}.worldOrdinal`, 0),
      recordedAt: requireTimestamp(requireField(raw, "recordedAt", where), `${where}.recordedAt`),
    };
  });
  return { format: "realm-runtime-action-receipts", schemaVersion: 1, receipts };
}

function validateCharacterEffects(value: unknown): RealmRuntimeSaveCharacterEffectsV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime character effects must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "effects"], "characterEffects");
  if (value.format !== "realm-runtime-character-effects" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime character effects schema is unsupported");
  }
  if (!Array.isArray(value.effects)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime character effects must be an array");
  }
  const effectIds = new Set<string>();
  const effects = value.effects.map((raw, index) => {
    const where = `characterEffects.effects[${index}]`;
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime character effect ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceCharacterEffectId",
        "sourceCharacterInstanceId",
        "sourceEffectDefinitionId",
        "effectKey",
        "sourceActionReceiptId",
        "status",
        "appliedTick",
        "appliedOrdinal",
        "endedTick",
        "endedOrdinal",
        "revision",
        "metadata",
      ],
      where,
    );
    const sourceCharacterEffectId = requireReference(
      requireField(raw, "sourceCharacterEffectId", where),
      `${where}.sourceCharacterEffectId`,
    );
    if (effectIds.has(sourceCharacterEffectId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime character effect ids must be unique");
    }
    effectIds.add(sourceCharacterEffectId);
    const status = requireField(raw, "status", where);
    if (typeof status !== "string" || !CHARACTER_EFFECT_STATUSES.has(status as RealmRuntimeSaveCharacterEffectStatus)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime character effect ${index} status is invalid`);
    }
    const appliedTick = requireInteger(requireField(raw, "appliedTick", where), `${where}.appliedTick`, 0);
    const appliedOrdinal = requireInteger(requireField(raw, "appliedOrdinal", where), `${where}.appliedOrdinal`, 0);
    const endedTick = validateNullableInteger(requireField(raw, "endedTick", where), `${where}.endedTick`, 0);
    const endedOrdinal = validateNullableInteger(requireField(raw, "endedOrdinal", where), `${where}.endedOrdinal`, 0);
    if ((endedTick === null) !== (endedOrdinal === null)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime character effect ${index} cursor is incomplete`);
    }
    if (
      endedTick !== null
      && endedOrdinal !== null
      && (endedTick < appliedTick || (endedTick === appliedTick && endedOrdinal < appliedOrdinal))
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime character effect ${index} cursor is inverted`);
    }
    return {
      sourceCharacterEffectId,
      sourceCharacterInstanceId: requireIdentity(
        requireField(raw, "sourceCharacterInstanceId", where),
        `${where}.sourceCharacterInstanceId`,
      ),
      sourceEffectDefinitionId: requireIdentity(
        requireField(raw, "sourceEffectDefinitionId", where),
        `${where}.sourceEffectDefinitionId`,
      ),
      effectKey: requireIdentity(requireField(raw, "effectKey", where), `${where}.effectKey`),
      sourceActionReceiptId: requireReference(
        requireField(raw, "sourceActionReceiptId", where),
        `${where}.sourceActionReceiptId`,
      ),
      status: status as RealmRuntimeSaveCharacterEffectStatus,
      appliedTick,
      appliedOrdinal,
      endedTick,
      endedOrdinal,
      revision: requireInteger(requireField(raw, "revision", where), `${where}.revision`, 0),
      metadata: requireJsonObject(requireField(raw, "metadata", where), `${where}.metadata`),
    };
  });
  return { format: "realm-runtime-character-effects", schemaVersion: 1, effects };
}

function validateObservations(value: unknown): RealmRuntimeSaveObservationsV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime observations must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "observations"], "observations");
  if (value.format !== "realm-runtime-observations" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime observations schema is unsupported");
  }
  if (!Array.isArray(value.observations)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime observations must be an array");
  }
  const observationIds = new Set<string>();
  const dedupeKeys = new Set<string>();
  const observations = value.observations.map((raw, index) => {
    const where = `observations.observations[${index}]`;
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime observation ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceObservationId",
        "sourceObserverCharacterInstanceId",
        "sourceEventId",
        "dedupeKey",
        "observationKind",
        "content",
        "fidelity",
        "occurredTick",
        "occurredOrdinal",
        "availableFromTick",
        "availableFromOrdinal",
        "learnedAt",
        "metadata",
      ],
      where,
    );
    const sourceObservationId = requireReference(
      requireField(raw, "sourceObservationId", where),
      `${where}.sourceObservationId`,
    );
    const sourceObserverCharacterInstanceId = requireIdentity(
      requireField(raw, "sourceObserverCharacterInstanceId", where),
      `${where}.sourceObserverCharacterInstanceId`,
    );
    const dedupeKey = requireReference(requireField(raw, "dedupeKey", where), `${where}.dedupeKey`);
    const sourceEventId = requireField(raw, "sourceEventId", where);
    const observationKind = requireField(raw, "observationKind", where);
    const content = requireField(raw, "content", where);
    if (
      (sourceEventId !== null && typeof sourceEventId !== "string")
      || typeof observationKind !== "string"
      || !OBSERVATION_KINDS.has(observationKind as RealmRuntimeSaveObservationKind)
      || typeof content !== "string"
      || !content.trim()
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime observation ${index} shape is invalid`);
    }
    const dedupeIdentity = `${sourceObserverCharacterInstanceId}${dedupeKey}`;
    if (observationIds.has(sourceObservationId) || dedupeKeys.has(dedupeIdentity)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime observation identities must be unique");
    }
    observationIds.add(sourceObservationId);
    dedupeKeys.add(dedupeIdentity);
    const occurredTick = requireInteger(requireField(raw, "occurredTick", where), `${where}.occurredTick`, 0);
    const occurredOrdinal = requireInteger(
      requireField(raw, "occurredOrdinal", where),
      `${where}.occurredOrdinal`,
      0,
    );
    const availableFromTick = requireInteger(
      requireField(raw, "availableFromTick", where),
      `${where}.availableFromTick`,
      0,
    );
    const availableFromOrdinal = requireInteger(
      requireField(raw, "availableFromOrdinal", where),
      `${where}.availableFromOrdinal`,
      0,
    );
    if (
      availableFromTick < occurredTick
      || (availableFromTick === occurredTick && availableFromOrdinal < occurredOrdinal)
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime observation ${index} availability cursor is inverted`);
    }
    return {
      sourceObservationId,
      sourceObserverCharacterInstanceId,
      sourceEventId: sourceEventId === null
        ? null
        : requireEventId(sourceEventId, `${where}.sourceEventId`),
      dedupeKey,
      observationKind: observationKind as RealmRuntimeSaveObservationKind,
      content,
      fidelity: requireFidelity(requireField(raw, "fidelity", where), `${where}.fidelity`),
      occurredTick,
      occurredOrdinal,
      availableFromTick,
      availableFromOrdinal,
      learnedAt: requireTimestamp(requireField(raw, "learnedAt", where), `${where}.learnedAt`),
      metadata: requireJsonObject(requireField(raw, "metadata", where), `${where}.metadata`),
    };
  });
  return { format: "realm-runtime-observations", schemaVersion: 1, observations };
}

function validateNullableSourceObservation(
  raw: Record<string, unknown>,
  where: string,
): { sourceRecordId: string | null; sourceObservationId: string | null } {
  const sourceRecordIdRaw = requireField(raw, "sourceRecordId", where);
  const sourceObservationIdRaw = requireField(raw, "sourceObservationId", where);
  if ((sourceRecordIdRaw === null) !== (sourceObservationIdRaw === null)) {
    throw new RealmRuntimeSaveError(
      "INVALID_SAVE",
      `save ${where} source record/observation reference is incomplete`,
    );
  }
  if (sourceRecordIdRaw === null) {
    return { sourceRecordId: null, sourceObservationId: null };
  }
  return {
    sourceRecordId: requireIdentity(sourceRecordIdRaw, `${where}.sourceRecordId`),
    sourceObservationId: requireReference(sourceObservationIdRaw, `${where}.sourceObservationId`),
  };
}

function validateMemoryCursor(
  raw: Record<string, unknown>,
  where: string,
): {
  occurredTick: number;
  occurredOrdinal: number;
  availableFromTick: number;
  availableFromOrdinal: number;
} {
  const occurredTick = requireInteger(requireField(raw, "occurredTick", where), `${where}.occurredTick`, 0);
  const occurredOrdinal = requireInteger(
    requireField(raw, "occurredOrdinal", where),
    `${where}.occurredOrdinal`,
    0,
  );
  const availableFromTick = requireInteger(
    requireField(raw, "availableFromTick", where),
    `${where}.availableFromTick`,
    0,
  );
  const availableFromOrdinal = requireInteger(
    requireField(raw, "availableFromOrdinal", where),
    `${where}.availableFromOrdinal`,
    0,
  );
  if (
    availableFromTick < occurredTick
    || (availableFromTick === occurredTick && availableFromOrdinal < occurredOrdinal)
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} availability cursor is inverted`);
  }
  return { occurredTick, occurredOrdinal, availableFromTick, availableFromOrdinal };
}

function validateMemoryEmbedding(value: unknown, where: string): readonly number[] {
  if (
    !Array.isArray(value)
    || value.length !== MEMORY_EMBEDDING_DIMENSIONS
    || value.some((component) => typeof component !== "number" || !Number.isFinite(component))
  ) {
    throw new RealmRuntimeSaveError(
      "INVALID_SAVE",
      `save ${where} must be ${MEMORY_EMBEDDING_DIMENSIONS} finite numbers`,
    );
  }
  return [...value] as number[];
}

function validateMemory(value: unknown): RealmRuntimeSaveMemoryV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime memory must be an object");
  }
  assertExactKeys(
    value,
    ["format", "schemaVersion", "conclusions", "snapshots", "relationshipStates"],
    "memory",
  );
  if (value.format !== "realm-runtime-memory" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime memory schema is unsupported");
  }
  if (
    !Array.isArray(value.conclusions)
    || !Array.isArray(value.snapshots)
    || !Array.isArray(value.relationshipStates)
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime memory sections must be arrays");
  }
  const memoryIds = new Set<string>();
  const conclusions = value.conclusions.map((raw, index) => {
    const where = `memory.conclusions[${index}]`;
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime memory conclusion ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceMemoryId",
        "sourceObserverContinuityId",
        "observedEntityKey",
        "sourceRecordId",
        "sourceObservationId",
        "sourceSupersedesMemoryId",
        "operation",
        "memoryKind",
        "content",
        "keywords",
        "semanticEmbedding",
        "embeddingModel",
        "fidelity",
        "occurredTick",
        "occurredOrdinal",
        "availableFromTick",
        "availableFromOrdinal",
        "metadata",
      ],
      where,
    );
    const sourceMemoryId = requireReference(
      requireField(raw, "sourceMemoryId", where),
      `${where}.sourceMemoryId`,
    );
    if (memoryIds.has(sourceMemoryId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime memory conclusion ids must be unique");
    }
    memoryIds.add(sourceMemoryId);
    const operation = requireField(raw, "operation", where);
    const memoryKind = requireField(raw, "memoryKind", where);
    const content = requireField(raw, "content", where);
    if (
      typeof operation !== "string"
      || !MEMORY_OPERATIONS.has(operation as RealmRuntimeSaveMemoryOperation)
      || typeof memoryKind !== "string"
      || !MEMORY_KINDS.has(memoryKind as RealmRuntimeSaveMemoryKind)
      || typeof content !== "string"
      || !content.trim()
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime memory conclusion ${index} shape is invalid`);
    }
    const supersedesRaw = requireField(raw, "sourceSupersedesMemoryId", where);
    if ((operation === "add") !== (supersedesRaw === null)) {
      throw new RealmRuntimeSaveError(
        "INVALID_SAVE",
        `runtime memory conclusion ${index} revision shape is invalid`,
      );
    }
    const keywordsRaw = requireField(raw, "keywords", where);
    if (!Array.isArray(keywordsRaw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where}.keywords must be an array`);
    }
    const source = validateNullableSourceObservation(raw, where);
    return {
      sourceMemoryId,
      sourceObserverContinuityId: requireIdentity(
        requireField(raw, "sourceObserverContinuityId", where),
        `${where}.sourceObserverContinuityId`,
      ),
      observedEntityKey: requireBoundedText(
        requireField(raw, "observedEntityKey", where),
        `${where}.observedEntityKey`,
        512,
      ),
      ...source,
      sourceSupersedesMemoryId: supersedesRaw === null
        ? null
        : requireReference(supersedesRaw, `${where}.sourceSupersedesMemoryId`),
      operation: operation as RealmRuntimeSaveMemoryOperation,
      memoryKind: memoryKind as RealmRuntimeSaveMemoryKind,
      content,
      keywords: keywordsRaw.map((keyword, keywordIndex) => requireBoundedText(
        keyword,
        `${where}.keywords[${keywordIndex}]`,
        256,
      )),
      semanticEmbedding: validateMemoryEmbedding(
        requireField(raw, "semanticEmbedding", where),
        `${where}.semanticEmbedding`,
      ),
      embeddingModel: requireBoundedText(
        requireField(raw, "embeddingModel", where),
        `${where}.embeddingModel`,
        256,
      ),
      fidelity: requireFidelity(requireField(raw, "fidelity", where), `${where}.fidelity`),
      ...validateMemoryCursor(raw, where),
      metadata: requireJsonObject(requireField(raw, "metadata", where), `${where}.metadata`),
    };
  });
  for (const conclusion of conclusions) {
    if (
      conclusion.sourceSupersedesMemoryId !== null
      && !memoryIds.has(conclusion.sourceSupersedesMemoryId)
    ) {
      throw new RealmRuntimeSaveError(
        "INVALID_SAVE",
        "runtime memory conclusion supersedes an unsaved conclusion",
      );
    }
  }
  // 修订链必须无环（append-only 存储里 supersedes 指向既有结论）。
  const supersedesById = new Map(
    conclusions.map((conclusion) => [conclusion.sourceMemoryId, conclusion.sourceSupersedesMemoryId]),
  );
  for (const conclusion of conclusions) {
    const seen = new Set<string>([conclusion.sourceMemoryId]);
    let cursor = conclusion.sourceSupersedesMemoryId;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime memory supersedes chain is cyclic");
      }
      seen.add(cursor);
      cursor = supersedesById.get(cursor) ?? null;
    }
  }
  const snapshotIds = new Set<string>();
  const snapshots = value.snapshots.map((raw, index) => {
    const where = `memory.snapshots[${index}]`;
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime memory snapshot ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceSnapshotId",
        "sourceObserverContinuityId",
        "snapshotKind",
        "content",
        "sourceItemIds",
        "cursorTick",
        "cursorOrdinal",
        "cacheEpoch",
        "tokenCount",
      ],
      where,
    );
    const sourceSnapshotId = requireReference(
      requireField(raw, "sourceSnapshotId", where),
      `${where}.sourceSnapshotId`,
    );
    if (snapshotIds.has(sourceSnapshotId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime memory snapshot ids must be unique");
    }
    snapshotIds.add(sourceSnapshotId);
    const snapshotKind = requireField(raw, "snapshotKind", where);
    const content = requireField(raw, "content", where);
    if (
      typeof snapshotKind !== "string"
      || !MEMORY_SNAPSHOT_KINDS.has(snapshotKind as RealmRuntimeSaveMemorySnapshotKind)
      || typeof content !== "string"
      || !content.trim()
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime memory snapshot ${index} shape is invalid`);
    }
    const sourceItemIdsRaw = requireField(raw, "sourceItemIds", where);
    if (!Array.isArray(sourceItemIdsRaw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where}.sourceItemIds must be an array`);
    }
    const sourceItemIds = sourceItemIdsRaw.map((item, itemIndex) => requireReference(
      item,
      `${where}.sourceItemIds[${itemIndex}]`,
    ));
    for (const itemId of sourceItemIds) {
      if (!memoryIds.has(itemId)) {
        throw new RealmRuntimeSaveError(
          "INVALID_SAVE",
          "runtime memory snapshot references an unsaved conclusion",
        );
      }
    }
    return {
      sourceSnapshotId,
      sourceObserverContinuityId: requireIdentity(
        requireField(raw, "sourceObserverContinuityId", where),
        `${where}.sourceObserverContinuityId`,
      ),
      snapshotKind: snapshotKind as RealmRuntimeSaveMemorySnapshotKind,
      content,
      sourceItemIds,
      cursorTick: requireInteger(requireField(raw, "cursorTick", where), `${where}.cursorTick`, 0),
      cursorOrdinal: requireInteger(requireField(raw, "cursorOrdinal", where), `${where}.cursorOrdinal`, 0),
      cacheEpoch: requireInteger(requireField(raw, "cacheEpoch", where), `${where}.cacheEpoch`, 0),
      tokenCount: requireInteger(requireField(raw, "tokenCount", where), `${where}.tokenCount`, 0),
    };
  });
  const relationshipKeys = new Set<string>();
  const relationshipStates = value.relationshipStates.map((raw, index) => {
    const where = `memory.relationshipStates[${index}]`;
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime relationship state ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceObserverContinuityId",
        "targetEntityKey",
        "relationKind",
        "content",
        "fidelity",
        "sourceRecordId",
        "sourceObservationId",
        "occurredTick",
        "occurredOrdinal",
        "availableFromTick",
        "availableFromOrdinal",
      ],
      where,
    );
    const sourceObserverContinuityId = requireIdentity(
      requireField(raw, "sourceObserverContinuityId", where),
      `${where}.sourceObserverContinuityId`,
    );
    const targetEntityKey = requireBoundedText(
      requireField(raw, "targetEntityKey", where),
      `${where}.targetEntityKey`,
      512,
    );
    const relationKind = requireField(raw, "relationKind", where);
    const content = requireField(raw, "content", where);
    if (
      typeof relationKind !== "string"
      || !RELATIONSHIP_KINDS.has(relationKind as RealmRuntimeSaveRelationshipKind)
      || typeof content !== "string"
      || !content.trim()
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime relationship state ${index} shape is invalid`);
    }
    const identity = `${sourceObserverContinuityId} ${targetEntityKey} ${relationKind}`;
    if (relationshipKeys.has(identity)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime relationship state identities must be unique");
    }
    relationshipKeys.add(identity);
    return {
      sourceObserverContinuityId,
      targetEntityKey,
      relationKind: relationKind as RealmRuntimeSaveRelationshipKind,
      content,
      fidelity: requireFidelity(requireField(raw, "fidelity", where), `${where}.fidelity`),
      ...validateNullableSourceObservation(raw, where),
      ...validateMemoryCursor(raw, where),
    };
  });
  return {
    format: "realm-runtime-memory",
    schemaVersion: 1,
    conclusions,
    snapshots,
    relationshipStates,
  };
}

/**
 * Cross-section reference gate: every memory row must stay inside the saved
 * Record — observer continuities come from the saved topology, source
 * record/observation references resolve inside the saved Record and its
 * observation section. Cross-Record or dangling references are rejected
 * instead of being trusted as target foreign keys.
 */
function validateMemoryReferences(
  memory: RealmRuntimeSaveMemoryV1,
  context: {
    record: RealmRuntimeSaveRecordV1;
    topology?: RealmRuntimeSaveTopologyV1;
    observations?: RealmRuntimeSaveObservationsV1;
  },
): void {
  if (
    memory.conclusions.length === 0
    && memory.snapshots.length === 0
    && memory.relationshipStates.length === 0
  ) {
    return;
  }
  const continuityIds = new Set(
    (context.topology?.participants ?? []).flatMap((participant) => (
      participant.character ? [participant.character.sourceContinuityId] : []
    )),
  );
  const observationIds = new Set(
    (context.observations?.observations ?? []).map((observation) => observation.sourceObservationId),
  );
  const checkSource = (
    source: { sourceRecordId: string | null; sourceObservationId: string | null },
    where: string,
  ): void => {
    if (source.sourceRecordId === null) return;
    if (source.sourceRecordId !== context.record.scope.recordId) {
      throw new RealmRuntimeSaveError(
        "INVALID_SAVE",
        `runtime memory ${where} references a source Record outside the save`,
      );
    }
    if (!observationIds.has(source.sourceObservationId!)) {
      throw new RealmRuntimeSaveError(
        "INVALID_SAVE",
        `runtime memory ${where} references an unsaved source observation`,
      );
    }
  };
  for (const [index, conclusion] of memory.conclusions.entries()) {
    if (!continuityIds.has(conclusion.sourceObserverContinuityId)) {
      throw new RealmRuntimeSaveError(
        "INVALID_SAVE",
        `runtime memory conclusions[${index}] observer continuity is outside the saved topology`,
      );
    }
    checkSource(conclusion, `conclusions[${index}]`);
  }
  for (const [index, snapshot] of memory.snapshots.entries()) {
    if (!continuityIds.has(snapshot.sourceObserverContinuityId)) {
      throw new RealmRuntimeSaveError(
        "INVALID_SAVE",
        `runtime memory snapshots[${index}] observer continuity is outside the saved topology`,
      );
    }
  }
  for (const [index, state] of memory.relationshipStates.entries()) {
    if (!continuityIds.has(state.sourceObserverContinuityId)) {
      throw new RealmRuntimeSaveError(
        "INVALID_SAVE",
        `runtime memory relationshipStates[${index}] observer continuity is outside the saved topology`,
      );
    }
    checkSource(state, `relationshipStates[${index}]`);
  }
}

export function serializeRealmRuntimeSaveMemoryV1(
  section: RealmRuntimeSaveMemoryV1,
): string {
  return canonicalJson(validateMemory(section) as unknown as JsonValue);
}

function requireTrimmedText(value: unknown, where: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be bounded trimmed text`);
  }
  return value;
}

function validateNullableTimestamp(value: unknown, where: string): string | null {
  if (value === null) return null;
  return requireTimestamp(value, where);
}

const OUTBOX_STATES: ReadonlySet<string> = new Set(["pending", "delivering", "retryable", "failed"]);

function validateOutbox(value: unknown): RealmRuntimeSaveOutboxV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime outbox must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "messages"], "outbox");
  if (value.format !== "realm-runtime-outbox" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime outbox schema is unsupported");
  }
  const messagesRaw = requireField(value, "messages", "outbox");
  if (!Array.isArray(messagesRaw)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime outbox messages must be an array");
  }
  const seenMessageIds = new Set<string>();
  const seenDedupeKeys = new Set<string>();
  const messages = messagesRaw.map((raw, index) => {
    const where = `outbox.messages[${index}]`;
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be an object`);
    }
    assertExactKeys(
      raw,
      [
        "sourceMessageId", "dedupeKey", "topic", "envelope", "state",
        "deliveryAttempts", "nextAttemptAt", "sourceEventId",
        "leaseOwner", "leaseExpiresAt",
        "lastErrorCode", "lastErrorMessage", "lastErrorAt",
      ],
      where,
    );
    const sourceMessageId = requireReference(
      requireField(raw, "sourceMessageId", where), `${where}.sourceMessageId`,
    );
    if (seenMessageIds.has(sourceMessageId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where}.sourceMessageId is duplicated`);
    }
    seenMessageIds.add(sourceMessageId);
    const dedupeKey = requireTrimmedText(
      requireField(raw, "dedupeKey", where), `${where}.dedupeKey`, 512,
    );
    if (seenDedupeKeys.has(dedupeKey)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where}.dedupeKey is duplicated`);
    }
    seenDedupeKeys.add(dedupeKey);
    const topic = requireTrimmedText(requireField(raw, "topic", where), `${where}.topic`, 256);
    const envelope = requireJsonObject(requireField(raw, "envelope", where), `${where}.envelope`);
    const stateRaw = requireField(raw, "state", where);
    if (typeof stateRaw !== "string" || !OUTBOX_STATES.has(stateRaw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where}.state is not a saved Outbox state`);
    }
    const state = stateRaw as RealmRuntimeSaveOutboxState;
    const deliveryAttempts = requireInteger(
      requireField(raw, "deliveryAttempts", where), `${where}.deliveryAttempts`, 0,
    );
    const nextAttemptAt = requireTimestamp(
      requireField(raw, "nextAttemptAt", where), `${where}.nextAttemptAt`,
    );
    const sourceEventIdRaw = requireField(raw, "sourceEventId", where);
    const sourceEventId = sourceEventIdRaw === null
      ? null
      : requireEventId(sourceEventIdRaw, `${where}.sourceEventId`);
    const leaseOwnerRaw = requireField(raw, "leaseOwner", where);
    const leaseOwner = leaseOwnerRaw === null
      ? null
      : requireTrimmedText(leaseOwnerRaw, `${where}.leaseOwner`, 256);
    const leaseExpiresAt = validateNullableTimestamp(
      requireField(raw, "leaseExpiresAt", where), `${where}.leaseExpiresAt`,
    );
    if (state === "delivering" && (leaseOwner === null || leaseExpiresAt === null)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} delivering message lacks a lease`);
    }
    if (state !== "delivering" && (leaseOwner !== null || leaseExpiresAt !== null)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} non-delivering message carries a lease`);
    }
    const lastErrorCodeRaw = requireField(raw, "lastErrorCode", where);
    const lastErrorCode = lastErrorCodeRaw === null
      ? null
      : requireTrimmedText(lastErrorCodeRaw, `${where}.lastErrorCode`, 128);
    const lastErrorMessageRaw = requireField(raw, "lastErrorMessage", where);
    const lastErrorMessage = lastErrorMessageRaw === null
      ? null
      : requireTrimmedText(lastErrorMessageRaw, `${where}.lastErrorMessage`, 4096);
    const lastErrorAt = validateNullableTimestamp(
      requireField(raw, "lastErrorAt", where), `${where}.lastErrorAt`,
    );
    const errorCount = [lastErrorCode, lastErrorMessage, lastErrorAt]
      .filter((field) => field !== null).length;
    if (state === "pending" && errorCount !== 0) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} pending message carries a failure`);
    }
    if ((state === "retryable" || state === "failed") && errorCount !== 3) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} ${state} message lacks failure details`);
    }
    if (state === "delivering" && errorCount !== 0 && errorCount !== 3) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} delivering message failure shape is invalid`);
    }
    return {
      sourceMessageId,
      dedupeKey,
      topic,
      envelope,
      state,
      deliveryAttempts,
      nextAttemptAt,
      sourceEventId,
      leaseOwner,
      leaseExpiresAt,
      lastErrorCode,
      lastErrorMessage,
      lastErrorAt,
    };
  });
  return { format: "realm-runtime-outbox", schemaVersion: 1, messages };
}

function validateOutboxReferences(
  outbox: RealmRuntimeSaveOutboxV1,
  record: RealmRuntimeSaveRecordV1,
): void {
  const eventIds = new Set(record.events.map((event) => event.eventId));
  for (const [index, message] of outbox.messages.entries()) {
    if (message.sourceEventId !== null && !eventIds.has(message.sourceEventId)) {
      throw new RealmRuntimeSaveError(
        "INVALID_SAVE",
        `runtime outbox messages[${index}] references an Event outside the saved Record`,
      );
    }
  }
}

export function serializeRealmRuntimeSaveOutboxV1(
  section: RealmRuntimeSaveOutboxV1,
): string {
  return canonicalJson(validateOutbox(section) as unknown as JsonValue);
}

const FIRST_NIGHT_STATES: ReadonlySet<string> = new Set(["pending", "ready", "degraded"]);
const MAX_FIRST_NIGHT_SUGGESTIONS = 32;

function validateFirstNight(value: unknown): RealmRuntimeSaveFirstNightV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime first-night must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "entry"], "firstNight");
  if (value.format !== "realm-runtime-first-night" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime first-night schema is unsupported");
  }
  const entryRaw = requireField(value, "entry", "firstNight");
  if (entryRaw === null) {
    return { format: "realm-runtime-first-night", schemaVersion: 1, entry: null };
  }
  if (!isPlainObject(entryRaw)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime first-night entry must be an object");
  }
  assertExactKeys(
    entryRaw,
    ["state", "attempts", "hookContent", "suggestions", "context"],
    "firstNight.entry",
  );
  const stateRaw = requireField(entryRaw, "state", "firstNight.entry");
  if (typeof stateRaw !== "string" || !FIRST_NIGHT_STATES.has(stateRaw)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save firstNight.entry.state is not a first-night state");
  }
  const attempts = requireInteger(
    requireField(entryRaw, "attempts", "firstNight.entry"), "firstNight.entry.attempts", 0,
  );
  const hookContentRaw = requireField(entryRaw, "hookContent", "firstNight.entry");
  if (typeof hookContentRaw !== "string" || hookContentRaw.length > 8192) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save firstNight.entry.hookContent must be bounded text");
  }
  const suggestionsRaw = requireField(entryRaw, "suggestions", "firstNight.entry");
  if (!Array.isArray(suggestionsRaw) || suggestionsRaw.length > MAX_FIRST_NIGHT_SUGGESTIONS) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "save firstNight.entry.suggestions must be a bounded array");
  }
  const suggestions = suggestionsRaw.map((suggestion, index) => requireTrimmedText(
    suggestion, `firstNight.entry.suggestions[${index}]`, 512,
  ));
  const context = requireJsonObject(
    requireField(entryRaw, "context", "firstNight.entry"), "firstNight.entry.context",
  );
  return {
    format: "realm-runtime-first-night",
    schemaVersion: 1,
    entry: {
      state: stateRaw as RealmRuntimeSaveFirstNightState,
      attempts,
      hookContent: hookContentRaw,
      suggestions,
      context,
    },
  };
}

export function serializeRealmRuntimeSaveFirstNightV1(
  section: RealmRuntimeSaveFirstNightV1,
): string {
  return canonicalJson(validateFirstNight(section) as unknown as JsonValue);
}

const SELF_PLAY_STATES: ReadonlySet<string> = new Set([
  "running", "stopping", "completed", "failed", "cancelled",
]);

function validateSelfPlay(value: unknown): RealmRuntimeSaveSelfPlayV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime self-play must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "sessions"], "selfPlay");
  if (value.format !== "realm-runtime-self-play" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime self-play schema is unsupported");
  }
  const sessionsRaw = requireField(value, "sessions", "selfPlay");
  if (!Array.isArray(sessionsRaw)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime self-play sessions must be an array");
  }
  const seenSessionIds = new Set<string>();
  const sessions = sessionsRaw.map((raw, index) => {
    const where = `selfPlay.sessions[${index}]`;
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where} must be an object`);
    }
    assertExactKeys(
      raw,
      ["sourceSessionId", "state", "beatBudget", "beatsCompleted", "requestedBy", "lastError"],
      where,
    );
    const sourceSessionId = requireReference(
      requireField(raw, "sourceSessionId", where), `${where}.sourceSessionId`,
    );
    if (seenSessionIds.has(sourceSessionId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where}.sourceSessionId is duplicated`);
    }
    seenSessionIds.add(sourceSessionId);
    const stateRaw = requireField(raw, "state", where);
    if (typeof stateRaw !== "string" || !SELF_PLAY_STATES.has(stateRaw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where}.state is not a self-play state`);
    }
    const beatBudget = requireInteger(
      requireField(raw, "beatBudget", where), `${where}.beatBudget`, 1,
    );
    const beatsCompleted = requireInteger(
      requireField(raw, "beatsCompleted", where), `${where}.beatsCompleted`, 0,
    );
    if (beatsCompleted > beatBudget) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `save ${where}.beatsCompleted exceeds the beat budget`);
    }
    const requestedBy = requireTrimmedText(
      requireField(raw, "requestedBy", where), `${where}.requestedBy`, 256,
    );
    const lastErrorRaw = requireField(raw, "lastError", where);
    const lastError = lastErrorRaw === null
      ? null
      : requireTrimmedText(lastErrorRaw, `${where}.lastError`, 4096);
    return {
      sourceSessionId,
      state: stateRaw as RealmRuntimeSaveSelfPlayState,
      beatBudget,
      beatsCompleted,
      requestedBy,
      lastError,
    };
  });
  return { format: "realm-runtime-self-play", schemaVersion: 1, sessions };
}

export function serializeRealmRuntimeSaveSelfPlayV1(
  section: RealmRuntimeSaveSelfPlayV1,
): string {
  return canonicalJson(validateSelfPlay(section) as unknown as JsonValue);
}

function validateScenes(value: unknown): RealmRuntimeSaveSceneV1[] {
  if (!Array.isArray(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology scenes must be an array");
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime topology scene ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceSceneId",
        "title",
        "status",
        "location",
        "objective",
        "tension",
        "weather",
        "displayTime",
        "startTick",
        "startOrdinal",
        "endTick",
        "endOrdinal",
      ],
      `topology.scenes[${index}]`,
    );
    const sourceSceneId = requireIdentity(
      requireField(raw, "sourceSceneId", `topology.scenes[${index}]`),
      `topology.scenes[${index}].sourceSceneId`,
    );
    if (ids.has(sourceSceneId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology scene ids must be unique");
    }
    ids.add(sourceSceneId);
    const title = requireField(raw, "title", `topology.scenes[${index}]`);
    const status = requireField(raw, "status", `topology.scenes[${index}]`);
    const location = requireField(raw, "location", `topology.scenes[${index}]`);
    const objective = requireField(raw, "objective", `topology.scenes[${index}]`);
    const tension = requireField(raw, "tension", `topology.scenes[${index}]`);
    const weather = requireField(raw, "weather", `topology.scenes[${index}]`);
    const displayTime = requireField(raw, "displayTime", `topology.scenes[${index}]`);
    if (
      typeof title !== "string"
      || typeof status !== "string"
      || !SCENE_STATUSES.has(status as RealmRuntimeSaveSceneStatus)
      || typeof location !== "string"
      || typeof objective !== "string"
      || typeof tension !== "string"
      || typeof weather !== "string"
      || typeof displayTime !== "string"
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime topology scene ${index} shape is invalid`);
    }
    const startTick = requireInteger(
      requireField(raw, "startTick", `topology.scenes[${index}]`),
      `topology.scenes[${index}].startTick`,
      0,
    );
    const startOrdinal = requireInteger(
      requireField(raw, "startOrdinal", `topology.scenes[${index}]`),
      `topology.scenes[${index}].startOrdinal`,
      0,
    );
    const endTick = validateNullableInteger(
      requireField(raw, "endTick", `topology.scenes[${index}]`),
      `topology.scenes[${index}].endTick`,
      0,
    );
    const endOrdinal = validateNullableInteger(
      requireField(raw, "endOrdinal", `topology.scenes[${index}]`),
      `topology.scenes[${index}].endOrdinal`,
      0,
    );
    if ((endTick === null) !== (endOrdinal === null)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology scene cursor is incomplete");
    }
    if (endTick !== null && (endTick < startTick || (endTick === startTick && endOrdinal! < startOrdinal))) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology scene ends before it starts");
    }
    return {
      sourceSceneId,
      title,
      status: status as RealmRuntimeSaveSceneStatus,
      location,
      objective,
      tension,
      weather,
      displayTime,
      startTick,
      startOrdinal,
      endTick,
      endOrdinal,
    };
  });
}

function validateVisibilityPolicies(
  value: unknown,
  sceneIds: ReadonlySet<string>,
  characterInstanceIds: ReadonlySet<string>,
): RealmRuntimeSaveVisibilityPolicyV1[] {
  if (!Array.isArray(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology visibility policies must be an array");
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  return value.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime topology visibility policy ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceVisibilityPolicyId",
        "policyKey",
        "policyVersion",
        "policyKind",
        "sourceSceneId",
        "restrictedDomainId",
        "sourcePrivateCharacterInstanceId",
        "sourceAudienceCharacterInstanceIds",
      ],
      `topology.visibilityPolicies[${index}]`,
    );
    const sourceVisibilityPolicyId = requireIdentity(
      requireField(raw, "sourceVisibilityPolicyId", `topology.visibilityPolicies[${index}]`),
      `topology.visibilityPolicies[${index}].sourceVisibilityPolicyId`,
    );
    if (ids.has(sourceVisibilityPolicyId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology visibility policy ids must be unique");
    }
    ids.add(sourceVisibilityPolicyId);
    const policyKey = requireField(raw, "policyKey", `topology.visibilityPolicies[${index}]`);
    const policyKind = requireField(raw, "policyKind", `topology.visibilityPolicies[${index}]`);
    if (
      typeof policyKey !== "string"
      || !policyKey.trim()
      || typeof policyKind !== "string"
      || !VISIBILITY_POLICY_KINDS.has(policyKind as RealmRuntimeSaveVisibilityPolicyKind)
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime topology visibility policy ${index} shape is invalid`);
    }
    const policyVersion = requireInteger(
      requireField(raw, "policyVersion", `topology.visibilityPolicies[${index}]`),
      `topology.visibilityPolicies[${index}].policyVersion`,
      1,
    );
    const policyIdentity = `${policyKey}\u0000${policyVersion}`;
    if (keys.has(policyIdentity)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime visibility policy key/version pairs must be unique");
    }
    keys.add(policyIdentity);
    const sourceSceneValue = requireField(raw, "sourceSceneId", `topology.visibilityPolicies[${index}]`);
    const sourceSceneId = sourceSceneValue === null
      ? null
      : requireIdentity(sourceSceneValue, `topology.visibilityPolicies[${index}].sourceSceneId`);
    const restrictedDomainValue = requireField(raw, "restrictedDomainId", `topology.visibilityPolicies[${index}]`);
    const restrictedDomainId = restrictedDomainValue === null
      ? null
      : requireReference(restrictedDomainValue, `topology.visibilityPolicies[${index}].restrictedDomainId`);
    const sourcePrivateValue = requireField(
      raw,
      "sourcePrivateCharacterInstanceId",
      `topology.visibilityPolicies[${index}]`,
    );
    const sourcePrivateCharacterInstanceId = sourcePrivateValue === null
      ? null
      : requireIdentity(sourcePrivateValue, `topology.visibilityPolicies[${index}].sourcePrivateCharacterInstanceId`);
    const audienceValue = requireField(
      raw,
      "sourceAudienceCharacterInstanceIds",
      `topology.visibilityPolicies[${index}]`,
    );
    if (!Array.isArray(audienceValue)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime topology visibility policy ${index} audience is invalid`);
    }
    const sourceAudienceCharacterInstanceIds = audienceValue.map((item, audienceIndex) =>
      requireIdentity(
        item,
        `topology.visibilityPolicies[${index}].sourceAudienceCharacterInstanceIds[${audienceIndex}]`,
      )
    );
    if (new Set(sourceAudienceCharacterInstanceIds).size !== sourceAudienceCharacterInstanceIds.length) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime visibility policy audience ids must be unique");
    }
    const kind = policyKind as RealmRuntimeSaveVisibilityPolicyKind;
    const validShape = (
      (kind === "public" || kind === "dm_only")
      && sourceSceneId === null
      && restrictedDomainId === null
      && sourcePrivateCharacterInstanceId === null
      && sourceAudienceCharacterInstanceIds.length === 0
    ) || (
      kind === "scene"
      && sourceSceneId !== null
      && restrictedDomainId === null
      && sourcePrivateCharacterInstanceId === null
    ) || (
      kind === "restricted"
      && sourceSceneId === null
      && restrictedDomainId !== null
      && sourcePrivateCharacterInstanceId === null
      && sourceAudienceCharacterInstanceIds.length > 0
    ) || (
      kind === "private"
      && sourceSceneId === null
      && restrictedDomainId === null
      && sourcePrivateCharacterInstanceId !== null
      && sourceAudienceCharacterInstanceIds.length === 0
    );
    if (!validShape) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime topology visibility policy ${index} shape is invalid`);
    }
    if (sourceSceneId !== null && !sceneIds.has(sourceSceneId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime visibility policy references an unknown scene");
    }
    if (
      (sourcePrivateCharacterInstanceId !== null && !characterInstanceIds.has(sourcePrivateCharacterInstanceId))
      || sourceAudienceCharacterInstanceIds.some((id) => !characterInstanceIds.has(id))
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime visibility policy references an unknown character");
    }
    return {
      sourceVisibilityPolicyId,
      policyKey,
      policyVersion,
      policyKind: kind,
      sourceSceneId,
      restrictedDomainId,
      sourcePrivateCharacterInstanceId,
      sourceAudienceCharacterInstanceIds,
    };
  });
}

function validateTopology(value: unknown): RealmRuntimeSaveTopologyV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "participants", "scenes", "visibilityPolicies"], "topology");
  if (value.format !== "realm-runtime-topology" || value.schemaVersion !== 1) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology schema is unsupported");
  }
  if (!Array.isArray(value.participants)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology participants must be an array");
  }
  const participantIds = new Set<string>();
  const characterIds = new Set<string>();
  const continuityIds = new Set<string>();
  const participants: RealmRuntimeSaveParticipantV1[] = [];
  for (const [index, raw] of value.participants.entries()) {
    if (!isPlainObject(raw)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime topology participant ${index} is invalid`);
    }
    assertExactKeys(
      raw,
      [
        "sourceParticipantId",
        "participantKind",
        "sourcePrincipalId",
        "controllerMode",
        "isActive",
        "speakingOrder",
        "sharedControlEnabled",
        "character",
      ],
      `topology.participants[${index}]`,
    );
    const sourceParticipantId = requireIdentity(
      requireField(raw, "sourceParticipantId", `topology.participants[${index}]`),
      `topology.participants[${index}].sourceParticipantId`,
    );
    if (participantIds.has(sourceParticipantId)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology participant ids must be unique");
    }
    participantIds.add(sourceParticipantId);
    const participantKind = requireField(raw, "participantKind", `topology.participants[${index}]`);
    const controllerMode = requireField(raw, "controllerMode", `topology.participants[${index}]`);
    const sourcePrincipalId = requireField(raw, "sourcePrincipalId", `topology.participants[${index}]`);
    const isActive = requireField(raw, "isActive", `topology.participants[${index}]`);
    const sharedControlEnabled = requireField(raw, "sharedControlEnabled", `topology.participants[${index}]`);
    if (
      typeof participantKind !== "string"
      || !PARTICIPANT_KINDS.has(participantKind as RealmRuntimeSaveParticipantKind)
      || typeof controllerMode !== "string"
      || !CONTROLLER_MODES.has(controllerMode as RealmRuntimeSaveControllerMode)
      || typeof isActive !== "boolean"
      || typeof sharedControlEnabled !== "boolean"
    ) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime topology participant ${index} shape is invalid`);
    }
    const normalizedPrincipal = sourcePrincipalId === null
      ? null
      : requireIdentity(sourcePrincipalId, `topology.participants[${index}].sourcePrincipalId`);
    const characterRaw = requireField(raw, "character", `topology.participants[${index}]`);
    let character: RealmRuntimeSaveCharacterV1 | null = null;
    if (participantKind === "narrator") {
      if (characterRaw !== null) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "narrator participant cannot carry character topology");
      }
    } else {
      if (!isPlainObject(characterRaw)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "character participant must carry character topology");
      }
      assertExactKeys(
        characterRaw,
        [
          "sourceCharacterInstanceId",
          "sourceContinuityId",
          "sourcePredecessorInstanceId",
          "sourceDefinitionId",
          "definition",
          "continuity",
          "instance",
        ],
        `topology.participants[${index}].character`,
      );
      const sourceCharacterInstanceId = requireIdentity(
        requireField(characterRaw, "sourceCharacterInstanceId", `topology.participants[${index}].character`),
        `topology.participants[${index}].character.sourceCharacterInstanceId`,
      );
      const sourceContinuityId = requireIdentity(
        requireField(characterRaw, "sourceContinuityId", `topology.participants[${index}].character`),
        `topology.participants[${index}].character.sourceContinuityId`,
      );
      const sourcePredecessorInstanceId = requireField(
        characterRaw,
        "sourcePredecessorInstanceId",
        `topology.participants[${index}].character`,
      );
      const sourceDefinitionId = requireIdentity(
        requireField(characterRaw, "sourceDefinitionId", `topology.participants[${index}].character`),
        `topology.participants[${index}].character.sourceDefinitionId`,
      );
      if (characterIds.has(sourceCharacterInstanceId) || continuityIds.has(sourceContinuityId)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology character identities must be unique");
      }
      characterIds.add(sourceCharacterInstanceId);
      continuityIds.add(sourceContinuityId);
      const normalizedPredecessor = sourcePredecessorInstanceId === null
        ? null
        : requireIdentity(
            sourcePredecessorInstanceId,
            `topology.participants[${index}].character.sourcePredecessorInstanceId`,
          );
      const definitionRaw = requireField(characterRaw, "definition", `topology.participants[${index}].character`);
      if (!isPlainObject(definitionRaw)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology character definition is invalid");
      }
      assertExactKeys(definitionRaw, ["displayName", "sourceFormat", "profile"], "topology.character.definition");
      const displayName = requireField(definitionRaw, "displayName", "topology.character.definition");
      const sourceFormat = requireField(definitionRaw, "sourceFormat", "topology.character.definition");
      const profile = requireField(definitionRaw, "profile", "topology.character.definition");
      if (
        typeof displayName !== "string"
        || !displayName.trim()
        || typeof sourceFormat !== "string"
        || !CHARACTER_SOURCE_FORMATS.has(sourceFormat)
        || !isPlainObject(profile)
        || !isJsonValue(profile)
      ) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology character definition is invalid");
      }
      const continuityRaw = requireField(characterRaw, "continuity", `topology.participants[${index}].character`);
      if (!isPlainObject(continuityRaw)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology continuity is invalid");
      }
      assertExactKeys(
        continuityRaw,
        ["continuityKey", "status", "bornTick", "bornOrdinal", "endedTick", "endedOrdinal"],
        "topology.character.continuity",
      );
      const continuityKey = requireField(continuityRaw, "continuityKey", "topology.character.continuity");
      const continuityStatus = requireField(continuityRaw, "status", "topology.character.continuity");
      if (
        typeof continuityKey !== "string"
        || !continuityKey.trim()
        || typeof continuityStatus !== "string"
        || !CONTINUITY_STATUSES.has(continuityStatus)
      ) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology continuity is invalid");
      }
      const bornTick = requireInteger(
        requireField(continuityRaw, "bornTick", "topology.character.continuity"),
        "topology.character.continuity.bornTick",
        0,
      );
      const bornOrdinal = requireInteger(
        requireField(continuityRaw, "bornOrdinal", "topology.character.continuity"),
        "topology.character.continuity.bornOrdinal",
        0,
      );
      const endedTick = validateNullableInteger(
        requireField(continuityRaw, "endedTick", "topology.character.continuity"),
        "topology.character.continuity.endedTick",
        0,
      );
      const endedOrdinal = validateNullableInteger(
        requireField(continuityRaw, "endedOrdinal", "topology.character.continuity"),
        "topology.character.continuity.endedOrdinal",
        0,
      );
      if ((endedTick === null) !== (endedOrdinal === null)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology continuity cursor is incomplete");
      }
      const instanceRaw = requireField(characterRaw, "instance", `topology.participants[${index}].character`);
      if (!isPlainObject(instanceRaw)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology character instance is invalid");
      }
      assertExactKeys(
        instanceRaw,
        [
          "controllerMode",
          "status",
          "instantiatedTick",
          "instantiatedOrdinal",
          "inheritanceCutoffTick",
          "inheritanceCutoffOrdinal",
          "retiredTick",
          "retiredOrdinal",
          "state",
        ],
        "topology.character.instance",
      );
      const instanceControllerMode = requireField(instanceRaw, "controllerMode", "topology.character.instance");
      const instanceStatus = requireField(instanceRaw, "status", "topology.character.instance");
      const state = requireField(instanceRaw, "state", "topology.character.instance");
      if (
        typeof instanceControllerMode !== "string"
        || !CONTROLLER_MODES.has(instanceControllerMode as RealmRuntimeSaveControllerMode)
        || typeof instanceStatus !== "string"
        || !INSTANCE_STATUSES.has(instanceStatus)
        || !isPlainObject(state)
        || !isJsonValue(state)
      ) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology character instance is invalid");
      }
      const instantiatedTick = requireInteger(
        requireField(instanceRaw, "instantiatedTick", "topology.character.instance"),
        "topology.character.instance.instantiatedTick",
        0,
      );
      const instantiatedOrdinal = requireInteger(
        requireField(instanceRaw, "instantiatedOrdinal", "topology.character.instance"),
        "topology.character.instance.instantiatedOrdinal",
        0,
      );
      const inheritanceCutoffTick = requireInteger(
        requireField(instanceRaw, "inheritanceCutoffTick", "topology.character.instance"),
        "topology.character.instance.inheritanceCutoffTick",
        0,
      );
      const inheritanceCutoffOrdinal = requireInteger(
        requireField(instanceRaw, "inheritanceCutoffOrdinal", "topology.character.instance"),
        "topology.character.instance.inheritanceCutoffOrdinal",
        0,
      );
      const retiredTick = validateNullableInteger(
        requireField(instanceRaw, "retiredTick", "topology.character.instance"),
        "topology.character.instance.retiredTick",
        0,
      );
      const retiredOrdinal = validateNullableInteger(
        requireField(instanceRaw, "retiredOrdinal", "topology.character.instance"),
        "topology.character.instance.retiredOrdinal",
        0,
      );
      if ((retiredTick === null) !== (retiredOrdinal === null)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime topology instance cursor is incomplete");
      }
      character = {
        sourceCharacterInstanceId,
        sourceContinuityId,
        sourcePredecessorInstanceId: normalizedPredecessor,
        sourceDefinitionId,
        definition: {
          displayName,
          sourceFormat: sourceFormat as "native" | "sillytavern_character_card",
          profile: profile as Readonly<Record<string, JsonValue>>,
        },
        continuity: {
          continuityKey,
          status: continuityStatus as "active" | "inactive" | "ended",
          bornTick,
          bornOrdinal,
          endedTick,
          endedOrdinal,
        },
        instance: {
          controllerMode: instanceControllerMode as RealmRuntimeSaveControllerMode,
          status: instanceStatus as "planned" | "present" | "absent" | "retired",
          instantiatedTick,
          instantiatedOrdinal,
          inheritanceCutoffTick,
          inheritanceCutoffOrdinal,
          retiredTick,
          retiredOrdinal,
          state: state as Readonly<Record<string, JsonValue>>,
        },
      };
    }
    participants.push({
      sourceParticipantId,
      participantKind: participantKind as RealmRuntimeSaveParticipantKind,
      sourcePrincipalId: normalizedPrincipal,
      controllerMode: controllerMode as RealmRuntimeSaveControllerMode,
      isActive,
      speakingOrder: requireInteger(
        requireField(raw, "speakingOrder", `topology.participants[${index}]`),
        `topology.participants[${index}].speakingOrder`,
        0,
      ),
      sharedControlEnabled,
      character,
    });
  }
  const scenes = validateScenes(value.scenes ?? []);
  const sceneIds = new Set(scenes.map((scene) => scene.sourceSceneId));
  const visibilityPolicies = validateVisibilityPolicies(
    value.visibilityPolicies ?? [],
    sceneIds,
    characterIds,
  );
  return {
    format: "realm-runtime-topology",
    schemaVersion: 1,
    participants,
    scenes,
    visibilityPolicies,
  };
}

export function serializeRealmRuntimeSaveTopologyV1(topology: RealmRuntimeSaveTopologyV1): string {
  return canonicalJson(validateTopology(topology) as unknown as JsonValue);
}

function buildRuntimeFiles(
  record: RealmRuntimeSaveRecordV1,
  goals: RealmRuntimeSaveGoalsV1,
  topology?: RealmRuntimeSaveTopologyV1,
  actionReceipts?: RealmRuntimeSaveActionReceiptsV1,
  characterEffects?: RealmRuntimeSaveCharacterEffectsV1,
  observations?: RealmRuntimeSaveObservationsV1,
  memory?: RealmRuntimeSaveMemoryV1,
  outbox?: RealmRuntimeSaveOutboxV1,
  firstNight?: RealmRuntimeSaveFirstNightV1,
  selfPlay?: RealmRuntimeSaveSelfPlayV1,
  domain?: RealmRuntimeSaveDomainV1,
): ReadonlyMap<string, Uint8Array> {
  const files: [string, Uint8Array][] = [
    [RECORD_ENTRY, Buffer.from(serializeRealmRuntimeSaveRecordV1(record), "utf8")],
    [GOALS_ENTRY, Buffer.from(serializeRealmRuntimeSaveGoalsV1(goals), "utf8")],
  ];
  if (topology) files.push([TOPOLOGY_ENTRY, Buffer.from(serializeRealmRuntimeSaveTopologyV1(topology), "utf8")]);
  if (actionReceipts) {
    files.push([ACTION_RECEIPTS_ENTRY, Buffer.from(serializeRealmRuntimeSaveActionReceiptsV1(actionReceipts), "utf8")]);
  }
  if (characterEffects) {
    files.push([
      CHARACTER_EFFECTS_ENTRY,
      Buffer.from(serializeRealmRuntimeSaveCharacterEffectsV1(characterEffects), "utf8"),
    ]);
  }
  if (observations) {
    files.push([OBSERVATIONS_ENTRY, Buffer.from(serializeRealmRuntimeSaveObservationsV1(observations), "utf8")]);
  }
  if (memory) {
    files.push([MEMORY_ENTRY, Buffer.from(serializeRealmRuntimeSaveMemoryV1(memory), "utf8")]);
  }
  if (outbox) {
    files.push([OUTBOX_ENTRY, Buffer.from(serializeRealmRuntimeSaveOutboxV1(outbox), "utf8")]);
  }
  if (firstNight) {
    files.push([FIRST_NIGHT_ENTRY, Buffer.from(serializeRealmRuntimeSaveFirstNightV1(firstNight), "utf8")]);
  }
  if (selfPlay) {
    files.push([SELF_PLAY_ENTRY, Buffer.from(serializeRealmRuntimeSaveSelfPlayV1(selfPlay), "utf8")]);
  }
  if (domain) {
    files.push([DOMAIN_ENTRY, Buffer.from(serializeRealmRuntimeSaveDomainV1(domain), "utf8")]);
  }
  return new Map(files);
}

export function realmRuntimeSaveManifestFromData(input: {
  engineApi: string;
  mode: RealmRuntimeSaveMode;
  world: RealmRuntimeSaveWorldRef | null;
  scope: RealmRuntimeSaveScope;
  record: RealmRuntimeSaveRecordV1;
  goals: RealmRuntimeSaveGoalsV1;
  topology?: RealmRuntimeSaveTopologyV1;
  actionReceipts?: RealmRuntimeSaveActionReceiptsV1;
  characterEffects?: RealmRuntimeSaveCharacterEffectsV1;
  observations?: RealmRuntimeSaveObservationsV1;
  memory?: RealmRuntimeSaveMemoryV1;
  outbox?: RealmRuntimeSaveOutboxV1;
  firstNight?: RealmRuntimeSaveFirstNightV1;
  selfPlay?: RealmRuntimeSaveSelfPlayV1;
  domain?: RealmRuntimeSaveDomainV1;
}): RealmRuntimeSaveManifestV2 {
  const files = buildRuntimeFiles(
    input.record,
    input.goals,
    input.topology,
    input.actionReceipts,
    input.characterEffects,
    input.observations,
    input.memory,
    input.outbox,
    input.firstNight,
    input.selfPlay,
    input.domain,
  );
  return {
    format: "realm-save",
    formatVersion: 2,
    engineApi: input.engineApi,
    mode: input.mode,
    world: input.world,
    scope: input.scope,
    snapshot: {
      recordVersion: input.record.head.recordVersion,
      nextRecordOrdinal: input.record.head.nextRecordOrdinal,
      runtimeHash: computeRealmRuntimeSaveContentHash(files),
    },
  };
}

export function buildRealmRuntimeSaveArchive(input: {
  manifest: RealmRuntimeSaveManifestV2;
  record: RealmRuntimeSaveRecordV1;
  goals: RealmRuntimeSaveGoalsV1;
  topology?: RealmRuntimeSaveTopologyV1;
  actionReceipts?: RealmRuntimeSaveActionReceiptsV1;
  characterEffects?: RealmRuntimeSaveCharacterEffectsV1;
  observations?: RealmRuntimeSaveObservationsV1;
  memory?: RealmRuntimeSaveMemoryV1;
  outbox?: RealmRuntimeSaveOutboxV1;
  firstNight?: RealmRuntimeSaveFirstNightV1;
  selfPlay?: RealmRuntimeSaveSelfPlayV1;
  domain?: RealmRuntimeSaveDomainV1;
}): Uint8Array {
  const manifest = normalizeManifest(input.manifest);
  const record = validateRecord(input.record, manifest);
  const goals = validateGoals(input.goals,{...record.scope,workspaceId:manifest.scope.workspaceId});
  const topology = input.topology === undefined ? undefined : validateTopology(input.topology);
  const actionReceipts = input.actionReceipts === undefined
    ? undefined
    : validateActionReceipts(input.actionReceipts);
  const characterEffects = input.characterEffects === undefined
    ? undefined
    : validateCharacterEffects(input.characterEffects);
  const observations = input.observations === undefined
    ? undefined
    : validateObservations(input.observations);
  const memory = input.memory === undefined ? undefined : validateMemory(input.memory);
  if (memory) {
    validateMemoryReferences(memory, { record, topology, observations });
  }
  const outbox = input.outbox === undefined ? undefined : validateOutbox(input.outbox);
  if (outbox) {
    validateOutboxReferences(outbox, record);
  }
  const firstNight = input.firstNight === undefined ? undefined : validateFirstNight(input.firstNight);
  const selfPlay = input.selfPlay === undefined ? undefined : validateSelfPlay(input.selfPlay);
  const domain = input.domain === undefined ? undefined : normalizeRealmRuntimeSaveDomainV1(input.domain);
  const files = buildRuntimeFiles(
    record, goals, topology, actionReceipts, characterEffects, observations, memory,
    outbox, firstNight, selfPlay, domain,
  );
  if (computeRealmRuntimeSaveContentHash(files) !== manifest.snapshot.runtimeHash) {
    throw new RealmRuntimeSaveError("RUNTIME_HASH_MISMATCH", "runtime save content hash mismatch");
  }
  const entries: Record<string, [Uint8Array, ZipOptions]> = {
    [MANIFEST_ENTRY]: [
      Buffer.from(serializeRealmRuntimeSaveManifestV2(manifest), "utf8"),
      { level: 6, mtime: new Date(1980, 0, 1) },
    ],
    [RECORD_ENTRY]: [files.get(RECORD_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }],
    [GOALS_ENTRY]: [files.get(GOALS_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }],
  };
  if (topology) {
    entries[TOPOLOGY_ENTRY] = [files.get(TOPOLOGY_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  if (actionReceipts) {
    entries[ACTION_RECEIPTS_ENTRY] = [files.get(ACTION_RECEIPTS_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  if (characterEffects) {
    entries[CHARACTER_EFFECTS_ENTRY] = [files.get(CHARACTER_EFFECTS_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  if (observations) {
    entries[OBSERVATIONS_ENTRY] = [files.get(OBSERVATIONS_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  if (memory) {
    entries[MEMORY_ENTRY] = [files.get(MEMORY_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  if (outbox) {
    entries[OUTBOX_ENTRY] = [files.get(OUTBOX_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  if (firstNight) {
    entries[FIRST_NIGHT_ENTRY] = [files.get(FIRST_NIGHT_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  if (selfPlay) {
    entries[SELF_PLAY_ENTRY] = [files.get(SELF_PLAY_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  if (domain) {
    entries[DOMAIN_ENTRY] = [files.get(DOMAIN_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  }
  return zipSync(entries);
}

export function parseRealmRuntimeSaveArchive(bytes: Uint8Array): RealmRuntimeSaveArchive {
  let decoded: ReadonlyMap<string, Uint8Array>;
  try {
    decoded = validateStrictZipArchive(bytes, {
      entryNamePattern: ARCHIVE_ENTRY_RE,
      firstEntryName: MANIFEST_ENTRY,
      entrySizeCap: () => MAX_RUNTIME_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof RealmPackError) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime save archive failed ZIP validation");
    }
    throw error;
  }
  if (
    !decoded.has(MANIFEST_ENTRY)
    || !decoded.has(RECORD_ENTRY)
    || !decoded.has(GOALS_ENTRY)
    || [...decoded.keys()].some((entry) => !KNOWN_ENTRIES.has(entry))
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime save archive entry set is invalid");
  }
  const manifestBytes = decoded.get(MANIFEST_ENTRY)!;
  const manifest = parseRealmRuntimeSaveManifestV2(manifestBytes);
  const files = new Map<string, Uint8Array>(
    [...decoded.entries()].filter(([path]) => path.startsWith("runtime/")),
  );
  if (computeRealmRuntimeSaveContentHash(files) !== manifest.snapshot.runtimeHash) {
    throw new RealmRuntimeSaveError("RUNTIME_HASH_MISMATCH", "runtime save content hash mismatch");
  }
  let recordRaw: unknown;
  let goalsRaw: unknown;
  let topologyRaw: unknown;
  let actionReceiptsRaw: unknown;
  let characterEffectsRaw: unknown;
  let observationsRaw: unknown;
  let memoryRaw: unknown;
  let outboxRaw: unknown;
  let firstNightRaw: unknown;
  let selfPlayRaw: unknown;
  let domainRaw: unknown;
  try {
    recordRaw = JSON.parse(Buffer.from(files.get(RECORD_ENTRY)!).toString("utf8"));
    goalsRaw = JSON.parse(Buffer.from(files.get(GOALS_ENTRY)!).toString("utf8"));
    if (files.has(TOPOLOGY_ENTRY)) {
      topologyRaw = JSON.parse(Buffer.from(files.get(TOPOLOGY_ENTRY)!).toString("utf8"));
    }
    if (files.has(ACTION_RECEIPTS_ENTRY)) {
      actionReceiptsRaw = JSON.parse(Buffer.from(files.get(ACTION_RECEIPTS_ENTRY)!).toString("utf8"));
    }
    if (files.has(CHARACTER_EFFECTS_ENTRY)) {
      characterEffectsRaw = JSON.parse(Buffer.from(files.get(CHARACTER_EFFECTS_ENTRY)!).toString("utf8"));
    }
    if (files.has(OBSERVATIONS_ENTRY)) {
      observationsRaw = JSON.parse(Buffer.from(files.get(OBSERVATIONS_ENTRY)!).toString("utf8"));
    }
    if (files.has(MEMORY_ENTRY)) {
      memoryRaw = JSON.parse(Buffer.from(files.get(MEMORY_ENTRY)!).toString("utf8"));
    }
    if (files.has(OUTBOX_ENTRY)) {
      outboxRaw = JSON.parse(Buffer.from(files.get(OUTBOX_ENTRY)!).toString("utf8"));
    }
    if (files.has(FIRST_NIGHT_ENTRY)) {
      firstNightRaw = JSON.parse(Buffer.from(files.get(FIRST_NIGHT_ENTRY)!).toString("utf8"));
    }
    if (files.has(SELF_PLAY_ENTRY)) {
      selfPlayRaw = JSON.parse(Buffer.from(files.get(SELF_PLAY_ENTRY)!).toString("utf8"));
    }
    if (files.has(DOMAIN_ENTRY)) {
      domainRaw = files.get(DOMAIN_ENTRY);
    }
  } catch {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime save JSON is invalid");
  }
  const record = validateRecord(recordRaw, manifest);
  const goals = validateGoals(goalsRaw,{...record.scope,workspaceId:manifest.scope.workspaceId});
  const topology = topologyRaw === undefined ? undefined : validateTopology(topologyRaw);
  const actionReceipts = actionReceiptsRaw === undefined ? undefined : validateActionReceipts(actionReceiptsRaw);
  const characterEffects = characterEffectsRaw === undefined ? undefined : validateCharacterEffects(characterEffectsRaw);
  const observations = observationsRaw === undefined ? undefined : validateObservations(observationsRaw);
  const memory = memoryRaw === undefined ? undefined : validateMemory(memoryRaw);
  if (memory) {
    validateMemoryReferences(memory, { record, topology, observations });
  }
  const outbox = outboxRaw === undefined ? undefined : validateOutbox(outboxRaw);
  if (outbox) {
    validateOutboxReferences(outbox, record);
  }
  const firstNight = firstNightRaw === undefined ? undefined : validateFirstNight(firstNightRaw);
  const selfPlay = selfPlayRaw === undefined ? undefined : validateSelfPlay(selfPlayRaw);
  const domain = domainRaw === undefined
    ? undefined
    : parseRealmRuntimeSaveDomainV1(domainRaw as Uint8Array);
  return {
    manifest,
    record,
    goals,
    ...(topology ? { topology } : {}),
    ...(actionReceipts ? { actionReceipts } : {}),
    ...(characterEffects ? { characterEffects } : {}),
    ...(observations ? { observations } : {}),
    ...(memory ? { memory } : {}),
    ...(outbox ? { outbox } : {}),
    ...(firstNight ? { firstNight } : {}),
    ...(selfPlay ? { selfPlay } : {}),
    ...(domain ? { domain } : {}),
  };
}
