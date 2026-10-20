-- Candidate only: body-v3 is a distinct complete-body admission, never a V2 digest.
-- Existing V1/V2 branches retain their original function bodies and privileges.
ALTER TABLE goal_content_write_admissions DROP CONSTRAINT goal_content_write_admissions_operation_check;
ALTER TABLE goal_content_write_admissions ADD CONSTRAINT goal_content_write_admissions_operation_check
  CHECK(operation IN ('materialize','retry','clone','restore-v2','restore-v3','restore-v1-legacy'));
-- Necessary read-only completeness surface for the existing NOBYPASSRLS role.
-- No new runtime write privilege; all queries retain workspace/world/line predicates.
GRANT SELECT(workspace_id,world_id,worldline_id,record_id,command_id,assessment_id,envelope_canonical,envelope_hash)
  ON performance_evidence_transport_provenance TO realm_goal_authoring;
GRANT SELECT(workspace_id,world_id,worldline_id,id,record_id,command_id,score,evidence_event_ids,evidence_snapshot_hash)
  ON performance_assessments TO realm_goal_authoring;
GRANT SELECT(workspace_id,world_id,worldline_id,id,request_fingerprint,result_manifest)
  ON committed_fact_commands TO realm_goal_authoring;
GRANT SELECT(workspace_id,world_id,worldline_id,id,project_id,status,completion_record_id,completion_event_id)
  ON project_milestones TO realm_goal_authoring;
GRANT SELECT(workspace_id,world_id,worldline_id,id) ON projects TO realm_goal_authoring;
GRANT EXECUTE ON FUNCTION performance_transport_canonical(jsonb),performance_transport_keys(jsonb,text[]) TO realm_goal_authoring;


CREATE FUNCTION goal_content_write_prepare_v3(p_workspace text,p_proof text,p_operation text,p_body text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text; item jsonb; owner jsonb; plan_hash text; count_items integer;
  source_record public.records%ROWTYPE; source_head public.record_heads%ROWTYPE;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  -- D3: no playable legacy preservation capability is exposed. Unknown historical
  -- source cannot be silently admitted as current content.
  IF p_operation IS NULL OR p_operation <> 'restore-v3'
    OR p_body IS NULL OR p_body !~ '^[0-9a-f]{64}$' OR p_plan IS NULL
    OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object' OR octet_length(p_plan::text)>16777216 THEN
    RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_plan))<>6
    OR NOT p_plan ?& ARRAY['operation','worldId','worldlineId','instances','source','restoreGroupRoot']
    OR p_plan->>'operation' IS DISTINCT FROM p_operation
    OR jsonb_typeof(p_plan->'worldId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_plan->'worldlineId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_plan->'instances') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  count_items:=jsonb_array_length(p_plan->'instances');
  IF count_items NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  PERFORM 1 FROM public.worlds WHERE workspace_id=p_workspace AND id=p_plan->>'worldId' AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  PERFORM public.membership_assert_world_owner(p_workspace,p_plan->>'worldId',actor);
  PERFORM 1 FROM public.worldlines WHERE workspace_id=p_workspace AND world_id=p_plan->>'worldId'
    AND id=p_plan->>'worldlineId' AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  IF p_operation='clone' THEN
    IF jsonb_typeof(p_plan->'source') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_plan->'source'))<>3
      OR NOT (p_plan->'source') ?& ARRAY['recordId','recordVersion','nextRecordOrdinal']
      OR jsonb_typeof(p_plan#>'{source,recordId}') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_plan#>'{source,recordVersion}') IS DISTINCT FROM 'number'
      OR jsonb_typeof(p_plan#>'{source,nextRecordOrdinal}') IS DISTINCT FROM 'number'
      OR p_plan#>>'{source,recordVersion}' !~ '^(0|[1-9][0-9]*)$'
      OR p_plan#>>'{source,nextRecordOrdinal}' !~ '^(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    SELECT * INTO source_record FROM public.records WHERE workspace_id=p_workspace AND id=p_plan#>>'{source,recordId}' FOR UPDATE;
    IF NOT FOUND OR source_record.world_id IS DISTINCT FROM p_plan->>'worldId' OR source_record.status='archived' THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    SELECT * INTO source_head FROM public.record_heads WHERE workspace_id=p_workspace AND record_id=source_record.id FOR UPDATE;
    IF NOT FOUND OR source_head.record_version IS DISTINCT FROM (p_plan#>>'{source,recordVersion}')::bigint
      OR source_head.next_record_ordinal IS DISTINCT FROM (p_plan#>>'{source,nextRecordOrdinal}')::bigint THEN RAISE EXCEPTION 'GOAL_BRANCH_HEAD_CHANGED'; END IF;
  ELSIF p_plan->'source' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  IF p_operation='restore-v3' THEN
    IF NOT EXISTS(SELECT 1 FROM public.record_goal_restore_admissions group_admission
      WHERE group_admission.workspace_id=p_workspace AND group_admission.record_id=p_plan->>'restoreGroupRoot'
        AND group_admission.group_plan->'bodyVersion'='3'::jsonb AND group_admission.body_commitment=p_body
        AND group_admission.principal_id=actor AND group_admission.transaction_id=pg_current_xact_id()
        AND group_admission.world_id=p_plan->>'worldId' AND group_admission.worldline_id=p_plan->>'worldlineId'
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'instances') planned WHERE NOT EXISTS(
          SELECT 1 FROM jsonb_array_elements(group_admission.group_plan#>'{goals,roots}') root,LATERAL jsonb_array_elements(root->'instances') goal
          WHERE goal#>>'{definition,kind}'='content' AND goal#>>'{ref,instanceId}'=planned->>'instanceId'
            AND goal#>'{ref,owner}'=planned->'owner' AND goal#>>'{predecessor,ref,instanceId}' IS NOT DISTINCT FROM planned->>'predecessor'
            AND goal#>>'{definition,binding,definitionHash}'=planned->>'definitionHash'
            AND goal#>'{definition,binding,source}'=planned->'source' AND goal->>'goalKey'=planned->>'goalKey'
            AND goal->>'policyVersion'=planned->>'policyVersion'))) THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
    PERFORM public.record_goal_restore_group_check(p_workspace,p_plan->>'restoreGroupRoot');
  ELSIF p_plan->'restoreGroupRoot' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  IF (SELECT count(DISTINCT value->>'instanceId') FROM jsonb_array_elements(p_plan->'instances'))<>count_items THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  plan_hash:=encode(public.digest(p_plan::text,'sha256'),'hex');
  IF EXISTS(SELECT 1 FROM public.goal_content_write_admissions admission,
    jsonb_array_elements(p_plan->'instances') planned
    WHERE admission.workspace_id=p_workspace AND admission.goal_instance_id=planned->>'instanceId') THEN
    IF (SELECT count(*) FROM public.goal_content_write_admissions admission,
      jsonb_array_elements(p_plan->'instances') planned
      WHERE admission.workspace_id=p_workspace AND admission.goal_instance_id=planned->>'instanceId'
        AND admission.principal_id=actor AND admission.transaction_id=pg_current_xact_id()
        AND admission.body_commitment=p_body AND admission.plan_commitment=plan_hash AND admission.plan=p_plan)<>count_items THEN
      RAISE EXCEPTION 'GOAL_CONTENT_IDENTITY_CONFLICT'; END IF;
    RETURN jsonb_build_object('actor',actor,'planCommitment',plan_hash);
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_plan->'instances') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(item))<>7
      OR NOT item ?& ARRAY['instanceId','owner','goalKey','policyVersion','definitionHash','source','predecessor']
      OR jsonb_typeof(item->'instanceId') IS DISTINCT FROM 'string' OR length(btrim(item->>'instanceId'))=0
      OR jsonb_typeof(item->'goalKey') IS DISTINCT FROM 'string' OR length(btrim(item->>'goalKey'))=0
      OR jsonb_typeof(item->'policyVersion') IS DISTINCT FROM 'string' OR length(btrim(item->>'policyVersion'))=0
      OR jsonb_typeof(item->'definitionHash') IS DISTINCT FROM 'string' OR item->>'definitionHash' !~ '^[0-9a-f]{64}$'
      OR (item->'predecessor'<>'null'::jsonb AND (jsonb_typeof(item->'predecessor')<>'string' OR length(btrim(item->>'predecessor'))=0)) THEN
      RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
    owner:=item->'owner';
    IF jsonb_typeof(owner) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
    IF NOT ((owner->>'scopeKind' IN ('record','story','worldline')) IS TRUE)
      OR owner->>'worldId' IS DISTINCT FROM p_plan->>'worldId' OR owner->>'worldlineId' IS DISTINCT FROM p_plan->>'worldlineId'
      OR jsonb_typeof(owner->'worldId') IS DISTINCT FROM 'string' OR jsonb_typeof(owner->'worldlineId') IS DISTINCT FROM 'string'
      OR NOT owner ?& ARRAY['scopeKind','worldId','worldlineId']
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(owner) key WHERE key NOT IN ('scopeKind','worldId','worldlineId',CASE owner->>'scopeKind' WHEN 'record' THEN 'recordId' WHEN 'story' THEN 'storyId' ELSE 'scopeKind' END)) THEN
      RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
    IF owner->>'scopeKind'='record' AND (jsonb_typeof(owner->'recordId') IS DISTINCT FROM 'string'
      OR NOT EXISTS(SELECT 1 FROM public.records WHERE workspace_id=p_workspace AND world_id=owner->>'worldId'
        AND worldline_id=owner->>'worldlineId' AND id=owner->>'recordId' AND (p_operation='restore-v3' OR status<>'archived'))) THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
    IF owner->>'scopeKind'='story' AND (jsonb_typeof(owner->'storyId') IS DISTINCT FROM 'string'
      OR NOT EXISTS(SELECT 1 FROM public.stories WHERE workspace_id=p_workspace AND world_id=owner->>'worldId'
        AND worldline_id=owner->>'worldlineId' AND id=owner->>'storyId')) THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
    PERFORM public.goal_content_source_assert(item->'source',owner->>'worldId');
    IF EXISTS(SELECT 1 FROM public.goal_instances WHERE workspace_id=p_workspace AND id=item->>'instanceId') THEN RAISE EXCEPTION 'GOAL_CONTENT_IDENTITY_CONFLICT'; END IF;
    IF p_operation IN ('materialize','clone') AND item->'predecessor'<>'null'::jsonb THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
    IF p_operation='clone' AND (owner->>'scopeKind'<>'record' OR NOT EXISTS(
      SELECT 1 FROM public.records target JOIN public.worldlines line ON line.workspace_id=target.workspace_id AND line.world_id=target.world_id AND line.id=target.worldline_id
      WHERE target.workspace_id=p_workspace AND target.id=owner->>'recordId' AND target.timeline_kind='branch'
        AND target.linked_record_id=source_record.id AND target.world_version=source_record.world_version
        AND line.parent_worldline_id=source_record.worldline_id AND line.fork_tick=COALESCE(source_head.last_world_tick,source_record.start_tick)
        AND line.fork_ordinal=COALESCE(source_head.last_world_ordinal,source_record.start_ordinal))) THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    INSERT INTO public.goal_content_write_admissions(workspace_id,world_id,worldline_id,goal_instance_id,scope_kind,record_id,story_id,
      principal_id,operation,transaction_id,body_commitment,plan_commitment,plan)
    VALUES(p_workspace,owner->>'worldId',owner->>'worldlineId',item->>'instanceId',owner->>'scopeKind',owner->>'recordId',owner->>'storyId',
      actor,p_operation,pg_current_xact_id(),p_body,plan_hash,p_plan);
  END LOOP;
  RETURN jsonb_build_object('actor',actor,'planCommitment',plan_hash);
