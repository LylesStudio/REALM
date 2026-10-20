/**
 * `.realm` runtime-save v2 contract.
 *
 * This is deliberately separate from `.realmworld`: it carries a Record's
 * runtime event/Goal facts plus the WorldBinding needed to restore it. It never
 * treats content files as runtime facts and never installs a RealmWorld.
 */
import { createHash } from "node:crypto";
import { RealmRuntimeSaveError, MAX_RUNTIME_FILE_BYTES, RUNTIME_SAVE_FILE_BYTES, memoryStringCharacterBytes,
  countRuntimeSectionWireBytes, type RuntimeSectionWireFormatter } from "./runtime-save-primitives.ts";
export { RealmRuntimeSaveError, RUNTIME_SAVE_FILE_BYTES, countRuntimeSectionWireBytes } from "./runtime-save-primitives.ts";
export type { RealmRuntimeSaveErrorCode, RuntimeSectionWireFormatter } from "./runtime-save-primitives.ts";
import { isPlainObject, isJsonValue, assertExactKeys, requireField, requireIdentity, requireInteger } from "./runtime-save-validation.ts";
import { normalizeRealmRuntimeSaveEventForRestore } from "./runtime-save-event.ts";
export { normalizeRealmRuntimeSaveEventForRestore } from "./runtime-save-event.ts";

import { normalizeRuntimePerformanceWitnesses, runtimePerformanceWitnessesDigest, validateRuntimePerformanceWitnessClosure,
  PERFORMANCE_WITNESSES_ENTRY, type RuntimePerformanceWitnessesV1 } from "./runtime-performance-witness-transport.ts";
import { decodeRealmRuntimeSaveGoalsV2, type RealmRuntimeSaveGoalsV2 } from "./realm-runtime-goals-v2.ts";
import { validatePerformanceSourceConsistency } from "./runtime-performance-source-consistency.ts";
import { validateReplayBundle, REPLAY_LINEAGE_MAX_BYTES, type ReplayClosure } from "../application/command-replay-lineage.ts";
import { zipSync, type ZipOptions } from "fflate";
import {
  RealmPackError,
  PACK_LIMITS,
  validateStrictZipArchive,
} from "./realm-pack.ts";
import type { JsonValue } from "../runtime/public.ts";
import { decodeRecordGoalDefinition } from "../goals/record-authoring.ts";
import {
  normalizeRealmRuntimeSaveDomainV1,
  parseRealmRuntimeSaveDomainV1,
  serializeNormalizedRealmRuntimeSaveDomainV1ForArchive,
  type RealmRuntimeSaveDomainV1,
} from "./realm-runtime-domain-save.ts";





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
  performanceWitnessesFormat?: { schemaVersion: 1; digest: string };
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
  | "goal.transition.committed"
  | "project.created"
  | "project.stage.changed"
  | "project.milestone.confirmed"
  | "finance.budget.allocated"
  | "finance.income.recorded"
  | "finance.expense.recorded"
  | "finance.adjustment.recorded";

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
export type RealmRuntimeSaveGoals = RealmRuntimeSaveGoalsV1 | RealmRuntimeSaveGoalsV2;

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

/** Pure global format only; active archive and RecordBundle fields remain V1.
 * Unlike V1, V2 permits empty snapshot content and Record-only relationships.
 */
export interface RealmRuntimeSaveMemoryV2 {
  format: "realm-runtime-memory";
  schemaVersion: 2;
  scope: { workspaceId: string; worldId: string; worldlineId: string };
  worldlineHead: { tick: number; ordinal: number };
  conclusions: readonly RealmRuntimeSaveMemoryConclusionV1[];
  snapshots: readonly RealmRuntimeSaveMemorySnapshotV1[];
  relationshipStates: readonly RealmRuntimeSaveRelationshipStateV1[];
  cacheEpochs: readonly { sourceObserverContinuityId: string; epoch: number }[];
}
export type RealmRuntimeSaveMemory = RealmRuntimeSaveMemoryV1 | RealmRuntimeSaveMemoryV2;

/** Separate pure-input surface. No active archive/bundle union is widened.
 * Siblings are complete existing bundles; domain carries its existing complete
 * bundles. Supply each Record once. No caller-provided ownership maps are used.
 */
export interface RealmRuntimeSaveArchiveMemoryInput {
  manifest: RealmRuntimeSaveManifestV2;
  record: RealmRuntimeSaveRecordV1;
  topology?: RealmRuntimeSaveTopologyV1;
  observations?: RealmRuntimeSaveObservationsV1;
  memory?: RealmRuntimeSaveMemoryV1 | RealmRuntimeSaveMemoryV2;
  domain?: RealmRuntimeSaveDomainV1;
  siblings?: readonly RealmRuntimeSaveRecordBundleV1[];
}

export interface RealmRuntimeSaveMemoryObservationOwner {
  sourceObservationId: string;
  sourceRecordId: string;
  sourceCharacterInstanceId: string;
  sourceObserverContinuityId: string;
  sourceEventId: string | null;
  sourceEventRecordId: string | null;
}

/** Owned detached data, with no target IDs or database capability. Downstream
 * callers consume this result rather than rereading mutable input after await.
 */
export interface ResolvedRealmRuntimeSaveArchiveMemory {
  sourceFormat: "v2" | "legacy";
  scope: RealmRuntimeSaveMemoryV2["scope"];
  worldlineHead: RealmRuntimeSaveMemoryV2["worldlineHead"] | null;
  conclusions: readonly RealmRuntimeSaveMemoryConclusionV1[];
  snapshots: readonly RealmRuntimeSaveMemorySnapshotV1[];
  relationshipStates: readonly RealmRuntimeSaveRelationshipStateV1[];
  cacheEpochs: RealmRuntimeSaveMemoryV2["cacheEpochs"];
  supersedesOrder: readonly string[];
  observationOwners: readonly RealmRuntimeSaveMemoryObservationOwner[];
  eventOwners: readonly { sourceEventId: string; sourceRecordId: string }[];
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

export interface RealmRuntimeSaveArchive<G extends RealmRuntimeSaveGoals = RealmRuntimeSaveGoalsV1> {
  performanceWitnesses?: RuntimePerformanceWitnessesV1;
  manifest: RealmRuntimeSaveManifestV2;
  record: RealmRuntimeSaveRecordV1;
  goals: G;
  /** Optional for reading pre-topology v2 saves; new exports always include it. */
  topology?: RealmRuntimeSaveTopologyV1;
  /** Optional for reading pre-ledger v2 saves; new exports always include them. */
  actionReceipts?: RealmRuntimeSaveActionReceiptsV1;
  characterEffects?: RealmRuntimeSaveCharacterEffectsV1;
  observations?: RealmRuntimeSaveObservationsV1;
  /** Optional for reading pre-memory v2 saves; new exports always include it. */
  memory?: RealmRuntimeSaveMemory;
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
  PERFORMANCE_WITNESSES_ENTRY,
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

const SAFE_REFERENCE = /^[A-Za-z0-9._:-]+$/;
const SAFE_EVENT_ID = /^[A-Za-z0-9._:-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ENGINE_API = /^1\./;


/** PostgreSQL17 numeric_out: int16 base-10000 weight and14-bit display
 * scale => <=131072+16383+sign+point characters. This is the intrinsic
 * persisted JSONB output bound, NOT a cap on arbitrary incoming JSON text.
 * See postgresql.org/docs/17/datatype-numeric.html and numeric.c.
 */
export const MEMORY_PG_NUMBER_TOKEN_CHARS = 147458;

export const MEMORY_RUNTIME_FILE_BYTES = RUNTIME_SAVE_FILE_BYTES;



/** Exact JSON.stringify string size, including lone surrogate escaping. */
export function memoryJsonStringBytes(value: string): number {
  let bytes = 2;
  for (let i=0;i<value.length;i++) {
    const code=value.charCodeAt(i), next=value.charCodeAt(i+1);
    if(code>=0xd800&&code<=0xdbff&&next>=0xdc00&&next<=0xdfff){bytes+=4;i++;}
    else bytes+=memoryStringCharacterBytes(code);
  }
  return bytes;
}

/** Count the existing canonical formatter without constructing its text.
 * Object key order changes bytes' order, never their count. */
export function countMemoryCanonicalBytes(value: JsonValue): number {
  let bytes=0;
  const pending: JsonValue[]=[value];
  while(pending.length){
    const item=pending.pop()!;
    if(typeof item==="string"){bytes+=memoryJsonStringBytes(item);continue;}
    if(item===null||typeof item!=="object"){bytes+=JSON.stringify(item).length;continue;}
    if(Array.isArray(item)){bytes+=2+Math.max(0,item.length-1);for(const child of item)pending.push(child);}
    else {const keys=Object.keys(item);bytes+=2+Math.max(0,keys.length-1);
      for(const key of keys){bytes+=memoryJsonStringBytes(key)+1;pending.push((item as {readonly[key:string]:JsonValue})[key]!);}}
  }
  return bytes;
}






/** One actual file, with its formatter and remaining archive allowance. The
 * caller commits bytes only after exact pre-format admission and verification.
 */
export class RuntimeSectionWireLedger {
  readonly filePath: string;
  readonly formatter: RuntimeSectionWireFormatter;
  readonly limitBytes: number;
  private bytes = 0;
  constructor(filePath: string, formatter: RuntimeSectionWireFormatter,
    remainingAggregateBytes = PACK_LIMITS.totalUncompressedMax, limitBytes = MAX_RUNTIME_FILE_BYTES) {
    if (!Number.isSafeInteger(remainingAggregateBytes) || remainingAggregateBytes < 0
      || !Number.isSafeInteger(limitBytes) || limitBytes < 0 || limitBytes > MAX_RUNTIME_FILE_BYTES
      || !["canonical-runtime", "normalized-domain"].includes(formatter)) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "runtime section ledger budget is invalid");
    }
    this.filePath = filePath;
    this.formatter = formatter;
    this.limitBytes = Math.min(limitBytes, remainingAggregateBytes);
  }
  get acceptedBytes(): number { return this.bytes; }
  get remainingBytes(): number { return this.limitBytes - this.bytes; }
  checkLowerBound(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remainingBytes) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime section ${this.filePath} exceeds its byte budget`);
    }
  }
  addExact(bytes: number): void { this.checkLowerBound(bytes); this.bytes += bytes; }
  reserve(value: unknown): void {
    this.addExact(countRuntimeSectionWireBytes(value, this.formatter, this.remainingBytes));
  }
  verify(emittedBytes: number): void {
    if (!Number.isSafeInteger(emittedBytes) || emittedBytes !== this.bytes) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime section ${this.filePath} wire ledger mismatch`);
    }
  }
}

