import { planGoalRestore, resolveGoalRestore, hasGoalRestoreTarget, writeRestoredGoalsV2, finalizeGoalRestoreEvidence } from "./runtime-goal-restore.ts";
import { hasPerformanceRestoreTarget } from "./runtime-restore-v3.ts";
import { writePerformanceTransport, verifyPerformanceTransport } from "./runtime-performance-witness-restore.ts";
import { nativePerformanceWitness, projectPerformanceWitness, type PerformanceWitnessEnvelopeV1, type PerformanceWitnessOriginV1, type PerformanceWitnessIdentityKind, type RuntimePerformanceWitnessesV1 } from "../../modules/world-transfer/runtime-performance-witness-transport.ts";
import { readPerformanceEvidenceSource, readPerformanceTransport } from "./performance-evidence-transport-repository.ts";
import { PerformanceEvidenceReceiptError } from "../../modules/application/performance-evidence-receipt.ts";
import { performanceTransportConsumerOptions } from "../../modules/application/performance-command-executor.ts";
import { normalizeRealmRuntimeSaveDomainV1 } from "../../modules/world-transfer/realm-runtime-domain-save.ts";
import { readCommandMaterializations, insertCommandMaterializations, hasCommandMaterializationsSchema } from "./business-command-policy.ts";
import { normalizeRequestPolicy, validateCommandMaterializations, type CommandMaterializations, type CommandPolicyResolver } from "../../modules/world-transfer/realmworld-command-policy.ts";
import { readEvidenceRows } from "./runtime-evidence-resource-reader.ts";
import { readTopologyRows } from "./runtime-topology-resource-reader.ts";
import { hasGoalTransportSchema, loadArchiveGoalBindings, emptyRuntimeGoals } from "./runtime-goal-binding-reader.ts";
import { createDefaultGoalContentBindingSource, type GoalContentSourceResolver } from "../../modules/application/goal-content-binding-source.ts";
import { createHash, randomUUID } from "node:crypto";
import { estimateMemoryTokens, fitMemoryLinesWithinBudget } from "../../modules/memory/public.ts";
import { isOperatorPrincipal } from "../../modules/identity/operator.ts";
import type { PoolClient, QueryResultRow } from "pg";
import {
  buildRealmRuntimeSaveArchive,
  RuntimeSectionWireLedger, countRuntimeSectionWireBytes,
  serializeRealmRuntimeSaveOutboxV1,
  MemoryWireByteLedger, MemoryPgJsonStream, countMemoryCanonicalBytes, memoryJsonStringBytes, MEMORY_RUNTIME_FILE_BYTES,
  parseRealmRuntimeSaveArchive,
  parseRealmRuntimeSaveManifestV2,
  serializeRealmRuntimeSaveManifestV2,
  normalizeRealmRuntimeSaveEventForRestore,
  realmRuntimeSaveManifestFromData,
  validateDomainRecordClosure,
  runtimeFactReplayClosure,
  runtimeFinanceReplayClosure,
  runtimeReplaySourceSceneIds,
  RealmRuntimeSaveError,
  type RealmRuntimeSaveActionReceiptsV1,
  type RealmRuntimeSaveArchive,
  type RealmRuntimeSaveCharacterEffectsV1,
  type RealmRuntimeSaveFirstNightV1,
  type RealmRuntimeSaveGoalsV1,
  type RealmRuntimeSaveGoals,
  type RealmRuntimeSaveMemory,
  type RealmRuntimeSaveMemoryV1,

  type RealmRuntimeSaveMemoryV2,
  type RealmRuntimeSaveObservationsV1,
  type ResolvedRealmRuntimeSaveArchiveMemory,
  resolveRealmRuntimeSaveArchiveMemory,
  type RealmRuntimeSaveOutboxV1,
  type RealmRuntimeSaveRecordV1,
  type RealmRuntimeSaveEventV1,
  type RealmRuntimeSaveRestorableEvent,
  type RealmRuntimeSaveSelfPlayV1,
  type RealmRuntimeSaveTopologyV1,
} from "../../modules/world-transfer/realm-runtime-save.ts";
import { RealmRuntimeSaveDomainError, type RealmRuntimeSaveDomainV1 } from "../../modules/world-transfer/realm-runtime-domain-save.ts";
import { decodeScopedFactCommandReceipt, type ScopedFactReceiptRow } from "./committed-fact-command-repository.ts";
import { decodeScopedFinanceCommandReceipt, type ScopedFinanceReceiptRow } from "./project-finance-command-repository.ts";
import {
  createReplayContext, projectReplayContext, composeReplayContext, deduplicateReplayContexts,
  REPLAY_LINEAGE_MAX_BYTES, type ReplayClosure, type ReplayScopeV1, type ReplayContextV1, type StoredReplayBindingV1,
} from "../../modules/application/command-replay-lineage.ts";
import {
  normalizeStoryDefinition,
  storyDefinitionHashFor,
  storyNodeInstanceIdFor,
  storyUnlockEvidenceHashFor,
  storyUnlockIdempotencyKeyFor,
  storyUnlockLedgerIdFor,
  type StoryDefinition,
  type StoryUnlockRule,
  type StoryUnlockEvidence,
} from "../../modules/story-graph/public.ts";
import {
  projectFinanceCommandFingerprintFor,
  projectFinanceCommandGroupIdFor,
  type ProjectFinanceCommandFingerprintInput,
} from "../../modules/projects/public.ts";
import { normalizeSemanticEventKey } from "../../modules/application/project-finance-command.ts";
import {
  declaredSemanticEventsFromWorldSettings,
} from "../../modules/world-transfer/semantic-events.ts";
import {
  committedFactCommandIdFor,
  committedFactRequestFingerprintFor,
  evidenceHash,
} from "../../modules/application/committed-fact-command.ts";
import {
  LOCAL_WORLD_VERSION,
} from "../../modules/world-transfer/realm-save.ts";
import type { JsonValue } from "../../modules/runtime/public.ts";
import {decodeRecordGoalDefinition,rebaseRecordGoalDefinitions,type RecordGoalDefinitionVersion} from '../../modules/goals/record-authoring.ts';
import {rebaseNarrativeState} from '../../modules/application/narrative-situation.ts';
import {rebuildRecordNarrativeState} from './narrative-situation-repository.ts';
import {
  BASE_RULE_PACK_KEY,
  ensureWorldBaseRuleDefinitions,
  readWorldStyle,
} from "../../modules/application/base-rule-definitions.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export type RealmRuntimeSaveRepositoryErrorCode =
  | "PERFORMANCE_TRANSPORT_VERSION_UNSUPPORTED"
  | "PERFORMANCE_TRANSPORT_TARGET_UNSUPPORTED"
  | "GOAL_HISTORICAL_BINDING_UNRESOLVED"
  | "GOAL_TRANSPORT_VERSION_UNSUPPORTED"
  | "GOAL_TRANSPORT_TARGET_UNSUPPORTED"
  | "BACKUP_FORBIDDEN"
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

export interface RealmRuntimeSaveReader<TGoals extends RealmRuntimeSaveGoals = RealmRuntimeSaveGoalsV1> {
  load(input: {
    workspaceId: string;
    recordId: string;
    /** HTTP downloads contain private backup data; verify owner in the read transaction. */
    principalId: string;
    purpose: "record-export" | "whole-closure-backup" | "native-record-branch";
    /** The native branch caller already owns the source/head locks. */
    sessionProof?: string;
    /**
     * Optional caller-supplied Story Graph definitions (keyed by Story id).
     * The authoritative definitions are always loaded from the persisted
     * story_definition_bindings rows inside the reader transaction; a
     * supplied entry is only validated against that binding and the read
     * fails closed on any mismatch. Never required by production routes.
     */
    storyDefinitions?: ReadonlyMap<string, unknown>;
  }): Promise<RealmRuntimeSaveArchive<TGoals> | null>;
}

export interface RealmRuntimeSaveRestoreInput {
  workspaceId: string;
  principalId: string;
  sessionProof?: string;
  archive: RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>;
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
  importedDomainStoryCount: number;
  importedDomainRecordCount: number;
  /**
   * Story Graph definitions remapped to the restored Story ids. Callers
   * that reconcile/continue Stories after a restore must use these (their
   * ids and hash differ from the source definitions); undefined when the
   * archive carried no Story definitions.
   */
  storyDefinitions?: readonly {
    storyId: string;
    definitionHash: string;
    definition: StoryDefinition;
  }[];
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
  goalsSchemaVersion?: 2;
  performanceWitnessesSchemaVersion?: 1;
  resolveGoalSource?: GoalContentSourceResolver;
  resolveCommandPolicy?: CommandPolicyResolver;
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

interface DomainFinanceGroupRow extends QueryResultRow, ScopedFinanceReceiptRow {
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
  story_id: string;
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
  story_id: string;
  story_node_instance_id: string;
  node_key: string;
  transition: "unlocked" | "rolled_back";
  idempotency_key: string;
  record_id: string | null;
  evidence_event_ids: string[];
  evidence_hash: string;
  evidence: unknown;
}

interface DomainFactCommandRow extends QueryResultRow, ScopedFactReceiptRow {
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
  rule_pack_key: string;
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

async function assertFactReceiptTransportSupported(
  client: PoolClient,
  scope: { workspaceId: string; worldId: string; worldlineId: string },
  rows: readonly DomainFactCommandRow[],
  entries?: PerformanceWitnessEnvelopeV1[],
): Promise<void> {
  for (const row of rows) {
    const manifest = row.result_manifest;
    if (manifest === null || typeof manifest !== "object") continue;
    if (!Object.hasOwn(manifest,"performanceWitness") && !Object.hasOwn(manifest,"performanceTransport")) continue;
    let entry: PerformanceWitnessEnvelopeV1;
    try {
      if (Object.hasOwn(manifest,"performanceTransport")) entry=await readPerformanceTransport(client,scope,row.id,row);
      else {
        const source=await readPerformanceEvidenceSource(client,scope,row);
        if (!source) throw new PerformanceEvidenceReceiptError();
        entry=nativePerformanceWitness(source.receipt as unknown as PerformanceWitnessOriginV1);
      }
    } catch (error) {
      if (error instanceof PerformanceEvidenceReceiptError
        || (typeof error === "object" && error !== null && "code" in error && error.code === "42P01")) {
        throw restoreFailure("Performance source proof is invalid.");
      }
      throw error;
    }
    if (!entries) throw new RealmRuntimeSaveRepositoryError("PERFORMANCE_TRANSPORT_VERSION_UNSUPPORTED",
      "The consumer does not support complete performance witness transport.");
    entries.push(entry);
    row.result_manifest={request:entry.projection.request,result:entry.projection.result,
      performanceTransport:{version:1,digest:entry.digest}};
  }
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
      attempt:Number(row.attempt ?? 1),supersedesInstanceId:row.supersedes_instance_id ?? null,
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

type ExportCharacterRecord = { recordId: string; topology: RealmRuntimeSaveTopologyV1 };
type ExportCharacter = NonNullable<RealmRuntimeSaveTopologyV1["participants"][number]["character"]>;
// A fixed error, without private Record/Character identities, is shared by
// narrow refusal and malformed whole closure. No wire rows are reordered.
function invalidExportCharacters(): never {
  throw restoreFailure("Runtime Character export closure is incomplete or inconsistent.");
}
function indexExportCharacters(records: readonly ExportCharacterRecord[]) {
  const characters = new Map<string, { recordId: string; character: ExportCharacter }>();
  const definitions = new Map<string, string>(), continuities = new Map<string, string>();
  const participants = new Set<string>();
  for (const record of records) for (const participant of record.topology.participants) {
    if (participants.has(participant.sourceParticipantId)) invalidExportCharacters();
    participants.add(participant.sourceParticipantId);
    const character = participant.character;
    if (!character) continue;
    const previous = characters.get(character.sourceCharacterInstanceId);
    if (previous && (previous.recordId !== record.recordId
      || canonicalRestoreJson(previous.character) !== canonicalRestoreJson(character))) invalidExportCharacters();
    const definition = canonicalRestoreJson(character.definition);
    const continuity = canonicalRestoreJson({ definitionId: character.sourceDefinitionId, continuity: character.continuity });
    if ((definitions.has(character.sourceDefinitionId) && definitions.get(character.sourceDefinitionId) !== definition)
      || (continuities.has(character.sourceContinuityId) && continuities.get(character.sourceContinuityId) !== continuity)) invalidExportCharacters();
    definitions.set(character.sourceDefinitionId, definition);
    continuities.set(character.sourceContinuityId, continuity);
    characters.set(character.sourceCharacterInstanceId, { recordId: record.recordId, character });
  }
  return characters;
}
function validateExportCharacterClosure(records: readonly ExportCharacterRecord[]): void {
  const characters = indexExportCharacters(records);
  for (const { character } of characters.values()) {
    const id = character.sourcePredecessorInstanceId;
    if (id !== null && characters.get(id)?.character.sourceContinuityId !== character.sourceContinuityId) invalidExportCharacters();
  }
  // Reuse the existing DAG validator only for admission. Preserve the source
  // participant/Record wire order and the unchanged restorer's write ordering.
  try { restoreParentOrder([...characters.values()], row => row.character.sourceCharacterInstanceId,
    row => row.character.sourcePredecessorInstanceId, "Character"); }
  catch { invalidExportCharacters(); }
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

function mapSingleRecordMemory(
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
function mapMemory(
  conclusions: readonly MemoryConclusionRow[],
  snapshots: readonly MemorySnapshotRow[],
  relationshipStates: readonly RelationshipStateRow[],
  worldlineHead: { tick: number; ordinal: number },
  cacheEpochs: readonly { sourceObserverContinuityId: string; epoch: number }[],
  scope: { workspaceId: string; worldId: string; worldlineId: string },
): RealmRuntimeSaveMemoryV2 {
  return {
    format: "realm-runtime-memory",
    schemaVersion: 2,
    scope,
    worldlineHead,
    conclusions: [...conclusions].sort((a,b)=>Number(a.occurred_tick)-Number(b.occurred_tick)||Number(a.occurred_ordinal)-Number(b.occurred_ordinal)||Buffer.compare(Buffer.from(a.id),Buffer.from(b.id))).map((row) => ({
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
    snapshots: [...snapshots].sort((a,b)=>Number(a.cursor_tick)-Number(b.cursor_tick)||Number(a.cursor_ordinal)-Number(b.cursor_ordinal)||Buffer.compare(Buffer.from(a.id),Buffer.from(b.id))).map((row) => ({
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
    relationshipStates: [...relationshipStates].sort((a,b)=>Buffer.compare(Buffer.from(a.observer_continuity_id),Buffer.from(b.observer_continuity_id))||Buffer.compare(Buffer.from(a.target_entity_key),Buffer.from(b.target_entity_key))||Buffer.compare(Buffer.from(a.relation_kind),Buffer.from(b.relation_kind))).map((row) => ({
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
    cacheEpochs: [...cacheEpochs].sort((a,b)=>Buffer.compare(Buffer.from(a.sourceObserverContinuityId),Buffer.from(b.sourceObserverContinuityId))),
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
  stories: readonly DomainStoryRow[];
  storyDefinitions: readonly NonNullable<RealmRuntimeSaveDomainV1["storyDefinitions"]>[number][];
  records: readonly NonNullable<RealmRuntimeSaveDomainV1["records"]>[number][];
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

interface DomainStoryRow extends QueryResultRow {
  id: string;
  title: string;
  status: string;
  premise: string;
}

interface DomainSiblingRecordRow extends QueryResultRow {
  id: string;
  story_id: string;
  title: string;
  status: string;
  world_version: string;
  start_tick: string | number;
  start_ordinal: string | number;
  timeline_kind: string;
  linked_record_id: string | null;
  record_version: string | number;
  next_record_ordinal: string | number;
  last_event_id: string | null;
  last_world_tick: string | number | null;
  last_world_ordinal: string | number | null;
}



function mapDomain(
  source: { worldId: string; worldlineId: string; storyId: string; recordId: string },
  rows: DomainRows,
  receipts: ReadonlyMap<string, ReturnType<typeof decodeScopedFactCommandReceipt>>,
  financeReceipts: ReadonlyMap<string, ReturnType<typeof decodeScopedFinanceCommandReceipt>>,
): RealmRuntimeSaveDomainV1 {
  return {
    format: "realm-runtime-domain",
    schemaVersion: 1,
    source,
    stories: rows.stories.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status as NonNullable<RealmRuntimeSaveDomainV1["stories"]>[number]["status"],
      premise: row.premise,
    })),
    storyDefinitions: rows.storyDefinitions,
    records: rows.records,
    projects: rows.projects.map((row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      stage: row.stage,
      title: row.title,
      currency: "JPY",
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
      currency: "JPY",
      version: Number(row.version),
    })),
    financeAccounts: rows.financeAccounts.map((row) => ({
      id: row.id,
      currency: "JPY",
      status: row.status,
      openingBalanceMinor: Number(row.opening_balance_minor),
    })),
    ledgerEntries: rows.ledgerEntries.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      direction: row.direction,
      amountMinor: Number(row.amount_minor),
      currency: "JPY",
      category: row.category,
      memo: row.memo,
      projectId: row.project_id,
      sourceRecordId: row.source_record_id,
      sourceEventId: row.source_event_id,
      occurredAt: saveTimestamp(row.occurred_at),
      idempotencyKey: row.idempotency_key,
    })),
    financeCommandGroups: rows.financeCommandGroups.map((row) => {
      const receipt = financeReceipts.get(row.id)!;
      return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint,
        state: row.state,
        resultManifest: { ...jsonObject(receipt.result), ...(Object.hasOwn(jsonObject(row.result_manifest),"performanceTransport")
          ? {performanceTransport:jsonObject(row.result_manifest).performanceTransport!} : {}) },
        rejectionCode: row.rejection_code,
        policyVersion: row.policy_version,
        sourceRecordId: row.source_record_id,
        provenance: receipt.provenance!,
        request: receipt.request === null ? null : jsonObject(receipt.request),
      };
    }),
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
      storyId: row.story_id,
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
      storyId: row.story_id,
      storyNodeInstanceId: row.story_node_instance_id,
      nodeKey: row.node_key,
      transition: row.transition,
      idempotencyKey: row.idempotency_key,
      recordId: row.record_id,
      evidenceEventIds: [...row.evidence_event_ids],
      evidenceHash: row.evidence_hash,
      evidence: jsonObject(row.evidence),
    })),
    committedFactCommands: rows.committedFactCommands.map((row) => {
      const receipt = receipts.get(row.id)!;
      return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        requestFingerprint: row.request_fingerprint,
        kind: row.kind,
        resultManifest: { ...jsonObject(receipt.result), ...(Object.hasOwn(jsonObject(row.result_manifest),"performanceTransport")
          ? {performanceTransport:jsonObject(row.result_manifest).performanceTransport!} : {}) },
        provenance: receipt.provenance!,
        request: receipt.request === null ? null : jsonObject(receipt.request),
      };
    }),
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
      rulePackKey: row.rule_pack_key,
      quantity: Number(row.quantity),
      revision: Number(row.revision),
      metadata: jsonObject(row.metadata),
    })),
  };
}

interface LoadedRecordSections {
  record: RealmRuntimeSaveRecordV1;
  goals: RealmRuntimeSaveGoalsV1;
  topology: RealmRuntimeSaveTopologyV1;
  actionReceipts: RealmRuntimeSaveActionReceiptsV1;
  characterEffects: RealmRuntimeSaveCharacterEffectsV1;
  observations: RealmRuntimeSaveObservationsV1;
  outbox: RealmRuntimeSaveOutboxV1;
  firstNight: RealmRuntimeSaveFirstNightV1;
  selfPlay: RealmRuntimeSaveSelfPlayV1;
  eventIds: readonly string[];
}

// Fixed transfer buffers, never accepted collection cardinality limits.
const NON_MEMORY_RESOURCE_PAGE_ROWS = 1000;
const NON_MEMORY_RESOURCE_CHUNK_CHARS = 65536;
const NON_MEMORY_RESOURCE_CHUNK_BYTES = 65536;
const NON_MEMORY_RESOURCE_INLINE_BYTES = 256;
// pg JSON.parse can produce +/-Infinity from legal JSONB numerics. The
// historical jsonObject mapper then emits {} for the ENTIRE payload. Detect
// that before streaming, including a late overflow after a huge string, so a
// raw representation that normalizes to {} never acquires a new byte cap.
// This exact integer is the IEEE-754 round-to-nearest overflow midpoint:
// 2**1024 - 2**970. Values strictly below it round to a finite Number.
const EVENT_FINITE_NUMBER_BOUNDARY = "179769313486231580793728971405303415079934132710037826936173778980444968292764750946649017977587207096330286416692887910946555547851940402630657488671505820681908902000708383676273854845817711531764475730270069855571366959622842914819860834936475292719074168444365510704342711559699508093042880177904174497792";
const EVENT_NORMALIZED_PAYLOAD_SQL = `CASE WHEN jsonb_path_exists(payload,
  'strict $.** ? (@.type() == "number" && (@ >= ${EVENT_FINITE_NUMBER_BOUNDARY} || @ <= -${EVENT_FINITE_NUMBER_BOUNDARY}))')
  THEN '{}'::jsonb ELSE payload END`;
const EVENT_TEXT_COLUMNS = ["id", "event_kind", "speaker_name", "actor_participant_id",
  "scene_id", "visibility_policy_id", "calendar_id", "display_time", "content"] as const;

type RuntimeEventHeader = QueryResultRow & {
  record_version: string | number;
  record_ordinal: string | number;
  world_tick: string | number;
  world_ordinal: string | number;
  actor_is_null: boolean;
  payload_bytes: number;
};

/** Events are shared by ordinary/native roots, whole roots and every sibling.
 * Only scalar metadata and fixed-size inline values cross a page boundary. Every variable body travels
 * in bounded PostgreSQL character chunks under the existing file byte budget.
 * The schema's UNIQUE(workspace_id,record_id,record_ordinal) and PK(workspace_id,id)
 * make the original (record_ordinal,id) tuple a unique, lossless keyset cursor.
 */
async function loadRuntimeEventRows(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  scope: { workspaceId: string; worldId: string; worldlineId: string; recordId: string },
  head: { recordVersion: number; nextRecordOrdinal: number },
): Promise<{ rows: EventRow[] }> {
  const ledger = new RuntimeSectionWireLedger("runtime/record.json", "canonical-runtime");
  ledger.reserve({ format: "realm-runtime-record", schemaVersion: 1,
    scope: { worldId: scope.worldId, worldlineId: scope.worldlineId, recordId: scope.recordId }, head, events: [] });
  const rows: EventRow[] = [];
  let cursor: [string | number, string] | null = null;
  for (;;) {
    const answer = await client.query<RuntimeEventHeader>(
      `/* runtime event headers */ SELECT record_version, record_ordinal, world_tick, world_ordinal,
        actor_participant_id IS NULL AS actor_is_null,
        ${EVENT_TEXT_COLUMNS.map(column => `COALESCE(octet_length(${column}),0) AS ${column}_bytes, COALESCE(length(${column}),0) AS ${column}_chars,
          CASE WHEN octet_length(${column})<=${NON_MEMORY_RESOURCE_INLINE_BYTES} THEN ${column} ELSE NULL END AS ${column}`).join(",")},
        CASE WHEN octet_length((${EVENT_NORMALIZED_PAYLOAD_SQL})::text)<=${NON_MEMORY_RESOURCE_INLINE_BYTES}
          THEN (${EVENT_NORMALIZED_PAYLOAD_SQL}) ELSE NULL END AS payload,
        octet_length(convert_to((${EVENT_NORMALIZED_PAYLOAD_SQL})::text, 'UTF8')) AS payload_bytes
       FROM events WHERE workspace_id=$1 AND record_id=$2
         AND ($3::bigint IS NULL OR (record_ordinal,id)>($3::bigint,$4::text))
       ORDER BY record_ordinal ASC, id ASC LIMIT ${NON_MEMORY_RESOURCE_PAGE_ROWS}`,
      [scope.workspaceId, scope.recordId, cursor?.[0] ?? null, cursor?.[1] ?? null],
    );
    for (const header of answer.rows) {
      const row: EventRow = { id: "", record_version: header.record_version, record_ordinal: header.record_ordinal,
        event_kind: "", payload: {}, content: "", speaker_name: "", actor_participant_id: header.actor_is_null ? null : "",
        scene_id: "", visibility_policy_id: "", world_tick: header.world_tick, world_ordinal: header.world_ordinal,
        calendar_id: "", display_time: "" };
      for (const column of EVENT_TEXT_COLUMNS) {
        if (typeof header[column] === "string") row[column] = header[column];
      }
      const inlinePayload = header.payload !== null && typeof header.payload === "object";
      if (inlinePayload) row.payload = header.payload;
      if (rows.length) ledger.addExact(1); // actual emitted array comma
      ledger.reserve(mapEvent(row));
      // UTF8 source text is a conservative lower bound on JSON string contents;
      // escaping can only increase it. JSONB::text is NOT a wire-byte bound.
      const textLowerBound = EVENT_TEXT_COLUMNS.reduce((sum, column) => sum + (typeof header[column] === "string" ? 0 : Number(header[`${column}_bytes`])), 0);
      ledger.checkLowerBound(textLowerBound);
      const hydrateText = async (column: typeof EVENT_TEXT_COLUMNS[number]): Promise<string> => {
        if (typeof header[column] === "string") return header[column];
        const parts: string[] = [];
        for (let position = 1; position <= Number(header[`${column}_chars`]); position += NON_MEMORY_RESOURCE_CHUNK_CHARS) {
          const chunk = await client.query<{ value: string }>(
            `/* runtime event chunk */ SELECT substring(${column} FROM $4::integer FOR $5::integer) AS value
             FROM events WHERE workspace_id=$1 AND record_id=$2 AND record_ordinal=$3::bigint LIMIT 1`,
            [scope.workspaceId, scope.recordId, header.record_ordinal, position, NON_MEMORY_RESOURCE_CHUNK_CHARS],
          );
          if (typeof chunk.rows[0]?.value !== "string") throw restoreFailure("Runtime event text chunk is missing.");
          const value = chunk.rows[0].value;
          // PostgreSQL substring counts code points and never splits an astral
          // pair. Count exact JSON UTF8 contents before retaining each chunk.
          ledger.addExact(memoryJsonStringBytes(value) - 2);
          parts.push(value);
        }
        return parts.join("");
      };
      // Load other fields and normalized JSON before the potentially huge
      // content body, so an exact+1 ASCII content can fail without transferring it.
      for (const column of EVENT_TEXT_COLUMNS) {
        if (column === "content" || (column === "actor_participant_id" && header.actor_is_null)) continue;
        row[column] = await hydrateText(column);
      }
      if (!inlinePayload) {
        const payload = new MemoryPgJsonStream(ledger.remainingBytes + 2); // replace skeleton {}
        const byteLength = Number(header.payload_bytes);
        if (!Number.isSafeInteger(byteLength) || byteLength < 2) throw restoreFailure("Runtime event payload header is invalid.");
        const payloadCursor = `realm_event_payload_${randomUUID().replaceAll("-", "")}`;
        // Materialize the normalized JSONB-to-UTF8 conversion once for this
        // cursor. Reissuing CASE::text for every substring amplifies legal long
        // numeric spellings even when their final normalized output is tiny.
        // Byte slices avoid rescanning UTF8 character offsets for every chunk.
        await client.query(
          `/* runtime event payload cursor */ DECLARE ${payloadCursor} NO SCROLL CURSOR FOR
           WITH payload_bytes AS MATERIALIZED (
             SELECT convert_to((${EVENT_NORMALIZED_PAYLOAD_SQL})::text, 'UTF8') AS bytes
             FROM events WHERE workspace_id=$1 AND record_id=$2 AND record_ordinal=$3::bigint LIMIT 1
           ) SELECT substring(bytes FROM chunk_start FOR ${NON_MEMORY_RESOURCE_CHUNK_BYTES}) AS value
             FROM payload_bytes CROSS JOIN LATERAL
               generate_series(1, octet_length(bytes), ${NON_MEMORY_RESOURCE_CHUNK_BYTES}) AS positions(chunk_start)
             ORDER BY chunk_start`,
          [scope.workspaceId, scope.recordId, header.record_ordinal],
        );
        try {
          const decoder = new TextDecoder("utf-8", { fatal: true });
          for (let position = 0; position < byteLength; position += NON_MEMORY_RESOURCE_CHUNK_BYTES) {
            const chunk = await client.query<{ value: Buffer }>(
              `/* runtime event chunk */ FETCH FORWARD 1 FROM ${payloadCursor}`,
            );
            const value = chunk.rows[0]?.value;
            if (!Buffer.isBuffer(value) || value.length !== Math.min(NON_MEMORY_RESOURCE_CHUNK_BYTES, byteLength - position)) {
              throw restoreFailure("Runtime event payload chunk is missing or has an invalid length.");
            }
            payload.write(decoder.decode(value, { stream: true }));
          }
          payload.write(decoder.decode());
          row.payload = payload.finish();
        } catch (error) {
          try { await client.query(`CLOSE ${payloadCursor}`); } catch { /* preserve the original failure for transaction rollback */ }
          throw error;
        }
        await client.query(`CLOSE ${payloadCursor}`);
        ledger.addExact(payload.bytes - 2);
      }
      ledger.checkLowerBound(typeof header.content === "string" ? 0 : Number(header.content_bytes));
      row.content = await hydrateText("content");
      rows.push(row);
    }
    if (answer.rows.length < NON_MEMORY_RESOURCE_PAGE_ROWS) break;
    const last = rows.at(-1)!;
    // Keep pg bigint text, not Number or timestamp-millisecond cursors.
    cursor = [last.record_ordinal, last.id];
  }
  return { rows };
}

// PostgreSQL length counts code points; codec text bounds count UTF16 units.
// Only bounded candidates reach regexp_split_to_table, so a huge rejected
// field cannot cause an unbounded set expansion or cross the driver boundary.
const OUTBOX_BOUNDED_TEXT = { dedupe_key: 512, topic: 256, lease_owner: 256,
  last_error_code: 128, last_error_message: 4096 } as const;
function outboxTextValidSql(column: string, limit: number): string {
  return `CASE WHEN ${column} IS NULL THEN true WHEN length(${column})>${limit} THEN false
    ELSE (SELECT COALESCE(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)<=${limit}
      FROM regexp_split_to_table(${column}, '') AS characters(ch)) END`;
}

// Keep the historical jsonObject fallback for non-objects and for any
// nested number that pg would parse as Infinity. Never cap raw JSONB text:
// legal long decimals can normalize to a tiny JavaScript Number.
const OUTBOX_NORMALIZED_PAYLOAD_SQL = `CASE WHEN jsonb_typeof(payload)<>'object' THEN '{}'::jsonb
  ELSE (${EVENT_NORMALIZED_PAYLOAD_SQL}) END`;
type RuntimeOutboxHeader = OutboxRow & {
  created_at: string;
  row_locator: string;
  id_chars: number;
  id_bytes: number;
  event_id_chars: number;
  event_id_bytes: number;
  event_id_is_null: boolean;
};

/** Shared by ordinary/native roots and whole root/sibling snapshots.
 * Headers never transfer envelopes. ctid identifies this tuple only inside
 * the existing REPEATABLE READ transaction; it is not persisted as identity.
 * Chronology remains the original (created_at,id), with lossless pg text.
 */
async function loadRuntimeOutboxRows(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  scope: { workspaceId: string; worldId: string; worldlineId: string; recordId: string },
): Promise<{ rows: OutboxRow[] }> {
  const ledger = new RuntimeSectionWireLedger("runtime/outbox.json", "canonical-runtime");
  ledger.reserve(mapOutbox([]));
  const rows: OutboxRow[] = [];
  let cursor: [string, string] | null = null;
  const scopeValues = [scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId];
  for (;;) {
    const answer: { rows: RuntimeOutboxHeader[] } = await client.query<RuntimeOutboxHeader>(
      `/* runtime outbox headers; outbox preflight; outbox bounded envelope */ SELECT
        ctid::text AS row_locator, created_at::text AS created_at,
        ${["id", "event_id"].map(column => `COALESCE(length(${column}),0) AS ${column}_chars,
          COALESCE(octet_length(${column}),0) AS ${column}_bytes,
          CASE WHEN octet_length(${column})<=${NON_MEMORY_RESOURCE_INLINE_BYTES} THEN ${column} ELSE NULL END AS ${column}`).join(",")},
        event_id IS NULL AS event_id_is_null,
        ${Object.entries(OUTBOX_BOUNDED_TEXT).map(([column, limit]) => {
          const valid = outboxTextValidSql(column, limit);
          return `(${valid}) AS ${column}_valid, CASE WHEN (${valid}) THEN ${column} ELSE NULL END AS ${column}`;
        }).join(",")},
        state, attempt_count, available_at, lease_expires_at, last_error_at
       FROM outbox WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4
         AND state IN ('pending', 'delivering', 'retryable', 'failed')
         AND ($5::timestamptz IS NULL OR (created_at,id)>($5::timestamptz,$6::text))
       ORDER BY created_at ASC, id ASC LIMIT ${NON_MEMORY_RESOURCE_PAGE_ROWS}`,
      [...scopeValues, cursor?.[0] ?? null, cursor?.[1] ?? null],
    );
    for (const header of answer.rows) {
      for (const [column, limit] of Object.entries(OUTBOX_BOUNDED_TEXT)) {
        const value = header[column];
        if (header[`${column}_valid`] !== true || (value !== null
          && (typeof value !== "string" || !value.length || value.length > limit || value.trim() !== value))
          || (value === null && (column === "topic" || column === "dedupe_key"))) {
          throw restoreFailure(`Runtime outbox ${column} must be bounded trimmed text.`);
        }
      }
      if (!/^\(\d+,\d+\)$/.test(header.row_locator) || typeof header.created_at !== "string"
        || typeof header.event_id_is_null !== "boolean") throw restoreFailure("Runtime outbox header is invalid.");
      const row: OutboxRow = { ...header, id: typeof header.id === "string" ? header.id : "", payload: {},
        event_id: header.event_id_is_null ? null : typeof header.event_id === "string" ? header.event_id : "" };
      // Delegate state/lease/error/timestamp/attempt semantics to the existing
      // codec on a small skeleton, before opening an unrelated envelope.
      serializeRealmRuntimeSaveOutboxV1(mapOutbox([{ ...row, id: "preflight", event_id: row.event_id === null ? null : "preflight" }]));
      if (rows.length) ledger.addExact(1);
      ledger.reserve(mapOutbox([row]).messages[0]);
      const values = [...scopeValues, header.row_locator];
      for (const column of ["id", "event_id"] as const) {
        if (column === "event_id" && header.event_id_is_null) continue;
        const chars = Number(header[`${column}_chars`]), bytes = Number(header[`${column}_bytes`]);
        if (!Number.isSafeInteger(chars) || chars < 1 || !Number.isSafeInteger(bytes) || bytes < 1) {
          throw restoreFailure("Runtime outbox reference header is invalid.");
        }
        if (typeof header[column] === "string") {
          if (!/^[A-Za-z0-9._:-]+$/.test(header[column])) throw restoreFailure("Runtime outbox reference is invalid.");
          continue;
        }
        ledger.checkLowerBound(bytes);
        const parts: string[] = [];
        for (let position = 1; position <= chars; position += NON_MEMORY_RESOURCE_CHUNK_CHARS) {
          const chunk = await client.query<{ value: string }>(
            `/* runtime outbox reference chunk */ SELECT substring(${column} FROM $6::integer FOR $7::integer) AS value
             FROM outbox WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 AND ctid=$5::tid LIMIT 1`,
            [...values, position, NON_MEMORY_RESOURCE_CHUNK_CHARS],
          );
          const value = chunk.rows[0]?.value;
          // Both reference codecs accept this ASCII alphabet without a new
          // length ceiling. Validate each chunk before retaining its contents.
          if (typeof value !== "string" || value.length !== Math.min(NON_MEMORY_RESOURCE_CHUNK_CHARS, chars-position+1)
            || !/^[A-Za-z0-9._:-]+$/.test(value)) throw restoreFailure("Runtime outbox reference chunk is invalid.");
          ledger.addExact(memoryJsonStringBytes(value)-2);
          parts.push(value);
        }
        row[column] = parts.join("");
      }
      const payload = new MemoryPgJsonStream(ledger.remainingBytes + 2); // replace skeleton {}
      const payloadCursor = `realm_outbox_payload_${randomUUID().replaceAll("-", "")}`;
      // A single materialization per envelope. Subsequent FETCHes do not
      // repeat JSONB traversal, ::text conversion or UTF8 offset scans.
      await client.query(
        `/* runtime outbox payload cursor */ DECLARE ${payloadCursor} NO SCROLL CURSOR FOR
         WITH payload_bytes AS MATERIALIZED (
           SELECT convert_to((${OUTBOX_NORMALIZED_PAYLOAD_SQL})::text, 'UTF8') AS bytes
           FROM outbox WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 AND ctid=$5::tid LIMIT 1
         ) SELECT substring(bytes FROM chunk_start FOR ${NON_MEMORY_RESOURCE_CHUNK_BYTES}) AS value
           FROM payload_bytes CROSS JOIN LATERAL
             generate_series(1, octet_length(bytes), ${NON_MEMORY_RESOURCE_CHUNK_BYTES}) AS positions(chunk_start)
           ORDER BY chunk_start`, values,
      );
      try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          const chunk = await client.query<{ value: Buffer }>(`/* runtime outbox payload chunk */ FETCH FORWARD 1 FROM ${payloadCursor}`);
          if (!chunk.rows.length) break;
          const value = chunk.rows[0]?.value;
          if (chunk.rows.length !== 1 || !Buffer.isBuffer(value) || !value.length || value.length > NON_MEMORY_RESOURCE_CHUNK_BYTES) {
            throw restoreFailure("Runtime outbox envelope chunk is invalid.");
          }
          payload.write(decoder.decode(value, { stream: true }));
        }
        payload.write(decoder.decode());
        row.payload = jsonObject(payload.finish());
        ledger.addExact(payload.bytes - 2);
      } catch (error) {
        try { await client.query(`CLOSE ${payloadCursor}`); } catch { /* original error drives rollback */ }
        throw error;
      }
      await client.query(`CLOSE ${payloadCursor}`);
      // No accepted collection is retained until its exact emitted wire cost
      // has been admitted; the transfer parser also budgets before retaining.
      rows.push(row);
    }
    if (answer.rows.length < NON_MEMORY_RESOURCE_PAGE_ROWS) break;
    cursor = [answer.rows.at(-1)!.created_at, rows.at(-1)!.id];
  }
  return { rows };
}

