import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalGoalJson, goalOwnerKey, type GoalOwner } from "../../modules/goals/content-binding.ts";
import { decodeRecordGoalDefinition, rebaseRecordGoalDefinitions } from "../../modules/goals/record-authoring.ts";
import { goalEvidenceSnapshotHash, type GoalDefinition, type GoalEvent } from "../../modules/goals/public.ts";
import { verifyGoalContentBinding, type GoalContentSourceResolver } from "../../modules/application/goal-content-binding-source.ts";
import { decodeRealmRuntimeSaveGoalsV2, goalInstancesParentFirst, goalTypedIdentityKey,
  remapRealmRuntimeSaveGoalsV2, type GoalIdentityMapping, type RealmRuntimeSaveGoalsV2 } from "../../modules/world-transfer/realm-runtime-goals-v2.ts";
import type { RealmRuntimeSaveArchive, RealmRuntimeSaveGoals, RealmRuntimeSaveRecordV1 } from "../../modules/world-transfer/realm-runtime-save.ts";
import { normalizeRealmRuntimeSaveEventForRestore } from "../../modules/world-transfer/realm-runtime-save.ts";
import { GOAL_TRANSPORT_CAPABILITY_SQL } from "./runtime-goal-binding-reader.ts";
import { bindGoalContentWrites } from "./goal-content-binding-repository.ts";

// Catalog only: a partial installation must fail before projecting any new table.
export const GOAL_RESTORE_TARGET_CAPABILITY_SQL = `SELECT (${GOAL_TRANSPORT_CAPABILITY_SQL})
  AND NOT EXISTS (SELECT 1 FROM (VALUES
    ('record_goal_restore_group_prepare_v2(text,text,text,text,text,text,jsonb)'),
    ('record_goal_restore_group_replay_v2(text,text,text,text,text,jsonb)'),
    ('record_goal_restore_group_definitions(text,text,text,text,text,jsonb)'),
    ('goal_restore_v2_complete(text,text)')
  ) required(signature) WHERE to_regprocedure('public.'||signature) IS NULL)
  AND NOT EXISTS (SELECT 1 FROM (VALUES
    ('goal_instances',ARRAY['completed_at']),
    ('goal_content_write_admissions',ARRAY['world_id','worldline_id','scope_kind','record_id','story_id','principal_id','operation']),
    ('record_goal_definitions',ARRAY['world_id','worldline_id','id','goal_id','definition_version','goal_key','policy_version','supersedes_definition_id','created_by_principal_id']),
    ('record_goal_restore_admissions',ARRAY['workspace_id','world_id','worldline_id','record_id','principal_id','archive_hash','transaction_id','group_root','operation','body_commitment','plan_commitment','group_plan','source_record_id','target_story_id','target_status']),
    ('goal_assessments',ARRAY['workspace_id','world_id','worldline_id','record_id','id','goal_instance_id','assessment_job_id','source_event_id','source','status','result','evidence_event_ids','evidence_head_version','evidence_head_ordinal','evidence_snapshot_hash','policy_version'])
  ) required(table_name,columns) WHERE to_regclass('public.'||table_name) IS NULL
    OR EXISTS(SELECT 1 FROM unnest(required.columns) column_name WHERE NOT EXISTS(
      SELECT 1 FROM pg_catalog.pg_attribute attribute WHERE attribute.attrelid=to_regclass('public.'||required.table_name)
        AND attribute.attname=column_name AND attribute.attnum>0 AND NOT attribute.attisdropped))) AS available`;
export async function hasGoalRestoreTarget(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ available: boolean }>(GOAL_RESTORE_TARGET_CAPABILITY_SQL);
  return result.rows.length === 1 && result.rows[0].available === true;
}

export interface GoalRestoreRecord {
  sourceRecordId: string; targetRecordId: string; recordDocument: RealmRuntimeSaveRecordV1;
  eventTargetIds: ReadonlyMap<string, string>;
}
export interface GoalRestorePlan {
  source: RealmRuntimeSaveGoalsV2;
  mappings: readonly GoalIdentityMapping[];
  records: readonly GoalRestoreRecord[];
  contentDefinitions: Map<string, GoalDefinition>;
}
/** A representation of the carried record-authored history, not a content
 * lookup or an invented source hash. The shared remapper verifies each original
 * assessment hash against these immutable definitions and carried events before
 * producing any target hash. Unbound legacy content never enters this path. */