/** Shared exact memory-file ledger. Candidate parsers get remaining bytes;
 * rejected candidates are never retained or charged as accepted rows. */
export class MemoryWireByteLedger {
  bytes: number;
  constructor(emptyDocument: RealmRuntimeSaveMemoryV2) {
    this.bytes=countMemoryCanonicalBytes(emptyDocument as unknown as JsonValue);
    this.check(0);
  }
  get remaining(): number {return MAX_RUNTIME_FILE_BYTES-this.bytes;}
  check(extra: number): void {
    if(extra>this.remaining)invalidMemory("MemoryV2 exceeds the runtime file byte limit.");
  }
  add(bytes: number): void {this.check(bytes);this.bytes+=bytes;}
  verify(document: RealmRuntimeSaveMemoryV2): void {
    if(countMemoryCanonicalBytes(document as unknown as JsonValue)!==this.bytes)
      invalidMemory("Memory resource ledger does not match canonical wire bytes.");
  }
}

type MemoryJsonFrame = {value:JsonValue[]|{[key:string]:JsonValue};phase:string;key?:string};

/** Incremental normalizer for PostgreSQL JSONB text. SQL whitespace and long
 * numeric spellings are discarded. Only accepted semantic state is retained,
 * plus fixed UTF8/escape/numeric buffers. No whole raw row is accumulated.
 */
export class MemoryPgJsonStream {
  bytes=0;
  private root:JsonValue= null;
  private hasRoot=false;
  private stack:MemoryJsonFrame[]=[];
  private token:"string"|"number"|"literal"|null=null;
  private raw="";
  private pieces:string[]=[];
  private piece="";
  private escape="";
  private high="";
  private stringKey=false;
  private decoder=new TextDecoder("utf-8",{fatal:true});
  private readonly limit:number;
  constructor(limit:number) {this.limit=limit;}
  private fail():never {return invalidMemory("Invalid bounded PostgreSQL memory JSON.");}
  private charge(bytes:number):void {
    if(this.bytes+bytes>this.limit)invalidMemory("MemoryV2 exceeds the runtime file byte limit.");
    this.bytes+=bytes;
  }
  private expectValue():void {
    const parent=this.stack.at(-1);
    if(parent?!["value","valueOrEnd"].includes(parent.phase):this.hasRoot)this.fail();
  }
  private attach(value:JsonValue):void {
    this.expectValue();const parent=this.stack.at(-1);
    if(!parent){this.root=value;this.hasRoot=true;return;}
    if(Array.isArray(parent.value))parent.value.push(value);
    else Object.defineProperty(parent.value,parent.key!,{value,enumerable:true,writable:true,configurable:true});
    parent.phase="commaOrEnd";
  }
  private stringPart(value:string):void {
    if(this.high){
      const code=value.charCodeAt(0);
      if(code>=0xdc00&&code<=0xdfff){this.charge(4);this.piece+=this.high+value[0];value=value.slice(1);}
      else {this.charge(6);this.piece+=this.high;}
      this.high="";
    }
    const last=value.charCodeAt(value.length-1);
    if(last>=0xd800&&last<=0xdbff){this.high=value.at(-1)!;value=value.slice(0,-1);}
    this.charge(memoryJsonStringBytes(value)-2);this.piece+=value;
    if(this.piece.length>=8192){
      // Flatten a bounded decoded piece, never parse an accumulated raw row.
      this.pieces.push(JSON.parse(JSON.stringify(this.piece)) as string);this.piece="";
    }
  }
  private endString():void {
    if(this.high){this.charge(6);this.piece+=this.high;this.high="";}
    this.pieces.push(this.piece);const value=this.pieces.join("");this.pieces=[];this.piece="";this.token=null;
    if(this.stringKey){const top=this.stack.at(-1)!;
      if(Object.hasOwn(top.value,value))this.fail();top.key=value;top.phase="colon";
    }else this.attach(value);
  }
  private endScalar():void {
    let value:JsonValue;
    if(this.token==="number"){
      if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(this.raw))this.fail();
      value=JSON.parse(this.raw) as number;if(!Number.isFinite(value))this.fail();
    }else {
      if(!["true","false","null"].includes(this.raw))this.fail();value=JSON.parse(this.raw) as JsonValue;
    }
    this.charge(JSON.stringify(value).length);this.raw="";this.token=null;this.attach(value);
  }
  write(input:string|Uint8Array):void {
    const text=typeof input==="string"?input:this.decoder.decode(input,{stream:true});
    for(let i=0;i<text.length;i++){
      const ch=text[i]!;
      if(this.token==="string"){
        if(this.escape){
          this.escape+=ch;
          if(this.escape.length===2&&ch!=="u"){
            if(!'"\\/bfnrt'.includes(ch))this.fail();this.stringPart(JSON.parse('"'+this.escape+'"') as string);this.escape="";
          }else if(this.escape.length===6){
            if(!/^\\u[0-9a-fA-F]{4}$/.test(this.escape))this.fail();this.stringPart(JSON.parse('"'+this.escape+'"') as string);this.escape="";
          }
        }else if(ch==='"')this.endString();
        else if(ch==="\\")this.escape="\\";
        else {
          if(ch.charCodeAt(0)<32)this.fail();
          let end=i+1;
          while(end<text.length&&text[end]!=='"'&&text[end]!=="\\"&&text.charCodeAt(end)>=32)end++;
          this.stringPart(text.slice(i,end));i=end-1;
        }
        continue;
      }
      if(this.token){
        if(/[ \t\r\n,\]}]/.test(ch)){this.endScalar();i--;continue;}
        this.raw+=ch;
        if(this.raw.length>(this.token==="number"?MEMORY_PG_NUMBER_TOKEN_CHARS:5))this.fail();
        continue;
      }
      if(/[ \t\r\n]/.test(ch))continue;
      const top=this.stack.at(-1);
      if(ch==='"'){
        this.stringKey=!!top&&!Array.isArray(top.value)&&["key","keyOrEnd"].includes(top.phase);
        if(!this.stringKey)this.expectValue();this.charge(2);this.token="string";continue;
      }
      if(ch==="{"||ch==="["){
        this.charge(2);const value=ch==="{"?{}:[];this.attach(value);
        this.stack.push({value,phase:ch==="{"?"keyOrEnd":"valueOrEnd"});continue;
      }
      if(ch==="}"||ch==="]"){
        if(!top||Array.isArray(top.value)!==(ch==="]")||!["commaOrEnd",ch==="]"?"valueOrEnd":"keyOrEnd"].includes(top.phase))this.fail();
        this.stack.pop();continue;
      }
      if(ch===":"){if(top?.phase!=="colon")this.fail();this.charge(1);top.phase="value";continue;}
      if(ch===","){if(top?.phase!=="commaOrEnd")this.fail();this.charge(1);top.phase=Array.isArray(top.value)?"value":"key";continue;}
      this.expectValue();this.token=/[-0-9]/.test(ch)?"number":"literal";this.raw=ch;
    }
  }
  finish():JsonValue {
    const tail=this.decoder.decode();if(tail)this.write(tail);
    if(this.token==="number"||this.token==="literal")this.endScalar();
    if(this.token||this.stack.length||!this.hasRoot)this.fail();
    return this.root;
  }
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
    ["format", "formatVersion", "engineApi", "mode", "world", "scope", "snapshot", "performanceWitnessesFormat"],
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
  let performanceWitnessesFormat: RealmRuntimeSaveManifestV2["performanceWitnessesFormat"];
  if (Object.hasOwn(value, "performanceWitnessesFormat")) {
    const declaration = value.performanceWitnessesFormat;
    if (!isPlainObject(declaration) || Object.keys(declaration).length !== 2 || declaration.schemaVersion !== 1) {
      throw new RealmRuntimeSaveError("INVALID_SAVE", "Performance witness schema version is unsupported.");
    }
    assertExactKeys(declaration, ["schemaVersion", "digest"], "manifest.performanceWitnessesFormat");
    performanceWitnessesFormat = { schemaVersion: 1, digest: requireHash(declaration.digest, "performanceWitnessesFormat.digest") };
  }
  return {
    ...(performanceWitnessesFormat ? { performanceWitnessesFormat } : {}),
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
    ...(valid.performanceWitnessesFormat ? { performanceWitnessesFormat: valid.performanceWitnessesFormat } : {}),
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
  return validateRecordDocument(value, {
    scope: {
      worldId: manifest.world?.worldId ?? null,
      worldlineId: manifest.scope.worldlineId,
      recordId: manifest.scope.recordId,
    },
    head: {
      recordVersion: manifest.snapshot.recordVersion,
      nextRecordOrdinal: manifest.snapshot.nextRecordOrdinal,
    },
  });
}

/**
 * validateRecord with an explicit expected scope/head instead of a manifest:
 * shared by the archive entry and by domain-carried sibling Record snapshots.
 */
function validateRecordDocument(
  value: unknown,
  expected: {
    scope: { worldId: string | null; worldlineId: string; recordId: string };
    head: { recordVersion: number; nextRecordOrdinal: number };
  },
): RealmRuntimeSaveRecordV1 {
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
    scope.worldlineId !== expected.scope.worldlineId
    || scope.recordId !== expected.scope.recordId
    || (expected.scope.worldId !== null && scope.worldId !== expected.scope.worldId)
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
    head.recordVersion !== expected.head.recordVersion
    || head.nextRecordOrdinal !== expected.head.nextRecordOrdinal
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
  return { format: "realm-runtime-memory", schemaVersion: 1, ...validateMemoryRows(value, "v1") };
}