/**
 * Load every persisted section of one Record through the production section
 * mappers. Shared by the saved Record itself and by every carried sibling
 * Record snapshot, so a sibling is a complete runnable Record — never an
 * evidence-only stub.
 */
async function loadRecordSections(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  scope: { workspaceId: string; worldId: string; worldlineId: string; recordId: string },
  head: { recordVersion: number; nextRecordOrdinal: number },
  nestedEvidenceLedger?: RuntimeSectionWireLedger,
): Promise<LoadedRecordSections> {
  const { workspaceId, worldId, worldlineId, recordId } = scope;
  const eventResult = await loadRuntimeEventRows(client, scope, head);
  const instanceResult = await client.query<GoalInstanceRow>(
    `SELECT id, goal_key, state, revision, progress, outcome, policy_version,
            definition_source,definition_id,resolution_kind,evidence_start_version,evidence_start_ordinal,attempt,supersedes_instance_id
     FROM goal_instances
     WHERE workspace_id = $1 AND record_id = $2
     ORDER BY id ASC`,
    [workspaceId, recordId],
  );
  const assessmentResult = await client.query<GoalAssessmentRow>(
    `SELECT id, goal_instance_id, source_event_id, source, status, result,
            evidence_event_ids, evidence_head_version, evidence_head_ordinal,
            evidence_snapshot_hash, policy_version
     FROM goal_assessments
     WHERE workspace_id = $1 AND record_id = $2
     ORDER BY created_at ASC, id ASC`,
    [workspaceId, recordId],
  );
  const topologyLedger = new RuntimeSectionWireLedger("runtime/topology.json", "canonical-runtime");
  topologyLedger.reserve({format:"realm-runtime-topology",schemaVersion:1,participants:[],scenes:[],visibilityPolicies:[]});
  const topologyResult = await readTopologyRows<ParticipantTopologyRow>(client, "participants", [workspaceId, worldId, worldlineId, recordId], topologyLedger, row => mapTopology([row], [], []).participants[0]);
  const sceneResult = await readTopologyRows<SceneTopologyRow>(client, "scenes", [workspaceId, worldId, worldlineId, recordId], topologyLedger, row => mapTopology([], [row], []).scenes[0]);
  const visibilityPolicyResult = await readTopologyRows<VisibilityPolicyTopologyRow>(client, "visibility", [workspaceId, worldId, worldlineId, recordId], topologyLedger, row => mapTopology([], [], [row]).visibilityPolicies[0]);
  const evidenceScope = [workspaceId, worldId, worldlineId, recordId];
  const receiptLedger = nestedEvidenceLedger ?? new RuntimeSectionWireLedger("runtime/action-receipts.json", "canonical-runtime");
  const effectLedger = nestedEvidenceLedger ?? new RuntimeSectionWireLedger("runtime/character-effects.json", "canonical-runtime");
  const observationLedger = nestedEvidenceLedger ?? new RuntimeSectionWireLedger("runtime/observations.json", "canonical-runtime");
  receiptLedger.reserve(mapActionReceipts([])); effectLedger.reserve(mapCharacterEffects([])); observationLedger.reserve(mapObservations([]));
  const actionReceiptResult = await readEvidenceRows<ActionReceiptRow>(client, "action_receipts", evidenceScope, receiptLedger, row => mapActionReceipts([row]).receipts[0]);
  const characterEffectResult = await readEvidenceRows<CharacterEffectRow>(client, "character_effects", evidenceScope, effectLedger, row => mapCharacterEffects([row]).effects[0]);
  const observationResult = await readEvidenceRows<ObservationRow>(client, "observations", evidenceScope, observationLedger, row => mapObservations([row]).observations[0]);
  // Outbox 只导出非终态消息；delivered 已送达，绝不进入存档。
  const outboxResult = await loadRuntimeOutboxRows(client, scope);
  const firstNightResult = await client.query<FirstNightRow>(
    `SELECT state, attempts, hook_content, suggestions, context
     FROM record_first_nights
     WHERE workspace_id = $1 AND record_id = $2 AND world_id = $3`,
    [workspaceId, recordId, worldId],
  );
  const selfPlayResult = await client.query<SelfPlaySessionRow>(
    `SELECT id, state, beat_budget, beats_completed, requested_by, last_error
     FROM record_self_play_sessions
     WHERE workspace_id = $1 AND record_id = $2 AND world_id = $3
     ORDER BY created_at ASC, id ASC`,
    [workspaceId, recordId, worldId],
  );

  const topology = mapTopology(topologyResult.rows, sceneResult.rows, visibilityPolicyResult.rows);
  topologyLedger.verify(countRuntimeSectionWireBytes(topology,"canonical-runtime"));
  const record: RealmRuntimeSaveRecordV1 = {
    format: "realm-runtime-record",
    schemaVersion: 1,
    scope: {
      worldId,
      worldlineId,
      recordId,
    },
    head: {
      recordVersion: head.recordVersion,
      nextRecordOrdinal: head.nextRecordOrdinal,
    },
    events: eventResult.rows.map(mapEvent),
  };
  const definitions = await client.query<{definition:unknown}>(
    "SELECT definition FROM record_goal_definitions WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 ORDER BY goal_id,definition_version",
    [workspaceId,worldId,worldlineId,recordId]);
  return {
    record,
    goals: mapGoals(instanceResult.rows, assessmentResult.rows,definitions.rows),
    topology,
    actionReceipts: mapActionReceipts(actionReceiptResult.rows),
    characterEffects: mapCharacterEffects(characterEffectResult.rows),
    observations: mapObservations(observationResult.rows),
    outbox: mapOutbox(outboxResult.rows),
    firstNight: mapFirstNight(firstNightResult.rows),
    selfPlay: mapSelfPlay(selfPlayResult.rows),
    eventIds: eventResult.rows.map((row) => row.id),
  };
}

// F4a3-M bounds memory traversal here. Complete Record/domain bodies above
// and below remain the separately deferred F4a3-N resource work.
/** Fixed query buffers; these bound pages/chunks, never accepted row count. */
export const MEMORY_RESOURCE_PAGE_ROWS = 1000;
export const MEMORY_RESOURCE_CHUNK_CHARS = 65536;
type MemoryClient = Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0];
type MemoryScope = {workspaceId:string;worldId:string;worldlineId:string};
type MemoryCollection = "conclusions"|"snapshots"|"relationships";
const MEMORY_OVERFLOW_NUMERIC = ((BigInt(1)<<BigInt(1024))-(BigInt(1)<<BigInt(970))).toString();

// Preserve jsonObject's existing non-object/nonfinite fallback, without asking
// the driver to JSON.parse a complete metadata payload first. The threshold
// is the exact binary64 overflow rounding midpoint, not a float SQL cast.
const memoryMetadataSql = `CASE WHEN jsonb_typeof(metadata) <> 'object' THEN '{}'::jsonb
  WHEN EXISTS (SELECT 1 FROM jsonb_path_query(metadata,'strict $.** ? (@.type() == "number")') j(v)
    WHERE abs((v #>> '{}')::numeric) >= '${MEMORY_OVERFLOW_NUMERIC}'::numeric) THEN '{}'::jsonb ELSE metadata END`;

const memoryLayouts = {
  conclusions:{table:"memory_conclusions",keys:["id"],ids:["id","observer_continuity_id","source_record_id","source_observation_id","supersedes_memory_id"],
    fields:{id:"sourceMemoryId",observer_continuity_id:"sourceObserverContinuityId",observed_entity_key:"observedEntityKey",source_record_id:"sourceRecordId",
      source_observation_id:"sourceObservationId",supersedes_memory_id:"sourceSupersedesMemoryId",operation:"operation",memory_kind:"memoryKind",
      embedding_model:"embeddingModel",occurred_tick:"occurredTick",occurred_ordinal:"occurredOrdinal",available_from_tick:"availableFromTick",available_from_ordinal:"availableFromOrdinal"},
    arrays:[{column:"keywords",wire:"keywords",max:256}],bounded:{observed_entity_key:512,embedding_model:256},
    empty:{content:"",keywords:[],semanticEmbedding:[],metadata:{},fidelity:0}},
  snapshots:{table:"memory_snapshots",keys:["id"],ids:["id","observer_continuity_id"],
    fields:{id:"sourceSnapshotId",observer_continuity_id:"sourceObserverContinuityId",snapshot_kind:"snapshotKind",cursor_tick:"cursorTick",cursor_ordinal:"cursorOrdinal",cache_epoch:"cacheEpoch",token_count:"tokenCount"},
    arrays:[{column:"item_ids",wire:"sourceItemIds",max:512}],bounded:{},empty:{content:"",sourceItemIds:[]}},
  relationships:{table:"relationship_states",keys:["observer_continuity_id","target_entity_key","relation_kind"],ids:["observer_continuity_id","source_record_id","source_observation_id"],
    fields:{observer_continuity_id:"sourceObserverContinuityId",target_entity_key:"targetEntityKey",relation_kind:"relationKind",source_record_id:"sourceRecordId",source_observation_id:"sourceObservationId",
      occurred_tick:"occurredTick",occurred_ordinal:"occurredOrdinal",available_from_tick:"availableFromTick",available_from_ordinal:"availableFromOrdinal"},
    arrays:[],bounded:{target_entity_key:512},empty:{content:"",fidelity:0}},
} as const;

interface MemoryPageHeader extends QueryResultRow {
  keys:string[];head:Record<string,JsonValue>;invalid:boolean;oversize:boolean;lower_bytes:string|number;
  content_bytes:string|number;content_chars:number;fidelity_text:string|null;
}

class BoundedMemoryCollection {
  readonly document:RealmRuntimeSaveMemoryV2;
  readonly ledger:MemoryWireByteLedger;
  readonly conclusions=new Map<string,MemoryConclusionRow>();
  readonly snapshots=new Map<string,MemorySnapshotRow>();
  readonly relationships=new Map<string,RelationshipStateRow>();
  private records=new Set<string>();
  private roots=false;
  private observers=new Set<string>();
  private observationOwners=new Map<string,{id:string;record_id:string;source_event_id:string|null}>();
  private eventOwners=new Map<string,{id:string;record_id:string;source_event_id:string|null}>();
  private anchors=new Map<string,string>();
  async owners(table:"observations"|"events",ids:readonly string[]){
    const cache=table==="observations"?this.observationOwners:this.eventOwners;
    const pending=[...new Set(ids)].filter(id=>!cache.has(id));
    for(const row of await loadMemoryOwnerHeaders(this.client,this.scope,table,pending))cache.set(row.id,row);
    return ids.flatMap(id=>cache.has(id)?[cache.get(id)!]:[]);
  }
  async anchor(observer:string){
    if(!this.anchors.has(observer))this.anchors.set(observer,await loadMemoryObserverAnchor(this.client,this.scope,observer));
    return this.anchors.get(observer)!;
  }
  private client:MemoryClient;
  private scope:MemoryScope;
  constructor(client:MemoryClient,scope:MemoryScope,head:{tick:number;ordinal:number}){
    this.client=client;this.scope=scope;
    this.document={format:"realm-runtime-memory",schemaVersion:2,scope,worldlineHead:head,conclusions:[],snapshots:[],relationshipStates:[],cacheEpochs:[]};
    this.ledger=new MemoryWireByteLedger(this.document);
  }
  private params():string[]{return [this.scope.workspaceId,this.scope.worldId,this.scope.worldlineId];}
  async epochs(ids:Iterable<string>):Promise<void>{
    const pending=[...new Set(ids)].filter(id=>!this.observers.has(id)).sort();
    for(let i=0;i<pending.length;i+=MEMORY_RESOURCE_PAGE_ROWS){
      const batch=pending.slice(i,i+MEMORY_RESOURCE_PAGE_ROWS);
      if(batch.some(id=>Buffer.byteLength(id)>512))throw restoreFailure("MemoryV2 identifier exceeds 512 bytes.");
      const answer=await this.client.query<{observer_continuity_id:string;epoch:number}>(
        `/* memory resource epoch header */ SELECT c.id AS observer_continuity_id,COALESCE(e.epoch,0) AS epoch FROM character_continuities c
         LEFT JOIN memory_cache_epochs e ON e.workspace_id=c.workspace_id AND e.observer_continuity_id=c.id
         WHERE c.workspace_id=$1 AND c.world_id=$2 AND c.worldline_id=$3 AND c.id=ANY($4::text[])
         ORDER BY c.id COLLATE "C" LIMIT ${MEMORY_RESOURCE_PAGE_ROWS}`, [...this.params(),batch]);
      if(answer.rows.length!==batch.length)throw restoreFailure("Runtime memory observer is outside the saved worldline.");
      for(const row of answer.rows){
        const value={sourceObserverContinuityId:row.observer_continuity_id,epoch:Number(row.epoch)};
        this.ledger.add(countMemoryCanonicalBytes(value)+(this.observers.size?1:0));
        this.observers.add(row.observer_continuity_id);
        (this.document.cacheEpochs as {sourceObserverContinuityId:string;epoch:number}[]).push(value);
      }
    }
  }
  private async hydrate(kind:MemoryCollection,header:MemoryPageHeader):Promise<Record<string,JsonValue>>{
    const layout=memoryLayouts[kind],row=header.head;
    const collection=kind==="relationships"?this.document.relationshipStates:this.document[kind];
    const comma=collection.length?1:0;
    const limit=this.ledger.remaining-comma;
    const fail=()=>{throw restoreFailure("MemoryV2 exceeds the runtime file byte limit.");};
    if(header.invalid)throw restoreFailure("MemoryV2 row contains an oversized identifier or bounded text field.");
    if(header.fidelity_text!==null)row.fidelity=Number(header.fidelity_text);
    let bytes=countMemoryCanonicalBytes(row);
    if(bytes+Number(header.lower_bytes)>limit)fail();
    const where=`workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND `+layout.keys.map((key,i)=>`${key}=$${i+4}`).join(" AND ");
    const params=[...this.params(),...header.keys];
    const base=params.length;
    const query=async(sql:string,extra:unknown[]=[])=>this.client.query(`/* memory resource hydrate */ ${sql} FROM ${layout.table} WHERE ${where} LIMIT 1`,[...params,...extra]);
    // Fixed 384-dimensional schema payload, independently of row/JSON size.
    if(kind==="conclusions"){
      const vector=(await query("SELECT semantic_embedding::text value")).rows[0]!.value as string;
      const value=parseVectorLiteral(vector);const extra=countMemoryCanonicalBytes(value)-2;
      if(bytes+extra>limit)fail();row.semanticEmbedding=value;bytes+=extra;
    }
    for(const array of layout.arrays){
      const bounds=(await query(`SELECT cardinality(${array.column}) n,COALESCE(array_lower(${array.column},1),1) lo`)).rows[0]!;
      const length=Number(bounds.n),lower=Number(bounds.lo);
      const items:JsonValue[]=[];
      for(let offset=0;offset<length;offset+=MEMORY_RESOURCE_PAGE_ROWS){
        const start=lower+offset,end=start+Math.min(MEMORY_RESOURCE_PAGE_ROWS,length-offset)-1;
        const slice=(await query(`SELECT ${array.column}[$${base+1}:$${base+2}] value`,[start,end])).rows[0]!.value as JsonValue[];
        for(const value of slice){const extra=countMemoryCanonicalBytes(value)+(items.length?1:0);if(bytes+extra>limit)fail();bytes+=extra;items.push(value);}
      }
      row[array.wire]=items;
    }
    if(kind==="conclusions"){
      const parser=new MemoryPgJsonStream(limit-bytes+2);
      for(let position=1;;){
        const part=(await query(`SELECT substring((${memoryMetadataSql})::text FROM $${base+1}::integer FOR $${base+2}::integer) value`,[position,MEMORY_RESOURCE_CHUNK_CHARS])).rows[0]!.value as string;
        if(!part)break;parser.write(part);position+=Array.from(part).length;
        if(Array.from(part).length<MEMORY_RESOURCE_CHUNK_CHARS)break;
      }
      row.metadata=parser.finish();bytes+=parser.bytes-2;
    }
    // Other exact normalized fields are known before content. Thus an ASCII
    // content that is one byte over the actual wire budget is refused before
    // ANY of that content is transferred, not after a full candidate read.
    if(bytes+Number(header.content_bytes)>limit)fail();
    const parts:string[]=[];
    for(let position=1;position<=Number(header.content_chars);position+=MEMORY_RESOURCE_CHUNK_CHARS){
      const part=(await query(`SELECT substring(content FROM $${base+1}::integer FOR $${base+2}::integer) value`,[position,MEMORY_RESOURCE_CHUNK_CHARS])).rows[0]!.value as string;
      const extra=memoryJsonStringBytes(part)-2;if(bytes+extra>limit)fail();bytes+=extra;parts.push(part);
    }
    row.content=parts.join("");this.ledger.add(bytes+comma);
    if(countMemoryCanonicalBytes(row)!==bytes)throw restoreFailure("Memory resource row byte ledger mismatch.");
    return row;
  }
  private async scan(kind:MemoryCollection,predicate:string,selection:unknown[]=[]):Promise<void>{
    const layout=memoryLayouts[kind],params=[...this.params(),...selection];
    const bounds=[...layout.ids.map(key=>`COALESCE(octet_length(${key}),0)>512`),
      ...Object.entries(layout.bounded).map(([key,max])=>`length(${key})>${max}`),
      ...layout.arrays.map(array=>`EXISTS (SELECT 1 FROM unnest(${array.column}) value WHERE length(value)>${array.max})`)];
    const invalid=`(${bounds.join(" OR ")})`;
    const fields=Object.entries(layout.fields).flatMap(([column,wire])=>[`'${wire}'`,column]);
    for(const [key,value] of Object.entries(layout.empty)){fields.push(`'${key}'`,`'${JSON.stringify(value).replaceAll("'","''")}'::jsonb`);}
    const arrayLower=layout.arrays.map(array=>`COALESCE((SELECT sum(octet_length(value)) FROM unnest(${array.column}) value),0)
      +CASE WHEN cardinality(${array.column})>0 THEN 3::bigint*cardinality(${array.column})-1 ELSE 0 END`);
    const metadataLower=kind==="conclusions"?`+COALESCE((SELECT sum(octet_length(v #>> '{}')) FROM jsonb_path_query((${memoryMetadataSql}),'strict $.** ? (@.type() == "string")') j(v)),0)
      +COALESCE((SELECT sum(octet_length(v #>> '{}')) FROM jsonb_path_query((${memoryMetadataSql}),'strict $.** ? (@.type() == "object").keyvalue().key') j(v)),0)`:"";
    let cursor:string[]|null=null;
    for(;;){
      const cursorStart=params.length+1;
      const keyTuple=`(${layout.keys.map(key=>`${key} COLLATE "C"`).join(",")})`;
      const next:string=cursor?`AND ${keyTuple} > (${layout.keys.map((_,i)=>`$${cursorStart+i}::text COLLATE "C"`).join(",")})`:"";
      const answer:{rows:MemoryPageHeader[]}=await this.client.query<MemoryPageHeader>(`/* memory resource header ${kind} */
        SELECT keys,invalid,lower_bytes,content_bytes,content_chars,fidelity_text,
          lower_bytes::numeric > ${this.ledger.remaining} AS oversize,
          CASE WHEN lower_bytes::numeric > ${this.ledger.remaining} THEN NULL ELSE wire_head END head
        FROM (SELECT CASE WHEN ${invalid} THEN NULL ELSE ARRAY[${layout.keys.join(",")}] END keys,
          ${invalid} AS invalid,CASE WHEN ${invalid} THEN NULL ELSE jsonb_build_object(${fields.join(",")}) END wire_head,
          octet_length(content)::bigint content_bytes,length(content) content_chars,
          ${kind==="snapshots"?"NULL::text":"fidelity::text"} fidelity_text,
          (octet_length(content)::bigint ${arrayLower.map(sql=>`+(${sql})`).join("")} ${metadataLower})::text lower_bytes
        FROM ${layout.table} WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND (${predicate}) ${next}
        ORDER BY ${layout.keys.map(key=>`${key} COLLATE "C"`).join(",")} LIMIT ${MEMORY_RESOURCE_PAGE_ROWS}) memory_headers ORDER BY keys COLLATE "C"`,[...params,...(cursor??[])]);
      for(const header of answer.rows){
        if(header.invalid)throw restoreFailure("MemoryV2 row contains an oversized identifier or bounded text field.");
        const key=JSON.stringify(header.keys);
        if(kind==="conclusions"&&this.conclusions.has(header.keys[0]!))continue;
        if(kind==="snapshots"&&this.snapshots.has(header.keys[0]!))continue;
        if(kind==="relationships"&&this.relationships.has(key))continue;
        if(header.oversize)throw restoreFailure("MemoryV2 exceeds the runtime file byte limit.");
        await this.epochs([String(header.head.sourceObserverContinuityId)]);
        const wire=await this.hydrate(kind,header);
        const sql=Object.fromEntries(Object.entries(layout.fields).map(([column,field])=>[column,wire[field]]));
        sql.content=wire.content;
        if(kind==="conclusions"){
          Object.assign(sql,{keywords:wire.keywords,semantic_embedding:JSON.stringify(wire.semanticEmbedding),metadata:wire.metadata,fidelity:wire.fidelity});
          this.conclusions.set(header.keys[0]!,sql as MemoryConclusionRow);
          (this.document.conclusions as unknown as JsonValue[]).push(wire);
        }else if(kind==="snapshots"){
          sql.item_ids=wire.sourceItemIds;this.snapshots.set(header.keys[0]!,sql as MemorySnapshotRow);
          (this.document.snapshots as unknown as JsonValue[]).push(wire);
        }else {sql.fidelity=wire.fidelity;this.relationships.set(key,sql as RelationshipStateRow);(this.document.relationshipStates as unknown as JsonValue[]).push(wire);}
      }
      if(answer.rows.length<MEMORY_RESOURCE_PAGE_ROWS)break;
      cursor=answer.rows.at(-1)!.keys;
    }
  }
  async load(recordIds:readonly string[],memoryIds:readonly string[]){
    if(!this.roots){await this.scan("snapshots","true");await this.scan("conclusions","source_record_id IS NULL");
      await this.scan("relationships","source_record_id IS NULL");this.roots=true;}
    for(const id of recordIds){if(this.records.has(id))continue;
      await this.scan("conclusions","source_record_id=$4",[id]);await this.scan("relationships","source_record_id=$4",[id]);this.records.add(id);}
    const pending=new Set<string>(memoryIds);
    for(const row of this.snapshots.values())for(const id of row.item_ids)pending.add(id);
    for(const row of this.conclusions.values())if(row.supersedes_memory_id!==null)pending.add(row.supersedes_memory_id);
    for(;;){
      const batch=[...pending].filter(id=>!this.conclusions.has(id)).sort().slice(0,MEMORY_RESOURCE_PAGE_ROWS);if(!batch.length)break;
      await this.scan("conclusions","id=ANY($4::text[])",[batch]);
      for(const id of batch){const row=this.conclusions.get(id);if(!row)throw restoreFailure("Runtime memory references a conclusion outside the saved worldline.");
        pending.delete(id);if(row.supersedes_memory_id!==null)pending.add(row.supersedes_memory_id);}
    }
    return {conclusions:[...this.conclusions.values()],snapshots:[...this.snapshots.values()],relationships:[...this.relationships.values()]};
  }
}

/** Memory closure owner headers only; complete Record payloads remain N. */
async function loadMemoryOwnerHeaders(client:MemoryClient,scope:MemoryScope,table:"observations"|"events",ids:readonly string[]){
  const result:{id:string;record_id:string;source_event_id:string|null}[]=[];
  const columns=table==="observations"?["record_id","source_event_id"]:["record_id"];
  for(let at=0;at<ids.length;at+=MEMORY_RESOURCE_PAGE_ROWS){
    const batch=[...new Set(ids.slice(at,at+MEMORY_RESOURCE_PAGE_ROWS))];
    const where=`workspace_id=$1 AND world_id=$2 AND worldline_id=$3`;
    const base=[scope.workspaceId,scope.worldId,scope.worldlineId];
    const answer=await client.query(`/* memory resource owner header */ SELECT array_position($4::text[],id) input_index,
      ${columns.map(column=>`octet_length(${column}) ${column}_bytes,length(${column}) ${column}_chars,
        CASE WHEN octet_length(${column})<=${MEMORY_RESOURCE_CHUNK_CHARS} THEN ${column} ELSE NULL END ${column}`).join(",")}
      FROM ${table} WHERE ${where} AND id=ANY($4::text[]) ORDER BY id COLLATE "C" LIMIT ${MEMORY_RESOURCE_PAGE_ROWS}`,[...base,batch]);
    for(const header of answer.rows){
      const id=batch[Number(header.input_index)-1]!;
      const values:Record<string,string|null>={};
      for(const column of columns){
        if(Number(header[`${column}_bytes`])>MEMORY_RUNTIME_FILE_BYTES)throw restoreFailure("Memory ownership identifier exceeds the runtime file byte limit.");
        if(header[column]!==null||header[`${column}_chars`]===null){values[column]=header[column] as string|null;continue;}
        const parts:string[]=[];
        for(let position=1;position<=Number(header[`${column}_chars`]);position+=MEMORY_RESOURCE_CHUNK_CHARS){
          const chunk=await client.query(`/* memory resource owner chunk */ SELECT substring(${column} FROM $5::integer FOR $6::integer) value
            FROM ${table} WHERE ${where} AND id=$4 LIMIT 1`,[...base,id,position,MEMORY_RESOURCE_CHUNK_CHARS]);
          parts.push(chunk.rows[0]!.value as string);
        }
        values[column]=parts.join("");
      }
      result.push({id,record_id:values.record_id!,source_event_id:values.source_event_id??null});
    }
  }
  return result;
}

async function loadMemoryObserverAnchor(client:MemoryClient,scope:MemoryScope,observer:string):Promise<string>{
  const from=`FROM participants AS participant
    JOIN character_instances AS instance ON instance.workspace_id=participant.workspace_id AND instance.world_id=participant.world_id
      AND instance.worldline_id=participant.worldline_id AND instance.record_id=participant.record_id AND instance.id=participant.character_instance_id
    JOIN records AS record ON record.workspace_id=instance.workspace_id AND record.world_id=instance.world_id
      AND record.worldline_id=instance.worldline_id AND record.id=instance.record_id
    WHERE instance.workspace_id=$1 AND instance.world_id=$2 AND instance.worldline_id=$3 AND instance.continuity_id=$4
    ORDER BY record.start_tick,record.start_ordinal,record.id COLLATE "C",instance.id COLLATE "C",participant.id COLLATE "C" LIMIT 1`;
  const params=[scope.workspaceId,scope.worldId,scope.worldlineId,observer];
  const header=(await client.query(`/* memory resource anchor header */ SELECT octet_length(record.id) bytes,length(record.id) chars,
    CASE WHEN octet_length(record.id)<=${MEMORY_RESOURCE_CHUNK_CHARS} THEN record.id ELSE NULL END record_id ${from}`,params)).rows[0];
  if(!header)throw restoreFailure("Runtime memory observer has no complete Record topology anchor (F4c dependency).");
  if(Number(header.bytes)>MEMORY_RUNTIME_FILE_BYTES)throw restoreFailure("Memory ownership identifier exceeds the runtime file byte limit.");
  if(header.record_id!==null)return header.record_id as string;
  const parts:string[]=[];
  for(let position=1;position<=Number(header.chars);position+=MEMORY_RESOURCE_CHUNK_CHARS){
    const chunk=await client.query(`/* memory resource anchor chunk */ SELECT substring(record.id FROM $5::integer FOR $6::integer) record_id ${from}`,
      [...params,position,MEMORY_RESOURCE_CHUNK_CHARS]);parts.push(chunk.rows[0]!.record_id as string);
  }
  return parts.join("");
}

/** Bound on carried sibling Records so a hostile/inconsistent worldline cannot fan out unbounded work. */
const MAX_DOMAIN_SIBLING_RECORDS = 64;

function seedFactContext(scope: ReplayScopeV1, closure: ReplayClosure): ReplayContextV1 {
  return createReplayContext({ format: "realm-command-lineage-context", version: 1, family: "fact",
    originScope: scope, currentScope: scope,
    identities: Object.fromEntries(Object.entries(closure).map(([kind, ids]) => [kind, ids.map((id) => [id, id])])) });
}

function seedFinanceContext(scope: ReplayScopeV1, closure: ReplayClosure): ReplayContextV1 {
  return createReplayContext({ format: "realm-command-lineage-context", version: 1, family: "finance",
    originScope: scope, currentScope: scope,
    identities: Object.fromEntries(Object.entries(closure).map(([kind, ids]) => [kind, ids.map((id) => [id, id])])) });
}

