import type { PoolClient } from 'pg';
import type { GoalRuntimeScope } from '../../modules/goals/public.ts';
import { createRecordGoalDefinition } from '../../modules/goals/record-authoring.ts';
import { normalizeRecordGoalDrafts } from '../../modules/goals/authoring-contract.ts';

/** Called before the opening event, inside the enclosing creator-proof genesis transaction. */
export async function materializeGenesisRecordGoals(client: PoolClient, input: {
  scope: GoalRuntimeScope; sessionProof: string; creationRequestId: string; drafts: unknown;
}): Promise<void> {
  const drafts = normalizeRecordGoalDrafts(input.drafts);
  for (const [index, draft] of drafts.entries()) {
    const definition = createRecordGoalDefinition({ scope: input.scope, goalId: `genesis.goal.${index+1}`,
      draft, activationHead: {recordVersion:0,ordinal:0} });
    await client.query(`SELECT record_goal_genesis_materialize($1,$2,$3,$4::jsonb)`,
      [input.scope.workspaceId,input.sessionProof,input.creationRequestId,JSON.stringify(definition)]);
  }
}