// Shared scalar/row parsing only. V1 keeps its original local membership rules;
// V2 references are resolved once with complete context by the separate API.
function validateMemoryRows(
  value: Record<string, unknown>,
  mode: "v1" | "v2" | "legacy",
): Pick<RealmRuntimeSaveMemoryV1, "conclusions" | "snapshots" | "relationshipStates"> {
  if (!Array.isArray(value.conclusions) || !Array.isArray(value.snapshots) || !Array.isArray(value.relationshipStates)) {
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
  for (const conclusion of mode !== "v2" ? conclusions : []) {
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
  for (const conclusion of mode === "v1" ? conclusions : []) {
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
      || (mode !== "v2" && !content.trim())
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
    for (const itemId of mode !== "v2" ? sourceItemIds : []) {
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
      ...(mode !== "v2" ? validateNullableSourceObservation(raw, where) : validateMemoryV2RelationshipSource(raw, where)),
      ...validateMemoryCursor(raw, where),
    };
  });
  return { conclusions, snapshots, relationshipStates };
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

function invalidMemory(message: string): never {
  throw new RealmRuntimeSaveError("INVALID_SAVE", message);
}

/** Copy JSON data without invoking accessors/toJSON or retaining caller aliases.
 * Iterative traversal rejects cycles but permits shared, acyclic input objects.
 */
function detachMemoryData(value: unknown, optionalRootFields: readonly string[] = []): unknown {
  const scalar = (item: unknown): boolean => item === null || typeof item === "string"
    || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item));
  const container = (item: unknown): Record<string, unknown> | unknown[] => {
    if (typeof item !== "object" || item === null
      || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) {
      return invalidMemory("Memory input must contain plain JSON data.");
    }
    return item as Record<string, unknown> | unknown[];
  };
  if (scalar(value)) return value;
  const source = container(value);
  const result = Array.isArray(source) ? [] : {};
  const frame = (input: Record<string, unknown> | unknown[], output: object) => {
    const keys = Reflect.ownKeys(input).filter((key) => {
      if (Array.isArray(input) && key === "length") return false;
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
      return !(input === source && typeof key === "string" && optionalRootFields.includes(key) && "value" in descriptor && descriptor.value === undefined);
    });
    if (keys.some((key) => typeof key !== "string")
      || (Array.isArray(input) && (keys.length !== input.length || keys.some((key, i) => key !== String(i))))) {
      invalidMemory("Memory input must contain plain JSON data.");
    }
    return { input, output, keys: keys as string[], index: 0 };
  };
  const stack = [frame(source, result)];
  const active = new Set<object>([source]);
  while (stack.length) {
    const top = stack[stack.length - 1]!;
    if (top.index === top.keys.length) { active.delete(top.input); stack.pop(); continue; }
    const key = top.keys[top.index++]!;
    const descriptor = Object.getOwnPropertyDescriptor(top.input, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) invalidMemory("Memory input must contain plain JSON data.");
    const item: unknown = descriptor.value;
    if (scalar(item)) {
      Object.defineProperty(top.output, key, { value: item, enumerable: true, writable: true, configurable: true });
    } else {
      const input = container(item);
      if (active.has(input)) invalidMemory("Memory input must not contain cycles.");
      const output = Array.isArray(input) ? [] : {};
      Object.defineProperty(top.output, key, { value: output, enumerable: true, writable: true, configurable: true });
      active.add(input); stack.push(frame(input, output));
    }
  }
  return result;
}

function validateMemoryV2RelationshipSource(raw: Record<string, unknown>, where: string) {
  const record = requireField(raw, "sourceRecordId", where);
  const observation = requireField(raw, "sourceObservationId", where);
  if (record === null && observation !== null) invalidMemory("Memory observation requires a source Record.");
  return {
    sourceRecordId: record === null ? null : requireIdentity(record, `${where}.sourceRecordId`),
    sourceObservationId: observation === null ? null : requireReference(observation, `${where}.sourceObservationId`),
  };
}

function memoryRelationshipKey(row: RealmRuntimeSaveRelationshipStateV1): string {
  return JSON.stringify([row.sourceObserverContinuityId, row.targetEntityKey, row.relationKind]);
}

function memoryInt32(value: unknown, where: string): number {
  const result = requireInteger(value, where, 0);
  if (result > 2147483647) invalidMemory(`Memory ${where} exceeds int32.`);
  return result;
}

// V2 wire identities/references are literal ASCII IDs, at most 512 bytes.
// This is an identifier bound, not an archive row-count or payload cap.
function boundedMemoryId(value: string | null): void {
  if (value !== null && value.length > 512) invalidMemory("MemoryV2 identifier exceeds 512 bytes.");
}

function normalizeMemoryV2Document(value: unknown): RealmRuntimeSaveMemoryV2 {
  const raw = detachMemoryData(value);
  if (!isPlainObject(raw)) invalidMemory("MemoryV2 must be an object.");
  const keys = ["format", "schemaVersion", "scope", "worldlineHead", "conclusions", "snapshots", "relationshipStates", "cacheEpochs"];
  assertExactKeys(raw, keys, "memoryV2");
  for (const key of keys) requireField(raw, key, "memoryV2");
  if (raw.format !== "realm-runtime-memory" || raw.schemaVersion !== 2) invalidMemory("MemoryV2 schema is unsupported.");
  if (!isPlainObject(raw.scope) || !isPlainObject(raw.worldlineHead)) invalidMemory("MemoryV2 scope/head is invalid.");
  assertExactKeys(raw.scope, ["workspaceId", "worldId", "worldlineId"], "memoryV2.scope");
  assertExactKeys(raw.worldlineHead, ["tick", "ordinal"], "memoryV2.worldlineHead");
  const scope = {
    workspaceId: requireIdentity(requireField(raw.scope, "workspaceId", "memoryV2.scope"), "memoryV2.scope.workspaceId"),
    worldId: requireIdentity(requireField(raw.scope, "worldId", "memoryV2.scope"), "memoryV2.scope.worldId"),
    worldlineId: requireIdentity(requireField(raw.scope, "worldlineId", "memoryV2.scope"), "memoryV2.scope.worldlineId"),
  };
  const worldlineHead = {
    tick: requireInteger(requireField(raw.worldlineHead, "tick", "memoryV2.worldlineHead"), "memoryV2.worldlineHead.tick", 0),
    ordinal: requireInteger(requireField(raw.worldlineHead, "ordinal", "memoryV2.worldlineHead"), "memoryV2.worldlineHead.ordinal", 0),
  };
  const rows = validateMemoryRows(raw, "v2");
  for (const id of Object.values(scope)) boundedMemoryId(id);
  for (const row of rows.conclusions) {
    for (const id of [row.sourceMemoryId, row.sourceObserverContinuityId, row.sourceRecordId, row.sourceObservationId, row.sourceSupersedesMemoryId]) boundedMemoryId(id);
  }
  for (const row of rows.snapshots) {
    boundedMemoryId(row.sourceSnapshotId); boundedMemoryId(row.sourceObserverContinuityId);
    for (const id of row.sourceItemIds) boundedMemoryId(id);
    memoryInt32(row.cacheEpoch, "snapshot.cacheEpoch"); memoryInt32(row.tokenCount, "snapshot.tokenCount");
  }
  for (const row of rows.relationshipStates) {
    boundedMemoryId(row.sourceObserverContinuityId); boundedMemoryId(row.sourceRecordId); boundedMemoryId(row.sourceObservationId);
  }
  if (!Array.isArray(raw.cacheEpochs)) invalidMemory("MemoryV2 cacheEpochs must be an array.");
  const seen = new Set<string>();
  const cacheEpochs = raw.cacheEpochs.map((entry) => {
    if (!isPlainObject(entry)) invalidMemory("MemoryV2 epoch is invalid.");
    assertExactKeys(entry, ["sourceObserverContinuityId", "epoch"], "memoryV2.cacheEpochs");
    const sourceObserverContinuityId = requireIdentity(requireField(entry, "sourceObserverContinuityId", "epoch"), "epoch.observer");
    if (seen.has(sourceObserverContinuityId)) invalidMemory("MemoryV2 epoch observers must be unique.");
    seen.add(sourceObserverContinuityId);
    boundedMemoryId(sourceObserverContinuityId);
    return { sourceObserverContinuityId, epoch: memoryInt32(requireField(entry, "epoch", "epoch"), "epoch.epoch") };
  });
  return {
    format: "realm-runtime-memory", schemaVersion: 2, scope, worldlineHead,
    conclusions: [...rows.conclusions].sort((a, b) => a.occurredTick - b.occurredTick || a.occurredOrdinal - b.occurredOrdinal || compareUtf8(a.sourceMemoryId, b.sourceMemoryId)),
    snapshots: [...rows.snapshots].sort((a, b) => a.cursorTick - b.cursorTick || a.cursorOrdinal - b.cursorOrdinal || compareUtf8(a.sourceSnapshotId, b.sourceSnapshotId)),
    relationshipStates: [...rows.relationshipStates].sort((a, b) => compareUtf8(a.sourceObserverContinuityId, b.sourceObserverContinuityId) || compareUtf8(a.targetEntityKey, b.targetEntityKey) || compareUtf8(a.relationKind, b.relationKind)),
    cacheEpochs: cacheEpochs.sort((a, b) => compareUtf8(a.sourceObserverContinuityId, b.sourceObserverContinuityId)),
  };
}

function encodeMemoryV2(document: RealmRuntimeSaveMemoryV2): string {
  const text = canonicalJson(document as unknown as JsonValue);
  const emittedBytes=Buffer.byteLength(text,"utf8");
  if(emittedBytes!==countMemoryCanonicalBytes(document as unknown as JsonValue))invalidMemory("Memory resource ledger does not match canonical wire bytes.");
  if (emittedBytes > MAX_RUNTIME_FILE_BYTES) invalidMemory("MemoryV2 exceeds the runtime file byte limit.");
  return text;
}

