-- Worker-only logical capability: exact live assessment lease + predecessor/head/basis.
-- No browser operation or direct runtime INSERT grant is added.
GRANT SELECT ON events,goal_assessment_jobs,goal_assessments TO realm_goal_authoring;
GRANT UPDATE ON goal_assessment_jobs TO realm_goal_authoring;

CREATE FUNCTION record_goal_evolve(p_workspace text,p_job text,p_owner text,p_attempt integer,p_definition jsonb,p_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  j public.goal_assessment_jobs%ROWTYPE;
  r public.records%ROWTYPE;
  w public.worlds%ROWTYPE;
  l public.worldlines%ROWTYPE;
  h public.record_heads%ROWTYPE;
  g public.goal_instances%ROWTYPE;
  cached public.record_goal_commands%ROWTYPE;
  old_document jsonb;
  bound_scope jsonb;
  basis text;
  policy_id text;
  scene_id text;
  command_key text;
  fingerprint text;
  event_id text;
  result jsonb;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  SELECT * INTO j FROM public.goal_assessment_jobs WHERE workspace_id=p_workspace AND id=p_job FOR UPDATE;
  IF NOT FOUND OR p_owner IS NULL OR j.state IS DISTINCT FROM 'running' OR j.lease_owner IS DISTINCT FROM p_owner
    OR j.attempt_count IS DISTINCT FROM p_attempt OR j.lease_expires_at IS NULL OR j.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'GOAL_STALE_LEASE';
  END IF;
  SELECT * INTO w FROM public.worlds WHERE workspace_id=p_workspace AND id=j.world_id FOR KEY SHARE;
  IF NOT FOUND OR w.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'GOAL_READ_ONLY'; END IF;
  SELECT * INTO r FROM public.records WHERE workspace_id=p_workspace AND world_id=j.world_id
    AND worldline_id=j.worldline_id AND id=j.record_id FOR UPDATE;
  IF NOT FOUND OR r.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'GOAL_READ_ONLY'; END IF;
  IF r.world_version IS DISTINCT FROM '0.0.0-local' THEN RAISE EXCEPTION 'GOAL_AUTHORING_POLICY_REQUIRED'; END IF;
  SELECT * INTO l FROM public.worldlines WHERE workspace_id=p_workspace AND world_id=j.world_id AND id=j.worldline_id FOR UPDATE;
  IF NOT FOUND OR l.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'GOAL_READ_ONLY'; END IF;
  command_key:='evolve:'||encode(public.digest(convert_to(p_job,'UTF8'),'sha256'),'hex');
  fingerprint:=encode(public.digest(convert_to(p_definition::text,'UTF8'),'sha256'),'hex');
  SELECT * INTO cached FROM public.record_goal_commands WHERE workspace_id=p_workspace AND world_id=j.world_id
    AND worldline_id=j.worldline_id AND record_id=j.record_id AND principal_id='engine:goal-worker' AND idempotency_key=command_key;
  IF FOUND THEN
    IF cached.request_fingerprint IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'GOAL_IDEMPOTENCY_KEY_REUSED'; END IF;
    RETURN cached.result||jsonb_build_object('status','replayed');
  END IF;
  SELECT * INTO h FROM public.record_heads WHERE workspace_id=p_workspace AND world_id=j.world_id
    AND worldline_id=j.worldline_id AND record_id=j.record_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_HEAD_UNAVAILABLE'; END IF;
  SELECT * INTO g FROM public.goal_instances WHERE workspace_id=p_workspace AND world_id=j.world_id
    AND worldline_id=j.worldline_id AND record_id=j.record_id AND id=j.goal_instance_id FOR UPDATE;
  IF NOT FOUND OR g.definition_source IS DISTINCT FROM 'record' OR g.state NOT IN ('active','completed','failed','settled')
    OR g.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'GOAL_WRITE_CONFLICT'; END IF;
  IF g.state<>'active' AND (g.resolution_kind IS DISTINCT FROM 'natural' OR NOT EXISTS (
    SELECT 1 FROM public.events transition JOIN public.goal_assessments assessment
      ON assessment.workspace_id=transition.workspace_id AND assessment.world_id=transition.world_id
      AND assessment.worldline_id=transition.worldline_id AND assessment.record_id=transition.record_id
    WHERE transition.workspace_id=p_workspace AND transition.id='goal-transition:'||j.id||':'||j.attempt_count::text
      AND transition.id=h.last_event_id AND transition.event_kind='goal.transition.committed'
      AND transition.payload#>>'{__realmRuntimePayload,goalInstanceId}'=g.id
      AND transition.payload#>>'{__realmRuntimePayload,to}'=g.state
      AND transition.payload#>>'{__realmRuntimePayload,revision}'=g.revision::text
      AND assessment.id='goal-assessment:'||j.id||':'||j.attempt_count::text
      AND assessment.assessment_job_id=j.id AND assessment.status='accepted'
      AND assessment.goal_instance_id=g.id AND assessment.source_event_id=j.source_event_id AND assessment.policy_version=g.policy_version
  )) THEN RAISE EXCEPTION 'GOAL_SUCCESSOR_REQUIRES_NATURAL_TERMINAL'; END IF;
  SELECT definition INTO old_document FROM public.record_goal_definitions WHERE workspace_id=p_workspace AND world_id=j.world_id
    AND worldline_id=j.worldline_id AND record_id=j.record_id AND id=g.definition_id;
  IF old_document#>>'{draft,changePolicy}' IS DISTINCT FROM 'evolving' THEN RAISE EXCEPTION 'GOAL_FIXED'; END IF;
  bound_scope:=jsonb_build_object('workspaceId',p_workspace,'worldId',j.world_id,'worldlineId',j.worldline_id,'recordId',j.record_id);
  IF p_definition IS NULL OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object' OR length(p_definition::text)>131072
    OR p_definition->'scope' IS DISTINCT FROM bound_scope OR p_definition->>'source' IS DISTINCT FROM 'record'
    OR p_definition->>'changeKind' IS DISTINCT FROM 'automatic'
    OR p_definition->>'goalId' IS DISTINCT FROM old_document->>'goalId'
    OR p_definition->>'supersedesDefinitionId' IS DISTINCT FROM g.definition_id
    OR (p_definition->>'definitionVersion')::integer IS DISTINCT FROM (old_document->>'definitionVersion')::integer+1
    OR p_definition#>>'{draft,changePolicy}' IS DISTINCT FROM 'evolving'
    OR p_definition#>'{draft,visible}' IS DISTINCT FROM old_document#>'{draft,visible}'
    OR p_definition->'draft' IS NOT DISTINCT FROM old_document->'draft'
    OR p_definition->>'changeReason' IS NULL OR length(btrim(p_definition->>'changeReason')) NOT BETWEEN 1 AND 2048
    OR p_definition->'activationHead' IS DISTINCT FROM jsonb_build_object('recordVersion',h.record_version,'ordinal',h.next_record_ordinal-1)
    OR jsonb_typeof(p_definition->'basisEventIds') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_EVOLUTION_INVALID'; END IF;
  IF jsonb_array_length(p_definition->'basisEventIds') NOT BETWEEN 1 AND 16
    OR NOT (p_definition->'basisEventIds' ? j.source_event_id)
    OR (SELECT count(DISTINCT value) FROM jsonb_array_elements_text(p_definition->'basisEventIds'))<>jsonb_array_length(p_definition->'basisEventIds') THEN
    RAISE EXCEPTION 'GOAL_EVOLUTION_EVIDENCE_INVALID';
  END IF;
  FOR basis IN SELECT jsonb_array_elements_text(p_definition->'basisEventIds') LOOP
    IF NOT EXISTS (SELECT 1 FROM public.events event JOIN public.visibility_policies policy
      ON policy.workspace_id=event.workspace_id AND policy.world_id=event.world_id AND policy.worldline_id=event.worldline_id
      AND policy.record_id=event.record_id AND policy.id=event.visibility_policy_id
      WHERE event.workspace_id=p_workspace AND event.world_id=j.world_id AND event.worldline_id=j.worldline_id AND event.record_id=j.record_id
        AND event.id=basis AND event.event_kind IN ('narration.committed','world.consequence.committed','action.resolved','scene.crystallized')
        AND event.record_version>(old_document#>>'{activationHead,recordVersion}')::bigint
        AND event.record_ordinal>(old_document#>>'{activationHead,ordinal}')::bigint
        AND event.record_version<=h.record_version AND event.record_ordinal<h.next_record_ordinal
        AND ((old_document#>>'{draft,visible}')::boolean IS FALSE OR policy.policy_kind='public')) THEN
      RAISE EXCEPTION 'GOAL_EVOLUTION_EVIDENCE_INVALID';
    END IF;
  END LOOP;
  IF h.record_version>=9007199254740991 OR h.next_record_ordinal>=9007199254740991 OR l.head_ordinal>=9007199254740991 THEN
    RAISE EXCEPTION 'GOAL_CURSOR_INVALID';
  END IF;
  SELECT id INTO scene_id FROM public.scenes WHERE workspace_id=p_workspace AND world_id=j.world_id
    AND worldline_id=j.worldline_id AND record_id=j.record_id ORDER BY start_tick DESC,start_ordinal DESC,id ASC LIMIT 1;
  SELECT id INTO policy_id FROM public.visibility_policies WHERE workspace_id=p_workspace AND world_id=j.world_id
    AND worldline_id=j.worldline_id AND record_id=j.record_id AND policy_kind='public' ORDER BY policy_version,id LIMIT 1;
  IF scene_id IS NULL OR policy_id IS NULL THEN RAISE EXCEPTION 'GOAL_CONTEXT_UNAVAILABLE'; END IF;
  event_id:='goal-evolution:'||encode(public.digest(convert_to(jsonb_build_array(p_workspace,p_job)::text,'UTF8'),'sha256'),'hex');
  IF (old_document#>>'{draft,visible}')::boolean IS NOT TRUE THEN
    policy_id:='goal-policy:'||event_id;
    INSERT INTO public.visibility_policies(workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_kind)
      VALUES(p_workspace,j.world_id,j.worldline_id,j.record_id,policy_id,event_id,'dm_only');
  END IF;
  IF g.state='active' THEN
    UPDATE public.goal_instances SET state='settled',resolution_kind='superseded',revision=revision+1,
      completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,outcome=NULL WHERE workspace_id=p_workspace AND id=g.id;
  END IF;
  INSERT INTO public.record_goal_definitions(workspace_id,world_id,worldline_id,record_id,id,goal_id,definition_version,goal_key,policy_version,definition,supersedes_definition_id,created_by_principal_id)
    VALUES(p_workspace,j.world_id,j.worldline_id,j.record_id,p_definition->>'definitionId',p_definition->>'goalId',(p_definition->>'definitionVersion')::integer,
      p_definition->>'goalKey',p_definition->>'policyVersion',p_definition,p_definition->>'supersedesDefinitionId','engine:goal-worker');
  INSERT INTO public.goal_instances(workspace_id,world_id,worldline_id,record_id,id,goal_key,policy_version,definition_source,definition_id,evidence_start_version,evidence_start_ordinal,state,revision,attempt,supersedes_instance_id)
    VALUES(p_workspace,j.world_id,j.worldline_id,j.record_id,p_definition->>'goalInstanceId',p_definition->>'goalKey',p_definition->>'policyVersion','record',p_definition->>'definitionId',
      h.record_version,h.next_record_ordinal-1,'active',1,1,g.id);
  INSERT INTO public.events(workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,
    actor_participant_id,speaker_name,content,payload,visibility_policy_id,world_tick,world_ordinal,calendar_id,display_time)
    VALUES(p_workspace,j.world_id,j.worldline_id,j.record_id,scene_id,event_id,h.record_version+1,h.next_record_ordinal,0,'goal.transition.committed',
      NULL,'','Record goal evolved',jsonb_build_object('__realmRuntimePayload',jsonb_build_object('operation','evolve',
        'goalInstanceId',CASE WHEN g.state='active' THEN g.id ELSE p_definition->>'goalInstanceId' END,
        'goalKey',CASE WHEN g.state='active' THEN g.goal_key ELSE p_definition->>'goalKey' END,
        'from',CASE WHEN g.state='active' THEN 'active' ELSE NULL END,'to',CASE WHEN g.state='active' THEN 'settled' ELSE 'active' END,
        'revision',CASE WHEN g.state='active' THEN g.revision+1 ELSE 1 END,
        'resolutionKind',CASE WHEN g.state='active' THEN 'superseded' ELSE NULL END,'successorGoalInstanceId',p_definition->>'goalInstanceId',
        'predecessorGoalInstanceId',g.id,
        'definitionVersion',(p_definition->>'definitionVersion')::integer,'reason',p_definition->>'changeReason','basisEventIds',p_definition->'basisEventIds')),
      policy_id,l.head_tick,l.head_ordinal+1,w.calendar_id,COALESCE(w.settings->>'displayTime',''));
  UPDATE public.record_heads SET record_version=h.record_version+1,next_record_ordinal=h.next_record_ordinal+1,last_event_id=event_id,
    last_world_tick=l.head_tick,last_world_ordinal=l.head_ordinal+1,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=p_workspace AND record_id=j.record_id;
  UPDATE public.worldlines SET head_ordinal=l.head_ordinal+1,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=p_workspace AND id=j.worldline_id;
  result:=jsonb_build_object('status','committed','operation','evolve','goalInstanceId',p_definition->>'goalInstanceId','definitionId',p_definition->>'definitionId',
    'definitionVersion',(p_definition->>'definitionVersion')::integer,'eventId',event_id,'recordVersion',h.record_version+1,'ordinal',h.next_record_ordinal);
  INSERT INTO public.record_goal_commands(workspace_id,world_id,worldline_id,record_id,principal_id,idempotency_key,request_fingerprint,operation,goal_instance_id,result)
    VALUES(p_workspace,j.world_id,j.worldline_id,j.record_id,'engine:goal-worker',command_key,fingerprint,'evolve',p_definition->>'goalInstanceId',result);
  PERFORM pg_catalog.pg_notify('record_committed',jsonb_build_object('workspaceId',p_workspace,'recordId',j.record_id,'nextOrdinal',h.next_record_ordinal+1)::text);
  RETURN result;
END;
$$;
ALTER FUNCTION record_goal_evolve(text,text,text,integer,jsonb,bigint) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_evolve(text,text,text,integer,jsonb,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_evolve(text,text,text,integer,jsonb,bigint) TO realm_runtime;
