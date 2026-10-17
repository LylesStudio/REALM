import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import {
  buildRealmRuntimeSaveArchive,
  normalizeRealmRuntimeSaveEventForRestore,
  realmRuntimeSaveManifestFromData,
  RealmRuntimeSaveError,
  type RealmRuntimeSaveActionReceiptsV1,
  type RealmRuntimeSaveArchive,
  type RealmRuntimeSaveCharacterEffectsV1,
  type RealmRuntimeSaveFirstNightV1,
  type RealmRuntimeSaveGoalsV1,
  type RealmRuntimeSaveMemoryV1,
  type RealmRuntimeSaveObservationsV1,
  type RealmRuntimeSaveOutboxV1,
  type RealmRuntimeSaveRecordV1,
  type RealmRuntimeSaveEventV1,
  type RealmRuntimeSaveRestorableEvent,
  type RealmRuntimeSaveSelfPlayV1,
  type RealmRuntimeSaveTopologyV1,
} from "../../modules/world-transfer/realm-runtime-save.ts";
import type { RealmRuntimeSaveDomainV1 } from "../../modules/world-transfer/realm-runtime-domain-save.ts";
import {
  storyNodeInstanceIdFor,
  storyUnlockIdempotencyKeyFor,
  storyUnlockLedgerIdFor,
} from "../../modules/story-graph/public.ts";
import {
  LOCAL_WORLD_VERSION,
} from "../../modules/world-transfer/realm-save.ts";
import type { JsonValue } from "../../modules/runtime/public.ts";
import {decodeRecordGoalDefinition,rebaseRecordGoalDefinitions,type RecordGoalDefinitionVersion} from '../../modules/goals/record-authoring.ts';
import {rebaseNarrativeState} from '../../modules/application/narrative-situation.ts';
import {rebuildRecordNarrativeState} from './narrative-situation-repository.ts';
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export type RealmRuntimeSaveRepositoryErrorCode =
  | "RECORD_NOT_FOUND"
  | "RECORD_ARCHIVED"
  | "WORLD_NOT_FOUND"
  | "WORLD_ARCHIVED"
  | "WORLD_READ_ONLY"
  | "WORLD_VERSION_MISMATCH"
  | "RESTORE_INVALID_TARGET"
  | "RESTORE_ID_COLLISION"
  | "RESTORE_CONFLICT"
  | "REALMWORLD_VALIDATION_UNAVAILABLE"
  | "REALMWORLD_PACKAGE_MISSING"
  | "REALMWORLD_PACKAGE_UNTRUSTED"
  | "REALMWORLD_IDENTITY_MISMATCH"
  | "BASE_VERSION_INCOMPATIBLE"
  | "RUNTIME_SAVE_INVALID"
  | "RUNTIME_SAVE_FAILED";

export class RealmRuntimeSaveRepositoryError extends Error {
  readonly code: RealmRuntimeSaveRepositoryErrorCode;

  constructor(code: RealmRuntimeSaveRepositoryErrorCode, message: string) {
    super(message);
    this.name = "RealmRuntimeSaveRepositoryError";
    this.code = code;
  }
}

export interface RealmRuntimeSaveReader {
  load(input: {
    workspaceId: string;
    recordId: string;
    /** HTTP downloads contain private backup data; verify owner in the read transaction. */
    principalId?: string;
  }): Promise<RealmRuntimeSaveArchive | null>;
}

export interface RealmRuntimeSaveRestoreInput {
  workspaceId: string;
  principalId: string;
  sessionProof?: string;
  archive: RealmRuntimeSaveArchive;
  /** Required for base saves; world-bound saves must match manifest.world.worldId. */
  targetWorldId?: string;
  /** Same archive + target + key deterministically replays the same restore. */
  idempotencyKey: string;
  recordTitle?: string;
  storyTitle?: string;
  /** Server-only current-head snapshot branch; never accepted by the restore HTTP route. */
  branch?: {sourceRecordId:string;sourceWorldlineId:string;fork:{tick:number;ordinal:number};label:string;premise:string};
}

export interface RealmRuntimeSaveRestoreResult {
  worldId: string;
  worldVersion: string;
  worldlineId: string;
  storyId: string;
  recordId: string;
  importedEventCount: number;
  importedGoalInstanceCount: number;
  importedAssessmentCount: number;
  importedActionReceiptCount: number;
  importedCharacterEffectCount: number;
  importedObservationCount: number;
  importedMemoryConclusionCount: number;
  importedMemorySnapshotCount: number;
  importedRelationshipStateCount: number;
  importedOutboxMessageCount: number;
  importedFirstNightCount: number;
  importedSelfPlaySessionCount: number;
  importedDomainProjectCount: number;
  importedDomainLedgerEntryCount: number;
  importedDomainStoryNodeCount: number;
  importedDomainUnlockCount: number;
  importedDomainFactCommandCount: number;
  importedDomainAssessmentCount: number;
  importedDomainRelationshipRevisionCount: number;
  importedDomainAssetCount: number;
  warnings: readonly ["WORLD_VERSION_MISMATCH"] | readonly [];
  replayed: boolean;
}

export interface RealmRuntimeSaveRestorer {
  restore(input: RealmRuntimeSaveRestoreInput): Promise<RealmRuntimeSaveRestoreResult>;
}

/**
 * Archive-carried WorldBinding that a world-bound restore must prove against
 * an installed, trusted RealmWorld package before any restore write.
 */
export interface RealmRuntimeSaveWorldBinding {
  worldId: string;
  worldVersion: string;
}

/**
 * Production boundary hook: verifies that the exact archive binding is an
 * installed, signature-valid, content-hash-valid, currently trusted
 * RealmWorld package (read-only mount; never installs/writes/executes).
 * Implementations fail closed by throwing RealmRuntimeSaveRepositoryError
 * with a stable machine code; any other throw is mapped to
 * REALMWORLD_PACKAGE_UNTRUSTED without leaking raw details.
 */
export type RealmRuntimeSaveWorldBindingValidator = (
  binding: RealmRuntimeSaveWorldBinding,
) => Promise<void>;

export interface RealmRuntimeSaveRestorerOptions {
  /**
   * Required for world-bound saves: without it a world-bound restore fails
   * closed (REALMWORLD_VALIDATION_UNAVAILABLE) so direct restorer use cannot
   * bypass package trust verification. Base saves never invoke it.
   */
  validateWorldBinding?: RealmRuntimeSaveWorldBindingValidator;
  /**
   * Base→world-bound 升级路径（Slice 5）：base 存档显式恢复到非 base 版本
   * 的目标 World 时，在任何写入前验证目标精确 binding（已安装、验签/
   * content-hash 有效、当前可信且 engineCompat.baseRange 兼容活动 base
   * 版本）。base→base 恢复绝不调用；缺 seam 而目标 world-bound 时
   * fail-closed（REALMWORLD_VALIDATION_UNAVAILABLE）。
   */
  validateUpgradeTarget?: RealmRuntimeSaveWorldBindingValidator;
}

interface RecordRow extends QueryResultRow {
  world_id: string;
  worldline_id: string;
  record_id: string;
  story_id: string;
  world_version: string;
  record_version: string | number;
  next_record_ordinal: string | number;
}

interface EventRow extends QueryResultRow {
  id: string;
  record_version: string | number;
  record_ordinal: string | number;
  event_kind: string;
  payload: unknown;
  content: string;
  speaker_name: string;
  actor_participant_id: string | null;
  scene_id: string;
  visibility_policy_id: string;
  world_tick: string | number;
  world_ordinal: string | number;
  calendar_id: string;
  display_time: string;
}

interface GoalInstanceRow extends QueryResultRow {
  id: string;
  goal_key: string;
  state: string;
  revision: string | number;
  progress: unknown;
  outcome: unknown;
  policy_version: string;
  definition_source: 'content' | 'record';
  definition_id: string | null;
  resolution_kind: 'natural' | 'withdrawn' | 'superseded';
  evidence_start_version: string | number;
  evidence_start_ordinal: string | number;
  attempt: number;
  supersedes_instance_id: string | null;
}

interface GoalAssessmentRow extends QueryResultRow {
  id: string;
  goal_instance_id: string;
  source_event_id: string;
  source: string;
  status: string;
  result: unknown;
  evidence_event_ids: string[];
  evidence_head_version: string | number | null;
  evidence_head_ordinal: string | number | null;
  evidence_snapshot_hash: string;
  policy_version: string;
}

interface ParticipantTopologyRow extends QueryResultRow {
  participant_id: string;
  participant_kind: "character" | "narrator";
  participant_character_instance_id: string | null;
  participant_principal_id: string | null;
  participant_controller_mode: "human" | "ai" | "hybrid";
  participant_is_active: boolean;
  participant_speaking_order: string | number;
  participant_shared_control_enabled: boolean;
  instance_id: string | null;
  instance_continuity_id: string | null;
  instance_predecessor_id: string | null;
  instance_controller_mode: "human" | "ai" | "hybrid" | null;
  instance_status: "planned" | "present" | "absent" | "retired" | null;
  instance_instantiated_tick: string | number | null;
  instance_instantiated_ordinal: string | number | null;
  instance_inheritance_cutoff_tick: string | number | null;
  instance_inheritance_cutoff_ordinal: string | number | null;
  instance_retired_tick: string | number | null;
  instance_retired_ordinal: string | number | null;
  instance_state: unknown;
  continuity_key: string | null;
  continuity_status: "active" | "inactive" | "ended" | null;
  continuity_born_tick: string | number | null;
  continuity_born_ordinal: string | number | null;
  continuity_ended_tick: string | number | null;
  continuity_ended_ordinal: string | number | null;
  definition_id: string | null;
  definition_display_name: string | null;
  definition_source_format: "native" | "sillytavern_character_card" | null;
  definition_profile: unknown;
}

interface SceneTopologyRow extends QueryResultRow {
  scene_id: string;
  title: string;
  status: "planned" | "active" | "closed" | "cancelled";
  location: string;
  objective: string;
  tension: string;
  weather: string;
  display_time: string;
  start_tick: string | number;
  start_ordinal: string | number;
  end_tick: string | number | null;
  end_ordinal: string | number | null;
}

interface VisibilityPolicyTopologyRow extends QueryResultRow {
  policy_id: string;
  policy_key: string;
  policy_version: string | number;
  policy_kind: "public" | "scene" | "restricted" | "private" | "dm_only";
  scene_id: string | null;
  restricted_domain_id: string | null;
  private_character_instance_id: string | null;
  audience_character_instance_ids: string[];
}

interface ActionReceiptRow extends QueryResultRow {
  id: string;
  transaction_id: string;
  call_fingerprint: string;
  actor_character_instance_id: string;
  source_event_id: string;
  receipt: unknown;
  world_tick: string | number;
  world_ordinal: string | number;
  recorded_at: Date | string;
}

interface CharacterEffectRow extends QueryResultRow {
  id: string;
  character_instance_id: string;
  effect_definition_id: string;
  effect_key: string;
  source_action_receipt_id: string;
  status: "active" | "expired" | "removed";
  applied_tick: string | number;
  applied_ordinal: string | number;
  ended_tick: string | number | null;
  ended_ordinal: string | number | null;
  revision: string | number;
  metadata: unknown;
}

interface ObservationRow extends QueryResultRow {
  id: string;
  observer_character_instance_id: string;
  source_event_id: string | null;
  dedupe_key: string;
  observation_kind: "direct" | "inferred" | "rumor" | "system_grant";
  content: string;
  fidelity: string | number;
  occurred_tick: string | number;
  occurred_ordinal: string | number;
  available_from_tick: string | number;
  available_from_ordinal: string | number;
  learned_at: Date | string;
  metadata: unknown;
}

interface MemoryConclusionRow extends QueryResultRow {
  id: string;
  observer_continuity_id: string;
  observed_entity_key: string;
  source_record_id: string | null;
  source_observation_id: string | null;
  supersedes_memory_id: string | null;
  operation: "add" | "update" | "retract";
  memory_kind: "explicit" | "inferred" | "summary" | "preference" | "relationship";
  content: string;
  keywords: string[];
  semantic_embedding: string;
  embedding_model: string;
  fidelity: string | number;
  occurred_tick: string | number;
  occurred_ordinal: string | number;
  available_from_tick: string | number;
  available_from_ordinal: string | number;
  metadata: unknown;
}

interface MemorySnapshotRow extends QueryResultRow {
  id: string;
  observer_continuity_id: string;
  snapshot_kind: "representation" | "recall";
  content: string;
  item_ids: string[];
  cursor_tick: string | number;
  cursor_ordinal: string | number;
  cache_epoch: string | number;
  token_count: string | number;
}

interface RelationshipStateRow extends QueryResultRow {
  observer_continuity_id: string;
  target_entity_key: string;
  relation_kind: "trust" | "hostile" | "alliance" | "kinship" | "debt" | "acquaintance" | "note";
  content: string;
  fidelity: string | number;
  source_record_id: string | null;
  source_observation_id: string | null;
  occurred_tick: string | number;
  occurred_ordinal: string | number;
  available_from_tick: string | number;
  available_from_ordinal: string | number;
}

interface OutboxRow extends QueryResultRow {
  id: string;
  dedupe_key: string;
  topic: string;
  payload: unknown;
  state: "pending" | "delivering" | "retryable" | "failed";
  attempt_count: string | number;
  available_at: Date | string;
  event_id: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_at: Date | string | null;
}

interface FirstNightRow extends QueryResultRow {
  state: "pending" | "ready" | "degraded";
  attempts: string | number;
  hook_content: string;
  suggestions: string[];
  context: unknown;
}

interface SelfPlaySessionRow extends QueryResultRow {
  id: string;
  state: "running" | "stopping" | "completed" | "failed" | "cancelled";
  beat_budget: string | number;
  beats_completed: string | number;
  requested_by: string;
  last_error: string | null;
}

interface DomainProjectRow extends QueryResultRow {
  id: string;
  kind: "production" | "campaign" | "operation" | "initiative";
  status: "planned" | "active" | "completed" | "cancelled" | "archived";
  stage: "planning" | "funding" | "production" | "scheduled" | "delivery" | "closed";
  title: string;
  currency: "JPY";
  deadline: string | null;
  version: string | number;
}

interface DomainMilestoneRow extends QueryResultRow {
  id: string;
  project_id: string;
  sequence: string | number;
  title: string;
  status: "planned" | "active" | "completed" | "cancelled";
  due_on: string | null;
  completion_record_id: string | null;
  completion_event_id: string | null;
}

interface DomainProjectStoryLinkRow extends QueryResultRow {
  id: string;
  project_id: string;
  story_id: string;
  link_kind: "primary" | "related";
}

interface DomainBudgetRow extends QueryResultRow {
  id: string;
  project_id: string;
  category: string;
  amount_minor: string | number;
  currency: "JPY";
  version: string | number;
}

interface DomainAccountRow extends QueryResultRow {
  id: string;
  currency: "JPY";
  status: "active" | "closed";
  opening_balance_minor: string | number;
}

interface DomainLedgerRow extends QueryResultRow {
  id: string;
  account_id: string;
  kind: "income" | "expense" | "adjustment";
  direction: "income" | "expense";
  amount_minor: string | number;
  currency: "JPY";
  category: string;
  memo: string;
  project_id: string | null;
  source_record_id: string | null;
  source_event_id: string | null;
  occurred_at: Date | string;
  idempotency_key: string;
}

interface DomainFinanceGroupRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  request_fingerprint: string;
  state: "committed" | "rejected";
  result_manifest: unknown;
  rejection_code: string | null;
  policy_version: string;
  source_record_id: string | null;
}

interface DomainObligationRow extends QueryResultRow {
  id: string;
  project_id: string | null;
  kind: "loan" | "presale" | "revenue_share";
  status: "open" | "settled" | "cancelled";
  principal_minor: string | number;
  outstanding_minor: string | number;
  share_bps: string | number | null;
  undelivered_count: string | number;
  due_on: string | null;
  version: string | number;
}

interface DomainSettlementRow extends QueryResultRow {
  id: string;
  obligation_id: string;
  ledger_entry_id: string | null;
  kind: "repayment" | "draw" | "share";
  amount_minor: string | number;
}

interface DomainStoryNodeRow extends QueryResultRow {
  id: string;
  node_key: string;
  state: "locked" | "active" | "completed" | "failed";
  revision: string | number;
  record_id: string | null;
  definition_hash: string;
  unlock_evidence_event_ids: string[];
  unlock_evidence: unknown;
}

interface DomainUnlockRow extends QueryResultRow {
  id: string;
  story_node_instance_id: string;
  node_key: string;
  transition: "unlocked" | "rolled_back";
  idempotency_key: string;
  record_id: string | null;
  evidence_event_ids: string[];
  evidence_hash: string;
  evidence: unknown;
}

interface DomainFactCommandRow extends QueryResultRow {
  id: string;
  idempotency_key: string;
  request_fingerprint: string;
  kind: "inventory_adjusted" | "inventory_granted" | "relationship_revised" | "performance_assessed";
  result_manifest: unknown;
}

interface DomainAssessmentRow extends QueryResultRow {
  id: string;
  record_id: string;
  policy_version: string;
  score: string | number;
  evidence_event_ids: string[];
  evidence_snapshot_hash: string;
  command_id: string;
}

interface DomainRelationshipRow extends QueryResultRow {
  id: string;
  subject_entity_key: string;
  object_entity_key: string;
  relation_kind: string;
  revision_ordinal: string | number;
  source_event_id: string;
  source_record_id: string;
  occurred_tick: string | number;
  occurred_ordinal: string | number;
  command_id: string;
}

interface DomainAssetRow extends QueryResultRow {
  record_id: string;
  character_instance_id: string;
  asset_definition_id: string;
  asset_key: string;
  quantity: string | number;
  revision: string | number;
  metadata: unknown;
}

function saveTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RealmRuntimeSaveRepositoryError(
      "RUNTIME_SAVE_FAILED",
      "Record runtime row carries an invalid timestamp.",
    );
  }
  return date.toISOString();
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object"
    && value !== null
    && Object.values(value).every(isJsonValue);
}

function jsonValue(value: unknown): JsonValue {
  return isJsonValue(value) ? value : {};
}

function jsonObject(value: unknown): Readonly<Record<string, JsonValue>> {
  const normalized = jsonValue(value);
  return typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)
    ? normalized as Readonly<Record<string, JsonValue>>
    : {};
}

function worldRefFromVersion(
  worldId: string,
  worldVersion: string,
): { mode: "base"; world: null } | { mode: "world-bound"; world: { worldId: string; worldVersion: string } } {
  if (worldVersion === LOCAL_WORLD_VERSION) {
    return { mode: "base", world: null };
  }
  return {
    mode: "world-bound",
    world: { worldId, worldVersion },
  };
}

function mapEvent(row: EventRow): RealmRuntimeSaveEventV1 {
  return {
    eventId: row.id,
    recordVersion: Number(row.record_version),
    ordinal: Number(row.record_ordinal),
    kind: row.event_kind,
    payload: {
      content: row.content,
      speakerName: row.speaker_name,
      actorParticipantId: row.actor_participant_id,
      sceneId: row.scene_id,
      visibilityPolicyId: row.visibility_policy_id,
      worldTick: Number(row.world_tick),
      worldOrdinal: Number(row.world_ordinal),
      calendarId: row.calendar_id,
      displayTime: row.display_time,
      eventPayload: jsonObject(row.payload),
    },
  };
}