function legacyAuthoredGoalSource(archive: RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>): RealmRuntimeSaveGoalsV2 | null {
  if (!archive.performanceWitnesses || archive.goals.schemaVersion !== 1) return null;
  const saved = [{ record: archive.record, goals: archive.goals }, ...(archive.domain?.records ?? []).map(r => r.bundle)];
  if (saved.every(r => r.goals.instances.length === 0 && r.goals.assessments.length === 0 && !r.goals.definitions?.length)) return null;
  const roots = saved.map(({ record, goals }) => {
    const owner: GoalOwner = { scopeKind: "record", ...record.scope };
    const definitions = new Map((goals.definitions ?? []).map(decodeRecordGoalDefinition).map(d => [d.definitionId, d]));
    return { owner, instances: goals.instances.map(raw => {
      const g = raw as Record<string, unknown>;
      const definition = definitions.get(g.definitionId as string);
      if (g.definitionSource !== "record" || !definition || definition.goalInstanceId !== g.id) {
        throw new Error("Playable legacy Goal restore requires the exact record-authored definition.");
      }
      return { ref: { owner, instanceId: g.id }, definition: { kind: "record", definitionId: definition.definitionId,
        goalId: definition.goalId, definitionVersion: definition.definitionVersion }, goalKey: g.goalKey, policyVersion: g.policyVersion,
        state: g.state, revision: g.revision, progress: g.progress, outcome: g.outcome, attempt: g.attempt ?? 1,
        predecessor: g.supersedesInstanceId == null ? null : { kind: "definition-revision", ref: { owner, instanceId: g.supersedesInstanceId } },
        resolutionKind: g.resolutionKind, evidenceStart: { recordVersion: g.evidenceStartVersion, ordinal: g.evidenceStartOrdinal } };
    }) };
  }).filter(root => root.instances.length > 0);
  const assessments = saved.flatMap(({ record, goals }) => goals.assessments.map(raw => {
    const a = raw as Record<string, unknown>;
    const owner: GoalOwner = { scopeKind: "record", ...record.scope };
    return { id: a.id, goal: { owner, instanceId: a.goalInstanceId }, sourceEvent: { ...record.scope, eventId: a.sourceEventId },
      source: a.source, status: a.status, result: a.result, evidenceEvents: (a.evidenceEventIds as string[]).map(eventId => ({ ...record.scope, eventId })),
      evidenceHead: a.evidenceHead ?? null, evidenceSnapshotHash: a.evidenceSnapshotHash, policyVersion: a.policyVersion };
  }));
  return decodeRealmRuntimeSaveGoalsV2({ format: "realm-runtime-goals", schemaVersion: 2,
    workspaceId: archive.manifest.scope.workspaceId, roots, definitions: saved.flatMap(r => r.goals.definitions ?? []), assessments });
}
/** Synchronous, detached identity and event preflight, before any source await. */
export function planGoalRestore(archive: RealmRuntimeSaveArchive<RealmRuntimeSaveGoals>, input: {
  workspaceId: string; worldId: string; worldlineId: string; token: string;
  records: readonly GoalRestoreRecord[]; storyIds: ReadonlyMap<string, string>;
}): GoalRestorePlan | null {
  const source = archive.goals.schemaVersion === 2 ? decodeRealmRuntimeSaveGoalsV2(archive.goals) : legacyAuthoredGoalSource(archive);
  if (!source) return null;
  const mappings: GoalIdentityMapping[] = [];
  const add = (entityKind: GoalIdentityMapping["entityKind"], owner: GoalOwner, id: string, targetOwner: GoalOwner, targetId: string) => {
    mappings.push({ entityKind, source: { workspaceId: source.workspaceId, owner, id },
      target: { workspaceId: input.workspaceId, owner: targetOwner, id: targetId } });
  };
  const sourceLine: GoalOwner = { scopeKind: "worldline", worldId: archive.record.scope.worldId, worldlineId: archive.record.scope.worldlineId };
  const targetLine: GoalOwner = { scopeKind: "worldline", worldId: input.worldId, worldlineId: input.worldlineId };
  add("worldline", sourceLine, sourceLine.worldlineId, targetLine, input.worldlineId);
  for (const [sourceId, targetId] of input.storyIds) {
    add("story", { ...sourceLine, scopeKind: "story", storyId: sourceId }, sourceId,
      { ...targetLine, scopeKind: "story", storyId: targetId }, targetId);
  }
  for (const record of input.records) {
    const owner: GoalOwner = { ...sourceLine, scopeKind: "record", recordId: record.sourceRecordId };
    const target: GoalOwner = { ...targetLine, scopeKind: "record", recordId: record.targetRecordId };
    add("record", owner, record.sourceRecordId, target, record.targetRecordId);
    for (const [id, targetId] of record.eventTargetIds) add("event", owner, id, target, targetId);
    const definitions = source.definitions.filter(d => d.scope.recordId === record.sourceRecordId);
    const rebased = rebaseRecordGoalDefinitions({ definitions, scope: { workspaceId: input.workspaceId,
      worldId: input.worldId, worldlineId: input.worldlineId, recordId: record.targetRecordId }, eventIds: record.eventTargetIds });
    for (const d of definitions) {
      const t = rebased.find(t => t.goalId === d.goalId && t.definitionVersion === d.definitionVersion)!;
      add("definition", owner, d.definitionId, target, t.definitionId);
      add("instance", owner, d.goalInstanceId, target, t.goalInstanceId);
    }
  }
  const targetOwner = (owner: GoalOwner): GoalOwner => {
    if (owner.scopeKind === "worldline") return targetLine;
    const match = mappings.find(m => m.entityKind === owner.scopeKind && goalOwnerKey(m.source.owner) === goalOwnerKey(owner));
    if (!match) throw new Error("Goal owner is outside the validated restore topology.");
    return match.target.owner;
  };
  for (const g of goalInstancesParentFirst(source)) if (g.definition.kind === "content") {
    const identity = { workspaceId: source.workspaceId, owner: g.ref.owner, id: g.ref.instanceId };
    const id = createHash("sha256").update(input.token).update(goalTypedIdentityKey("instance", identity)).digest("hex").slice(0, 32);
    add("instance", g.ref.owner, g.ref.instanceId, targetOwner(g.ref.owner), `goal_restore_${id}`);
  }
  for (const a of source.assessments) {
    const record = input.records.find(r => a.sourceEvent.recordId === r.sourceRecordId);
    if (!record || !record.eventTargetIds.has(a.sourceEvent.eventId)
      || a.evidenceEvents.some(e => !record.eventTargetIds.has(e.eventId))) throw new Error("Goal evidence is outside the saved Record.");
    const id = createHash("sha256").update(input.token).update(goalTypedIdentityKey("assessment", {
      workspaceId: source.workspaceId, owner: a.goal.owner, id: a.id })).digest("hex").slice(0, 32);
    add("assessment", a.goal.owner, a.id, targetOwner(a.goal.owner), `assessment_restore_${id}`);
  }
  return { source, mappings, records: input.records, contentDefinitions: new Map() };
}