async function loadStoryBindings(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  source: {workspaceId:string;worldId:string;worldlineId:string},
  nodeRows: readonly DomainStoryNodeRow[],
  storyDefinitionInputs?: ReadonlyMap<string,unknown>,
): Promise<NonNullable<RealmRuntimeSaveDomainV1["storyDefinitions"]>> {
  const bindingRows = await client.query<{
    story_id: string;
    definition_hash: string;
    definition: unknown;
    origin: string;
    source_workspace_id: string | null;
    source_story_id: string | null;
    source_definition_hash: string | null;
  }>(
    `SELECT story_id, definition_hash, definition, origin,
            source_workspace_id, source_story_id, source_definition_hash
     FROM story_definition_bindings
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND story_id = ANY($4::text[])
     ORDER BY story_id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, [...new Set(nodeRows.map(row=>row.story_id))]],
  );
  const bindings = new Map(bindingRows.rows.map((row) => [row.story_id, row]));
  const storyDefinitions: NonNullable<RealmRuntimeSaveDomainV1["storyDefinitions"]>[number][] = [];
  const nodeStoryIds = [...new Set(nodeRows.map((row) => row.story_id))].sort();
  for (const storyId of nodeStoryIds) {
    const binding = bindings.get(storyId);
    if (!binding) {
      throw new RealmRuntimeSaveRepositoryError(
        "RUNTIME_SAVE_INVALID",
        "Runtime domain Story node rows predate persisted definition bindings; rematerialize the Story Graph with its authoritative definition.",
      );
    }
    let normalized;
    try {
      normalized = normalizeStoryDefinition(binding.definition as Parameters<typeof normalizeStoryDefinition>[0]);
    } catch {
      throw new RealmRuntimeSaveRepositoryError(
        "RUNTIME_SAVE_INVALID",
        "Runtime domain persisted Story definition is invalid.",
      );
    }
    if (storyDefinitionHashFor(normalized) !== binding.definition_hash) {
      throw new RealmRuntimeSaveRepositoryError(
        "RUNTIME_SAVE_INVALID",
        "Runtime domain persisted Story definition does not match its binding hash.",
      );
    }
    const supplied = storyDefinitionInputs?.get(storyId);
    if (supplied !== undefined) {
      let suppliedNormalized;
      try {
        suppliedNormalized = normalizeStoryDefinition(supplied as Parameters<typeof normalizeStoryDefinition>[0]);
      } catch {
        throw new RealmRuntimeSaveRepositoryError(
          "RUNTIME_SAVE_INVALID",
          "Runtime domain supplied Story definition is invalid.",
        );
      }
      if (storyDefinitionHashFor(suppliedNormalized) !== binding.definition_hash) {
        throw new RealmRuntimeSaveRepositoryError(
          "RUNTIME_SAVE_INVALID",
          "Runtime domain supplied Story definition does not match the persisted binding.",
        );
      }
    }
    for (const row of nodeRows) {
      if (row.story_id === storyId && row.definition_hash !== binding.definition_hash) {
        throw new RealmRuntimeSaveRepositoryError(
          "RUNTIME_SAVE_INVALID",
          "Runtime domain Story definition binding does not match the materialized node rows.",
        );
      }
    }
    // A binding written by a restore carries immutable first-known origin
    // provenance; the archive must carry it forward literally so a repeated
    // restore never relabels the previous target as the source. Native
    // materializations have no origin and omit the field entirely. The
    // schema CHECK guarantees restore ⇒ complete source identity; verify
    // anyway rather than weaken the contract.
    if (binding.origin === "restore") {
      if (
        binding.source_workspace_id === null
        || binding.source_story_id === null
        || binding.source_definition_hash === null
      ) {
        throw new RealmRuntimeSaveRepositoryError(
          "RUNTIME_SAVE_INVALID",
          "Runtime domain persisted Story binding origin is incomplete.",
        );
      }
      storyDefinitions.push({
        storyId,
        definitionHash: binding.definition_hash,
        definition: normalized as unknown as Readonly<Record<string, JsonValue>>,
        sourceBinding: {
          workspaceId: binding.source_workspace_id,
          storyId: binding.source_story_id,
          definitionHash: binding.source_definition_hash,
        },
      });
    } else {
      storyDefinitions.push({
        storyId,
        definitionHash: binding.definition_hash,
        definition: normalized as unknown as Readonly<Record<string, JsonValue>>,
      });
    }
  }

  return storyDefinitions;
}

async function loadDomainSnapshot(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  source: { workspaceId: string; worldId: string; worldlineId: string; storyId: string; recordId: string },
  savedEventIds: ReadonlySet<string>,
  storyDefinitionInputs: ReadonlyMap<string, unknown> | undefined,
  primary: { record: RealmRuntimeSaveRecordV1; topology: RealmRuntimeSaveTopologyV1; observations: RealmRuntimeSaveObservationsV1 },
  performanceEntries?: PerformanceWitnessEnvelopeV1[],
): Promise<{ domain: RealmRuntimeSaveDomainV1; memory: RealmRuntimeSaveMemoryV2 }> {
  // Coherent whole-worldline domain scope: finance accounts/ledger/commands,
  // obligations, relationship history, and assessments are worldline-owned;
  // EVERY Project of the worldline is carried with its links to ANY Story
  // (a Project owned by another Story or shared between Stories is never
  // filtered away — its finance must not dangle); Story Graph state spans
  // every Story and every Record of the worldline; every Record that owns
  // domain evidence is carried as a complete sibling snapshot.
  const nestedEvidenceLedger = new RuntimeSectionWireLedger("runtime/domain.json", "normalized-domain");
  const stories = await client.query<DomainStoryRow>(
    `SELECT id, title, status, premise
     FROM stories
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const projects = await client.query<DomainProjectRow>(
    `SELECT id, kind, status, stage, title, currency, deadline::text, version
     FROM projects AS project
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const projectIds = projects.rows.map((row) => row.id);
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
     ORDER BY project_id ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
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
    `SELECT workspace_id, world_id, worldline_id, id, idempotency_key, request_fingerprint, state,
            CASE WHEN octet_length(result_manifest::text) <= $4 THEN result_manifest ELSE NULL END AS result_manifest,
            octet_length(result_manifest::text) > $4 AS receipt_oversized,
            rejection_code, policy_version, source_record_id
     FROM project_finance_command_groups
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, REPLAY_LINEAGE_MAX_BYTES * 2],
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
    `SELECT id, story_id, node_key, state, revision, record_id, definition_hash,
            unlock_evidence_event_ids, unlock_evidence
     FROM story_node_instances
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY story_id ASC, node_key ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const storyUnlockLedger = await client.query<DomainUnlockRow>(
    `SELECT id, story_id, story_node_instance_id, node_key, transition, idempotency_key,
            record_id, evidence_event_ids, evidence_hash, evidence
     FROM story_unlock_ledger
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const committedFactCommands = await client.query<DomainFactCommandRow>(
    `SELECT workspace_id, world_id, worldline_id, id, idempotency_key, request_fingerprint, kind,
            CASE WHEN octet_length(result_manifest::text) <= $4 THEN result_manifest ELSE NULL END AS result_manifest,
            octet_length(result_manifest::text) > $4 AS receipt_oversized
     FROM committed_fact_commands
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, REPLAY_LINEAGE_MAX_BYTES * 2],
  );
  await assertFactReceiptTransportSupported(client, source, committedFactCommands.rows, performanceEntries);
  const performanceAssessments = await client.query<DomainAssessmentRow>(
    `SELECT id, record_id, policy_version, score, evidence_event_ids,
            evidence_snapshot_hash, command_id
     FROM performance_assessments
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const memberRelationshipRevisions = await client.query<DomainRelationshipRow>(
    `SELECT id, subject_entity_key, object_entity_key, relation_kind,
            revision_ordinal, source_event_id, source_record_id,
            occurred_tick, occurred_ordinal, command_id
     FROM member_relationship_revisions
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY subject_entity_key ASC, object_entity_key ASC,
              relation_kind ASC, revision_ordinal ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  const characterAssets = await client.query<DomainAssetRow>(
    `SELECT ca.record_id, ca.character_instance_id, ca.asset_definition_id,
            ad.asset_key, ad.rule_pack_key,
            ca.quantity, ca.revision, ca.metadata
     FROM character_assets ca
     JOIN asset_definitions ad
       ON ad.workspace_id = ca.workspace_id
      AND ad.world_id = ca.world_id
      AND ad.id = ca.asset_definition_id
     WHERE ca.workspace_id = $1 AND ca.world_id = $2 AND ca.worldline_id = $3
     ORDER BY ca.character_instance_id ASC, ca.asset_definition_id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );

  // Evidence closure: every Record/Event identity referenced by the carried
  // domain rows must resolve to the saved Record (whose events are in the
  // Record section) or to an explicitly carried sibling Record snapshot.
  const referencedRecordIds = new Set<string>();
  const referencedEventIds = new Set<string>();
  const referenceRecord = (value: string | null) => {
    if (value !== null) referencedRecordIds.add(value);
  };
  const referenceEvent = (value: string | null) => {
    if (value !== null) referencedEventIds.add(value);
  };
  for (const row of milestones.rows) {
    referenceRecord(row.completion_record_id);
    referenceEvent(row.completion_event_id);
  }
  for (const row of ledgerEntries.rows) {
    referenceRecord(row.source_record_id);
    referenceEvent(row.source_event_id);
  }
  for (const row of financeCommandGroups.rows) {
    referenceRecord(row.source_record_id);
  }
  for (const row of storyNodes.rows) {
    referenceRecord(row.record_id);
    row.unlock_evidence_event_ids.forEach((id) => referenceEvent(id));
  }
  for (const row of storyUnlockLedger.rows) {
    referenceRecord(row.record_id);
    row.evidence_event_ids.forEach((id) => referenceEvent(id));
  }
  for (const row of memberRelationshipRevisions.rows) {
    referenceRecord(row.source_record_id);
    referenceEvent(row.source_event_id);
  }
  for (const row of performanceAssessments.rows) {
    referenceRecord(row.record_id);
    row.evidence_event_ids.forEach((id) => referenceEvent(id));
  }
  for (const row of characterAssets.rows) {
    referenceRecord(row.record_id);
  }

  for (const eventId of referencedEventIds) {
    if (savedEventIds.has(eventId)) referencedEventIds.delete(eventId);
  }
  referencedRecordIds.delete(source.recordId);
  // Authored definitions and formal narrative events are new shipped roots.
  // They must survive a full closure even without a finance/memory dependency.
  const nativeRoots=await client.query<{id:string}>(
    `SELECT record.id FROM records record
     WHERE record.workspace_id=$1 AND record.world_id=$2 AND record.worldline_id=$3
       AND (EXISTS(SELECT 1 FROM record_goal_definitions definition
         WHERE definition.workspace_id=record.workspace_id AND definition.record_id=record.id)
         OR EXISTS(SELECT 1 FROM goal_instances goal
           WHERE goal.workspace_id=record.workspace_id AND goal.world_id=record.world_id
             AND goal.worldline_id=record.worldline_id AND goal.record_id=record.id
             AND goal.scope_kind='record' AND goal.definition_source='content')
         OR EXISTS(SELECT 1 FROM events event WHERE event.workspace_id=record.workspace_id AND event.record_id=record.id
           AND event.event_kind='narration.committed' AND (event.payload#>'{__realmRuntimePayload,narrativeState}' IS NOT NULL
             OR event.payload->'narrativeState' IS NOT NULL)))
     ORDER BY record.id LIMIT $4`,[source.workspaceId,source.worldId,source.worldlineId,MAX_DOMAIN_SIBLING_RECORDS+2]);
  if(nativeRoots.rows.length>MAX_DOMAIN_SIBLING_RECORDS+1)throw restoreFailure("Runtime domain sibling Record closure exceeds the supported bound.");
  for(const record of nativeRoots.rows)if(record.id!==source.recordId)referenceRecord(record.id);

  const siblingRows = new Map<string, DomainSiblingRecordRow>();
  const siblingSections = new Map<string, LoadedRecordSections>();
  // This cache contains typed DB owners, not inferred ID prefixes or wire
  // positions. Every owner is later checked against its complete topology.
  const characterOwners = new Map<string, { id: string; record_id: string; continuity_id: string }>();
  const carriedEventIds = new Set<string>(savedEventIds);
  const neededMemoryIds = new Set<string>();
  const resourceHead=(await client.query<{head_tick:string|number;head_ordinal:string|number}>(
    `/* memory resource head */ SELECT head_tick,head_ordinal FROM worldlines WHERE workspace_id=$1 AND world_id=$2 AND id=$3`,
    [source.workspaceId,source.worldId,source.worldlineId])).rows[0]??{head_tick:0,head_ordinal:0};
  const memoryState=new BoundedMemoryCollection(client,{workspaceId:source.workspaceId,worldId:source.worldId,worldlineId:source.worldlineId},
    {tick:Number(resourceHead.head_tick),ordinal:Number(resourceHead.head_ordinal)});
  const resourceObservers=(sections:readonly Pick<LoadedRecordSections,"topology">[])=>sections.flatMap(section=>section.topology.participants
    .flatMap(row=>row.character?[row.character.sourceContinuityId]:[]));
  await memoryState.epochs(resourceObservers([primary]));
  let memoryRows: Awaited<ReturnType<BoundedMemoryCollection["load"]>>;
  // The root's linked Record is a real dependency too.
  const rootLink = await client.query<{ linked_record_id: string | null }>(
    `SELECT linked_record_id FROM records WHERE workspace_id = $1 AND world_id = $2
       AND worldline_id = $3 AND id = $4`,
    [source.workspaceId, source.worldId, source.worldlineId, source.recordId]);
  referenceRecord(rootLink.rows[0]?.linked_record_id ?? null);
  for (;;) {
    const characterRecords = [{ recordId: source.recordId, topology: primary.topology },
      ...[...siblingSections].map(([recordId, sections]) => ({ recordId, topology: sections.topology }))];
    const characters = indexExportCharacters(characterRecords);
    for (const owner of characterOwners.values()) {
      const carried = characters.get(owner.id);
      if ((owner.record_id === source.recordId || siblingSections.has(owner.record_id))
        && (!carried || carried.recordId !== owner.record_id || carried.character.sourceContinuityId !== owner.continuity_id)) invalidExportCharacters();
    }
    const missing = new Map<string, string>();
    for (const { character } of characters.values()) {
      const predecessor = character.sourcePredecessorInstanceId;
      if (predecessor === null) continue;
      const carried = characters.get(predecessor);
      if (carried) {
        if (carried.character.sourceContinuityId !== character.sourceContinuityId) invalidExportCharacters();
      } else {
        if (missing.has(predecessor) && missing.get(predecessor) !== character.sourceContinuityId) invalidExportCharacters();
        missing.set(predecessor, character.sourceContinuityId);
      }
    }
    const pending = [...missing.keys()].filter(id => !characterOwners.has(id)).sort();
    for (let offset = 0; offset < pending.length; offset += 1000) {
      const batch = pending.slice(offset, offset + 1000);
      const owners = await client.query<{ id: string; record_id: string; continuity_id: string;
        workspace_id: string; world_id: string; worldline_id: string }>(
        `/* export character predecessor owners */ SELECT id,record_id,continuity_id,workspace_id,world_id,worldline_id
         FROM character_instances WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3
           AND id=ANY($4::text[]) ORDER BY id ASC LIMIT 1000`,
        [source.workspaceId, source.worldId, source.worldlineId, batch],
      );
      if (owners.rows.length !== batch.length) invalidExportCharacters();
      const seen = new Set<string>();
      for (const owner of owners.rows) {
        if (!batch.includes(owner.id) || seen.has(owner.id) || owner.workspace_id !== source.workspaceId
          || owner.world_id !== source.worldId || owner.worldline_id !== source.worldlineId
          || owner.continuity_id !== missing.get(owner.id) || !owner.record_id) invalidExportCharacters();
        seen.add(owner.id);
        characterOwners.set(owner.id, owner);
        if (owner.record_id === source.recordId || siblingSections.has(owner.record_id)) invalidExportCharacters();
        referenceRecord(owner.record_id);
      }
    }
    const carriedRecordIds = [source.recordId, ...siblingRows.keys()];
    memoryRows = await memoryState.load(carriedRecordIds, [...neededMemoryIds]);
    const memoryById = new Map(memoryRows.conclusions.map((row) => [row.id, row]));
    const requiredBefore = neededMemoryIds.size;
    for (const row of memoryRows.snapshots) row.item_ids.forEach((id) => neededMemoryIds.add(id));
    const observationIds = new Set<string>();
    const observerIds = new Set<string>();
    for (const row of memoryRows.conclusions) {
      if (row.supersedes_memory_id !== null) neededMemoryIds.add(row.supersedes_memory_id);
      referenceRecord(row.source_record_id);
      if (row.source_observation_id !== null) observationIds.add(row.source_observation_id);
      observerIds.add(row.observer_continuity_id);
    }
    for (const row of memoryRows.relationships) {
      referenceRecord(row.source_record_id);
      if (row.source_observation_id !== null) observationIds.add(row.source_observation_id);
      observerIds.add(row.observer_continuity_id);
    }
    for (const row of memoryRows.snapshots) observerIds.add(row.observer_continuity_id);
    if (requiredBefore === neededMemoryIds.size && [...neededMemoryIds].some((id) => !memoryById.has(id))) {
      throw restoreFailure("Runtime memory references a conclusion outside the saved worldline.");
    }
    if (observationIds.size) {
      const owners = {rows:await memoryState.owners("observations",[...observationIds])};
      if (owners.rows.length !== observationIds.size) throw restoreFailure("Runtime memory references an observation outside the saved worldline.");
      for (const row of owners.rows) { referenceRecord(row.record_id); referenceEvent(row.source_event_id); }
    }
    const knownObservers = new Set<string>();
    for (const section of [primary, ...siblingSections.values()]) {
      for (const row of section.observations.observations) referenceEvent(row.sourceEventId);
      for (const participant of section.topology.participants) {
        if (participant.character) knownObservers.add(participant.character.sourceContinuityId);
      }
    }
    for (const observer of [...observerIds].sort()) {
      if (knownObservers.has(observer)) continue;
      referenceRecord(await memoryState.anchor(observer));
    }
    const eventBatch = [...referencedEventIds].filter((id) => !carriedEventIds.has(id));
    if (eventBatch.length) {
      const owners = {rows:await memoryState.owners("events",eventBatch)};
      if (owners.rows.length !== eventBatch.length) throw restoreFailure("Runtime domain references evidence events outside the saved worldline.");
      for (const row of owners.rows) referenceRecord(row.record_id);
    }
    const recordBatch = [...referencedRecordIds].filter((id) => id !== source.recordId && !siblingRows.has(id));
    if (siblingRows.size + recordBatch.length > MAX_DOMAIN_SIBLING_RECORDS) {
      throw restoreFailure("Runtime domain sibling Record closure exceeds the supported bound.");
    }
    if (recordBatch.length === 0 && requiredBefore === neededMemoryIds.size) {
      if (eventBatch.length) throw restoreFailure("Runtime domain evidence event projection is incomplete.");
      break;
    }
    if (recordBatch.length) {
      const records = await client.query<DomainSiblingRecordRow>(
        `SELECT record.id, record.story_id, record.title, record.status,
                record.world_version, record.start_tick, record.start_ordinal,
                record.timeline_kind, record.linked_record_id,
                head.record_version, head.next_record_ordinal, head.last_event_id,
                head.last_world_tick, head.last_world_ordinal
         FROM records AS record
         JOIN record_heads AS head
           ON head.workspace_id = record.workspace_id
          AND head.record_id = record.id
         WHERE record.workspace_id = $1 AND record.world_id = $2
           AND record.worldline_id = $3 AND record.id = ANY($4::text[])
         ORDER BY record.start_tick ASC, record.start_ordinal ASC, record.id ASC`,
        [source.workspaceId, source.worldId, source.worldlineId, recordBatch],
      );
      if (records.rows.length !== recordBatch.length) throw restoreFailure("Runtime domain references Records outside the saved worldline.");
      for (const row of records.rows) {
        siblingRows.set(row.id, row);
        referenceRecord(row.linked_record_id);
        // Exact three evidence property names and the two separators between them.
        nestedEvidenceLedger.addExact(Buffer.byteLength('"actionReceipts":,"characterEffects":,"observations":'));
        const sections = await loadRecordSections(client,
          { workspaceId: source.workspaceId, worldId: source.worldId, worldlineId: source.worldlineId, recordId: row.id },
          { recordVersion: Number(row.record_version), nextRecordOrdinal: Number(row.next_record_ordinal) }, nestedEvidenceLedger);
        siblingSections.set(row.id, sections);
        await memoryState.epochs(resourceObservers([sections]));
        for (const id of sections.eventIds) carriedEventIds.add(id);
      }
    }
  }
  validateExportCharacterClosure([{ recordId: source.recordId, topology: primary.topology },
    ...[...siblingSections].map(([recordId, sections]) => ({ recordId, topology: sections.topology }))]);
  const { workspaceId, worldId, worldlineId } = source;
  const memory = mapMemory(memoryRows.conclusions, memoryRows.snapshots, memoryRows.relationships,
    memoryState.document.worldlineHead, memoryState.document.cacheEpochs,{workspaceId,worldId,worldlineId});
  memoryState.ledger.verify(memory);

  // Story Graph definitions: a Story with materialized node rows must carry
  // the exact definition it was materialized from. The authoritative binding
  // is loaded from story_definition_bindings inside this same reader
  // transaction (single coherent snapshot); a caller-supplied definition may
  // only be validated against the persisted binding, never replace it.
  const storyDefinitions = await loadStoryBindings(client,source,storyNodes.rows,storyDefinitionInputs);

  const records: NonNullable<RealmRuntimeSaveDomainV1["records"]>[number][] = [...siblingRows.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => {
      const sections = siblingSections.get(row.id)!;
      return {
        recordId: row.id,
        storyId: row.story_id,
        title: row.title,
        status: row.status as NonNullable<RealmRuntimeSaveDomainV1["records"]>[number]["status"],
        worldVersion: row.world_version,
        startTick: Number(row.start_tick),
        startOrdinal: Number(row.start_ordinal),
        timelineKind: row.timeline_kind as NonNullable<RealmRuntimeSaveDomainV1["records"]>[number]["timelineKind"],
        linkedRecordId: row.linked_record_id,
        lastEventId: row.last_event_id,
        lastWorldTick: row.last_world_tick === null ? null : Number(row.last_world_tick),
        lastWorldOrdinal: row.last_world_ordinal === null ? null : Number(row.last_world_ordinal),
        bundle: {
          record: sections.record,
          goals: sections.goals,
          topology: sections.topology,
          actionReceipts: sections.actionReceipts,
          characterEffects: sections.characterEffects,
          observations: sections.observations,
          // Worldline memory lives in the root archive (V2); sibling bundles
          // carry no memory section so the resolver sees a single source.
          outbox: sections.outbox,
          firstNight: sections.firstNight,
          selfPlay: sections.selfPlay,
        },
      };
    });

  const receiptRows = new Map(committedFactCommands.rows.map((row) => [row.id, row]));
  const contextCache = new Map<string, { row: ScopedFactReceiptRow; context: ReplayContextV1 }>();
  const receipts = new Map<string, ReturnType<typeof decodeScopedFactCommandReceipt>>();
  try {
    for (const row of committedFactCommands.rows) {
      receipts.set(row.id, decodeScopedFactCommandReceipt(source, row, (id) => receiptRows.get(id), contextCache));
    }
  } catch { throw restoreFailure("Runtime fact receipt lineage is invalid."); }
  const financeRows = new Map(financeCommandGroups.rows.map((row) => [row.id, row]));
  const financeContextCache = new Map<string, { row: ScopedFinanceReceiptRow; context: ReplayContextV1 }>();
  const financeReceipts = new Map<string, ReturnType<typeof decodeScopedFinanceCommandReceipt>>();
  try {
    for (const row of financeCommandGroups.rows) {
      financeReceipts.set(row.id, decodeScopedFinanceCommandReceipt(source, row, (id) => financeRows.get(id), financeContextCache));
    }
  } catch { throw restoreFailure("Runtime Finance receipt lineage is invalid."); }
  const domain = mapDomain(
    {
      worldId: source.worldId,
      worldlineId: source.worldlineId,
      storyId: source.storyId,
      recordId: source.recordId,
    },
    {
      stories: stories.rows,
      storyDefinitions,
      records,
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
    receipts,
    financeReceipts,
  );
  return {domain:carryDomainReplayContexts(source,primary,domain,receipts,financeReceipts,performanceEntries),memory};
}

function carryDomainReplayContexts(
  source: {workspaceId:string;worldId:string;worldlineId:string},
  primary: {record:RealmRuntimeSaveRecordV1;topology:RealmRuntimeSaveTopologyV1},
  domain: RealmRuntimeSaveDomainV1,
  receipts: ReadonlyMap<string,ReturnType<typeof decodeScopedFactCommandReceipt>>,
  financeReceipts: ReadonlyMap<string,ReturnType<typeof decodeScopedFinanceCommandReceipt>>,
  performanceEntries?: readonly PerformanceWitnessEnvelopeV1[],
): RealmRuntimeSaveDomainV1 {
  const actualScope = { workspaceId: source.workspaceId, worldId: source.worldId, worldlineId: source.worldlineId };
  const closure = runtimeFactReplayClosure(primary.record, domain, primary.topology);
  const contexts = new Map<string, ReplayContextV1>();
  let native: ReplayContextV1 | undefined;
  const facts = domain.committedFactCommands.map((command) => {
    if (command.provenance !== "legacy-result-v1") return command;
    const proof = receipts.get(command.id)!.replayProof;
    const key = proof?.context.id ?? "native";
    let context = contexts.get(key);
    if (!context) {
      try {
        context = proof ? projectReplayContext(proof.context, actualScope, closure) : (native ??= seedFactContext(actualScope, closure));
      } catch { throw restoreFailure("Runtime fact receipt projection is invalid."); }
      contexts.set(key, context);
    }
    return { ...command, replayLineage: { version: 1 as const, contextId: context.id,
      originalRequestFingerprint: command.requestFingerprint } };
  });
  const financeContexts = new Map<string, ReplayContextV1>();
  let financeClosure: ReplayClosure | undefined;
  let financeNative: ReplayContextV1 | undefined;
  const groups = domain.financeCommandGroups.map((group) => {
    if (group.provenance !== "legacy-result-v1" || group.state !== "committed" || group.policyVersion !== "project-finance-command.v1") return group;
    const proof = financeReceipts.get(group.id)!.replayProof;
    const key = proof?.context.id ?? "native";
    let context = financeContexts.get(key);
    if (!context) {
      try {
        financeClosure ??= runtimeFinanceReplayClosure(primary.record, domain, primary.topology);
        context = proof ? projectReplayContext(proof.context, actualScope, financeClosure)
          : (financeNative ??= seedFinanceContext(actualScope, financeClosure));
      } catch { throw restoreFailure("Runtime Finance receipt projection is invalid."); }
      financeContexts.set(key, context);
    }
    return { ...group, replayLineage: { version: 1 as const, contextId: context.id,
      originalRequestFingerprint: group.requestFingerprint } };
  });
  const allContexts = [...contexts.values(), ...financeContexts.values()];
  const carried = { ...domain, committedFactCommands: facts, financeCommandGroups: groups,
    ...(allContexts.length ? { commandReplayContexts: deduplicateReplayContexts(allContexts) } : {}) };
  validateDomainRecordClosure(primary.record, carried, primary.topology, source.workspaceId,
    performanceEntries?.length ? {format:"realm-runtime-performance-witnesses",schemaVersion:1,witnesses:performanceEntries} : undefined);
  return carried;
}

interface SingleRecordDomainRows {
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

function mapSingleRecordDomain(
  source: { worldId: string; worldlineId: string; storyId: string; recordId: string },
  rows: SingleRecordDomainRows,
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

async function loadSingleRecordDomainSnapshot(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  source: { workspaceId: string; worldId: string; worldlineId: string; storyId: string; recordId: string },
  primary: {record:RealmRuntimeSaveRecordV1;topology:RealmRuntimeSaveTopologyV1},
  performanceEntries?: PerformanceWitnessEnvelopeV1[],
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
    `SELECT workspace_id,world_id,worldline_id,false AS receipt_oversized,
            id, idempotency_key, request_fingerprint, state, result_manifest,
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
    `SELECT id, story_id, node_key, state, revision, record_id, definition_hash,
            unlock_evidence_event_ids, unlock_evidence
     FROM story_node_instances
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4
     ORDER BY node_key ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, source.storyId],
  );
  const storyUnlockLedger = await client.query<DomainUnlockRow>(
    `SELECT id, story_id, story_node_instance_id, node_key, transition, idempotency_key,
            record_id, evidence_event_ids, evidence_hash, evidence
     FROM story_unlock_ledger
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND story_id = $4
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId, source.storyId],
  );
  const committedFactCommands = await client.query<DomainFactCommandRow>(
    `SELECT workspace_id,world_id,worldline_id,false AS receipt_oversized,
            id, idempotency_key, request_fingerprint, kind, result_manifest
     FROM committed_fact_commands
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY created_at ASC, id ASC`,
    [source.workspaceId, source.worldId, source.worldlineId],
  );
  await assertFactReceiptTransportSupported(client, source, committedFactCommands.rows, performanceEntries);
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
            definition.asset_key, definition.rule_pack_key, asset.quantity, asset.revision, asset.metadata
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
  const rows: SingleRecordDomainRows = {
      projects: projects.rows, milestones: milestones.rows, projectStoryLinks: allProjectLinks.rows,
      budgetAllocations: budgetAllocations.rows, financeAccounts: financeAccounts.rows,
      ledgerEntries: ledgerEntries.rows, financeCommandGroups: financeCommandGroups.rows,
      obligations: obligations.rows, obligationSettlements: obligationSettlements.rows,
      storyNodes: storyNodes.rows, storyUnlockLedger: storyUnlockLedger.rows,
      committedFactCommands: committedFactCommands.rows, performanceAssessments: performanceAssessments.rows,
      memberRelationshipRevisions: memberRelationshipRevisions.rows, characterAssets: characterAssets.rows,
  };
  const bound = (await client.query<{bound:boolean}>(
    `SELECT EXISTS(SELECT 1 FROM story_definition_bindings WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND story_id=$4) AS bound`,
    [source.workspaceId,source.worldId,source.worldlineId,source.storyId])).rows[0]!.bound;
  const modernReceipt = [...rows.committedFactCommands,...rows.financeCommandGroups].some(row=>{
    const manifest=jsonObject(row.result_manifest);
    return ["result","request","provenance","replayLineage","replayContext","commandId","commandGroupId"].some(key=>Object.hasOwn(manifest,key));
  });
  // Keep the shipped historical representation byte-for-byte when it can
  // express the source. Current receipts/bindings use the typed closure wire
  // with no sibling Record bundles and only the selected Story.
  const wireSource={worldId:source.worldId,worldlineId:source.worldlineId,storyId:source.storyId,recordId:source.recordId};
  if (!bound && !modernReceipt) return mapSingleRecordDomain(wireSource,rows);
  const receipts = new Map<string,ReturnType<typeof decodeScopedFactCommandReceipt>>();
  const facts = new Map(rows.committedFactCommands.map(row=>[row.id,row]));
  const contexts = new Map<string,{row:ScopedFactReceiptRow;context:ReplayContextV1}>();
  const financeReceipts = new Map<string,ReturnType<typeof decodeScopedFinanceCommandReceipt>>();
  const groups = new Map(rows.financeCommandGroups.map(row=>[row.id,row]));
  const financeContexts = new Map<string,{row:ScopedFinanceReceiptRow;context:ReplayContextV1}>();
  try {
    for(const row of facts.values())receipts.set(row.id,decodeScopedFactCommandReceipt(source,row,id=>facts.get(id),contexts));
    for(const row of groups.values())financeReceipts.set(row.id,decodeScopedFinanceCommandReceipt(source,row,id=>groups.get(id),financeContexts));
  } catch {throw restoreFailure("Runtime single-Record receipt lineage is invalid.");}
  const stories = await client.query<DomainStoryRow>(
    `SELECT id,title,status,premise FROM stories WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id=$4`,
    [source.workspaceId,source.worldId,source.worldlineId,source.storyId]);
  const storyDefinitions = await loadStoryBindings(client,source,rows.storyNodes);
  // Immutable definitions include locked nodes, whose explicit runtime Record
  // dependencies must be transportable even before those nodes materialize.
  // Reuse the restore rule traversal with an identity map for this exact
  // closure; ordinary export must never acquire a private sibling implicitly.
  const ruleMaps = {
    recordIds: new Map([[source.recordId, source.recordId]]),
    milestoneIds: new Map(rows.milestones.map(row => [row.id, row.id])),
    obligationIds: new Map(rows.obligations.map(row => [row.id, row.id])),
  };
  for (const binding of storyDefinitions) {
    const definition = normalizeStoryDefinition(binding.definition as unknown as Parameters<typeof normalizeStoryDefinition>[0]);
    for (const node of definition.nodes) {
      remapStoryUnlockRule(node.unlock, ruleMaps, `storyDefinitions.${binding.storyId}.${node.nodeKey}.unlock`);
    }
  }
  const domain=mapDomain(wireSource,{...rows,stories:stories.rows,storyDefinitions,records:[]},receipts,financeReceipts);
  return carryDomainReplayContexts(source,primary,domain,receipts,financeReceipts,performanceEntries);
}

/** A pg client has one active query; stop issuing SQL immediately on failure. */
async function readInOrder<const T extends readonly unknown[]>(tasks:{readonly [K in keyof T]:()=>Promise<T[K]>}):Promise<T> {
  const results:unknown[]=[];
  for(const task of tasks)results.push(await task());
  return results as unknown as T;
}

/** V1 cannot carry original Story/worldline Goal instances. Read only a
 * constant witness inside the authorized snapshot; never load private bodies. */
async function refuseUnsupportedScopedGoals(
  client: Parameters<Parameters<typeof withWorkspaceTransaction>[2]>[0],
  scope: { workspaceId: string; worldId: string; worldlineId: string; storyId: string | null },
): Promise<void> {
  const unsupported = await client.query<{ unsupported_scoped_goal: number }>(
    `SELECT 1 AS unsupported_scoped_goal
     FROM goal_instances AS goal
     WHERE goal.workspace_id = $1 AND goal.world_id = $2 AND goal.worldline_id = $3
       AND goal.record_id IS NULL
       AND ((goal.scope_kind = 'worldline' AND goal.story_id IS NULL)
         OR (goal.scope_kind = 'story' AND ($4::text IS NULL OR goal.story_id = $4)
           AND EXISTS (SELECT 1 FROM stories AS owner_story
             WHERE owner_story.workspace_id = goal.workspace_id AND owner_story.world_id = goal.world_id
               AND owner_story.worldline_id = goal.worldline_id AND owner_story.id = goal.story_id)))
     LIMIT 1`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, scope.storyId],
  );
  if (unsupported.rows.length) {
    throw restoreFailure("Story/worldline Goal export is unsupported by runtime save V1.");
  }
}

function createSingleRecordSaveReader(
  database: WorkspaceDatabase,
  resolveGoalSource: GoalContentSourceResolver,
  performanceWitnessesSchemaVersion?: 1,
): RealmRuntimeSaveReader<RealmRuntimeSaveGoals> {
  return {
    async load({ workspaceId, recordId, principalId, purpose, sessionProof }) {
      if (!principalId?.trim() || principalId !== principalId.trim()
        || (purpose !== "record-export" && purpose !== "native-record-branch")
        || (purpose === "native-record-branch" && !sessionProof?.trim())) {
        throw new RealmRuntimeSaveRepositoryError("WORLD_READ_ONLY", "An explicit server-side export authority is required.");
      }
      return withWorkspaceTransaction(database, workspaceId, async (client) => {
        const performanceEntries = performanceWitnessesSchemaVersion === 1 ? [] as PerformanceWitnessEnvelopeV1[] : undefined;
        // The library holds the source/head locks. Its restore capability
        // verifies the actual proof before the first target write; runtime
        // deliberately cannot call the private session-actor primitive.
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
        const goalSchemaAvailable = await hasGoalTransportSchema(client);
        if (!goalSchemaAvailable) await refuseUnsupportedScopedGoals(client, { workspaceId, worldId: recordRow.world_id,
          worldlineId: recordRow.worldline_id, storyId: recordRow.story_id });
        const eventResult = await loadRuntimeEventRows(client,
          { workspaceId, worldId: recordRow.world_id, worldlineId: recordRow.worldline_id, recordId },
          { recordVersion: Number(recordRow.record_version), nextRecordOrdinal: Number(recordRow.next_record_ordinal) });
        const topologyLedger = new RuntimeSectionWireLedger("runtime/topology.json", "canonical-runtime");
        topologyLedger.reserve({format:"realm-runtime-topology",schemaVersion:1,participants:[],scenes:[],visibilityPolicies:[]});
        const receiptLedger = new RuntimeSectionWireLedger("runtime/action-receipts.json", "canonical-runtime");
        const effectLedger = new RuntimeSectionWireLedger("runtime/character-effects.json", "canonical-runtime");
        const observationLedger = new RuntimeSectionWireLedger("runtime/observations.json", "canonical-runtime");
        receiptLedger.reserve(mapActionReceipts([])); effectLedger.reserve(mapCharacterEffects([])); observationLedger.reserve(mapObservations([]));
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
          ()=>readTopologyRows<ParticipantTopologyRow>(client, "participants", [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId], topologyLedger, row => mapTopology([row], [], []).participants[0]),
          ()=>readTopologyRows<SceneTopologyRow>(client, "scenes", [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId], topologyLedger, row => mapTopology([], [row], []).scenes[0]),
          ()=>readTopologyRows<VisibilityPolicyTopologyRow>(client, "visibility", [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId], topologyLedger, row => mapTopology([], [], [row]).visibilityPolicies[0]),
          ()=>readEvidenceRows<ActionReceiptRow>(client, "action_receipts", [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId], receiptLedger, row => mapActionReceipts([row]).receipts[0]),
          ()=>readEvidenceRows<CharacterEffectRow>(client, "character_effects", [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId], effectLedger, row => mapCharacterEffects([row]).effects[0]),
          ()=>readEvidenceRows<ObservationRow>(client, "observations", [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId], observationLedger, row => mapObservations([row]).observations[0]),
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
          ()=>loadRuntimeOutboxRows(client, { workspaceId, worldId: recordRow.world_id,
            worldlineId: recordRow.worldline_id, recordId }),
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
        const legacyGoals = mapGoals(instanceResult.rows, assessmentResult.rows,definitions.rows);
        const topology = mapTopology(
          topologyResult.rows,
          sceneResult.rows,
          visibilityPolicyResult.rows,
        );
        topologyLedger.verify(countRuntimeSectionWireBytes(topology,"canonical-runtime"));
        // Both purposes return a single Record representation. Native proof
        // is not an authority to carry private ancestor Record bundles.
        validateExportCharacterClosure([{ recordId, topology }]);
        const actionReceipts = mapActionReceipts(actionReceiptResult.rows);
        const characterEffects = mapCharacterEffects(characterEffectResult.rows);
        const observations = mapObservations(observationResult.rows);
        const mixedWorldline = (await client.query<{ mixed: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM records WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id<>$4) AS mixed`,
          [workspaceId, recordRow.world_id, recordRow.worldline_id, recordId],
        )).rows[0]!.mixed;
        const requiresMemoryV2 = relationshipStateResult.rows.some(row => row.source_record_id !== null && row.source_observation_id === null);
        const emptySnapshotIds = new Set(memorySnapshotResult.rows.filter(row => row.item_ids.length === 0 && row.content.length === 0).map(row => row.id));
        let snapshots = memorySnapshotResult.rows;
        if (mixedWorldline) {
          const observers = new Set(topologyResult.rows.flatMap(row => row.instance_continuity_id ? [row.instance_continuity_id] : []));
          const observationIds = new Set(observationResult.rows.map(row => row.id));
          const conclusions = new Map(memoryConclusionResult.rows.map(row => [row.id, row]));
          // Source-less formal state cannot be attributed safely in a mixed
          // Worldline. Reject it rather than leaking or deleting a fact.
          for (const row of [...memoryConclusionResult.rows, ...relationshipStateResult.rows]) {
            if (!observers.has(row.observer_continuity_id)
              || (row.source_record_id === null && row.source_observation_id === null)
              || (row.source_observation_id !== null && !observationIds.has(row.source_observation_id))) {
              throw new RealmRuntimeSaveRepositoryError("RUNTIME_SAVE_INVALID",
                "Record-only memory projection is unsupported for unattributed formal state; use an authorized whole-closure backup.");
            }
          }
          for (const row of memoryConclusionResult.rows) {
            if (row.supersedes_memory_id !== null && !conclusions.has(row.supersedes_memory_id)) {
              throw new RealmRuntimeSaveRepositoryError("RUNTIME_SAVE_INVALID",
                "Record-only memory projection is unsupported for a cross-Record formal predecessor; use an authorized whole-closure backup.");
            }
          }
          // Snapshots are derived Worldline caches. Rebuild their contents
          // solely from this Record's typed items, including empty caches.
          snapshots = snapshots.filter(row => observers.has(row.observer_continuity_id)).map(row => {
            const item_ids = row.item_ids.filter(id => conclusions.get(id)?.observer_continuity_id === row.observer_continuity_id);
            const lines = item_ids.map(id => conclusions.get(id)!.content);
            const content = row.snapshot_kind === "representation" ? fitMemoryLinesWithinBudget(lines) : lines.join("\n");
            return { ...row, item_ids, content, token_count: estimateMemoryTokens(content) };
          // Preserve genuinely empty V2 caches, while retaining the existing
          // exclusion of sibling-only or unattributed nonempty cache bodies.
          }).filter(row => row.content.length > 0 || (requiresMemoryV2 && emptySnapshotIds.has(row.id)));
        }
        let memory: RealmRuntimeSaveMemoryV1 | RealmRuntimeSaveMemoryV2 = mapSingleRecordMemory(
          memoryConclusionResult.rows, snapshots, relationshipStateResult.rows,
        );
        if (requiresMemoryV2) {
          const observers=[...new Set(topology.participants.flatMap(row=>row.character?[row.character.sourceContinuityId]:[]))];
          const epochs=await client.query<{observer_continuity_id:string;epoch:number}>(
            `SELECT c.id AS observer_continuity_id,COALESCE(e.epoch,0) AS epoch FROM character_continuities c
             LEFT JOIN memory_cache_epochs e ON e.workspace_id=c.workspace_id AND e.observer_continuity_id=c.id
             WHERE c.workspace_id=$1 AND c.world_id=$2 AND c.worldline_id=$3 AND c.id=ANY($4::text[]) ORDER BY c.id`,
            [workspaceId,recordRow.world_id,recordRow.worldline_id,observers]);
          // Only causal committed evidence establishes this Record's progress.
          // Availability is a visibility schedule and snapshots are shared
          // caches; neither can advance the transported Worldline head.
          const cursor=maxWorldCursor([
            ...eventResult.rows.map(row=>({worldTick:Number(row.world_tick),worldOrdinal:Number(row.world_ordinal)})),
            ...[...observationResult.rows,...memoryConclusionResult.rows,...relationshipStateResult.rows].map(row=>
              ({worldTick:Number(row.occurred_tick),worldOrdinal:Number(row.occurred_ordinal)})),
          ]) ?? {tick:0,ordinal:0};
          // A cache summarizing future-visible items must not become reusable
          // merely because its consumption cursor is rebased. Invalidate only
          // affected observers with a currently eligible cache. Advancing the
          // transported counter above ALL retained snapshots preserves stale
          // caches and cannot collide with a later real revision increment.
          // Resave is stable: an already stale future cache needs no new epoch.
          const conclusionsById = new Map(memoryConclusionResult.rows.map(row => [row.id, row]));
          const knownEpochs = new Map(epochs.rows.map(row => [row.observer_continuity_id, Number(row.epoch)]));
          const invalidate = new Set<string>();
          for (const snapshot of snapshots) {
            const epoch = knownEpochs.get(snapshot.observer_continuity_id);
            if (epoch === undefined || !Number.isInteger(epoch) || epoch < 0 || epoch > 2147483647
              || Number(snapshot.cache_epoch) > epoch) {
              throw new RealmRuntimeSaveRepositoryError("RUNTIME_SAVE_INVALID", "Runtime memory cache epoch precedes a retained snapshot or is invalid.");
            }
            if (Number(snapshot.cache_epoch) === epoch && snapshot.item_ids.some(id => {
              const item = conclusionsById.get(id);
              return item !== undefined && (Number(item.available_from_tick) > cursor.tick
                || (Number(item.available_from_tick) === cursor.tick && Number(item.available_from_ordinal) > cursor.ordinal));
            })) invalidate.add(snapshot.observer_continuity_id);
          }
          const cacheEpochs = epochs.rows.map(row => {
            const epoch = Number(row.epoch);
            if (!invalidate.has(row.observer_continuity_id)) return { sourceObserverContinuityId: row.observer_continuity_id, epoch };
            if (epoch === 2147483647) {
              throw new RealmRuntimeSaveRepositoryError("RUNTIME_SAVE_INVALID", "Projected memory cache epoch is exhausted.");
            }
            return { sourceObserverContinuityId: row.observer_continuity_id, epoch: epoch + 1 };
          });
          // Retain typed items/content/epochs/budgets; sibling consumption
          // positions cannot become committed progress in a narrow restore.
          snapshots=snapshots.map(row=>Number(row.cursor_tick)>cursor.tick
            || (Number(row.cursor_tick)===cursor.tick && Number(row.cursor_ordinal)>cursor.ordinal)
            ? {...row,cursor_tick:cursor.tick,cursor_ordinal:cursor.ordinal} : row);
          memory=mapMemory(memoryConclusionResult.rows,snapshots,relationshipStateResult.rows,
            cursor,
            cacheEpochs,
            {workspaceId,worldId:recordRow.world_id,worldlineId:recordRow.worldline_id});
        }
        const outbox = mapOutbox(outboxResult.rows);
        const firstNight = mapFirstNight(firstNightResult.rows);
        const selfPlay = mapSelfPlay(selfPlayResult.rows);
        const domain = await loadSingleRecordDomainSnapshot(client, {
          workspaceId,
          worldId: recordRow.world_id,
          worldlineId: recordRow.worldline_id,
          storyId: recordRow.story_id,
          recordId: recordRow.record_id,
        }, {record,topology}, performanceEntries);
        if (recordRow.world_version !== LOCAL_WORLD_VERSION) {
          const map = await readCommandMaterializations(client, { workspaceId, worldId: recordRow.world_id, worldlineId: recordRow.worldline_id });
          if (map) {
            if (map.worldVersion !== recordRow.world_version) throw restoreFailure("Command policy Record version is incompatible.");
            Object.assign(domain, normalizeRealmRuntimeSaveDomainV1({ ...domain, commandMaterializations: map }));
          }
        }
        const goals = await loadArchiveGoalBindings(client, { workspaceId, worldId: recordRow.world_id,
          worldlineId: recordRow.worldline_id, storyIds: [recordRow.story_id], schemaAvailable: goalSchemaAvailable,
          records: [{ record, goals: legacyGoals }], resolveSource: resolveGoalSource });
        // Phase 4D：存档记录 Record 的实际 binding（records.world_version），
        // 不取 worlds 创建身份——切换过的 Record 存档必须保真。
        const worldRef = worldRefFromVersion(recordRow.world_id, recordRow.world_version);
        const performanceWitnesses: RuntimePerformanceWitnessesV1 | undefined = performanceEntries?.length
          ? { format: "realm-runtime-performance-witnesses", schemaVersion: 1, witnesses: performanceEntries } : undefined;
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
          ...(performanceWitnesses ? {performanceWitnesses} : {}),
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
          ...(performanceWitnesses ? {performanceWitnesses} : {}),
        };
      }, { readOnly: purpose !== "native-record-branch", isolationLevel: "repeatable read" }).catch(error=>{
        if(error instanceof RealmRuntimeSaveError || error instanceof RealmRuntimeSaveDomainError) throw restoreFailure(error.message);
        throw error;
      });
    },
  };
}