function mapGoals(
  instances: readonly GoalInstanceRow[],
  assessments: readonly GoalAssessmentRow[],
  definitions: readonly {definition:unknown}[],
): RealmRuntimeSaveGoalsV1 {
  return {
    format: "realm-runtime-goals",
    schemaVersion: 1,
    instances: instances.map((row) => ({
      id: row.id,
      goalKey: row.goal_key,
      state: row.state,
      revision: Number(row.revision),
      progress: jsonObject(row.progress),
      outcome: row.outcome === null ? null : jsonObject(row.outcome),
      policyVersion: row.policy_version,
      ...(row.definition_source === 'record' ? {
        definitionSource: 'record',definitionId:row.definition_id,resolutionKind:row.resolution_kind,
        evidenceStartVersion:Number(row.evidence_start_version),evidenceStartOrdinal:Number(row.evidence_start_ordinal),
        attempt:row.attempt,supersedesInstanceId:row.supersedes_instance_id,
      } : {}),
    }) as JsonValue),
    ...(definitions.length ? {definitions:definitions.map(row=>jsonObject(row.definition) as JsonValue)} : {}),
    assessments: assessments.map((row) => ({
      id: row.id,
      goalInstanceId: row.goal_instance_id,
      sourceEventId: row.source_event_id,
      source: row.source,
      status: row.status,
      result: jsonObject(row.result),
      evidenceEventIds: [...row.evidence_event_ids],
      evidenceHead: row.evidence_head_version === null || row.evidence_head_ordinal === null
        ? null
        : {
            recordVersion: Number(row.evidence_head_version),
            ordinal: Number(row.evidence_head_ordinal),
          },
      evidenceSnapshotHash: row.evidence_snapshot_hash,
      policyVersion: row.policy_version,
    }) as JsonValue),
  };
}

function mapTopology(
  rows: readonly ParticipantTopologyRow[],
  scenes: readonly SceneTopologyRow[],
  visibilityPolicies: readonly VisibilityPolicyTopologyRow[],
): RealmRuntimeSaveTopologyV1 {
  return {
    format: "realm-runtime-topology",
    schemaVersion: 1,
    participants: rows.map((row) => {
      if (
        row.participant_kind === "character"
        && row.instance_id
        && row.instance_continuity_id
        && row.continuity_key !== null
        && row.continuity_status !== null
        && row.definition_id
        && row.definition_display_name
        && row.definition_source_format
        && row.instance_controller_mode
        && row.instance_status
        && row.instance_instantiated_tick !== null
        && row.instance_instantiated_ordinal !== null
        && row.instance_inheritance_cutoff_tick !== null
        && row.instance_inheritance_cutoff_ordinal !== null
        && row.continuity_born_tick !== null
        && row.continuity_born_ordinal !== null
      ) {
        return {
          sourceParticipantId: row.participant_id,
          participantKind: row.participant_kind,
          sourcePrincipalId: row.participant_principal_id,
          controllerMode: row.participant_controller_mode,
          isActive: row.participant_is_active,
          speakingOrder: Number(row.participant_speaking_order),
          sharedControlEnabled: row.participant_shared_control_enabled,
          character: {
            sourceCharacterInstanceId: row.instance_id,
            sourceContinuityId: row.instance_continuity_id,
            sourcePredecessorInstanceId: row.instance_predecessor_id,
            sourceDefinitionId: row.definition_id,
            definition: {
              displayName: row.definition_display_name,
              sourceFormat: row.definition_source_format,
              profile: jsonObject(row.definition_profile),
            },
            continuity: {
              continuityKey: row.continuity_key,
              status: row.continuity_status,
              bornTick: Number(row.continuity_born_tick),
              bornOrdinal: Number(row.continuity_born_ordinal),
              endedTick: row.continuity_ended_tick === null ? null : Number(row.continuity_ended_tick),
              endedOrdinal: row.continuity_ended_ordinal === null ? null : Number(row.continuity_ended_ordinal),
            },
            instance: {
              controllerMode: row.instance_controller_mode,
              status: row.instance_status,
              instantiatedTick: Number(row.instance_instantiated_tick),
              instantiatedOrdinal: Number(row.instance_instantiated_ordinal),
              inheritanceCutoffTick: Number(row.instance_inheritance_cutoff_tick),
              inheritanceCutoffOrdinal: Number(row.instance_inheritance_cutoff_ordinal),
              retiredTick: row.instance_retired_tick === null ? null : Number(row.instance_retired_tick),
              retiredOrdinal: row.instance_retired_ordinal === null ? null : Number(row.instance_retired_ordinal),
              state: jsonObject(row.instance_state),
            },
          },
        };
      }
      if (row.participant_kind !== "narrator" || row.instance_id !== null) {
        throw new RealmRuntimeSaveRepositoryError(
          "RUNTIME_SAVE_FAILED",
          "Record participant topology is incomplete.",
        );
      }
      return {
        sourceParticipantId: row.participant_id,
        participantKind: "narrator" as const,
        sourcePrincipalId: row.participant_principal_id,
        controllerMode: row.participant_controller_mode,
        isActive: row.participant_is_active,
        speakingOrder: Number(row.participant_speaking_order),
        sharedControlEnabled: row.participant_shared_control_enabled,
        character: null,
      };
    }),
    scenes: scenes.map((row) => ({
      sourceSceneId: row.scene_id,
      title: row.title,
      status: row.status,
      location: row.location,
      objective: row.objective,
      tension: row.tension,
      weather: row.weather,
      displayTime: row.display_time,
      startTick: Number(row.start_tick),
      startOrdinal: Number(row.start_ordinal),
      endTick: row.end_tick === null ? null : Number(row.end_tick),
      endOrdinal: row.end_ordinal === null ? null : Number(row.end_ordinal),
    })),
    visibilityPolicies: visibilityPolicies.map((row) => ({
      sourceVisibilityPolicyId: row.policy_id,
      policyKey: row.policy_key,
      policyVersion: Number(row.policy_version),
      policyKind: row.policy_kind,
      sourceSceneId: row.scene_id,
      restrictedDomainId: row.restricted_domain_id,
      sourcePrivateCharacterInstanceId: row.private_character_instance_id,
      sourceAudienceCharacterInstanceIds: [...row.audience_character_instance_ids],
    })),
  };
}

function mapActionReceipts(rows: readonly ActionReceiptRow[]): RealmRuntimeSaveActionReceiptsV1 {
  return {
    format: "realm-runtime-action-receipts",
    schemaVersion: 1,
    receipts: rows.map((row) => ({
      sourceReceiptId: row.id,
      sourceEventId: row.source_event_id,
      sourceActorCharacterInstanceId: row.actor_character_instance_id,
      transactionId: row.transaction_id,
      callFingerprint: row.call_fingerprint,
      receipt: jsonObject(row.receipt),
      worldTick: Number(row.world_tick),
      worldOrdinal: Number(row.world_ordinal),
      recordedAt: saveTimestamp(row.recorded_at),
    })),
  };
}

function mapCharacterEffects(rows: readonly CharacterEffectRow[]): RealmRuntimeSaveCharacterEffectsV1 {
  return {
    format: "realm-runtime-character-effects",
    schemaVersion: 1,
    effects: rows.map((row) => ({
      sourceCharacterEffectId: row.id,
      sourceCharacterInstanceId: row.character_instance_id,
      sourceEffectDefinitionId: row.effect_definition_id,
      effectKey: row.effect_key,
      sourceActionReceiptId: row.source_action_receipt_id,
      status: row.status,
      appliedTick: Number(row.applied_tick),
      appliedOrdinal: Number(row.applied_ordinal),
      endedTick: row.ended_tick === null ? null : Number(row.ended_tick),
      endedOrdinal: row.ended_ordinal === null ? null : Number(row.ended_ordinal),
      revision: Number(row.revision),
      metadata: jsonObject(row.metadata),
    })),
  };
}

function mapObservations(rows: readonly ObservationRow[]): RealmRuntimeSaveObservationsV1 {
  return {
    format: "realm-runtime-observations",
    schemaVersion: 1,
    observations: rows.map((row) => ({
      sourceObservationId: row.id,
      sourceObserverCharacterInstanceId: row.observer_character_instance_id,
      sourceEventId: row.source_event_id,
      dedupeKey: row.dedupe_key,
      observationKind: row.observation_kind,
      content: row.content,
      fidelity: Number(row.fidelity),
      occurredTick: Number(row.occurred_tick),
      occurredOrdinal: Number(row.occurred_ordinal),
      availableFromTick: Number(row.available_from_tick),
      availableFromOrdinal: Number(row.available_from_ordinal),
      learnedAt: saveTimestamp(row.learned_at),
      metadata: jsonObject(row.metadata),
    })),
  };
}

const MEMORY_EMBEDDING_DIMENSIONS = 384;

/**
 * Reads a `vector` column through its canonical text form (`[v0,v1,...]`) and
 * fails closed on anything but 384 finite components — the archive contract
 * carries embeddings as plain number arrays.
 */
function parseVectorLiteral(value: string): number[] {
  const match = /^\[([^\]]*)\]$/.exec(value.trim());
  const components = match?.[1].split(",").map((component) => Number(component.trim())) ?? [];
  if (
    components.length !== MEMORY_EMBEDDING_DIMENSIONS
    || components.some((component) => !Number.isFinite(component))
  ) {
    throw new RealmRuntimeSaveRepositoryError(
      "RUNTIME_SAVE_FAILED",
      "Record memory row carries an invalid semantic embedding.",
    );
  }
  return components;
}

/** Serializes an embedding back into the canonical `vector` SQL literal. */
function saveVectorLiteral(vector: readonly number[]): string {
  if (
    vector.length !== MEMORY_EMBEDDING_DIMENSIONS
    || vector.some((component) => !Number.isFinite(component))
  ) {
    throw new RealmRuntimeSaveRepositoryError(
      "RUNTIME_SAVE_INVALID",
      "Runtime memory embedding must contain 384 finite values.",
    );
  }
  return `[${vector.join(",")}]`;
}

function mapMemory(
  conclusions: readonly MemoryConclusionRow[],
  snapshots: readonly MemorySnapshotRow[],
  relationshipStates: readonly RelationshipStateRow[],
): RealmRuntimeSaveMemoryV1 {
  return {
    format: "realm-runtime-memory",
    schemaVersion: 1,
    conclusions: conclusions.map((row) => ({
      sourceMemoryId: row.id,
      sourceObserverContinuityId: row.observer_continuity_id,
      observedEntityKey: row.observed_entity_key,
      sourceRecordId: row.source_record_id,
      sourceObservationId: row.source_observation_id,
      sourceSupersedesMemoryId: row.supersedes_memory_id,
      operation: row.operation,
      memoryKind: row.memory_kind,
      content: row.content,
      keywords: [...row.keywords],
      semanticEmbedding: parseVectorLiteral(row.semantic_embedding),
      embeddingModel: row.embedding_model,
      fidelity: Number(row.fidelity),
      occurredTick: Number(row.occurred_tick),
      occurredOrdinal: Number(row.occurred_ordinal),
      availableFromTick: Number(row.available_from_tick),
      availableFromOrdinal: Number(row.available_from_ordinal),
      metadata: jsonObject(row.metadata),
    })),
    snapshots: snapshots.map((row) => ({
      sourceSnapshotId: row.id,
      sourceObserverContinuityId: row.observer_continuity_id,
      snapshotKind: row.snapshot_kind,
      content: row.content,
      sourceItemIds: [...row.item_ids],
      cursorTick: Number(row.cursor_tick),
      cursorOrdinal: Number(row.cursor_ordinal),
      cacheEpoch: Number(row.cache_epoch),
      tokenCount: Number(row.token_count),
    })),
    relationshipStates: relationshipStates.map((row) => ({
      sourceObserverContinuityId: row.observer_continuity_id,
      targetEntityKey: row.target_entity_key,
      relationKind: row.relation_kind,
      content: row.content,
      fidelity: Number(row.fidelity),
      sourceRecordId: row.source_record_id,
      sourceObservationId: row.source_observation_id,
      occurredTick: Number(row.occurred_tick),
      occurredOrdinal: Number(row.occurred_ordinal),
      availableFromTick: Number(row.available_from_tick),
      availableFromOrdinal: Number(row.available_from_ordinal),
    })),
  };
}

// Outbox 只归档非终态消息（delivered 已送达，是终态事实，不进存档）；
// lease 与失败细节为存档保真而携带，restore 一律不复制（fresh pending）。
function mapOutbox(rows: readonly OutboxRow[]): RealmRuntimeSaveOutboxV1 {
  return {
    format: "realm-runtime-outbox",
    schemaVersion: 1,
    messages: rows.map((row) => ({
      sourceMessageId: row.id,
      dedupeKey: row.dedupe_key,
      topic: row.topic,
      envelope: jsonObject(row.payload),
      state: row.state,
      deliveryAttempts: Number(row.attempt_count),
      nextAttemptAt: saveTimestamp(row.available_at),
      sourceEventId: row.event_id,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at === null ? null : saveTimestamp(row.lease_expires_at),
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      lastErrorAt: row.last_error_at === null ? null : saveTimestamp(row.last_error_at),
    })),
  };
}

function mapFirstNight(rows: readonly FirstNightRow[]): RealmRuntimeSaveFirstNightV1 {
  const row = rows[0];
  return {
    format: "realm-runtime-first-night",
    schemaVersion: 1,
    entry: row
      ? {
        state: row.state,
        attempts: Number(row.attempts),
        hookContent: row.hook_content,
        suggestions: [...row.suggestions],
        context: jsonObject(row.context),
      }
      : null,
  };
}

function mapSelfPlay(rows: readonly SelfPlaySessionRow[]): RealmRuntimeSaveSelfPlayV1 {
  return {
    format: "realm-runtime-self-play",
    schemaVersion: 1,
    sessions: rows.map((row) => ({
      sourceSessionId: row.id,
      state: row.state,
      beatBudget: Number(row.beat_budget),
      beatsCompleted: Number(row.beats_completed),
      requestedBy: row.requested_by,
      lastError: row.last_error,
    })),
  };
}

interface DomainRows {
  projects: readonly DomainProjectRow[];
  milestones: readonly DomainMilestoneRow[];
  projectStoryLinks: readonly DomainProjectStoryLinkRow[];
  budgetAllocations: readonly DomainBudgetRow[];
  financeAccounts: readonly DomainAccountRow[];
  ledgerEntries: readonly DomainLedgerRow[];
  financeCommandGroups: readonly DomainFinanceGroupRow[];
  obligations: readonly DomainObligationRow[];
  obligationSettlements: readonly DomainSettlementRow[];
  storyNodes: readonly DomainStoryNodeRow[];
  storyUnlockLedger: readonly DomainUnlockRow[];
  committedFactCommands: readonly DomainFactCommandRow[];
  performanceAssessments: readonly DomainAssessmentRow[];
  memberRelationshipRevisions: readonly DomainRelationshipRow[];
  characterAssets: readonly DomainAssetRow[];
}

function mapDomain(
  source: { worldId: string; worldlineId: string; storyId: string; recordId: string },
  rows: DomainRows,
): RealmRuntimeSaveDomainV1 {
  return {
    format: "realm-runtime-domain",
    schemaVersion: 1,
    source,
    projects: rows.projects.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      stage: row.stage,
      title: row.title,
      currency: row.currency,
      deadline: row.deadline,
      version: Number(row.version),
    })),
    milestones: rows.milestones.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      sequence: Number(row.sequence),
      title: row.title,
      status: row.status,
      dueOn: row.due_on,
      completionRecordId: row.completion_record_id,
      completionEventId: row.completion_event_id,
    })),
    projectStoryLinks: rows.projectStoryLinks.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      storyId: row.story_id,
      linkKind: row.link_kind,
    })),
    budgetAllocations: rows.budgetAllocations.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      category: row.category,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      version: Number(row.version),
    })),
    financeAccounts: rows.financeAccounts.map((row) => ({
      id: row.id,
      currency: row.currency,
      status: row.status,
      openingBalanceMinor: Number(row.opening_balance_minor),
    })),
    ledgerEntries: rows.ledgerEntries.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      direction: row.direction,
      amountMinor: Number(row.amount_minor),
      currency: row.currency,
      category: row.category,
      memo: row.memo,
      projectId: row.project_id,
      sourceRecordId: row.source_record_id,
      sourceEventId: row.source_event_id,
      occurredAt: saveTimestamp(row.occurred_at),
      idempotencyKey: row.idempotency_key,
    })),
    financeCommandGroups: rows.financeCommandGroups.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      state: row.state,
      resultManifest: jsonObject(row.result_manifest),
      rejectionCode: row.rejection_code,
      policyVersion: row.policy_version,
      sourceRecordId: row.source_record_id,
    })),
    obligations: rows.obligations.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      status: row.status,
      principalMinor: Number(row.principal_minor),
      outstandingMinor: Number(row.outstanding_minor),
      shareBps: row.share_bps === null ? null : Number(row.share_bps),
      undeliveredCount: Number(row.undelivered_count),
      dueOn: row.due_on,
      version: Number(row.version),
    })),
    obligationSettlements: rows.obligationSettlements.map((row) => ({
      id: row.id,
      obligationId: row.obligation_id,
      ledgerEntryId: row.ledger_entry_id,
      kind: row.kind,
      amountMinor: Number(row.amount_minor),
    })),
    storyNodes: rows.storyNodes.map((row) => ({
      id: row.id,
      nodeKey: row.node_key,
      state: row.state,
      revision: Number(row.revision),
      recordId: row.record_id,
      definitionHash: row.definition_hash,
      unlockEvidenceEventIds: [...row.unlock_evidence_event_ids],
      unlockEvidence: jsonObject(row.unlock_evidence),
    })),
    storyUnlockLedger: rows.storyUnlockLedger.map((row) => ({
      id: row.id,
      storyNodeInstanceId: row.story_node_instance_id,
      nodeKey: row.node_key,
      transition: row.transition,
      idempotencyKey: row.idempotency_key,
      recordId: row.record_id,
      evidenceEventIds: [...row.evidence_event_ids],
      evidenceHash: row.evidence_hash,
      evidence: jsonObject(row.evidence),
    })),
    committedFactCommands: rows.committedFactCommands.map((row) => ({
      id: row.id,
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      kind: row.kind,
      resultManifest: jsonObject(row.result_manifest),
    })),
    performanceAssessments: rows.performanceAssessments.map((row) => ({
      id: row.id,
      recordId: row.record_id,
      policyVersion: row.policy_version,
      score: Number(row.score),
      evidenceEventIds: [...row.evidence_event_ids],
      evidenceSnapshotHash: row.evidence_snapshot_hash,
      commandId: row.command_id,
    })),
    memberRelationshipRevisions: rows.memberRelationshipRevisions.map((row) => ({
      id: row.id,
      subjectEntityKey: row.subject_entity_key,
      objectEntityKey: row.object_entity_key,
      relationKind: row.relation_kind,
      revisionOrdinal: Number(row.revision_ordinal),
      sourceEventId: row.source_event_id,
      sourceRecordId: row.source_record_id,
      occurredTick: Number(row.occurred_tick),
      occurredOrdinal: Number(row.occurred_ordinal),
      commandId: row.command_id,
    })),
    characterAssets: rows.characterAssets.map((row) => ({
      recordId: row.record_id,
      characterInstanceId: row.character_instance_id,
      assetDefinitionId: row.asset_definition_id,
      assetKey: row.asset_key,
      quantity: Number(row.quantity),
      revision: Number(row.revision),
      metadata: jsonObject(row.metadata),
    })),
  };
}

