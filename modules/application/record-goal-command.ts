import { createHash } from "node:crypto";
import type { WorkspaceDatabase } from "../../database/postgres/workspace-transaction.ts";
import { withWorkspaceTransaction } from "../../database/postgres/workspace-transaction.ts";
import { createRecordGoalDefinition, decodeRecordGoalDefinition, normalizeRecordGoalDraft,
  planRecordGoalRevision, planRecordGoalWithdrawal, type RecordGoalDefinitionVersion } from "../goals/record-authoring.ts";
import type { GoalRuntimeScope } from "../goals/public.ts";
import { RuntimeInvariantError } from "../runtime/public.ts";

function invalid(): never { throw new RuntimeInvariantError('GOAL_COMMAND_INVALID', 'Invalid Goal command.'); }
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) invalid();
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid();
  return value;
}
export function normalizeRecordGoalCommand(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const operation = row.operation;
  if (operation !== 'create' && operation !== 'revise' && operation !== 'withdraw') invalid();
  const keys = ['operation', 'recordId', 'expectedHead', ...(operation === 'withdraw' ? [] : ['draft']),
    ...(operation === 'create' ? [] : ['goalInstanceId', 'expectedDefinitionVersion', 'expectedInstanceRevision', 'reason'])];
  if (Object.keys(row).some(key => !keys.includes(key))) invalid();
  if (!row.expectedHead || typeof row.expectedHead !== 'object' || Array.isArray(row.expectedHead)) invalid();
  const head = row.expectedHead as Record<string, unknown>;
  if (Object.keys(head).some(key => !['recordVersion', 'ordinal'].includes(key))
    || ![head.recordVersion, head.ordinal].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n < Number.MAX_SAFE_INTEGER)
    || (head.recordVersion === 0) !== (head.ordinal === 0)) invalid();
  const base = { recordId: identifier(row.recordId), expectedHead: {
    recordVersion: head.recordVersion as number, ordinal: head.ordinal as number } };
  if (operation === 'create') return { ...base, operation: 'create' as const, draft: normalizeRecordGoalDraft(row.draft) };
  if (typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 2048 || row.reason.includes('\0')) invalid();
  const management = { ...base, goalInstanceId: identifier(row.goalInstanceId),
    expectedDefinitionVersion: positive(row.expectedDefinitionVersion), expectedInstanceRevision: positive(row.expectedInstanceRevision), reason: row.reason.trim() };
  if (operation === 'revise') return { ...management, operation: 'revise' as const, draft: normalizeRecordGoalDraft(row.draft) };
  return { ...management, operation: 'withdraw' as const };
}

/** Runtime pool only; the DB independently proves the actor and rechecks actual state under locks. */
export async function executeRecordGoalCommand(database: WorkspaceDatabase, input: {
  scope: GoalRuntimeScope; principalId: string; sessionProof: string; idempotencyKey: string; command: unknown;
}) {
  const command = normalizeRecordGoalCommand(input.command);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.idempotencyKey) || command.recordId !== input.scope.recordId) invalid();
  const scope = { workspaceId: input.scope.workspaceId, worldId: input.scope.worldId,
    worldlineId: input.scope.worldlineId, recordId: input.scope.recordId };
  return withWorkspaceTransaction(database, scope.workspaceId, async client => {
    let definition: RecordGoalDefinitionVersion | null = null;
    const cached = await client.query(`SELECT 1 FROM record_goal_commands WHERE workspace_id=$1 AND world_id=$2
      AND worldline_id=$3 AND record_id=$4 AND principal_id=$5 AND idempotency_key=$6`,
      [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,input.principalId,input.idempotencyKey]);
    // A cached receipt is not returned here: DB authority and fingerprint checks still run below.
    if (!cached.rowCount) {
      if (command.operation === 'create') {
        const goalId = 'goal_' + createHash('sha256').update(JSON.stringify([scope, input.principalId, input.idempotencyKey])).digest('hex');
        definition = createRecordGoalDefinition({ scope, goalId, draft: command.draft, activationHead: command.expectedHead });
      } else {
        const result = await client.query<{ id: string; attempt: number; definition: unknown }>(`SELECT goal.id,goal.attempt,authored.definition
          FROM goal_instances goal JOIN record_goal_definitions authored ON authored.workspace_id=goal.workspace_id
          AND authored.world_id=goal.world_id AND authored.worldline_id=goal.worldline_id AND authored.record_id=goal.record_id
          AND authored.id=goal.definition_id AND authored.goal_key=goal.goal_key AND authored.policy_version=goal.policy_version
          WHERE goal.workspace_id=$1 AND goal.world_id=$2 AND goal.worldline_id=$3 AND goal.record_id=$4
          AND goal.id=$5 AND goal.definition_source='record'`, [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,command.goalInstanceId]);
        const row = result.rows[0];
        if (!row) throw new RuntimeInvariantError('GOAL_NOT_FOUND','Goal not found.');
        const previous = decodeRecordGoalDefinition(row.definition);
        // This is a proposed CAS transition, not an assertion about current stored state.
        const proposal = { previous, scope, instance: { goalInstanceId: row.id, recordId: scope.recordId,
          state: 'active' as const, revision: command.expectedInstanceRevision, progress: {}, outcome: null, attempt: row.attempt },
          expectedDefinitionVersion: command.expectedDefinitionVersion, expectedInstanceRevision: command.expectedInstanceRevision,
          reason: command.reason };
        if (command.operation === 'revise') definition = planRecordGoalRevision({ ...proposal, nextDraft: command.draft,
          observedHead: command.expectedHead, events: [], evidenceEventIds: [] }).definition;
        else planRecordGoalWithdrawal(proposal);
      }
    }
    const result = await client.query<{ result: Record<string, unknown> }>(
      `SELECT record_goal_manage($1,$2,$3,$4,$5::jsonb,$6::jsonb) AS result`,
      [input.sessionProof, scope.workspaceId, scope.recordId, input.idempotencyKey, JSON.stringify(command),
        definition ? JSON.stringify(definition) : null]);
    return result.rows[0]!.result;
  });
}