/** Only declared speech anchors; nested metadata and presentation stay literal. */
function rewriteParticipantReferences(value:JsonValue, localParticipantIds:ReadonlyMap<string,string>):JsonValue {
  if(!value || typeof value!=='object' || Array.isArray(value)) return value;
  const object=value as Readonly<Record<string,JsonValue>>;
  const wrapped=Object.hasOwn(object,'__realmRuntimePayload');
  const body=wrapped?object.__realmRuntimePayload:value;
  if(!body || typeof body!=='object' || Array.isArray(body)) {
    throw restoreFailure('Runtime save event.__realmRuntimePayload is invalid.');
  }
  const rewrite=(source:Readonly<Record<string,JsonValue>>, keys:readonly string[])=>{
    const result={...source};
    for(const key of keys) {
      if(!Object.hasOwn(source,key) || source[key]===null) continue;
      if(typeof source[key]!=='string') throw restoreFailure(`Runtime save event.${key} is invalid.`);
      result[key]=remapRequired(localParticipantIds,source[key],`event.${key}`);
    }
    return result;
  };
  const rewritten=rewrite(body as Readonly<Record<string,JsonValue>>,['participantId','recipientId']);
  return wrapped?{...rewrite(object,['recipientId']),__realmRuntimePayload:rewritten}:rewritten;
}

interface GoalReferenceMaps {
  instances: ReadonlyMap<string,string>;
  definitions: ReadonlyMap<string,string>;
  policies: ReadonlyMap<string,string>;
}

function rewriteGoalReferences(value:JsonValue, identities:GoalReferenceMaps, localEventIds:ReadonlyMap<string,string>):JsonValue {
  if(!value || typeof value!=='object' || Array.isArray(value)) return value;
  const object=value as Readonly<Record<string,JsonValue>>;
  if(object.__realmRuntimePayload !== undefined) return {...object,__realmRuntimePayload:rewriteGoalReferences(object.__realmRuntimePayload,identities,localEventIds)};
  const result={...object};
  // 0070/0072 emit these as non-null text identities, not optional literals.
  // Keep the older alias contracts below unchanged.
  for(const key of ['successorGoalInstanceId','predecessorGoalInstanceId']) {
    if(!Object.hasOwn(object,key)) continue;
    const source=object[key];
    if(typeof source!=='string') throw restoreFailure(`Runtime save event.${key} is invalid.`);
    result[key]=remapRequired(identities.instances,source,`event.${key}`);
  }
  if(Object.hasOwn(object,'basisEventIds')) {
    const basis=restoreStringArray(object,'basisEventIds');
    if(basis.length<1 || basis.length>16 || new Set(basis).size!==basis.length) {
      throw restoreFailure('Runtime save event.basisEventIds is invalid.');
    }
    // Evolution evidence belongs to this Record; a shared Event map would
    // incorrectly admit a private carried sibling's evidence. Preserve order.
    result.basisEventIds=basis.map(id=>remapRequired(localEventIds,id,'event.basisEventIds'));
  }
  for(const [key, map] of Object.entries({goalInstanceId:identities.instances,supersedesInstanceId:identities.instances,
    successorInstanceId:identities.instances,definitionId:identities.definitions,supersedesDefinitionId:identities.definitions,
    successorDefinitionId:identities.definitions,policyVersion:identities.policies})) {
    const source=object[key];
    if(typeof source==='string') {
      if(key==='policyVersion' && !map.has(source)) continue; // content policies are not authored definitions
      result[key]=remapRequired(map,source,`event.${key}`);
    }
  }
  return result;
}

/** Stable Kahn ordering: input order breaks ties, IDs do not define chronology. */
function restoreParentOrder<T>(rows:readonly T[], id:(row:T)=>string, parent:(row:T)=>string|null, label:string):T[] {
  const byId=new Map(rows.map(row=>[id(row),row]));
  if(byId.size!==rows.length) throw restoreFailure(`${label} identities conflict.`);
  const children=new Map<string,T[]>();const pending:T[]=[];
  for(const row of rows) {
    const predecessor=parent(row);
    if(predecessor===null) pending.push(row);
    else {
      if(!byId.has(predecessor)) throw restoreFailure(`${label} predecessor is outside the saved closure.`);
      const list=children.get(predecessor)??[];list.push(row);children.set(predecessor,list);
    }
  }
  const ordered:T[]=[];
  for(let i=0;i<pending.length;i++) {const row=pending[i]!;ordered.push(row);pending.push(...children.get(id(row))??[]);}
  if(ordered.length!==rows.length) throw restoreFailure(`${label} predecessor chain is cyclic.`);
  return ordered;
}

export function createPostgresRealmRuntimeSaveReader(database: WorkspaceDatabase,
  options: { goalsSchemaVersion: 2; performanceWitnessesSchemaVersion?: 1; resolveGoalSource?: GoalContentSourceResolver }): RealmRuntimeSaveReader<RealmRuntimeSaveGoals>;
export function createPostgresRealmRuntimeSaveReader(database: WorkspaceDatabase,
  options?: { performanceWitnessesSchemaVersion?: 1; resolveGoalSource?: GoalContentSourceResolver }): RealmRuntimeSaveReader;
export function createPostgresRealmRuntimeSaveReader(database: WorkspaceDatabase,
  options: { goalsSchemaVersion?: 2; performanceWitnessesSchemaVersion?: 1; resolveGoalSource?: GoalContentSourceResolver } = {}): RealmRuntimeSaveReader<RealmRuntimeSaveGoals> {
  options = { ...performanceTransportConsumerOptions(), ...options };
  const resolveGoalSource = options.resolveGoalSource ?? createDefaultGoalContentBindingSource();
  return { async load(input) {
    const deny = () => new RealmRuntimeSaveRepositoryError("BACKUP_FORBIDDEN", "An explicit server-side export authority is required.");
    if (input===null || typeof input!=="object" || Array.isArray(input)
      || ![Object.prototype,null].includes(Object.getPrototypeOf(input))) throw deny();
    const descriptors=Object.getOwnPropertyDescriptors(input);
    const allowed=["workspaceId","recordId","principalId","purpose","sessionProof","storyDefinitions"];
    if(Reflect.ownKeys(input).some(key=>typeof key!=="string" || !allowed.includes(key)
      || !descriptors[key]?.enumerable || !("value" in descriptors[key]!))) throw deny();
    const data=Object.fromEntries(Object.entries(descriptors).map(([key,descriptor])=>[key,descriptor.value]));
    if (["workspaceId","recordId","principalId"].some(key=>typeof data[key]!=="string"
      || !data[key].trim() || data[key]!==data[key].trim() || data[key].length>256)
      || !["record-export", "whole-closure-backup", "native-record-branch"].includes(data.purpose)
      || (data.purpose==="native-record-branch" && (typeof data.sessionProof!=="string" || !data.sessionProof.trim()))) {
      throw new RealmRuntimeSaveRepositoryError("BACKUP_FORBIDDEN", "An explicit server-side export authority is required.");
    }
    input=data as Parameters<RealmRuntimeSaveReader["load"]>[0];
    const archive = await (input.purpose === "whole-closure-backup"
      ? createWholeClosureReader(database, resolveGoalSource, options.performanceWitnessesSchemaVersion).load(input)
      : createSingleRecordSaveReader(database, resolveGoalSource, options.performanceWitnessesSchemaVersion).load(input));
    if (archive?.goals.schemaVersion === 2 && options.goalsSchemaVersion !== 2) {
      throw new RealmRuntimeSaveRepositoryError("GOAL_TRANSPORT_VERSION_UNSUPPORTED", "This reader consumer must explicitly support Goal section V2.");
    }
    return archive;
  } };
}