/** Strict structural normalization only; call the complete-context resolver
 * before consuming references. Returned data is detached from the input.
 */
export function normalizeRealmRuntimeSaveMemoryV2(value: unknown): RealmRuntimeSaveMemoryV2 {
  const document = normalizeMemoryV2Document(value);
  encodeMemoryV2(document);
  return document;
}

/** Same canonical formatter and 64 MiB file boundary as runtime archive JSON. */
export function serializeRealmRuntimeSaveMemoryV2(section: RealmRuntimeSaveMemoryV2): string {
  return encodeMemoryV2(normalizeMemoryV2Document(section));
}

/** Stable Kahn order using a min heap: O((rows + edges) log rows), never a
 * repeated all-map scan or per-chain recursive traversal.
 */
function orderGlobalMemory(conclusions: readonly RealmRuntimeSaveMemoryConclusionV1[]): string[] {
  const byId = new Map(conclusions.map((row) => [row.sourceMemoryId, row]));
  const children = new Map<string, string[]>();
  const heap: string[] = [];
  const push = (id: string): void => {
    heap.push(id); let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (compareUtf8(heap[parent]!, id) <= 0) break;
      heap[index] = heap[parent]!; index = parent;
    }
    heap[index] = id;
  };
  const pop = (): string => {
    const first = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      let index = 0;
      while (index * 2 + 1 < heap.length) {
        let child = index * 2 + 1;
        if (child + 1 < heap.length && compareUtf8(heap[child + 1]!, heap[child]!) < 0) child++;
        if (compareUtf8(last, heap[child]!) <= 0) break;
        heap[index] = heap[child]!; index = child;
      }
      heap[index] = last;
    }
    return first;
  };
  for (const row of conclusions) {
    const parentId = row.sourceSupersedesMemoryId;
    if (parentId === null) { push(row.sourceMemoryId); continue; }
    const parent = byId.get(parentId);
    if (!parent || parent.sourceObserverContinuityId !== row.sourceObserverContinuityId) invalidMemory("Memory supersedes reference is missing or has another observer.");
    const list = children.get(parentId) ?? [];
    list.push(row.sourceMemoryId); children.set(parentId, list);
  }
  const order: string[] = [];
  while (heap.length) {
    const id = pop(); order.push(id);
    for (const child of children.get(id) ?? []) push(child);
  }
  if (order.length !== conclusions.length) invalidMemory("Memory supersedes chain is cyclic.");
  return order;
}

function normalizeLegacyMemoryDocument(value: unknown): RealmRuntimeSaveMemoryV1 {
  if (!isPlainObject(value)) invalidMemory("Legacy memory must be an object.");
  assertExactKeys(value, ["format", "schemaVersion", "conclusions", "snapshots", "relationshipStates"], "legacy memory");
  if (value.format !== "realm-runtime-memory" || value.schemaVersion !== 1) invalidMemory("Legacy memory schema is unsupported.");
  const document: RealmRuntimeSaveMemoryV1 = { format: "realm-runtime-memory", schemaVersion: 1, ...validateMemoryRows(value, "legacy") };
  for (const snapshot of document.snapshots) {
    memoryInt32(snapshot.cacheEpoch, "snapshot.cacheEpoch"); memoryInt32(snapshot.tokenCount, "snapshot.tokenCount");
  }
  if (Buffer.byteLength(canonicalJson(document as unknown as JsonValue)) > MAX_RUNTIME_FILE_BYTES) invalidMemory("Legacy memory exceeds the runtime file byte limit.");
  return document;
}

function collectLegacyMemory(documents: readonly RealmRuntimeSaveMemoryV1[]) {
  const conclusions = new Map<string, RealmRuntimeSaveMemoryConclusionV1>();
  const snapshots = new Map<string, RealmRuntimeSaveMemorySnapshotV1>();
  const relationships = new Map<string, RealmRuntimeSaveRelationshipStateV1>();
  const insert = <T>(map: Map<string, T>, key: string, row: T): void => {
    if (map.has(key)) {
      if (canonicalJson(map.get(key) as unknown as JsonValue) !== canonicalJson(row as unknown as JsonValue)) invalidMemory("Legacy memory representations conflict.");
      return;
    }
    map.set(key, row);
  };
  for (const document of documents) {
    for (const row of document.conclusions) insert(conclusions, row.sourceMemoryId, row);
    for (const row of document.snapshots) insert(snapshots, row.sourceSnapshotId, row);
    for (const row of document.relationshipStates) insert(relationships, memoryRelationshipKey(row), row);
  }
  return { conclusions: [...conclusions.values()], snapshots: [...snapshots.values()], relationshipStates: [...relationships.values()] };
}

function legacyMemoryEpochs(snapshots: readonly RealmRuntimeSaveMemorySnapshotV1[], observers: Iterable<string>): RealmRuntimeSaveMemoryV2["cacheEpochs"] {
  const maxima = new Map([...observers].map((id) => [id, -1]));
  for (const snapshot of snapshots) {
    if (!maxima.has(snapshot.sourceObserverContinuityId)) invalidMemory("Legacy snapshot observer is not carried.");
    maxima.set(snapshot.sourceObserverContinuityId, Math.max(maxima.get(snapshot.sourceObserverContinuityId)!, snapshot.cacheEpoch));
  }
  return [...maxima].sort(([a], [b]) => compareUtf8(a, b)).map(([sourceObserverContinuityId, maximum]) => {
    if (maximum === 2147483647) invalidMemory("Legacy memory cache epoch is exhausted.");
    // MAX-1 -> MAX is representable, with zero remaining successful revisions.
    return { sourceObserverContinuityId, epoch: maximum + 1 };
  });
}

function normalizeMemoryContextBundle(bundle: RealmRuntimeSaveRecordBundleV1, scope: RealmRuntimeSaveMemoryV2["scope"]): RealmRuntimeSaveRecordBundleV1 {
  if (!isPlainObject(bundle) || !isPlainObject(bundle.record) || !isPlainObject(bundle.record.scope)) invalidMemory("Memory sibling Record is invalid.");
  // Keep active bundle/V1 behavior unchanged. The pure resolver parses memory
  // separately so its DAG is checked once globally, not by V1's per-chain walk.
  const sections = { ...bundle }; delete sections.memory;
  const context = validateRealmRuntimeSaveRecordBundle(sections, {
    worldId: scope.worldId, worldlineId: scope.worldlineId,
    recordId: requireIdentity(bundle.record.scope.recordId, "memory sibling Record"),
  });
  if (bundle.memory !== undefined) {
    context.memory = normalizeLegacyMemoryDocument(bundle.memory);
    validateMemoryReferences(context.memory, context);
  }
  return context;
}

/** Complete-context pure validation. Structural V2 success alone does not
 * establish ownership. This API neither allocates target IDs nor authorizes
 * export/restore, and is deliberately not wired into the active V1 wrappers.
 */
