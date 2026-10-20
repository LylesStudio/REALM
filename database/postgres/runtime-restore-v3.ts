import type { PoolClient } from "pg";
import { GOAL_RESTORE_TARGET_CAPABILITY_SQL } from "./runtime-goal-restore.ts";

/** Trusted binary declaration still negotiates the actual installed SQL surface. */
export const PERFORMANCE_RESTORE_TARGET_CAPABILITY_SQL = `SELECT (${GOAL_RESTORE_TARGET_CAPABILITY_SQL.replace(/^SELECT /, "").replace(/ AS available$/, "")})
  AND NOT EXISTS (SELECT 1 FROM (VALUES
    ('record_goal_restore_group_prepare_v3(text,text,text,text,text,text,jsonb)'),
    ('record_goal_restore_group_replay_v3(text,text,text,text,text,jsonb)'),
    ('performance_restore_v3_complete(text,text)'),
    ('performance_restore_v3_plan_assert(text,text,jsonb)'),
    ('performance_restore_legacy_goal_source(jsonb)'),
    ('performance_restore_v3_fact_assert(text,jsonb)'),
    ('performance_restore_v3_mapped(jsonb,text,text)'),
    ('goal_restore_v3_complete(text,text)'),
    ('performance_transport_canonical(jsonb)'),
    ('performance_transport_keys(jsonb,text[])'),
    ('goal_content_write_prepare_v3(text,text,text,text,jsonb)')
  ) required(signature) WHERE to_regprocedure('public.'||signature) IS NULL)
  AND NOT EXISTS (SELECT 1 FROM (VALUES
    ('performance_evidence_transport_provenance',ARRAY['workspace_id','world_id','worldline_id','record_id','command_id','assessment_id','source_workspace_id','source_world_id','source_worldline_id','source_record_id','source_command_id','source_assessment_id','version','envelope_canonical','envelope_hash','source_manifest_hash']),
    ('performance_assessments',ARRAY['record_id','command_id','policy_version','score','evidence_event_ids','evidence_snapshot_hash']),
    ('committed_fact_commands',ARRAY['workspace_id','world_id','worldline_id','id','request_fingerprint','result_manifest']),
    ('events',ARRAY['workspace_id','world_id','worldline_id','record_id','id','scene_id','visibility_policy_id','record_version','record_ordinal','world_tick','world_ordinal']),
    ('record_heads',ARRAY['workspace_id','record_id','record_version','next_record_ordinal']),
    ('scenes',ARRAY['workspace_id','world_id','worldline_id','record_id','id','start_tick','start_ordinal']),
    ('visibility_policies',ARRAY['workspace_id','world_id','worldline_id','id','policy_version','policy_kind']),
    ('project_milestones',ARRAY['workspace_id','world_id','worldline_id','id','project_id','status','completion_record_id','completion_event_id']),
    ('projects',ARRAY['workspace_id','world_id','worldline_id','id'])
  ) required(table_name,columns) WHERE to_regclass('public.'||table_name) IS NULL OR EXISTS(
    SELECT 1 FROM unnest(required.columns) column_name WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=to_regclass('public.'||required.table_name) AND a.attname=column_name AND a.attnum>0 AND NOT a.attisdropped)))
  AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=to_regclass('public.goal_content_write_admissions')
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%restore-v3%')
  AND NOT EXISTS(SELECT 1 FROM (VALUES ('record_goal_restore_admissions'),('performance_evidence_transport_provenance'),
    ('committed_fact_commands'),('performance_assessments'),('goal_instances'),('goal_assessments'),('records'),('stories'),('worldlines'),
    ('events'),('scenes'),('visibility_policies'),('record_heads'),('projects'),('project_milestones')) required(table_name)
    WHERE NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=to_regclass('public.'||required.table_name)
      AND t.tgname=CASE required.table_name WHEN 'performance_evidence_transport_provenance' THEN 'performance_v3_provenance_complete'
        ELSE 'performance_v3_'||required.table_name||'_complete' END
      AND t.tgdeferrable AND t.tginitdeferred AND t.tgenabled<>'D')) AS available`;

export async function hasPerformanceRestoreTarget(client: PoolClient): Promise<boolean> {
  const result=await client.query<{available:boolean}>(PERFORMANCE_RESTORE_TARGET_CAPABILITY_SQL);
  return result.rows.length===1 && result.rows[0].available===true;
}