END;
$$;
ALTER FUNCTION goal_content_write_prepare_v3(text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION goal_content_write_prepare_v3(text,text,text,text,jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION goal_content_write_prepare_v3(text,text,text,text,jsonb) TO realm_runtime;

CREATE OR REPLACE FUNCTION record_goal_restore_group_check(p_workspace text,p_record text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission public.record_goal_restore_admissions%ROWTYPE; member jsonb;
BEGIN
  SELECT * INTO admission FROM public.record_goal_restore_admissions WHERE workspace_id=p_workspace AND record_id=p_record;
  IF NOT FOUND OR admission.group_root IS NULL OR public.realm_current_workspace_id() IS DISTINCT FROM p_workspace
    OR admission.transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR admission.plan_commitment IS DISTINCT FROM encode(public.digest(admission.group_plan::text,'sha256'),'hex')
    OR NOT EXISTS(SELECT 1 FROM public.worlds WHERE workspace_id=p_workspace AND id=admission.world_id AND status='active')
    OR NOT EXISTS(SELECT 1 FROM public.player_world_memberships WHERE workspace_id=p_workspace AND world_id=admission.world_id
      AND principal_id=admission.principal_id AND role='owner') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF admission.group_plan->'bodyVersion' IN ('2'::jsonb,'3'::jsonb) AND NOT EXISTS(
    SELECT 1 FROM public.worldlines WHERE workspace_id=p_workspace AND world_id=admission.world_id
      AND id=admission.worldline_id AND status='active') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  FOR member IN SELECT value FROM jsonb_array_elements(admission.group_plan->'records') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.record_goal_restore_admissions sibling
      JOIN public.records record ON record.workspace_id=sibling.workspace_id AND record.id=sibling.record_id
      WHERE sibling.workspace_id=p_workspace AND sibling.record_id=member->>'recordId'
        AND sibling.group_root=admission.group_root AND sibling.group_plan=admission.group_plan
        AND sibling.plan_commitment=admission.plan_commitment AND sibling.body_commitment=admission.body_commitment
        AND sibling.operation=admission.operation AND sibling.transaction_id=admission.transaction_id
        AND sibling.principal_id=admission.principal_id AND sibling.world_id=admission.world_id
        AND sibling.worldline_id=admission.worldline_id AND sibling.source_record_id=member->>'sourceRecordId'
        AND record.world_id=admission.world_id AND record.worldline_id=admission.worldline_id
        AND record.story_id=sibling.target_story_id AND record.story_id=member->>'storyId'
        AND record.status=sibling.target_status AND record.status=member->>'status') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(admission.group_plan->'stories') planned
    WHERE NOT EXISTS(SELECT 1 FROM public.stories story WHERE story.workspace_id=p_workspace
      AND story.world_id=admission.world_id AND story.worldline_id=admission.worldline_id AND story.id=planned->>'storyId')) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF admission.operation='restore' THEN
    IF NOT EXISTS(SELECT 1 FROM public.records root JOIN public.stories story
      ON story.workspace_id=root.workspace_id AND story.id=root.story_id
      WHERE root.workspace_id=p_workspace AND root.id=admission.group_root
        AND story.premise=CASE admission.group_plan->>'bodyVersion' WHEN '3' THEN 'realm-save:body-v3:' WHEN '2' THEN 'realm-save:body-v2:' ELSE 'realm-save:body-v1:' END||admission.body_commitment) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.records record
      JOIN public.records source ON source.workspace_id=record.workspace_id AND source.id=record.linked_record_id
      JOIN public.stories story ON story.workspace_id=record.workspace_id AND story.id=record.story_id
      JOIN public.stories origin ON origin.workspace_id=source.workspace_id AND origin.id=source.story_id
      JOIN public.worldlines line ON line.workspace_id=record.workspace_id AND line.id=record.worldline_id
      JOIN public.record_heads head ON head.workspace_id=source.workspace_id AND head.record_id=source.id
      WHERE record.workspace_id=p_workspace AND record.id=p_record AND record.timeline_kind='branch'
        AND source.id=admission.group_plan#>>'{source,recordId}' AND source.world_id=record.world_id
        AND source.status<>'archived' AND source.world_version=record.world_version
        AND head.record_version=(admission.group_plan#>>'{source,recordVersion}')::bigint
        AND ((admission.group_plan->'bodyVersion' IS DISTINCT FROM '2'::jsonb AND admission.group_plan->'bodyVersion' IS DISTINCT FROM '3'::jsonb) OR head.next_record_ordinal=(admission.group_plan#>>'{source,nextRecordOrdinal}')::bigint)
        AND line.parent_worldline_id=source.worldline_id AND story.premise=origin.premise
        AND record.start_tick=line.fork_tick AND record.start_ordinal=line.fork_ordinal
        AND line.fork_tick=COALESCE(head.last_world_tick,source.start_tick)
        AND line.fork_ordinal=COALESCE(head.last_world_ordinal,source.start_ordinal)) THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
  END IF;
END;
$$;
ALTER FUNCTION record_goal_restore_group_check(text,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_check(text,text) FROM PUBLIC;

-- Pure projection of the *carried* V1 authored history into the same typed
-- representation checked for V2. No table/current-content lookup and no hash
-- replacement: the original sourceBody remains the body-v3 commitment.
CREATE FUNCTION performance_restore_legacy_goal_source(p_body jsonb)
RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE saved jsonb; doc jsonb; owner jsonb; g jsonb; d jsonb; a jsonb;
  roots jsonb:='[]'; instances jsonb; definitions jsonb:='[]'; assessments jsonb:='[]';
BEGIN
  FOR saved IN SELECT jsonb_build_object('record',p_body->'record','goals',p_body->'goals')
    UNION ALL SELECT r->'bundle' FROM jsonb_array_elements(p_body#>'{domain,records}') r LOOP
    doc:=saved->'goals';
    owner:=jsonb_build_object('scopeKind','record')||(saved#>'{record,scope}');
    IF doc->'schemaVersion' IS DISTINCT FROM '1'::jsonb
      OR jsonb_typeof(doc->'instances') IS DISTINCT FROM 'array'
      OR jsonb_typeof(doc->'assessments') IS DISTINCT FROM 'array'
      OR jsonb_typeof(COALESCE(doc->'definitions','[]'::jsonb)) IS DISTINCT FROM 'array'
      OR (SELECT count(*) FROM jsonb_array_elements(doc->'instances'))<>
        (SELECT count(DISTINCT listed_goal.value->>'id') FROM jsonb_array_elements(doc->'instances') AS listed_goal(value))
      OR (SELECT count(*) FROM jsonb_array_elements(doc->'assessments'))<>
        (SELECT count(DISTINCT listed_assessment.value->>'id') FROM jsonb_array_elements(doc->'assessments') AS listed_assessment(value))
      OR (SELECT count(*) FROM jsonb_array_elements(doc->'definitions'))<>
        (SELECT count(DISTINCT listed_definition.value->>'definitionId') FROM jsonb_array_elements(doc->'definitions') AS listed_definition(value))
      THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    instances:='[]';
    FOR g IN SELECT value FROM jsonb_array_elements(doc->'instances') LOOP
      SELECT value INTO STRICT d FROM jsonb_array_elements(doc->'definitions')
        WHERE value->>'definitionId'=g->>'definitionId' AND value->>'goalInstanceId'=g->>'id';
      IF g->>'definitionSource' IS DISTINCT FROM 'record' OR d->>'source' IS DISTINCT FROM 'record'
        OR (d->'scope') IS DISTINCT FROM (jsonb_build_object('workspaceId',p_body#>>'{manifest,scope,workspaceId}')||(saved#>'{record,scope}'))
        OR g->>'goalKey' IS DISTINCT FROM d->>'goalKey' OR g->>'policyVersion' IS DISTINCT FROM d->>'policyVersion'
        OR g->'evidenceStartVersion' IS DISTINCT FROM d#>'{activationHead,recordVersion}'
        OR g->'evidenceStartOrdinal' IS DISTINCT FROM d#>'{activationHead,ordinal}' THEN RAISE EXCEPTION 'GOAL_HISTORICAL_BINDING_UNRESOLVED'; END IF;
      instances:=instances||jsonb_build_array(jsonb_build_object(
        'ref',jsonb_build_object('owner',owner,'instanceId',g->'id'),
        'definition',jsonb_build_object('kind','record','definitionId',d->'definitionId','goalId',d->'goalId','definitionVersion',d->'definitionVersion'),
        'goalKey',g->'goalKey','policyVersion',g->'policyVersion','state',g->'state','revision',g->'revision',
        'progress',g->'progress','outcome',g->'outcome','attempt',COALESCE(g->'attempt','1'::jsonb),
        'predecessor',CASE WHEN g->>'supersedesInstanceId' IS NULL THEN 'null'::jsonb ELSE
          jsonb_build_object('kind','definition-revision','ref',jsonb_build_object('owner',owner,'instanceId',g->'supersedesInstanceId')) END,
        'resolutionKind',g->'resolutionKind','evidenceStart',jsonb_build_object('recordVersion',g->'evidenceStartVersion','ordinal',g->'evidenceStartOrdinal')));
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'definitions') AS listed_definition(value) WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(doc->'instances') AS listed_goal(value)
      WHERE listed_goal.value->>'definitionId'=listed_definition.value->>'definitionId'
        AND listed_goal.value->>'id'=listed_definition.value->>'goalInstanceId'))
      THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    IF jsonb_array_length(instances)>0 THEN
      roots:=roots||jsonb_build_array(jsonb_build_object('owner',owner,'instances',instances));
    END IF;
    definitions:=definitions||COALESCE(doc->'definitions','[]'::jsonb);
    FOR a IN SELECT value FROM jsonb_array_elements(doc->'assessments') LOOP
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'instances') AS listed_goal(value) WHERE listed_goal.value->>'id'=a->>'goalInstanceId'
        AND listed_goal.value->>'policyVersion'=a->>'policyVersion') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
      assessments:=assessments||jsonb_build_array(jsonb_build_object(
        'id',a->'id','goal',jsonb_build_object('owner',owner,'instanceId',a->'goalInstanceId'),
        'sourceEvent',(saved#>'{record,scope}')||jsonb_build_object('eventId',a->'sourceEventId'),
        'source',a->'source','status',a->'status','result',a->'result',
        'evidenceEvents',(SELECT COALESCE(jsonb_agg((saved#>'{record,scope}')||jsonb_build_object('eventId',e.value) ORDER BY e.pos),'[]'::jsonb)
          FROM jsonb_array_elements(a->'evidenceEventIds') WITH ORDINALITY e(value,pos)),
        'evidenceHead',COALESCE(a->'evidenceHead','null'::jsonb),'evidenceSnapshotHash',a->'evidenceSnapshotHash','policyVersion',a->'policyVersion'));
    END LOOP;
  END LOOP;
  RETURN jsonb_build_object('format','realm-runtime-goals','schemaVersion',2,'workspaceId',p_body#>>'{manifest,scope,workspaceId}',
    'roots',roots,'definitions',definitions,'assessments',assessments);
END;
$$;
ALTER FUNCTION performance_restore_legacy_goal_source(jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION performance_restore_legacy_goal_source(jsonb) FROM PUBLIC;

CREATE FUNCTION performance_restore_v3_plan_assert(p_workspace text,p_world text,p_plan jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE body jsonb; source_entry jsonb; target_entry jsonb; member jsonb; validation_plan jsonb;
BEGIN
  body:=(p_plan->>'sourceBody')::jsonb;
  IF body#>>'{performanceWitnesses,schemaVersion}' IS DISTINCT FROM '1'
    OR body#>>'{performanceWitnesses,format}' IS DISTINCT FROM 'realm-runtime-performance-witnesses'
    OR body#>'{manifest,performanceWitnessesFormat}' IS DISTINCT FROM jsonb_build_object('schemaVersion',1,'digest',
      encode(public.digest(convert_to('realm-runtime-performance-witnesses:v1','UTF8')||decode('00','hex')||
      convert_to(public.performance_transport_canonical(body->'performanceWitnesses'),'UTF8'),'sha256'),'hex'))
    OR jsonb_typeof(p_plan#>'{performanceWitnesses,witnesses}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(body#>'{performanceWitnesses,witnesses}')=0
    OR jsonb_array_length(body#>'{performanceWitnesses,witnesses}') IS DISTINCT FROM jsonb_array_length(p_plan#>'{performanceWitnesses,witnesses}')
    OR (SELECT count(DISTINCT e#>>'{projection,commandId}') FROM jsonb_array_elements(p_plan#>'{performanceWitnesses,witnesses}') e)
      <>jsonb_array_length(p_plan#>'{performanceWitnesses,witnesses}') THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_PROOF_REQUIRED'; END IF;
  FOR source_entry IN SELECT value FROM jsonb_array_elements(body#>'{performanceWitnesses,witnesses}') LOOP
    SELECT e INTO target_entry FROM jsonb_array_elements(p_plan#>'{performanceWitnesses,witnesses}') e
      WHERE e->'origin'=source_entry->'origin';
    IF NOT FOUND OR target_entry#>>'{projection,scope,workspaceId}' IS DISTINCT FROM p_workspace
      OR target_entry#>>'{projection,scope,worldId}' IS DISTINCT FROM p_world
      OR target_entry#>>'{projection,scope,worldlineId}' IS DISTINCT FROM p_plan->>'worldlineId'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(source_entry#>'{projection,relation,identities}') pair
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target_entry#>'{projection,relation,identities}') mapped
          WHERE mapped->>'kind'=pair->>'kind' AND mapped->>'originId'=pair->>'originId'))
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'records') r
        WHERE r->>'sourceRecordId'=source_entry#>>'{projection,recordId}' AND r->>'recordId'=target_entry#>>'{projection,recordId}')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'stories') r
        WHERE r->>'sourceStoryId'=source_entry#>>'{projection,storyId}' AND r->>'storyId'=target_entry#>>'{projection,storyId}') THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_PROOF_REQUIRED'; END IF;
  END LOOP;
  IF p_plan#>'{goals,schemaVersion}'='2'::jsonb THEN
    IF p_plan#>'{goals,schemaVersion}' IS DISTINCT FROM '2'::jsonb
      OR p_plan#>>'{goals,workspaceId}' IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    validation_plan:=p_plan;
    IF body#>'{goals,schemaVersion}'='1'::jsonb THEN
      -- A local validation view only; prepare still authenticates and persists
      -- the untouched complete legacy sourceBody under the V3 domain.
      validation_plan:=jsonb_set(p_plan,'{sourceBody}',to_jsonb(jsonb_set(body,'{goals}',public.performance_restore_legacy_goal_source(body))::text));
    END IF;
    -- The V2 pure checker compares each member's definition set in ID order.
    -- Keep the actual insertion plan parent-first for immediate predecessor
    -- guards; ordering this local validation view never pairs identities.
    validation_plan:=jsonb_set(validation_plan,'{records}',(SELECT jsonb_agg(
      jsonb_set(members.member,'{definitions}',(SELECT COALESCE(jsonb_agg(d ORDER BY d->>'definitionId'),'[]'::jsonb)
        FROM jsonb_array_elements(members.member->'definitions') d)) ORDER BY members.pos)
      FROM jsonb_array_elements(p_plan->'records') WITH ORDINALITY members(member,pos)));
    PERFORM public.goal_restore_v2_plan_assert(p_workspace,p_world,validation_plan);
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan#>'{goals,assessments}') a WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_plan#>'{goals,roots}') r,LATERAL jsonb_array_elements(r->'instances') g
        WHERE g->'ref'=a->'goal' AND g->>'policyVersion'=a->>'policyVersion')
      OR (a->'result' ? 'policyVersion' AND a#>'{result,policyVersion}' IS DISTINCT FROM a->'policyVersion')
      OR (a->'result' ? 'evidenceSnapshotHash' AND a#>'{result,evidenceSnapshotHash}' IS DISTINCT FROM a->'evidenceSnapshotHash')
      OR (a->'result' ? 'evidenceEventIds' AND a#>'{result,evidenceEventIds}' IS DISTINCT FROM
        (SELECT COALESCE(jsonb_agg(e->'eventId'),'[]'::jsonb) FROM jsonb_array_elements(a->'evidenceEvents') e)))
      THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  ELSE
    IF p_plan->'goals' IS DISTINCT FROM 'null'::jsonb OR body#>'{goals,schemaVersion}' IS DISTINCT FROM '1'::jsonb
      OR jsonb_typeof(p_plan->'legacyGoals') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_plan->'legacyGoals')<>jsonb_array_length(p_plan->'records') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    -- No unknown content source may enter the legacy path. Authored definitions
    -- still use the original group_definitions capability and semantic guards.
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(body#>'{goals,instances}') g WHERE g->>'definitionSource' IS DISTINCT FROM 'record')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(body#>'{domain,records}') r,LATERAL jsonb_array_elements(r#>'{bundle,goals,instances}') g
        WHERE g->>'definitionSource' IS DISTINCT FROM 'record') THEN RAISE EXCEPTION 'GOAL_HISTORICAL_BINDING_UNRESOLVED'; END IF;
    FOR member IN SELECT value FROM jsonb_array_elements(p_plan->'records') LOOP
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'legacyGoals') g WHERE g->>'recordId'=member->>'recordId'
        AND g->'goals'='[]'::jsonb AND g->'assessments'='[]'::jsonb AND member->'definitions'='[]'::jsonb)
        THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(public.performance_restore_legacy_goal_source(body)->'roots') r
      WHERE r->'instances'<>'[]'::jsonb) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  END IF;
END;
$$;
ALTER FUNCTION performance_restore_v3_plan_assert(text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION performance_restore_v3_plan_assert(text,text,jsonb) FROM PUBLIC;


CREATE FUNCTION record_goal_restore_group_prepare_v3(
  p_workspace text,p_proof text,p_world text,p_root text,p_hash text,p_body text,p_plan jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text; item jsonb; entry jsonb; pos integer; token text; line_id text;
  plan_hash text; source public.records%ROWTYPE; head public.record_heads%ROWTYPE;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_body IS NULL OR p_body !~ '^[a-f0-9]{64}$'
    OR p_root IS NULL OR p_plan IS NULL OR jsonb_typeof(p_plan) IS DISTINCT FROM 'object'
    -- Full 256 MiB archive body (including JSON string escaping), 64 MiB target
    -- Goals and typed maps/definitions; this is not the 16 MiB binding budget.
    OR octet_length(p_plan::text)>805306368 THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_plan) key WHERE key NOT IN ('operation','worldlineId','records','stories','source','bodyVersion','sourceBody','goals','mappings','performanceWitnesses','legacyGoals'))
    OR COALESCE(p_plan->>'operation','') NOT IN ('restore','branch')
    OR jsonb_typeof(p_plan->'records') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_plan->'stories') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF jsonb_array_length(p_plan->'records') NOT BETWEEN 1 AND 65
    OR jsonb_array_length(p_plan->'stories') NOT BETWEEN 1 AND 65 THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  -- The complete detached source, never an asserted digest or a key summary.
  IF p_plan->'bodyVersion' IS DISTINCT FROM '3'::jsonb
    OR jsonb_typeof(p_plan->'sourceBody') IS DISTINCT FROM 'string'
    OR p_body IS DISTINCT FROM encode(public.digest('realm-save:body-v3:'||(p_plan->>'sourceBody'),'sha256'),'hex')
    OR jsonb_typeof(p_plan->'mappings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  PERFORM public.performance_restore_v3_plan_assert(p_workspace,p_world,p_plan);
  -- A namespace reservation and membership revocation serialize on these locks.
  PERFORM 1 FROM public.worlds WHERE workspace_id=p_workspace AND id=p_world AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  -- The existing narrow capability owns the membership lock; do not grant
  -- membership UPDATE to the authoring role merely to acquire a row lock.
  PERFORM public.membership_assert_world_owner(p_workspace,p_world,actor);
  IF p_plan->>'operation'='restore' THEN
    IF p_root !~ '^record_restore_[a-f0-9]{24}$' OR p_plan ? 'source' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    token:=substring(p_root FROM 16);line_id:='worldline_restore_'||token;
  ELSE
    IF p_root !~ '^record_branch_[a-f0-9]{18}$' OR jsonb_array_length(p_plan->'records')<>1
      OR jsonb_array_length(p_plan->'stories')<>1 OR jsonb_typeof(p_plan->'source') IS DISTINCT FROM 'object'
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_plan->'source') key WHERE key NOT IN ('recordId','recordVersion','nextRecordOrdinal'))
      OR jsonb_typeof(p_plan#>'{source,recordVersion}') IS DISTINCT FROM 'number'
      OR COALESCE(p_plan#>>'{source,recordVersion}','') !~ '^(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    token:=substring(p_root FROM 15);line_id:='worldline_branch_'||token;
    SELECT * INTO source FROM public.records WHERE workspace_id=p_workspace AND id=p_plan#>>'{source,recordId}' FOR UPDATE;
    IF NOT FOUND OR source.world_id IS DISTINCT FROM p_world OR source.status='archived'
      OR p_plan#>>'{records,0,sourceRecordId}' IS DISTINCT FROM source.id THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    SELECT * INTO head FROM public.record_heads WHERE workspace_id=p_workspace AND record_id=source.id FOR UPDATE;
    IF NOT FOUND OR head.record_version IS DISTINCT FROM (p_plan#>>'{source,recordVersion}')::bigint
      OR head.next_record_ordinal IS DISTINCT FROM (p_plan#>>'{source,nextRecordOrdinal}')::bigint THEN RAISE EXCEPTION 'GOAL_BRANCH_HEAD_CHANGED'; END IF;
  END IF;
  IF p_plan->>'worldlineId' IS DISTINCT FROM line_id
    OR EXISTS(SELECT 1 FROM public.worldlines WHERE workspace_id=p_workspace AND id=line_id) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  pos:=0;
  FOR item IN SELECT value FROM jsonb_array_elements(p_plan->'stories') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) key WHERE key NOT IN ('sourceStoryId','storyId'))
      OR jsonb_typeof(item->'sourceStoryId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'storyId') IS DISTINCT FROM 'string'
      OR length(COALESCE(item->>'sourceStoryId','')) NOT BETWEEN 1 AND 256
      OR COALESCE(item->>'sourceStoryId','') !~ '^[A-Za-z0-9._:-]+$'
      OR (pos=0 AND item->>'storyId' IS DISTINCT FROM replace(p_root,'record_','story_'))
      OR (pos>0 AND (p_plan->>'operation'<>'restore' OR item->>'storyId' !~ ('^story_restore_'||token||'_[0-9]{1,2}$')))
      OR EXISTS(SELECT 1 FROM public.stories WHERE workspace_id=p_workspace AND id=item->>'storyId') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    pos:=pos+1;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'storyId') FROM jsonb_array_elements(p_plan->'stories'))<>pos
    OR (SELECT count(DISTINCT value->>'sourceStoryId') FROM jsonb_array_elements(p_plan->'stories'))<>pos THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  pos:=0;
  FOR item IN SELECT value FROM jsonb_array_elements(p_plan->'records') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) key WHERE key NOT IN ('sourceRecordId','recordId','storyId','status','definitions'))
      OR item->>'recordId' IS DISTINCT FROM (p_root||CASE WHEN pos=0 THEN '' ELSE '_s'||(pos-1)::text END)
      OR jsonb_typeof(item->'sourceRecordId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(item->'storyId') IS DISTINCT FROM 'string'
      OR length(COALESCE(item->>'sourceRecordId','')) NOT BETWEEN 1 AND 256
      OR COALESCE(item->>'sourceRecordId','') !~ '^[A-Za-z0-9._:-]+$'
      OR COALESCE(item->>'status','') NOT IN ('draft','active','closed','archived')
      OR (pos=0 AND item->>'status'<>'active')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'stories') story WHERE story->>'storyId'=item->>'storyId')
      OR EXISTS(SELECT 1 FROM public.records WHERE workspace_id=p_workspace AND id=item->>'recordId')
      OR jsonb_typeof(item->'definitions') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    IF jsonb_array_length(item->'definitions')>10000 OR octet_length((item->'definitions')::text)>16777216 THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
    pos:=pos+1;
  END LOOP;
  IF (SELECT count(DISTINCT value->>'sourceRecordId') FROM jsonb_array_elements(p_plan->'records'))<>pos THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  plan_hash:=encode(public.digest(p_plan::text,'sha256'),'hex');
  FOR entry IN SELECT value FROM jsonb_array_elements(p_plan->'records') LOOP
    INSERT INTO public.record_goal_restore_admissions(workspace_id,world_id,worldline_id,record_id,principal_id,archive_hash,transaction_id,
      group_root,operation,body_commitment,plan_commitment,group_plan,source_record_id,target_story_id,target_status)
    VALUES(p_workspace,p_world,line_id,entry->>'recordId',actor,p_hash,pg_current_xact_id(),
      p_root,p_plan->>'operation',p_body,plan_hash,p_plan,entry->>'sourceRecordId',entry->>'storyId',entry->>'status');
  END LOOP;
  RETURN jsonb_build_object('actor',actor,'planCommitment',plan_hash);
END;
$$;
ALTER FUNCTION record_goal_restore_group_prepare_v3(text,text,text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_prepare_v3(text,text,text,text,text,text,jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_goal_restore_group_prepare_v3(text,text,text,text,text,text,jsonb) TO realm_runtime;

CREATE FUNCTION goal_restore_v3_complete(p_workspace text,p_root text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission public.record_goal_restore_admissions%ROWTYPE; item jsonb; goal public.goal_instances%ROWTYPE; b jsonb;
BEGIN
  SELECT * INTO admission FROM public.record_goal_restore_admissions WHERE workspace_id=p_workspace AND record_id=p_root;
  IF NOT FOUND OR admission.group_plan->'bodyVersion' IS DISTINCT FROM '3'::jsonb THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  PERFORM public.record_goal_restore_group_check(p_workspace,p_root);
  FOR item IN SELECT g FROM jsonb_array_elements(admission.group_plan#>'{goals,roots}') r,LATERAL jsonb_array_elements(r->'instances') g LOOP
    SELECT * INTO goal FROM public.goal_instances WHERE workspace_id=p_workspace AND id=item#>>'{ref,instanceId}';
    IF NOT FOUND OR ROW(goal.world_id,goal.worldline_id,goal.scope_kind,goal.record_id,goal.story_id,goal.goal_key,goal.policy_version,goal.state,goal.revision,
      goal.attempt,goal.supersedes_instance_id,goal.definition_source,goal.definition_id,goal.resolution_kind,goal.evidence_start_version,goal.evidence_start_ordinal)
      IS DISTINCT FROM ROW(admission.world_id,admission.worldline_id,item#>>'{ref,owner,scopeKind}',item#>>'{ref,owner,recordId}',item#>>'{ref,owner,storyId}',item->>'goalKey',item->>'policyVersion',item->>'state',(item->>'revision')::bigint,
      (item->>'attempt')::integer,item#>>'{predecessor,ref,instanceId}',item#>>'{definition,kind}',item#>>'{definition,definitionId}',item->>'resolutionKind',COALESCE((item#>>'{evidenceStart,recordVersion}')::bigint,0),COALESCE((item#>>'{evidenceStart,ordinal}')::bigint,0))
      OR goal.progress IS DISTINCT FROM item->'progress' OR COALESCE(to_jsonb(goal.outcome),'null'::jsonb) IS DISTINCT FROM item->'outcome' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    IF goal.definition_source='content' THEN
      PERFORM public.goal_content_binding_assert(p_workspace,goal.id);
      b:=item#>'{definition,binding}';
      IF NOT EXISTS(SELECT 1 FROM public.goal_content_instance_bindings stored WHERE stored.workspace_id=p_workspace AND stored.goal_instance_id=goal.id
        AND stored.definition_hash=b->>'definitionHash' AND stored.source_kind=b#>>'{source,sourceKind}'
        AND stored.source_world_id=b#>>'{source,sourceWorldId}' AND stored.source_world_version=b#>>'{source,sourceWorldVersion}'
        AND stored.package_content_hash IS NOT DISTINCT FROM b#>>'{source,packageContentHash}'
        AND stored.base_revision IS NOT DISTINCT FROM b#>>'{source,baseRevision}' AND stored.base_content_hash IS NOT DISTINCT FROM b#>>'{source,baseContentHash}') THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(admission.group_plan#>'{goals,assessments}') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.goal_assessments a WHERE a.workspace_id=p_workspace AND a.world_id=admission.world_id
      AND a.worldline_id=admission.worldline_id AND a.record_id=item#>>'{goal,owner,recordId}' AND a.id=item->>'id'
      AND a.goal_instance_id=item#>>'{goal,instanceId}' AND a.source_event_id=item#>>'{sourceEvent,eventId}'
      AND a.assessment_job_id IS NULL AND a.source=item->>'source' AND a.status=item->>'status'
      AND a.result=item->'result' AND to_jsonb(a.evidence_event_ids)=(SELECT COALESCE(jsonb_agg(e->'eventId'),'[]'::jsonb) FROM jsonb_array_elements(item->'evidenceEvents') e)
      AND a.evidence_head_version IS NOT DISTINCT FROM (item#>>'{evidenceHead,recordVersion}')::bigint
      AND a.evidence_head_ordinal IS NOT DISTINCT FROM (item#>>'{evidenceHead,ordinal}')::bigint
      AND a.evidence_snapshot_hash=item->>'evidenceSnapshotHash' AND a.policy_version=item->>'policyVersion') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM public.goal_assessments WHERE workspace_id=p_workspace AND world_id=admission.world_id AND worldline_id=admission.worldline_id)
    <>jsonb_array_length(admission.group_plan#>'{goals,assessments}') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF (SELECT count(*) FROM public.goal_instances WHERE workspace_id=p_workspace AND world_id=admission.world_id AND worldline_id=admission.worldline_id)
    <>(SELECT count(*) FROM jsonb_array_elements(admission.group_plan#>'{goals,roots}') r,LATERAL jsonb_array_elements(r->'instances')) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
END;
$$;
ALTER FUNCTION goal_restore_v3_complete(text,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION goal_restore_v3_complete(text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION guard_goal_content_predecessor()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE goal public.goal_instances%ROWTYPE; previous public.goal_instances%ROWTYPE;
  admission public.goal_content_write_admissions%ROWTYPE; binding public.goal_content_instance_bindings%ROWTYPE;
  previous_binding public.goal_content_instance_bindings%ROWTYPE; cyclic boolean;
BEGIN
  IF TG_TABLE_NAME='goal_instances' THEN
    IF NEW.definition_source<>'content' THEN RETURN NEW; END IF;
    SELECT * INTO goal FROM public.goal_instances WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
  ELSE
    SELECT * INTO goal FROM public.goal_instances WHERE workspace_id=NEW.workspace_id AND id=NEW.goal_instance_id;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
  SELECT * INTO admission FROM public.goal_content_write_admissions WHERE workspace_id=goal.workspace_id AND goal_instance_id=goal.id;
  IF NOT FOUND OR admission.transaction_id IS DISTINCT FROM pg_current_xact_id() THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  PERFORM public.goal_content_binding_assert(goal.workspace_id,goal.id);
  SELECT * INTO binding FROM public.goal_content_instance_bindings WHERE workspace_id=goal.workspace_id AND goal_instance_id=goal.id;
  IF ROW(admission.world_id,admission.worldline_id,admission.scope_kind,admission.record_id,admission.story_id)
    IS DISTINCT FROM ROW(goal.world_id,goal.worldline_id,goal.scope_kind,goal.record_id,goal.story_id)
    OR NOT EXISTS(SELECT 1 FROM public.worlds WHERE workspace_id=goal.workspace_id AND id=goal.world_id AND status='active')
    OR NOT EXISTS(SELECT 1 FROM public.player_world_memberships WHERE workspace_id=goal.workspace_id AND world_id=goal.world_id AND principal_id=admission.principal_id AND role='owner') THEN
    RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  IF admission.operation='restore-v3' THEN
    PERFORM public.goal_restore_v3_complete(goal.workspace_id,admission.plan->>'restoreGroupRoot');
  END IF;
  IF admission.operation='restore-v2' THEN
    PERFORM public.goal_restore_v2_complete(goal.workspace_id,admission.plan->>'restoreGroupRoot');
  END IF;
  IF goal.attempt=1 THEN
    IF goal.supersedes_instance_id IS NOT NULL THEN RAISE EXCEPTION 'GOAL_CONTENT_PREDECESSOR_INVALID'; END IF;
  ELSE
    SELECT * INTO previous FROM public.goal_instances WHERE workspace_id=goal.workspace_id AND id=goal.supersedes_instance_id;
    IF NOT FOUND OR ROW(previous.world_id,previous.worldline_id,previous.scope_kind,previous.record_id,previous.story_id,previous.goal_key,previous.policy_version,previous.definition_source)
      IS DISTINCT FROM ROW(goal.world_id,goal.worldline_id,goal.scope_kind,goal.record_id,goal.story_id,goal.goal_key,goal.policy_version,'content'::text)
      OR previous.attempt+1<>goal.attempt OR previous.state NOT IN ('completed','failed','settled') OR previous.resolution_kind<>'natural' THEN
      RAISE EXCEPTION 'GOAL_CONTENT_PREDECESSOR_INVALID'; END IF;
    SELECT * INTO previous_binding FROM public.goal_content_instance_bindings WHERE workspace_id=goal.workspace_id AND goal_instance_id=previous.id;
    IF NOT FOUND OR ROW(previous_binding.source_kind,previous_binding.source_world_id,previous_binding.source_world_version,previous_binding.package_content_hash,
      previous_binding.base_revision,previous_binding.base_content_hash,previous_binding.definition_hash)
      IS DISTINCT FROM ROW(binding.source_kind,binding.source_world_id,binding.source_world_version,binding.package_content_hash,binding.base_revision,binding.base_content_hash,binding.definition_hash) THEN
      RAISE EXCEPTION 'GOAL_CONTENT_PREDECESSOR_INVALID'; END IF;
    WITH RECURSIVE ancestors AS (
      SELECT id,supersedes_instance_id,ARRAY[id] AS path,false AS cycle,1 AS depth FROM public.goal_instances WHERE workspace_id=goal.workspace_id AND id=goal.id
      UNION ALL SELECT parent.id,parent.supersedes_instance_id,child.path||parent.id,parent.id=ANY(child.path),child.depth+1
      FROM ancestors child JOIN public.goal_instances parent ON parent.workspace_id=goal.workspace_id AND parent.id=child.supersedes_instance_id
      WHERE NOT child.cycle AND child.depth<=10000
    ) SELECT COALESCE(bool_or(cycle OR depth>10000 OR (supersedes_instance_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.goal_instances parent WHERE parent.workspace_id=goal.workspace_id AND parent.id=ancestors.supersedes_instance_id))),false) INTO cyclic FROM ancestors;
    IF cyclic THEN RAISE EXCEPTION 'GOAL_CONTENT_PREDECESSOR_INVALID'; END IF;
  END IF;
  IF admission.operation='retry' AND goal.attempt=1 THEN RAISE EXCEPTION 'GOAL_CONTENT_PREDECESSOR_INVALID'; END IF;
  IF admission.operation='clone' THEN
    IF NOT EXISTS(SELECT 1 FROM public.records target JOIN public.records origin
      ON origin.workspace_id=target.workspace_id AND origin.id=target.linked_record_id AND origin.world_id=target.world_id
      JOIN public.record_heads head ON head.workspace_id=origin.workspace_id AND head.record_id=origin.id
      JOIN public.worldlines line ON line.workspace_id=target.workspace_id AND line.world_id=target.world_id AND line.id=target.worldline_id
      WHERE target.workspace_id=goal.workspace_id AND target.world_id=goal.world_id AND target.worldline_id=goal.worldline_id
        AND target.id=goal.record_id AND target.timeline_kind='branch' AND origin.id=admission.plan#>>'{source,recordId}'
        AND origin.status<>'archived' AND target.world_version=origin.world_version
        AND head.record_version=(admission.plan#>>'{source,recordVersion}')::bigint
        AND head.next_record_ordinal=(admission.plan#>>'{source,nextRecordOrdinal}')::bigint
        AND line.parent_worldline_id=origin.worldline_id AND line.fork_tick=COALESCE(head.last_world_tick,origin.start_tick)
        AND line.fork_ordinal=COALESCE(head.last_world_ordinal,origin.start_ordinal)) THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.goal_instances origin JOIN public.goal_content_instance_bindings proof
      ON proof.workspace_id=origin.workspace_id AND proof.goal_instance_id=origin.id
      WHERE origin.workspace_id=goal.workspace_id AND origin.world_id=goal.world_id AND origin.record_id=admission.plan#>>'{source,recordId}'
        AND origin.scope_kind='record' AND origin.goal_key=goal.goal_key AND origin.policy_version=goal.policy_version AND origin.attempt=1
        AND ROW(origin.state,origin.revision,origin.progress,origin.outcome,origin.completed_at) IS NOT DISTINCT FROM ROW(goal.state,goal.revision,goal.progress,goal.outcome,goal.completed_at)
        AND ROW(proof.source_kind,proof.source_world_id,proof.source_world_version,proof.package_content_hash,proof.base_revision,proof.base_content_hash,proof.definition_hash)
          IS NOT DISTINCT FROM ROW(binding.source_kind,binding.source_world_id,binding.source_world_version,binding.package_content_hash,binding.base_revision,binding.base_content_hash,binding.definition_hash)) THEN
      RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_goal_content_predecessor() OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION guard_goal_content_predecessor() FROM PUBLIC;

CREATE FUNCTION performance_restore_v3_mapped(p_entry jsonb,p_kind text,p_id text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE answer text;
BEGIN
  IF (SELECT count(*) FROM jsonb_array_elements(p_entry#>'{projection,relation,identities}') pair
    WHERE pair->>'kind'=p_kind AND pair->>'originId'=p_id)<>1 THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_RELATION'; END IF;
  SELECT pair->>'currentId' INTO answer FROM jsonb_array_elements(p_entry#>'{projection,relation,identities}') pair
    WHERE pair->>'kind'=p_kind AND pair->>'originId'=p_id;
  RETURN answer;
END;
$$;
ALTER FUNCTION performance_restore_v3_mapped(jsonb,text,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION performance_restore_v3_mapped(jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION performance_restore_v3_fact_assert(p_workspace text,p_entry jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE p jsonb:=p_entry->'projection'; s jsonb:=(p_entry#>>'{origin,witness,manifestCanonical}')::jsonb;
  h jsonb; m jsonb; line text:=p#>>'{scope,worldlineId}'; world text:=p#>>'{scope,worldId}';
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace OR p#>>'{scope,workspaceId}' IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_SCOPE'; END IF;
  FOR h IN SELECT value FROM jsonb_array_elements(jsonb_build_array(s->'headEvent')||(s->'evidence')||
    CASE WHEN s->'milestoneWitness'='null'::jsonb THEN '[]'::jsonb ELSE jsonb_build_array(s#>'{milestoneWitness,completionHeader}') END) LOOP
    IF NOT EXISTS(SELECT 1 FROM public.events event
      JOIN public.records record ON (record.workspace_id,record.world_id,record.worldline_id,record.id)=(event.workspace_id,event.world_id,event.worldline_id,event.record_id)
      JOIN public.record_heads head ON head.workspace_id=record.workspace_id AND head.record_id=record.id
      JOIN public.scenes scene ON (scene.workspace_id,scene.world_id,scene.worldline_id,scene.id)=(event.workspace_id,event.world_id,event.worldline_id,event.scene_id)
      JOIN public.visibility_policies policy ON (policy.workspace_id,policy.world_id,policy.worldline_id,policy.id)=(event.workspace_id,event.world_id,event.worldline_id,event.visibility_policy_id)
      WHERE event.workspace_id=p_workspace AND event.world_id=world AND event.worldline_id=line AND event.record_id=p->>'recordId'
        AND event.id=public.performance_restore_v3_mapped(p_entry,'event',h->>'id')
        AND event.scene_id=public.performance_restore_v3_mapped(p_entry,'scene',h->>'sceneId')
        AND event.visibility_policy_id=public.performance_restore_v3_mapped(p_entry,'policy',h->>'visibilityPolicyId')
        AND event.record_version::text=h->>'recordVersion' AND event.record_ordinal::text=h->>'recordOrdinal'
        AND event.world_tick::text=h->>'worldTick' AND event.world_ordinal::text=h->>'worldOrdinal'
        AND record.story_id=p->>'storyId' AND record.world_version=s#>>'{binding,worldVersion}'
        AND head.record_version>=(s#>>'{head,recordVersion}')::bigint AND head.next_record_ordinal>=(s#>>'{head,nextRecordOrdinal}')::bigint
        AND policy.policy_version::text=h->>'policyVersion' AND policy.policy_kind=h->>'policyKind'
        AND (NOT h ? 'sceneStartTick' OR (scene.start_tick::text=h->>'sceneStartTick' AND scene.start_ordinal::text=h->>'sceneStartOrdinal')))
      THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_FACT_MISMATCH'; END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.scenes WHERE workspace_id=p_workspace AND world_id=world AND worldline_id=line
    AND record_id=p->>'recordId' AND id=public.performance_restore_v3_mapped(p_entry,'scene',s#>>'{currentScene,id}')
    AND start_tick::text=s#>>'{currentScene,startTick}' AND start_ordinal::text=s#>>'{currentScene,startOrdinal}') THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_FACT_MISMATCH'; END IF;
  m:=s->'milestoneWitness';
  IF m<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM public.project_milestones milestone JOIN public.projects project
    ON (project.workspace_id,project.world_id,project.worldline_id,project.id)=(milestone.workspace_id,milestone.world_id,milestone.worldline_id,milestone.project_id)
    WHERE milestone.workspace_id=p_workspace AND milestone.world_id=world AND milestone.worldline_id=line
      AND milestone.id=public.performance_restore_v3_mapped(p_entry,'milestone',m->>'id')
      AND milestone.project_id=public.performance_restore_v3_mapped(p_entry,'project',m->>'projectId')
      AND milestone.status='completed' AND milestone.completion_record_id=p->>'recordId'
      AND milestone.completion_event_id=public.performance_restore_v3_mapped(p_entry,'event',m->>'completionEventId')) THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_FACT_MISMATCH'; END IF;
END;
$$;
ALTER FUNCTION performance_restore_v3_fact_assert(text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION performance_restore_v3_fact_assert(text,jsonb) FROM PUBLIC;

CREATE FUNCTION performance_restore_v3_complete(p_workspace text,p_root text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission public.record_goal_restore_admissions%ROWTYPE; e jsonb; item jsonb; saved jsonb;
BEGIN
  SELECT * INTO admission FROM public.record_goal_restore_admissions WHERE workspace_id=p_workspace AND record_id=p_root;
  IF NOT FOUND OR admission.group_plan->'bodyVersion' IS DISTINCT FROM '3'::jsonb THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_PROOF_REQUIRED'; END IF;
  PERFORM public.record_goal_restore_group_check(p_workspace,p_root);
  IF admission.group_plan#>'{goals,schemaVersion}'='2'::jsonb THEN
    PERFORM public.goal_restore_v3_complete(p_workspace,p_root);
  ELSE
    FOR item IN SELECT value FROM jsonb_array_elements(admission.group_plan->'legacyGoals') LOOP
      FOR saved IN SELECT value FROM jsonb_array_elements(item->'goals') LOOP
        IF NOT EXISTS(SELECT 1 FROM public.goal_instances g WHERE g.workspace_id=p_workspace AND g.world_id=admission.world_id
          AND g.worldline_id=admission.worldline_id AND g.record_id=item->>'recordId' AND g.id=saved->>'targetId'
          AND g.definition_source='record' AND g.definition_id=saved->>'definitionId' AND g.goal_key=saved->>'goalKey'
          AND g.state=saved->>'state' AND g.revision=(saved->>'revision')::bigint AND g.progress=saved->'progress'
          AND COALESCE(g.outcome,'null'::jsonb)=saved->'outcome' AND g.policy_version=saved->>'policyVersion') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
      END LOOP;
      -- Nonempty authored history now uses the shared typed V2 Goal plan and
      -- goal_restore_v3_complete above. This fallback is strictly empty.
      IF jsonb_array_length(item->'assessments')<>0 THEN RAISE EXCEPTION 'GOAL_HISTORICAL_BINDING_UNRESOLVED'; END IF;
      IF (SELECT count(*) FROM public.goal_instances WHERE workspace_id=p_workspace AND world_id=admission.world_id
        AND worldline_id=admission.worldline_id AND record_id=item->>'recordId')<>jsonb_array_length(item->'goals') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    END LOOP;
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(admission.group_plan#>'{performanceWitnesses,witnesses}') LOOP
    IF NOT EXISTS(SELECT 1 FROM public.performance_evidence_transport_provenance ledger
      JOIN public.committed_fact_commands c ON (c.workspace_id,c.world_id,c.worldline_id,c.id)=(ledger.workspace_id,ledger.world_id,ledger.worldline_id,ledger.command_id)
      JOIN public.performance_assessments a ON (a.workspace_id,a.world_id,a.worldline_id,a.id)=(ledger.workspace_id,ledger.world_id,ledger.worldline_id,ledger.assessment_id)
      WHERE ledger.workspace_id=p_workspace AND ledger.world_id=admission.world_id AND ledger.worldline_id=admission.worldline_id
        AND ledger.record_id=e#>>'{projection,recordId}' AND ledger.command_id=e#>>'{projection,commandId}' AND ledger.assessment_id=e#>>'{projection,assessmentId}'
        AND ledger.envelope_canonical=public.performance_transport_canonical(e) AND ledger.envelope_hash=e->>'digest'
        AND c.result_manifest->'request'=e#>'{projection,request}' AND c.result_manifest->'result'=e#>'{projection,result}'
        AND c.result_manifest->'performanceTransport'=jsonb_build_object('version',1,'digest',e->>'digest')
        AND c.request_fingerprint=e#>>'{projection,requestFingerprint}'
        AND a.record_id=ledger.record_id AND a.command_id=ledger.command_id AND a.score=(e#>>'{projection,assessment,score}')::integer
        AND a.evidence_snapshot_hash=e#>>'{projection,assessment,evidenceSnapshotHash}'
        AND to_jsonb(a.evidence_event_ids)=e#>'{projection,assessment,evidenceEventIds}') THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_INCOMPLETE'; END IF;
    PERFORM public.performance_restore_v3_fact_assert(p_workspace,e);
  END LOOP;
  IF (SELECT count(*) FROM public.performance_evidence_transport_provenance WHERE workspace_id=p_workspace
    AND world_id=admission.world_id AND worldline_id=admission.worldline_id)
      <>jsonb_array_length(admission.group_plan#>'{performanceWitnesses,witnesses}') THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_INCOMPLETE'; END IF;
END;
$$;
ALTER FUNCTION performance_restore_v3_complete(text,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION performance_restore_v3_complete(text,text) FROM PUBLIC;


CREATE FUNCTION record_goal_restore_group_replay_v3(p_workspace text,p_proof text,p_world text,p_root text,p_body text,p_plan jsonb)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text; admission public.record_goal_restore_admissions%ROWTYPE;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  PERFORM 1 FROM public.worlds WHERE workspace_id=p_workspace AND id=p_world AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  PERFORM public.membership_assert_world_owner(p_workspace,p_world,actor);
  SELECT * INTO admission FROM public.record_goal_restore_admissions WHERE workspace_id=p_workspace AND record_id=p_root;
  IF NOT FOUND OR admission.principal_id IS DISTINCT FROM actor OR admission.world_id IS DISTINCT FROM p_world
    OR admission.group_plan->'bodyVersion' IS DISTINCT FROM '3'::jsonb OR admission.group_plan IS DISTINCT FROM p_plan
    OR admission.body_commitment IS DISTINCT FROM p_body OR admission.plan_commitment IS DISTINCT FROM encode(public.digest(p_plan::text,'sha256'),'hex')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'records') member WHERE NOT EXISTS(SELECT 1 FROM public.record_goal_restore_admissions sibling JOIN public.records record
      ON record.workspace_id=sibling.workspace_id AND record.id=sibling.record_id WHERE sibling.workspace_id=p_workspace AND sibling.record_id=member->>'recordId'
        AND sibling.group_root=p_root AND sibling.group_plan=p_plan AND sibling.principal_id=actor AND sibling.transaction_id=admission.transaction_id
        AND record.world_id=admission.world_id AND record.worldline_id=admission.worldline_id AND record.story_id=sibling.target_story_id)) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF p_body IS DISTINCT FROM encode(public.digest('realm-save:body-v3:'||(p_plan->>'sourceBody'),'sha256'),'hex') THEN RAISE EXCEPTION 'PERFORMANCE_RESTORE_PROOF_REQUIRED'; END IF;
  RETURN actor;
END;
$$;
ALTER FUNCTION record_goal_restore_group_replay_v3(text,text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_replay_v3(text,text,text,text,text,jsonb) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_goal_restore_group_replay_v3(text,text,text,text,text,jsonb) TO realm_runtime;

CREATE FUNCTION guard_performance_restore_v3_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET realm.workspace_id='' AS $$
DECLARE ws text; line text; root text;
BEGIN
  ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  IF TG_TABLE_NAME='worldlines' THEN line:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE line:=CASE WHEN TG_OP='DELETE' THEN OLD.worldline_id ELSE NEW.worldline_id END; END IF;
  PERFORM set_config('realm.workspace_id',ws,true);
  SELECT group_root INTO root FROM public.record_goal_restore_admissions WHERE workspace_id=ws AND worldline_id=line
    AND transaction_id=pg_current_xact_id() AND group_plan->'bodyVersion'='3'::jsonb LIMIT 1;
  IF FOUND THEN PERFORM public.performance_restore_v3_complete(ws,root); END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_performance_restore_v3_complete() OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION guard_performance_restore_v3_complete() FROM PUBLIC;


CREATE CONSTRAINT TRIGGER performance_v3_record_goal_restore_admissions_complete AFTER INSERT OR UPDATE OR DELETE ON record_goal_restore_admissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

CREATE CONSTRAINT TRIGGER performance_v3_provenance_complete AFTER INSERT OR UPDATE OR DELETE ON performance_evidence_transport_provenance
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

CREATE CONSTRAINT TRIGGER performance_v3_committed_fact_commands_complete AFTER INSERT OR UPDATE OR DELETE ON committed_fact_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

CREATE CONSTRAINT TRIGGER performance_v3_performance_assessments_complete AFTER INSERT OR UPDATE OR DELETE ON performance_assessments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

CREATE CONSTRAINT TRIGGER performance_v3_goal_instances_complete AFTER INSERT OR UPDATE OR DELETE ON goal_instances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

CREATE CONSTRAINT TRIGGER performance_v3_goal_assessments_complete AFTER INSERT OR UPDATE OR DELETE ON goal_assessments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

CREATE CONSTRAINT TRIGGER performance_v3_worldlines_complete AFTER INSERT OR UPDATE OR DELETE ON worldlines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

CREATE CONSTRAINT TRIGGER performance_v3_stories_complete AFTER INSERT OR UPDATE OR DELETE ON stories
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

CREATE CONSTRAINT TRIGGER performance_v3_records_complete AFTER INSERT OR UPDATE OR DELETE ON records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();

-- Requeue immutable header/prefix validation after an early constraint check.
-- Later gameplay has a different xid and never reopens this restore admission.
CREATE CONSTRAINT TRIGGER performance_v3_events_complete AFTER INSERT OR UPDATE OR DELETE ON events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();
CREATE CONSTRAINT TRIGGER performance_v3_scenes_complete AFTER INSERT OR UPDATE OR DELETE ON scenes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();
CREATE CONSTRAINT TRIGGER performance_v3_visibility_policies_complete AFTER INSERT OR UPDATE OR DELETE ON visibility_policies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();
CREATE CONSTRAINT TRIGGER performance_v3_record_heads_complete AFTER INSERT OR UPDATE OR DELETE ON record_heads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();
CREATE CONSTRAINT TRIGGER performance_v3_projects_complete AFTER INSERT OR UPDATE OR DELETE ON projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();
CREATE CONSTRAINT TRIGGER performance_v3_project_milestones_complete AFTER INSERT OR UPDATE OR DELETE ON project_milestones
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_performance_restore_v3_complete();
