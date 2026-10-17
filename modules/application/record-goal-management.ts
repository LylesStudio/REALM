import type { Pool } from 'pg';
import { withWorkspaceTransaction, type WorkspaceDatabase } from '../../database/postgres/workspace-transaction.ts';
import { createPostgresGoalProjectionRepository } from '../../database/postgres/goal-projection-repository.ts';
import { createPostgresGoalAssessmentJobQueue } from '../../database/postgres/goal-assessment-job-queue.ts';
import { loadBoundRecordGoalDefinition } from './record-goal-definition.ts';
import { decodeRecordGoalDefinition, projectRecordAuthoredGoal } from '../goals/record-authoring.ts';
import { goalAssessmentJobIdFor, type GoalRuntimeScope } from '../goals/public.ts';
import type { RecordGoalManagementSnapshot } from '../goals/authoring-contract.ts';
import { LOCAL_WORLD_VERSION } from '../world-transfer/realm-save.ts';
import { RuntimeInvariantError } from '../runtime/public.ts';

function fail(code: string): never { throw new RuntimeInvariantError(code,'Record Goal management is unavailable.'); }

/** Owner authoring read: public Goals only. Ownership does not declassify hidden predecessors. */
export async function loadRecordGoalManagement(database: WorkspaceDatabase, input: {
  scope: GoalRuntimeScope; principalId: string;
}): Promise<RecordGoalManagementSnapshot> {
  const {scope,principalId} = input;
  return withWorkspaceTransaction(database,scope.workspaceId,async client => {
    const access = await client.query(`SELECT record.world_version,record.status,world.status AS world_status,
      line.status AS line_status,head.record_version,head.next_record_ordinal
      FROM records record JOIN worlds world ON world.workspace_id=record.workspace_id AND world.id=record.world_id
      JOIN worldlines line ON line.workspace_id=record.workspace_id AND line.world_id=record.world_id AND line.id=record.worldline_id
      JOIN record_heads head ON head.workspace_id=record.workspace_id AND head.record_id=record.id
      JOIN player_world_memberships member ON member.workspace_id=record.workspace_id AND member.world_id=record.world_id
      WHERE record.workspace_id=$1 AND record.world_id=$2 AND record.worldline_id=$3 AND record.id=$4
        AND member.principal_id=$5 AND member.role='owner' AND record.status<>'archived'`,
    [scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId,principalId]);
    const row = access.rows[0];
    if (!row) fail('GOAL_FORBIDDEN');
    const canCreate = row.world_version===LOCAL_WORLD_VERSION && row.status==='active'
      && row.world_status==='active' && row.line_status==='active';
    const projection = await createPostgresGoalProjectionRepository(client).load({workspaceId:scope.workspaceId,recordId:scope.recordId});
    const jobs = await client.query<{goal_instance_id:string;state:string}>(`SELECT DISTINCT ON(goal_instance_id) goal_instance_id,state
      FROM goal_assessment_jobs WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4
      ORDER BY goal_instance_id,created_at DESC,id DESC`,[scope.workspaceId,scope.worldId,scope.worldlineId,scope.recordId]);
    const jobStates = new Map(jobs.rows.map(job=>[job.goal_instance_id,job.state]));
    const candidates = [];
    for (const instance of projection.instances) {
      if (instance.definitionSource !== 'record') continue;
      if (projection.worldId!==scope.worldId || instance.worldlineId!==scope.worldlineId) fail('GOAL_SCOPE_MISMATCH');
      const definition = decodeRecordGoalDefinition(await loadBoundRecordGoalDefinition(client,{scope,binding:{
        definitionSource:instance.definitionSource,definitionId:instance.definitionId,goalKey:instance.goalKey,
        policyVersion:instance.policyVersion,worldVersion:projection.worldVersion}}));
      const publicGoal = projectRecordAuthoredGoal({definition,instance,managementAllowed:canCreate});
      if (publicGoal) candidates.push({definition,publicGoal});
    }
    const visibleIds = new Set(candidates.map(({publicGoal})=>publicGoal.goalInstanceId));
    const goals = candidates.map(({definition,publicGoal}):RecordGoalManagementSnapshot['goals'][number] => {
      const predecessorVisible = publicGoal.supersedesInstanceId!==null && visibleIds.has(publicGoal.supersedesInstanceId);
      return {goalInstanceId:publicGoal.goalInstanceId,goalKey:publicGoal.goalKey,definitionVersion:definition.definitionVersion,
        revision:publicGoal.revision,draft:definition.draft,state:publicGoal.state,
        ...(publicGoal.resolutionKind ? {resolutionKind:publicGoal.resolutionKind} : {}),
        progressSummary:typeof publicGoal.progress.summary==='string' ? publicGoal.progress.summary : '',
        completedCriteria:Array.isArray(publicGoal.progress.completedCriteria) ? publicGoal.progress.completedCriteria as number[] : [],
        supersedesInstanceId:predecessorVisible ? publicGoal.supersedesInstanceId : null,
        changeReason:predecessorVisible ? definition.changeReason : null,
        ...publicGoal.capabilities,assessmentState:jobStates.get(publicGoal.goalInstanceId) ?? null};
    });
    return {recordId:scope.recordId,canCreate,head:{recordVersion:Number(row.record_version),ordinal:Math.max(0,Number(row.next_record_ordinal)-1)},goals};
  },{readOnly:true});
}

