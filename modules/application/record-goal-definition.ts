import type { PoolClient } from "pg";
import { loadGoalContentBinding } from "../../database/postgres/goal-content-binding-repository.ts";
import { canonicalGoalJson } from "../goals/content-binding.ts";
import { createDefaultGoalContentBindingSource, verifyGoalContentBinding, type GoalContentSourceResolver } from "./goal-content-binding-source.ts";
import { loadRecordAuthoredGoalDefinition } from "../../database/postgres/record-goal-authoring-repository.ts";
import { withWorkspaceTransaction, type WorkspaceDatabase } from "../../database/postgres/workspace-transaction.ts";
import type { ClaimedGoalAssessmentJob } from "../goals/assessment-worker.ts";
import type { GoalDefinition, GoalRuntimeScope } from "../goals/public.ts";
import { RuntimeInvariantError } from "../runtime/public.ts";

export interface RecordGoalDefinitionBinding {
  instanceId?: string;
  definitionSource?: string;
  definitionId?: string | null;
  goalKey: string;
  policyVersion?: string | null;
  worldVersion: string;
}
type ContentResolver = (binding: { worldId: string; worldVersion: string; goalKey: string }) =>
  GoalDefinition | null | Promise<GoalDefinition | null>;

/** GET/SSE and worker share explicit source selection. Missing authored data never falls back. */
export async function loadBoundRecordGoalDefinition(client: PoolClient, input: {
  scope: GoalRuntimeScope;
  binding: RecordGoalDefinitionBinding;
  resolveContentDefinition?: ContentResolver;
  resolveGoalSource?: GoalContentSourceResolver;
}): Promise<GoalDefinition> {
  const { binding, scope } = input;
  if (binding.definitionSource === 'record') {
    if (!binding.definitionId || !binding.policyVersion) {
      throw new RuntimeInvariantError('GOAL_DEFINITION_UNAVAILABLE','The Record Goal binding is incomplete.');
    }
    return loadRecordAuthoredGoalDefinition(client, scope, {
      definitionId: binding.definitionId, goalKey: binding.goalKey, policyVersion: binding.policyVersion,
    });
  }
  if (binding.definitionSource !== undefined && binding.definitionSource !== 'content') {
    throw new RuntimeInvariantError('GOAL_DEFINITION_SOURCE_INVALID','The Goal definition source is invalid.');
  }
  // Present-day key/policy equality cannot prove historical content. A
  // projection without an instance id must prove every matching attempt.
  const instances = await client.query<{id:string}>(`SELECT id FROM goal_instances
    WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4
      AND scope_kind='record' AND definition_source='content' AND goal_key=$5 AND policy_version=$6
      AND ($7::text IS NULL OR id=$7) ORDER BY attempt`,
    [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,binding.goalKey,binding.policyVersion ?? null,binding.instanceId ?? null]);
  if (!instances.rows.length) throw new RuntimeInvariantError("GOAL_HISTORICAL_BINDING_UNRESOLVED", "Historical Goal source is unresolved.");
  let exact: string | undefined;
  let resolved: GoalDefinition | undefined;
  for (const instance of instances.rows) {
    const content = await loadGoalContentBinding(client, scope.workspaceId, instance.id);
    if (content.owner.scopeKind !== "record" || content.owner.recordId !== scope.recordId
      || content.owner.worldId !== scope.worldId || content.owner.worldlineId !== scope.worldlineId
      || content.goalKey !== binding.goalKey || content.policyVersion !== binding.policyVersion
      || content.source.sourceWorldVersion !== binding.worldVersion) {
      throw new RuntimeInvariantError("GOAL_SCOPE_MISMATCH", "Goal source binding does not match the instance.");
    }
    const identity = canonicalGoalJson([content.source,content.definitionHash]);
    if (exact !== undefined && identity !== exact) throw new RuntimeInvariantError("GOAL_HISTORICAL_BINDING_UNRESOLVED", "Goal source is ambiguous.");
    exact = identity;
    resolved = (await verifyGoalContentBinding(content, input.resolveGoalSource ?? createDefaultGoalContentBindingSource())).definition;
  }
  return resolved!;
}

/** Trusted worker adapter: resolves the job's exact instance, not the latest goal family version. */
export function createRecordGoalDefinitionResolver(database: WorkspaceDatabase, options: {
  resolveContentDefinition?: ContentResolver;
  resolveGoalSource?: GoalContentSourceResolver;
} = {}): (job: ClaimedGoalAssessmentJob) => Promise<GoalDefinition> {
  return job => withWorkspaceTransaction(database, job.workspaceId, async client => {
    const result = await client.query<{ definition_source: string; definition_id: string | null;
      goal_key: string; policy_version: string; world_version: string }>(`SELECT goal.definition_source,goal.definition_id,
      goal.goal_key,goal.policy_version,record.world_version
      FROM goal_instances goal JOIN records record ON record.workspace_id=goal.workspace_id
        AND record.world_id=goal.world_id AND record.worldline_id=goal.worldline_id AND record.id=goal.record_id
      WHERE goal.workspace_id=$1 AND goal.world_id=$2 AND goal.worldline_id=$3 AND goal.record_id=$4 AND goal.id=$5`,
      [job.workspaceId,job.worldId,job.worldlineId,job.recordId,job.goalInstanceId]);
    const row = result.rows[0];
    if (!row) throw new RuntimeInvariantError('GOAL_DEFINITION_UNAVAILABLE','The exact Record Goal instance is unavailable.');
    if (row.goal_key !== job.goalKey || row.world_version !== job.worldVersion) {
      throw new RuntimeInvariantError('GOAL_SCOPE_MISMATCH','The Goal job does not match its immutable Record binding.');
    }
    return loadBoundRecordGoalDefinition(client, { scope: job, binding: {
      instanceId: job.goalInstanceId, definitionSource: row.definition_source, definitionId: row.definition_id, goalKey: row.goal_key,
      policyVersion: row.policy_version, worldVersion: row.world_version,
    }, resolveContentDefinition: options.resolveContentDefinition, resolveGoalSource: options.resolveGoalSource });
  }, { readOnly: true });
}
