import type { PoolClient } from "pg";
import { loadRecordAuthoredGoalDefinition } from "../../database/postgres/record-goal-authoring-repository.ts";
import { withWorkspaceTransaction, type WorkspaceDatabase } from "../../database/postgres/workspace-transaction.ts";
import type { ClaimedGoalAssessmentJob } from "../goals/assessment-worker.ts";
import type { GoalDefinition, GoalRuntimeScope } from "../goals/public.ts";
import { RuntimeInvariantError } from "../runtime/public.ts";

export interface RecordGoalDefinitionBinding {
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
  if (!input.resolveContentDefinition) {
    throw new RuntimeInvariantError('GOAL_CONTENT_UNAVAILABLE','Goal content is unavailable.');
  }
  const definition = await input.resolveContentDefinition({ worldId: scope.worldId,
    worldVersion: binding.worldVersion, goalKey: binding.goalKey });
  if (!definition || definition.goalKey !== binding.goalKey) {
    throw new RuntimeInvariantError('GOAL_DEFINITION_UNAVAILABLE','The exact Goal content is unavailable.');
  }
  return definition;
}

/** Trusted worker adapter: resolves the job's exact instance, not the latest goal family version. */
export function createRecordGoalDefinitionResolver(database: WorkspaceDatabase, options: {
  resolveContentDefinition?: ContentResolver;
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
      definitionSource: row.definition_source, definitionId: row.definition_id, goalKey: row.goal_key,
      policyVersion: row.policy_version, worldVersion: row.world_version,
    }, resolveContentDefinition: options.resolveContentDefinition });
  }, { readOnly: true });
}