function createWholeClosureReader(
  database: WorkspaceDatabase,
  resolveGoalSource: GoalContentSourceResolver,
  performanceWitnessesSchemaVersion?: 1,
): RealmRuntimeSaveReader<RealmRuntimeSaveGoals> {
  return {
    async load(input) {
      const { workspaceId, recordId, storyDefinitions } = input;
      const principalAware = true;
      const backupPrincipalId = input.principalId;
      const denyBackup = () => new RealmRuntimeSaveRepositoryError("BACKUP_FORBIDDEN", "Whole-closure backup is not permitted.");
      if (input.purpose !== "whole-closure-backup" || !isOperatorPrincipal(backupPrincipalId)) throw denyBackup();
      return withWorkspaceTransaction(database, workspaceId, async (client) => {
        const performanceEntries = performanceWitnessesSchemaVersion === 1 ? [] as PerformanceWitnessEnvelopeV1[] : undefined;
        // Recheck server policy here; membership is read from the actual Record
        // below in this same strong read-only snapshot, before private sections.
        if (principalAware && !isOperatorPrincipal(backupPrincipalId)) throw denyBackup();
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
             AND record.id = $2
             ${principalAware ? `AND EXISTS (
               SELECT 1 FROM player_world_memberships AS backup_membership
               WHERE backup_membership.workspace_id = record.workspace_id
                 AND backup_membership.world_id = record.world_id
                 AND backup_membership.principal_id = $3
                 AND backup_membership.role = 'owner'
             )` : ""}`,
          principalAware ? [workspaceId, recordId, backupPrincipalId] : [workspaceId, recordId],
        );
        const recordRow = recordResult.rows[0];
        if (!recordRow) return null;
        if (await isArchivedRecord(client, workspaceId, recordId)) {
          throw new RealmRuntimeSaveRepositoryError(
            "RECORD_ARCHIVED",
            "The requested Record is archived.",
          );
        }

        const goalSchemaAvailable = await hasGoalTransportSchema(client);
        if (!goalSchemaAvailable) await refuseUnsupportedScopedGoals(client, { workspaceId, worldId: recordRow.world_id,
          worldlineId: recordRow.worldline_id, storyId: null });
        const sections = await loadRecordSections(
          client,
          {
            workspaceId,
            worldId: recordRow.world_id,
            worldlineId: recordRow.worldline_id,
            recordId: recordRow.record_id,
          },
          {
            recordVersion: Number(recordRow.record_version),
            nextRecordOrdinal: Number(recordRow.next_record_ordinal),
          },
        );
        const {
          record,
          goals: legacyGoals,
          topology,
          actionReceipts,
          characterEffects,
          observations,
          outbox,
          firstNight,
          selfPlay,
        } = sections;
        const { domain, memory: archiveMemory } = await loadDomainSnapshot(
          client,
          {
            workspaceId,
            worldId: recordRow.world_id,
            worldlineId: recordRow.worldline_id,
            storyId: recordRow.story_id,
            recordId: recordRow.record_id,
          },
          new Set(sections.eventIds),
          storyDefinitions,
          { record, topology, observations },
          performanceEntries,
        );
        const goals = await loadArchiveGoalBindings(client, { workspaceId, worldId: recordRow.world_id,
          worldlineId: recordRow.worldline_id, storyIds: [recordRow.story_id, ...(domain.stories ?? []).map(s => s.id)],
          schemaAvailable: goalSchemaAvailable, resolveSource: resolveGoalSource,
          records: [{ record, goals: legacyGoals }, ...(domain.records ?? []).map(r => r.bundle)] });
        if (goals.schemaVersion === 2) {
          for (const sibling of domain.records ?? []) sibling.bundle.goals = emptyRuntimeGoals();
        }
        if (recordRow.world_version !== LOCAL_WORLD_VERSION) {
          const map = await readCommandMaterializations(client, { workspaceId, worldId: recordRow.world_id, worldlineId: recordRow.worldline_id });
          if (map) {
            if (map.worldVersion !== recordRow.world_version) throw restoreFailure("Command policy Record version is incompatible.");
            Object.assign(domain, normalizeRealmRuntimeSaveDomainV1({ ...domain, commandMaterializations: map }));
          }
        }
        // An authorized backup intentionally retains the complete closure,
        // including private and archived siblings. Ordinary Record read access
        // is not this capability. Revocation is evaluated at snapshot time.
        // Phase 4D：存档记录 Record 的实际 binding（records.world_version），
        // 不取 worlds 创建身份——切换过的 Record 存档必须保真。
        const worldRef = worldRefFromVersion(recordRow.world_id, recordRow.world_version);
        const performanceWitnesses: RuntimePerformanceWitnessesV1 | undefined = performanceEntries?.length
          ? { format: "realm-runtime-performance-witnesses", schemaVersion: 1, witnesses: performanceEntries } : undefined;
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
          memory: archiveMemory,
          outbox,
          firstNight,
          selfPlay,
          domain,
          ...(performanceWitnesses ? {performanceWitnesses} : {}),
        });
        return {
          manifest,
          record,
          goals,
          topology,
          actionReceipts,
          characterEffects,
          observations,
          memory: archiveMemory,
          outbox,
          firstNight,
          selfPlay,
          domain,
          ...(performanceWitnesses ? {performanceWitnesses} : {}),
        };
      }, { readOnly: true, isolationLevel: "repeatable read" }).catch((error: unknown) => {
        if (error instanceof RealmRuntimeSaveError || error instanceof RealmRuntimeSaveDomainError) {
          throw restoreFailure(error.message);
        }
        throw error;
      });
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
  reader: RealmRuntimeSaveReader<RealmRuntimeSaveGoals>,
  input: Parameters<RealmRuntimeSaveReader["load"]>[0],
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

/** Canonical object keys for detached JSON; array order remains semantic. */
function canonicalRestoreJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRestoreJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalRestoreJson(Reflect.get(value, key))}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw restoreFailure("Runtime restore commitment data is invalid.");
  return encoded;
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
  record: RealmRuntimeSaveRecordV1,
): RealmRuntimeSaveRestorableEvent[] {
  const events = record.events.map((event, index) => {
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
    if (record.head.recordVersion !== 0 || record.head.nextRecordOrdinal !== 0) {
      throw restoreFailure("An empty Record save must have a zero head.");
    }
    return events;
  }
  const sorted = events.sort((left, right) => left.ordinal - right.ordinal || left.eventId.localeCompare(right.eventId));
  if (
    sorted[0]!.ordinal !== 1
    || sorted[0]!.recordVersion !== 1
    || sorted.at(-1)!.ordinal + 1 !== record.head.nextRecordOrdinal
    || sorted.at(-1)!.recordVersion !== record.head.recordVersion
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

/**
 * Cross-Record restore identity state. Every source identity maps to exactly
 * one target identity across the whole archive (the saved Record plus all
 * carried sibling Record snapshots): events/scenes/instances are
 * workspace-unique in the source, character continuities/definitions are
 * shared between Records and inserted once, and worldline-shared memory rows
 * (null-source conclusions, snapshots, relationship states) are deduplicated
 * by source identity so multi-Record bundles never double-insert them.
 */
interface RestoreSharedState {
  recordIds: Map<string, string>;
  eventIds: Map<string, string>;
  sceneIds: Map<string, string>;
  financeFallbackSceneTargets: Map<string, Set<string>>;
  visibilityPolicyIds: Map<string, string>;
  participantIds: Map<string, string>;
  characterInstanceIds: Map<string, string>;
  continuityIds: Map<string, string>;
  definitionIds: Map<string, string>;
  definitionRepresentations: Map<string, string>;
  charactersByContinuity: Map<string, RestoredCharacterTopology>;
  instanceContinuityIds: Map<string, string>;
  memoryConclusionIds: Map<string, string>;
  plannedMemoryConclusionIds: Set<string>;
  memorySnapshotIds: Map<string, string>;
  plannedMemorySnapshotIds: Set<string>;
  relationshipStateKeys: Set<string>;
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
  topologyDocument: RealmRuntimeSaveTopologyV1 | undefined,
  token: string,
  events: readonly RealmRuntimeSaveRestorableEvent[],
  shared: RestoreSharedState,
): NormalizedRestoreTopology {
  const participantIds = shared.participantIds;
  const characterIds = shared.characterInstanceIds;
  const continuityIds = shared.continuityIds;
  const localCharacters = new Map<string,RestoredCharacterTopology>();
  const localRepresentations = new Map<string,string>();
  const participants = (topologyDocument?.participants ?? []).map((participant, index) => {
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
    const local=localCharacters.get(character.sourceCharacterInstanceId);
    if(local) {
      if(localRepresentations.get(character.sourceCharacterInstanceId)!==canonicalRestoreJson(character)) throw restoreFailure("Runtime character representations conflict.");
      return {sourceParticipantId:participant.sourceParticipantId,targetParticipantId,participantKind:participant.participantKind,
        sourcePrincipalId:participant.sourcePrincipalId,controllerMode:participant.controllerMode,isActive:participant.isActive,
        speakingOrder:participant.speakingOrder,sharedControlEnabled:participant.sharedControlEnabled,character:local};
    }
    if (characterIds.has(character.sourceCharacterInstanceId)) {
      throw restoreFailure("Runtime character topology identities are duplicated.");
    }
    // Definitions and continuities have independent source namespaces: several
    // distinct continuities may legitimately reference one definition. Reuse by
    // source ID only; identical values under distinct IDs stay distinct.
    const sharedCharacter = shared.charactersByContinuity.get(character.sourceContinuityId);
    if (sharedCharacter) {
      if (
        sharedCharacter.continuity.continuityKey !== character.continuity.continuityKey
        || sharedCharacter.sourceDefinitionId !== character.sourceDefinitionId
        || sharedCharacter.definition.displayName !== character.definition.displayName
      ) {
        throw restoreFailure("Runtime character continuity is inconsistent across Records.");
      }
    }
    const definitionRepresentation = canonicalRestoreJson(character.definition);
    const previousDefinition = shared.definitionRepresentations.get(character.sourceDefinitionId);
    if (previousDefinition !== undefined && previousDefinition !== definitionRepresentation) {
      throw restoreFailure("Runtime character definition is inconsistent across Records.");
    }
    const targetDefinitionId = shared.definitionIds.get(character.sourceDefinitionId)
      ?? `character_definition_restore_${token}_${index}`;
    shared.definitionIds.set(character.sourceDefinitionId, targetDefinitionId);
    shared.definitionRepresentations.set(character.sourceDefinitionId, definitionRepresentation);
    const targetInstanceId = `character_instance_restore_${token}_${index}`;
    const targetContinuityId = sharedCharacter?.targetContinuityId
      ?? `character_continuity_restore_${token}_${index}`;
    characterIds.set(character.sourceCharacterInstanceId, targetInstanceId);
    continuityIds.set(character.sourceContinuityId, targetContinuityId);
    shared.instanceContinuityIds.set(character.sourceCharacterInstanceId, targetContinuityId);
    const restoredCharacter: RestoredCharacterTopology = {
      sourceCharacterInstanceId: character.sourceCharacterInstanceId,
      sourceContinuityId: character.sourceContinuityId,
      sourcePredecessorInstanceId: character.sourcePredecessorInstanceId,
      sourceDefinitionId: character.sourceDefinitionId,
      targetDefinitionId,
      targetContinuityId,
      targetInstanceId,
      definition: character.definition,
      continuity: character.continuity,
      instance: character.instance,
    };
    localCharacters.set(character.sourceCharacterInstanceId,restoredCharacter);
    localRepresentations.set(character.sourceCharacterInstanceId,canonicalRestoreJson(character));
    if (!sharedCharacter) {
      shared.charactersByContinuity.set(character.sourceContinuityId, restoredCharacter);
    }
    return {
      sourceParticipantId: participant.sourceParticipantId,
      targetParticipantId,
      participantKind: participant.participantKind,
      sourcePrincipalId: participant.sourcePrincipalId,
      controllerMode: participant.controllerMode,
      isActive: participant.isActive,
      speakingOrder: participant.speakingOrder,
      sharedControlEnabled: participant.sharedControlEnabled,
      character: restoredCharacter,
    };
  });

  const archiveScenes = topologyDocument?.scenes ?? [];
  const sceneInputs = archiveScenes.length > 0 ? archiveScenes
    : (events.length ? runtimeReplaySourceSceneIds(archiveScenes, events.map((event) => event.sourceSceneId)) : [`legacy-scene:${token}`]).map((sourceSceneId) => ({
      sourceSceneId, title: "Restored scene", status: "active" as const, location: "", objective: "", tension: "", weather: "",
      displayTime: "", startTick: 0, startOrdinal: 0, endTick: null, endOrdinal: null,
    }));
  const sceneIds = shared.sceneIds;
  const scenes = sceneInputs.map((scene, index) => {
    if (sceneIds.has(scene.sourceSceneId)) throw restoreFailure("Runtime scene ids are duplicated.");
    const targetSceneId = `scene_restore_${token}_${index}`;
    sceneIds.set(scene.sourceSceneId, targetSceneId);
    if (archiveScenes.length === 0 && events.length === 0) {
      // Finance's existing closure names the empty-Record fallback separately
      // from the restore-local key above. Register its actual materialized
      // target now, rather than trying to infer one from scene/Record order.
      for (const sourceId of runtimeReplaySourceSceneIds(archiveScenes, [])) {
        const targets = shared.financeFallbackSceneTargets.get(sourceId) ?? new Set<string>();
        targets.add(targetSceneId);
        shared.financeFallbackSceneTargets.set(sourceId, targets);
      }
    }
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
  const archivePolicies = topologyDocument?.visibilityPolicies ?? [];
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
          sourceVisibilityPolicyId: `legacy-policy:${token}`,
          policyKey: "restore-public",
          policyVersion: 1,
          policyKind: "public" as const,
          sourceSceneId: null,
          restrictedDomainId: null,
          sourcePrivateCharacterInstanceId: null,
          sourceAudienceCharacterInstanceIds: [],
        }]);
  const visibilityPolicyIds = shared.visibilityPolicyIds;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const object=value as Readonly<Record<string,JsonValue>>;
  if(object.__realmRuntimePayload!==undefined) return {...object,__realmRuntimePayload:rewriteEvidenceReferences(object.__realmRuntimePayload,eventIds)};
  if(!Array.isArray(object.evidenceEventIds)) return value;
  return {...object,evidenceEventIds:object.evidenceEventIds.map(id=>typeof id==='string'?remapRequired(eventIds,id,'event.evidenceEventIds'):id)};
}

type DomainStory = NonNullable<RealmRuntimeSaveDomainV1["stories"]>[number];
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
  commandMaterializations?: CommandMaterializations;
  stories: readonly (Omit<DomainStory, "id"> & { sourceId: string; targetId: string })[];
  storyDefinitions: readonly {
    sourceStoryId: string;
    targetStoryId: string;
    /** Immutable hash of the SOURCE definition carried by the archive. */
    sourceDefinitionHash: string;
    /**
     * Immutable first-known origin persisted on the target binding. When
     * the archive carries explicit origin provenance (a binding written by
     * an earlier restore) it is preserved literally; otherwise the
     * immediate source actually known from this archive — its scope
     * workspace, Story identity, and definition hash — is recorded as the
     * first-known origin and older history is never fabricated.
     */
    origin: { workspaceId: string; storyId: string; definitionHash: string };
    /** Hash of the remapped target definition; target node rows bind to it. */
    definitionHash: string;
    /** Remapped target definition: unlock rules reference target identities. */
    definition: StoryDefinition;
  }[];
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
  financeCommandGroups: readonly (Omit<DomainFinanceGroup, "id" | "sourceRecordId" | "resultManifest" | "request" | "requestFingerprint" | "provenance" | "replayLineage"> & {
    sourceId: string;
    targetId: string;
    replayLineage?: StoredReplayBindingV1;
    replayContext?: ReplayContextV1;
    targetSourceRecordId: string | null;
    provenance: "request-result-v1" | "legacy-result-v1";
    resultManifest: Readonly<Record<string, JsonValue>>;
    request: Readonly<Record<string, JsonValue>> | null;
    requestFingerprint: string;
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
  storyNodes: readonly (Omit<DomainNode, "id" | "storyId" | "recordId" | "definitionHash" | "unlockEvidenceEventIds" | "unlockEvidence"> & {
    sourceId: string;
    targetId: string;
    targetStoryId: string;
    /** Remapped target definition hash (never the source hash). */
    definitionHash: string;
    targetRecordId: string | null;
    unlockEvidenceEventIds: readonly string[];
    unlockEvidence: Readonly<Record<string, JsonValue>>;
  })[];
  storyUnlockLedger: readonly (Omit<DomainUnlock, "id" | "storyId" | "storyNodeInstanceId" | "idempotencyKey" | "recordId" | "evidenceEventIds" | "evidence" | "evidenceHash"> & {
    sourceId: string;
    targetId: string;
    targetStoryId: string;
    targetStoryNodeInstanceId: string;
    idempotencyKey: string;
    targetRecordId: string | null;
    evidenceEventIds: readonly string[];
    evidence: Readonly<Record<string, JsonValue>>;
    evidenceHash: string;
  })[];
  committedFactCommands: readonly (Omit<DomainFact, "id" | "resultManifest" | "request" | "requestFingerprint" | "provenance" | "replayLineage"> & {
    sourceId: string;
    targetId: string;
    replayLineage?: StoredReplayBindingV1;
    replayContext?: ReplayContextV1;
    provenance: "request-result-v1" | "legacy-result-v1";
    resultManifest: Readonly<Record<string, JsonValue>>;
    request: Readonly<Record<string, JsonValue>> | null;
    requestFingerprint: string;
  })[];
  performanceAssessments: readonly (Omit<DomainAssessment, "id" | "recordId" | "evidenceEventIds" | "commandId" | "evidenceSnapshotHash"> & {
    sourceId: string;
    targetId: string;
    targetRecordId: string;
    evidenceEventIds: readonly string[];
    targetCommandId: string;
    evidenceSnapshotHash: string;
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
  /** Combined source→target event map across every restored Record plan. */
  eventIds: ReadonlyMap<string, string>;
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

function remapNullableId(
  map: ReadonlyMap<string, string>,
  value: JsonValue | string | null,
  field: string,
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw restoreFailure(`Runtime domain ${field} is invalid.`);
  return remapRequired(map, value, field);
}

function requireRequestKeys(
  row: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
  field: string,
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(row)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw restoreFailure(`Runtime domain ${field} has an unexpected key.`);
    }
  }
  for (const key of required) {
    if (!(key in row)) throw restoreFailure(`Runtime domain ${field} is incomplete.`);
  }
}

function restoreSemanticEventKey(
  row: Readonly<Record<string, JsonValue>>,
  field: string,
): { semanticEventKey?: string } {
  if (row.semanticEventKey === undefined || row.semanticEventKey === null) return {};
  try {
    const key = normalizeSemanticEventKey(row.semanticEventKey);
    return key ? { semanticEventKey: key } : {};
  } catch {
    throw restoreFailure(`Runtime domain ${field}.semanticEventKey is invalid.`);
  }
}

function financeRestoreReceiptManifest(group: NormalizedRestoreDomain["financeCommandGroups"][number]) {
  return group.provenance === "legacy-result-v1"
    ? { provenance: "legacy-result-v1", result: group.resultManifest, request: null,
        ...(group.replayLineage ? { replayLineage: group.replayLineage } : {}),
        ...(group.replayContext ? { replayContext: group.replayContext } : {}) }
    : { result: group.resultManifest, request: group.request };
}

interface DomainRestoreMaps {
  recordIds: ReadonlyMap<string, string>;
  eventIds: ReadonlyMap<string, string>;
  sceneIds: ReadonlyMap<string, string>;
  characterInstanceIds: ReadonlyMap<string, string>;
  assetDefinitionIds: ReadonlyMap<string, string>;
  projectIds: ReadonlyMap<string, string>;
  accountIds: ReadonlyMap<string, string>;
  milestoneIds: ReadonlyMap<string, string>;
  ledgerIds: ReadonlyMap<string, string>;
  groupIds: ReadonlyMap<string, string>;
  obligationIds: ReadonlyMap<string, string>;
  factIds: ReadonlyMap<string, string>;
}

/**
 * Typed remap of the server-persisted finance evidence fingerprint object
 * ({recordId, sceneId, visibility, worldTick, worldOrdinal}). Only identity
 * fields are remapped; nothing else in the request is treated as an identity.
 */
function remapFinanceEvidenceValue(
  value: JsonValue,
  maps: DomainRestoreMaps,
  field: string,
): JsonValue {
  if (value === null) return null;
  const evidence = restoreObject(value, field);
  requireRequestKeys(evidence, ["recordId", "sceneId", "visibility", "worldTick", "worldOrdinal"], field);
  const visibility = restoreString(evidence, "visibility");
  if (visibility !== "public" && visibility !== "restricted") {
    throw restoreFailure(`Runtime domain ${field}.visibility is invalid.`);
  }
  return {
    recordId: remapRequired(maps.recordIds, restoreString(evidence, "recordId"), `${field}.recordId`),
    sceneId: remapRequired(maps.sceneIds, restoreString(evidence, "sceneId"), `${field}.sceneId`),
    visibility,
    worldTick: restoreInteger(evidence, "worldTick", 0),
    worldOrdinal: restoreInteger(evidence, "worldOrdinal", 0),
  };
}

function remapFinanceAction(
  value: JsonValue,
  maps: DomainRestoreMaps,
  field: string,
): JsonValue {
  const action = restoreObject(value, field);
  const command = restoreString(action, "command");
  if (command === "change_stage") {
    requireRequestKeys(action, ["command", "projectId", "stage", "expectedProjectVersion"], field);
    return {
      command,
      projectId: remapRequired(maps.projectIds, restoreString(action, "projectId"), `${field}.projectId`),
      stage: restoreString(action, "stage"),
      expectedProjectVersion: restoreInteger(action, "expectedProjectVersion", 1),
    };
  }
  if (command === "confirm_milestone") {
    requireRequestKeys(action, ["command", "projectId", "milestoneId", "expectedProjectVersion"], field);
    return {
      command,
      projectId: remapRequired(maps.projectIds, restoreString(action, "projectId"), `${field}.projectId`),
      milestoneId: remapRequired(maps.milestoneIds, restoreString(action, "milestoneId"), `${field}.milestoneId`),
      expectedProjectVersion: restoreInteger(action, "expectedProjectVersion", 1),
    };
  }
  if (command === "record_expense") {
    requireRequestKeys(action, ["command", "accountId", "amountMinor", "category", "memo", "projectId", "occurredAt", "expectedBalanceMinor"], field);
    return {
      command,
      accountId: remapNullableId(maps.accountIds, action.accountId ?? null, `${field}.accountId`),
      amountMinor: restoreInteger(action, "amountMinor", 1),
      category: restoreString(action, "category"),
      memo: restoreString(action, "memo"),
      projectId: remapNullableId(maps.projectIds, action.projectId ?? null, `${field}.projectId`),
      occurredAt: restoreString(action, "occurredAt"),
      expectedBalanceMinor: restoreInteger(action, "expectedBalanceMinor", 0),
    };
  }
  throw restoreFailure(`Runtime domain ${field} is not a supported finance action.`);
}

/** Typed remap of a persisted canonical finance request to target identities. */
function remapFinanceRequest(
  request: Readonly<Record<string, JsonValue>>,
  maps: DomainRestoreMaps,
  field: string,
): Readonly<Record<string, JsonValue>> {
  const command = restoreString(request, "command");
  switch (command) {
    case "finance.expense.recorded":
    case "finance.income.recorded":
    case "finance.adjustment.recorded": {
      const hasDirection = "direction" in request;
      requireRequestKeys(request, [
        "command", "accountId", "amountMinor", "category", "memo", "projectId",
        "recordId", "occurredAt", "expectedBalanceMinor", "evidence",
        ...(hasDirection ? ["direction" as const] : []),
      ], field);
      return {
        command,
        accountId: remapNullableId(maps.accountIds, request.accountId ?? null, `${field}.accountId`),
        amountMinor: restoreInteger(request, "amountMinor", 1),
        category: restoreString(request, "category"),
        memo: restoreString(request, "memo"),
        projectId: remapNullableId(maps.projectIds, request.projectId ?? null, `${field}.projectId`),
        recordId: remapNullableId(maps.recordIds, request.recordId ?? null, `${field}.recordId`),
        occurredAt: restoreString(request, "occurredAt"),
        expectedBalanceMinor: restoreInteger(request, "expectedBalanceMinor", 0),
        ...(hasDirection ? { direction: restoreString(request, "direction") } : {}),
        evidence: remapFinanceEvidenceValue(request.evidence ?? null, maps, `${field}.evidence`),
      };
    }
    case "project.milestone.confirmed": {
      requireRequestKeys(
        request,
        ["command", "projectId", "milestoneId", "expectedProjectVersion", "evidence"],
        field,
        ["semanticEventKey"],
      );
      return {
        command,
        projectId: remapRequired(maps.projectIds, restoreString(request, "projectId"), `${field}.projectId`),
        milestoneId: remapRequired(maps.milestoneIds, restoreString(request, "milestoneId"), `${field}.milestoneId`),
        expectedProjectVersion: restoreInteger(request, "expectedProjectVersion", 1),
        evidence: remapFinanceEvidenceValue(request.evidence ?? null, maps, `${field}.evidence`),
        ...restoreSemanticEventKey(request, field),
      };
    }
    case "project.stage.changed": {
      requireRequestKeys(request, ["command", "projectId", "stage", "expectedProjectVersion", "evidence"], field);
      return {
        command,
        projectId: remapRequired(maps.projectIds, restoreString(request, "projectId"), `${field}.projectId`),
        stage: restoreString(request, "stage"),
        expectedProjectVersion: restoreInteger(request, "expectedProjectVersion", 1),
        evidence: remapFinanceEvidenceValue(request.evidence ?? null, maps, `${field}.evidence`),
      };
    }
    case "finance.budget.allocated": {
      requireRequestKeys(request, ["command", "projectId", "category", "amountMinor", "expectedVersion"], field);
      return {
        command,
        projectId: remapRequired(maps.projectIds, restoreString(request, "projectId"), `${field}.projectId`),
        category: restoreString(request, "category"),
        amountMinor: restoreInteger(request, "amountMinor", 1),
        expectedVersion: restoreInteger(request, "expectedVersion", 0),
      };
    }
    case "finance.obligation.created": {
      requireRequestKeys(request, ["command", "projectId", "kind", "principalMinor", "shareBps", "undeliveredCount"], field);
      const shareBps = request.shareBps;
      if (shareBps !== null && !Number.isSafeInteger(shareBps)) {
        throw restoreFailure(`Runtime domain ${field}.shareBps is invalid.`);
      }
      return {
        command,
        projectId: remapNullableId(maps.projectIds, request.projectId ?? null, `${field}.projectId`),
        kind: restoreString(request, "kind"),
        principalMinor: restoreInteger(request, "principalMinor", 1),
        shareBps,
        undeliveredCount: restoreInteger(request, "undeliveredCount", 0),
      };
    }
    case "finance.obligation.settled": {
      requireRequestKeys(request, ["command", "obligationId", "settlementKind", "amountMinor", "expectedOutstandingMinor", "expectedBalanceMinor", "accountId", "category", "occurredAt"], field);
      return {
        command,
        obligationId: remapRequired(maps.obligationIds, restoreString(request, "obligationId"), `${field}.obligationId`),
        settlementKind: restoreString(request, "settlementKind"),
        amountMinor: restoreInteger(request, "amountMinor", 1),
        expectedOutstandingMinor: restoreInteger(request, "expectedOutstandingMinor", 0),
        expectedBalanceMinor: restoreInteger(request, "expectedBalanceMinor", 0),
        accountId: remapNullableId(maps.accountIds, request.accountId ?? null, `${field}.accountId`),
        category: restoreString(request, "category"),
        occurredAt: restoreString(request, "occurredAt"),
      };
    }
    case "record.apply_project_finance": {
      requireRequestKeys(request, ["command", "evidence", "actions"], field);
      const actions = request.actions;
      if (!Array.isArray(actions)) throw restoreFailure(`Runtime domain ${field}.actions is invalid.`);
      return {
        command,
        evidence: remapFinanceEvidenceValue(request.evidence ?? null, maps, `${field}.evidence`),
        actions: actions.map((action, index) => remapFinanceAction(action, maps, `${field}.actions[${index}]`)),
      };
    }
    default:
      throw restoreFailure(`Runtime domain ${field} has an unsupported finance command.`);
  }
}

/** Typed remap of a persisted canonical committed-fact request. */
function remapFactRequest(
  kind: DomainFact["kind"],
  request: Readonly<Record<string, JsonValue>>,
  maps: DomainRestoreMaps,
  field: string,
): Readonly<Record<string, JsonValue>> {
  const command = restoreString(request, "command");
  switch (kind) {
    case "inventory_adjusted": {
      if (command !== "inventory.adjusted") throw restoreFailure(`Runtime domain ${field}.command is inconsistent.`);
      requireRequestKeys(request, ["command", "recordId", "characterInstanceId", "assetDefinitionId", "delta", "sourceEventId", "expectedRevision"], field);
      return {
        command,
        recordId: remapRequired(maps.recordIds, restoreString(request, "recordId"), `${field}.recordId`),
        characterInstanceId: remapRequired(maps.characterInstanceIds, restoreString(request, "characterInstanceId"), `${field}.characterInstanceId`),
        // Pre-resolved against the installed target World BEFORE any request
        // fingerprint is derived, so the target request carries the actual
        // target definition identity.
        assetDefinitionId: remapRequired(maps.assetDefinitionIds, restoreString(request, "assetDefinitionId"), `${field}.assetDefinitionId`),
        delta: restoreInteger(request, "delta", -1_000_000),
        sourceEventId: remapRequired(maps.eventIds, restoreString(request, "sourceEventId"), `${field}.sourceEventId`),
        expectedRevision: restoreInteger(request, "expectedRevision", 0),
      };
    }
    case "inventory_granted": {
      if (command !== "inventory.granted") throw restoreFailure(`Runtime domain ${field}.command is inconsistent.`);
      requireRequestKeys(request, ["command", "recordId", "characterInstanceId", "assetDefinitionId", "quantity", "sourceEventId"], field);
      return {
        command,
        recordId: remapRequired(maps.recordIds, restoreString(request, "recordId"), `${field}.recordId`),
        characterInstanceId: remapRequired(maps.characterInstanceIds, restoreString(request, "characterInstanceId"), `${field}.characterInstanceId`),
        assetDefinitionId: remapRequired(maps.assetDefinitionIds, restoreString(request, "assetDefinitionId"), `${field}.assetDefinitionId`),
        quantity: restoreInteger(request, "quantity", 1),
        sourceEventId: remapRequired(maps.eventIds, restoreString(request, "sourceEventId"), `${field}.sourceEventId`),
      };
    }
    case "relationship_revised": {
      if (command !== "relationship.revised") throw restoreFailure(`Runtime domain ${field}.command is inconsistent.`);
      requireRequestKeys(request, ["command", "subjectEntityKey", "objectEntityKey", "relationKind", "sourceEventId"], field);
      return {
        command,
        subjectEntityKey: restoreString(request, "subjectEntityKey"),
        objectEntityKey: restoreString(request, "objectEntityKey"),
        relationKind: restoreString(request, "relationKind"),
        sourceEventId: remapRequired(maps.eventIds, restoreString(request, "sourceEventId"), `${field}.sourceEventId`),
      };
    }
    case "performance_assessed": {
      if (command !== "performance.assessed") throw restoreFailure(`Runtime domain ${field}.command is inconsistent.`);
      requireRequestKeys(request, ["command", "recordId", "policyVersion", "score", "evidenceEventIds"], field);
      // Production readEvidenceIds sorts the snapshot before fingerprinting;
      // the remapped request must match that canonical order byte-for-byte.
      const evidenceEventIds = restoreStringArray(request, "evidenceEventIds")
        .map((id) => remapRequired(maps.eventIds, id, `${field}.evidenceEventIds`))
        .sort((left, right) => left.localeCompare(right));
      return {
        command,
        recordId: remapRequired(maps.recordIds, restoreString(request, "recordId"), `${field}.recordId`),
        policyVersion: restoreString(request, "policyVersion"),
        score: restoreInteger(request, "score", -1_000_000),
        evidenceEventIds,
      };
    }
    default:
      throw restoreFailure(`Runtime domain ${field} has an unsupported fact command.`);
  }
}

/** Typed remap of a stored fact-command result manifest. */
function remapFactManifest(
  kind: DomainFact["kind"],
  manifest: Readonly<Record<string, JsonValue>>,
  targetCommandId: string,
  remappedRequest: Readonly<Record<string, JsonValue>>,
  field: string,
): Readonly<Record<string, JsonValue>> {
  const commandId = restoreString(manifest, "commandId");
  if (commandId.length === 0) throw restoreFailure(`Runtime domain ${field}.commandId is invalid.`);
  switch (kind) {
    case "inventory_adjusted":
    case "inventory_granted": {
      requireRequestKeys(manifest, ["status", "commandId", "quantity", "revision"], field);
      return {
        status: restoreString(manifest, "status"),
        commandId: targetCommandId,
        quantity: restoreInteger(manifest, "quantity", 0),
        revision: restoreInteger(manifest, "revision", 0),
      };
    }
    case "relationship_revised": {
      requireRequestKeys(manifest, ["status", "commandId", "relationKind", "revisionOrdinal", "occurred"], field);
      const occurred = restoreObject(manifest.occurred ?? null, `${field}.occurred`);
      requireRequestKeys(occurred, ["worldTick", "worldOrdinal"], `${field}.occurred`);
      return {
        status: restoreString(manifest, "status"),
        commandId: targetCommandId,
        relationKind: restoreString(manifest, "relationKind"),
        revisionOrdinal: restoreInteger(manifest, "revisionOrdinal", 1),
        occurred: {
          worldTick: restoreInteger(occurred, "worldTick", 0),
          worldOrdinal: restoreInteger(occurred, "worldOrdinal", 0),
        },
      };
    }
    case "performance_assessed": {
      requireRequestKeys(manifest, ["status", "commandId", "assessmentId", "score", "evidenceSnapshotHash", "goalTransition"], field);
      if (manifest.goalTransition !== null) throw restoreFailure(`Runtime domain ${field}.goalTransition is invalid.`);
      const assessmentId = restoreString(manifest, "assessmentId");
      if (assessmentId !== `${commandId}:assessment`) throw restoreFailure(`Runtime domain ${field}.assessmentId is invalid.`);
      const evidenceEventIds = remappedRequest.evidenceEventIds;
      if (!Array.isArray(evidenceEventIds)) throw restoreFailure(`Runtime domain ${field}.evidenceEventIds is invalid.`);
      return {
        status: restoreString(manifest, "status"),
        commandId: targetCommandId,
        assessmentId: `${targetCommandId}:assessment`,
        score: restoreInteger(manifest, "score", -1_000_000),
        // Recomputed against the remapped evidence snapshot, never copied.
        evidenceSnapshotHash: evidenceHash(evidenceEventIds as readonly string[]),
        goalTransition: null,
      };
    }
    default:
      throw restoreFailure(`Runtime domain ${field} has an unsupported fact command.`);
  }
}

/** Typed remap of a stored finance command-group result manifest. */
function remapFinanceManifest(
  request: Readonly<Record<string, JsonValue>>,
  manifest: Readonly<Record<string, JsonValue>>,
  maps: DomainRestoreMaps,
  scope: { workspaceId: string; worldId: string; worldlineId: string },
  field: string,
): Readonly<Record<string, JsonValue>> {
  const command = restoreString(request, "command");
  const remapWorldCursor = (value: JsonValue | undefined): JsonValue => {
    if (value === undefined || value === null) return value ?? null;
    const cursor = restoreObject(value, `${field}.worldCursor`);
    requireRequestKeys(cursor, ["worldTick", "worldOrdinal"], `${field}.worldCursor`);
    return {
      worldTick: restoreInteger(cursor, "worldTick", 0),
      worldOrdinal: restoreInteger(cursor, "worldOrdinal", 0),
    };
  };
  const commandGroupId = remapRequired(maps.groupIds, restoreString(manifest, "commandGroupId"), `${field}.commandGroupId`);
  switch (command) {
    case "finance.expense.recorded":
    case "finance.income.recorded":
    case "finance.adjustment.recorded": {
      requireRequestKeys(manifest, ["status", "commandGroupId", "entry", "cash", "eventKind"], field, ["worldCursor"]);
      const entry = restoreObject(manifest.entry ?? null, `${field}.entry`);
      requireRequestKeys(entry, [
        "workspaceId", "worldId", "worldlineId", "id", "accountId", "kind",
        "direction", "amountMinor", "currency", "category", "memo", "projectId",
        "recordId", "sourceEventId", "occurredAt", "idempotencyKey",
      ], `${field}.entry`);
      const remappedEntry: Record<string, JsonValue> = {
        workspaceId: scope.workspaceId,
        worldId: scope.worldId,
        worldlineId: scope.worldlineId,
        id: remapRequired(maps.ledgerIds, restoreString(entry, "id"), `${field}.entry.id`),
        accountId: remapRequired(maps.accountIds, restoreString(entry, "accountId"), `${field}.entry.accountId`),
        kind: restoreString(entry, "kind"),
        direction: restoreString(entry, "direction"),
        amountMinor: restoreInteger(entry, "amountMinor", 1),
        currency: restoreString(entry, "currency"),
        category: restoreString(entry, "category"),
        memo: restoreString(entry, "memo"),
        projectId: remapNullableId(maps.projectIds, entry.projectId ?? null, `${field}.entry.projectId`),
        recordId: remapNullableId(maps.recordIds, entry.recordId ?? null, `${field}.entry.recordId`),
        sourceEventId: remapNullableId(maps.eventIds, entry.sourceEventId ?? null, `${field}.entry.sourceEventId`),
        occurredAt: restoreString(entry, "occurredAt"),
        idempotencyKey: restoreString(entry, "idempotencyKey"),
      };
      const result: Record<string, JsonValue> = {
        status: restoreString(manifest, "status"),
        commandGroupId,
        entry: remappedEntry,
        cash: restoreObject(manifest.cash ?? null, `${field}.cash`) as JsonValue,
        eventKind: restoreString(manifest, "eventKind"),
      };
      if ("worldCursor" in manifest) result.worldCursor = remapWorldCursor(manifest.worldCursor);
      return result;
    }
    case "project.milestone.confirmed": {
      requireRequestKeys(
        manifest,
        ["status", "commandGroupId", "projectId", "milestoneId", "projectVersion", "eventKind"],
        field,
        ["worldCursor", "semanticEventKey", "requestPolicy"],
      );
      const result: Record<string, JsonValue> = {
        status: restoreString(manifest, "status"),
        commandGroupId,
        projectId: remapRequired(maps.projectIds, restoreString(manifest, "projectId"), `${field}.projectId`),
        milestoneId: remapRequired(maps.milestoneIds, restoreString(manifest, "milestoneId"), `${field}.milestoneId`),
        projectVersion: restoreInteger(manifest, "projectVersion", 1),
        eventKind: restoreString(manifest, "eventKind"),
        ...restoreSemanticEventKey(manifest, field),
        ...(Object.hasOwn(manifest, "requestPolicy") ? { requestPolicy: { ...normalizeRequestPolicy(manifest.requestPolicy) } } : {}),
      };
      if ("worldCursor" in manifest) result.worldCursor = remapWorldCursor(manifest.worldCursor);
      return result;
    }
    case "project.stage.changed": {
      requireRequestKeys(manifest, ["status", "commandGroupId", "projectId", "stage", "projectVersion", "eventKind", "worldCursor"], field);
      return {
        status: restoreString(manifest, "status"),
        commandGroupId,
        projectId: remapRequired(maps.projectIds, restoreString(manifest, "projectId"), `${field}.projectId`),
        stage: restoreString(manifest, "stage"),
        projectVersion: restoreInteger(manifest, "projectVersion", 1),
        eventKind: restoreString(manifest, "eventKind"),
        worldCursor: remapWorldCursor(manifest.worldCursor),
      };
    }
    case "finance.budget.allocated": {
      requireRequestKeys(manifest, ["status", "commandGroupId", "projectId", "category", "amountMinor", "version", "eventKind"], field);
      return {
        status: restoreString(manifest, "status"),
        commandGroupId,
        projectId: remapRequired(maps.projectIds, restoreString(manifest, "projectId"), `${field}.projectId`),
        category: restoreString(manifest, "category"),
        amountMinor: restoreInteger(manifest, "amountMinor", 1),
        version: restoreInteger(manifest, "version", 1),
        eventKind: restoreString(manifest, "eventKind"),
      };
    }
    case "finance.obligation.created":
    case "finance.obligation.settled": {
      // Settlement results always carry the post-write cash position;
      // creation results never do.
      const isSettlement = command === "finance.obligation.settled";
      requireRequestKeys(
        manifest,
        [
          "status", "commandGroupId", "obligationId", "kind", "outstandingMinor", "undeliveredCount",
          ...(isSettlement ? ["cash"] : []),
        ],
        field,
      );
      const result: Record<string, JsonValue> = {
        status: restoreString(manifest, "status"),
        commandGroupId,
        obligationId: remapRequired(maps.obligationIds, restoreString(manifest, "obligationId"), `${field}.obligationId`),
        kind: restoreString(manifest, "kind"),
        outstandingMinor: restoreInteger(manifest, "outstandingMinor", 0),
        undeliveredCount: restoreInteger(manifest, "undeliveredCount", 0),
      };
      if (isSettlement) result.cash = restoreObject(manifest.cash ?? null, `${field}.cash`) as JsonValue;
      return result;
    }
    case "record.apply_project_finance": {
      requireRequestKeys(manifest, ["status", "commandGroupId", "worldCursor"], field);
      return {
        status: restoreString(manifest, "status"),
        commandGroupId,
        worldCursor: remapWorldCursor(manifest.worldCursor),
      };
    }
    default:
      throw restoreFailure(`Runtime domain ${field} has an unsupported finance result manifest.`);
  }
}

/**
 * Typed remap of Story unlock evidence ({eventIds, goalKeys, nodeKeys,
 * milestoneIds?, obligationIds?}). Only typed identity arrays are remapped;
 * goalKeys/nodeKeys are semantic keys and are preserved.
 */
function remapStoryUnlockEvidenceValue(
  value: Readonly<Record<string, JsonValue>>,
  maps: DomainRestoreMaps,
  field: string,
  options: { locked?: boolean } = {},
): Readonly<Record<string, JsonValue>> {
  // A locked node has never unlocked: production materialize stores exactly
  // `{}`, and restore must carry it verbatim — evidence is never invented
  // for a node that has not unlocked.
  if (options.locked) {
    if (Object.keys(value).length > 0) {
      throw restoreFailure(`Runtime domain ${field} must be empty for a locked node.`);
    }
    return {};
  }
  requireRequestKeys(value, ["eventIds", "goalKeys", "nodeKeys"], field, ["milestoneIds", "obligationIds"]);
  const remapArray = (key: string, map: ReadonlyMap<string, string>) => (
    restoreStringArray(value, key).map((id) => remapRequired(map, id, `${field}.${key}`))
  );
  const result: Record<string, JsonValue> = {
    eventIds: remapArray("eventIds", maps.eventIds),
    goalKeys: restoreStringArray(value, "goalKeys"),
    nodeKeys: restoreStringArray(value, "nodeKeys"),
  };
  if ("milestoneIds" in value && value.milestoneIds !== undefined) {
    result.milestoneIds = remapArray("milestoneIds", maps.milestoneIds);
  }
  if ("obligationIds" in value && value.obligationIds !== undefined) {
    result.obligationIds = remapArray("obligationIds", maps.obligationIds);
  }
  return result;
}

/**
 * Rule references to milestones/obligations that have no row in the source
 * worldline are World-level content references not yet instantiated (a Story
 * may legitimately gate on a milestone that does not exist yet). The reader
 * carries every milestone/obligation of the worldline, so an unmapped id
 * provably has no source row; keeping it verbatim preserves the rule's
 * semantics in the target (still unsatisfied until instantiated there).
 */
function remapContentReference(
  map: ReadonlyMap<string, string>,
  value: string,
): string {
  return map.get(value) ?? value;
}

/** Recursive typed remap of Story unlock rules: only the declared runtime
 * identity fields (milestone/obligation/Record references) are rewritten;
 * goal keys, node keys, event kinds, and thresholds are semantic and kept.
 * Record references stay fail-closed: Records are always runtime rows, so a
 * rule referencing an un-carried Record is dangling evidence. */
function remapStoryUnlockRule(
  rule: StoryUnlockRule,
  maps: {
    recordIds: ReadonlyMap<string, string>;
    milestoneIds: ReadonlyMap<string, string>;
    obligationIds: ReadonlyMap<string, string>;
  },
  field: string,
): StoryUnlockRule {
  switch (rule.kind) {
    case "story_started":
    case "node_state":
    case "cash_at_least":
      return rule;
    case "goal_state":
      return {
        ...rule,
        ...(rule.recordId !== undefined
          ? { recordId: remapRequired(maps.recordIds, rule.recordId, `${field}.recordId`) }
          : {}),
      };
    case "event_count":
      return {
        ...rule,
        ...(rule.recordId !== undefined
          ? { recordId: remapRequired(maps.recordIds, rule.recordId, `${field}.recordId`) }
          : {}),
      };
    case "milestone_status":
      return { ...rule, milestoneId: remapContentReference(maps.milestoneIds, rule.milestoneId) };
    case "obligation_outstanding_at_most":
      return { ...rule, obligationId: remapContentReference(maps.obligationIds, rule.obligationId) };
    case "all":
    case "any":
      return { ...rule, rules: rule.rules.map((inner, index) => remapStoryUnlockRule(inner, maps, `${field}.rules[${index}]`)) };
    case "not":
      return { ...rule, rule: remapStoryUnlockRule(rule.rule, maps, `${field}.rule`) };
    default:
      throw restoreFailure(`Runtime domain ${field} has an unsupported unlock rule.`);
  }
}

/**
 * Legacy (pre-provenance) finance results carry no request. The command kind
 * is recovered from the typed result shape alone — never from free text — so
 * the stored manifest can still be remapped field-by-field.
 */
function inferLegacyFinanceCommand(
  manifest: Readonly<Record<string, JsonValue>>,
  field: string,
): string {
  const eventKind = manifest.eventKind;
  if (typeof eventKind === "string") {
    if (
      eventKind === "project.milestone.confirmed"
      || eventKind === "project.stage.changed"
      || eventKind === "finance.budget.allocated"
      || eventKind === "finance.expense.recorded"
      || eventKind === "finance.income.recorded"
      || eventKind === "finance.adjustment.recorded"
    ) {
      return eventKind;
    }
  }
  if (typeof manifest.obligationId === "string") {
    // Settlement results always carry the post-write cash position;
    // creation results never do.
    return "cash" in manifest && manifest.cash !== null && manifest.cash !== undefined
      ? "finance.obligation.settled"
      : "finance.obligation.created";
  }
  if ("worldCursor" in manifest) return "record.apply_project_finance";
  throw restoreFailure(`Runtime domain ${field} is not a recognized legacy finance result.`);
}

/** Typed remap of a legacy fact-command bare result (no persisted request). */
function remapLegacyFactManifest(
  command: DomainFact,
  assessments: readonly DomainAssessment[],
  eventIds: ReadonlyMap<string, string>,
  targetCommandId: string,
): Readonly<Record<string, JsonValue>> {
  const field = `committedFactCommands.${command.id}.resultManifest`;
  if (command.kind === "performance_assessed") {
    // The bare result has no evidence ids; the domain assessment row for this
    // command carries the authoritative source evidence snapshot to remap.
    const assessment = assessments.find((row) => row.commandId === command.id);
    if (!assessment) {
      throw restoreFailure("Runtime domain legacy assessment evidence is missing.");
    }
    const evidenceEventIds = assessment.evidenceEventIds
      .map((id) => remapRequired(eventIds, id, `${field}.evidenceEventIds`))
      .sort((left, right) => left.localeCompare(right));
    const manifest = command.resultManifest;
    requireRequestKeys(manifest, ["status", "commandId", "assessmentId", "score", "evidenceSnapshotHash", "goalTransition"], field);
    if (manifest.goalTransition !== null) throw restoreFailure(`Runtime domain ${field}.goalTransition is invalid.`);
    const sourceCommandId = restoreString(manifest, "commandId");
    if (restoreString(manifest, "assessmentId") !== `${sourceCommandId}:assessment`) {
      throw restoreFailure(`Runtime domain ${field}.assessmentId is invalid.`);
    }
    return {
      status: restoreString(manifest, "status"),
      commandId: targetCommandId,
      assessmentId: `${targetCommandId}:assessment`,
      score: restoreInteger(manifest, "score", -1_000_000),
      evidenceSnapshotHash: evidenceHash(evidenceEventIds),
      goalTransition: null,
    };
  }
  // inventory_*/relationship_revised manifests never read the request.
  return remapFactManifest(command.kind, command.resultManifest, targetCommandId, {}, field);
}

function remapCanonicalStoryEvidence(value: Readonly<Record<string,JsonValue>>, maps: DomainRestoreMaps): Readonly<Record<string,JsonValue>> {
  requireRequestKeys(value,[],"legacy.storyEvidence",["projectId","milestoneId"]);
  return {...(value.projectId===undefined?{}:{projectId:remapRequired(maps.projectIds,restoreString(value,"projectId"),"legacy.storyEvidence.projectId")}),
    ...(value.milestoneId===undefined?{}:{milestoneId:remapRequired(maps.milestoneIds,restoreString(value,"milestoneId"),"legacy.storyEvidence.milestoneId")})};
}
function remapCanonicalFinanceManifest(value: Readonly<Record<string,JsonValue>>, maps: DomainRestoreMaps): Readonly<Record<string,JsonValue>> {
  requireRequestKeys(value,["projectId","ledgerEntryIds"],"legacy.finance");
  return {projectId:remapRequired(maps.projectIds,restoreString(value,"projectId"),"legacy.finance.projectId"),
    ledgerEntryIds:restoreStringArray(value,"ledgerEntryIds").map(id=>remapRequired(maps.ledgerIds,id,"legacy.finance.ledgerEntryIds"))};
}
function remapCanonicalFactManifest(kind: DomainFact["kind"], value: Readonly<Record<string,JsonValue>>, maps: DomainRestoreMaps): Readonly<Record<string,JsonValue>> {
  if(kind==="inventory_granted") {
    requireRequestKeys(value,["recordId","characterInstanceId","assetDefinitionId","quantity"],"legacy.fact");
    return {recordId:remapRequired(maps.recordIds,restoreString(value,"recordId"),"legacy.fact.recordId"),
      characterInstanceId:remapRequired(maps.characterInstanceIds,restoreString(value,"characterInstanceId"),"legacy.fact.character"),
      assetDefinitionId:remapRequired(maps.assetDefinitionIds,restoreString(value,"assetDefinitionId"),"legacy.fact.asset"),quantity:restoreInteger(value,"quantity",0)};
  }
  if(kind==="relationship_revised") {
    requireRequestKeys(value,["recordId","sourceEventId"],"legacy.fact");
    return {recordId:remapRequired(maps.recordIds,restoreString(value,"recordId"),"legacy.fact.recordId"),sourceEventId:remapRequired(maps.eventIds,restoreString(value,"sourceEventId"),"legacy.fact.sourceEventId")};
  }
  if(kind==="performance_assessed") {
    requireRequestKeys(value,["recordId","score"],"legacy.fact");
    return {recordId:remapRequired(maps.recordIds,restoreString(value,"recordId"),"legacy.fact.recordId"),score:restoreInteger(value,"score",-1000000)};
  }
  throw restoreFailure("The historical single-Record receipt shape is unsupported.");
}


function normalizeRestoreDomain(
  archive: RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>,
  token: string,
  targetWorkspaceId: string,
  targetWorldId: string,
  targetWorldlineId: string,
  shared: RestoreSharedState,
  assetDefinitionIds: ReadonlyMap<string, string>,
): NormalizedRestoreDomain | null {
  const inputDomain = archive.domain;
  if (!inputDomain) return null;
  const canonicalLegacyFactIds = new Set(inputDomain.stories === undefined ? inputDomain.committedFactCommands.filter(command => command.provenance===undefined && command.request===undefined).map(command=>command.id) : []);
  const domain = { ...inputDomain,
    committedFactCommands: inputDomain.committedFactCommands.map(command=>({...command,provenance:command.provenance ?? (command.request ? "request-result-v1" as const : "legacy-result-v1" as const),request:command.request ?? null})),
    financeCommandGroups: inputDomain.financeCommandGroups.map(group=>({...group,provenance:group.provenance ?? (group.request ? "request-result-v1" as const : "legacy-result-v1" as const),request:group.request ?? null})),
    stories: inputDomain.stories ?? [{id:inputDomain.source.storyId,title:"Restored story",status:"active" as const,premise:""}],
    storyDefinitions: inputDomain.storyDefinitions ?? [], records: inputDomain.records ?? [],
    storyNodes: inputDomain.storyNodes.map(node => ({...node,storyId:node.storyId ?? inputDomain.source.storyId})),
    storyUnlockLedger: inputDomain.storyUnlockLedger.map(row => ({...row,storyId:row.storyId ?? inputDomain.source.storyId})),
  };
  if (
    domain.source.worldId !== archive.record.scope.worldId
    || domain.source.worldlineId !== archive.record.scope.worldlineId
    || domain.source.recordId !== archive.record.scope.recordId
  ) {
    throw restoreFailure("Runtime domain scope does not match the saved Record.");
  }
  if (domain.source.storyId.trim() === "") throw restoreFailure("Runtime domain Story identity is missing.");
  const targetScope = { workspaceId: targetWorkspaceId, worldId: targetWorldId, worldlineId: targetWorldlineId };

  // Pass 1: build every source→target identity mapping before any reference
  // is rewritten, so no rewrite can observe a partial mapping. Record/Event/
  // scene/character identities come from the shared cross-Record plans.
  const recordIds = shared.recordIds;
  const eventIds = shared.eventIds;
  const primaryTargetRecordId = recordIds.get(archive.record.scope.recordId);
  if (!primaryTargetRecordId) {
    throw restoreFailure("Runtime domain scope does not match the restored Record plans.");
  }

  const storyIds = new Map<string, string>();
  storyIds.set(domain.source.storyId, primaryTargetRecordId.replace(/^record_/, "story_"));
  domain.stories.forEach((story, index) => {
    if (storyIds.has(story.id)) return;
    storyIds.set(story.id, `story_restore_${token}_${index}`);
  });

  const assignIds = (
    ids: Map<string, string>,
    values: readonly string[],
    prefix: string,
    duplicateMessage: string,
  ) => {
    values.forEach((sourceId, index) => {
      if (ids.has(sourceId)) throw restoreFailure(duplicateMessage);
      const targetId = `${prefix}_restore_${token}_${index}`;
      ids.set(sourceId, targetId);
    });
  };

  const projectIds = new Map<string, string>();
  assignIds(projectIds, domain.projects.map((project) => project.id), "project", "Runtime domain project ids are duplicated.");
  const accountIds = new Map<string, string>();
  assignIds(accountIds, domain.financeAccounts.map((account) => account.id), "finance_account", "Runtime domain finance account ids are duplicated.");
  const milestoneIds = new Map<string, string>();
  assignIds(milestoneIds, domain.milestones.map((milestone) => milestone.id), "milestone", "Runtime domain milestone ids are duplicated.");
  const nodeIds = new Map<string, string>();
  for (const node of domain.storyNodes) {
    if (nodeIds.has(node.id)) throw restoreFailure("Runtime domain Story node ids are duplicated.");
    const targetStoryId = storyIds.get(node.storyId);
    if (!targetStoryId) throw restoreFailure("Runtime domain Story node references an unknown Story.");
    nodeIds.set(node.id, storyNodeInstanceIdFor({
      workspaceId: targetWorkspaceId,
      worldId: targetWorldId,
      worldlineId: targetWorldlineId,
      storyId: targetStoryId,
    }, node.nodeKey));
  }

  // Fact command identities are content-derived from the remapped canonical
  // request: the target fingerprint proves replay provenance instead of
  // copying the source-scope hash. Legacy rows keep their original source
  // fingerprint untouched and prove replay by reversing typed identities
  // against the first-known origin before comparing the full original hash.
  const factIds = new Map<string, string>();
  const factRequests = new Map<string, Readonly<Record<string, JsonValue>> | null>();
  const factFingerprints = new Map<string, string>();
  const factMaps: DomainRestoreMaps = {
    recordIds, eventIds, sceneIds: shared.sceneIds,
    characterInstanceIds: shared.characterInstanceIds,
    assetDefinitionIds,
    projectIds, accountIds, milestoneIds,
    ledgerIds: new Map(), groupIds: new Map(), obligationIds: new Map(), factIds,
  };
  for (const command of domain.committedFactCommands) {
    if (factIds.has(command.id)) throw restoreFailure("Runtime domain fact command ids are duplicated.");
    if (command.provenance === "legacy-result-v1") {
      const requestFingerprint = command.requestFingerprint;
      factRequests.set(command.id, null);
      factFingerprints.set(command.id, requestFingerprint);
      factIds.set(command.id, committedFactCommandIdFor(targetScope, command.idempotencyKey, requestFingerprint));
      continue;
    }
    if (command.request === null) throw restoreFailure("Runtime domain fact command request is missing.");
    const request = remapFactRequest(command.kind, command.request, factMaps, `committedFactCommands.${command.id}.request`);
    const requestFingerprint = committedFactRequestFingerprintFor(targetScope, request);
    factRequests.set(command.id, request);
    factFingerprints.set(command.id, requestFingerprint);
    factIds.set(command.id, committedFactCommandIdFor(targetScope, command.idempotencyKey, requestFingerprint));
  }

  const groupIds = new Map<string, string>();
  const groupRequests = new Map<string, Readonly<Record<string, JsonValue>> | null>();
  const groupFingerprints = new Map<string, string>();
  // Ledger/settlement/budget/obligation ids produced by command groups keep
  // their derivation (`<group>:entry` etc.) so restored rows are
  // indistinguishable from natively committed ones.
  const derivedId = (
    sourceId: string,
    suffixPattern: RegExp,
  ): string | null => {
    for (const [sourceGroupId, targetGroupId] of groupIds) {
      if (sourceId.startsWith(`${sourceGroupId}:`) && suffixPattern.test(sourceId.slice(sourceGroupId.length + 1))) {
        return `${targetGroupId}:${sourceId.slice(sourceGroupId.length + 1)}`;
      }
    }
    return null;
  };
  // Round 1: groups whose requests cannot reference Obligation identities
  // (Obligation target ids derive from their creating group, so they are not
  // known until those groups are remapped).
  const obligationIds = new Map<string, string>();
  const groupMaps: DomainRestoreMaps = { ...factMaps, factIds, groupIds, obligationIds };
  const settleGroups: typeof domain.financeCommandGroups[number][] = [];
  const remapGroupRequest = (
    group: typeof domain.financeCommandGroups[number],
  ): void => {
    if (group.provenance === "legacy-result-v1") {
      const requestFingerprint = group.requestFingerprint;
      groupRequests.set(group.id, null);
      groupFingerprints.set(group.id, requestFingerprint);
      groupIds.set(group.id, projectFinanceCommandGroupIdFor(targetScope, group.idempotencyKey, requestFingerprint));
      return;
    }
    if (group.request === null) throw restoreFailure("Runtime domain finance command request is missing.");
    const request = remapFinanceRequest(group.request, groupMaps, `financeCommandGroups.${group.id}.request`);
    const requestFingerprint = projectFinanceCommandFingerprintFor(
      targetScope,
      request as unknown as ProjectFinanceCommandFingerprintInput,
    );
    groupRequests.set(group.id, request);
    groupFingerprints.set(group.id, requestFingerprint);
    groupIds.set(group.id, projectFinanceCommandGroupIdFor(targetScope, group.idempotencyKey, requestFingerprint));
  };
  for (const group of domain.financeCommandGroups) {
    if (groupIds.has(group.id)) throw restoreFailure("Runtime domain finance command ids are duplicated.");
    if (
      group.provenance !== "legacy-result-v1"
      && group.request !== null
      && restoreString(group.request, "command") === "finance.obligation.settled"
    ) {
      settleGroups.push(group);
      continue;
    }
    remapGroupRequest(group);
  }
  domain.obligations.forEach((obligation, index) => {
    if (obligationIds.has(obligation.id)) throw restoreFailure("Runtime domain obligation ids are duplicated.");
    obligationIds.set(obligation.id, derivedId(obligation.id, /^obligation$/) ?? `obligation_restore_${token}_${index}`);
  });
  for (const group of settleGroups) {
    remapGroupRequest(group);
  }
  const ledgerIds = new Map<string, string>();
  domain.ledgerEntries.forEach((entry, index) => {
    if (ledgerIds.has(entry.id)) throw restoreFailure("Runtime domain ledger ids are duplicated.");
    ledgerIds.set(entry.id, derivedId(entry.id, /^entry(?::\d+)?$/) ?? `ledger_restore_${token}_${index}`);
  });
  const settlementIds = new Map<string, string>();
  domain.obligationSettlements.forEach((settlement, index) => {
    if (settlementIds.has(settlement.id)) throw restoreFailure("Runtime domain settlement ids are duplicated.");
    settlementIds.set(settlement.id, derivedId(settlement.id, /^settlement$/) ?? `obligation_settlement_restore_${token}_${index}`);
  });
  const budgetIds = new Map<string, string>();
  domain.budgetAllocations.forEach((budget, index) => {
    if (budgetIds.has(budget.id)) throw restoreFailure("Runtime domain budget ids are duplicated.");
    budgetIds.set(budget.id, derivedId(budget.id, /^budget$/) ?? `budget_restore_${token}_${index}`);
  });

  const fullMaps: DomainRestoreMaps = {
    recordIds, eventIds, sceneIds: shared.sceneIds,
    characterInstanceIds: shared.characterInstanceIds,
    assetDefinitionIds,
    projectIds, accountIds, milestoneIds, ledgerIds, groupIds, obligationIds, factIds,
  };

  if (new Set(factIds.values()).size !== factIds.size) throw restoreFailure("Runtime fact target ids collide.");
  const factProofs = new Map<string, { replayLineage: StoredReplayBindingV1; replayContext?: ReplayContextV1 }>();
  try {
    const sourceScope = { workspaceId: archive.manifest.scope.workspaceId,
      worldId: archive.record.scope.worldId, worldlineId: archive.record.scope.worldlineId };
    const closure = runtimeFactReplayClosure(archive.record, domain, archive.topology);
    const sourceContexts = new Map((domain.commandReplayContexts ?? []).map((context) => [context.id, context]));
    const composed = new Map<string, ReplayContextV1>();
    const contextFor = new Map<string, ReplayContextV1>();
    let native: ReplayContextV1 | undefined;
    const planned = {
      record: closure.record.map((id) => [id, remapRequired(recordIds, id, "lineage.record")]),
      event: closure.event.map((id) => [id, remapRequired(eventIds, id, "lineage.event")]),
      characterInstance: closure.characterInstance.map((id) => [id, remapRequired(shared.characterInstanceIds, id, "lineage.character")]),
      assetDefinition: closure.assetDefinition.map((id) => [id, remapRequired(assetDefinitionIds, id, "lineage.asset")]),
      scene: [], project: [], financeAccount: [], milestone: [], obligation: [],
    };
    for (const command of domain.committedFactCommands) {
      if (command.provenance !== "legacy-result-v1" || canonicalLegacyFactIds.has(command.id)) continue;
      const sourceContext = command.replayLineage
        ? sourceContexts.get(command.replayLineage.contextId)!
        : (native ??= seedFactContext(sourceScope, closure));
      let target = composed.get(sourceContext.id);
      if (!target) {
        target = composeReplayContext(sourceContext, sourceScope, closure, targetScope, planned);
        composed.set(sourceContext.id, target);
      }
      contextFor.set(command.id, target);
    }
    const anchors = new Map<string, string>();
    for (const [sourceId, context] of contextFor) {
      const targetId = factIds.get(sourceId)!;
      const current = anchors.get(context.id);
      if (!current || targetId < current) anchors.set(context.id, targetId);
    }
    for (const command of domain.committedFactCommands) {
      const context = contextFor.get(command.id);
      if (!context) continue;
      const anchorCommandId = anchors.get(context.id)!;
      factProofs.set(command.id, { replayLineage: { version: 1, contextId: context.id,
        originalRequestFingerprint: command.requestFingerprint, anchorCommandId },
      ...(factIds.get(command.id) === anchorCommandId ? { replayContext: context } : {}) });
    }
    if (Buffer.byteLength(JSON.stringify([...factProofs.values()]), "utf8") > REPLAY_LINEAGE_MAX_BYTES) {
      throw restoreFailure("Runtime fact lineage exceeds its byte budget.");
    }
  } catch { throw restoreFailure("Runtime fact lineage cannot be composed with the actual target maps."); }

  if (new Set(groupIds.values()).size !== groupIds.size) throw restoreFailure("Runtime Finance target command ids collide.");
  const financeProofs = new Map<string, { replayLineage: StoredReplayBindingV1; replayContext?: ReplayContextV1 }>();
  try {
    const eligible = domain.financeCommandGroups.filter((group) => group.provenance === "legacy-result-v1"
      && group.state === "committed" && group.policyVersion === "project-finance-command.v1");
    if (eligible.length) {
      const sourceScope = { workspaceId: archive.manifest.scope.workspaceId,
        worldId: archive.record.scope.worldId, worldlineId: archive.record.scope.worldlineId };
      const closure = runtimeFinanceReplayClosure(archive.record, domain, archive.topology);
      const sources = new Map((domain.commandReplayContexts ?? []).map((context) => [context.id, context]));
      const financeSceneIds = new Map(shared.sceneIds);
      for (const [sourceId, targets] of shared.financeFallbackSceneTargets) {
        if (!closure.scene.includes(sourceId)) continue;
        for (const targetId of targets) {
          const existing = financeSceneIds.get(sourceId);
          if (existing !== undefined && existing !== targetId) {
            throw restoreFailure("Runtime Finance fallback scene identity is ambiguous.");
          }
          financeSceneIds.set(sourceId, targetId);
        }
      }
      const planned = {
        record: closure.record.map((id) => [id, remapRequired(recordIds, id, "lineage.finance.record")]),
        scene: closure.scene.map((id) => [id, remapRequired(financeSceneIds, id, "lineage.finance.scene")]),
        project: closure.project.map((id) => [id, remapRequired(projectIds, id, "lineage.finance.project")]),
        financeAccount: closure.financeAccount.map((id) => [id, remapRequired(accountIds, id, "lineage.finance.account")]),
        milestone: closure.milestone.map((id) => [id, remapRequired(milestoneIds, id, "lineage.finance.milestone")]),
        obligation: closure.obligation.map((id) => [id, remapRequired(obligationIds, id, "lineage.finance.obligation")]),
        event: [], characterInstance: [], assetDefinition: [],
      };
      const composed = new Map<string, ReplayContextV1>();
      const contextFor = new Map<string, ReplayContextV1>();
      let native: ReplayContextV1 | undefined;
      for (const group of eligible) {
        const source = group.replayLineage ? sources.get(group.replayLineage.contextId)!
          : (native ??= seedFinanceContext(sourceScope, closure));
        let target = composed.get(source.id);
        if (!target) {
          target = composeReplayContext(source, sourceScope, closure, targetScope, planned);
          composed.set(source.id, target);
        }
        contextFor.set(group.id, target);
      }
      const anchors = new Map<string, string>();
      for (const [sourceId, context] of contextFor) {
        const targetId = groupIds.get(sourceId)!;
        const current = anchors.get(context.id);
        if (!current || targetId < current) anchors.set(context.id, targetId);
      }
      for (const group of eligible) {
        const context = contextFor.get(group.id)!;
        const anchorCommandId = anchors.get(context.id)!;
        financeProofs.set(group.id, { replayLineage: { version: 1, contextId: context.id,
          originalRequestFingerprint: group.requestFingerprint, anchorCommandId },
        ...(groupIds.get(group.id) === anchorCommandId ? { replayContext: context } : {}) });
      }
    }
    if (Buffer.byteLength(JSON.stringify([...factProofs.values(), ...financeProofs.values()]), "utf8") > REPLAY_LINEAGE_MAX_BYTES) {
      throw restoreFailure("Combined command lineage exceeds its byte budget.");
    }
  } catch { throw restoreFailure("Runtime Finance lineage cannot be composed with the actual target maps."); }

  // Story Graph definition binding: the source definition identity is
  // immutable (its hash is verified against the carried content), while the
  // target node rows bind to the hash of the REMAPPED definition whose
  // unlock rules reference target runtime identities — otherwise no target
  // milestone/settlement could ever unlock a still-locked node, and the
  // original definition would collide with the restored rows.
  const storyDefinitions = domain.storyDefinitions.map((entry) => {
    let parsed: StoryDefinition;
    try {
      parsed = normalizeStoryDefinition(entry.definition as unknown as Parameters<typeof normalizeStoryDefinition>[0]);
    } catch {
      throw restoreFailure("Runtime domain Story definition is invalid.");
    }
    if (storyDefinitionHashFor(parsed) !== entry.definitionHash) {
      throw restoreFailure("Runtime domain Story definition hash does not match its content.");
    }
    const targetStoryId = storyIds.get(entry.storyId);
    if (!targetStoryId) throw restoreFailure("Runtime domain Story definition references an unknown Story.");
    const remapped: StoryDefinition = {
      ...parsed,
      nodes: parsed.nodes.map((node) => ({
        ...node,
        unlock: remapStoryUnlockRule(
          node.unlock,
          { recordIds, milestoneIds, obligationIds },
          `storyDefinitions.${entry.storyId}.nodes.${node.nodeKey}.unlock`,
        ),
      })),
    };
    return {
      sourceStoryId: entry.storyId,
      targetStoryId,
      sourceDefinitionHash: entry.definitionHash,
      origin: entry.sourceBinding ?? {
        workspaceId: archive.manifest.scope.workspaceId,
        storyId: entry.storyId,
        definitionHash: entry.definitionHash,
      },
      definitionHash: storyDefinitionHashFor(remapped),
      definition: remapped,
    };
  });
  const targetDefinitionHashByStory = new Map(
    storyDefinitions.map((entry) => [entry.sourceStoryId, entry.definitionHash]),
  );

  // Pass 2: rewrite typed references with the complete mappings.
  const stories = domain.stories.map((story) => ({
    title: story.title,
    status: story.status,
    premise: story.premise,
    sourceId: story.id,
    targetId: storyIds.get(story.id)!,
  }));
  const projects = domain.projects.map((project) => ({
    ...project,
    sourceId: project.id,
    targetId: projectIds.get(project.id)!,
  }));
  const milestones = domain.milestones.map((milestone) => ({
    ...milestone,
    sourceId: milestone.id,
    targetId: milestoneIds.get(milestone.id)!,
    targetProjectId: remapRequired(projectIds, milestone.projectId, "milestone.projectId"),
    targetCompletionRecordId: remapNullableId(recordIds, milestone.completionRecordId, "milestone.completionRecordId"),
    targetCompletionEventId: remapNullableId(eventIds, milestone.completionEventId, "milestone.completionEventId"),
  }));
  const projectStoryLinks = domain.projectStoryLinks.map((link, index) => {
    const targetStoryId = storyIds.get(link.storyId);
    if (!targetStoryId) throw restoreFailure("Runtime domain project link references an unknown Story.");
    return {
      ...link,
      sourceId: link.id,
      targetId: `project_story_link_restore_${token}_${index}`,
      targetProjectId: remapRequired(projectIds, link.projectId, "projectStoryLink.projectId"),
      targetStoryId,
    };
  });
  const budgetAllocations = domain.budgetAllocations.map((budget) => ({
    ...budget,
    sourceId: budget.id,
    targetId: budgetIds.get(budget.id)!,
    targetProjectId: remapRequired(projectIds, budget.projectId, "budget.projectId"),
  }));
  const financeAccounts = domain.financeAccounts.map((account) => ({
    ...account,
    sourceId: account.id,
    targetId: accountIds.get(account.id)!,
  }));
  const ledgerEntries = domain.ledgerEntries.map((entry) => ({
    ...entry,
    sourceId: entry.id,
    targetId: ledgerIds.get(entry.id)!,
    targetAccountId: remapRequired(accountIds, entry.accountId, "ledger.accountId"),
    targetProjectId: remapNullableId(projectIds, entry.projectId, "ledger.projectId"),
    targetSourceRecordId: remapNullableId(recordIds, entry.sourceRecordId, "ledger.sourceRecordId"),
    targetSourceEventId: remapNullableId(eventIds, entry.sourceEventId, "ledger.sourceEventId"),
  }));
  const financeCommandGroups = domain.financeCommandGroups.map((group) => {
    const request = groupRequests.get(group.id)!;
    return {
      ...financeProofs.get(group.id),
      id: group.id,
      idempotencyKey: group.idempotencyKey,
      state: group.state,
      rejectionCode: group.rejectionCode,
      policyVersion: group.policyVersion,
      sourceId: group.id,
      targetId: groupIds.get(group.id)!,
      targetSourceRecordId: remapNullableId(recordIds, group.sourceRecordId, "financeCommandGroup.sourceRecordId"),
      provenance: group.provenance,
      request,
      requestFingerprint: groupFingerprints.get(group.id)!,
      resultManifest: group.state === "committed" && inputDomain.stories===undefined && group.policyVersion==="project-finance:v1"
        ? remapCanonicalFinanceManifest(group.resultManifest,fullMaps)
        : group.state === "committed" ? remapFinanceManifest(
          group.provenance === "legacy-result-v1"
            ? { command: inferLegacyFinanceCommand(group.resultManifest, `financeCommandGroups.${group.id}.resultManifest`) }
            : request!,
          group.resultManifest,
          fullMaps,
          targetScope,
          `financeCommandGroups.${group.id}.resultManifest`,
        )
        : group.resultManifest,
    };
  });
  for (const group of financeCommandGroups) {
    if (Buffer.byteLength(JSON.stringify({ provenance: group.provenance, result: group.resultManifest, request: group.request,
      replayLineage: group.replayLineage, replayContext: group.replayContext }), "utf8") > REPLAY_LINEAGE_MAX_BYTES) {
      throw restoreFailure("Runtime Finance receipt exceeds its byte budget.");
    }
  }
  const obligations = domain.obligations.map((obligation) => ({
    ...obligation,
    sourceId: obligation.id,
    targetId: obligationIds.get(obligation.id)!,
    targetProjectId: remapNullableId(projectIds, obligation.projectId, "obligation.projectId"),
  }));
  const obligationSettlements = domain.obligationSettlements.map((settlement) => ({
    ...settlement,
    sourceId: settlement.id,
    targetId: settlementIds.get(settlement.id)!,
    targetObligationId: remapRequired(obligationIds, settlement.obligationId, "obligationSettlement.obligationId"),
    targetLedgerEntryId: remapNullableId(ledgerIds, settlement.ledgerEntryId, "obligationSettlement.ledgerEntryId"),
  }));
  const storyNodes = domain.storyNodes.map((node) => {
    const targetId = nodeIds.get(node.id)!;
    const targetStoryId = storyIds.get(node.storyId)!;
    const definitionHash = targetDefinitionHashByStory.get(node.storyId) ?? (inputDomain.stories===undefined ? node.definitionHash : undefined);
    if (!definitionHash) {
      throw restoreFailure("Runtime domain Story node rows require the carried Story definition.");
    }
    return {
      nodeKey: node.nodeKey,
      state: node.state,
      revision: node.revision,
      sourceId: node.id,
      targetId,
      targetStoryId,
      definitionHash,
      targetRecordId: remapNullableId(recordIds, node.recordId, "storyNode.recordId"),
      unlockEvidenceEventIds: node.unlockEvidenceEventIds.map((id) => remapRequired(eventIds, id, "storyNode.unlockEvidenceEventIds")),
      unlockEvidence: inputDomain.stories===undefined ? remapCanonicalStoryEvidence(node.unlockEvidence,fullMaps) : remapStoryUnlockEvidenceValue(
        node.unlockEvidence,
        fullMaps,
        `storyNodes.${node.id}.unlockEvidence`,
        { locked: node.state === "locked" },
      ),
    };
  });
  const nodeBySourceId = new Map(domain.storyNodes.map((node) => [node.id, node]));
  const unlockTargetIds = new Set<string>();
  const storyUnlockLedger = domain.storyUnlockLedger.map((ledger) => {
    const sourceNode = nodeBySourceId.get(ledger.storyNodeInstanceId);
    if (!sourceNode) throw restoreFailure("Runtime domain Story unlock references an unknown node.");
    if (sourceNode.storyId !== ledger.storyId) {
      throw restoreFailure("Runtime domain Story unlock does not match its node Story.");
    }
    const targetNodeId = nodeIds.get(ledger.storyNodeInstanceId)!;
    const targetStoryId = storyIds.get(ledger.storyId)!;
    const definitionHash = targetDefinitionHashByStory.get(ledger.storyId) ?? (inputDomain.stories===undefined ? sourceNode.definitionHash : undefined);
    if(!definitionHash)throw restoreFailure("A Story unlock lacks its carried definition.");
    const evidence = inputDomain.stories===undefined ? remapCanonicalStoryEvidence(ledger.evidence,fullMaps)
      : remapStoryUnlockEvidenceValue(ledger.evidence, fullMaps, `storyUnlockLedger.${ledger.id}.evidence`);
    // Recompute the evidence hash against the remapped snapshot and the
    // remapped target definition hash so future reconcile in the target
    // derives the same identity and cannot duplicate the unlock.
    const evidenceHash = storyUnlockEvidenceHashFor({
      definitionHash,
      nodeKey: ledger.nodeKey,
      evidence: evidence as unknown as StoryUnlockEvidence,
    });
    const targetId = storyUnlockLedgerIdFor(targetNodeId, ledger.transition, evidenceHash);
    if (unlockTargetIds.has(targetId)) throw restoreFailure("Runtime domain Story unlock ids are duplicated.");
    unlockTargetIds.add(targetId);
    return {
      nodeKey: ledger.nodeKey,
      transition: ledger.transition,
      sourceId: ledger.id,
      targetId,
      targetStoryId,
      targetStoryNodeInstanceId: targetNodeId,
      idempotencyKey: storyUnlockIdempotencyKeyFor(targetNodeId, ledger.transition, evidenceHash),
      targetRecordId: remapNullableId(recordIds, ledger.recordId, "storyUnlockLedger.recordId"),
      evidenceEventIds: ledger.evidenceEventIds.map((id) => remapRequired(eventIds, id, "storyUnlockLedger.evidenceEventIds")),
      evidence,
      evidenceHash,
    };
  });
  const committedFactCommands = domain.committedFactCommands.map((command) => {
    const targetId = factIds.get(command.id)!;
    const request = factRequests.get(command.id)!;
    return {
      ...factProofs.get(command.id),
      kind: command.kind,
      idempotencyKey: command.idempotencyKey,
      sourceId: command.id,
      targetId,
      provenance: command.provenance,
      request,
      requestFingerprint: factFingerprints.get(command.id)!,
      resultManifest: canonicalLegacyFactIds.has(command.id)
        ? remapCanonicalFactManifest(command.kind,command.resultManifest,fullMaps)
        : command.provenance === "legacy-result-v1" ? remapLegacyFactManifest(command, domain.performanceAssessments, eventIds, targetId)
        : remapFactManifest(command.kind, Object.hasOwn(command.resultManifest,"performanceTransport")
          ? Object.fromEntries(Object.entries(command.resultManifest).filter(([key])=>key!=="performanceTransport")) : command.resultManifest, targetId, request!, `committedFactCommands.${command.id}.resultManifest`),
    };
  });
  for (const command of committedFactCommands) {
    if (Buffer.byteLength(JSON.stringify({ provenance: command.provenance, result: command.resultManifest,
      request: command.request, replayLineage: command.replayLineage, replayContext: command.replayContext }), "utf8") > REPLAY_LINEAGE_MAX_BYTES) {
      throw restoreFailure("Runtime fact receipt exceeds its byte budget.");
    }
  }
  const performanceAssessments = domain.performanceAssessments.map((assessment, index) => {
    const targetCommandId = remapRequired(factIds, assessment.commandId, "performanceAssessment.commandId");
    const evidenceEventIds = assessment.evidenceEventIds
      .map((id) => remapRequired(eventIds, id, "performanceAssessment.evidenceEventIds"))
      .sort((left, right) => left.localeCompare(right));
    return {
      policyVersion: assessment.policyVersion,
      score: assessment.score,
      sourceId: assessment.id,
      targetId: assessment.id === `${assessment.commandId}:assessment`
        ? `${targetCommandId}:assessment`
        : `performance_assessment_restore_${token}_${index}`,
      targetRecordId: remapRequired(recordIds, assessment.recordId, "performanceAssessment.recordId"),
      evidenceEventIds,
      targetCommandId,
      evidenceSnapshotHash: evidenceHash(evidenceEventIds),
    };
  });
  const memberRelationshipRevisions = domain.memberRelationshipRevisions.map((revision, index) => ({
    ...revision,
    sourceId: revision.id,
    targetId: `member_relationship_revision_restore_${token}_${index}`,
    targetSourceEventId: remapRequired(eventIds, revision.sourceEventId, "memberRelationshipRevision.sourceEventId"),
    targetSourceRecordId: remapRequired(recordIds, revision.sourceRecordId, "memberRelationshipRevision.sourceRecordId"),
    targetCommandId: remapRequired(factIds, revision.commandId, "memberRelationshipRevision.commandId"),
  }));
  const characterAssets = domain.characterAssets.map((asset) => ({
    ...asset,
    targetRecordId: remapRequired(recordIds, asset.recordId, "characterAsset.recordId"),
    targetCharacterInstanceId: remapRequired(shared.characterInstanceIds, asset.characterInstanceId, "characterAsset.characterInstanceId"),
  }));
  const commandMaterializations = domain.commandMaterializations ? {
    ...domain.commandMaterializations,
    rows: domain.commandMaterializations.rows.map(row => ({ ...row,
      projectId: remapRequired(projectIds, row.projectId, "commandMaterializations.projectId"),
      milestoneId: remapRequired(milestoneIds, row.milestoneId, "commandMaterializations.milestoneId"),
      storyId: remapRequired(storyIds, row.storyId, "commandMaterializations.storyId"),
      recordId: remapRequired(recordIds, row.recordId, "commandMaterializations.recordId"),
    })),
  } : undefined;
  return {
    ...(commandMaterializations ? { commandMaterializations } : {}),
    stories,
    storyDefinitions,
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
    committedFactCommands,
    performanceAssessments,
    memberRelationshipRevisions,
    characterAssets,
    eventIds,
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
  goalsDocument: RealmRuntimeSaveGoalsV1,
  token: string,
  definitions:readonly RecordGoalDefinitionVersion[],
): RestoredGoalInstance[] {
  const ids = new Set<string>();
  const goalKeys = new Set<string>();
  const rows=goalsDocument.instances.map((raw, index) => {
    const row = restoreObject(raw, `goals.instances[${index}]`);
    const sourceId = restoreString(row, "id", { nonEmpty: true });
    const goalKey = restoreString(row, "goalKey", { nonEmpty: true });
    const state = restoreString(row, "state", { nonEmpty: true });
    const policyVersion = restoreString(row, "policyVersion", { nonEmpty: true });
    const attempt=row.attempt===undefined?1:restoreInteger(row,"attempt",1);
    const attemptKey=JSON.stringify([goalKey,attempt]);
    if (ids.has(sourceId) || goalKeys.has(attemptKey) || !GOAL_STATES.has(state)) {
      throw restoreFailure("Runtime Goal instances are duplicated or have an invalid state.");
    }
    ids.add(sourceId);
    goalKeys.add(attemptKey);
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
      attempt,
      supersedesInstanceId:null as string|null,
      definitionVersion:definition?.definitionVersion ?? 0,
    };
  });
  const activeKeys=new Set<string>();
  for(const row of rows) if(row.state==='active') {if(activeKeys.has(row.goalKey)) throw restoreFailure('Goal attempts have conflicting active states.');activeKeys.add(row.goalKey);}
  const bySource=new Map(rows.map(row=>[row.sourceId,row]));
  const sourceDefinitions=(goalsDocument.definitions??[]).map(decodeRecordGoalDefinition);
  for(const [index,raw] of goalsDocument.instances.entries()) {
    const row=restoreObject(raw,`goals.instances[${index}]`);const target=rows[index];
    if(target.definitionSource!=='record') {
      const previousId=row.supersedesInstanceId;
      if(previousId!==undefined && previousId!==null) {
        if(typeof previousId!=='string') throw restoreFailure('Content Goal predecessor is invalid.');
        const previous=bySource.get(previousId);
        if(!previous || previous.definitionSource!=='content' || previous.goalKey!==target.goalKey
          || previous.attempt+1!==target.attempt || previous.state==='active') throw restoreFailure('Content Goal predecessor is missing, foreign or conflicting.');
        target.supersedesInstanceId=previous.targetId;
      } else if(target.attempt!==1) throw restoreFailure('Content Goal retry lacks its predecessor.');
      continue;
    }
    const sourceDefinition=sourceDefinitions.find(item=>item.goalKey===target.goalKey)!;
    const previousDefinition=sourceDefinitions.find(item=>item.definitionId===sourceDefinition.supersedesDefinitionId);
    const previousId=row.supersedesInstanceId;
    if((previousDefinition?.goalInstanceId ?? null)!==(previousId ?? null)) throw restoreFailure('The native Goal predecessor binding is invalid.');
    target.supersedesInstanceId=previousId===null||previousId===undefined?null:bySource.get(previousId as string)?.targetId??null;
    if(previousId && !target.supersedesInstanceId) throw restoreFailure('The native Goal predecessor is outside the saved history.');
  }
  return restoreParentOrder(rows,row=>row.targetId,row=>row.supersedesInstanceId,'Goal');
}

function normalizeAssessmentRows(
  goalsDocument: RealmRuntimeSaveGoalsV1,
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
  return goalsDocument.assessments.map((raw, index) => {
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

interface RestoredMemoryCacheEpoch {
  targetObserverContinuityId: string;
  epoch: number;
}

interface RestoredOutboxMessage {
  restoreDeliveryKind: "record-events-v1" | null;
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
  actionReceiptsDocument: RealmRuntimeSaveActionReceiptsV1 | undefined,
  characterInstanceIds: ReadonlyMap<string, string>,
  eventIds: ReadonlyMap<string, string>,
  token: string,
): RestoredActionReceipt[] {
  const receipts = actionReceiptsDocument?.receipts ?? [];
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
  characterEffectsDocument: RealmRuntimeSaveCharacterEffectsV1 | undefined,
  actionReceiptsDocument: RealmRuntimeSaveActionReceiptsV1 | undefined,
  characterInstanceIds: ReadonlyMap<string, string>,
  receipts: readonly RestoredActionReceipt[],
  token: string,
): RestoredCharacterEffect[] {
  const effects = characterEffectsDocument?.effects ?? [];
  if (effects.length > 0 && !actionReceiptsDocument) {
    throw restoreFailure("Runtime character effects require the saved action receipts.");
  }
  const receiptBySource = new Map(
    (actionReceiptsDocument?.receipts ?? []).map((receipt, index) => [
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
  observationsDocument: RealmRuntimeSaveObservationsV1 | undefined,
  characterInstanceIds: ReadonlyMap<string, string>,
  eventIds: ReadonlyMap<string, string>,
  token: string,
): RestoredObservation[] {
  const observations = observationsDocument?.observations ?? [];
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
 * MemoryV2 规范化：worldline-scoped memory 由纯解析器一次性 detached 校验后，
 * 在 restore 侧只做全局 id 重映射。只有主 Record 计划实际插入行；携带的
 * sibling Record 计划返回空数组（它们的 bundle 不携带 memory 段）。
 */
function normalizeRestoreMemoryV2(
  resolved: ResolvedRealmRuntimeSaveArchiveMemory,
  shared: RestoreSharedState,
  observationBySource: ReadonlyMap<string, string>,
  recordIdBySource: ReadonlyMap<string, string>,
  token: string,
  isPrimary: boolean,
): {
  conclusions: readonly RestoredMemoryConclusion[];
  snapshots: readonly RestoredMemorySnapshot[];
  relationshipStates: readonly RestoredRelationshipState[];
  cacheEpochs: readonly RestoredMemoryCacheEpoch[];
} {
  if (!isPrimary) {
    return { conclusions: [], snapshots: [], relationshipStates: [], cacheEpochs: [] };
  }

  const conclusionBySource = new Map<string, string>();
  for (const conclusion of resolved.conclusions) {
    if (shared.memoryConclusionIds.has(conclusion.sourceMemoryId)) {
      throw restoreFailure("Runtime memory conclusion ids are duplicated.");
    }
    const targetId = `memory_conclusion_restore_${token}_${createHash("sha256").update(conclusion.sourceMemoryId).digest("hex")}`;
    if ([...conclusionBySource.values()].includes(targetId)) throw restoreFailure("Runtime memory conclusion target ids collide.");
    shared.memoryConclusionIds.set(conclusion.sourceMemoryId, targetId);
    conclusionBySource.set(conclusion.sourceMemoryId, targetId);
  }

  const snapshotBySource = new Map<string, string>();
  for (const snapshot of resolved.snapshots) {
    if (shared.memorySnapshotIds.has(snapshot.sourceSnapshotId)) {
      throw restoreFailure("Runtime memory snapshot ids are duplicated.");
    }
    const targetId = `memory_snapshot_restore_${token}_${createHash("sha256").update(snapshot.sourceSnapshotId).digest("hex")}`;
    if ([...snapshotBySource.values()].includes(targetId)) throw restoreFailure("Runtime memory snapshot target ids collide.");
    shared.memorySnapshotIds.set(snapshot.sourceSnapshotId, targetId);
    snapshotBySource.set(snapshot.sourceSnapshotId, targetId);
  }

  const conclusionRows = new Map<string, RestoredMemoryConclusion>();
  const mapConclusion = (conclusion: typeof resolved.conclusions[number]): void => {
    const targetId = conclusionBySource.get(conclusion.sourceMemoryId);
    if (!targetId) return;
    if (shared.plannedMemoryConclusionIds.has(targetId)) return;
    const targetObserverContinuityId = shared.continuityIds.get(conclusion.sourceObserverContinuityId);
    if (!targetObserverContinuityId) {
      throw restoreFailure("Runtime memory conclusion references an unrestored observer continuity.");
    }
    const targetSourceRecordId = conclusion.sourceRecordId === null
      ? null
      : recordIdBySource.get(conclusion.sourceRecordId) ?? null;
    if (conclusion.sourceRecordId !== null && targetSourceRecordId === null) {
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
      : shared.memoryConclusionIds.get(conclusion.sourceSupersedesMemoryId) ?? null;
    if (conclusion.sourceSupersedesMemoryId !== null && targetSupersedesMemoryId === null) {
      throw restoreFailure("Runtime memory conclusion supersedes an unrestored conclusion.");
    }
    shared.plannedMemoryConclusionIds.add(targetId);
    conclusionRows.set(conclusion.sourceMemoryId, {
      targetId,
      targetObserverContinuityId,
      observedEntityKey: conclusion.observedEntityKey,
      targetSourceRecordId,
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
    });
  };

  const sourceConclusions = new Map(resolved.conclusions.map((row) => [row.sourceMemoryId, row]));
  for (const sourceMemoryId of resolved.supersedesOrder) {
    const conclusion = sourceConclusions.get(sourceMemoryId);
    if (!conclusion) continue;
    mapConclusion(conclusion);
  }
  for (const conclusion of resolved.conclusions) {
    if (!conclusionRows.has(conclusion.sourceMemoryId)) {
      mapConclusion(conclusion);
    }
  }

  const snapshots = resolved.snapshots.map((snapshot) => {
    const targetId = snapshotBySource.get(snapshot.sourceSnapshotId)!;
    const targetObserverContinuityId = shared.continuityIds.get(snapshot.sourceObserverContinuityId);
    if (!targetObserverContinuityId) {
      throw restoreFailure("Runtime memory snapshot references an unrestored observer continuity.");
    }
    const targetItemIds = snapshot.sourceItemIds.map((sourceItemId) => {
      const targetItemId = shared.memoryConclusionIds.get(sourceItemId);
      if (!targetItemId) {
        throw restoreFailure("Runtime memory snapshot references an unrestored conclusion.");
      }
      return targetItemId;
    });
    return {
      targetId,
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

  const relationshipStates: RestoredRelationshipState[] = [];
  for (const state of resolved.relationshipStates) {
    const targetObserverContinuityId = shared.continuityIds.get(state.sourceObserverContinuityId);
    if (!targetObserverContinuityId) {
      throw restoreFailure("Runtime relationship state references an unrestored observer continuity.");
    }
    const targetSourceRecordId = state.sourceRecordId === null
      ? null
      : recordIdBySource.get(state.sourceRecordId) ?? null;
    if (state.sourceRecordId !== null && targetSourceRecordId === null) {
      throw restoreFailure("Runtime relationship state references a Record outside the save.");
    }
    const targetSourceObservationId = state.sourceObservationId === null
      ? null
      : observationBySource.get(state.sourceObservationId) ?? null;
    if (state.sourceObservationId !== null && targetSourceObservationId === null) {
      throw restoreFailure("Runtime relationship state references an unrestored source observation.");
    }
    const dedupeKey = [
      targetObserverContinuityId,
      state.targetEntityKey,
      state.relationKind,
    ].join("\0");
    if (shared.relationshipStateKeys.has(dedupeKey)) {
      continue;
    }
    shared.relationshipStateKeys.add(dedupeKey);
    relationshipStates.push({
      targetObserverContinuityId,
      targetEntityKey: state.targetEntityKey,
      relationKind: state.relationKind,
      content: state.content,
      fidelity: state.fidelity,
      targetSourceRecordId,
      targetSourceObservationId,
      occurredTick: state.occurredTick,
      occurredOrdinal: state.occurredOrdinal,
      availableFromTick: state.availableFromTick,
      availableFromOrdinal: state.availableFromOrdinal,
    });
  }

  const cacheEpochs = resolved.cacheEpochs.map((epoch) => {
    const targetObserverContinuityId = shared.continuityIds.get(epoch.sourceObserverContinuityId);
    if (!targetObserverContinuityId) {
      throw restoreFailure("Runtime memory cache epoch references an unrestored observer continuity.");
    }
    return { targetObserverContinuityId, epoch: epoch.epoch };
  });

  return {
    conclusions: [...conclusionRows.values()],
    snapshots,
    relationshipStates,
    cacheEpochs,
  };
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
  outboxDocument: RealmRuntimeSaveOutboxV1 | undefined,
  eventIds: ReadonlyMap<string, string>,
  token: string,
  sourceRecordId: string,
  targetRecordId: string,
): RestoredOutboxMessage[] {
  const messages = outboxDocument?.messages ?? [];
  return messages.map((message, index) => {
    const targetEventId = message.sourceEventId === null
      ? null
      : eventIds.get(message.sourceEventId) ?? null;
    if (message.sourceEventId !== null && targetEventId === null) {
      throw restoreFailure("Runtime outbox message references an Event outside the saved Record.");
    }
    let envelope = message.envelope;
    // This topic is authored by local-record-turn-runtime. Custom topics own
    // arbitrary JSON; only the engine topic's declared anchors are identities.
    if (message.topic === 'record.events.committed') {
      // The runtime writer owns this one body slot. A present but malformed
      // wrapper must never fall back to otherwise valid outer anchors.
      const wrapped = Object.hasOwn(envelope, '__realmRuntimePayload');
      const body = wrapped
        ? restoreObject(envelope.__realmRuntimePayload, 'outbox.runtimePayload')
        : envelope;
      if (body.recordId !== sourceRecordId || !Array.isArray(body.eventIds)
        || body.eventIds.some(id => typeof id !== 'string' || !eventIds.has(id))) {
        throw restoreFailure('Runtime outbox envelope references an unknown or foreign Record/Event.');
      }
      const mappedBody = {
        ...body,
        recordId: targetRecordId,
        eventIds: body.eventIds.map(id => eventIds.get(id as string)!),
      };
      // Keep the historical flat transport shape. Its acceptance alone does
      // not establish compatibility with the wrapper-only runtime decoder.
      envelope = wrapped ? { ...envelope, __realmRuntimePayload: mappedBody } : mappedBody;
    }
    return {
      restoreDeliveryKind: message.topic === "record.events.committed" ? "record-events-v1" : null,
      targetId: `outbox_restore_${token}_${index}`,
      targetDedupeKey: `restore:${token}:${message.dedupeKey}`,
      topic: message.topic,
      envelope,
      targetEventId,
    };
  });
}

/** First-night 状态原样复制到目标 Record（每 Record 至多一条状态行）。 */
function normalizeRestoreFirstNight(
  firstNightDocument: RealmRuntimeSaveFirstNightV1 | undefined,
): RestoredFirstNight | null {
  const entry = firstNightDocument?.entry ?? null;
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
  selfPlayDocument: RealmRuntimeSaveSelfPlayV1 | undefined,
  token: string,
): RestoredSelfPlaySession[] {
  const sessions = selfPlayDocument?.sessions ?? [];
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

/** One restored Record plan: the saved Record or a carried sibling snapshot. */
interface RestoreRecordPlan {
  sourceRecordId: string;
  targetRecordId: string;
  token: string;
  /** Source Story id; null only for legacy no-domain saves (primary story). */
  sourceStoryId: string | null;
  title: string;
  status: "draft" | "active" | "closed" | "archived";
  worldVersion: string | null;
  startTick: number;
  startOrdinal: number;
  timelineKind: "primary" | "retrospection" | "merged" | "branch";
  sourceLinkedRecordId: string | null;
  sourceLastEventId: string | null;
  lastWorldTick: number | null;
  lastWorldOrdinal: number | null;
  recordDocument: RealmRuntimeSaveRecordV1;
  goalsDocument: RealmRuntimeSaveGoalsV1;
  topologyDocument: RealmRuntimeSaveTopologyV1 | undefined;
  actionReceiptsDocument: RealmRuntimeSaveActionReceiptsV1 | undefined;
  characterEffectsDocument: RealmRuntimeSaveCharacterEffectsV1 | undefined;
  observationsDocument: RealmRuntimeSaveObservationsV1 | undefined;
  memoryDocument: RealmRuntimeSaveMemory | undefined;
  outboxDocument: RealmRuntimeSaveOutboxV1 | undefined;
  firstNightDocument: RealmRuntimeSaveFirstNightV1 | undefined;
  selfPlayDocument: RealmRuntimeSaveSelfPlayV1 | undefined;
  events: RealmRuntimeSaveRestorableEvent[];
  eventTargetIds: Map<string, string>;
  topology: NormalizedRestoreTopology | null;
  definitions?: readonly RecordGoalDefinitionVersion[];
  goalReferences?: GoalReferenceMaps;
  eventPayloads?: ReadonlyMap<string,JsonValue>;
  goals: readonly RestoredGoalInstance[];
  assessments: ReturnType<typeof normalizeAssessmentRows>;
  actionReceipts: readonly RestoredActionReceipt[];
  characterEffects: readonly RestoredCharacterEffect[];
  observations: readonly RestoredObservation[];
  memoryConclusions: readonly RestoredMemoryConclusion[];
  memorySnapshots: readonly RestoredMemorySnapshot[];
  relationshipStates: readonly RestoredRelationshipState[];
  memoryCacheEpochs: readonly RestoredMemoryCacheEpoch[];
  outboxMessages: readonly RestoredOutboxMessage[];
  firstNight: RestoredFirstNight | null;
  selfPlaySessions: readonly RestoredSelfPlaySession[];
}

/**
 * Pre-transaction read-only resolution of every asset definition identity
 * the archive references (character assets and persisted inventory command
 * requests), so request remapping and fingerprint derivation can carry the
 * actual target definition identity BEFORE any target write. The engine base
 * rule pack is materialized in-transaction exactly like runtime record
 * creation; every other definition must already be installed.
 */
async function preresolveRestoreAssetDefinitions(
  client: PoolClient,
  workspaceId: string,
  targetWorldId: string,
  domain: RealmRuntimeSaveDomainV1,
): Promise<{ map: Map<string, string>; ensureBase: boolean }> {
  const requested = new Map<string, { assetKey: string | null; rulePackKey: string | null }>();
  for (const asset of domain.characterAssets) {
    const previous = requested.get(asset.assetDefinitionId);
    if (previous && (previous.assetKey !== (asset.assetKey ?? null) || previous.rulePackKey !== (asset.rulePackKey ?? null))) {
      throw restoreFailure("Runtime asset definition hints conflict.");
    }
    requested.set(asset.assetDefinitionId, {
      assetKey: asset.assetKey ?? null,
      rulePackKey: asset.rulePackKey ?? null,
    });
  }
  for (const command of domain.committedFactCommands) {
    if (
      (command.kind === "inventory_granted" || command.kind === "inventory_adjusted")
      && command.request != null
      && typeof command.request.assetDefinitionId === "string"
    ) {
      const existing = requested.get(command.request.assetDefinitionId);
      if (!existing) requested.set(command.request.assetDefinitionId, { assetKey: null, rulePackKey: null });
    }
  }
  const map = new Map<string, string>();
  let ensureBase = false;
  if (requested.size === 0) return { map, ensureBase };
  {
    for (const [sourceId, hint] of requested) {
      const direct = await client.query<{ id: string; asset_key: string; rule_pack_key: string }>(
        `SELECT id, asset_key, rule_pack_key FROM asset_definitions
         WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
        [workspaceId, targetWorldId, sourceId],
      );
      if (direct.rows[0] && ((hint.assetKey !== null && direct.rows[0].asset_key !== hint.assetKey)
        || (hint.rulePackKey !== null && direct.rows[0].rule_pack_key !== hint.rulePackKey))) throw restoreFailure("Runtime asset definition hints do not match the target.");
      let targetId = direct.rows[0]?.id;
      if (!targetId && hint.assetKey) {
        const byKey = await client.query<{ id: string; rule_pack_key: string }>(
          `SELECT id, rule_pack_key FROM asset_definitions
           WHERE workspace_id = $1 AND world_id = $2 AND asset_key = $3`,
          [workspaceId, targetWorldId, hint.assetKey],
        );
        if ((byKey.rowCount ?? 0) > 1 || (byKey.rows[0] && hint.rulePackKey !== null && byKey.rows[0].rule_pack_key !== hint.rulePackKey)) throw restoreFailure("Runtime asset definition resolution is ambiguous.");
        targetId = byKey.rows[0]?.id;
      }
      if (!targetId && hint.assetKey && hint.rulePackKey === BASE_RULE_PACK_KEY) {
        targetId = `base_asset_${hint.assetKey}_${targetWorldId.slice(-24)}`;
        ensureBase = true;
      }
      if (!targetId) {
        throw new RealmRuntimeSaveRepositoryError(
          "RESTORE_INVALID_TARGET",
          "The target World lacks a restored asset definition.",
        );
      }
      if ([...map.values()].includes(targetId)) throw restoreFailure("Runtime asset definition target ids collide.");
      map.set(sourceId, targetId);
    }
  }
  return { map, ensureBase };
}

/**
 * Typed remap of an engine event payload. Only the declared typed identity
 * fields of each engine event schema are rewritten — `project.milestone.confirmed`
 * carries the confirmed project/milestone identities (+ optional declared
 * semantic event key passthrough); every other kind keeps the generic
 * evidenceEventIds walk. Arbitrary prose is never rewritten.
 */
function remapEngineEventPayload(
  kind: string,
  payload: JsonValue,
  maps: {
    eventIds: ReadonlyMap<string, string>;
    projectIds: ReadonlyMap<string, string> | null;
    milestoneIds: ReadonlyMap<string, string> | null;
  },
): JsonValue {
  if (kind === "project.milestone.confirmed") {
    const value = restoreObject(payload, "eventPayload");
    if (Object.keys(value).length === 0) return {};
    requireRequestKeys(value, ["projectId", "milestoneId"], "eventPayload", ["semanticEventKey"]);
    if (!maps.projectIds || !maps.milestoneIds) {
      throw restoreFailure("Runtime milestone event payload is outside the saved domain.");
    }
    return {
      projectId: remapRequired(maps.projectIds, restoreString(value, "projectId"), "eventPayload.projectId"),
      milestoneId: remapRequired(maps.milestoneIds, restoreString(value, "milestoneId"), "eventPayload.milestoneId"),
      ...restoreSemanticEventKey(value, "eventPayload"),
    };
  }
  return rewriteEvidenceReferences(payload, maps.eventIds);
}

function maxWorldCursor(events: readonly { worldTick: number; worldOrdinal: number }[]): {
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
  options = { ...performanceTransportConsumerOptions(), ...options };
  return {
    async restore(input) {
      // Synchronous owned archive validation precedes every await, including
      // package checks and exact replay. No caller-owned state is read later.
      let resolvedMemory: ResolvedRealmRuntimeSaveArchiveMemory;
      let replayCommitment: string;
      let sourceBody: string;
      try {
        const manifest = parseRealmRuntimeSaveManifestV2(serializeRealmRuntimeSaveManifestV2(input.archive.manifest));
        if ((manifest.performanceWitnessesFormat || Object.hasOwn(input.archive, "performanceWitnesses")) && options.performanceWitnessesSchemaVersion !== 1) {
          throw new RealmRuntimeSaveRepositoryError("PERFORMANCE_TRANSPORT_VERSION_UNSUPPORTED", "The consumer does not support complete performance witness transport.");
        }
        resolvedMemory = resolveRealmRuntimeSaveArchiveMemory({ manifest, record: input.archive.record,
          topology: input.archive.topology, observations: input.archive.observations,
          memory: input.archive.memory, domain: input.archive.domain });
        // Direct callers supply section objects, not original ZIP bytes. Keep
        // raw-byte integrity at build/parse and commit the accepted detached
        // body separately, including direct descriptive Story provenance.
        const validationManifest = realmRuntimeSaveManifestFromData({ ...input.archive, ...manifest });
        const archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive({ ...input.archive, manifest: validationManifest }), { goalsSchemaVersion: 2 });
        // The read-only legacy codec preserves opaque inventory receipts. They
        // contain no original accepted request, so a supplied fingerprint cannot
        // authorize projecting them as playable facts. Full modern/lineage
        // receipts have already passed the source tuple validator above.
        if (archive.domain?.committedFactCommands.some(command => command.kind === "performance_assessed"
          && command.provenance === undefined && command.request === undefined
          && Object.keys(command.resultManifest).length === 2
          && Object.hasOwn(command.resultManifest,"recordId") && Object.hasOwn(command.resultManifest,"score"))) {
          throw restoreFailure("Playable performance restore requires the original accepted request proof.");
        }
        if (archive.goals.schemaVersion === 2 && options.goalsSchemaVersion !== 2) throw new RealmRuntimeSaveRepositoryError("GOAL_TRANSPORT_VERSION_UNSUPPORTED", "Goal schema version is unsupported by this consumer.");
        // Codec compatibility does not establish playable historical content.
        // V1 has no exact source tuple. Keep the input/history intact and refuse
        // before any asynchronous package lookup, replay, or target write.
        for (const goals of [archive.goals, ...(archive.domain?.records ?? []).map(r => r.bundle.goals)]) {
          if (goals.schemaVersion === 1 && goals.instances.some(raw => !raw || typeof raw !== "object" || !("definitionSource" in raw) || raw.definitionSource !== "record")) {
            throw new RealmRuntimeSaveRepositoryError("GOAL_HISTORICAL_BINDING_UNRESOLVED", "Playable Goal restore requires historical source proof.");
          }
        }
        // v1 binds every validated section plus semantic manifest fields. The
        // supplied ZIP runtimeHash is explicitly excluded: raw JSON key/row
        // permutations can have different byte hashes for the same state.
        const acceptedBody = { ...archive, manifest: { ...manifest, snapshot: {
          recordVersion: manifest.snapshot.recordVersion,
          nextRecordOrdinal: manifest.snapshot.nextRecordOrdinal,
        } } };
        sourceBody = canonicalRestoreJson(acceptedBody);
        const version = archive.performanceWitnesses ? 3 : archive.goals.schemaVersion === 2 ? 2 : 1;
        replayCommitment = `realm-save:body-v${version}:${createHash("sha256")
          .update(version === 3 ? "realm-save:body-v3:" : version === 2 ? "realm-runtime-restore-body:v2:" : "realm-runtime-restore-body:v1\0")
          .update(sourceBody).digest("hex")}`;
        input = { ...input, archive: { ...archive, manifest } };
      } catch (error) {
        if (error instanceof RealmRuntimeSaveError || error instanceof RealmRuntimeSaveDomainError) {
          throw restoreFailure(error.message);
        }
        throw error;
      }
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
      const token = input.branch ? createHash("sha256").update(`${input.workspaceId}:${input.branch.sourceRecordId}:${input.idempotencyKey}`).digest("hex").slice(0,18) : restoreIdempotencyToken(input, targetWorldId);
      const namespace = input.branch ? "branch" : "restore";
      const targetRecordId = `record_${namespace}_${token}`;
      const targetWorldlineId = `worldline_${namespace}_${token}`;
      const targetStoryId = `story_${namespace}_${token}`;
      if (input.branch && (input.branch.sourceRecordId !== input.archive.record.scope.recordId
        || input.branch.sourceWorldlineId !== input.archive.record.scope.worldlineId
        || targetWorldId !== input.archive.record.scope.worldId || (input.archive.domain?.records?.length ?? 0) !== 0)) {
        throw restoreFailure("Branch snapshot source scope is invalid.");
      }
      const shared: RestoreSharedState = {
        recordIds: new Map(),
        eventIds: new Map(),
        sceneIds: new Map(),
        financeFallbackSceneTargets: new Map(),
        visibilityPolicyIds: new Map(),
        participantIds: new Map(),
        characterInstanceIds: new Map(),
        continuityIds: new Map(),
        definitionIds: new Map(),
        definitionRepresentations: new Map(),
        charactersByContinuity: new Map(),
        instanceContinuityIds: new Map(),
        memoryConclusionIds: new Map(),
        plannedMemoryConclusionIds: new Set(),
        memorySnapshotIds: new Map(),
        plannedMemorySnapshotIds: new Set(),
        relationshipStateKeys: new Set(),
      };

      // Record plans: the saved Record plus every carried sibling Record
      // snapshot, each with its own deterministic token scope but one shared
      // cross-Record identity mapping.
      const plans: RestoreRecordPlan[] = [];
      const archive = input.archive;
      shared.recordIds.set(archive.record.scope.recordId, targetRecordId);
      plans.push({
        sourceRecordId: archive.record.scope.recordId,
        targetRecordId,
        token,
        sourceStoryId: archive.domain?.source.storyId ?? null,
        title: input.recordTitle ?? "",
        status: "active",
        worldVersion: null,
        startTick: input.branch?.fork.tick ?? 0,
        startOrdinal: input.branch?.fork.ordinal ?? 0,
        timelineKind: "primary",
        sourceLinkedRecordId: null,
        sourceLastEventId: null,
        lastWorldTick: null,
        lastWorldOrdinal: null,
        recordDocument: archive.record,
        goalsDocument: archive.goals.schemaVersion === 2 ? emptyRuntimeGoals() : archive.goals,
        topologyDocument: archive.topology,
        actionReceiptsDocument: archive.actionReceipts,
        characterEffectsDocument: archive.characterEffects,
        observationsDocument: archive.observations,
        memoryDocument: archive.memory,
        outboxDocument: archive.outbox,
        firstNightDocument: archive.firstNight,
        selfPlayDocument: archive.selfPlay,
        events: [],
        eventTargetIds: new Map(),
        topology: null,
        goals: [],
        assessments: [],
        actionReceipts: [],
        characterEffects: [],
        observations: [],
        memoryConclusions: [],
        memorySnapshots: [],
        relationshipStates: [],
        memoryCacheEpochs: [],
        outboxMessages: [],
        firstNight: null,
        selfPlaySessions: [],
      });
      (archive.domain?.records ?? []).forEach((snapshot, index) => {
        const planToken = `${token}_s${index}`;
        const planTargetRecordId = `record_${namespace}_${planToken}`;
        if (shared.recordIds.has(snapshot.recordId)) {
          throw restoreFailure("Runtime domain sibling Record ids are duplicated.");
        }
        shared.recordIds.set(snapshot.recordId, planTargetRecordId);
        plans.push({
          sourceRecordId: snapshot.recordId,
          targetRecordId: planTargetRecordId,
          token: planToken,
          sourceStoryId: snapshot.storyId,
          title: snapshot.title,
          status: snapshot.status,
          worldVersion: snapshot.worldVersion,
          startTick: snapshot.startTick,
          startOrdinal: snapshot.startOrdinal,
          timelineKind: snapshot.timelineKind,
          sourceLinkedRecordId: snapshot.linkedRecordId,
          sourceLastEventId: snapshot.lastEventId,
          lastWorldTick: snapshot.lastWorldTick,
          lastWorldOrdinal: snapshot.lastWorldOrdinal,
          recordDocument: snapshot.bundle.record,
          goalsDocument: snapshot.bundle.goals,
          topologyDocument: snapshot.bundle.topology,
          actionReceiptsDocument: snapshot.bundle.actionReceipts,
          characterEffectsDocument: snapshot.bundle.characterEffects,
          observationsDocument: snapshot.bundle.observations,
          memoryDocument: snapshot.bundle.memory,
          outboxDocument: snapshot.bundle.outbox,
          firstNightDocument: snapshot.bundle.firstNight,
          selfPlayDocument: snapshot.bundle.selfPlay,
          events: [],
          eventTargetIds: new Map(),
          topology: null,
          goals: [],
          assessments: [],
          actionReceipts: [],
          characterEffects: [],
          observations: [],
          memoryConclusions: [],
          memorySnapshots: [],
          relationshipStates: [],
          memoryCacheEpochs: [],
          outboxMessages: [],
          firstNight: null,
          selfPlaySessions: [],
        });
      });

      // Pass 1: events + topology for every plan, filling the shared maps
      // before any dependent section references them.
      for (const plan of plans) {
        plan.events = normalizeRestoreEvents(plan.recordDocument);
        plan.eventTargetIds = new Map(
          plan.events.map((event, index) => [event.eventId, `restore_event_${plan.token}_${index}`]),
        );
        for (const targetId of plan.eventTargetIds.values()) {
          if ([...shared.eventIds.values()].includes(targetId)) {
            throw restoreFailure("Runtime restored event ids collide.");
          }
        }
        for (const [sourceId, targetId] of plan.eventTargetIds) {
          if (shared.eventIds.has(sourceId)) {
            throw restoreFailure("Runtime event ids are duplicated across Records.");
          }
          shared.eventIds.set(sourceId, targetId);
        }
        plan.topology = normalizeRestoreTopology(plan.topologyDocument, plan.token, plan.events, shared);
      }
      // Character predecessors may live in an earlier Record of the same
      // continuity; resolve them against the complete shared instance map.
      for (const plan of plans) {
        for (const participant of plan.topology!.participants) {
          const character = participant.character;
          if (!character || character.sourcePredecessorInstanceId === null) continue;
          const predecessorContinuityId = shared.instanceContinuityIds.get(character.sourcePredecessorInstanceId);
          if (!predecessorContinuityId || predecessorContinuityId !== character.targetContinuityId) {
            throw restoreFailure("Runtime character predecessor is outside the saved continuity.");
          }
        }
      }
      // A Record's immediate FK may point to itself: it needs no other row
      // inserted first. Keep the saved link for final target-ID mapping below.
      // Character and Goal predecessor graphs still reject every self-cycle.
      const orderedRecordPlans=restoreParentOrder(plans,plan=>plan.sourceRecordId,
        plan=>plan.sourceLinkedRecordId===plan.sourceRecordId?null:plan.sourceLinkedRecordId,'Record');
      const charactersBySource=new Map<string,{plan:RestoreRecordPlan;character:RestoredCharacterTopology}>();
      for(const plan of plans) for(const participant of plan.topology!.participants) if(participant.character) {
        charactersBySource.set(participant.character.sourceCharacterInstanceId,{plan,character:participant.character});
      }
      const orderedCharacters=restoreParentOrder([...charactersBySource.values()],row=>row.character.sourceCharacterInstanceId,
        row=>row.character.sourcePredecessorInstanceId,'Character');
      // A sibling snapshot's declared head must agree with its carried log:
      // no stale head may point at a missing event.
      for (const plan of plans.slice(1)) {
        const lastEventId = plan.events.at(-1)?.eventId ?? null;
        if (plan.sourceLastEventId !== lastEventId) {
          throw restoreFailure("Runtime sibling Record head does not match its event log.");
        }
      }

      // Pass 2: dependent sections (goal/observation references are
      // Record-local; memory references resolve through the shared maps).
      for (const plan of plans) {
        plan.definitions = rebaseRecordGoalDefinitions({ definitions: plan.goalsDocument.definitions ?? [],
          scope: {workspaceId:input.workspaceId,worldId:targetWorldId,worldlineId:targetWorldlineId,recordId:plan.targetRecordId}, eventIds: plan.eventTargetIds });
        plan.goals = normalizeGoalInstances(plan.goalsDocument, plan.token, plan.definitions);
        const references:GoalReferenceMaps = {instances:new Map(plan.goals.map(goal => [goal.sourceId,goal.targetId])),definitions:new Map(),policies:new Map()};
        for (const raw of plan.goalsDocument.definitions ?? []) {
          const source = decodeRecordGoalDefinition(raw); const target = plan.definitions.find(definition => definition.goalKey===source.goalKey)!;
          (references.definitions as Map<string,string>).set(source.definitionId,target.definitionId); (references.policies as Map<string,string>).set(source.policyVersion,target.policyVersion);
        }
        plan.goalReferences = references;
        plan.assessments = normalizeAssessmentRows(plan.goalsDocument, plan.goals, plan.eventTargetIds, plan.token);
        plan.actionReceipts = normalizeRestoreActionReceipts(
          plan.actionReceiptsDocument,
          shared.characterInstanceIds,
          shared.eventIds,
          plan.token,
        );
        plan.characterEffects = normalizeRestoreCharacterEffects(
          plan.characterEffectsDocument,
          plan.actionReceiptsDocument,
          shared.characterInstanceIds,
          plan.actionReceipts,
          plan.token,
        );
        plan.observations = normalizeRestoreObservations(
          plan.observationsDocument,
          shared.characterInstanceIds,
          shared.eventIds,
          plan.token,
        );
      }

      const goalStoryIds = new Map<string,string>([[archive.domain?.source.storyId ?? "source-story",targetStoryId]]);
      (archive.domain?.stories ?? []).forEach((story,index) => {
        if (!goalStoryIds.has(story.id)) goalStoryIds.set(story.id,`story_restore_${token}_${index}`);
      });
      const goalRestorePlan = planGoalRestore(archive, {workspaceId:input.workspaceId,worldId:targetWorldId,
        worldlineId:targetWorldlineId,token,records:plans,storyIds:goalStoryIds});
      const primaryPlan = plans[0]!;
      const warnings: readonly ["WORLD_VERSION_MISMATCH"] | readonly [] = [];

      const observationBySource = new Map<string, string>();
      for (const plan of plans) {
        const sourceObservations = plan.observationsDocument?.observations ?? [];
        for (const [index, sourceObservation] of sourceObservations.entries()) {
          const targetObservation = plan.observations[index];
          if (targetObservation) {
            observationBySource.set(sourceObservation.sourceObservationId, targetObservation.targetId);
          }
        }
      }

      const memoryPlan = normalizeRestoreMemoryV2(resolvedMemory, shared,
        observationBySource, shared.recordIds, token, true);
      primaryPlan.memoryConclusions = memoryPlan.conclusions;
      primaryPlan.memorySnapshots = memoryPlan.snapshots;
      primaryPlan.relationshipStates = memoryPlan.relationshipStates;
      primaryPlan.memoryCacheEpochs = memoryPlan.cacheEpochs;
      for (const plan of plans) {
        plan.outboxMessages = normalizeRestoreOutbox(plan.outboxDocument, plan.eventTargetIds, plan.token, plan.sourceRecordId, plan.targetRecordId);
        plan.firstNight = normalizeRestoreFirstNight(plan.firstNightDocument);
        plan.selfPlaySessions = normalizeRestoreSelfPlay(plan.selfPlayDocument, plan.token);
      }

      const restoredGoalsV2 = goalRestorePlan
        ? await resolveGoalRestore(goalRestorePlan,input.workspaceId,options.resolveGoalSource ?? createDefaultGoalContentBindingSource()) : null;
      const materializations = input.archive.domain?.commandMaterializations;
      if (materializations) {
        if (!options.resolveCommandPolicy) throw new RealmRuntimeSaveRepositoryError("REALMWORLD_VALIDATION_UNAVAILABLE", "Command policy verification is not configured.");
        const binding = input.archive.manifest.world;
        if (!binding || binding.worldId !== targetWorldId || materializations.worldVersion !== binding.worldVersion) throw restoreFailure("Command policy package identity is invalid.");
        try {
          const resolved = await options.resolveCommandPolicy(binding);
          if (!resolved || resolved.worldId !== binding.worldId) throw restoreFailure("Command policy is unavailable.");
          validateCommandMaterializations(materializations, resolved);
        } catch { throw new RealmRuntimeSaveRepositoryError("REALMWORLD_PACKAGE_UNTRUSTED", "Command policy verification failed."); }
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
      if (restoredGoalsV2) for (const plan of plans) {
        // Both V2 wire Goals and proven legacy authored history use the same
        // verified writer. Do not also INSERT the old legacy projections.
        plan.goals = [];
        plan.definitions = restoredGoalsV2.definitions.filter(d => d.scope.recordId===plan.targetRecordId);
        const root = restoredGoalsV2.roots.find(r => r.owner.scopeKind==='record' && r.owner.recordId===plan.targetRecordId);
        const sourceRoot = goalRestorePlan!.source.roots.find(r => r.owner.scopeKind==='record' && r.owner.recordId===plan.sourceRecordId);
        const instances = new Map<string,string>(); const definitions = new Map<string,string>(); const policies = new Map<string,string>();
        for (const mapping of goalRestorePlan!.mappings) if(mapping.source.owner.scopeKind==='record' && mapping.source.owner.recordId===plan.sourceRecordId) {
          if(mapping.entityKind==='instance') instances.set(mapping.source.id,mapping.target.id);
          if(mapping.entityKind==='definition') definitions.set(mapping.source.id,mapping.target.id);
        }
        for(const g of sourceRoot?.instances ?? []) {
          const target = root!.instances.find(t => t.ref.instanceId===instances.get(g.ref.instanceId))!;
          if (policies.has(g.policyVersion) && policies.get(g.policyVersion)!==target.policyVersion) throw restoreFailure("Goal policy identity is ambiguous.");
          policies.set(g.policyVersion,target.policyVersion);
        }
        plan.goalReferences={instances,definitions,policies};
        plan.assessments=restoredGoalsV2.assessments.filter(a => a.goal.owner.scopeKind==='record' && a.goal.owner.recordId===plan.targetRecordId).map(a => ({
          id:a.id,goalInstanceId:a.goal.instanceId,sourceEventId:a.sourceEvent.eventId,source:a.source,status:a.status,result:a.result,
          evidenceEventIds:a.evidenceEvents.map(e => e.eventId),evidenceHeadVersion:a.evidenceHead?.recordVersion ?? null,
          evidenceHeadOrdinal:a.evidenceHead?.ordinal ?? null,evidenceSnapshotHash:a.evidenceSnapshotHash,policyVersion:a.policyVersion}));
      }
      const goalGroupV2 = restoredGoalsV2 || archive.performanceWitnesses ? {operation:namespace,worldlineId:targetWorldlineId,
        stories:[...goalStoryIds].map(([sourceStoryId,storyId])=>({sourceStoryId,storyId})),
        records:plans.map(plan=>({sourceRecordId:plan.sourceRecordId,recordId:plan.targetRecordId,
          storyId:plan.sourceStoryId===null?targetStoryId:goalStoryIds.get(plan.sourceStoryId),status:plan.status,definitions:plan.definitions ?? []})),
        ...(input.branch?{source:{recordId:input.branch.sourceRecordId,recordVersion:archive.record.head.recordVersion,nextRecordOrdinal:archive.record.head.nextRecordOrdinal}}:{}),
        bodyVersion:archive.performanceWitnesses ? 3 : 2,sourceBody,goals:restoredGoalsV2,mappings:goalRestorePlan?.mappings ?? [],
        ...(archive.performanceWitnesses ? {performanceWitnesses:null} : {})} : null;
      return withWorkspaceTransaction(database, input.workspaceId, async (client) => {
        const worldResult = await client.query<{
          world_version: string;
          status: string;
          settings: unknown;
        }>(
          `SELECT world_version, status, settings
           FROM worlds
           WHERE workspace_id = $1 AND id = $2
           ${archive.performanceWitnesses || restoredGoalsV2 || plans.some(plan => (plan.definitions?.length ?? 0) > 0) || input.branch ? "FOR UPDATE" : "FOR KEY SHARE"}`,
          [input.workspaceId, targetWorldId],
        );
        const world = worldResult.rows[0];
        if (!world) {
          throw new RealmRuntimeSaveRepositoryError("WORLD_NOT_FOUND", "World not found.");
        }
        if (world.status === "archived") {
          throw new RealmRuntimeSaveRepositoryError("WORLD_ARCHIVED", "World is archived.");
        }
        // Authorization precedes every target-content validation so an
        // unauthorized principal can never distinguish target state
        // (WORLD_NOT_FOUND), including via asset/semantic-key failures.
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
        if ((archive.performanceWitnesses || restoredGoalsV2 || plans.some(plan => (plan.definitions?.length ?? 0) > 0) || input.branch) && (role !== "owner" || !input.sessionProof)) {
          throw new RealmRuntimeSaveRepositoryError("WORLD_READ_ONLY", "Native Goal restoration requires an owner session proof.");
        }
        if (archive.performanceWitnesses && !await hasPerformanceRestoreTarget(client)) {
          throw new RealmRuntimeSaveRepositoryError("PERFORMANCE_TRANSPORT_TARGET_UNSUPPORTED", "The target does not support complete performance transport.");
        }
        if (restoredGoalsV2 && !await hasGoalRestoreTarget(client)) {
          throw new RealmRuntimeSaveRepositoryError("GOAL_TRANSPORT_TARGET_UNSUPPORTED", "The target does not support complete Goal transport.");
        }
        if (materializations && !await hasCommandMaterializationsSchema(client)) {
          throw restoreFailure("The target schema cannot restore command materializations.");
        }
        // Asset definitions resolve BEFORE request fingerprints are derived,
        // inside the write transaction so the rechecked identities below can
        // never drift from this resolution.
        const assetResolution = archive.domain
          ? await preresolveRestoreAssetDefinitions(
            client,
            input.workspaceId,
            targetWorldId,
            archive.domain,
          )
          : { map: new Map<string, string>(), ensureBase: false };
        const domain = normalizeRestoreDomain(
          archive,
          token,
          input.workspaceId,
          targetWorldId,
          targetWorldlineId,
          shared,
          assetResolution.map,
        );
        const payloadMaps = {
          eventIds:shared.eventIds,
          projectIds:domain?new Map(domain.projects.map(row=>[row.sourceId,row.targetId])):null,
          milestoneIds:domain?new Map(domain.milestones.map(row=>[row.sourceId,row.targetId])):null,
        };
        for(const plan of plans) {
          // The shared bijection includes carried siblings. Qualify references
          // with this Record's topology rather than borrowing their anchors.
          const localParticipantIds:ReadonlyMap<string,string>=new Map(plan.topology!.participants.map(participant=>
            [participant.sourceParticipantId,participant.targetParticipantId]));
          plan.eventPayloads=new Map(plan.events.map(event=>{
            const enginePayload=remapEngineEventPayload(event.kind,event.eventPayload,payloadMaps);
            const rewritten=event.kind==='goal.transition.committed'?rewriteGoalReferences(enginePayload,plan.goalReferences!,plan.eventTargetIds):enginePayload;
            const participantPayload=event.kind==='utterance.committed' || event.kind==='narration.committed'
              ?rewriteParticipantReferences(rewritten,localParticipantIds):rewritten;
            const payloadObject=restoreObject(participantPayload,"event.payload");
            const body=restoreObject(payloadObject.__realmRuntimePayload ?? payloadObject,"event.runtimePayload");
            let payload:JsonValue=payloadObject;
            if(body.narrativeState!==undefined) {
              if(event.kind!=="narration.committed" || body.role!=="narrator") throw restoreFailure("Narrative restore authority is invalid.");
              const original=restoreObject(event.eventPayload,"event.original");
              const originalBody=restoreObject(original.__realmRuntimePayload ?? original,"event.originalRuntimePayload");
              const state=rebaseNarrativeState({state:originalBody.narrativeState,
                sourceScope:{workspaceId:archive.manifest.scope.workspaceId,...plan.recordDocument.scope},
                targetScope:{workspaceId:input.workspaceId,worldId:targetWorldId,worldlineId:targetWorldlineId,recordId:plan.targetRecordId},eventIds:plan.eventTargetIds});
              const nextBody={...body,narrativeState:state as unknown as JsonValue};
              payload=payloadObject.__realmRuntimePayload?{...payloadObject,__realmRuntimePayload:nextBody}:nextBody;
            }
            return [event.eventId,payload];
          }));
        }
        if(restoredGoalsV2) {
          finalizeGoalRestoreEvidence(restoredGoalsV2,goalRestorePlan!,plans.flatMap(plan=>plan.events.map(event=>({
            eventId:plan.eventTargetIds.get(event.eventId)!,recordId:plan.targetRecordId,recordVersion:event.recordVersion,
            ordinal:event.ordinal,kind:event.kind,payload:plan.eventPayloads!.get(event.eventId)!}))));
          for(const plan of plans) plan.assessments=plan.assessments.map(a=>{
            const target=restoredGoalsV2.assessments.find(t=>t.id===a.id)!;
            return {...a,result:target.result,evidenceSnapshotHash:target.evidenceSnapshotHash};
          });
        }
        let restoredPerformance: RuntimePerformanceWitnessesV1 | undefined;
        if (archive.performanceWitnesses) {
          if (!domain || !goalGroupV2) throw restoreFailure("Performance domain is incomplete.");
          const pairs = (rows: readonly {sourceId:string;targetId:string}[]) => new Map(rows.map(r=>[r.sourceId,r.targetId]));
          const maps = new Map<PerformanceWitnessIdentityKind,ReadonlyMap<string,string>>([
            ["record",shared.recordIds],["story",new Map([[archive.domain!.source.storyId,targetStoryId],...domain.stories.map(r=>[r.sourceId,r.targetId] as const)])],
            ["command",pairs(domain.committedFactCommands)],["assessment",pairs(domain.performanceAssessments)],
            ["event",shared.eventIds],["scene",shared.sceneIds],["policy",shared.visibilityPolicyIds],
            ["project",pairs(domain.projects)],["milestone",pairs(domain.milestones)]
          ]);
          restoredPerformance={format:"realm-runtime-performance-witnesses",schemaVersion:1,
            witnesses:archive.performanceWitnesses.witnesses.map(e=>projectPerformanceWitness(e,{workspaceId:input.workspaceId,worldId:targetWorldId,worldlineId:targetWorldlineId},maps))};
          for (const e of restoredPerformance.witnesses) {
            const c=domain.committedFactCommands.find(c=>c.targetId===e.projection.commandId);
            const a=domain.performanceAssessments.find(a=>a.targetId===e.projection.assessmentId);
            if(!c || !a || canonicalRestoreJson(c.request)!==canonicalRestoreJson(e.projection.request)
              || c.requestFingerprint!==e.projection.requestFingerprint || canonicalRestoreJson(c.resultManifest)!==canonicalRestoreJson(e.projection.result)
              || a.targetRecordId!==e.projection.recordId || a.targetCommandId!==c.targetId || a.score!==e.projection.assessment.score
              || canonicalRestoreJson(a.evidenceEventIds)!==canonicalRestoreJson(e.projection.assessment.evidenceEventIds)
              || a.evidenceSnapshotHash!==e.projection.assessment.evidenceSnapshotHash) throw restoreFailure("Performance materialization tuple does not match.");
          }
          Object.assign(goalGroupV2,{performanceWitnesses:restoredPerformance,
            legacyGoals:restoredGoalsV2 ? null : plans.map(p=>({recordId:p.targetRecordId,goals:p.goals,assessments:p.assessments}))});
        }
        // Finance's existing schema also limits each JSONB text envelope to 65,536 bytes.
        // Check PostgreSQL's actual encoding before any definition or worldline write.
        for (const group of domain?.financeCommandGroups ?? []) {
          const size = await client.query<{ bytes: number }>(
            `SELECT octet_length($1::jsonb::text) AS bytes`, [JSON.stringify(financeRestoreReceiptManifest(group))],
          );
          if (size.rows[0]!.bytes > 65_536) throw restoreFailure("Runtime Finance receipt exceeds the existing database row byte limit.");
        }
        // Restored command requests keep their World-declared semantic event
        // keys; the target World must declare every one of them (same
        // authorization the command store enforces at live commit time).
        if (domain) {
          const declaredEvents = declaredSemanticEventsFromWorldSettings(world.settings);
          const semanticKeys = new Set<string>();
          for (const group of domain.financeCommandGroups) {
            const key = group.request?.semanticEventKey;
            if (typeof key === "string") semanticKeys.add(key);
          }
          for (const key of semanticKeys) {
            if (!declaredEvents.has(key)) {
              throw new RealmRuntimeSaveRepositoryError(
                "RESTORE_INVALID_TARGET",
                "The target World does not declare a restored semantic event key.",
              );
            }
          }
        }
        if (input.archive.manifest.mode === "base" && !input.branch && world.world_version !== LOCAL_WORLD_VERSION) {
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

        const importedCounts = {
          importedEventCount: plans.reduce((count, plan) => count + plan.events.length, 0),
          importedGoalInstanceCount: restoredGoalsV2 ? restoredGoalsV2.roots.reduce((n,r)=>n+r.instances.length,0) : plans.reduce((count, plan) => count + plan.goals.length, 0),
          importedAssessmentCount: plans.reduce((count, plan) => count + plan.assessments.length, 0),
          importedActionReceiptCount: plans.reduce((count, plan) => count + plan.actionReceipts.length, 0),
          importedCharacterEffectCount: plans.reduce((count, plan) => count + plan.characterEffects.length, 0),
          importedObservationCount: plans.reduce((count, plan) => count + plan.observations.length, 0),
          importedMemoryConclusionCount: plans.reduce((count, plan) => count + plan.memoryConclusions.length, 0),
          importedMemorySnapshotCount: plans.reduce((count, plan) => count + plan.memorySnapshots.length, 0),
          importedRelationshipStateCount: plans.reduce((count, plan) => count + plan.relationshipStates.length, 0),
          importedOutboxMessageCount: plans.reduce((count, plan) => count + plan.outboxMessages.length, 0),
          importedFirstNightCount: plans.filter((plan) => plan.firstNight !== null).length,
          importedSelfPlaySessionCount: plans.reduce((count, plan) => count + plan.selfPlaySessions.length, 0),
          importedDomainProjectCount: domain?.projects.length ?? 0,
          importedDomainLedgerEntryCount: domain?.ledgerEntries.length ?? 0,
          importedDomainStoryNodeCount: domain?.storyNodes.length ?? 0,
          importedDomainUnlockCount: domain?.storyUnlockLedger.length ?? 0,
          importedDomainFactCommandCount: domain?.committedFactCommands.length ?? 0,
          importedDomainAssessmentCount: domain?.performanceAssessments.length ?? 0,
          importedDomainRelationshipRevisionCount: domain?.memberRelationshipRevisions.length ?? 0,
          importedDomainAssetCount: domain?.characterAssets.length ?? 0,
          importedDomainStoryCount: domain?.stories.length ?? 0,
          importedDomainRecordCount: plans.length - 1,
        };
        const storyDefinitionsResult = domain && domain.storyDefinitions.length > 0
          ? domain.storyDefinitions.map((entry) => ({
            storyId: entry.targetStoryId,
            definitionHash: entry.definitionHash,
            definition: entry.definition,
          }))
          : undefined;

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
          if (goalGroupV2) {
            if ((!input.branch && row.story_premise !== replayCommitment)
              || (input.branch && row.story_premise !== input.branch.premise)) {
              throw new RealmRuntimeSaveRepositoryError("RESTORE_CONFLICT", "Restore group does not match.");
            }
            const replay = await client.query<{actor:string}>(archive.performanceWitnesses ? "SELECT record_goal_restore_group_replay_v3($1,$2,$3,$4,$5,$6::jsonb) AS actor" : "SELECT record_goal_restore_group_replay_v2($1,$2,$3,$4,$5,$6::jsonb) AS actor",
              [input.workspaceId,input.sessionProof,targetWorldId,targetRecordId,replayCommitment.slice("realm-save:body-v2:".length),JSON.stringify(goalGroupV2)]);
            if(replay.rows[0]?.actor!==input.principalId) throw new RealmRuntimeSaveRepositoryError("RESTORE_CONFLICT","Restore group does not match.");
          } else if (input.branch) {
            const admitted = await client.query<{ actor: string }>(
              "SELECT record_goal_restore_branch_replay($1,$2,$3,$4,$5,$6,$7,$8,$9) AS actor",
              [input.workspaceId,input.sessionProof,targetWorldId,targetRecordId,
                replayCommitment.slice("realm-save:body-v1:".length),input.branch.sourceRecordId,
                input.branch.sourceWorldlineId,input.branch.fork.tick,input.branch.fork.ordinal]);
            if (row.story_premise !== input.branch.premise || admitted.rows[0]?.actor !== input.principalId) {
              throw new RealmRuntimeSaveRepositoryError("RESTORE_CONFLICT", "Branch body commitment does not match.");
            }
          } else {
            if (!/^realm-save:body-v1:[0-9a-f]{64}$/.test(row.story_premise)) {
              throw new RealmRuntimeSaveRepositoryError("RESTORE_CONFLICT", "Existing restore lacks a supported validated-body commitment; use a new idempotency key.");
            }
            if (row.story_premise !== replayCommitment) {
              throw new RealmRuntimeSaveRepositoryError("RESTORE_CONFLICT", "The restore idempotency key is already bound to another archive.");
            }
          }
          if (restoredPerformance) await verifyPerformanceTransport(client,restoredPerformance);
          return {
            worldId: targetWorldId,
            worldVersion: world.world_version,
            worldlineId: targetWorldlineId,
            storyId: targetStoryId,
            recordId: targetRecordId,
            ...importedCounts,
            ...(storyDefinitionsResult ? { storyDefinitions: storyDefinitionsResult } : {}),
            warnings: effectiveWarnings,
            replayed: true,
          };
        }

        // Fail closed before any target write: every restored character
        // effect must resolve its rule definition (by effect_key) inside the
        // target World — definitions are World-scoped rule data, never
        // carried by or installed from a runtime save.
        const effectDefinitionIds = new Map<string, string>();
        for (const plan of plans) {
          for (const effect of plan.characterEffects) {
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
        }

        // Fresh restores require the marker schema even when no outbox is present.
        // Keep this inside the authorized transaction and before any potential write.
        try {
          await client.query("SELECT restore_delivery_kind FROM public.outbox WHERE false", []);
        } catch (error) {
          if (typeof error === "object" && error !== null && "code" in error && error.code === "42703") {
            throw restoreFailure("Runtime restore requires the Outbox delivery schema.");
          }
          throw error;
        }

        // Asset definitions: materialize the engine-owned base pack on demand
        // (exactly like runtime record creation) and recheck every
        // pre-resolved target identity inside the write transaction.
        if (assetResolution.ensureBase) {
          const worldStyle = await readWorldStyle(client, {
            workspaceId: input.workspaceId,
            worldId: targetWorldId,
          });
          await ensureWorldBaseRuleDefinitions(
            client,
            { workspaceId: input.workspaceId, worldId: targetWorldId },
            worldStyle,
          );
        }
        if (assetResolution.map.size > 0) {
          const resolved = await client.query<{ id: string }>(
            `SELECT id FROM asset_definitions
             WHERE workspace_id = $1 AND world_id = $2 AND id = ANY($3::text[])`,
            [input.workspaceId, targetWorldId, [...assetResolution.map.values()]],
          );
          if (resolved.rows.length !== new Set(assetResolution.map.values()).size) {
            throw new RealmRuntimeSaveRepositoryError(
              "RESTORE_INVALID_TARGET",
              "The target World lacks a restored asset definition.",
            );
          }
        }

        const cursor = maxWorldCursor([
          ...plans.flatMap((plan) => plan.events),
          ...plans.flatMap((plan) => (
            plan.lastWorldTick !== null && plan.lastWorldOrdinal !== null
              ? [{ worldTick: plan.lastWorldTick, worldOrdinal: plan.lastWorldOrdinal }]
              : []
          )),
          ...(resolvedMemory?.worldlineHead
            ? [{ worldTick: resolvedMemory.worldlineHead.tick, worldOrdinal: resolvedMemory.worldlineHead.ordinal }]
            : []),
        ]);
        let nativePlanCommitment: string | undefined;
        if (goalGroupV2) {
          const admitted = await client.query<{admission:{actor:string;planCommitment:string}}>(
            archive.performanceWitnesses ? "SELECT record_goal_restore_group_prepare_v3($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission" : "SELECT record_goal_restore_group_prepare_v2($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission",
            [input.workspaceId,input.sessionProof,targetWorldId,targetRecordId,archive.manifest.snapshot.runtimeHash,
              replayCommitment.slice("realm-save:body-v2:".length),JSON.stringify(goalGroupV2)]);
          if(admitted.rows[0]?.admission.actor!==input.principalId) throw restoreFailure("Restore proof actor does not match.");
          nativePlanCommitment=admitted.rows[0].admission.planCommitment;
        } else if (plans.some(plan => (plan.definitions?.length ?? 0)>0) || input.branch) {
          const stories = [{sourceStoryId:archive.domain?.source.storyId ?? "source-story",storyId:targetStoryId},
            ...(domain?.stories ?? []).filter(story => story.targetId!==targetStoryId).map(story => ({sourceStoryId:story.sourceId,storyId:story.targetId}))];
          const storyIds = new Map(stories.map(story => [story.sourceStoryId,story.storyId]));
          const group = {operation:namespace,worldlineId:targetWorldlineId,stories,
            records:plans.map(plan => ({sourceRecordId:plan.sourceRecordId,recordId:plan.targetRecordId,
              storyId:plan.sourceStoryId===null?targetStoryId:storyIds.get(plan.sourceStoryId),status:plan.status,definitions:plan.definitions ?? []})),
            ...(input.branch?{source:{recordId:input.branch.sourceRecordId,recordVersion:archive.record.head.recordVersion}}:{}),
          };
          const admitted = await client.query<{admission:{actor:string;planCommitment:string}}>(
            "SELECT record_goal_restore_group_prepare($1,$2,$3,$4,$5,$6,$7::jsonb) AS admission",
            [input.workspaceId,input.sessionProof,targetWorldId,targetRecordId,archive.manifest.snapshot.runtimeHash,
              replayCommitment.slice("realm-save:body-v1:".length),JSON.stringify(group)]);
          if (admitted.rows[0]?.admission.actor!==input.principalId) throw restoreFailure("Restore proof actor does not match.");
          nativePlanCommitment=admitted.rows[0].admission.planCommitment;
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
            input.branch?.premise ?? replayCommitment,
          ],
        );
        // Every other carried Story of the worldline keeps its source
        // title/status/premise; logical Story ownership is never collapsed.
        for (const story of domain?.stories ?? []) {
          if (story.targetId === targetStoryId) continue;
          await client.query(
            `INSERT INTO stories (
               workspace_id, world_id, worldline_id, id, title, status,
               premise, start_tick, start_ordinal
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              story.targetId,
              restoreTitle(story.title, "Restored story"),
              story.status,
              story.premise,
            ],
          );
        }
        // Persist the remapped authoritative Story definition bindings in
        // the SAME transaction as the Story/node writes so a later reader,
        // reconcile, or continuation path (even in a fresh process) resolves
        // definitions server-side without retaining restore result objects.
        // Source identity is immutable provenance, never client input.
        for (const entry of domain?.storyDefinitions ?? []) {
          await client.query(
            `INSERT INTO story_definition_bindings (
               workspace_id, world_id, worldline_id, story_id,
               definition_hash, definition, origin,
               source_workspace_id, source_story_id, source_definition_hash
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'restore', $7, $8, $9)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              entry.targetStoryId,
              entry.definitionHash,
              JSON.stringify(entry.definition),
              entry.origin.workspaceId,
              entry.origin.storyId,
              entry.origin.definitionHash,
            ],
          );
        }
        const storyTargetIds = new Map(
          (domain?.stories ?? []).map((story) => [story.sourceId, story.targetId]),
        );
        const storyIdForPlan = (plan: RestoreRecordPlan): string => {
          if (plan.sourceStoryId === null) return targetStoryId;
          const mapped = storyTargetIds.get(plan.sourceStoryId);
          if (!mapped) throw restoreFailure("Runtime Record plan references an unknown Story.");
          return mapped;
        };
        // Phase 4D：恢复出的 Record 绑定=存档 manifest 记录的制作版本
        //（base 存档=哨兵；world-bound=存档版本），绝不取目标世界当前值。
        // Slice 5 升级路径例外：base→world-bound 显式升级绑定事务内锁定
        // 复核过的目标 World 版本（upgradeTargetBinding）。
        const restoredWorldVersion = input.archive.manifest.world?.worldVersion
          ?? upgradeTargetBinding?.worldVersion
          ?? LOCAL_WORLD_VERSION;
        const insertedDefinitionIds = new Set<string>();
        const insertedContinuityIds = new Set<string>();

        for (const plan of orderedRecordPlans) {
          await client.query(
            `INSERT INTO records (
               workspace_id, world_id, worldline_id, story_id, id, title,
               status, start_tick, start_ordinal, timeline_kind, linked_record_id,
               world_version
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $12, $11)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              storyIdForPlan(plan),
              plan.targetRecordId,
              plan.title !== ""
                ? restoreTitle(plan.title, "Restored Record")
                : restoreTitle(undefined, plan === primaryPlan ? "Restored Record" : "Restored sibling Record"),
              plan.status,
              plan.startTick,
              plan.startOrdinal,
              plan === primaryPlan && input.branch ? "branch" : plan.timelineKind,
              plan.worldVersion ?? restoredWorldVersion,
              plan === primaryPlan && input.branch ? input.branch.sourceRecordId
                : plan.sourceLinkedRecordId===null?null:shared.recordIds.get(plan.sourceLinkedRecordId),
            ],
          );
        }
        for (const {plan,character} of orderedCharacters) {
            if (!insertedDefinitionIds.has(character.targetDefinitionId)) {
              insertedDefinitionIds.add(character.targetDefinitionId);
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
            }
            if (!insertedContinuityIds.has(character.targetContinuityId)) {
              insertedContinuityIds.add(character.targetContinuityId);
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
            }
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
                plan.targetRecordId,
                character.targetContinuityId,
                character.sourcePredecessorInstanceId === null
                  ? null
                  : shared.characterInstanceIds.get(character.sourcePredecessorInstanceId)!,
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
        for (const plan of plans) {
          const topology=plan.topology!;
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
                plan.targetRecordId,
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
                plan.targetRecordId,
                `participant_restore_${plan.token}`,
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
                plan.targetRecordId,
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
                plan.targetRecordId,
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
        }
        for (const plan of plans) {
          const batchByVersion = new Map<number, number>();
          for (const event of plan.events) {
            const batchIndex = batchByVersion.get(event.recordVersion) ?? 0;
            batchByVersion.set(event.recordVersion, batchIndex + 1);
            const targetEventId = plan.eventTargetIds.get(event.eventId)!;
            const targetActorParticipantId = event.sourceActorParticipantId === null
              ? null
              : shared.participantIds.get(event.sourceActorParticipantId);
            if (event.sourceActorParticipantId !== null && !targetActorParticipantId) {
              throw restoreFailure("Runtime event actor is outside the saved participant topology.");
            }
            const targetSceneId = shared.sceneIds.get(event.sourceSceneId);
            const targetVisibilityPolicyId = shared.visibilityPolicyIds.get(event.sourceVisibilityPolicyId);
            if (!targetSceneId || !targetVisibilityPolicyId) {
              throw restoreFailure("Runtime event topology mapping is incomplete.");
            }
            const rewritten=plan.eventPayloads!.get(event.eventId)!;
            const payload=rewritten;
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
                plan.targetRecordId,
                targetSceneId,
                targetEventId,
                event.recordVersion,
                event.ordinal,
                batchIndex,
                event.kind,
                targetActorParticipantId ?? null,
                event.speakerName,
                event.content,
                JSON.stringify(payload),
                targetVisibilityPolicyId,
                event.worldTick,
                event.worldOrdinal,
                event.calendarId,
                event.displayTime,
              ],
            );
          }
          const lastEvent = plan.events.at(-1);
          const planCursor = maxWorldCursor(plan.events);
          await client.query(
            `INSERT INTO record_heads (
               workspace_id, world_id, worldline_id, record_id,
               record_version, next_record_ordinal, last_event_id,
               last_world_tick, last_world_ordinal
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              input.workspaceId,
              targetWorldId,
              targetWorldlineId,
              plan.targetRecordId,
              plan.recordDocument.head.recordVersion,
              plan.recordDocument.head.nextRecordOrdinal,
              lastEvent ? plan.eventTargetIds.get(lastEvent.eventId)! : null,
              plan === primaryPlan ? planCursor?.tick ?? null : plan.lastWorldTick,
              plan === primaryPlan ? planCursor?.ordinal ?? null : plan.lastWorldOrdinal,
            ],
          );

        }
        if (restoredGoalsV2) {
          for (const plan of plans) if(plan.definitions?.length) await client.query("SELECT record_goal_restore_group_definitions($1,$2,$3,$4,$5,$6::jsonb)",
            [input.workspaceId,input.sessionProof,plan.targetRecordId,replayCommitment.slice("realm-save:body-v2:".length),nativePlanCommitment,JSON.stringify(plan.definitions)]);
          await writeRestoredGoalsV2(client,{goals:restoredGoalsV2,sessionProof:input.sessionProof!,root:targetRecordId,
            bodyCommitment:replayCommitment.slice("realm-save:body-v2:".length),principalId:input.principalId,bodyVersion:archive.performanceWitnesses ? 3 : 2});
        }
        for (const plan of plans) {
          if(plan.events.some(event=>{const payload=restoreObject(event.eventPayload,"event.payload");return restoreObject(payload.__realmRuntimePayload ?? payload,"event.runtimePayload").narrativeState!==undefined;})) {
            await rebuildRecordNarrativeState(client,{workspaceId:input.workspaceId,worldId:targetWorldId,worldlineId:targetWorldlineId,recordId:plan.targetRecordId});
          }
          if(!restoredGoalsV2 && plan.definitions?.length) await client.query("SELECT record_goal_restore_group_definitions($1,$2,$3,$4,$5,$6::jsonb)",
            [input.workspaceId,input.sessionProof,plan.targetRecordId,replayCommitment.slice("realm-save:body-v1:".length),nativePlanCommitment,JSON.stringify(plan.definitions)]);
          for (const goal of plan.goals) {
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
                plan.targetRecordId,
                goal.targetId,
                goal.goalKey,
                goal.state,
                goal.revision,
                JSON.stringify(goal.progress),
                goal.outcome === null ? null : JSON.stringify(goal.outcome),
                goal.policyVersion,
                goal.definitionSource,goal.definitionId,goal.resolutionKind,goal.evidenceStartVersion,goal.evidenceStartOrdinal,goal.attempt,goal.supersedesInstanceId,
              ],
            );
          }
          for (const assessment of plan.assessments) {
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
                plan.targetRecordId,
                assessment.id,
                assessment.goalInstanceId,
                assessment.sourceEventId,
                assessment.source,
                assessment.status,
                JSON.stringify(assessment.result),
                [...assessment.evidenceEventIds],
                assessment.evidenceHeadVersion,
                assessment.evidenceHeadOrdinal,
                assessment.evidenceSnapshotHash,
                assessment.policyVersion,
              ],
            );
          }
          for (const receipt of plan.actionReceipts) {
            await client.query(
              `INSERT INTO action_receipts (
                 workspace_id, world_id, worldline_id, record_id, id,
                 transaction_id, call_fingerprint, actor_character_instance_id,
                 source_event_id, receipt, world_tick, world_ordinal, recorded_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                plan.targetRecordId,
                receipt.targetId,
                receipt.transactionId,
                receipt.callFingerprint,
                receipt.targetActorCharacterInstanceId,
                receipt.targetSourceEventId,
                JSON.stringify(receipt.receipt),
                receipt.worldTick,
                receipt.worldOrdinal,
                receipt.recordedAt,
              ],
            );
          }
          for (const effect of plan.characterEffects) {
            // realm_runtime 的 INSERT 列授权不含 ended 游标：先按授权列插入，
            // 同事务内用 UPDATE 补写 ended 游标（UPDATE 列授权覆盖）。
            await client.query(
              `INSERT INTO character_effects (
                 workspace_id, world_id, worldline_id, record_id, id,
                 character_instance_id, effect_definition_id, source_action_receipt_id,
                 status, applied_tick, applied_ordinal, revision, metadata
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                plan.targetRecordId,
                effect.targetId,
                effect.targetCharacterInstanceId,
                effectDefinitionIds.get(effect.effectKey)!,
                effect.targetActionReceiptId,
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
                  plan.targetRecordId,
                  effect.endedTick,
                  effect.endedOrdinal,
                ],
              );
            }
          }
          for (const observation of plan.observations) {
            await client.query(
              `INSERT INTO observations (
                 workspace_id, world_id, worldline_id, record_id, id,
                 observer_character_instance_id, source_event_id, dedupe_key,
                 observation_kind, content, fidelity, occurred_tick, occurred_ordinal,
                 available_from_tick, available_from_ordinal, learned_at, metadata
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb)`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                plan.targetRecordId,
                observation.targetId,
                observation.targetObserverCharacterInstanceId,
                observation.targetSourceEventId,
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


          // Outbox 消息落 fresh pending：lease/fencing token、attempt_count、
          // 失败细节一律不复制，available_at 取恢复时刻，等待独立 worker 重新
          // claim；dedupe_key 以 restore 前缀命名空间化并保留原键后缀。
          for (const message of plan.outboxMessages) {
            await client.query(
              `INSERT INTO outbox (
                 workspace_id, world_id, worldline_id, record_id,
                 event_id, turn_run_id, id, dedupe_key, topic, payload,
                 state, revision, attempt_count, available_at, created_at, updated_at,
                 restore_delivery_kind
               ) VALUES (
                 $1, $2, $3, $4, $5, NULL, $6, $7, $8, $9::jsonb,
                 'pending', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $10
               )`,
              [
                input.workspaceId,
                targetWorldId,
                targetWorldlineId,
                plan.targetRecordId,
                message.targetEventId,
                message.targetId,
                message.targetDedupeKey,
                message.topic,
                JSON.stringify(message.envelope),
                message.restoreDeliveryKind,
              ],
            );
          }
          if (plan.firstNight) {
            await client.query(
              `INSERT INTO record_first_nights (
                 workspace_id, record_id, world_id, state, attempts,
                 hook_content, suggestions, context
               ) VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8::jsonb)`,
              [
                input.workspaceId,
                plan.targetRecordId,
                targetWorldId,
                plan.firstNight.state,
                plan.firstNight.attempts,
                plan.firstNight.hookContent,
                [...plan.firstNight.suggestions],
                JSON.stringify(plan.firstNight.context),
              ],
            );
          }
          for (const session of plan.selfPlaySessions) {
            await client.query(
              `INSERT INTO record_self_play_sessions (
                 workspace_id, id, record_id, world_id, state,
                 beat_budget, beats_completed, requested_by, last_error
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
              [
                input.workspaceId,
                session.targetId,
                plan.targetRecordId,
                targetWorldId,
                session.state,
                session.beatBudget,
                session.beatsCompleted,
                session.requestedBy,
                session.lastError,
              ],
            );
          }
        }

        // Deferred V2 memory writes: observations for every Record (including
        // sibling-carried Records) must exist before any conclusion or state
        // that references an observation through source_observation_id.
        {
          for (const plan of plans) {
            for (const conclusion of plan.memoryConclusions) {
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
            for (const snapshot of plan.memorySnapshots) {
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
            for (const state of plan.relationshipStates) {
              await client.query(
                `INSERT INTO relationship_states (
                  workspace_id, world_id, worldline_id, observer_continuity_id,
                  target_entity_key, relation_kind, content, fidelity,
                  source_record_id, source_observation_id,
                  occurred_tick, occurred_ordinal,
                  available_from_tick, available_from_ordinal
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
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
            for (const epoch of plan.memoryCacheEpochs) {
              await client.query(
                `INSERT INTO memory_cache_epochs (
                  workspace_id, observer_continuity_id, epoch, updated_at
                ) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
`,
                [input.workspaceId, epoch.targetObserverContinuityId, epoch.epoch],
              );
            }          }
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
                JSON.stringify(financeRestoreReceiptManifest(group)),
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
                node.targetStoryId,
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
                unlock.targetStoryId,
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
                JSON.stringify(
                  command.provenance === "legacy-result-v1"
                    ? { provenance: "legacy-result-v1", result: command.resultManifest, request: null,
                        replayLineage: command.replayLineage, ...(command.replayContext ? { replayContext: command.replayContext } : {}) }
                    : { result: command.resultManifest, request: command.request,
                        ...(restoredPerformance?.witnesses.find(e=>e.projection.commandId===command.targetId)
                          ? {performanceTransport:{version:1,digest:restoredPerformance.witnesses.find(e=>e.projection.commandId===command.targetId)!.digest}} : {}) },
                ),
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
          const restoredAssetKeys = new Set<string>();
          for (const asset of domain.characterAssets) {
            // Pre-resolved before any request fingerprint was derived and
            // rechecked inside this transaction.
            const targetDefinitionId = assetResolution.map.get(asset.assetDefinitionId);
            if (!targetDefinitionId) {
              throw new RealmRuntimeSaveRepositoryError(
                "RESTORE_INVALID_TARGET",
                "The target World lacks a restored asset definition.",
              );
            }
            const assetPrimaryKey = `${asset.targetRecordId}\0${asset.targetCharacterInstanceId}\0${targetDefinitionId}`;
            if (restoredAssetKeys.has(assetPrimaryKey)) {
              throw restoreFailure("Runtime save domain.characterAssets contains duplicate restored identities.");
            }
            restoredAssetKeys.add(assetPrimaryKey);
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
                targetDefinitionId,
                asset.quantity,
                asset.revision,
                JSON.stringify(asset.metadata),
              ],
            );
          }
        }

        if (restoredPerformance) await writePerformanceTransport(client,restoredPerformance);
        if (domain?.commandMaterializations) await insertCommandMaterializations(client,
          { workspaceId: input.workspaceId, worldId: targetWorldId, worldlineId: targetWorldlineId }, domain.commandMaterializations);

        return {
          worldId: targetWorldId,
          worldVersion: world.world_version,
          worldlineId: targetWorldlineId,
          storyId: targetStoryId,
          recordId: targetRecordId,
          ...importedCounts,
          ...(storyDefinitionsResult ? { storyDefinitions: storyDefinitionsResult } : {}),
          warnings: effectiveWarnings,
          replayed: false,
        };
      });
    },
  };
}