export function resolveRealmRuntimeSaveArchiveMemory(
  input: RealmRuntimeSaveArchiveMemoryInput,
): ResolvedRealmRuntimeSaveArchiveMemory {
  const detached = detachMemoryData(input, ["memory", "topology", "observations", "domain", "siblings"]);
  if (!isPlainObject(detached)) invalidMemory("Memory context must be an object.");
  const source = detached as unknown as RealmRuntimeSaveArchiveMemoryInput;
  let manifest: RealmRuntimeSaveManifestV2;
  try { manifest = normalizeManifest(source.manifest); }
  catch (error) {
    if (error instanceof RealmRuntimeSaveError) return invalidMemory(error.message);
    throw error;
  }
  const record = validateRecord(source.record, manifest);
  const scope = { workspaceId: manifest.scope.workspaceId, worldId: record.scope.worldId, worldlineId: record.scope.worldlineId };
  const root = {
    record,
    topology: source.topology === undefined ? undefined : validateTopology(source.topology),
    observations: source.observations === undefined ? undefined : validateObservations(source.observations),
  };
  if (source.siblings !== undefined && !Array.isArray(source.siblings)) invalidMemory("Memory siblings must be complete bundles.");
  const bundles = [...(source.siblings ?? [])];
  const domainCursors: { tick: number; ordinal: number }[] = [];
  if (source.domain !== undefined) {
    let domain: RealmRuntimeSaveDomainV1;
    const memoryByRecord = new Map<string, RealmRuntimeSaveMemoryV1>();
    try {
      const domainInput = { ...source.domain, ...(source.domain.records === undefined ? {} : { records: source.domain.records.map((row) => {
        const bundle = { ...row.bundle };
        if (bundle.memory !== undefined) memoryByRecord.set(row.recordId, normalizeLegacyMemoryDocument(bundle.memory));
        delete bundle.memory;
        return { ...row, bundle };
      }) }) };
      domain = normalizeRealmRuntimeSaveDomainV1(domainInput);
      for (const row of (domain.records ?? [])) {
        const memory = memoryByRecord.get(row.recordId);
        if (memory !== undefined) row.bundle.memory = memory;
      }
      // Reattaching normalized legacy rows preserves the exact existing domain
      // envelope. JSON object key ordering cannot alter this byte count.
      if (countRuntimeSectionWireBytes(domain, "normalized-domain") > REPLAY_LINEAGE_MAX_BYTES) invalidMemory("Memory domain exceeds its byte limit.");
    }
    catch { return invalidMemory("Memory domain context is invalid."); }
    if (domain.source.worldId !== scope.worldId || domain.source.worldlineId !== scope.worldlineId || domain.source.recordId !== record.scope.recordId) invalidMemory("Memory domain source scope does not match.");
    for (const row of (domain.records ?? [])) {
      bundles.push(row.bundle);
      domainCursors.push({ tick: row.startTick, ordinal: row.startOrdinal });
      if (row.lastWorldTick !== null && row.lastWorldOrdinal !== null) domainCursors.push({ tick: row.lastWorldTick, ordinal: row.lastWorldOrdinal });
    }
  }
  const contexts = [root, ...bundles.map((bundle) => normalizeMemoryContextBundle(bundle, scope))];
  const records = new Set<string>();
  const events = new Map<string, string>();
  const continuities = new Map<string, string>();
  const definitions = new Map<string, string>();
  const instances = new Map<string, { recordId: string; continuityId: string; representation: string }>();
  const participants = new Map<string, string>();
  for (const context of contexts) {
    const recordId = context.record.scope.recordId;
    if (records.has(recordId)) invalidMemory("Memory context repeats a Record.");
    records.add(recordId);
    for (const event of context.record.events) {
      if (events.has(event.eventId)) invalidMemory("Memory event has multiple owners.");
      events.set(event.eventId, recordId);
    }
    for (const participant of context.topology?.participants ?? []) {
      if (participants.has(participant.sourceParticipantId)) invalidMemory("Memory participant has multiple owners.");
      participants.set(participant.sourceParticipantId, recordId);
      const character = participant.character;
      if (!character) continue;
      const continuity = canonicalJson({ sourceDefinitionId: character.sourceDefinitionId, continuity: character.continuity } as unknown as JsonValue);
      if (continuities.has(character.sourceContinuityId) && continuities.get(character.sourceContinuityId) !== continuity) invalidMemory("Memory continuity representations conflict.");
      continuities.set(character.sourceContinuityId, continuity);
      const definition = canonicalJson(character.definition as unknown as JsonValue);
      if (definitions.has(character.sourceDefinitionId) && definitions.get(character.sourceDefinitionId) !== definition) invalidMemory("Memory definition representations conflict.");
      definitions.set(character.sourceDefinitionId, definition);
      const representation = canonicalJson(character as unknown as JsonValue);
      const old = instances.get(character.sourceCharacterInstanceId);
      if (old && (old.recordId !== recordId || old.representation !== representation)) invalidMemory("Memory instance representations conflict.");
      instances.set(character.sourceCharacterInstanceId, { recordId, continuityId: character.sourceContinuityId, representation });
    }
  }
  const observations = new Map<string, RealmRuntimeSaveMemoryObservationOwner>();
  for (const context of contexts) {
    for (const row of context.observations?.observations ?? []) {
      const instance = instances.get(row.sourceObserverCharacterInstanceId);
      const recordId = context.record.scope.recordId;
      if (!instance || instance.recordId !== recordId) invalidMemory("Memory observation instance does not belong to its Record.");
      if (observations.has(row.sourceObservationId)) invalidMemory("Memory observation has multiple owners.");
      const eventRecordId = row.sourceEventId === null ? null : events.get(row.sourceEventId);
      if (eventRecordId === undefined) invalidMemory("Memory observation source event is not carried.");
      observations.set(row.sourceObservationId, {
        sourceObservationId: row.sourceObservationId, sourceRecordId: recordId,
        sourceCharacterInstanceId: row.sourceObserverCharacterInstanceId, sourceObserverContinuityId: instance.continuityId,
        sourceEventId: row.sourceEventId, sourceEventRecordId: eventRecordId,
      });
    }
  }
  const v2 = source.memory?.schemaVersion === 2 ? normalizeRealmRuntimeSaveMemoryV2(source.memory) : undefined;
  if (v2 && contexts.slice(1).some((context) => "memory" in context && context.memory !== undefined)) invalidMemory("MemoryV2 cannot be mixed with sibling legacy memory.");
  if (v2 && Object.keys(scope).some((key) => scope[key as keyof typeof scope] !== v2.scope[key as keyof typeof scope])) invalidMemory("Memory source scope does not match the archive.");
  const legacy: RealmRuntimeSaveMemoryV1[] = [];
  if (!v2 && source.memory !== undefined) {
    const document = normalizeLegacyMemoryDocument(source.memory);
    validateMemoryReferences(document, root); legacy.push(document);
  }
  if (!v2) for (const context of contexts.slice(1)) {
    if ("memory" in context && context.memory !== undefined) legacy.push(normalizeLegacyMemoryDocument(context.memory));
  }
  const document = v2 ?? collectLegacyMemory(legacy);
  if (v2) {
    const checkHead = (tick: number, ordinal: number): void => {
      if (tick > v2.worldlineHead.tick || (tick === v2.worldlineHead.tick && ordinal > v2.worldlineHead.ordinal)) invalidMemory("Memory source head precedes a recorded cursor.");
    };
    for (const cursor of domainCursors) checkHead(cursor.tick, cursor.ordinal);
    for (const row of [...document.conclusions, ...document.relationshipStates]) checkHead(row.occurredTick, row.occurredOrdinal);
    for (const row of document.snapshots) checkHead(row.cursorTick, row.cursorOrdinal);
    for (const context of contexts) {
      for (const row of context.observations?.observations ?? []) checkHead(row.occurredTick, row.occurredOrdinal);
      for (const event of context.record.events) {
        if (isPlainObject(event.payload) && ("worldTick" in event.payload || "worldOrdinal" in event.payload)) {
          checkHead(requireInteger(event.payload.worldTick, "event.worldTick", 0), requireInteger(event.payload.worldOrdinal, "event.worldOrdinal", 0));
        }
      }
    }
  }
  const checkSource = (row: RealmRuntimeSaveMemoryConclusionV1 | RealmRuntimeSaveRelationshipStateV1): void => {
    if (!continuities.has(row.sourceObserverContinuityId)) invalidMemory("Memory observer is outside carried topology.");
    if (row.sourceRecordId === null) return;
    if (!records.has(row.sourceRecordId)) invalidMemory("Memory source Record is not carried.");
    if (row.sourceObservationId === null) return;
    const owner = observations.get(row.sourceObservationId);
    if (!owner || owner.sourceRecordId !== row.sourceRecordId || owner.sourceObserverContinuityId !== row.sourceObserverContinuityId) invalidMemory("Memory source observation ownership does not match.");
  };
  for (const row of document.conclusions) checkSource(row);
  for (const row of document.relationshipStates) checkSource(row);
  const memoryIds = new Map(document.conclusions.map((row) => [row.sourceMemoryId, row]));
  for (const snapshot of document.snapshots) {
    if (!continuities.has(snapshot.sourceObserverContinuityId)) invalidMemory("Memory snapshot observer is outside carried topology.");
    for (const id of snapshot.sourceItemIds) {
      const item = memoryIds.get(id);
      if (!item) invalidMemory("Memory snapshot item is not carried.");
      if (item.sourceObserverContinuityId !== snapshot.sourceObserverContinuityId) invalidMemory("Memory snapshot item observer does not match.");
    }
  }
  const effectiveEpochs = v2?.cacheEpochs ?? legacyMemoryEpochs(document.snapshots, continuities.keys());
  const epochs = new Map(effectiveEpochs.map((row) => [row.sourceObserverContinuityId, row.epoch]));
  if (epochs.size !== continuities.size || [...continuities.keys()].some((id) => !epochs.has(id))) invalidMemory("Memory current epoch observers do not match carried topology.");
  for (const snapshot of document.snapshots) {
    if (epochs.get(snapshot.sourceObserverContinuityId)! < snapshot.cacheEpoch) invalidMemory("Memory cache epoch precedes a retained snapshot.");
  }
  return {
    sourceFormat: v2 ? "v2" : "legacy", scope, worldlineHead: v2?.worldlineHead ?? null,
    conclusions: document.conclusions, snapshots: document.snapshots, relationshipStates: document.relationshipStates,
    cacheEpochs: effectiveEpochs, supersedesOrder: orderGlobalMemory(document.conclusions),
    observationOwners: [...observations.values()].sort((a, b) => compareUtf8(a.sourceObservationId, b.sourceObservationId)),
    eventOwners: [...events].sort(([a], [b]) => compareUtf8(a, b)).map(([sourceEventId, sourceRecordId]) => ({ sourceEventId, sourceRecordId })),
  };
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
      if (!characterIds.has(sourceCharacterInstanceId) && continuityIds.has(sourceContinuityId)) {
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
    if(character) {
      const prior=participants.find(p=>p.character?.sourceCharacterInstanceId===character.sourceCharacterInstanceId)?.character;
      if(prior && canonicalJson(prior as unknown as JsonValue)!==canonicalJson(character as unknown as JsonValue)) {
        throw new RealmRuntimeSaveError("INVALID_SAVE","runtime topology character representations conflict");
      }
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

/** V2 is a single global section. Nested bundles keep their original V1
 * contract, and cannot hide a second copy of any Goal fact. */
function validateArchiveGoals(value: unknown, manifest: RealmRuntimeSaveManifestV2,
  record: RealmRuntimeSaveRecordV1, domain?: RealmRuntimeSaveDomainV1): RealmRuntimeSaveGoals {
  if (!isPlainObject(value) || value.schemaVersion !== 2) return validateGoals(value, { ...record.scope, workspaceId: manifest.scope.workspaceId });
  const goals = decodeRealmRuntimeSaveGoalsV2(value);
  const invalid = (): never => { throw new RealmRuntimeSaveError("INVALID_SAVE", "Global Goal owner or event closure is incomplete."); };
  if (goals.workspaceId !== manifest.scope.workspaceId) invalid();
  const records = [record, ...(domain?.records ?? []).map(r => r.bundle.record)];
  const recordByOwner = new Map(records.map(r => [JSON.stringify([r.scope.worldId,r.scope.worldlineId,r.scope.recordId]), r]));
  const worldlines = new Set(records.map(r => JSON.stringify([r.scope.worldId,r.scope.worldlineId])));
  const stories = new Set(domain ? [domain.source.storyId, ...(domain.stories ?? []).map(s => s.id)] : []);
  for (const snapshot of domain?.records ?? []) {
    const legacy = validateGoals(snapshot.bundle.goals);
    if (legacy.instances.length || legacy.assessments.length || legacy.definitions?.length) invalid();
  }
  for (const root of goals.roots) {
    const owner = root.owner;
    if (!worldlines.has(JSON.stringify([owner.worldId,owner.worldlineId]))) invalid();
    if (owner.scopeKind === "record" && !recordByOwner.has(JSON.stringify([owner.worldId,owner.worldlineId,owner.recordId]))) invalid();
    if (owner.scopeKind === "story" && (!domain || owner.worldId !== domain.source.worldId
      || owner.worldlineId !== domain.source.worldlineId || !stories.has(owner.storyId))) invalid();
    for (const instance of root.instances) {
      if (instance.definition.kind !== "content") continue;
      const source = instance.definition.binding.source;
      if (source.sourceKind === "installed" && (!manifest.world || source.sourceWorldId !== manifest.world.worldId
        || source.sourceWorldVersion !== manifest.world.worldVersion)) invalid();
    }
  }
  const requireEvent = (ref: {worldId:string;worldlineId:string;recordId:string;eventId:string}) => {
    const owner = recordByOwner.get(JSON.stringify([ref.worldId,ref.worldlineId,ref.recordId]));
    if (!owner || !owner.events.some(e => e.eventId === ref.eventId)) invalid();
  };
  for (const assessment of goals.assessments) {
    requireEvent(assessment.sourceEvent);
    assessment.evidenceEvents.forEach(requireEvent);
  }
  return goals;
}

function buildRuntimeFiles(
  manifest: RealmRuntimeSaveManifestV2,
  record: RealmRuntimeSaveRecordV1,
  goals: RealmRuntimeSaveGoals,
  topology?: RealmRuntimeSaveTopologyV1,
  actionReceipts?: RealmRuntimeSaveActionReceiptsV1,
  characterEffects?: RealmRuntimeSaveCharacterEffectsV1,
  observations?: RealmRuntimeSaveObservationsV1,
  memory?: RealmRuntimeSaveMemory,
  outbox?: RealmRuntimeSaveOutboxV1,
  firstNight?: RealmRuntimeSaveFirstNightV1,
  selfPlay?: RealmRuntimeSaveSelfPlayV1,
  domain?: RealmRuntimeSaveDomainV1,
  performanceWitnesses?: RuntimePerformanceWitnessesV1,
): ReadonlyMap<string, Uint8Array> {
  // Include the manifest in the existing 256 MiB uncompressed ZIP allowance.
  // Its zero/final hash has the same 64 ASCII bytes, so both producers agree.
  const manifestLedger = new RuntimeSectionWireLedger(MANIFEST_ENTRY, "canonical-runtime");
  manifestLedger.reserve(normalizeManifest(manifest));
  let remainingAggregateBytes = PACK_LIMITS.totalUncompressedMax - manifestLedger.acceptedBytes;
  const files: [string, Uint8Array][] = [];
  const append = (path: string, normalized: unknown): void => {
    const ledger = new RuntimeSectionWireLedger(path, "canonical-runtime", remainingAggregateBytes);
    ledger.reserve(normalized);
    const text = canonicalJson(normalized as JsonValue);
    ledger.verify(Buffer.byteLength(text, "utf8"));
    files.push([path, Buffer.from(text, "utf8")]);
    remainingAggregateBytes -= ledger.acceptedBytes;
  };
  append(RECORD_ENTRY, validateRecord(record, manifest));
  append(GOALS_ENTRY, validateArchiveGoals(goals, manifest, record, domain));
  if (topology) append(TOPOLOGY_ENTRY, validateTopology(topology));
  if (actionReceipts) append(ACTION_RECEIPTS_ENTRY, validateActionReceipts(actionReceipts));
  if (characterEffects) append(CHARACTER_EFFECTS_ENTRY, validateCharacterEffects(characterEffects));
  if (observations) append(OBSERVATIONS_ENTRY, validateObservations(observations));
  if (memory) {
    // Retain the audited MemoryV2 formatter and its emitted-byte verification.
    const normalized = memory.schemaVersion === 2 ? normalizeMemoryV2Document(memory) : validateMemory(memory);
    const ledger = new RuntimeSectionWireLedger(MEMORY_ENTRY, "canonical-runtime", remainingAggregateBytes);
    ledger.reserve(normalized);
    const text = normalized.schemaVersion === 2 ? encodeMemoryV2(normalized) : canonicalJson(normalized as unknown as JsonValue);
    ledger.verify(Buffer.byteLength(text, "utf8"));
    files.push([MEMORY_ENTRY, Buffer.from(text, "utf8")]);
    remainingAggregateBytes -= ledger.acceptedBytes;
  }
  if (outbox) append(OUTBOX_ENTRY, validateOutbox(outbox));
  if (firstNight) append(FIRST_NIGHT_ENTRY, validateFirstNight(firstNight));
  if (selfPlay) append(SELF_PLAY_ENTRY, validateSelfPlay(selfPlay));
  if (domain) {
    const ledger = new RuntimeSectionWireLedger(DOMAIN_ENTRY, "normalized-domain", remainingAggregateBytes);
    const text = serializeNormalizedRealmRuntimeSaveDomainV1ForArchive(domain, ledger);
    files.push([DOMAIN_ENTRY, Buffer.from(text, "utf8")]);
    remainingAggregateBytes -= ledger.acceptedBytes;
  }
  validateRuntimePerformanceWitnessClosure({ manifest, record, topology, domain, performanceWitnesses });
  if (performanceWitnesses) append(PERFORMANCE_WITNESSES_ENTRY, normalizeRuntimePerformanceWitnesses(performanceWitnesses));
  return new Map(files);
}

export function realmRuntimeSaveManifestFromData(input: {
  performanceWitnesses?: RuntimePerformanceWitnessesV1;
  engineApi: string;
  mode: RealmRuntimeSaveMode;
  world: RealmRuntimeSaveWorldRef | null;
  scope: RealmRuntimeSaveScope;
  record: RealmRuntimeSaveRecordV1;
  goals: RealmRuntimeSaveGoals;
  topology?: RealmRuntimeSaveTopologyV1;
  actionReceipts?: RealmRuntimeSaveActionReceiptsV1;
  characterEffects?: RealmRuntimeSaveCharacterEffectsV1;
  observations?: RealmRuntimeSaveObservationsV1;
  memory?: RealmRuntimeSaveMemory;
  outbox?: RealmRuntimeSaveOutboxV1;
  firstNight?: RealmRuntimeSaveFirstNightV1;
  selfPlay?: RealmRuntimeSaveSelfPlayV1;
  domain?: RealmRuntimeSaveDomainV1;
}): RealmRuntimeSaveManifestV2 {
  if (Object.hasOwn(input, "siblings")) throw new RealmRuntimeSaveError("INVALID_SAVE", "unknown save key archive.siblings");
  const manifest: RealmRuntimeSaveManifestV2 = {
    ...(input.performanceWitnesses ? { performanceWitnessesFormat: { schemaVersion: 1 as const, digest: runtimePerformanceWitnessesDigest(input.performanceWitnesses) } } : {}),
    format: "realm-save", formatVersion: 2,
    engineApi: input.engineApi, mode: input.mode, world: input.world, scope: input.scope,
    snapshot: { recordVersion: input.record.head.recordVersion,
      nextRecordOrdinal: input.record.head.nextRecordOrdinal, runtimeHash: "0".repeat(64) },
  };
  resolveRealmRuntimeSaveArchiveMemory({ manifest, record: input.record,
    topology: input.topology, observations: input.observations, memory: input.memory, domain: input.domain });
  const domain = input.domain === undefined ? undefined : normalizeRealmRuntimeSaveDomainV1(input.domain);
  const files = buildRuntimeFiles(
    manifest,
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
    domain,
    input.performanceWitnesses,
  );
  return {
    ...(manifest.performanceWitnessesFormat ? { performanceWitnessesFormat: manifest.performanceWitnessesFormat } : {}),
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

/** Actual typed identities carried by this archive, never imported map claims. */
export function runtimeFactReplayClosure(
  record: RealmRuntimeSaveRecordV1,
  domain: RealmRuntimeSaveDomainV1,
  topology?: RealmRuntimeSaveTopologyV1,
): ReplayClosure {
  const records = [record, ...(domain.records ?? []).map((snapshot) => snapshot.bundle.record)];
  const topologies = [topology, ...(domain.records ?? []).map((snapshot) => snapshot.bundle.topology)];
  const unique = (values: readonly string[]) => [...new Set(values)].sort();
  return {
    record: unique(records.map((item) => item.scope.recordId)),
    event: unique(records.flatMap((item) => item.events.map((event) => event.eventId))),
    characterInstance: unique(topologies.flatMap((item) => (item?.participants ?? []).flatMap((participant) =>
      participant.character ? [participant.character.sourceCharacterInstanceId] : []))),
    assetDefinition: unique([...domain.characterAssets.map((asset) => asset.assetDefinitionId),
      ...domain.committedFactCommands.flatMap((command) =>
        (command.kind === "inventory_granted" || command.kind === "inventory_adjusted")
        && typeof command.request?.assetDefinitionId === "string" ? [command.request.assetDefinitionId] : [])]),
    scene: [], project: [], financeAccount: [], milestone: [], obligation: [],
  };
}

/** The same source scene selection used by restore, including old archives without topology. */
export function runtimeReplaySourceSceneIds(
  scenes: readonly { sourceSceneId: string }[] | undefined,
  eventSceneIds: readonly string[],
): readonly string[] {
  if (scenes?.length) return scenes.map((scene) => scene.sourceSceneId);
  const ids = [...new Set(eventSceneIds)];
  return ids.length ? ids : ["legacy-scene"];
}

export function runtimeFinanceReplayClosure(
  record: RealmRuntimeSaveRecordV1,
  domain: RealmRuntimeSaveDomainV1,
  topology?: RealmRuntimeSaveTopologyV1,
): ReplayClosure {
  const bundles = [{ record, topology }, ...(domain.records ?? []).map((snapshot) => snapshot.bundle)];
  const unique = (values: readonly string[]) => [...new Set(values)].sort();
  return {
    record: unique(bundles.map((bundle) => bundle.record.scope.recordId)),
    scene: unique(bundles.flatMap((bundle) => runtimeReplaySourceSceneIds(bundle.topology?.scenes,
      bundle.topology?.scenes.length ? [] : bundle.record.events.map((event, index) => normalizeRealmRuntimeSaveEventForRestore(event, index).sourceSceneId)))),
    project: unique(domain.projects.map((project) => project.id)),
    financeAccount: unique(domain.financeAccounts.map((account) => account.id)),
    milestone: unique(domain.milestones.map((milestone) => milestone.id)),
    obligation: unique(domain.obligations.map((obligation) => obligation.id)),
    event: [], characterInstance: [], assetDefinition: [],
  };
}

/**
 * Cross-section closure: every Record/Event identity referenced by the domain
 * section must resolve to the saved Record section or to an explicitly carried
 * sibling Record snapshot (whose bundle carries its full event log), and the
 * domain source scope must match the Record. Runs on both build and parse so
 * hand-built archives fail closed too.
 */
export function validateDomainRecordClosure(
  record: RealmRuntimeSaveRecordV1,
  domain: RealmRuntimeSaveDomainV1,
  topology?: RealmRuntimeSaveTopologyV1,
  workspaceId?: string,
  performanceWitnesses?: RuntimePerformanceWitnessesV1,
): void {
  const invalid = (message: string): never => {
    throw new RealmRuntimeSaveError("INVALID_SAVE", message);
  };
  if (domain.commandMaterializations) {
    for (const row of domain.commandMaterializations.rows) {
      const source = row.recordId === record.scope.recordId ? record : domain.records?.find(r => r.recordId === row.recordId)?.bundle.record;
      if (!source) invalid("command materialization Record closure is missing");
    }
  }
  if (
    domain.source.worldId !== record.scope.worldId
    || domain.source.worldlineId !== record.scope.worldlineId
    || domain.source.recordId !== record.scope.recordId
  ) {
    invalid("runtime domain scope does not match the saved Record");
  }
  if (domain.commandReplayContexts !== undefined || domain.committedFactCommands.some((command) => command.replayLineage !== undefined)
    || domain.financeCommandGroups.some((group) => group.replayLineage !== undefined)) {
    if (!workspaceId) invalid("runtime lineage requires the manifest workspace");
    try {
      const factClosure = runtimeFactReplayClosure(record, domain, topology);
      const financeClosure = domain.commandReplayContexts?.some((context) => context.family === "finance")
        ? runtimeFinanceReplayClosure(record, domain, topology) : undefined;
      const actualClosure = financeClosure ? { ...factClosure, scene: financeClosure.scene, project: financeClosure.project,
        financeAccount: financeClosure.financeAccount, milestone: financeClosure.milestone, obligation: financeClosure.obligation } : factClosure;
      validateReplayBundle(domain.commandReplayContexts ?? [], [
        ...domain.committedFactCommands.filter((command) => command.replayLineage !== undefined)
          .map((command) => ({ id: command.id, family: "fact", requestFingerprint: command.requestFingerprint, replayLineage: command.replayLineage })),
        ...domain.financeCommandGroups.filter((group) => group.replayLineage !== undefined)
          .map((group) => ({ id: group.id, family: "finance", requestFingerprint: group.requestFingerprint, replayLineage: group.replayLineage })),
      ], { workspaceId: workspaceId!, worldId: record.scope.worldId, worldlineId: record.scope.worldlineId }, actualClosure);
    } catch { invalid("runtime lineage does not match the actual archive scope and closure"); }
  }
  const recordEventIds = new Set(record.events.map((event) => event.eventId));
  const eventScope = new Set(recordEventIds);
  const eventOwners = new Map(record.events.map((event) => [event.eventId, record.scope.recordId]));
  for (const snapshot of (domain.records ?? [])) {
    validateGoals(snapshot.bundle.goals, workspaceId === undefined ? undefined : {
      ...snapshot.bundle.record.scope, workspaceId,
    });
    if (snapshot.bundle.record.scope.recordId !== snapshot.recordId) {
      invalid("runtime domain sibling Record bundle scope does not match its snapshot");
    }
    for (const event of snapshot.bundle.record.events) {
      if (eventScope.has(event.eventId)) invalid("runtime domain sibling Record event duplicates another Record event");
      eventScope.add(event.eventId);
      eventOwners.set(event.eventId, snapshot.recordId);
    }
  }
  const requireEvent = (value: string | null) => {
    if (value !== null && !eventScope.has(value)) invalid("runtime domain references an unknown event");
  };
  for (const milestone of domain.milestones) {
    requireEvent(milestone.completionEventId);
  }
  for (const entry of domain.ledgerEntries) {
    requireEvent(entry.sourceEventId);
  }
  for (const node of domain.storyNodes) {
    node.unlockEvidenceEventIds.forEach((id) => requireEvent(id));
  }
  for (const unlock of domain.storyUnlockLedger) {
    unlock.evidenceEventIds.forEach((id) => requireEvent(id));
  }
  for (const assessment of domain.performanceAssessments) {
    assessment.evidenceEventIds.forEach((id) => requireEvent(id));
    if (assessment.evidenceEventIds.some((id) => eventOwners.get(id) !== assessment.recordId)) {
      invalid("runtime domain assessment evidence belongs to another Record");
    }
  }
  for (const revision of domain.memberRelationshipRevisions) {
    requireEvent(revision.sourceEventId);
  }
  try {
    validatePerformanceSourceConsistency(record, domain, runtimeFactReplayClosure(record, domain, topology), workspaceId, performanceWitnesses);
  } catch (error) {
    invalid(error instanceof Error ? error.message : "Runtime performance source facts are inconsistent.");
  }
  // Record-level references are closed inside the domain parser against the
  // carried stories/records; character assets additionally resolve their
  // character instance against the owning Record's carried topology (the
  // saved Record's archive topology or the sibling's bundle topology).
  const characterTopology = new Map<string, Set<string>>([
    [
      record.scope.recordId,
      new Set(
        (topology?.participants ?? [])
          .flatMap((participant) => participant.character ? [participant.character.sourceCharacterInstanceId] : []),
      ),
    ],
  ]);
  for (const snapshot of (domain.records ?? [])) {
    characterTopology.set(
      snapshot.recordId,
      new Set(
        (snapshot.bundle.topology?.participants ?? [])
          .flatMap((participant) => participant.character ? [participant.character.sourceCharacterInstanceId] : []),
      ),
    );
  }
  for (const asset of domain.characterAssets) {
    const instances = characterTopology.get(asset.recordId);
    if (instances === undefined) {
      invalid("runtime domain character assets reference an unknown Record");
      continue;
    }
    if (!instances.has(asset.characterInstanceId)) {
      invalid("runtime domain character assets reference an unknown character instance");
    }
  }
}

/** Finalize zipSync-owned ZIP32 only; NOT an untrusted-input ZIP validator.
 * Enforce the consumer's compressed payload sum without inflation or counting
 * ZIP framing. Include any MemoryV2 ratio padding before allocating it.
 * Prefixing empty non-final DEFLATE blocks leaves decoded bytes/CRC/hash intact;
 * V1/small V2 archive bytes remain unchanged when already within budget.
 */
export function finalizeRealmRuntimeSaveZip(bytes:Uint8Array,padMemoryV2:boolean):Uint8Array {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const end=bytes.length-22,central=view.getUint32(end+16,true),count=view.getUint16(end+10,true);
  const entries:{at:number;local:number;compressed:number;uncompressed:number;name:string}[]=[];
  for(let at=central,index=0;index<count;index++){
    const nameLength=view.getUint16(at+28,true),extra=view.getUint16(at+30,true),comment=view.getUint16(at+32,true);
    entries.push({at,local:view.getUint32(at+42,true),compressed:view.getUint32(at+20,true),uncompressed:view.getUint32(at+24,true),
      name:new TextDecoder().decode(bytes.subarray(at+46,at+46+nameLength))});
    at+=46+nameLength+extra+comment;
  }
  const memory=padMemoryV2?entries.find(entry=>entry.name===MEMORY_ENTRY):undefined;
  const padding=memory&&memory.uncompressed/memory.compressed>PACK_LIMITS.ratioMax
    ?5*Math.ceil((memory.uncompressed/PACK_LIMITS.ratioMax-memory.compressed)/5):0;
  const totalCompressed=entries.reduce((sum,entry)=>sum+entry.compressed,0)+padding;
  if(totalCompressed>PACK_LIMITS.entryCompressedMax){
    throw new RealmRuntimeSaveError("INVALID_SAVE","runtime save total compressed size exceeds limit");
  }
  if(!memory||padding===0)return bytes;
  const start=memory.local+30+view.getUint16(memory.local+26,true)+view.getUint16(memory.local+28,true);
  const output=new Uint8Array(bytes.length+padding);output.set(bytes.subarray(0,start));
  for(let at=start;at<start+padding;at+=5)output.set([0,0,0,255,255],at);
  output.set(bytes.subarray(start),start+padding);
  const result=new DataView(output.buffer);
  result.setUint32(memory.local+18,memory.compressed+padding,true);
  for(const entry of entries){
    const at=entry.at+padding;
    if(entry===memory)result.setUint32(at+20,entry.compressed+padding,true);
    if(entry.local>=start)result.setUint32(at+42,entry.local+padding,true);
  }
  result.setUint32(end+padding+16,central+padding,true);
  return output;
}

export function buildRealmRuntimeSaveArchive(input: {
  performanceWitnesses?: RuntimePerformanceWitnessesV1;
  manifest: RealmRuntimeSaveManifestV2;
  record: RealmRuntimeSaveRecordV1;
  goals: RealmRuntimeSaveGoals;
  topology?: RealmRuntimeSaveTopologyV1;
  actionReceipts?: RealmRuntimeSaveActionReceiptsV1;
  characterEffects?: RealmRuntimeSaveCharacterEffectsV1;
  observations?: RealmRuntimeSaveObservationsV1;
  memory?: RealmRuntimeSaveMemory;
  outbox?: RealmRuntimeSaveOutboxV1;
  firstNight?: RealmRuntimeSaveFirstNightV1;
  selfPlay?: RealmRuntimeSaveSelfPlayV1;
  domain?: RealmRuntimeSaveDomainV1;
}): Uint8Array {
  if (Object.hasOwn(input, "siblings")) throw new RealmRuntimeSaveError("INVALID_SAVE", "unknown save key archive.siblings");
  const manifest = normalizeManifest(input.manifest);
  const record = validateRecord(input.record, manifest);
  const goals = input.goals.schemaVersion === 2 ? decodeRealmRuntimeSaveGoalsV2(input.goals)
    : validateGoals(input.goals,{...record.scope,workspaceId:manifest.scope.workspaceId});
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
  const memoryV2Input = input.memory?.schemaVersion === 2
    ? normalizeRealmRuntimeSaveMemoryV2(input.memory)
    : undefined;
  const memoryV1 = input.memory !== undefined && memoryV2Input === undefined
    ? validateMemory(input.memory)
    : undefined;
  if (memoryV1) {
    validateMemoryReferences(memoryV1, { record, topology, observations });
  }
  const outbox = input.outbox === undefined ? undefined : validateOutbox(input.outbox);
  if (outbox) {
    validateOutboxReferences(outbox, record);
  }
  const firstNight = input.firstNight === undefined ? undefined : validateFirstNight(input.firstNight);
  const selfPlay = input.selfPlay === undefined ? undefined : validateSelfPlay(input.selfPlay);
  const domain = input.domain === undefined ? undefined : normalizeRealmRuntimeSaveDomainV1(input.domain);
  if (domain?.commandMaterializations && (!manifest.world || manifest.world.worldVersion !== domain.commandMaterializations.worldVersion)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "command materializations require the exact package binding");
  }
  const performanceWitnesses = input.performanceWitnesses === undefined ? undefined : normalizeRuntimePerformanceWitnesses(input.performanceWitnesses);
  validateRuntimePerformanceWitnessClosure({ manifest, record, topology, domain, performanceWitnesses });
  if (domain) validateDomainRecordClosure(record, domain, topology, manifest.scope.workspaceId, performanceWitnesses);
  const resolvedMemory = resolveRealmRuntimeSaveArchiveMemory({
    manifest, record, topology, observations, memory: memoryV2Input ?? memoryV1, domain,
  });
  const memory: RealmRuntimeSaveMemory | undefined = memoryV1 ?? (memoryV2Input !== undefined ? {
    format: "realm-runtime-memory",
    schemaVersion: 2,
    scope: resolvedMemory.scope,
    worldlineHead: resolvedMemory.worldlineHead!,
    conclusions: resolvedMemory.conclusions,
    snapshots: resolvedMemory.snapshots,
    relationshipStates: resolvedMemory.relationshipStates,
    cacheEpochs: resolvedMemory.cacheEpochs,
  } as RealmRuntimeSaveMemoryV2 : undefined);
  const files = buildRuntimeFiles(
    manifest, record, goals, topology, actionReceipts, characterEffects, observations, memory,
    outbox, firstNight, selfPlay, domain, performanceWitnesses,
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
  if (performanceWitnesses) entries[PERFORMANCE_WITNESSES_ENTRY] = [files.get(PERFORMANCE_WITNESSES_ENTRY)!, { level: 6, mtime: new Date(1980, 0, 1) }];
  const bytes=zipSync(entries);
  return finalizeRealmRuntimeSaveZip(bytes,memory?.schemaVersion===2);
}

export function parseRealmRuntimeSaveArchive(bytes: Uint8Array, options: { goalsSchemaVersion: 2 }): RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>;
export function parseRealmRuntimeSaveArchive(bytes: Uint8Array, options?: { goalsSchemaVersion?: 1 }): RealmRuntimeSaveArchive;
export function parseRealmRuntimeSaveArchive(bytes: Uint8Array, options?: { goalsSchemaVersion?: 1 | 2 }): RealmRuntimeSaveArchive<RealmRuntimeSaveGoals> {
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
  // Existing consumers retain V1 until they explicitly support typed globals.
  // A legacy caller must never consume a V2 archive through a V1 return type.
  const isGoalsV2 = isPlainObject(goalsRaw) && goalsRaw.schemaVersion === 2;
  if (isGoalsV2 && options?.goalsSchemaVersion !== 2) throw new RealmRuntimeSaveError("INVALID_SAVE", "Goal schema version is unsupported by this consumer");
  const goals = isGoalsV2 ? decodeRealmRuntimeSaveGoalsV2(goalsRaw)
    : validateGoals(goalsRaw,{...record.scope,workspaceId:manifest.scope.workspaceId});
  const topology = topologyRaw === undefined ? undefined : validateTopology(topologyRaw);
  const actionReceipts = actionReceiptsRaw === undefined ? undefined : validateActionReceipts(actionReceiptsRaw);
  const characterEffects = characterEffectsRaw === undefined ? undefined : validateCharacterEffects(characterEffectsRaw);
  const observations = observationsRaw === undefined ? undefined : validateObservations(observationsRaw);
  const memoryV2Input = isPlainObject(memoryRaw) && memoryRaw.schemaVersion === 2
    ? normalizeRealmRuntimeSaveMemoryV2(memoryRaw)
    : undefined;
  const memoryV1 = memoryRaw !== undefined && memoryV2Input === undefined
    ? validateMemory(memoryRaw)
    : undefined;
  if (memoryV1) {
    validateMemoryReferences(memoryV1, { record, topology, observations });
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
  let performanceWitnesses: RuntimePerformanceWitnessesV1 | undefined;
  if (files.has(PERFORMANCE_WITNESSES_ENTRY)) {
    try { performanceWitnesses = normalizeRuntimePerformanceWitnesses(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files.get(PERFORMANCE_WITNESSES_ENTRY)!))); }
    catch { throw new RealmRuntimeSaveError("INVALID_SAVE", "Private performance witness family is invalid."); }
  }
  validateRuntimePerformanceWitnessClosure({ manifest, record, topology, domain, performanceWitnesses });
  if (goals.schemaVersion === 2) validateArchiveGoals(goals, manifest, record, domain);
  if (domain?.commandMaterializations && (!manifest.world || manifest.world.worldVersion !== domain.commandMaterializations.worldVersion)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "command materializations require the exact package binding");
  }
  if (domain) validateDomainRecordClosure(record, domain, topology, manifest.scope.workspaceId, performanceWitnesses);
  const resolvedMemory = resolveRealmRuntimeSaveArchiveMemory({
    manifest, record, topology, observations, memory: memoryV2Input ?? memoryV1, domain,
  });
  const memory: RealmRuntimeSaveMemory | undefined = memoryV1 ?? (memoryV2Input !== undefined ? {
    format: "realm-runtime-memory",
    schemaVersion: 2,
    scope: resolvedMemory.scope,
    worldlineHead: resolvedMemory.worldlineHead!,
    conclusions: resolvedMemory.conclusions,
    snapshots: resolvedMemory.snapshots,
    relationshipStates: resolvedMemory.relationshipStates,
    cacheEpochs: resolvedMemory.cacheEpochs,
  } as RealmRuntimeSaveMemoryV2 : undefined);
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
    ...(performanceWitnesses ? { performanceWitnesses } : {}),
  };
}

/**
 * A complete Record bundle carried inside a runtime-save domain section: the
 * same per-section documents the archive itself stores, validated by the same
 * production validators. Used for sibling Record snapshots (multi-Record
 * Story/worldline closure) — never an evidence-only stub.
 */
export interface RealmRuntimeSaveRecordBundleV1 {
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
}

/**
 * Validate a domain-carried sibling Record bundle against its declared source
 * scope. The bundle's record.head is authoritative (no manifest snapshot);
 * every section runs through the same validators as the archive entries.
 */
export function validateRealmRuntimeSaveRecordBundle(
  value: unknown,
  scope: { worldId: string; worldlineId: string; recordId: string },
): RealmRuntimeSaveRecordBundleV1 {
  if (!isPlainObject(value)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "domain record bundle must be an object");
  }
  assertExactKeys(
    value,
    ["record", "goals", "topology", "actionReceipts", "characterEffects", "observations", "memory", "outbox", "firstNight", "selfPlay"],
    "domain record bundle",
  );
  const recordRaw = requireField(value, "record", "domain record bundle");
  if (!isPlainObject(recordRaw) || !isPlainObject(recordRaw.head)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", "domain record bundle record is invalid");
  }
  const head = {
    recordVersion: requireInteger(
      requireField(recordRaw.head, "recordVersion", "domain record bundle record.head"),
      "domain record bundle record.head.recordVersion",
      0,
    ),
    nextRecordOrdinal: requireInteger(
      requireField(recordRaw.head, "nextRecordOrdinal", "domain record bundle record.head"),
      "domain record bundle record.head.nextRecordOrdinal",
      0,
    ),
  };
  const record = validateRecordDocument(recordRaw, { scope: { ...scope }, head });
  const goalsRaw = requireField(value, "goals", "domain record bundle");
  const goals = validateGoals(goalsRaw);
  const topology = value.topology === undefined ? undefined : validateTopology(value.topology);
  const actionReceipts = value.actionReceipts === undefined ? undefined : validateActionReceipts(value.actionReceipts);
  const characterEffects = value.characterEffects === undefined ? undefined : validateCharacterEffects(value.characterEffects);
  const observations = value.observations === undefined ? undefined : validateObservations(value.observations);
  const memory = value.memory === undefined ? undefined : validateMemory(value.memory);
  if (memory) {
    validateMemoryReferences(memory, { record, topology, observations });
  }
  const outbox = value.outbox === undefined ? undefined : validateOutbox(value.outbox);
  if (outbox) {
    validateOutboxReferences(outbox, record);
  }
  const firstNight = value.firstNight === undefined ? undefined : validateFirstNight(value.firstNight);
  const selfPlay = value.selfPlay === undefined ? undefined : validateSelfPlay(value.selfPlay);
  return {
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
  };
}
