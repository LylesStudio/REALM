import type { PoolClient } from "pg";
import { RuntimeInvariantError } from "../../modules/runtime/public.ts";
import type { GoalDefinition } from "../../modules/goals/public.ts";
import { goalOwnerKey, type GoalOwner } from "../../modules/goals/content-binding.ts";
import { decodeRecordGoalDefinition } from "../../modules/goals/record-authoring.ts";
import { verifyGoalContentBinding, type GoalContentSourceResolver } from "../../modules/application/goal-content-binding-source.ts";
import { decodeRealmRuntimeSaveGoalsV2, serializeRealmRuntimeSaveGoalsV2,
  type GoalInstanceV2, type RealmRuntimeSaveGoalsV2 } from "../../modules/world-transfer/realm-runtime-goals-v2.ts";
import type { RealmRuntimeSaveGoals, RealmRuntimeSaveGoalsV1, RealmRuntimeSaveRecordV1 } from "../../modules/world-transfer/realm-runtime-save.ts";
import { loadGoalContentBinding } from "./goal-content-binding-repository.ts";

// Catalog-only: safe even when 0083 is absent or only partially installed.
// Installation, a persisted binding, and source trust are three separate gates.
export const GOAL_TRANSPORT_CAPABILITY_SQL = `SELECT
  to_regprocedure('public.goal_content_write_prepare(text,text,text,text,jsonb)') IS NOT NULL
  AND to_regprocedure('public.goal_content_write_bind(text,text,text,text,jsonb)') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('goal_content_instance_bindings',ARRAY['workspace_id','world_id','worldline_id','record_id','story_id','scope_kind','goal_instance_id','binding_version','normalization','goal_key','policy_version','definition_hash','source_kind','source_world_id','source_world_version','package_content_hash','base_revision','base_content_hash']),
      ('goal_instances',ARRAY['workspace_id','world_id','worldline_id','record_id','story_id','scope_kind','id','goal_key','state','revision','progress','outcome','policy_version','definition_source','definition_id','resolution_kind','evidence_start_version','evidence_start_ordinal','attempt','supersedes_instance_id']),
      ('goal_content_write_admissions',ARRAY['workspace_id','goal_instance_id','transaction_id','body_commitment','plan_commitment','plan']),
      ('record_goal_definitions',ARRAY['workspace_id','record_id','definition'])
    ) AS required(table_name,columns)
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class relation
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relname=required.table_name AND relation.relkind='r')
      OR EXISTS (SELECT 1 FROM unnest(required.columns) AS column_name
        WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute attribute
          WHERE attribute.attrelid=to_regclass('public.'||required.table_name)
            AND attribute.attname=column_name AND attribute.attnum>0 AND NOT attribute.attisdropped))
  ) AS available`;

export async function hasGoalTransportSchema(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ available: boolean }>(GOAL_TRANSPORT_CAPABILITY_SQL);
  return result.rows.length === 1 && result.rows[0].available === true;
}

export const LOAD_TRANSPORT_GOALS_SQL = `SELECT id,scope_kind,record_id,story_id,goal_key,state,revision,
  progress,outcome,policy_version,definition_source,definition_id,resolution_kind,
  evidence_start_version,evidence_start_ordinal,attempt,supersedes_instance_id
  FROM goal_instances WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3
    AND ((scope_kind='worldline' AND record_id IS NULL AND story_id IS NULL)
      OR (scope_kind='story' AND record_id IS NULL AND story_id=ANY($4::text[]))
      OR (scope_kind='record' AND record_id=ANY($5::text[]) AND story_id IS NULL))
  ORDER BY scope_kind,story_id,id`;

export const emptyRuntimeGoals = (): RealmRuntimeSaveGoalsV1 => ({
  format: "realm-runtime-goals", schemaVersion: 1, instances: [], assessments: [],
});
function unresolved(): never {
  throw new RuntimeInvariantError("GOAL_HISTORICAL_BINDING_UNRESOLVED", "Runtime Goal export requires its exact historical source binding.");
}
type SavedRecordGoals = { record: RealmRuntimeSaveRecordV1; goals: RealmRuntimeSaveGoalsV1 };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) unresolved();
  return value as Record<string, unknown>;
}

/** Called inside the actual authorized repeatable-read reader transaction.
 * Only the owners already admitted to that archive are projected. No sibling
 * discovery, current-key fallback, pool, or transaction is hidden here. */