async function loadDomainSnapshot(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  source: { workspaceId: string; worldId: string; worldlineId: string; storyId: string; recordId: string },
): Promise<RealmRuntimeSaveDomainV1> {
  const linkResult = await client.query<DomainProjectStoryLinkRow>(
    `SELECT id, project_id, story_id, link_kind
     FROM project_story_links
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4
     ORDER BY id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, source.storyId],
  );
  const projectIds = [...new Set(linkResult.rows.map((row) => row.project_id))];
  const projects = await client.query<DomainProjectRow>(
    `SELECT id, kind, status, stage, title, currency, deadline::text, version
     FROM projects
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND id = ANY($4::text[])
     ORDER BY id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, projectIds],
  );
  const milestones = await client.query<DomainMilestoneRow>(
    `SELECT id, project_id, sequence, title, status, due_on::text,
            completion_record_id, completion_event_id
     FROM project_milestones
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND project_id = ANY($4::text[])
     ORDER BY project_id ASC, sequence ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, projectIds],
  );
  const allProjectLinks = await client.query<DomainProjectStoryLinkRow>(
    `SELECT id, project_id, story_id, link_kind
     FROM project_story_links
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND project_id = ANY($4::text[])
     ORDER BY project_id ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, projectIds],
  );
  const budgetAllocations = await client.query<DomainBudgetRow>(
    `SELECT id, project_id, category, amount_minor, currency, version
     FROM budget_allocations
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND project_id = ANY($4::text[])
     ORDER BY project_id ASC, category ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, projectIds],
  );
  const financeAccounts = await client.query<DomainAccountRow>(
    `SELECT id, currency, status, opening_balance_minor
     FROM finance_accounts
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const ledgerEntries = await client.query<DomainLedgerRow>(
    `SELECT id, account_id, kind, direction, amount_minor, currency, category, memo,
            project_id, source_record_id, source_event_id, occurred_at, idempotency_key
     FROM ledger_entries
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY occurred_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const financeCommandGroups = await client.query<DomainFinanceGroupRow>(
    `SELECT id, idempotency_key, request_fingerprint, state, result_manifest,
            rejection_code, policy_version, source_record_id
     FROM project_finance_command_groups
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const obligations = await client.query<DomainObligationRow>(
    `SELECT id, project_id, kind, status, principal_minor, outstanding_minor,
            share_bps, undelivered_count, due_on::text, version
     FROM obligations
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND (project_id IS NULL OR project_id = ANY($4::text[]))
     ORDER BY id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, projectIds],
  );
  const obligationSettlements = await client.query<DomainSettlementRow>(
    `SELECT settlement.id, settlement.obligation_id, settlement.ledger_entry_id,
            settlement.kind, settlement.amount_minor
     FROM obligation_settlements AS settlement
     JOIN obligations AS obligation
       ON obligation.workspace_id = settlement.workspace_id
      AND obligation.world_id = settlement.world_id
      AND obligation.worldline_id = settlement.worldline_id
      AND obligation.id = settlement.obligation_id
     WHERE settlement.workspace_id = $1 AND settlement.world_id = $2
       AND settlement.worldline_id = $3
       AND (obligation.project_id IS NULL OR obligation.project_id = ANY($4::text[]))
     ORDER BY settlement.created_at ASC, settlement.id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, projectIds],
  );
  const storyNodes = await client.query<DomainStoryNodeRow>(
    `SELECT id, node_key, state, revision, record_id, definition_hash,
            unlock_evidence_event_ids, unlock_evidence
     FROM story_node_instances
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4
     ORDER BY node_key ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, source.storyId],
  );
  const storyUnlockLedger = await client.query<DomainUnlockRow>(
    `SELECT id, story_node_instance_id, node_key, transition, idempotency_key,
            record_id, evidence_event_ids, evidence_hash, evidence
     FROM story_unlock_ledger
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, source.storyId],
  );
  const committedFactCommands = await client.query<DomainFactCommandRow>(
    `SELECT id, idempotency_key, request_fingerprint, kind, result_manifest
     FROM committed_fact_commands
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const performanceAssessments = await client.query<DomainAssessmentRow>(
    `SELECT id, record_id, policy_version, score, evidence_event_ids,
            evidence_snapshot_hash, command_id
     FROM performance_assessments
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, source.recordId],
  );
  const memberRelationshipRevisions = await client.query<DomainRelationshipRow>(
    `SELECT id, subject_entity_key, object_entity_key, relation_kind,
            revision_ordinal, source_event_id, source_record_id,
            occurred_tick, occurred_ordinal, command_id
     FROM member_relationship_revisions
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND source_record_id = $4
     ORDER BY subject_entity_key ASC, object_entity_key ASC,
              relation_kind ASC, revision_ordinal ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, source.recordId],
  );
  const characterAssets = await client.query<DomainAssetRow>(
    `SELECT asset.record_id, asset.character_instance_id, asset.asset_definition_id,
            definition.asset_key, asset.quantity, asset.revision, asset.metadata
     FROM character_assets AS asset
     JOIN asset_definitions AS definition
       ON definition.workspace_id = asset.workspace_id
      AND definition.world_id = asset.world_id
      AND definition.id = asset.asset_definition_id
     WHERE asset.workspace_id = $1 AND asset.world_id = $2
       AND asset.worldline_id = $3 AND asset.record_id = $4
     ORDER BY asset.character_instance_id ASC, asset.asset_definition_id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, source.recordId],
  );
  return mapDomain(
    {
      worldId: source.worldId,
      worldlineId: source.worldlineId,
      storyId: source.storyId,
      recordId: source.recordId,
    },
    {
      projects: projects.rows,
      milestones: milestones.rows,
      projectStoryLinks: allProjectLinks.rows,
      budgetAllocations: budgetAllocations.rows,
      financeAccounts: financeAccounts.rows,
      ledgerEntries: ledgerEntries.rows,
      financeCommandGroups: financeCommandGroups.rows,
      obligations: obligations.rows,
      obligationSettlements: obligationSettlements.rows,
      storyNodes: storyNodes.rows,
      storyUnlockLedger: storyUnlockLedger.rows,
      committedFactCommands: committedFactCommands.rows,
      performanceAssessments: performanceAssessments.rows,
      memberRelationshipRevisions: memberRelationshipRevisions.rows,
      characterAssets: characterAssets.rows,
    },
  );
}

/** A pg client has one active query; stop issuing SQL immediately on failure. */
async function readInOrder<const T extends readonly unknown[]>(tasks:{readonly [K in keyof T]:()=>Promise<T[K]>}):Promise<T> {
  const results:unknown[]=[];
  for(const task of tasks)results.push(await task());
  return results as unknown as T;
}