/** Exact installed/base source verification precedes replay and every target write. */
export async function resolveGoalRestore(plan: GoalRestorePlan, workspaceId: string,
  resolve: GoalContentSourceResolver): Promise<RealmRuntimeSaveGoalsV2> {
  const definitions = new Map<string, GoalDefinition>();
  for (const root of plan.source.roots) for (const g of root.instances) if (g.definition.kind === "content") {
    const witness = await verifyGoalContentBinding(g.definition.binding, resolve);
    plan.contentDefinitions.set(g.definition.binding.definitionHash,witness.definition);
    definitions.set(goalTypedIdentityKey("instance", { workspaceId: plan.source.workspaceId, owner: g.ref.owner, id: g.ref.instanceId }), witness.definition);
  }
  decodeRealmRuntimeSaveGoalsV2(plan.source, { contentDefinition: b => definitions.get(goalTypedIdentityKey("instance", {
    workspaceId: b.workspaceId, owner: b.owner, id: b.instanceId }))! });
  return remapRealmRuntimeSaveGoalsV2(plan.source, { workspaceId, mappings: plan.mappings,
    assessmentEvidence: (assessment, goal) => {
      const record = plan.records.find(r => r.sourceRecordId === assessment.sourceEvent.recordId)!;
      const definition = goal.definition.kind === "record"
        ? plan.source.definitions.find(d => goal.definition.kind === "record" && d.definitionId === goal.definition.definitionId)!
        : definitions.get(goalTypedIdentityKey("instance", { workspaceId: plan.source.workspaceId, owner: goal.ref.owner, id: goal.ref.instanceId }))!;
      const events: GoalEvent[] = record.recordDocument.events.map(e => ({ eventId: e.eventId,
        recordId: record.sourceRecordId, recordVersion: e.recordVersion, ordinal: e.ordinal, kind: e.kind,
        payload: normalizeRealmRuntimeSaveEventForRestore(e).eventPayload }));
      return { definition, events };
    } });
}

/** Source tuples were verified by remap before any target query. Now commit the
 * exact payloads the existing engine/Character/command remappers will INSERT. */