export async function loadArchiveGoalBindings(client: PoolClient, input: {
  workspaceId: string; worldId: string; worldlineId: string; storyIds: readonly string[];
  records: readonly SavedRecordGoals[]; schemaAvailable: boolean; resolveSource: GoalContentSourceResolver;
}): Promise<RealmRuntimeSaveGoals> {
  const legacyContent = input.records.some(r => r.goals.instances.some(raw =>
    object(raw).definitionSource !== "record"));
  if (!input.schemaAvailable) {
    if (legacyContent) unresolved();
    return input.records[0].goals;
  }
  const scoped = await client.query<Record<string, unknown>>(LOAD_TRANSPORT_GOALS_SQL,
    [input.workspaceId, input.worldId, input.worldlineId, [...new Set(input.storyIds)].sort(),
      input.records.map(r => r.record.scope.recordId).sort()]);
  const expectedRecordInstances = input.records.flatMap(r => r.goals.instances.map(raw =>
    JSON.stringify([r.record.scope.recordId, object(raw).id]))).sort();
  const projectedRecordInstances = scoped.rows.filter(row => row.scope_kind === "record")
    .map(row => JSON.stringify([row.record_id, row.id])).sort();
  if (JSON.stringify(expectedRecordInstances) !== JSON.stringify(projectedRecordInstances)) unresolved();
  // Keep authored/no-Goal V1 wire bytes and behavior, even on a V2 installation.
  if (!legacyContent && scoped.rows.every(row => row.scope_kind === "record")) return input.records[0].goals;
  const definitions = input.records.flatMap(r => (r.goals.definitions ?? []).map(decodeRecordGoalDefinition));
  const definitionById = new Map(definitions.map(d => [d.definitionId, d]));
  const roots = new Map<string, { owner: GoalOwner; instances: GoalInstanceV2[] }>();
  const contentDefinitions = new Map<string, GoalDefinition>();
  const add = async (owner: GoalOwner, row: Record<string, unknown>) => {
    const id = row.id;
    if (typeof id !== "string") unresolved();
    let definition: GoalInstanceV2["definition"];
    if (row.definitionSource === "record") {
      const d = definitionById.get(row.definitionId as string);
      if (!d) unresolved();
      definition = { kind: "record", definitionId: d.definitionId, goalId: d.goalId, definitionVersion: d.definitionVersion };
    } else {
      const binding = await loadGoalContentBinding(client, input.workspaceId, id);
      if (binding.workspaceId !== input.workspaceId || binding.instanceId !== id
        || goalOwnerKey(binding.owner) !== goalOwnerKey(owner)
        || binding.goalKey !== row.goalKey || binding.policyVersion !== row.policyVersion) unresolved();
      const witness = await verifyGoalContentBinding(binding, input.resolveSource);
      contentDefinitions.set(id, witness.definition);
      definition = { kind: "content", binding };
    }
    const key = goalOwnerKey(owner);
    const root = roots.get(key) ?? { owner, instances: [] };
    const predecessor = row.supersedesInstanceId;
    root.instances.push({ ref: { owner, instanceId: id }, definition,
      goalKey: row.goalKey as string, policyVersion: row.policyVersion as string,
      state: row.state as GoalInstanceV2["state"], revision: row.revision as number,
      progress: row.progress as GoalInstanceV2["progress"], outcome: row.outcome as GoalInstanceV2["outcome"],
      attempt: row.attempt as number,
      predecessor: predecessor == null ? null : { kind: definition.kind === "content" ? "retry" : "definition-revision",
        ref: { owner, instanceId: predecessor as string } },
      resolutionKind: (row.resolutionKind ?? "natural") as GoalInstanceV2["resolutionKind"],
      evidenceStart: row.evidenceStartVersion == null || row.evidenceStartOrdinal == null ? null
        : { recordVersion: row.evidenceStartVersion as number, ordinal: row.evidenceStartOrdinal as number },
    });
    roots.set(key, root);
  };
  for (const row of scoped.rows) {
    const owner: GoalOwner = row.scope_kind === "worldline"
      ? { scopeKind: "worldline", worldId: input.worldId, worldlineId: input.worldlineId }
      : row.scope_kind === "record"
      ? { scopeKind: "record", worldId: input.worldId, worldlineId: input.worldlineId, recordId: row.record_id as string }
      : { scopeKind: "story", worldId: input.worldId, worldlineId: input.worldlineId, storyId: row.story_id as string };
    if (row.definition_source !== "content" && row.definition_source !== "record") unresolved();
    await add(owner, { id: row.id, goalKey: row.goal_key, policyVersion: row.policy_version,
      definitionSource: row.definition_source, definitionId: row.definition_id,
      state: row.state, revision: Number(row.revision), progress: row.progress, outcome: row.outcome,
      attempt: row.attempt, supersedesInstanceId: row.supersedes_instance_id, resolutionKind: row.resolution_kind,
      evidenceStartVersion: row.evidence_start_version === null ? null : Number(row.evidence_start_version),
      evidenceStartOrdinal: row.evidence_start_ordinal === null ? null : Number(row.evidence_start_ordinal) });
  }
  const assessments = input.records.flatMap(saved => saved.goals.assessments.map(value => {
    const raw = object(value);
    const owner: GoalOwner = { scopeKind: "record", ...saved.record.scope };
    const event = (id: unknown) => ({ ...saved.record.scope, eventId: id });
    return { id: raw.id, goal: { owner, instanceId: raw.goalInstanceId }, sourceEvent: event(raw.sourceEventId),
      source: raw.source, status: raw.status, result: raw.result,
      evidenceEvents: Array.isArray(raw.evidenceEventIds) ? raw.evidenceEventIds.map(event) : unresolved(),
      evidenceHead: raw.evidenceHead, evidenceSnapshotHash: raw.evidenceSnapshotHash, policyVersion: raw.policyVersion };
  }));
  const document: RealmRuntimeSaveGoalsV2 = decodeRealmRuntimeSaveGoalsV2({ format: "realm-runtime-goals", schemaVersion: 2,
    workspaceId: input.workspaceId, roots: [...roots.values()], definitions, assessments },
  { contentDefinition: binding => contentDefinitions.get(binding.instanceId) ?? unresolved() });
  // The existing archive builder enforces the combined archive budget too.
  serializeRealmRuntimeSaveGoalsV2(document);
  return document;
}