export function createPostgresRealmRuntimeSaveReader(
  database: WorkspaceDatabase,
): RealmRuntimeSaveReader {
  return {
    async load({ workspaceId, recordId, principalId }) {
      return withWorkspaceTransaction(database, workspaceId, async (client) => {
        const recordResult = await client.query<RecordRow>(
          `SELECT
             record.world_id,
             record.worldline_id,
             record.id AS record_id,
             record.story_id,
             record.world_version,
             head.record_version,
             head.next_record_ordinal
           FROM records AS record
           JOIN worlds AS world
             ON world.workspace_id = record.workspace_id
            AND world.id = record.world_id
           JOIN record_heads AS head
             ON head.workspace_id = record.workspace_id
            AND head.record_id = record.id
           WHERE record.workspace_id = $1
             AND record.id = $2`,
          [workspaceId, recordId],
        );
        const recordRow = recordResult.rows[0];
        if (!recordRow) return null;
        if (await isArchivedRecord(client, workspaceId, recordId)) {
          throw new RealmRuntimeSaveRepositoryError(
            "RECORD_ARCHIVED",
            "The requested Record is archived.",
          );
        }

        if(principalId!==undefined) {
          const authority=await client.query<{role:string}>(`SELECT role FROM player_world_memberships
            WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`,[workspaceId,recordRow.world_id,principalId]);
          if(!authority.rows[0])throw new RealmRuntimeSaveRepositoryError('RECORD_NOT_FOUND','Record not found.');
          if(authority.rows[0].role!=='owner')throw new RealmRuntimeSaveRepositoryError('WORLD_READ_ONLY','Private runtime backups require world ownership.');
        }
        const eventResult = await client.query<EventRow>(
          `SELECT id, record_version, record_ordinal, event_kind, payload,
                  content, speaker_name, actor_participant_id, scene_id,
                  visibility_policy_id, world_tick, world_ordinal,
                  calendar_id, display_time
           FROM events
           WHERE workspace_id = $1 AND record_id = $2
           ORDER BY record_ordinal ASC, id ASC`,
          [workspaceId, recordId],
        );
        const [
          instanceResult,
          assessmentResult,
          topologyResult,
          sceneResult,
          visibilityPolicyResult,
          actionReceiptResult,
          characterEffectResult,
          observationResult,
          memoryConclusionResult,
          memorySnapshotResult,
          relationshipStateResult,
          outboxResult,
          firstNightResult,
          selfPlayResult,
        ] = await readInOrder([
          ()=>client.query<GoalInstanceRow>(
            `SELECT id, goal_key, state, revision, progress, outcome, policy_version,
                    definition_source,definition_id,resolution_kind,evidence_start_version,evidence_start_ordinal,
                    attempt,supersedes_instance_id
             FROM goal_instances
             WHERE workspace_id = $1 AND record_id = $2
             ORDER BY id ASC`,
            [workspaceId, recordId],
          ),
          ()=>client.query<GoalAssessmentRow>(
            `SELECT id, goal_instance_id, source_event_id, source, status, result,
                    evidence_event_ids, evidence_head_version, evidence_head_ordinal,
                    evidence_snapshot_hash, policy_version
             FROM goal_assessments
             WHERE workspace_id = $1 AND record_id = $2
             ORDER BY created_at ASC, id ASC`,
            [workspaceId, recordId],
          ),
          ()=>client.query<ParticipantTopologyRow>(
            `SELECT
               participant.id AS participant_id,
               participant.participant_kind,
               participant.character_instance_id AS participant_character_instance_id,
               participant.principal_id AS participant_principal_id,
               participant.controller_mode AS participant_controller_mode,
               participant.is_active AS participant_is_active,
               participant.speaking_order AS participant_speaking_order,
               participant.shared_control_enabled AS participant_shared_control_enabled,
               instance.id AS instance_id,
               instance.continuity_id AS instance_continuity_id,
               instance.predecessor_instance_id AS instance_predecessor_id,
               instance.controller_mode AS instance_controller_mode,
               instance.status AS instance_status,
               instance.instantiated_tick AS instance_instantiated_tick,
               instance.instantiated_ordinal AS instance_instantiated_ordinal,
               instance.inheritance_cutoff_tick AS instance_inheritance_cutoff_tick,
               instance.inheritance_cutoff_ordinal AS instance_inheritance_cutoff_ordinal,
               instance.retired_tick AS instance_retired_tick,
               instance.retired_ordinal AS instance_retired_ordinal,
               instance.state AS instance_state,
               continuity.continuity_key,
               continuity.status AS continuity_status,
               continuity.born_tick AS continuity_born_tick,
               continuity.born_ordinal AS continuity_born_ordinal,
               continuity.ended_tick AS continuity_ended_tick,
               continuity.ended_ordinal AS continuity_ended_ordinal,
               definition.id AS definition_id,
               definition.display_name AS definition_display_name,
               definition.source_format AS definition_source_format,
               definition.profile AS definition_profile
             FROM participants AS participant
             LEFT JOIN character_instances AS instance
               ON instance.workspace_id = participant.workspace_id
              AND instance.world_id = participant.world_id
              AND instance.worldline_id = participant.worldline_id
              AND instance.record_id = participant.record_id
              AND instance.id = participant.character_instance_id
             LEFT JOIN character_continuities AS continuity
               ON continuity.workspace_id = instance.workspace_id
              AND continuity.world_id = instance.world_id
              AND continuity.worldline_id = instance.worldline_id
              AND continuity.id = instance.continuity_id
             LEFT JOIN character_definitions AS definition
               ON definition.workspace_id = continuity.workspace_id
              AND definition.world_id = continuity.world_id
              AND definition.id = continuity.definition_id
             WHERE participant.workspace_id = $1
               AND participant.world_id = $2
               AND participant.worldline_id = $3
               AND participant.record_id = $4
             ORDER BY participant.speaking_order ASC, participant.id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          ()=>client.query<SceneTopologyRow>(
            `SELECT id AS scene_id, title, status, location, objective,
                    tension, weather, display_time,
                    start_tick, start_ordinal, end_tick, end_ordinal
             FROM scenes
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
               AND record_id = $4
             ORDER BY start_tick ASC, start_ordinal ASC, id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          ()=>client.query<VisibilityPolicyTopologyRow>(
            `SELECT id AS policy_id, policy_key, policy_version, policy_kind,
                    scene_id, restricted_domain_id, private_character_instance_id,
                    audience_character_instance_ids
             FROM visibility_policies
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
               AND record_id = $4
             ORDER BY policy_key ASC, policy_version ASC, id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          ()=>client.query<ActionReceiptRow>(
            `SELECT id, transaction_id, call_fingerprint,
                    actor_character_instance_id, source_event_id, receipt,
                    world_tick, world_ordinal, recorded_at
             FROM action_receipts
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
               AND record_id = $4
             ORDER BY world_tick ASC, world_ordinal ASC, id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          ()=>client.query<CharacterEffectRow>(
            `SELECT
               effect.id,
               effect.character_instance_id,
               effect.effect_definition_id,
               definition.effect_key,
               effect.source_action_receipt_id,
               effect.status,
               effect.applied_tick,
               effect.applied_ordinal,
               effect.ended_tick,
               effect.ended_ordinal,
               effect.revision,
               effect.metadata
             FROM character_effects AS effect
             JOIN effect_definitions AS definition
               ON definition.workspace_id = effect.workspace_id
              AND definition.world_id = effect.world_id
              AND definition.id = effect.effect_definition_id
             WHERE effect.workspace_id = $1
               AND effect.world_id = $2
               AND effect.worldline_id = $3
               AND effect.record_id = $4
             ORDER BY effect.applied_tick ASC, effect.applied_ordinal ASC, effect.id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          ()=>client.query<ObservationRow>(
            `SELECT id, observer_character_instance_id, source_event_id,
                    dedupe_key, observation_kind, content, fidelity,
                    occurred_tick, occurred_ordinal,
                    available_from_tick, available_from_ordinal,
                    learned_at, metadata
             FROM observations
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
               AND record_id = $4
             ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          // Memory 运行态以 Worldline 为作用域；source record/observation
          // 引用必须落在被存档 Record 内（跨 Record 引用由契约 fail-closed
          // 拒绝），因此 reader 只导出本 Record 自源或无源的结论/关系。
          ()=>client.query<MemoryConclusionRow>(
            `SELECT id, observer_continuity_id, observed_entity_key,
                    source_record_id, source_observation_id, supersedes_memory_id,
                    operation, memory_kind, content, keywords,
                    semantic_embedding::text AS semantic_embedding,
                    embedding_model, fidelity,
                    occurred_tick, occurred_ordinal,
                    available_from_tick, available_from_ordinal, metadata
             FROM memory_conclusions
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
               AND (source_record_id IS NULL OR source_record_id = $4)
             ORDER BY occurred_tick ASC, occurred_ordinal ASC, id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          ()=>client.query<MemorySnapshotRow>(
            `SELECT id, observer_continuity_id, snapshot_kind, content, item_ids,
                    cursor_tick, cursor_ordinal, cache_epoch, token_count
             FROM memory_snapshots
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
             ORDER BY cursor_tick ASC, cursor_ordinal ASC, id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id],
          ),
          ()=>client.query<RelationshipStateRow>(
            `SELECT observer_continuity_id, target_entity_key, relation_kind,
                    content, fidelity, source_record_id, source_observation_id,
                    occurred_tick, occurred_ordinal,
                    available_from_tick, available_from_ordinal
             FROM relationship_states
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
               AND (source_record_id IS NULL OR source_record_id = $4)
             ORDER BY observer_continuity_id ASC, target_entity_key ASC, relation_kind ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          // Outbox 只导出非终态消息；delivered 已送达，绝不进入存档。
          ()=>client.query<OutboxRow>(
            `SELECT id, dedupe_key, topic, payload, state, attempt_count,
                    available_at, event_id, lease_owner, lease_expires_at,
                    last_error_code, last_error_message, last_error_at
             FROM outbox
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
               AND record_id = $4
               AND state IN ('pending', 'delivering', 'retryable', 'failed')
             ORDER BY created_at ASC, id ASC`,
            [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
          ),
          ()=>client.query<FirstNightRow>(
            `SELECT state, attempts, hook_content, suggestions, context
             FROM record_first_nights
             WHERE workspace_id = $1 AND record_id = $2 AND world_id = $3`,
            [workspaceId, recordId, recordRow.world_id],
          ),
          ()=>client.query<SelfPlaySessionRow>(
            `SELECT id, state, beat_budget, beats_completed, requested_by, last_error
             FROM record_self_play_sessions
             WHERE workspace_id = $1 AND record_id = $2 AND world_id = $3
             ORDER BY created_at ASC, id ASC`,
            [workspaceId, recordId, recordRow.world_id],
          ),
        ]);

        const record: RealmRuntimeSaveRecordV1 = {
          format: "realm-runtime-record",
          schemaVersion: 1,
          scope: {
            worldId: recordRow.world_id,
            worldlineId: recordRow.worldline_id,
            recordId: recordRow.record_id,
          },
          head: {
            recordVersion: Number(recordRow.record_version),
            nextRecordOrdinal: Number(recordRow.next_record_ordinal),
          },
          events: eventResult.rows.map(mapEvent),
        };
        const definitions = await client.query<{definition:unknown}>(`SELECT definition FROM record_goal_definitions
          WHERE workspace_id=$1 AND record_id=$2 ORDER BY goal_id,definition_version`,[workspaceId,recordId]);
        const goals = mapGoals(instanceResult.rows, assessmentResult.rows,definitions.rows);
        const topology = mapTopology(
          topologyResult.rows,
          sceneResult.rows,
          visibilityPolicyResult.rows,
        );
        const actionReceipts = mapActionReceipts(actionReceiptResult.rows);
        const characterEffects = mapCharacterEffects(characterEffectResult.rows);
        const observations = mapObservations(observationResult.rows);
        const memory = mapMemory(
          memoryConclusionResult.rows,
          memorySnapshotResult.rows,
          relationshipStateResult.rows,
        );
        const outbox = mapOutbox(outboxResult.rows);
        const firstNight = mapFirstNight(firstNightResult.rows);
        const selfPlay = mapSelfPlay(selfPlayResult.rows);
        const domain = await loadDomainSnapshot(client, {
          workspaceId,
          worldId: recordRow.world_id,
          worldlineId: recordRow.worldline_id,
          storyId: recordRow.story_id,
          recordId: recordRow.record_id,
        });
        // Phase 4D：存档记录 Record 的实际 binding（records.world_version），
        // 不取 worlds 创建身份——切换过的 Record 存档必须保真。
        const worldRef = worldRefFromVersion(recordRow.world_id, recordRow.world_version);
        const manifest = realmRuntimeSaveManifestFromData({
          engineApi: "1.x",
          mode: worldRef.mode,
          world: worldRef.world,
          scope: {
            workspaceId,
            worldlineId: recordRow.worldline_id,
            recordId: recordRow.record_id,
          },
          record,
          goals,
          topology,
          actionReceipts,
          characterEffects,
          observations,
          memory,
          outbox,
          firstNight,
          selfPlay,
          domain,
        });
        return {
          manifest,
          record,
          goals,
          topology,
          actionReceipts,
          characterEffects,
          observations,
          memory,
          outbox,
          firstNight,
          selfPlay,
          domain,
        };
      }, { readOnly: true, isolationLevel:'repeatable read' });
    },
  };
}

async function isArchivedRecord(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  workspaceId: string,
  recordId: string,
): Promise<boolean> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM records WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, recordId],
  );
  return result.rows[0]?.status === "archived";
}

export async function buildRealmRuntimeSaveBytes(
  reader: RealmRuntimeSaveReader,
  input: { workspaceId: string; recordId: string; principalId?: string },
): Promise<Uint8Array | null> {
  const archive = await reader.load(input);
  return archive ? buildRealmRuntimeSaveArchive(archive) : null;
}

const RESTORE_TARGET_ID = /^[A-Za-z0-9._-]+$/;
const RESTORE_HASH = /^[0-9a-f]{64}$/;
const GOAL_STATES = new Set(["active", "completed", "failed", "settled"]);
const ASSESSMENT_SOURCES = new Set(["deterministic", "judge", "fallback"]);
const ASSESSMENT_STATUSES = new Set(["accepted", "rejected", "stale", "failed"]);

function restoreFailure(message: string): RealmRuntimeSaveRepositoryError {
  return new RealmRuntimeSaveRepositoryError("RUNTIME_SAVE_INVALID", message);
}

function restoreObject(value: JsonValue, field: string): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw restoreFailure(`Runtime save ${field} must be an object.`);
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function restoreString(
  row: Readonly<Record<string, JsonValue>>,
  field: string,
  options: { nonEmpty?: boolean } = {},
): string {
  const value = row[field];
  if (typeof value !== "string" || (options.nonEmpty && !value.trim())) {
    throw restoreFailure(`Runtime save ${field} is invalid.`);
  }
  return value;
}

function restoreInteger(
  row: Readonly<Record<string, JsonValue>>,
  field: string,
  minimum: number,
): number {
  const value = row[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw restoreFailure(`Runtime save ${field} is invalid.`);
  }
  return value as number;
}

function restoreStringArray(
  row: Readonly<Record<string, JsonValue>>,
  field: string,
): readonly string[] {
  const value = row[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw restoreFailure(`Runtime save ${field} is invalid.`);
  }
  return value;
}

function restoreIdempotencyToken(input: RealmRuntimeSaveRestoreInput, targetWorldId: string): string {
  const key = input.idempotencyKey.trim();
  if (!key || key.length > 128) {
    throw new RealmRuntimeSaveRepositoryError(
      "RESTORE_INVALID_TARGET",
      "A bounded restore idempotency key is required.",
    );
  }
  return createHash("sha256")
    .update("realm-save-restore:v1")
    .update("\0")
    .update(targetWorldId)
    .update("\0")
    .update(key)
    .digest("hex")
    .slice(0, 24);
}

function restoreTitle(value: string | undefined, fallback: string): string {
  const title = value?.trim() || fallback;
  if (!title || title.length > 120) {
    throw new RealmRuntimeSaveRepositoryError(
      "RESTORE_INVALID_TARGET",
      "Restore titles must be non-empty and bounded.",
    );
  }
  return title;
}

function normalizeRestoreEvents(
  archive: RealmRuntimeSaveArchive,
): RealmRuntimeSaveRestorableEvent[] {
  const events = archive.record.events.map((event, index) => {
    try {
      return normalizeRealmRuntimeSaveEventForRestore(event, index);
    } catch (error) {
      if (error instanceof RealmRuntimeSaveError) throw restoreFailure("Runtime save event projection is invalid.");
      throw error;
    }
  });
  const ordinals = new Set<number>();
  for (const event of events) {
    if (ordinals.has(event.ordinal)) throw restoreFailure("Runtime save event ordinals are duplicated.");
    ordinals.add(event.ordinal);
  }
  if (events.length === 0) {
    if (archive.record.head.recordVersion !== 0 || archive.record.head.nextRecordOrdinal !== 0) {
      throw restoreFailure("An empty Record save must have a zero head.");
    }
    return events;
  }
  const sorted = events.sort((left, right) => left.ordinal - right.ordinal || left.eventId.localeCompare(right.eventId));
  if (
    sorted[0]!.ordinal !== 1
    || sorted[0]!.recordVersion !== 1
    || sorted.at(-1)!.ordinal + 1 !== archive.record.head.nextRecordOrdinal
    || sorted.at(-1)!.recordVersion !== archive.record.head.recordVersion
  ) {
    throw restoreFailure("Runtime Record events do not form a contiguous saved head.");
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (current.ordinal !== previous.ordinal + 1 || current.recordVersion < previous.recordVersion) {
      throw restoreFailure("Runtime Record event ordering is invalid.");
    }
  }
  return sorted;
}

interface RestoredCharacterTopology {
  sourceCharacterInstanceId: string;
  sourceContinuityId: string;
  sourcePredecessorInstanceId: string | null;
  sourceDefinitionId: string;
  targetDefinitionId: string;
  targetContinuityId: string;
  targetInstanceId: string;
  definition: NonNullable<RealmRuntimeSaveTopologyV1["participants"][number]["character"]>["definition"];
  continuity: NonNullable<RealmRuntimeSaveTopologyV1["participants"][number]["character"]>["continuity"];
  instance: NonNullable<RealmRuntimeSaveTopologyV1["participants"][number]["character"]>["instance"];
}

interface RestoredParticipantTopology {
  sourceParticipantId: string;
  targetParticipantId: string;
  participantKind: "character" | "narrator";
  sourcePrincipalId: string | null;
  controllerMode: "human" | "ai" | "hybrid";
  isActive: boolean;
  speakingOrder: number;
  sharedControlEnabled: boolean;
  character: RestoredCharacterTopology | null;
}

interface RestoredSceneTopology {
  sourceSceneId: string;
  targetSceneId: string;
  title: string;
  status: "planned" | "active" | "closed" | "cancelled";
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

interface RestoredVisibilityPolicyTopology {
  sourceVisibilityPolicyId: string;
  targetVisibilityPolicyId: string;
  policyKey: string;
  policyVersion: number;
  policyKind: "public" | "scene" | "restricted" | "private" | "dm_only";
  targetSceneId: string | null;
  restrictedDomainId: string | null;
  targetPrivateCharacterInstanceId: string | null;
  targetAudienceCharacterInstanceIds: readonly string[];
}

interface NormalizedRestoreTopology {
  participants: readonly RestoredParticipantTopology[];
  participantIds: ReadonlyMap<string, string>;
  characterInstanceIds: ReadonlyMap<string, string>;
  continuityIds: ReadonlyMap<string, string>;
  scenes: readonly RestoredSceneTopology[];
  sceneIds: ReadonlyMap<string, string>;
  visibilityPolicies: readonly RestoredVisibilityPolicyTopology[];
  visibilityPolicyIds: ReadonlyMap<string, string>;
}

function normalizeRestoreTopology(
  archive: RealmRuntimeSaveArchive,
  token: string,
  events: readonly RealmRuntimeSaveRestorableEvent[],
): NormalizedRestoreTopology {
  const participantIds = new Map<string, string>();
  const characterIds = new Map<string, string>();
  const continuityIds = new Map<string, string>();
  const participants = (archive.topology?.participants ?? []).map((participant, index) => {
    if (participantIds.has(participant.sourceParticipantId)) {
      throw restoreFailure("Runtime participant ids are duplicated.");
    }
    const targetParticipantId = `participant_restore_${token}_${index}`;
    participantIds.set(participant.sourceParticipantId, targetParticipantId);
    if (!participant.character) {
      return {
        sourceParticipantId: participant.sourceParticipantId,
        targetParticipantId,
        participantKind: participant.participantKind,
        sourcePrincipalId: participant.sourcePrincipalId,
        controllerMode: participant.controllerMode,
        isActive: participant.isActive,
        speakingOrder: participant.speakingOrder,
        sharedControlEnabled: participant.sharedControlEnabled,
        character: null,
      };
    }
    const character = participant.character;
    if (
      characterIds.has(character.sourceCharacterInstanceId)
      || continuityIds.has(character.sourceContinuityId)
    ) {
      throw restoreFailure("Runtime character topology identities are duplicated.");
    }
    const targetInstanceId = `character_instance_restore_${token}_${index}`;
    const targetContinuityId = `character_continuity_restore_${token}_${index}`;
    characterIds.set(character.sourceCharacterInstanceId, targetInstanceId);
    continuityIds.set(character.sourceContinuityId, targetContinuityId);
    return {
      sourceParticipantId: participant.sourceParticipantId,
      targetParticipantId,
      participantKind: participant.participantKind,
      sourcePrincipalId: participant.sourcePrincipalId,
      controllerMode: participant.controllerMode,
      isActive: participant.isActive,
      speakingOrder: participant.speakingOrder,
      sharedControlEnabled: participant.sharedControlEnabled,
      character: {
        sourceCharacterInstanceId: character.sourceCharacterInstanceId,
        sourceContinuityId: character.sourceContinuityId,
        sourcePredecessorInstanceId: character.sourcePredecessorInstanceId,
        sourceDefinitionId: character.sourceDefinitionId,
        targetDefinitionId: `character_definition_restore_${token}_${index}`,
        targetContinuityId,
        targetInstanceId,
        definition: character.definition,
        continuity: character.continuity,
        instance: character.instance,
      },
    };
  });
  const characterBySource = new Map(
    participants.flatMap((participant) => participant.character
      ? [[participant.character.sourceCharacterInstanceId, participant.character] as const]
      : []),
  );
  for (const participant of participants) {
    const character = participant.character;
    if (!character || character.sourcePredecessorInstanceId === null) continue;
    const predecessor = characterBySource.get(character.sourcePredecessorInstanceId);
    if (!predecessor || predecessor.targetContinuityId !== character.targetContinuityId) {
      throw restoreFailure("Runtime character predecessor is outside the saved continuity.");
    }
  }

  const sourceSceneIds = [...new Set(events.map((event) => event.sourceSceneId))];
  const archiveScenes = archive.topology?.scenes ?? [];
  const sceneInputs = archiveScenes.length > 0
    ? archiveScenes
    : (sourceSceneIds.length > 0
      ? sourceSceneIds.map((sourceSceneId) => ({
          sourceSceneId,
          title: "Restored scene",
          status: "active" as const,
          location: "",
          objective: "",
          tension: "",
          weather: "",
          displayTime: "",
          startTick: 0,
          startOrdinal: 0,
          endTick: null,
          endOrdinal: null,
        }))
      : [{
          sourceSceneId: "legacy-scene",
          title: "Restored scene",
          status: "active" as const,
          location: "",
          objective: "",
          tension: "",
          weather: "",
          displayTime: "",
          startTick: 0,
          startOrdinal: 0,
          endTick: null,
          endOrdinal: null,
        }]);
  const sceneIds = new Map<string, string>();
  const scenes = sceneInputs.map((scene, index) => {
    if (sceneIds.has(scene.sourceSceneId)) throw restoreFailure("Runtime scene ids are duplicated.");
    const targetSceneId = `scene_restore_${token}_${index}`;
    sceneIds.set(scene.sourceSceneId, targetSceneId);
    return {
      sourceSceneId: scene.sourceSceneId,
      targetSceneId,
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
  for (const event of events) {
    if (!sceneIds.has(event.sourceSceneId)) {
      throw restoreFailure("Runtime event references an unknown scene.");
    }
  }

  const sourcePolicyIds = [...new Set(events.map((event) => event.sourceVisibilityPolicyId))];
  const archivePolicies = archive.topology?.visibilityPolicies ?? [];
  const policyInputs = archivePolicies.length > 0
    ? archivePolicies
    : (sourcePolicyIds.length > 0
      ? sourcePolicyIds.map((sourceVisibilityPolicyId, index) => ({
          sourceVisibilityPolicyId,
          policyKey: `restore-public-${index}`,
          policyVersion: 1,
          policyKind: "public" as const,
          sourceSceneId: null,
          restrictedDomainId: null,
          sourcePrivateCharacterInstanceId: null,
          sourceAudienceCharacterInstanceIds: [],
        }))
      : [{
          sourceVisibilityPolicyId: "legacy-policy",
          policyKey: "restore-public",
          policyVersion: 1,
          policyKind: "public" as const,
          sourceSceneId: null,
          restrictedDomainId: null,
          sourcePrivateCharacterInstanceId: null,
          sourceAudienceCharacterInstanceIds: [],
        }]);
  const visibilityPolicyIds = new Map<string, string>();
  const visibilityPolicies = policyInputs.map((policy, index) => {
    if (visibilityPolicyIds.has(policy.sourceVisibilityPolicyId)) {
      throw restoreFailure("Runtime visibility policy ids are duplicated.");
    }
    const targetVisibilityPolicyId = `policy_restore_${token}_${index}`;
    visibilityPolicyIds.set(policy.sourceVisibilityPolicyId, targetVisibilityPolicyId);
    const targetSceneId = policy.sourceSceneId === null ? null : sceneIds.get(policy.sourceSceneId);
    const targetPrivateCharacterInstanceId = policy.sourcePrivateCharacterInstanceId === null
      ? null
      : characterIds.get(policy.sourcePrivateCharacterInstanceId);
    const targetAudienceCharacterInstanceIds = policy.sourceAudienceCharacterInstanceIds.map((sourceId) => {
      const targetId = characterIds.get(sourceId);
      if (!targetId) throw restoreFailure("Runtime visibility policy references an unknown character.");
      return targetId;
    });
    if (policy.sourceSceneId !== null && !targetSceneId) {
      throw restoreFailure("Runtime visibility policy references an unknown scene.");
    }
    if (policy.sourcePrivateCharacterInstanceId !== null && !targetPrivateCharacterInstanceId) {
      throw restoreFailure("Runtime visibility policy references an unknown character.");
    }
    return {
      sourceVisibilityPolicyId: policy.sourceVisibilityPolicyId,
      targetVisibilityPolicyId,
      policyKey: policy.policyKey,
      policyVersion: policy.policyVersion,
      policyKind: policy.policyKind,
      targetSceneId: targetSceneId ?? null,
      restrictedDomainId: policy.restrictedDomainId,
      targetPrivateCharacterInstanceId: targetPrivateCharacterInstanceId ?? null,
      targetAudienceCharacterInstanceIds,
    };
  });
  for (const event of events) {
    if (!visibilityPolicyIds.has(event.sourceVisibilityPolicyId)) {
      throw restoreFailure("Runtime event references an unknown visibility policy.");
    }
  }
  const policyBySourceId = new Map(
    policyInputs.map((policy) => [policy.sourceVisibilityPolicyId, policy]),
  );
  for (const event of events) {
    const policy = policyBySourceId.get(event.sourceVisibilityPolicyId);
    if (policy?.policyKind === "scene" && policy.sourceSceneId !== event.sourceSceneId) {
      throw restoreFailure("Runtime event scene does not match its scene visibility policy.");
    }
  }
  return {
    participants,
    participantIds,
    characterInstanceIds: characterIds,
    continuityIds,
    scenes,
    sceneIds,
    visibilityPolicies,
    visibilityPolicyIds,
  };
}

function rewriteEvidenceReferences(value: JsonValue, eventIds: ReadonlyMap<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map((item) => rewriteEvidenceReferences(item, eventIds));
  if (typeof value !== "object" || value === null) return value;
  const object = value as Readonly<Record<string, JsonValue>>;
  const rewritten: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(object)) {
    if (key === "evidenceEventIds" && Array.isArray(child)) {
      rewritten[key] = child.map((item) => (
        typeof item === "string" ? eventIds.get(item) ?? item : item
      ));
    } else {
      rewritten[key] = rewriteEvidenceReferences(child, eventIds);
    }
  }
  return rewritten;
}

function rewriteGoalReferences(value:JsonValue,identities:ReadonlyMap<string,string>):JsonValue {
  if(Array.isArray(value))return value.map(item=>rewriteGoalReferences(item,identities));
  if(!value || typeof value!=='object')return value;
  const keys=new Set(['goalInstanceId','supersedesInstanceId','successorInstanceId','definitionId','supersedesDefinitionId','successorDefinitionId','policyVersion']);
  return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,
    keys.has(key)&&typeof child==='string'?identities.get(child)??child:rewriteGoalReferences(child,identities)])) as JsonValue;
}

type DomainProject = RealmRuntimeSaveDomainV1["projects"][number];
type DomainMilestone = RealmRuntimeSaveDomainV1["milestones"][number];
type DomainLink = RealmRuntimeSaveDomainV1["projectStoryLinks"][number];
type DomainBudget = RealmRuntimeSaveDomainV1["budgetAllocations"][number];
type DomainAccount = RealmRuntimeSaveDomainV1["financeAccounts"][number];
type DomainLedger = RealmRuntimeSaveDomainV1["ledgerEntries"][number];
type DomainFinanceGroup = RealmRuntimeSaveDomainV1["financeCommandGroups"][number];
type DomainObligation = RealmRuntimeSaveDomainV1["obligations"][number];
type DomainSettlement = RealmRuntimeSaveDomainV1["obligationSettlements"][number];
type DomainNode = RealmRuntimeSaveDomainV1["storyNodes"][number];
type DomainUnlock = RealmRuntimeSaveDomainV1["storyUnlockLedger"][number];
type DomainFact = RealmRuntimeSaveDomainV1["committedFactCommands"][number];
type DomainAssessment = RealmRuntimeSaveDomainV1["performanceAssessments"][number];
type DomainRelationship = RealmRuntimeSaveDomainV1["memberRelationshipRevisions"][number];
type DomainAsset = RealmRuntimeSaveDomainV1["characterAssets"][number];

type RestoredWithId<T> = Omit<T, "id"> & { sourceId: string; targetId: string };

interface NormalizedRestoreDomain {
  projects: readonly RestoredWithId<DomainProject>[];
  milestones: readonly (Omit<DomainMilestone, "id" | "projectId" | "completionRecordId" | "completionEventId"> & {
    sourceId: string;
    targetId: string;
    targetProjectId: string;
    targetCompletionRecordId: string | null;
    targetCompletionEventId: string | null;
  })[];
  projectStoryLinks: readonly (Omit<DomainLink, "id" | "projectId" | "storyId"> & {
    sourceId: string;
    targetId: string;
    targetProjectId: string;
    targetStoryId: string;
  })[];
  budgetAllocations: readonly (Omit<DomainBudget, "id" | "projectId"> & {
    sourceId: string;
    targetId: string;
    targetProjectId: string;
  })[];
  financeAccounts: readonly RestoredWithId<DomainAccount>[];
  ledgerEntries: readonly (Omit<DomainLedger, "id" | "accountId" | "projectId" | "sourceRecordId" | "sourceEventId"> & {
    sourceId: string;
    targetId: string;
    targetAccountId: string;
    targetProjectId: string | null;
    targetSourceRecordId: string | null;
    targetSourceEventId: string | null;
  })[];
  financeCommandGroups: readonly (Omit<DomainFinanceGroup, "id" | "sourceRecordId" | "resultManifest"> & {
    sourceId: string;
    targetId: string;
    targetSourceRecordId: string | null;
    resultManifest: Readonly<Record<string, JsonValue>>;
  })[];
  obligations: readonly (Omit<DomainObligation, "id" | "projectId"> & {
    sourceId: string;
    targetId: string;
    targetProjectId: string | null;
  })[];
  obligationSettlements: readonly (Omit<DomainSettlement, "id" | "obligationId" | "ledgerEntryId"> & {
    sourceId: string;
    targetId: string;
    targetObligationId: string;
    targetLedgerEntryId: string | null;
  })[];
  storyNodes: readonly (Omit<DomainNode, "id" | "recordId" | "unlockEvidenceEventIds" | "unlockEvidence"> & {
    sourceId: string;
    targetId: string;
    targetRecordId: string | null;
    unlockEvidenceEventIds: readonly string[];
    unlockEvidence: Readonly<Record<string, JsonValue>>;
  })[];
  storyUnlockLedger: readonly (Omit<DomainUnlock, "id" | "storyNodeInstanceId" | "idempotencyKey" | "recordId" | "evidenceEventIds" | "evidence"> & {
    sourceId: string;
    targetId: string;
    targetStoryNodeInstanceId: string;
    idempotencyKey: string;
    targetRecordId: string | null;
    evidenceEventIds: readonly string[];
    evidence: Readonly<Record<string, JsonValue>>;
  })[];
  committedFactCommands: readonly (Omit<DomainFact, "id" | "resultManifest"> & {
    sourceId: string;
    targetId: string;
    resultManifest: Readonly<Record<string, JsonValue>>;
  })[];
  performanceAssessments: readonly (Omit<DomainAssessment, "id" | "recordId" | "evidenceEventIds" | "commandId"> & {
    sourceId: string;
    targetId: string;
    targetRecordId: string;
    evidenceEventIds: readonly string[];
    targetCommandId: string;
  })[];
  memberRelationshipRevisions: readonly (Omit<DomainRelationship, "id" | "sourceEventId" | "sourceRecordId" | "commandId"> & {
    sourceId: string;
    targetId: string;
    targetSourceEventId: string;
    targetSourceRecordId: string;
    targetCommandId: string;
  })[];
  characterAssets: readonly (Omit<DomainAsset, "recordId" | "characterInstanceId"> & {
    targetRecordId: string;
    targetCharacterInstanceId: string;
  })[];
}

function remapRequired(
  map: ReadonlyMap<string, string>,
  value: string,
  field: string,
): string {
  const target = map.get(value);
  if (!target) throw restoreFailure(`Runtime domain ${field} references an unknown identity.`);
  return target;
}

function remapRecord(
  value: string | null,
  sourceRecordId: string,
  targetRecordId: string,
  field: string,
): string | null {
  if (value === null) return null;
  if (value !== sourceRecordId) throw restoreFailure(`Runtime domain ${field} references another Record.`);
  return targetRecordId;
}

function remapEvent(
  value: string | null,
  sourceToTargetEventId: ReadonlyMap<string, string>,
  field: string,
): string | null {
  if (value === null) return null;
  return remapRequired(sourceToTargetEventId, value, field);
}

function remapEventArray(
  values: readonly string[],
  sourceToTargetEventId: ReadonlyMap<string, string>,
  field: string,
): readonly string[] {
  return values.map((value) => remapRequired(sourceToTargetEventId, value, field));
}

function rewriteDomainReferences(
  value: JsonValue,
  references: ReadonlyMap<string, string>,
): JsonValue {
  if (typeof value === "string") return references.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteDomainReferences(item, references));
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = rewriteDomainReferences(child, references);
  }
  return result;
}

function normalizeRestoreDomain(
  archive: RealmRuntimeSaveArchive,
  token: string,
  targetWorldId: string,
  targetWorldlineId: string,
  targetStoryId: string,
  targetRecordId: string,
  sourceToTargetEventId: ReadonlyMap<string, string>,
  topology: NormalizedRestoreTopology,
): NormalizedRestoreDomain | null {
  const domain = archive.domain;
  if (!domain) return null;
  if (
    domain.source.worldId !== archive.record.scope.worldId
    || domain.source.worldlineId !== archive.record.scope.worldlineId
    || domain.source.recordId !== archive.record.scope.recordId
  ) {
    throw restoreFailure("Runtime domain scope does not match the saved Record.");
  }
  if (domain.source.storyId.trim() === "") throw restoreFailure("Runtime domain Story identity is missing.");

  const projectIds = new Map<string, string>();
  const projects = domain.projects.map((project, index) => {
    if (projectIds.has(project.id)) throw restoreFailure("Runtime domain project ids are duplicated.");
    const targetId = `project_restore_${token}_${index}`;
    projectIds.set(project.id, targetId);
    return { ...project, sourceId: project.id, targetId };
  });
  const accountIds = new Map<string, string>();
  const financeAccounts = domain.financeAccounts.map((account, index) => {
    if (accountIds.has(account.id)) throw restoreFailure("Runtime domain finance account ids are duplicated.");
    const targetId = `finance_account_restore_${token}_${index}`;
    accountIds.set(account.id, targetId);
    return { ...account, sourceId: account.id, targetId };
  });
  const referenceMap = new Map<string, string>([
    ...projectIds,
    ...accountIds,
    ...sourceToTargetEventId,
  ]);
  referenceMap.set(archive.record.scope.recordId, targetRecordId);
  topology.characterInstanceIds.forEach((value, key) => referenceMap.set(key, value));
  const milestoneIds = new Map<string, string>();
  const milestones = domain.milestones.map((milestone, index) => {
    if (milestoneIds.has(milestone.id)) throw restoreFailure("Runtime domain milestone ids are duplicated.");
    const targetId = `milestone_restore_${token}_${index}`;
    milestoneIds.set(milestone.id, targetId);
    referenceMap.set(milestone.id, targetId);
    return {
      ...milestone,
      sourceId: milestone.id,
      targetId,
      targetProjectId: remapRequired(projectIds, milestone.projectId, "milestone.projectId"),
      targetCompletionRecordId: remapRecord(
        milestone.completionRecordId,
        archive.record.scope.recordId,
        targetRecordId,
        "milestone.completionRecordId",
      ),
      targetCompletionEventId: remapEvent(milestone.completionEventId, sourceToTargetEventId, "milestone.completionEventId"),
    };
  });
  const projectStoryLinks = domain.projectStoryLinks.map((link, index) => ({
    ...link,
    sourceId: link.id,
    targetId: `project_story_link_restore_${token}_${index}`,
    targetProjectId: remapRequired(projectIds, link.projectId, "projectStoryLink.projectId"),
    targetStoryId: link.storyId === domain.source.storyId ? targetStoryId : (() => {
      throw restoreFailure("Runtime domain project link references another Story.");
    })(),
  }));
  const budgetAllocations = domain.budgetAllocations.map((budget, index) => ({
    ...budget,
    sourceId: budget.id,
    targetId: `budget_restore_${token}_${index}`,
    targetProjectId: remapRequired(projectIds, budget.projectId, "budget.projectId"),
  }));
  const ledgerIds = new Map<string, string>();
  const ledgerEntries = domain.ledgerEntries.map((entry, index) => {
    if (ledgerIds.has(entry.id)) throw restoreFailure("Runtime domain ledger ids are duplicated.");
    const targetId = `ledger_restore_${token}_${index}`;
    ledgerIds.set(entry.id, targetId);
    return {
      ...entry,
      sourceId: entry.id,
      targetId,
      targetAccountId: remapRequired(accountIds, entry.accountId, "ledger.accountId"),
      targetProjectId: entry.projectId === null ? null : remapRequired(projectIds, entry.projectId, "ledger.projectId"),
      targetSourceRecordId: remapRecord(entry.sourceRecordId, archive.record.scope.recordId, targetRecordId, "ledger.sourceRecordId"),
      targetSourceEventId: remapEvent(entry.sourceEventId, sourceToTargetEventId, "ledger.sourceEventId"),
    };
  });
  ledgerIds.forEach((value, key) => referenceMap.set(key, value));
  const financeGroupIds = new Map<string, string>();
  const financeCommandGroups = domain.financeCommandGroups.map((group, index) => {
    if (financeGroupIds.has(group.id)) throw restoreFailure("Runtime domain finance command ids are duplicated.");
    const targetId = `finance_command_group_restore_${token}_${index}`;
    financeGroupIds.set(group.id, targetId);
    return {
      ...group,
      sourceId: group.id,
      targetId,
      targetSourceRecordId: remapRecord(group.sourceRecordId, archive.record.scope.recordId, targetRecordId, "financeCommandGroup.sourceRecordId"),
      resultManifest: rewriteDomainReferences(group.resultManifest, referenceMap) as Readonly<Record<string, JsonValue>>,
    };
  });
  const obligationIds = new Map<string, string>();
  const obligations = domain.obligations.map((obligation, index) => {
    if (obligationIds.has(obligation.id)) throw restoreFailure("Runtime domain obligation ids are duplicated.");
    const targetId = `obligation_restore_${token}_${index}`;
    obligationIds.set(obligation.id, targetId);
    referenceMap.set(obligation.id, targetId);
    return {
      ...obligation,
      sourceId: obligation.id,
      targetId,
      targetProjectId: obligation.projectId === null ? null : remapRequired(projectIds, obligation.projectId, "obligation.projectId"),
    };
  });
  const obligationSettlements = domain.obligationSettlements.map((settlement, index) => ({
    ...settlement,
    sourceId: settlement.id,
    targetId: `obligation_settlement_restore_${token}_${index}`,
    targetObligationId: remapRequired(obligationIds, settlement.obligationId, "obligationSettlement.obligationId"),
    targetLedgerEntryId: settlement.ledgerEntryId === null ? null : remapRequired(ledgerIds, settlement.ledgerEntryId, "obligationSettlement.ledgerEntryId"),
  }));
  const nodeIds = new Map<string, string>();
  const storyNodes = domain.storyNodes.map((node) => {
    const targetId = storyNodeInstanceIdFor({
      workspaceId: archive.manifest.scope.workspaceId,
      worldId: targetWorldId,
      worldlineId: targetWorldlineId,
      storyId: targetStoryId,
    }, node.nodeKey);
    if (nodeIds.has(node.id) || [...nodeIds.values()].includes(targetId)) throw restoreFailure("Runtime domain Story node ids are duplicated.");
    nodeIds.set(node.id, targetId);
    referenceMap.set(node.id, targetId);
    return {
      ...node,
      sourceId: node.id,
      targetId,
      targetRecordId: remapRecord(node.recordId, archive.record.scope.recordId, targetRecordId, "storyNode.recordId"),
      unlockEvidenceEventIds: remapEventArray(node.unlockEvidenceEventIds, sourceToTargetEventId, "storyNode.unlockEvidenceEventIds"),
      unlockEvidence: rewriteDomainReferences(node.unlockEvidence, referenceMap) as Readonly<Record<string, JsonValue>>,
    };
  });
  const unlockIds = new Map<string, string>();
  const storyUnlockLedger = domain.storyUnlockLedger.map((ledger) => {
    const targetNodeId = remapRequired(nodeIds, ledger.storyNodeInstanceId, "storyUnlockLedger.storyNodeInstanceId");
    const targetId = storyUnlockLedgerIdFor(targetNodeId, ledger.transition, ledger.evidenceHash);
    const idempotencyKey = storyUnlockIdempotencyKeyFor(targetNodeId, ledger.transition, ledger.evidenceHash);
    if (unlockIds.has(ledger.id) || [...unlockIds.values()].includes(targetId)) throw restoreFailure("Runtime domain Story unlock ids are duplicated.");
    unlockIds.set(ledger.id, targetId);
    referenceMap.set(ledger.id, targetId);
    return {
      ...ledger,
      sourceId: ledger.id,
      targetId,
      targetStoryNodeInstanceId: targetNodeId,
      idempotencyKey,
      targetRecordId: remapRecord(ledger.recordId, archive.record.scope.recordId, targetRecordId, "storyUnlockLedger.recordId"),
      evidenceEventIds: remapEventArray(ledger.evidenceEventIds, sourceToTargetEventId, "storyUnlockLedger.evidenceEventIds"),
      evidence: rewriteDomainReferences(ledger.evidence, referenceMap) as Readonly<Record<string, JsonValue>>,
    };
  });
  const factIds = new Map<string, string>();
  const committedFactCommands = domain.committedFactCommands.map((command, index) => {
    if (factIds.has(command.id)) throw restoreFailure("Runtime domain fact command ids are duplicated.");
    const targetId = `fact_command_restore_${token}_${index}`;
    factIds.set(command.id, targetId);
    return { ...command, sourceId: command.id, targetId, resultManifest: command.resultManifest };
  });
  factIds.forEach((value, key) => referenceMap.set(key, value));
  const rewrittenFacts = committedFactCommands.map((command) => ({
    ...command,
    resultManifest: rewriteDomainReferences(command.resultManifest, referenceMap) as Readonly<Record<string, JsonValue>>,
  }));
  const assessmentIds = new Map<string, string>();
  const performanceAssessments = domain.performanceAssessments.map((assessment, index) => {
    if (assessmentIds.has(assessment.id)) throw restoreFailure("Runtime domain assessment ids are duplicated.");
    const targetId = `performance_assessment_restore_${token}_${index}`;
    assessmentIds.set(assessment.id, targetId);
    return {
      ...assessment,
      sourceId: assessment.id,
      targetId,
      targetRecordId: remapRecord(assessment.recordId, archive.record.scope.recordId, targetRecordId, "performanceAssessment.recordId")!,
      evidenceEventIds: remapEventArray(assessment.evidenceEventIds, sourceToTargetEventId, "performanceAssessment.evidenceEventIds"),
      targetCommandId: remapRequired(factIds, assessment.commandId, "performanceAssessment.commandId"),
    };
  });
  const memberRelationshipRevisions = domain.memberRelationshipRevisions.map((revision, index) => ({
    ...revision,
    sourceId: revision.id,
    targetId: `member_relationship_revision_restore_${token}_${index}`,
    targetSourceEventId: remapRequired(sourceToTargetEventId, revision.sourceEventId, "memberRelationshipRevision.sourceEventId"),
    targetSourceRecordId: remapRecord(revision.sourceRecordId, archive.record.scope.recordId, targetRecordId, "memberRelationshipRevision.sourceRecordId")!,
    targetCommandId: remapRequired(factIds, revision.commandId, "memberRelationshipRevision.commandId"),
  }));
  const characterAssets = domain.characterAssets.map((asset) => ({
    ...asset,
    targetRecordId: remapRecord(asset.recordId, archive.record.scope.recordId, targetRecordId, "characterAsset.recordId")!,
    targetCharacterInstanceId: remapRequired(topology.characterInstanceIds, asset.characterInstanceId, "characterAsset.characterInstanceId"),
  }));
  return {
    projects,
    milestones,
    projectStoryLinks,
    budgetAllocations,
    financeAccounts,
    ledgerEntries,
    financeCommandGroups,
    obligations,
    obligationSettlements,
    storyNodes,
    storyUnlockLedger,
    committedFactCommands: rewrittenFacts,
    performanceAssessments,
    memberRelationshipRevisions,
    characterAssets,
  };
}

interface RestoredGoalInstance {
  sourceId: string;
  sourcePolicyVersion: string;
  targetId: string;
  goalKey: string;
  state: string;
  revision: number;
  progress: Readonly<Record<string, JsonValue>>;
  outcome: Readonly<Record<string, JsonValue>> | null;
  policyVersion: string;
  definitionSource: 'content'|'record';
  definitionId: string|null;
  resolutionKind: string;
  evidenceStartVersion: number;
  evidenceStartOrdinal: number;
  attempt: number;
  supersedesInstanceId: string|null;
  definitionVersion: number;
}

function normalizeGoalInstances(
  archive: RealmRuntimeSaveArchive,
  token: string,
  definitions:readonly RecordGoalDefinitionVersion[],
): RestoredGoalInstance[] {
  const ids = new Set<string>();
  const goalKeys = new Set<string>();
  const rows=archive.goals.instances.map((raw, index) => {
    const row = restoreObject(raw, `goals.instances[${index}]`);
    const sourceId = restoreString(row, "id", { nonEmpty: true });
    const goalKey = restoreString(row, "goalKey", { nonEmpty: true });
    const state = restoreString(row, "state", { nonEmpty: true });
    const policyVersion = restoreString(row, "policyVersion", { nonEmpty: true });
    if (ids.has(sourceId) || goalKeys.has(goalKey) || !GOAL_STATES.has(state)) {
      throw restoreFailure("Runtime Goal instances are duplicated or have an invalid state.");
    }
    ids.add(sourceId);
    goalKeys.add(goalKey);
    const outcomeValue = row.outcome;
    const definition=row.definitionSource==='record'?definitions.find(item=>item.goalKey===goalKey):null;
    if(row.definitionSource==='record' && !definition) throw restoreFailure('The native Goal definition binding is missing.');
    return {
      sourceId,
      sourcePolicyVersion:policyVersion,
      targetId: definition?.goalInstanceId ?? `goal_restore_${token}_${index}`,
      goalKey,
      state,
      revision: restoreInteger(row, "revision", 0),
      progress: restoreObject(row.progress ?? {}, `goals.instances[${index}].progress`),
      outcome: outcomeValue === null || outcomeValue === undefined
        ? null
        : restoreObject(outcomeValue, `goals.instances[${index}].outcome`),
      policyVersion:definition?.policyVersion ?? policyVersion,
      definitionSource:definition?'record' as const:'content' as const,
      definitionId:definition?.definitionId ?? null,
      resolutionKind:definition?restoreString(row,'resolutionKind'):'natural',
      evidenceStartVersion:definition?.activationHead.recordVersion ?? 0,
      evidenceStartOrdinal:definition?.activationHead.ordinal ?? 0,
      attempt:definition?restoreInteger(row,'attempt',1):1,
      supersedesInstanceId:null as string|null,
      definitionVersion:definition?.definitionVersion ?? 0,
    };
  });
  const bySource=new Map(rows.map(row=>[row.sourceId,row]));
  const sourceDefinitions=(archive.goals.definitions??[]).map(decodeRecordGoalDefinition);
  for(const [index,raw] of archive.goals.instances.entries()) {
    const row=restoreObject(raw,`goals.instances[${index}]`);const target=rows[index];
    if(target.definitionSource!=='record') continue;
    const sourceDefinition=sourceDefinitions.find(item=>item.goalKey===target.goalKey)!;
    const previousDefinition=sourceDefinitions.find(item=>item.definitionId===sourceDefinition.supersedesDefinitionId);
    const previousId=row.supersedesInstanceId;
    if((previousDefinition?.goalInstanceId ?? null)!==(previousId ?? null)) throw restoreFailure('The native Goal predecessor binding is invalid.');
    target.supersedesInstanceId=previousId===null||previousId===undefined?null:bySource.get(previousId as string)?.targetId??null;
    if(previousId && !target.supersedesInstanceId) throw restoreFailure('The native Goal predecessor is outside the saved history.');
  }
  return rows;
}

function normalizeAssessmentRows(
  archive: RealmRuntimeSaveArchive,
  goals: readonly RestoredGoalInstance[],
  eventIds: ReadonlyMap<string, string>,
  token: string,
): readonly {
  id: string;
  goalInstanceId: string;
  sourceEventId: string;
  source: string;
  status: string;
  result: Readonly<Record<string, JsonValue>>;
  evidenceEventIds: readonly string[];
  evidenceHeadVersion: number | null;
  evidenceHeadOrdinal: number | null;
  evidenceSnapshotHash: string;
  policyVersion: string;
}[] {
  const goalBySource = new Map(goals.map((goal) => [goal.sourceId, goal]));
  return archive.goals.assessments.map((raw, index) => {
    const row = restoreObject(raw, `goals.assessments[${index}]`);
    const sourceGoalId = restoreString(row, "goalInstanceId", { nonEmpty: true });
    const sourceEventId = restoreString(row, "sourceEventId", { nonEmpty: true });
    const source = restoreString(row, "source", { nonEmpty: true });
    const status = restoreString(row, "status", { nonEmpty: true });
    const boundGoal=goalBySource.get(sourceGoalId);
    const mappedGoalId = boundGoal?.targetId;
    const mappedSourceEventId = eventIds.get(sourceEventId);
    if (
      !mappedGoalId
      || !mappedSourceEventId
      || !ASSESSMENT_SOURCES.has(source)
      || !ASSESSMENT_STATUSES.has(status)
    ) {
      throw restoreFailure("Runtime Goal assessment references an unknown fact or has an invalid state.");
    }
    const evidenceSourceIds = restoreStringArray(row, "evidenceEventIds");
    const evidenceEventIds = evidenceSourceIds.map((eventId) => {
      const mapped = eventIds.get(eventId);
      if (!mapped) throw restoreFailure("Runtime Goal assessment evidence is outside the saved Record.");
      return mapped;
    });
    const evidenceHead = row.evidenceHead;
    let evidenceHeadVersion: number | null = null;
    let evidenceHeadOrdinal: number | null = null;
    if (evidenceHead !== null && evidenceHead !== undefined) {
      const head = restoreObject(evidenceHead, `goals.assessments[${index}].evidenceHead`);
      evidenceHeadVersion = restoreInteger(head, "recordVersion", 1);
      evidenceHeadOrdinal = restoreInteger(head, "ordinal", 0);
    }
    const evidenceSnapshotHash = restoreString(row, "evidenceSnapshotHash", { nonEmpty: true });
    if (RESTORE_HASH.test(evidenceSnapshotHash) === false) {
      throw restoreFailure("Runtime Goal assessment evidence hash is invalid.");
    }
    const sourcePolicyVersion=restoreString(row,'policyVersion',{nonEmpty:true});
    if(boundGoal!.definitionSource==='record'&&sourcePolicyVersion!==boundGoal!.sourcePolicyVersion)
      throw restoreFailure('Native assessment policy does not match its immutable saved Goal.');
    return {
      id: `assessment_restore_${token}_${index}`,
      goalInstanceId: mappedGoalId,
      sourceEventId: mappedSourceEventId,
      source,
      status,
      result: restoreObject(row.result ?? {}, `goals.assessments[${index}].result`),
      evidenceEventIds,
      evidenceHeadVersion,
      evidenceHeadOrdinal,
      evidenceSnapshotHash,
      policyVersion: boundGoal!.definitionSource==='record'?boundGoal!.policyVersion:sourcePolicyVersion,
    };
  });
}

interface RestoredActionReceipt {
  targetId: string;
  transactionId: string;
  callFingerprint: string;
  targetActorCharacterInstanceId: string;
  targetSourceEventId: string;
  receipt: Readonly<Record<string, JsonValue>>;
  worldTick: number;
  worldOrdinal: number;
  recordedAt: string;
}

interface RestoredCharacterEffect {
  targetId: string;
  targetCharacterInstanceId: string;
  effectKey: string;
  targetActionReceiptId: string;
  status: "active" | "expired" | "removed";
  appliedTick: number;
  appliedOrdinal: number;
  endedTick: number | null;
  endedOrdinal: number | null;
  revision: number;
  metadata: Readonly<Record<string, JsonValue>>;
}

interface RestoredObservation {
  targetId: string;
  targetObserverCharacterInstanceId: string;
  targetSourceEventId: string | null;
  dedupeKey: string;
  observationKind: "direct" | "inferred" | "rumor" | "system_grant";
  content: string;
  fidelity: number;
  occurredTick: number;
  occurredOrdinal: number;
  availableFromTick: number;
  availableFromOrdinal: number;
  learnedAt: string;
  metadata: Readonly<Record<string, JsonValue>>;
}

interface RestoredMemoryConclusion {
  targetId: string;
  targetObserverContinuityId: string;
  observedEntityKey: string;
  targetSourceRecordId: string | null;
  targetSourceObservationId: string | null;
  targetSupersedesMemoryId: string | null;
  operation: "add" | "update" | "retract";
  memoryKind: "explicit" | "inferred" | "summary" | "preference" | "relationship";
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

interface RestoredMemorySnapshot {
  targetId: string;
  targetObserverContinuityId: string;
  snapshotKind: "representation" | "recall";
  content: string;
  targetItemIds: readonly string[];
  cursorTick: number;
  cursorOrdinal: number;
  cacheEpoch: number;
  tokenCount: number;
}

interface RestoredRelationshipState {
  targetObserverContinuityId: string;
  targetEntityKey: string;
  relationKind: "trust" | "hostile" | "alliance" | "kinship" | "debt" | "acquaintance" | "note";
  content: string;
  fidelity: number;
  targetSourceRecordId: string | null;
  targetSourceObservationId: string | null;
  occurredTick: number;
  occurredOrdinal: number;
  availableFromTick: number;
  availableFromOrdinal: number;
}

interface RestoredOutboxMessage {
  targetId: string;
  targetDedupeKey: string;
  topic: string;
  envelope: Readonly<Record<string, JsonValue>>;
  targetEventId: string | null;
}

interface RestoredFirstNight {
  state: "pending" | "ready" | "degraded";
  attempts: number;
  hookContent: string;
  suggestions: readonly string[];
  context: Readonly<Record<string, JsonValue>>;
}

interface RestoredSelfPlaySession {
  targetId: string;
  state: "completed" | "failed" | "cancelled";
  beatBudget: number;
  beatsCompleted: number;
  requestedBy: string;
  lastError: string | null;
}

/**
 * Materialized Action Receipts are facts: the receipt payload (dice, costs,
 * effects) is copied verbatim so replay never re-rolls. Only the foreign-key
 * references are remapped into the target Record topology; any reference
 * outside the saved Record fails closed before any target write.
 */
function normalizeRestoreActionReceipts(
  archive: RealmRuntimeSaveArchive,
  characterInstanceIds: ReadonlyMap<string, string>,
  eventIds: ReadonlyMap<string, string>,
  token: string,
): RestoredActionReceipt[] {
  const receipts = archive.actionReceipts?.receipts ?? [];
  return receipts.map((receipt, index) => {
    const targetActorCharacterInstanceId = characterInstanceIds.get(receipt.sourceActorCharacterInstanceId);
    const targetSourceEventId = eventIds.get(receipt.sourceEventId);
    if (!targetActorCharacterInstanceId || !targetSourceEventId) {
      throw restoreFailure("Runtime action receipt references facts outside the saved Record.");
    }
    return {
      targetId: `action_receipt_restore_${token}_${index}`,
      transactionId: receipt.transactionId,
      callFingerprint: receipt.callFingerprint,
      targetActorCharacterInstanceId,
      targetSourceEventId,
      receipt: receipt.receipt,
      worldTick: receipt.worldTick,
      worldOrdinal: receipt.worldOrdinal,
      recordedAt: receipt.recordedAt,
    };
  });
}

function normalizeRestoreCharacterEffects(
  archive: RealmRuntimeSaveArchive,
  characterInstanceIds: ReadonlyMap<string, string>,
  receipts: readonly RestoredActionReceipt[],
  token: string,
): RestoredCharacterEffect[] {
  const effects = archive.characterEffects?.effects ?? [];
  if (effects.length > 0 && !archive.actionReceipts) {
    throw restoreFailure("Runtime character effects require the saved action receipts.");
  }
  const receiptBySource = new Map(
    (archive.actionReceipts?.receipts ?? []).map((receipt, index) => [
      receipt.sourceReceiptId,
      receipts[index]!.targetId,
    ]),
  );
  return effects.map((effect, index) => {
    const targetCharacterInstanceId = characterInstanceIds.get(effect.sourceCharacterInstanceId);
    const targetActionReceiptId = receiptBySource.get(effect.sourceActionReceiptId);
    if (!targetCharacterInstanceId || !targetActionReceiptId) {
      throw restoreFailure("Runtime character effect references facts outside the saved Record.");
    }
    return {
      targetId: `character_effect_restore_${token}_${index}`,
      targetCharacterInstanceId,
      effectKey: effect.effectKey,
      targetActionReceiptId,
      status: effect.status,
      appliedTick: effect.appliedTick,
      appliedOrdinal: effect.appliedOrdinal,
      endedTick: effect.endedTick,
      endedOrdinal: effect.endedOrdinal,
      revision: effect.revision,
      metadata: effect.metadata,
    };
  });
}

function normalizeRestoreObservations(
  archive: RealmRuntimeSaveArchive,
  characterInstanceIds: ReadonlyMap<string, string>,
  eventIds: ReadonlyMap<string, string>,
  token: string,
): RestoredObservation[] {
  const observations = archive.observations?.observations ?? [];
  return observations.map((observation, index) => {
    const targetObserverCharacterInstanceId = characterInstanceIds.get(
      observation.sourceObserverCharacterInstanceId,
    );
    const targetSourceEventId = observation.sourceEventId === null
      ? null
      : eventIds.get(observation.sourceEventId) ?? null;
    if (
      !targetObserverCharacterInstanceId
      || (observation.sourceEventId !== null && targetSourceEventId === null)
    ) {
      throw restoreFailure("Runtime observation references facts outside the saved Record.");
    }
    return {
      targetId: `observation_restore_${token}_${index}`,
      targetObserverCharacterInstanceId,
      targetSourceEventId,
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
    };
  });
}

/**
 * Memory 段规范化：observer continuity、source record/observation、
 * supersedes 链与 snapshot item_ids 全部重映射到 restore 作用域 id；任何
 * 引用缺失在目标写入前 fail-closed（调用方尚未开启目标事务写入）。
 */
function normalizeRestoreMemoryConclusions(
  archive: RealmRuntimeSaveArchive,
  continuityIds: ReadonlyMap<string, string>,
  observations: readonly RestoredObservation[],
  targetRecordId: string,
  token: string,
): RestoredMemoryConclusion[] {
  const conclusions = archive.memory?.conclusions ?? [];
  const observationBySource = new Map(
    (archive.observations?.observations ?? []).map((observation, index) => [
      observation.sourceObservationId,
      observations[index]!.targetId,
    ]),
  );
  const targetIds = new Map(
    conclusions.map((conclusion, index) => [
      conclusion.sourceMemoryId,
      `memory_conclusion_restore_${token}_${index}`,
    ]),
  );
  const normalized = conclusions.map((conclusion) => {
    const targetObserverContinuityId = continuityIds.get(conclusion.sourceObserverContinuityId);
    if (!targetObserverContinuityId) {
      throw restoreFailure("Runtime memory conclusion references an unrestored observer continuity.");
    }
    if (conclusion.sourceRecordId !== null && conclusion.sourceRecordId !== archive.record.scope.recordId) {
      throw restoreFailure("Runtime memory conclusion references a Record outside the save.");
    }
    const targetSourceObservationId = conclusion.sourceObservationId === null
      ? null
      : observationBySource.get(conclusion.sourceObservationId) ?? null;
    if (conclusion.sourceObservationId !== null && targetSourceObservationId === null) {
      throw restoreFailure("Runtime memory conclusion references an unrestored source observation.");
    }
    const targetSupersedesMemoryId = conclusion.sourceSupersedesMemoryId === null
      ? null
      : targetIds.get(conclusion.sourceSupersedesMemoryId) ?? null;
    if (conclusion.sourceSupersedesMemoryId !== null && targetSupersedesMemoryId === null) {
      throw restoreFailure("Runtime memory conclusion supersedes an unrestored conclusion.");
    }
    return {
      targetId: targetIds.get(conclusion.sourceMemoryId)!,
      targetObserverContinuityId,
      observedEntityKey: conclusion.observedEntityKey,
      targetSourceRecordId: conclusion.sourceRecordId === null ? null : targetRecordId,
      targetSourceObservationId,
      targetSupersedesMemoryId,
      operation: conclusion.operation,
      memoryKind: conclusion.memoryKind,
      content: conclusion.content,
      keywords: conclusion.keywords,
      semanticEmbedding: conclusion.semanticEmbedding,
      embeddingModel: conclusion.embeddingModel,
      fidelity: conclusion.fidelity,
      occurredTick: conclusion.occurredTick,
      occurredOrdinal: conclusion.occurredOrdinal,
      availableFromTick: conclusion.availableFromTick,
      availableFromOrdinal: conclusion.availableFromOrdinal,
      metadata: conclusion.metadata,
    };
  });
  // append-only 自引用 FK：被取代的结论必须先落库。按 supersedes 链做稳定
  // 拓扑排序（契约已保证无环且引用均在存档内）。
  const pending = new Map(normalized.map((entry) => [entry.targetId, entry]));
  const ordered: RestoredMemoryConclusion[] = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const [targetId, entry] of pending) {
      if (entry.targetSupersedesMemoryId !== null && pending.has(entry.targetSupersedesMemoryId)) {
        continue;
      }
      ordered.push(entry);
      pending.delete(targetId);
      progressed = true;
    }
    if (!progressed) {
      throw restoreFailure("Runtime memory supersedes chain is cyclic.");
    }
  }
  return ordered;
}

function normalizeRestoreMemorySnapshots(
  archive: RealmRuntimeSaveArchive,
  continuityIds: ReadonlyMap<string, string>,
  token: string,
): RestoredMemorySnapshot[] {
  const snapshots = archive.memory?.snapshots ?? [];
  // 结论目标 id 由存档下标确定性派生（与 normalizeRestoreMemoryConclusions
  // 的分配规则一致）；缺失引用一律 fail-closed。
  const conclusionBySource = new Map(
    (archive.memory?.conclusions ?? []).map((conclusion, conclusionIndex) => [
      conclusion.sourceMemoryId,
      `memory_conclusion_restore_${token}_${conclusionIndex}`,
    ]),
  );
  return snapshots.map((snapshot, index) => {
    const targetObserverContinuityId = continuityIds.get(snapshot.sourceObserverContinuityId);
    if (!targetObserverContinuityId) {
      throw restoreFailure("Runtime memory snapshot references an unrestored observer continuity.");
    }
    const targetItemIds = snapshot.sourceItemIds.map((sourceItemId) => {
      const targetItemId = conclusionBySource.get(sourceItemId);
      if (!targetItemId) {
        throw restoreFailure("Runtime memory snapshot references an unrestored conclusion.");
      }
      return targetItemId;
    });
    return {
      targetId: `memory_snapshot_restore_${token}_${index}`,
      targetObserverContinuityId,
      snapshotKind: snapshot.snapshotKind,
      content: snapshot.content,
      targetItemIds,
      cursorTick: snapshot.cursorTick,
      cursorOrdinal: snapshot.cursorOrdinal,
      cacheEpoch: snapshot.cacheEpoch,
      tokenCount: snapshot.tokenCount,
    };
  });
}

function normalizeRestoreRelationshipStates(
  archive: RealmRuntimeSaveArchive,
  continuityIds: ReadonlyMap<string, string>,
  observations: readonly RestoredObservation[],
  targetRecordId: string,
): RestoredRelationshipState[] {
  const states = archive.memory?.relationshipStates ?? [];
  const observationBySource = new Map(
    (archive.observations?.observations ?? []).map((observation, index) => [
      observation.sourceObservationId,
      observations[index]!.targetId,
    ]),
  );
  return states.map((state) => {
    const targetObserverContinuityId = continuityIds.get(state.sourceObserverContinuityId);
    if (!targetObserverContinuityId) {
      throw restoreFailure("Runtime relationship state references an unrestored observer continuity.");
    }
    if (state.sourceRecordId !== null && state.sourceRecordId !== archive.record.scope.recordId) {
      throw restoreFailure("Runtime relationship state references a Record outside the save.");
    }
    const targetSourceObservationId = state.sourceObservationId === null
      ? null
      : observationBySource.get(state.sourceObservationId) ?? null;
    if (state.sourceObservationId !== null && targetSourceObservationId === null) {
      throw restoreFailure("Runtime relationship state references an unrestored source observation.");
    }
    return {
      targetObserverContinuityId,
      targetEntityKey: state.targetEntityKey,
      relationKind: state.relationKind,
      content: state.content,
      fidelity: state.fidelity,
      targetSourceRecordId: state.sourceRecordId === null ? null : targetRecordId,
      targetSourceObservationId,
      occurredTick: state.occurredTick,
      occurredOrdinal: state.occurredOrdinal,
      availableFromTick: state.availableFromTick,
      availableFromOrdinal: state.availableFromOrdinal,
    };
  });
}

/**
 * Outbox 规范化：record/event 引用重映射到 restore 作用域；dedupe_key
 * （投递幂等键）原文保留为后缀，但以 restore 前缀命名空间化——outbox 的
 * dedupe_key 在整个 workspace 内唯一，源 Record 可能仍在同一 workspace
 * 持有同键消息，直接复制会撞唯一约束。lease/fencing token（revision）、
 * attempt_count、失败细节一律不复制：restore 落 fresh pending，等待独立
 * worker 重新 claim。任何指向存档外 Event 的引用在目标写入前 fail-closed。
 */
function normalizeRestoreOutbox(
  archive: RealmRuntimeSaveArchive,
  eventIds: ReadonlyMap<string, string>,
  token: string,
): RestoredOutboxMessage[] {
  const messages = archive.outbox?.messages ?? [];
  return messages.map((message, index) => {
    const targetEventId = message.sourceEventId === null
      ? null
      : eventIds.get(message.sourceEventId) ?? null;
    if (message.sourceEventId !== null && targetEventId === null) {
      throw restoreFailure("Runtime outbox message references an Event outside the saved Record.");
    }
    return {
      targetId: `outbox_restore_${token}_${index}`,
      targetDedupeKey: `restore:${token}:${message.dedupeKey}`,
      topic: message.topic,
      envelope: message.envelope,
      targetEventId,
    };
  });
}

/** First-night 状态原样复制到目标 Record（每 Record 至多一条状态行）。 */
function normalizeRestoreFirstNight(
  archive: RealmRuntimeSaveArchive,
): RestoredFirstNight | null {
  const entry = archive.firstNight?.entry ?? null;
  if (!entry) return null;
  return {
    state: entry.state,
    attempts: entry.attempts,
    hookContent: entry.hookContent,
    suggestions: entry.suggestions,
    context: entry.context,
  };
}

/**
 * Self-play 会话账本规范化：在途状态（running/stopping）不携带任何
 * worker lease，restore 收束为终态 cancelled（拍边界取消语义）；终态
 * （completed/failed/cancelled）与拍预算/已拍数原样保留。
 */
function normalizeRestoreSelfPlay(
  archive: RealmRuntimeSaveArchive,
  token: string,
): RestoredSelfPlaySession[] {
  const sessions = archive.selfPlay?.sessions ?? [];
  return sessions.map((session, index) => ({
    targetId: `self_play_restore_${token}_${index}`,
    state: session.state === "running" || session.state === "stopping"
      ? "cancelled"
      : session.state,
    beatBudget: session.beatBudget,
    beatsCompleted: session.beatsCompleted,
    requestedBy: session.requestedBy,
    lastError: session.lastError,
  }));
}

function maxWorldCursor(events: readonly RealmRuntimeSaveRestorableEvent[]): {
  tick: number;
  ordinal: number;
} | null {
  let result: { tick: number; ordinal: number } | null = null;
  for (const event of events) {
    if (!result || event.worldTick > result.tick || (
      event.worldTick === result.tick && event.worldOrdinal > result.ordinal
    )) {
      result = { tick: event.worldTick, ordinal: event.worldOrdinal };
    }
  }
  return result;
}

export function createPostgresRealmRuntimeSaveRestorer(
  database: WorkspaceDatabase,
  options: RealmRuntimeSaveRestorerOptions = {},
): RealmRuntimeSaveRestorer {
  return {
    async restore(input) {
      const targetWorldId = input.targetWorldId?.trim()
        || input.archive.manifest.world?.worldId
        || "";
      if (!RESTORE_TARGET_ID.test(targetWorldId)) {
        throw new RealmRuntimeSaveRepositoryError(
          "RESTORE_INVALID_TARGET",
          "A safe target World id is required.",
        );
      }
      if (
        input.archive.manifest.mode === "world-bound"
        && input.archive.manifest.world?.worldId !== targetWorldId
      ) {
        throw new RealmRuntimeSaveRepositoryError(
          "RESTORE_INVALID_TARGET",
          "A world-bound save must restore into the same World identity.",
        );
      }
      // RealmWorld 信任闸：world-bound 存档的精确 binding（archive manifest
      // 记录的 worldId/worldVersion）必须先证明为已安装、验签/content-hash
      // 有效且当前可信的 RealmWorld 包——在任何 restore 写入（含幂等重放
      // 短路）之前 fail-closed。base 存档不经过此闸，也不要求任何
      // RealmWorld 安装/信任配置。
      if (input.archive.manifest.mode === "world-bound") {
        const binding = input.archive.manifest.world;
        if (!binding) {
          throw new RealmRuntimeSaveRepositoryError(
            "RUNTIME_SAVE_INVALID",
            "A world-bound save must carry a WorldBinding.",
          );
        }
        if (!options.validateWorldBinding) {
          throw new RealmRuntimeSaveRepositoryError(
            "REALMWORLD_VALIDATION_UNAVAILABLE",
            "RealmWorld package validation is not configured.",
          );
        }
        try {
          await options.validateWorldBinding({
            worldId: binding.worldId,
            worldVersion: binding.worldVersion,
          });
        } catch (error) {
          if (error instanceof RealmRuntimeSaveRepositoryError) throw error;
          throw new RealmRuntimeSaveRepositoryError(
            "REALMWORLD_PACKAGE_UNTRUSTED",
            "RealmWorld package validation failed.",
          );
        }
      }
      // Base→world-bound 升级闸：base 存档显式指向非 base 版本的目标
      // World 时，目标精确 binding（worldId + 目标 World 当前版本）必须先
      // 证明为已安装、验签有效且与活动引擎 base 版本兼容——在任何 restore
      // 写入（含幂等重放短路）之前 fail-closed。版本在事务外预读、事务内
      // FOR KEY SHARE 复核，漂移即 RESTORE_CONFLICT。
      let upgradeTargetBinding: RealmRuntimeSaveWorldBinding | null = null;
      if (input.archive.manifest.mode === "base" && !input.branch) {
        // 预读在独立只读 workspace 事务内执行（RLS GUC 作用域要求）。
        const preWorld = await withWorkspaceTransaction(
          database,
          input.workspaceId,
          async (client) => {
            const preRead = await client.query<{ world_version: string }>(
              `SELECT world_version
               FROM worlds
               WHERE workspace_id = $1 AND id = $2`,
              [input.workspaceId, targetWorldId],
            );
            return preRead.rows[0] ?? null;
          },
          { readOnly: true },
        );
        if (preWorld && preWorld.world_version !== LOCAL_WORLD_VERSION) {
          if (!options.validateUpgradeTarget) {
            throw new RealmRuntimeSaveRepositoryError(
              "REALMWORLD_VALIDATION_UNAVAILABLE",
              "RealmWorld package validation is not configured.",
            );
          }
          upgradeTargetBinding = {
            worldId: targetWorldId,
            worldVersion: preWorld.world_version,
          };
          try {
            await options.validateUpgradeTarget(upgradeTargetBinding);
          } catch (error) {
            if (error instanceof RealmRuntimeSaveRepositoryError) throw error;
            throw new RealmRuntimeSaveRepositoryError(
              "REALMWORLD_PACKAGE_UNTRUSTED",
              "RealmWorld package validation failed.",
            );
          }
        }
      }
      const token = input.branch?createHash('sha256').update(`${input.workspaceId}:${input.branch.sourceRecordId}:${input.idempotencyKey}`).digest('hex').slice(0,18):restoreIdempotencyToken(input, targetWorldId);
      const namespace=input.branch?'branch':'restore';
      const targetRecordId = `record_${namespace}_${token}`;
      const targetWorldlineId = `worldline_${namespace}_${token}`;
      const targetStoryId = `story_${namespace}_${token}`;
      if(input.branch && (input.branch.sourceRecordId!==input.archive.record.scope.recordId || input.branch.sourceWorldlineId!==input.archive.record.scope.worldlineId
        || targetWorldId!==input.archive.record.scope.worldId))throw restoreFailure('Branch snapshot source scope is invalid.');
      const targetNarratorParticipantId = `participant_restore_${token}`;
      const events = normalizeRestoreEvents(input.archive);
      const topology = normalizeRestoreTopology(input.archive, token, events);
      const sourceToTargetEventId = new Map(
        events.map((event, index) => [event.eventId, `restore_event_${token}_${index}`]),
      );
      const definitions=rebaseRecordGoalDefinitions({definitions:input.archive.goals.definitions??[],
        scope:{workspaceId:input.workspaceId,worldId:targetWorldId,worldlineId:targetWorldlineId,recordId:targetRecordId},eventIds:sourceToTargetEventId});
      const goals = normalizeGoalInstances(input.archive, token,definitions);
      const targetScope={workspaceId:input.workspaceId,worldId:targetWorldId,worldlineId:targetWorldlineId,recordId:targetRecordId};
      const sourceScope={workspaceId:input.archive.manifest.scope.workspaceId,...input.archive.record.scope};
      const goalReferences=new Map(goals.map(goal=>[goal.sourceId,goal.targetId]));
      for(const raw of input.archive.goals.definitions??[]) {
        const source=decodeRecordGoalDefinition(raw);const target=definitions.find(item=>item.goalKey===source.goalKey)!;
        goalReferences.set(source.definitionId,target.definitionId);goalReferences.set(source.policyVersion,target.policyVersion);
      }
      const assessments = normalizeAssessmentRows(
        input.archive,
        goals,
        sourceToTargetEventId,
        token,
      );
      const actionReceipts = normalizeRestoreActionReceipts(
        input.archive,
        topology.characterInstanceIds,
        sourceToTargetEventId,
        token,
      );
      const characterEffects = normalizeRestoreCharacterEffects(
        input.archive,
        topology.characterInstanceIds,
        actionReceipts,
        token,
      );
      const observations = normalizeRestoreObservations(
        input.archive,
        topology.characterInstanceIds,
        sourceToTargetEventId,
        token,
      );
      const memoryConclusions = normalizeRestoreMemoryConclusions(
        input.archive,
        topology.continuityIds,
        observations,
        targetRecordId,
        token,
      );
      const memorySnapshots = normalizeRestoreMemorySnapshots(
        input.archive,
        topology.continuityIds,
        token,
      );
      const relationshipStates = normalizeRestoreRelationshipStates(
        input.archive,
        topology.continuityIds,
        observations,
        targetRecordId,
      );
      const outboxMessages = normalizeRestoreOutbox(input.archive, sourceToTargetEventId, token);
      const firstNight = normalizeRestoreFirstNight(input.archive);
      const selfPlaySessions = normalizeRestoreSelfPlay(input.archive, token);
      const domain = normalizeRestoreDomain(
        input.archive,
        token,
        targetWorldId,
        targetWorldlineId,
        targetStoryId,
        targetRecordId,
        sourceToTargetEventId,
        topology,
      );
      const warnings: readonly ["WORLD_VERSION_MISMATCH"] | readonly [] = [];

      return withWorkspaceTransaction(database, input.workspaceId, async (client) => {
        const worldResult = await client.query<{
          world_version: string;
          status: string;
        }>(
          `SELECT world_version, status
           FROM worlds
           WHERE workspace_id = $1 AND id = $2
           FOR KEY SHARE`,
          [input.workspaceId, targetWorldId],
        );
        const world = worldResult.rows[0];
        if (!world) {
          throw new RealmRuntimeSaveRepositoryError("WORLD_NOT_FOUND", "World not found.");
        }
        if (world.status === "archived") {
          throw new RealmRuntimeSaveRepositoryError("WORLD_ARCHIVED", "World is archived.");
        }
        const membership = await client.query<{ role: string }>(
          `SELECT role
           FROM player_world_memberships
           WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
          [input.workspaceId, targetWorldId, input.principalId],
        );
        const role = membership.rows[0]?.role;
        if (role !== "owner" && role !== "player") {
          throw new RealmRuntimeSaveRepositoryError("WORLD_NOT_FOUND", "World not found.");
        }
        if((definitions.length||input.branch) && role!=='owner')throw new RealmRuntimeSaveRepositoryError('WORLD_READ_ONLY','Native Goal restoration requires world ownership.');
        if((definitions.length||input.branch) && !input.sessionProof) throw restoreFailure('A verified owner restore proof is required for native Goals.');
        if (input.archive.manifest.mode === "base" && world.world_version !== LOCAL_WORLD_VERSION && !input.branch) {
          // 升级路径：仅当事务外预读的 binding 与本事务锁定读一致才允许；
          // 版本漂移 fail-closed（RESTORE_CONFLICT），绝不绑定未验证版本。
          if (
            !upgradeTargetBinding
            || upgradeTargetBinding.worldVersion !== world.world_version
          ) {
            throw new RealmRuntimeSaveRepositoryError(
              "RESTORE_CONFLICT",
              "Target world version changed during restore.",
            );
          }
        }
        const versionMismatch = input.archive.manifest.mode === "world-bound"
          && input.archive.manifest.world?.worldVersion !== world.world_version;
        const effectiveWarnings: readonly ["WORLD_VERSION_MISMATCH"] | readonly [] = versionMismatch
          ? ["WORLD_VERSION_MISMATCH"]
          : warnings;

        const existing = await client.query<{
          world_id: string;
          worldline_id: string;
          story_id: string;
          story_premise: string;
          status: string;
        }>(
          `SELECT record.world_id, record.worldline_id, record.story_id, record.status,
                  story.premise AS story_premise
           FROM records AS record
           JOIN stories AS story
             ON story.workspace_id = record.workspace_id
            AND story.world_id = record.world_id
            AND story.worldline_id = record.worldline_id
            AND story.id = record.story_id
           WHERE record.workspace_id = $1 AND record.id = $2`,
          [input.workspaceId, targetRecordId],
        );
        if (existing.rowCount !== 0) {
          const row = existing.rows[0]!;
          if (row.world_id !== targetWorldId || row.worldline_id !== targetWorldlineId || row.story_id !== targetStoryId) {
            throw new RealmRuntimeSaveRepositoryError("RESTORE_ID_COLLISION", "Restore identity collides with another Record.");
          }
          if (row.story_premise !== (input.branch?.premise??`realm-save:${input.archive.manifest.snapshot.runtimeHash}`)) {
            throw new RealmRuntimeSaveRepositoryError(
              "RESTORE_CONFLICT",
              "The restore idempotency key is already bound to another archive.",
            );
          }
          return {
            worldId: targetWorldId,
            worldVersion: world.world_version,
            worldlineId: targetWorldlineId,
            storyId: targetStoryId,
            recordId: targetRecordId,
            importedEventCount: events.length,
            importedGoalInstanceCount: goals.length,
            importedAssessmentCount: assessments.length,
            importedActionReceiptCount: actionReceipts.length,
            importedCharacterEffectCount: characterEffects.length,
            importedObservationCount: observations.length,
            importedMemoryConclusionCount: memoryConclusions.length,
            importedMemorySnapshotCount: memorySnapshots.length,
            importedRelationshipStateCount: relationshipStates.length,
            importedOutboxMessageCount: outboxMessages.length,
            importedFirstNightCount: firstNight ? 1 : 0,
            importedSelfPlaySessionCount: selfPlaySessions.length,
            importedDomainProjectCount: domain?.projects.length ?? 0,
            importedDomainLedgerEntryCount: domain?.ledgerEntries.length ?? 0,
            importedDomainStoryNodeCount: domain?.storyNodes.length ?? 0,
            importedDomainUnlockCount: domain?.storyUnlockLedger.length ?? 0,
            importedDomainFactCommandCount: domain?.committedFactCommands.length ?? 0,
            importedDomainAssessmentCount: domain?.performanceAssessments.length ?? 0,
            importedDomainRelationshipRevisionCount: domain?.memberRelationshipRevisions.length ?? 0,
            importedDomainAssetCount: domain?.characterAssets.length ?? 0,
            warnings: effectiveWarnings,
            replayed: true,
          };
        }

        // Fail closed before any target write: every restored character
        // effect must resolve its rule definition (by effect_key) inside the
        // target World — definitions are World-scoped rule data, never
        // carried by or installed from a runtime save.
        const effectDefinitionIds = new Map<string, string>();
        for (const effect of characterEffects) {
          if (effectDefinitionIds.has(effect.effectKey)) continue;
          const definition = await client.query<{ id: string }>(
            `SELECT id
             FROM effect_definitions
             WHERE workspace_id = $1 AND world_id = $2 AND effect_key = $3`,
            [input.workspaceId, targetWorldId, effect.effectKey],
          );
          const definitionId = definition.rows[0]?.id;
          if (!definitionId) {
            throw new RealmRuntimeSaveRepositoryError(
              "RESTORE_INVALID_TARGET",
              "The target World lacks a restored effect definition.",
            );
          }
          effectDefinitionIds.set(effect.effectKey, definitionId);
        }

        const cursor = maxWorldCursor(events);
        const recordVersion = input.archive.record.head.recordVersion;
        const nextRecordOrdinal = input.archive.record.head.nextRecordOrdinal;
        if (events.length > 0 && recordVersion <= 0) {
          throw restoreFailure("Runtime Record head version is invalid for a non-empty save.");
        }
        if(definitions.length||input.branch) {
          const admitted=input.branch?await client.query<{actor:string}>(`SELECT record_goal_branch_prepare($1,$2,$3,$4,$5,$6) AS actor`,
            [input.workspaceId,input.sessionProof,input.branch.sourceRecordId,token,input.archive.manifest.snapshot.runtimeHash,recordVersion])
            :await client.query<{actor:string}>(`SELECT record_goal_restore_prepare($1,$2,$3,$4,$5,$6) AS actor`,
              [input.workspaceId,input.sessionProof,targetWorldId,targetWorldlineId,targetRecordId,input.archive.manifest.snapshot.runtimeHash]);
          if(admitted.rows[0]?.actor!==input.principalId) throw restoreFailure('The native Goal restore actor does not match the proof.');
        }
        await client.query(
          `INSERT INTO worldlines (
             workspace_id, world_id, id, label, status,
             parent_worldline_id, fork_tick, fork_ordinal, head_tick, head_ordinal
           ) VALUES ($1, $2, $3, $4, 'active', $7, $8, $9, $5, $6)`,
          [
            input.workspaceId,
            targetWorldId,
            targetWorldlineId,
            restoreTitle(input.branch?.label, "Restored runtime save"),
            cursor?.tick ?? 0,
            cursor?.ordinal ?? 0,
            input.branch?.sourceWorldlineId??null,input.branch?.fork.tick??null,input.branch?.fork.ordinal??null,
          ],
        );
        await client.query(
          `INSERT INTO stories (
             workspace_id, world_id, worldline_id, id, title, status,
             premise, start_tick, start_ordinal
           ) VALUES ($1, $2, $3, $4, $5, 'active', $6, 0, 0)`,
          [
            input.workspaceId,
            targetWorldId,
            targetWorldlineId,
            targetStoryId,
            restoreTitle(input.storyTitle, "Restored story"),
            input.branch?.premise??`realm-save:${input.archive.manifest.snapshot.runtimeHash}`,
          ],
        );
        // Phase 4D：恢复出的 Record 绑定=存档 manifest 记录的制作版本
        //（base 存档=哨兵；world-bound=存档版本），绝不取目标世界当前值。
        // Slice 5 升级路径例外：base→world-bound 显式升级绑定事务内锁定
        // 复核过的目标 World 版本（upgradeTargetBinding）。
        const restoredWorldVersion = input.archive.manifest.world?.worldVersion
          ?? upgradeTargetBinding?.worldVersion
          ?? LOCAL_WORLD_VERSION;
        await client.query(
          `INSERT INTO records (
             workspace_id, world_id, worldline_id, story_id, id, title,
             status, start_tick, start_ordinal, timeline_kind, linked_record_id,
             world_version
           ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $8, $9, $10, $11, $7)`,
          [
            input.workspaceId,
            targetWorldId,
            targetWorldlineId,
            targetStoryId,
            targetRecordId,
            restoreTitle(input.recordTitle, "Restored Record"),
            restoredWorldVersion,
            input.branch?.fork.tick??0,input.branch?.fork.ordinal??0,input.branch?'branch':'primary',input.branch?.sourceRecordId??null,
          ],
        );
        const targetInstanceBySource = topology.characterInstanceIds;
        for (const participant of topology.participants) {
          const character = participant.character;
          if (!character) continue;
          await client.query(
            `INSERT INTO character_definitions (
               workspace_id, world_id, id, display_name, source_format, profile
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
              input.workspaceId,
              targetWorldId,
              character.targetDefinitionId,
              character.definition.displayName,
              character.definition.sourceFormat,
              JSON.stringify(character.definition.profile),
            ],
          );
          await client.query(
            `INSERT INTO character_continuities (
               workspace_id, world_id, worldline_id, definition_id, id,
               continuity_key, status, born_tick, born_ordinal, ended_tick, ended_ordinal
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              character.targetDefinitionId,
              character.targetContinuityId,
              character.continuity.continuityKey,
              character.continuity.status,
              character.continuity.bornTick,
              character.continuity.bornOrdinal,
              character.continuity.endedTick,
              character.continuity.endedOrdinal,
            ],
          );
          await client.query(
            `INSERT INTO character_instances (
               workspace_id, world_id, worldline_id, record_id, continuity_id,
               predecessor_instance_id, id, controller_mode, status,
               instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick,
               inheritance_cutoff_ordinal, retired_tick, retired_ordinal, state
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              character.targetContinuityId,
              character.sourcePredecessorInstanceId === null
                ? null
                : targetInstanceBySource.get(character.sourcePredecessorInstanceId)!,
              character.targetInstanceId,
              character.instance.controllerMode,
              character.instance.status,
              character.instance.instantiatedTick,
              character.instance.instantiatedOrdinal,
              character.instance.inheritanceCutoffTick,
              character.instance.inheritanceCutoffOrdinal,
              character.instance.retiredTick,
              character.instance.retiredOrdinal,
              JSON.stringify(character.instance.state),
            ],
          );
        }
        for (const participant of topology.participants) {
          await client.query(
            `INSERT INTO participants (
               workspace_id, world_id, worldline_id, record_id, id,
               participant_kind, character_instance_id, principal_id,
               controller_mode, is_active, speaking_order, shared_control_enabled
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              participant.targetParticipantId,
              participant.participantKind,
              participant.character?.targetInstanceId ?? null,
              participant.sourcePrincipalId === null ? null : input.principalId,
              participant.controllerMode,
              participant.isActive,
              participant.speakingOrder,
              participant.sharedControlEnabled,
            ],
          );
        }
        if (!topology.participants.some((participant) => participant.participantKind === "narrator")) {
          await client.query(
            `INSERT INTO participants (
               workspace_id, world_id, worldline_id, record_id, id,
               participant_kind, character_instance_id, principal_id,
               controller_mode, is_active, speaking_order, shared_control_enabled
             ) VALUES ($1, $2, $3, $4, $5, 'narrator', NULL, NULL, 'ai', true, $6, false)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              targetNarratorParticipantId,
              topology.participants.reduce(
                (maximum, participant) => Math.max(maximum, participant.speakingOrder),
                -1,
              ) + 1,
            ],
          );
        }
        for (const scene of topology.scenes) {
          await client.query(
            `INSERT INTO scenes (
               workspace_id, world_id, worldline_id, record_id, id, title,
               status, location, objective, tension, weather, display_time,
               start_tick, start_ordinal, end_tick, end_ordinal
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              scene.targetSceneId,
              scene.title,
              scene.status,
              scene.location,
              scene.objective,
              scene.tension,
              scene.weather,
              scene.displayTime,
              scene.startTick,
              scene.startOrdinal,
              scene.endTick,
              scene.endOrdinal,
            ],
          );
        }
        for (const policy of topology.visibilityPolicies) {
          await client.query(
            `INSERT INTO visibility_policies (
               workspace_id, world_id, worldline_id, record_id, id, policy_key,
               policy_version, policy_kind, scene_id, restricted_domain_id,
               private_character_instance_id, audience_character_instance_ids
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[])`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              policy.targetVisibilityPolicyId,
              policy.policyKey,
              policy.policyVersion,
              policy.policyKind,
              policy.targetSceneId,
              policy.restrictedDomainId,
              policy.targetPrivateCharacterInstanceId,
              [...policy.targetAudienceCharacterInstanceIds],
            ],
          );
        }
        await client.query(
          `INSERT INTO record_heads (
             workspace_id, world_id, worldline_id, record_id,
             record_version, next_record_ordinal
           ) VALUES ($1, $2, $3, $4, 0, 0)`,
          [input.workspaceId, targetWorldId, targetWorldlineId, targetRecordId],
        );

        const batchByVersion = new Map<number, number>();
        for (const event of events) {
          const batchIndex = batchByVersion.get(event.recordVersion) ?? 0;
          batchByVersion.set(event.recordVersion, batchIndex + 1);
          const targetEventId = sourceToTargetEventId.get(event.eventId)!;
          const targetActorParticipantId = event.sourceActorParticipantId === null
            ? null
            : topology.participantIds.get(event.sourceActorParticipantId);
          if (event.sourceActorParticipantId !== null && !targetActorParticipantId) {
            throw restoreFailure("Runtime event actor is outside the saved participant topology.");
          }
          const targetSceneId = topology.sceneIds.get(event.sourceSceneId);
          const targetVisibilityPolicyId = topology.visibilityPolicyIds.get(event.sourceVisibilityPolicyId);
          if (!targetSceneId || !targetVisibilityPolicyId) {
            throw restoreFailure("Runtime event topology mapping is incomplete.");
          }
          const rewritten = rewriteGoalReferences(rewriteEvidenceReferences(event.eventPayload, sourceToTargetEventId),goalReferences);
          const payload=restoreObject(rewritten,'event.payload');
          const body=restoreObject(payload.__realmRuntimePayload??payload,'event.runtimePayload');
          let storedPayload:JsonValue=payload;
          if(body.narrativeState!==undefined) {
            if(event.kind!=='narration.committed'||body.role!=='narrator')throw restoreFailure('Narrative restore authority is invalid.');
            const original=restoreObject(event.eventPayload,'event.original');
            const originalBody=restoreObject(original.__realmRuntimePayload??original,'event.originalRuntimePayload');
            const state=rebaseNarrativeState({state:originalBody.narrativeState,sourceScope,targetScope,eventIds:sourceToTargetEventId});
            const nextBody={...body,narrativeState:state as unknown as JsonValue};
            storedPayload=payload.__realmRuntimePayload?{...payload,__realmRuntimePayload:nextBody}:nextBody;
          }
          await client.query(
            `INSERT INTO events (
               workspace_id, world_id, worldline_id, record_id, scene_id, id,
               record_version, record_ordinal, batch_index, event_kind,
               actor_participant_id, speaker_name, content, payload,
               visibility_policy_id, world_tick, world_ordinal, calendar_id,
               display_time, causation_command_id, turn_run_id, recorded_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                       $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19, NULL, NULL, CURRENT_TIMESTAMP)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              targetSceneId,
              targetEventId,
              event.recordVersion,
              event.ordinal,
              batchIndex,
              event.kind,
              targetActorParticipantId ?? null,
              event.speakerName,
              event.content,
              JSON.stringify(storedPayload),
              targetVisibilityPolicyId,
              event.worldTick,
              event.worldOrdinal,
              event.calendarId,
              event.displayTime,
            ],
          );
        }
        const lastEvent = events.at(-1);
        await client.query(
          `UPDATE record_heads
           SET record_version = $5,
               next_record_ordinal = $6,
               last_event_id = $7,
               last_world_tick = $8,
               last_world_ordinal = $9,
               updated_at = CURRENT_TIMESTAMP
           WHERE workspace_id = $1 AND world_id = $2
             AND worldline_id = $3 AND record_id = $4`,
          [
            input.workspaceId,
            targetWorldId,
            targetWorldlineId,
            targetRecordId,
            recordVersion,
            nextRecordOrdinal,
            lastEvent ? sourceToTargetEventId.get(lastEvent.eventId)! : null,
            cursor?.tick ?? null,
            cursor?.ordinal ?? null,
          ],
        );

        if(events.some(event=>{
          const body=restoreObject(event.eventPayload,'event.payload');const inner=restoreObject(body.__realmRuntimePayload??body,'event.runtimePayload');
          return inner.narrativeState!==undefined;
        })) await rebuildRecordNarrativeState(client,targetScope);
        if(definitions.length) await client.query(`SELECT record_goal_restore_definitions($1,$2,$3,$4::jsonb)`,
          [input.workspaceId,input.sessionProof,targetRecordId,JSON.stringify(definitions)]);
        for (const goal of [...goals].sort((a,b)=>a.definitionVersion-b.definitionVersion)) {
          await client.query(
            `INSERT INTO goal_instances (
               workspace_id, world_id, worldline_id, record_id, id, goal_key,
               state, revision, progress, outcome, policy_version, completed_at,
               definition_source,definition_id,resolution_kind,evidence_start_version,evidence_start_ordinal,attempt,supersedes_instance_id
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11,
                       CASE WHEN $7 = 'active' THEN NULL ELSE CURRENT_TIMESTAMP END,$12,$13,$14,$15,$16,$17,$18)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              goal.targetId,
              goal.goalKey,
              goal.state,
              goal.revision,
              JSON.stringify(goal.progress),
              goal.outcome === null ? null : JSON.stringify(goal.outcome),
              goal.policyVersion,
              goal.definitionSource,goal.definitionId,goal.resolutionKind,goal.evidenceStartVersion,goal.evidenceStartOrdinal,
              goal.attempt,goal.supersedesInstanceId,
            ],
          );
        }
        for (const assessment of assessments) {
          await client.query(
            `INSERT INTO goal_assessments (
               workspace_id, world_id, worldline_id, record_id, id,
               goal_instance_id, assessment_job_id, source_event_id, source, status,
               result, evidence_event_ids, evidence_head_version, evidence_head_ordinal,
               evidence_snapshot_hash, policy_version
             ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10::jsonb,
                       $11::text[], $12, $13, $14, $15)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              assessment.id,
              assessment.goalInstanceId,
              assessment.sourceEventId,
              assessment.source,
              assessment.status,
              JSON.stringify(assessment.result),
              assessment.evidenceEventIds,
              assessment.evidenceHeadVersion,
              assessment.evidenceHeadOrdinal,
              assessment.evidenceSnapshotHash,
              assessment.policyVersion,
            ],
          );
        }

        for (const receipt of actionReceipts) {
          await client.query(
            `INSERT INTO action_receipts (
               workspace_id, world_id, worldline_id, record_id,
               actor_character_instance_id, source_event_id, id, transaction_id,
               call_fingerprint, receipt, world_tick, world_ordinal, recorded_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
               $13::timestamptz
             )`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              receipt.targetActorCharacterInstanceId,
              receipt.targetSourceEventId,
              receipt.targetId,
              receipt.transactionId,
              receipt.callFingerprint,
              JSON.stringify(receipt.receipt),
              receipt.worldTick,
              receipt.worldOrdinal,
              receipt.recordedAt,
            ],
          );
        }
        for (const effect of characterEffects) {
          // realm_runtime 的 INSERT 列授权不含 ended 游标：先按授权列插入，
          // 同事务内用 UPDATE 补写 ended 游标（UPDATE 列授权覆盖）。
          await client.query(
            `INSERT INTO character_effects (
               workspace_id, world_id, worldline_id, record_id,
               character_instance_id, effect_definition_id,
               source_action_receipt_id, id, status,
               applied_tick, applied_ordinal, revision, metadata
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
             )`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              effect.targetCharacterInstanceId,
              effectDefinitionIds.get(effect.effectKey)!,
              effect.targetActionReceiptId,
              effect.targetId,
              effect.status,
              effect.appliedTick,
              effect.appliedOrdinal,
              effect.revision,
              JSON.stringify(effect.metadata),
            ],
          );
          if (effect.endedTick !== null && effect.endedOrdinal !== null) {
            await client.query(
              `UPDATE character_effects
               SET ended_tick = $6, ended_ordinal = $7
               WHERE workspace_id = $1 AND id = $2
                 AND world_id = $3 AND worldline_id = $4 AND record_id = $5`,
              [
                input.workspaceId,
                effect.targetId,
                targetWorldId,
                targetWorldlineId,
                targetRecordId,
                effect.endedTick,
                effect.endedOrdinal,
              ],
            );
          }
        }
        for (const observation of observations) {
          await client.query(
            `INSERT INTO observations (
               workspace_id, world_id, worldline_id, record_id,
               observer_character_instance_id, source_event_id, id,
               dedupe_key, observation_kind, content, fidelity,
               occurred_tick, occurred_ordinal,
               available_from_tick, available_from_ordinal, learned_at,
               metadata
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16::timestamptz, $17::jsonb
             )`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              observation.targetObserverCharacterInstanceId,
              observation.targetSourceEventId,
              observation.targetId,
              observation.dedupeKey,
              observation.observationKind,
              observation.content,
              observation.fidelity,
              observation.occurredTick,
              observation.occurredOrdinal,
              observation.availableFromTick,
              observation.availableFromOrdinal,
              observation.learnedAt,
              JSON.stringify(observation.metadata),
            ],
          );
        }

        // memory_conclusions 按 supersedes 拓扑序落库（被取代者先行）；
        // semantic_embedding 以规范化 vector 字面原样写回。
        for (const conclusion of memoryConclusions) {
          await client.query(
            `INSERT INTO memory_conclusions (
               workspace_id, world_id, worldline_id, observer_continuity_id,
               observed_entity_key, source_record_id, source_observation_id,
               supersedes_memory_id, id, operation, memory_kind, content,
               keywords, semantic_embedding, embedding_model, fidelity,
               occurred_tick, occurred_ordinal,
               available_from_tick, available_from_ordinal, metadata
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::text[], $14::vector, $15, $16, $17, $18, $19, $20,
               $21::jsonb
             )`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              conclusion.targetObserverContinuityId,
              conclusion.observedEntityKey,
              conclusion.targetSourceRecordId,
              conclusion.targetSourceObservationId,
              conclusion.targetSupersedesMemoryId,
              conclusion.targetId,
              conclusion.operation,
              conclusion.memoryKind,
              conclusion.content,
              [...conclusion.keywords],
              saveVectorLiteral(conclusion.semanticEmbedding),
              conclusion.embeddingModel,
              conclusion.fidelity,
              conclusion.occurredTick,
              conclusion.occurredOrdinal,
              conclusion.availableFromTick,
              conclusion.availableFromOrdinal,
              JSON.stringify(conclusion.metadata),
            ],
          );
        }
        for (const snapshot of memorySnapshots) {
          await client.query(
            `INSERT INTO memory_snapshots (
               workspace_id, world_id, worldline_id, observer_continuity_id,
               id, snapshot_kind, content, item_ids,
               cursor_tick, cursor_ordinal, cache_epoch, token_count
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11, $12
             )`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              snapshot.targetObserverContinuityId,
              snapshot.targetId,
              snapshot.snapshotKind,
              snapshot.content,
              [...snapshot.targetItemIds],
              snapshot.cursorTick,
              snapshot.cursorOrdinal,
              snapshot.cacheEpoch,
              snapshot.tokenCount,
            ],
          );
        }
        for (const state of relationshipStates) {
          await client.query(
            `INSERT INTO relationship_states (
               workspace_id, world_id, worldline_id, observer_continuity_id,
               target_entity_key, relation_kind, content, fidelity,
               source_record_id, source_observation_id,
               occurred_tick, occurred_ordinal,
               available_from_tick, available_from_ordinal
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
             )`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              state.targetObserverContinuityId,
              state.targetEntityKey,
              state.relationKind,
              state.content,
              state.fidelity,
              state.targetSourceRecordId,
              state.targetSourceObservationId,
              state.occurredTick,
              state.occurredOrdinal,
              state.availableFromTick,
              state.availableFromOrdinal,
            ],
          );
        }

        // Outbox 消息落 fresh pending：lease/fencing token、attempt_count、
        // 失败细节一律不复制，available_at 取恢复时刻，等待独立 worker 重新
        // claim；dedupe_key 以 restore 前缀命名空间化并保留原键后缀。
        for (const message of outboxMessages) {
          await client.query(
            `INSERT INTO outbox (
               workspace_id, world_id, worldline_id, record_id,
               event_id, turn_run_id, id, dedupe_key, topic, payload,
               state, revision, attempt_count, available_at, created_at, updated_at
             ) VALUES (
               $1, $2, $3, $4, $5, NULL, $6, $7, $8, $9::jsonb,
               'pending', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
             )`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              targetRecordId,
              message.targetEventId,
              message.targetId,
              message.targetDedupeKey,
              message.topic,
              JSON.stringify(message.envelope),
            ],
          );
        }
        if (firstNight) {
          await client.query(
            `INSERT INTO record_first_nights (
               workspace_id, record_id, world_id, state, attempts,
               hook_content, suggestions, context
             ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb)`,
            [
              input.workspaceId,
              targetRecordId,
              targetWorldId,
              firstNight.state,
              firstNight.attempts,
              firstNight.hookContent,
              [...firstNight.suggestions],
              JSON.stringify(firstNight.context),
            ],
          );
        }
        for (const session of selfPlaySessions) {
          await client.query(
            `INSERT INTO record_self_play_sessions (
               workspace_id, id, record_id, world_id, state,
               beat_budget, beats_completed, requested_by, last_error
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              input.workspaceId,
              session.targetId,
              targetRecordId,
              targetWorldId,
              session.state,
              session.beatBudget,
              session.beatsCompleted,
              session.requestedBy,
              session.lastError,
            ],
          );
        }

        if (domain) {
          for (const project of domain.projects) {
            await client.query(
              `INSERT INTO projects (
                 workspace_id, world_id, worldline_id, id, kind, status, stage,
                 title, currency, deadline, owner_id, version
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                project.targetId,
                project.kind,
                project.status,
                project.stage,
                project.title,
                project.currency,
                project.deadline,
                project.version,
              ],
            );
          }
          for (const account of domain.financeAccounts) {
            await client.query(
              `INSERT INTO finance_accounts (
                 workspace_id, world_id, worldline_id, id, currency, status,
                 opening_balance_minor
               ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                account.targetId,
                account.currency,
                account.status,
                account.openingBalanceMinor,
              ],
            );
          }
          for (const link of domain.projectStoryLinks) {
            await client.query(
              `INSERT INTO project_story_links (
                 workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind
               ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                link.targetId,
                link.targetProjectId,
                link.targetStoryId,
                link.linkKind,
              ],
            );
          }
          for (const budget of domain.budgetAllocations) {
            await client.query(
              `INSERT INTO budget_allocations (
                 workspace_id, world_id, worldline_id, id, project_id, category,
                 amount_minor, currency, version
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                budget.targetId,
                budget.targetProjectId,
                budget.category,
                budget.amountMinor,
                budget.currency,
                budget.version,
              ],
            );
          }
          for (const group of domain.financeCommandGroups) {
            await client.query(
              `INSERT INTO project_finance_command_groups (
                 workspace_id, world_id, worldline_id, id, idempotency_key,
                 request_fingerprint, state, result_manifest, rejection_code,
                 policy_version, source_record_id, completed_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11,
                         CASE WHEN $7 = 'committed' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                group.targetId,
                group.idempotencyKey,
                group.requestFingerprint,
                group.state,
                JSON.stringify(group.resultManifest),
                group.rejectionCode,
                group.policyVersion,
                group.targetSourceRecordId,
              ],
            );
          }
          for (const ledger of domain.ledgerEntries) {
            await client.query(
              `INSERT INTO ledger_entries (
                 workspace_id, world_id, worldline_id, id, account_id, kind,
                 direction, amount_minor, currency, category, memo, project_id,
                 source_record_id, source_event_id, occurred_at, idempotency_key
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                         $13, $14, $15::timestamptz, $16)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                ledger.targetId,
                ledger.targetAccountId,
                ledger.kind,
                ledger.direction,
                ledger.amountMinor,
                ledger.currency,
                ledger.category,
                ledger.memo,
                ledger.targetProjectId,
                ledger.targetSourceRecordId,
                ledger.targetSourceEventId,
                ledger.occurredAt,
                ledger.idempotencyKey,
              ],
            );
          }
          for (const obligation of domain.obligations) {
            await client.query(
              `INSERT INTO obligations (
                 workspace_id, world_id, worldline_id, id, project_id, kind,
                 status, principal_minor, outstanding_minor, share_bps,
                 undelivered_count, due_on, version
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                obligation.targetId,
                obligation.targetProjectId,
                obligation.kind,
                obligation.status,
                obligation.principalMinor,
                obligation.outstandingMinor,
                obligation.shareBps,
                obligation.undeliveredCount,
                obligation.dueOn,
                obligation.version,
              ],
            );
          }
          for (const settlement of domain.obligationSettlements) {
            await client.query(
              `INSERT INTO obligation_settlements (
                 workspace_id, world_id, worldline_id, id, obligation_id,
                 ledger_entry_id, kind, amount_minor
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                settlement.targetId,
                settlement.targetObligationId,
                settlement.targetLedgerEntryId,
                settlement.kind,
                settlement.amountMinor,
              ],
            );
          }
          for (const milestone of domain.milestones) {
            await client.query(
              `INSERT INTO project_milestones (
                 workspace_id, world_id, worldline_id, id, project_id, sequence,
                 title, status, due_on, completion_record_id, completion_event_id
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                milestone.targetId,
                milestone.targetProjectId,
                milestone.sequence,
                milestone.title,
                milestone.status,
                milestone.dueOn,
                milestone.targetCompletionRecordId,
                milestone.targetCompletionEventId,
              ],
            );
          }
          for (const node of domain.storyNodes) {
            await client.query(
              `INSERT INTO story_node_instances (
                 workspace_id, world_id, worldline_id, story_id, node_key, id,
                 state, revision, record_id, definition_hash,
                 unlock_evidence_event_ids, unlock_evidence, unlocked_at, activated_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[],
                         $12::jsonb,
                         CASE WHEN $7 = 'locked' THEN NULL ELSE CURRENT_TIMESTAMP END,
                         CASE WHEN $7 = 'locked' THEN NULL ELSE CURRENT_TIMESTAMP END)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                targetStoryId,
                node.nodeKey,
                node.targetId,
                node.state,
                node.revision,
                node.targetRecordId,
                node.definitionHash,
                [...node.unlockEvidenceEventIds],
                JSON.stringify(node.unlockEvidence),
              ],
            );
          }
          for (const unlock of domain.storyUnlockLedger) {
            await client.query(
              `INSERT INTO story_unlock_ledger (
                 workspace_id, world_id, worldline_id, story_id, id,
                 story_node_instance_id, node_key, transition, idempotency_key,
                 record_id, evidence_event_ids, evidence_hash, evidence
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], $12, $13::jsonb)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                targetStoryId,
                unlock.targetId,
                unlock.targetStoryNodeInstanceId,
                unlock.nodeKey,
                unlock.transition,
                unlock.idempotencyKey,
                unlock.targetRecordId,
                [...unlock.evidenceEventIds],
                unlock.evidenceHash,
                JSON.stringify(unlock.evidence),
              ],
            );
          }
          for (const command of domain.committedFactCommands) {
            await client.query(
              `INSERT INTO committed_fact_commands (
                 workspace_id, world_id, worldline_id, id, idempotency_key,
                 request_fingerprint, kind, result_manifest
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                command.targetId,
                command.idempotencyKey,
                command.requestFingerprint,
                command.kind,
                JSON.stringify(command.resultManifest),
              ],
            );
          }
          for (const assessment of domain.performanceAssessments) {
            await client.query(
              `INSERT INTO performance_assessments (
                 workspace_id, world_id, worldline_id, record_id, id,
                 policy_version, score, evidence_event_ids,
                 evidence_snapshot_hash, command_id
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                assessment.targetRecordId,
                assessment.targetId,
                assessment.policyVersion,
                assessment.score,
                [...assessment.evidenceEventIds],
                assessment.evidenceSnapshotHash,
                assessment.targetCommandId,
              ],
            );
          }
          for (const revision of domain.memberRelationshipRevisions) {
            await client.query(
              `INSERT INTO member_relationship_revisions (
                 workspace_id, world_id, worldline_id, id, subject_entity_key,
                 object_entity_key, relation_kind, revision_ordinal,
                 source_event_id, source_record_id, occurred_tick, occurred_ordinal,
                 command_id
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                revision.targetId,
                revision.subjectEntityKey,
                revision.objectEntityKey,
                revision.relationKind,
                revision.revisionOrdinal,
                revision.targetSourceEventId,
                revision.targetSourceRecordId,
                revision.occurredTick,
                revision.occurredOrdinal,
                revision.targetCommandId,
              ],
            );
          }
          for (const asset of domain.characterAssets) {
            // A base save may be explicitly upgraded to another World. Its
            // database ids are not content identities; resolve a carried key
            // only inside the already authorized target World. Legacy archives
            // remain id-bound and never guess a key from an id or source DB.
            const definition = await client.query<{ id: string }>(
              `SELECT id FROM asset_definitions
               WHERE workspace_id = $1 AND world_id = $2
                 AND (($3::text IS NOT NULL AND asset_key = $3)
                   OR ($3::text IS NULL AND id = $4))`,
              [input.workspaceId, targetWorldId, asset.assetKey ?? null, asset.assetDefinitionId],
            );
            if (definition.rowCount !== 1) {
              throw new RealmRuntimeSaveRepositoryError(
                "RESTORE_INVALID_TARGET",
                "The target World lacks a restored asset definition.",
              );
            }
            await client.query(
              `INSERT INTO character_assets (
                 workspace_id, world_id, worldline_id, record_id,
                 character_instance_id, asset_definition_id, quantity, revision, metadata
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                asset.targetRecordId,
                asset.targetCharacterInstanceId,
                definition.rows[0]!.id,
                asset.quantity,
                asset.revision,
                JSON.stringify(asset.metadata),
              ],
            );
          }
        }

        return {
          worldId: targetWorldId,
          worldVersion: world.world_version,
          worldlineId: targetWorldlineId,
          storyId: targetStoryId,
          recordId: targetRecordId,
          importedEventCount: events.length,
          importedGoalInstanceCount: goals.length,
          importedAssessmentCount: assessments.length,
          importedActionReceiptCount: actionReceipts.length,
          importedCharacterEffectCount: characterEffects.length,
          importedObservationCount: observations.length,
          importedMemoryConclusionCount: memoryConclusions.length,
          importedMemorySnapshotCount: memorySnapshots.length,
          importedRelationshipStateCount: relationshipStates.length,
          importedOutboxMessageCount: outboxMessages.length,
          importedFirstNightCount: firstNight ? 1 : 0,
          importedSelfPlaySessionCount: selfPlaySessions.length,
          importedDomainProjectCount: domain?.projects.length ?? 0,
          importedDomainLedgerEntryCount: domain?.ledgerEntries.length ?? 0,
          importedDomainStoryNodeCount: domain?.storyNodes.length ?? 0,
          importedDomainUnlockCount: domain?.storyUnlockLedger.length ?? 0,
          importedDomainFactCommandCount: domain?.committedFactCommands.length ?? 0,
          importedDomainAssessmentCount: domain?.performanceAssessments.length ?? 0,
          importedDomainRelationshipRevisionCount: domain?.memberRelationshipRevisions.length ?? 0,
          importedDomainAssetCount: domain?.characterAssets.length ?? 0,
          warnings: effectiveWarnings,
          replayed: false,
        };
      });
    },
  };
}
