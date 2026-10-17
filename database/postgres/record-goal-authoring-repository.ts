import type { PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import { RuntimeInvariantError, type JsonValue } from "../../modules/runtime/public.ts";
import {
  decodeRecordGoalDefinition,
  planRecordGoalReplacement,
  planRecordGoalRevision,
  type RecordGoalDefinitionVersion,
  type RecordGoalReplacement,
} from "../../modules/goals/record-authoring.ts";
import type { GoalRuntimeScope, GoalState } from "../../modules/goals/public.ts";
import { loadGoalScopeCommittedEvents } from "./goal-scope-evidence.ts";

export interface RecordGoalDefinitionBinding {
  definitionId: string;
  goalKey: string;
  policyVersion: string;
}

/**
 * Initial materialization only. The caller owns the authorized genesis/management
 * transaction, scope gates and formal event. Never opens a pool or commits.
 */
export async function materializeRecordAuthoredGoal(client: PoolClient, input: {
  definition: RecordGoalDefinitionVersion;
  principalId: string;
}): Promise<void> {
  const definition = decodeRecordGoalDefinition(input.definition);
  if (definition.definitionVersion !== 1) {
    throw new RuntimeInvariantError("GOAL_INITIAL_VERSION_INVALID", "Initial materialization requires the first definition version.");
  }
  await insertDefinitionAndInstance(client, definition, input.principalId, null);
}

/** Caller has already locked world/Record/worldline/head in the standard order. */
export async function appendRecordGoalReplacement(client: PoolClient, input: {
  replacement: RecordGoalReplacement;
  principalId: string;
}): Promise<void> {
  const definition = decodeRecordGoalDefinition(input.replacement.definition);
  if (definition.definitionVersion <= 1) {
    throw new RuntimeInvariantError("GOAL_REPLACEMENT_INVALID", "Replacement requires a successor definition.");
  }
  const scope = definition.scope;
  const previous = await client.query<{ id: string; state: string; revision: string; progress: unknown;
    outcome: unknown; attempt: number; definition: unknown }>(`
    SELECT goal.id, goal.state, goal.revision::text, goal.progress, goal.outcome, goal.attempt, authored.definition
    FROM goal_instances AS goal JOIN record_goal_definitions AS authored
      ON authored.workspace_id = goal.workspace_id AND authored.world_id = goal.world_id
      AND authored.worldline_id = goal.worldline_id AND authored.record_id = goal.record_id
      AND authored.id = goal.definition_id
    WHERE goal.workspace_id = $1 AND goal.world_id = $2 AND goal.worldline_id = $3 AND goal.record_id = $4
      AND goal.id = $5 AND goal.definition_source = 'record' AND goal.definition_id = $6
    FOR UPDATE OF goal`, [scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId,
    input.replacement.previousTransition.goalInstanceId, definition.supersedesDefinitionId]);
  const row = previous.rows[0];
  if (!row) throw new RuntimeInvariantError("GOAL_WRITE_CONFLICT", "The previous Goal binding changed.");
  const oldDefinition = decodeRecordGoalDefinition(row.definition);
  const events = definition.changeKind === "automatic" ? await loadGoalScopeCommittedEvents(client, scope) : [];
  const planInput = { previous: oldDefinition, scope,
    instance: { goalInstanceId: row.id, recordId: scope.recordId, state: row.state as GoalState,
      revision: Number(row.revision), progress: row.progress as Readonly<Record<string, JsonValue>>,
      outcome: row.outcome as Readonly<Record<string, JsonValue>> | null, attempt: row.attempt },
    expectedDefinitionVersion: definition.definitionVersion - 1,
    expectedInstanceRevision: input.replacement.previousTransition.revision - 1,
    nextDraft: definition.draft, reason: definition.changeReason ?? "",
    observedHead: definition.activationHead, events, evidenceEventIds: definition.basisEventIds,
  };
  const canonical = definition.changeKind === "automatic"
    ? planRecordGoalReplacement(planInput) : planRecordGoalRevision(planInput);
  if (!isDeepStrictEqual(canonical, input.replacement)) {
    throw new RuntimeInvariantError("GOAL_REPLACEMENT_INVALID", "The replacement does not match its committed predecessor.");
  }
  const closed = await client.query(`UPDATE goal_instances
    SET state = 'settled', resolution_kind = 'superseded', revision = $7,
      completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, outcome = NULL
    WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4
      AND id = $5 AND state = 'active' AND revision = $6`, [scope.workspaceId, scope.worldId,
    scope.worldlineId, scope.recordId, row.id, planInput.expectedInstanceRevision, canonical.previousTransition.revision]);
  if (closed.rowCount !== 1) throw new RuntimeInvariantError("GOAL_WRITE_CONFLICT", "The previous Goal revision changed.");
  await insertDefinitionAndInstance(client, definition, input.principalId, row.id);
}

/** Explicit binding resolution: a missing or mismatched definition never falls back to package content. */
export async function loadRecordAuthoredGoalDefinition(
  client: PoolClient,
  scope: GoalRuntimeScope,
  binding: RecordGoalDefinitionBinding,
): Promise<RecordGoalDefinitionVersion> {
  const result = await client.query<{ definition: unknown }>(`SELECT definition FROM record_goal_definitions
    WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4
      AND id = $5 AND goal_key = $6 AND policy_version = $7`, [
    scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId,
    binding.definitionId, binding.goalKey, binding.policyVersion,
  ]);
  if (result.rows.length !== 1) {
    throw new RuntimeInvariantError("GOAL_DEFINITION_UNAVAILABLE", "The exact Record Goal definition is unavailable.");
  }
  return decodeRecordGoalDefinition(result.rows[0]!.definition);
}

async function insertDefinitionAndInstance(client: PoolClient, definition: RecordGoalDefinitionVersion,
  principalId: string, supersedesInstanceId: string | null): Promise<void> {
  if (typeof principalId !== "string" || !principalId.trim() || principalId.includes("\0")) {
    throw new RuntimeInvariantError("GOAL_AUTHOR_INVALID", "A server-authorized author is required.");
  }
  const scope = definition.scope;
  await client.query(`INSERT INTO record_goal_definitions (
    workspace_id, world_id, worldline_id, record_id, id, goal_id, definition_version,
    goal_key, policy_version, definition, supersedes_definition_id, created_by_principal_id
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`, [
    scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId, definition.definitionId,
    definition.goalId, definition.definitionVersion, definition.goalKey, definition.policyVersion,
    JSON.stringify(definition), definition.supersedesDefinitionId, principalId,
  ]);
  await client.query(`INSERT INTO goal_instances (
    workspace_id, world_id, worldline_id, record_id, id, goal_key, policy_version,
    definition_source, definition_id, evidence_start_version, evidence_start_ordinal,
    state, revision, attempt, supersedes_instance_id
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,'record',$8,$9,$10,'active',1,1,$11)`, [
    scope.workspaceId, scope.worldId, scope.worldlineId, scope.recordId, definition.goalInstanceId,
    definition.goalKey, definition.policyVersion, definition.definitionId,
    definition.activationHead.recordVersion, definition.activationHead.ordinal, supersedesInstanceId,
  ]);
}