export function finalizeGoalRestoreEvidence(goals: RealmRuntimeSaveGoalsV2, plan: GoalRestorePlan,
  events: readonly GoalEvent[]): void {
  const all=goalInstancesParentFirst(goals);
  for(const a of goals.assessments) {
    const g=all.find(g=>g.ref.instanceId===a.goal.instanceId)!;
    if(g.ref.owner.scopeKind!=="record") throw new Error("Unsupported assessment owner.");
    const definition=g.definition.kind==="record"?goals.definitions.find(d=>g.definition.kind==="record" && d.definitionId===g.definition.definitionId)!
      :plan.contentDefinitions.get(g.definition.binding.definitionHash)!;
    const evidence=a.evidenceEvents.map(ref=>{
      const selected=events.filter(e=>e.recordId===ref.recordId && e.eventId===ref.eventId);
      if(selected.length!==1)throw new Error("Target Goal evidence is incomplete.");return selected[0];
    });
    const hash=goalEvidenceSnapshotHash({definition,instance:{...g,goalInstanceId:g.ref.instanceId,recordId:g.ref.owner.recordId},events:evidence,evidenceHead:a.evidenceHead});
    a.evidenceSnapshotHash=hash;
    if(Object.hasOwn(a.result,"evidenceSnapshotHash")) a.result={...a.result,evidenceSnapshotHash:hash};
  }
}

export const INSERT_RESTORED_GOAL_V2_SQL = `INSERT INTO goal_instances (
  workspace_id,world_id,worldline_id,scope_kind,record_id,story_id,id,goal_key,state,revision,progress,outcome,
  policy_version,completed_at,definition_source,definition_id,resolution_kind,evidence_start_version,evidence_start_ordinal,attempt,supersedes_instance_id
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,
  CASE WHEN $9='active' THEN NULL ELSE CURRENT_TIMESTAMP END,$14,$15,$16,$17,$18,$19,$20)`;
export async function insertRestoredGoalsV2(client: PoolClient, goals: RealmRuntimeSaveGoalsV2): Promise<void> {
  for (const g of goalInstancesParentFirst(goals)) {
    const o = g.ref.owner;
    await client.query(INSERT_RESTORED_GOAL_V2_SQL, [goals.workspaceId,o.worldId,o.worldlineId,o.scopeKind,
      o.scopeKind === "record" ? o.recordId : null,o.scopeKind === "story" ? o.storyId : null,g.ref.instanceId,g.goalKey,
      g.state,g.revision,JSON.stringify(g.progress),g.outcome === null ? null : JSON.stringify(g.outcome),g.policyVersion,
      g.definition.kind,g.definition.kind === "record" ? g.definition.definitionId : null,g.resolutionKind,
      g.evidenceStart?.recordVersion ?? 0,g.evidenceStart?.ordinal ?? 0,g.attempt,g.predecessor?.ref.instanceId ?? null]);
  }
}

export async function writeRestoredGoalsV2(client: PoolClient, input: {
  goals: RealmRuntimeSaveGoalsV2; sessionProof: string; root: string; bodyCommitment: string; principalId: string;
  bodyVersion?: 2 | 3;
}): Promise<void> {
  const all = goalInstancesParentFirst(input.goals);
  const bindings = all.flatMap(g => g.definition.kind === "content" ? [g.definition.binding] : []);
  // Only immutable binding metadata is batched. The full body/group commitment
  // and global DAG remain one transaction; opaque Goal documents retain 64 MiB.
  const batches = [];
  for (let offset=0;offset<bindings.length;offset+=100) {
    const batch=bindings.slice(offset,offset+100);
    const owner = batch[0].owner;
    const operation = input.bodyVersion === 3 ? "restore-v3" : "restore-v2";
    const plan = { operation, worldId: owner.worldId, worldlineId: owner.worldlineId,
      instances: batch.map(b => ({ instanceId: b.instanceId, owner: b.owner, goalKey: b.goalKey,
        policyVersion: b.policyVersion, definitionHash: b.definitionHash, source: b.source,
        predecessor: all.find(g => g.ref.instanceId === b.instanceId)!.predecessor?.ref.instanceId ?? null })),
      source: null, restoreGroupRoot: input.root };
    const result = await client.query<{ admission: { actor: string; planCommitment: string } }>(
      input.bodyVersion === 3 ? "SELECT goal_content_write_prepare_v3($1,$2,$3,$4,$5::jsonb) AS admission" : "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission",
      [input.goals.workspaceId,input.sessionProof,operation,input.bodyCommitment,canonicalGoalJson(plan)]);
    if (result.rows[0]?.admission.actor !== input.principalId
      || !/^[0-9a-f]{64}$/.test(result.rows[0].admission.planCommitment)) throw new Error("Goal content group admission failed.");
    batches.push({bindings:batch,planCommitment:result.rows[0].admission.planCommitment});
  }
  await insertRestoredGoalsV2(client, input.goals);
  for(const batch of batches) await bindGoalContentWrites(client, { workspaceId: input.goals.workspaceId,
    sessionProof: input.sessionProof, bodyCommitment: input.bodyCommitment, ...batch });
}