/** Re-evaluate committed, public, post-activation evidence; never synthesize a source event. */
export async function requestRecordGoalAssessment(pool: Pool, input: {
  scope: GoalRuntimeScope; principalId: string; goalInstanceId: string;
  expectedHead: {recordVersion:number;ordinal:number};
}):Promise<'inserted'|'existing'|'waiting'> {
  const snapshot = await loadRecordGoalManagement(pool,input);
  if (!snapshot.canCreate) fail('GOAL_READ_ONLY');
  if (snapshot.head.recordVersion!==input.expectedHead.recordVersion || snapshot.head.ordinal!==input.expectedHead.ordinal) fail('GOAL_WRITE_CONFLICT');
  const goal = snapshot.goals.find(candidate=>candidate.goalInstanceId===input.goalInstanceId);
  if (!goal) fail('GOAL_NOT_FOUND');
  if (goal.state!=='active') fail('GOAL_INSTANCE_TERMINAL');
  const source = await withWorkspaceTransaction(pool,input.scope.workspaceId,async client => {
    const result = await client.query<{id:string}>(`SELECT event.id FROM goal_instances goal
      JOIN events event ON event.workspace_id=goal.workspace_id AND event.world_id=goal.world_id
        AND event.worldline_id=goal.worldline_id AND event.record_id=goal.record_id
      JOIN visibility_policies policy ON policy.workspace_id=event.workspace_id AND policy.world_id=event.world_id
        AND policy.worldline_id=event.worldline_id AND policy.record_id=event.record_id AND policy.id=event.visibility_policy_id
      WHERE goal.workspace_id=$1 AND goal.world_id=$2 AND goal.worldline_id=$3 AND goal.record_id=$4 AND goal.id=$5
        AND goal.state='active' AND policy.policy_kind='public'
        AND event.record_version>goal.evidence_start_version AND event.record_ordinal>goal.evidence_start_ordinal
        AND event.record_version<=$6 AND event.record_ordinal<=$7
        AND event.event_kind IN ('narration.committed','world.consequence.committed','action.resolved','scene.crystallized')
      ORDER BY event.record_ordinal DESC LIMIT 1`,[input.scope.workspaceId,input.scope.worldId,input.scope.worldlineId,
        input.scope.recordId,input.goalInstanceId,snapshot.head.recordVersion,snapshot.head.ordinal]);
    return result.rows[0]?.id ?? null;
  },{readOnly:true});
  if (!source) return 'waiting';
  return createPostgresGoalAssessmentJobQueue({pool,workspaceId:input.scope.workspaceId,leaseOwner:'goal-authoring-request'})
    .enqueue({...input.scope,goalInstanceId:goal.goalInstanceId,goalKey:goal.goalKey,sourceEventId:source,
      jobId:goalAssessmentJobIdFor(input.scope.workspaceId,goal.goalInstanceId,source)});
}
