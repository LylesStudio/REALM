import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { canonicalGoalJson, decodeGoalContentBinding, type GoalContentBindingV1, type GoalOwner, type GoalSource } from "../../modules/goals/content-binding.ts";
import type { GoalContentSourceResolver } from "../../modules/application/goal-content-binding-source.ts";
import { RuntimeInvariantError } from "../../modules/runtime/public.ts";

export interface GoalContentWriteContext {
  sessionProof?: string;
  worldVersion: string;
  resolveSource: GoalContentSourceResolver;
  expectedSource?: GoalSource;
  source?: { recordId: string; recordVersion: number; nextRecordOrdinal: number };
}
export const LOCK_GOAL_CONTENT_WORLD_SQL = `SELECT id FROM worlds
  WHERE workspace_id=$1 AND id=$2 AND status='active' FOR UPDATE`;
/** Acquire before Record/head/worldline/Goal locks, including implicit FK locks.
 * prepare retains the same strongest World lock; it must never be an upgrade. */
export async function lockGoalContentWorld(client: PoolClient, workspaceId: string, worldId: string): Promise<void> {
  const result = await client.query(LOCK_GOAL_CONTENT_WORLD_SQL, [workspaceId, worldId]);
  if (result.rows.length !== 1) throw new RuntimeInvariantError("GOAL_CONTENT_PROOF_REQUIRED", "Goal content writes require an active World.");
}
export const LOAD_GOAL_CONTENT_BINDING_SQL = `SELECT jsonb_build_object(
  'bindingVersion',binding_version,'workspaceId',workspace_id,
  'owner',jsonb_build_object('scopeKind',scope_kind,'worldId',world_id,'worldlineId',worldline_id)
    || CASE scope_kind WHEN 'record' THEN jsonb_build_object('recordId',record_id)
       WHEN 'story' THEN jsonb_build_object('storyId',story_id) ELSE '{}'::jsonb END,
  'instanceId',goal_instance_id,'goalKey',goal_key,'policyVersion',policy_version,
  'definitionHash',definition_hash,'normalization',normalization,
  'source',jsonb_build_object('sourceKind',source_kind,'sourceWorldId',source_world_id,
    'sourceWorldVersion',source_world_version,'packageContentHash',package_content_hash,
    'baseRevision',base_revision,'baseContentHash',base_content_hash)) AS binding
  FROM goal_content_instance_bindings WHERE workspace_id=$1 AND goal_instance_id=$2`;
export async function loadGoalContentBinding(client: PoolClient, workspaceId: string, instanceId: string): Promise<GoalContentBindingV1> {
  const result = await client.query<{ binding: unknown }>(LOAD_GOAL_CONTENT_BINDING_SQL, [workspaceId, instanceId]);
  if (result.rows.length !== 1) throw new RuntimeInvariantError("GOAL_HISTORICAL_BINDING_UNRESOLVED", "Historical Goal source is unresolved.");
  return decodeGoalContentBinding(result.rows[0].binding);
}
export function goalOwnerForScope(scope: { worldId: string; worldlineId: string; recordId?: string; storyId?: string; kind?: string }): GoalOwner {
  if (scope.kind === "worldline") return { scopeKind: "worldline", worldId: scope.worldId, worldlineId: scope.worldlineId };
  if (scope.kind === "story") return { scopeKind: "story", worldId: scope.worldId, worldlineId: scope.worldlineId, storyId: scope.storyId! };
  return { scopeKind: "record", worldId: scope.worldId, worldlineId: scope.worldlineId, recordId: scope.recordId! };
}
export async function prepareGoalContentWrites(client: PoolClient, input: {
  workspaceId: string; sessionProof?: string; operation: "materialize" | "retry" | "clone" | "restore-v2";
  bindings: readonly GoalContentBindingV1[]; predecessors?: ReadonlyMap<string, string>;
  body: unknown; source?: GoalContentWriteContext["source"]; restoreGroupRoot?: string;
}): Promise<{ bodyCommitment: string; planCommitment: string }> {
  if (!input.sessionProof || !input.bindings.length) throw new RuntimeInvariantError("GOAL_CONTENT_PROOF_REQUIRED", "Goal content write requires a session proof.");
  const bindings = input.bindings.map(b => decodeGoalContentBinding(b));
  const first = bindings[0];
  const plan = { operation: input.operation, worldId: first.owner.worldId, worldlineId: first.owner.worldlineId,
    instances: bindings.map(b => ({ instanceId: b.instanceId, owner: b.owner, goalKey: b.goalKey,
      policyVersion: b.policyVersion, definitionHash: b.definitionHash, source: b.source,
      predecessor: input.predecessors?.get(b.instanceId) ?? null })), source: input.source ?? null,
    restoreGroupRoot: input.restoreGroupRoot ?? null };
  const bodyCommitment = createHash("sha256").update("realm-goal-content-write:v1\0").update(canonicalGoalJson(input.body)).digest("hex");
  const result = await client.query<{ admission: { actor: string; planCommitment: string } }>(
    "SELECT goal_content_write_prepare($1,$2,$3,$4,$5::jsonb) AS admission",
    [input.workspaceId, input.sessionProof, input.operation, bodyCommitment, canonicalGoalJson(plan)]);
  const admission = result.rows[0]?.admission;
  if (!admission?.actor || !/^[0-9a-f]{64}$/.test(admission.planCommitment)) throw new RuntimeInvariantError("GOAL_CONTENT_PROOF_REQUIRED", "Goal content admission is unavailable.");
  return { bodyCommitment, planCommitment: admission.planCommitment };
}
export async function bindGoalContentWrites(client: PoolClient, input: {
  workspaceId: string; sessionProof?: string; bodyCommitment: string; planCommitment: string;
  bindings: readonly GoalContentBindingV1[];
}): Promise<void> {
  await client.query("SELECT goal_content_write_bind($1,$2,$3,$4,$5::jsonb)",
    [input.workspaceId, input.sessionProof, input.bodyCommitment, input.planCommitment, canonicalGoalJson(input.bindings)]);
}
