import { buildRecordGoalNarrativeContext } from "../goals/narrative-context.ts";
import { createPostgresGoalProjectionRepository } from "../../database/postgres/goal-projection-repository.ts";
import { loadBoundRecordGoalDefinition } from "./record-goal-definition.ts";
import { withWorkspaceTransaction, type WorkspaceDatabase } from "../../database/postgres/workspace-transaction.ts";
import { decodeRecordGoalDefinition, projectRecordAuthoredGoal } from "../goals/record-authoring.ts";
import { projectGoal, type GoalProjection } from "../goals/projection.ts";
import type { GoalDefinition, GoalRuntimeScope } from "../goals/public.ts";
import { RuntimeInvariantError } from "../runtime/public.ts";
import type { RecordRuntimeScopeRepository } from "../../database/postgres/record-scope.ts";

/** Shared GET/SSE read path. The caller authorizes the session's Record before calling. */
export async function loadRecordGoalProjection(database: WorkspaceDatabase, input: {
  scope: GoalRuntimeScope;
  managementAllowed?: boolean;
  resolveContentDefinition?: (binding: { worldId: string; worldVersion: string; goalKey: string }) =>
    GoalDefinition | null | Promise<GoalDefinition | null>;
}): Promise<{ headOrdinal: number; goals: readonly GoalProjection[] }> {
  return withWorkspaceTransaction(database, input.scope.workspaceId, async (client) => {
    const projection = await createPostgresGoalProjectionRepository(client).load({
      workspaceId: input.scope.workspaceId, recordId: input.scope.recordId,
    });
    const goals: GoalProjection[] = [];
    const visibleInstanceIds = new Set<string>();
    for (const instance of projection.instances) {
      if (projection.worldId !== input.scope.worldId || instance.worldlineId !== input.scope.worldlineId) {
        throw new RuntimeInvariantError("GOAL_SCOPE_MISMATCH", "Goal projection scope does not match the authorized Record.");
      }
      const definition = await loadBoundRecordGoalDefinition(client, { scope: input.scope, binding: {
        definitionSource: instance.definitionSource, definitionId: instance.definitionId,
        goalKey: instance.goalKey, policyVersion: instance.policyVersion, worldVersion: projection.worldVersion,
      }, resolveContentDefinition: input.resolveContentDefinition });
      if (instance.definitionSource === "record") {
        const projected = projectRecordAuthoredGoal({ definition: decodeRecordGoalDefinition(definition),
          instance, managementAllowed: input.managementAllowed === true });
        if (projected) { goals.push(projected); visibleInstanceIds.add(instance.goalInstanceId); }
      } else {
        const projected = projectGoal({ definition, instance });
        if (projected) { goals.push(projected); visibleInstanceIds.add(instance.goalInstanceId); }
      }
    }
    // A public successor does not declassify a hidden predecessor's identity.
    return { headOrdinal: projection.headOrdinal, goals: goals.map(goal =>
      goal.supersedesInstanceId && !visibleInstanceIds.has(goal.supersedesInstanceId)
        ? { ...goal, supersedesInstanceId: null } : goal) };
  }, { readOnly: true });
}

/** Internal reader; the caller must authorize the Record just as for GET/SSE. */
export async function loadRecordGoalNarrativeContext(database: WorkspaceDatabase,
  input: Omit<Parameters<typeof loadRecordGoalProjection>[1], "managementAllowed"> & { principalId?: string },
): Promise<{ headOrdinal: number; document: string }> {
  return withWorkspaceTransaction(database, input.scope.workspaceId, async client => {
    if (input.principalId !== undefined) {
      const authorized = await client.query(`SELECT 1 FROM records record
        JOIN player_world_memberships member ON member.workspace_id=record.workspace_id AND member.world_id=record.world_id
        WHERE record.workspace_id=$1 AND record.world_id=$2 AND record.worldline_id=$3 AND record.id=$4
          AND record.status<>'archived' AND member.principal_id=$5 LIMIT 1`,
      [input.scope.workspaceId,input.scope.worldId,input.scope.worldlineId,input.scope.recordId,input.principalId]);
      if (!authorized.rowCount) throw new RuntimeInvariantError("GOAL_READ_FORBIDDEN", "Record Goal context is unavailable.");
    }
    const projection = await loadRecordGoalProjection(client, { ...input, managementAllowed: false });
    return { headOrdinal: projection.headOrdinal, document: buildRecordGoalNarrativeContext(projection) };
  }, { readOnly: true });
}

/** Production adapter: resolving runtime scope alone does not authorize Goal reads. */
export function createRecordGoalContextScopeRepository(database: WorkspaceDatabase,
  provider: RecordRuntimeScopeRepository,
  options: Pick<Parameters<typeof loadRecordGoalProjection>[1], "resolveContentDefinition"> = {},
): RecordRuntimeScopeRepository {
  return {
    async resolve(input) {
      const scope = await provider.resolve(input);
      if (!scope || scope.workspaceId !== input.workspaceId || scope.recordId !== input.recordId
        || scope.principalId !== input.principalId) return null;
      try {
        const context = await loadRecordGoalNarrativeContext(database, { ...options, scope, principalId: input.principalId });
        return { ...scope, brief: { ...scope.brief, recordGoals: context.document } };
      } catch (error) {
        if (error instanceof RuntimeInvariantError && error.code === "GOAL_READ_FORBIDDEN") return null;
        throw error;
      }
    },
    resolveViewerCharacterInstanceId: input => provider.resolveViewerCharacterInstanceId(input),
  };
}
