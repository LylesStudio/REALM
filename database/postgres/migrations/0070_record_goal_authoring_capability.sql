-- Browser authoring uses a proof-bound capability, never table INSERT or an owner pool.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='realm_goal_authoring') THEN
    CREATE ROLE realm_goal_authoring NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
ALTER ROLE realm_goal_authoring NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO realm_goal_authoring;
GRANT SELECT ON worlds, records, worldlines, record_heads, scenes, visibility_policies,
  goal_instances, record_goal_definitions, record_goal_commands TO realm_goal_authoring;
GRANT UPDATE ON worlds, records, worldlines, record_heads, goal_instances TO realm_goal_authoring;
GRANT INSERT ON record_goal_definitions, record_goal_commands, goal_instances, events, visibility_policies TO realm_goal_authoring;
GRANT SELECT, INSERT ON visibility_policy_audiences TO realm_goal_authoring;
GRANT EXECUTE ON FUNCTION realm_capability_session_actor(text,text), membership_assert_world_owner(text,text,text) TO realm_goal_authoring;
REVOKE INSERT ON record_goal_definitions, record_goal_commands FROM realm_runtime;

CREATE FUNCTION record_goal_manage(p_proof text,p_workspace text,p_record text,p_key text,p_request jsonb,p_definition jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  v_actor text;
  v_record public.records%ROWTYPE;
  v_world public.worlds%ROWTYPE;
  v_line public.worldlines%ROWTYPE;
  v_head public.record_heads%ROWTYPE;
  v_cached public.record_goal_commands%ROWTYPE;
  v_previous public.goal_instances%ROWTYPE;
  v_old_definition jsonb;
  v_definition jsonb;
  v_fingerprint text;
  v_event text;
  v_scene text;
  v_policy text;
  v_result jsonb;
  v_scope jsonb;
  v_version bigint;
  v_ordinal bigint;
  v_operation text;
  v_resolution text;
  v_goal_id text;
  v_revision bigint;
  v_event_payload jsonb;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  v_actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  v_operation:=p_request->>'operation';
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9._:-]{1,128}$' OR v_operation IS NULL OR v_operation NOT IN ('create','revise','withdraw')
    OR p_request->>'recordId' IS DISTINCT FROM p_record OR jsonb_typeof(p_request) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GOAL_COMMAND_INVALID'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_request) AS field(key) WHERE key<>ALL(
    CASE v_operation WHEN 'create' THEN ARRAY['operation','recordId','expectedHead','draft']
      WHEN 'revise' THEN ARRAY['operation','recordId','expectedHead','draft','goalInstanceId','expectedInstanceRevision','expectedDefinitionVersion','reason']
      ELSE ARRAY['operation','recordId','expectedHead','goalInstanceId','expectedInstanceRevision','expectedDefinitionVersion','reason'] END
  )) THEN RAISE EXCEPTION 'GOAL_COMMAND_INVALID'; END IF;
  SELECT * INTO v_record FROM public.records WHERE workspace_id=p_workspace AND id=p_record;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_NOT_FOUND'; END IF;
  -- Actor and owner-row lock are independently verified inside the write transaction.
  BEGIN
    PERFORM public.membership_assert_world_owner(p_workspace,v_record.world_id,v_actor);
  EXCEPTION WHEN raise_exception THEN RAISE EXCEPTION 'GOAL_FORBIDDEN'; END;
  SELECT * INTO v_world FROM public.worlds WHERE workspace_id=p_workspace AND id=v_record.world_id FOR KEY SHARE;
  IF v_world.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'GOAL_READ_ONLY'; END IF;
  SELECT * INTO v_record FROM public.records WHERE workspace_id=p_workspace AND id=p_record FOR UPDATE;
  IF v_record.world_id IS DISTINCT FROM v_world.id THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  IF v_record.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'GOAL_READ_ONLY'; END IF;
  -- Installed stories need an explicit package policy; native authoring cannot bypass them.
  IF v_record.world_version IS DISTINCT FROM '0.0.0-local' THEN RAISE EXCEPTION 'GOAL_AUTHORING_POLICY_REQUIRED'; END IF;
  SELECT * INTO v_line FROM public.worldlines WHERE workspace_id=p_workspace AND world_id=v_record.world_id AND id=v_record.worldline_id FOR UPDATE;
  IF NOT FOUND OR v_line.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'GOAL_READ_ONLY'; END IF;
  v_fingerprint:=encode(public.digest(convert_to(p_request::text,'UTF8'),'sha256'),'hex');
  SELECT * INTO v_cached FROM public.record_goal_commands WHERE workspace_id=p_workspace AND world_id=v_record.world_id
    AND worldline_id=v_record.worldline_id AND record_id=p_record AND principal_id=v_actor AND idempotency_key=p_key;
  IF FOUND THEN
    IF v_cached.request_fingerprint IS DISTINCT FROM v_fingerprint THEN RAISE EXCEPTION 'GOAL_IDEMPOTENCY_KEY_REUSED'; END IF;
    RETURN v_cached.result||jsonb_build_object('status','replayed');
  END IF;
  SELECT * INTO v_head FROM public.record_heads WHERE workspace_id=p_workspace AND world_id=v_record.world_id
    AND worldline_id=v_record.worldline_id AND record_id=p_record FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_HEAD_UNAVAILABLE'; END IF;
  IF jsonb_typeof(p_request#>'{expectedHead,recordVersion}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_request#>'{expectedHead,ordinal}') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'GOAL_COMMAND_INVALID'; END IF;
  v_version:=(p_request#>>'{expectedHead,recordVersion}')::bigint;
  v_ordinal:=(p_request#>>'{expectedHead,ordinal}')::bigint;
  IF v_version<0 OR v_ordinal<0 OR v_version>9007199254740990 OR v_ordinal>9007199254740990 OR ((v_version=0)<>(v_ordinal=0)) THEN RAISE EXCEPTION 'GOAL_COMMAND_INVALID'; END IF;
  IF v_version IS DISTINCT FROM v_head.record_version OR v_ordinal IS DISTINCT FROM GREATEST(0,v_head.next_record_ordinal-1) THEN RAISE EXCEPTION 'GOAL_WRITE_CONFLICT'; END IF;
  IF v_line.head_tick<0 OR v_line.head_tick>9007199254740991 OR v_line.head_ordinal<0 OR v_line.head_ordinal>9007199254740990 THEN RAISE EXCEPTION 'GOAL_CURSOR_INVALID'; END IF;
  v_scope:=jsonb_build_object('workspaceId',p_workspace,'worldId',v_record.world_id,'worldlineId',v_record.worldline_id,'recordId',p_record);
  IF v_operation<>'create' THEN
    SELECT * INTO v_previous FROM public.goal_instances WHERE workspace_id=p_workspace AND world_id=v_record.world_id
      AND worldline_id=v_record.worldline_id AND record_id=p_record AND id=p_request->>'goalInstanceId' AND definition_source='record' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_NOT_FOUND'; END IF;
    SELECT definition INTO v_old_definition FROM public.record_goal_definitions WHERE workspace_id=p_workspace AND world_id=v_record.world_id
      AND worldline_id=v_record.worldline_id AND record_id=p_record AND id=v_previous.definition_id;
    IF v_previous.state IS DISTINCT FROM 'active' OR v_previous.revision IS DISTINCT FROM (p_request->>'expectedInstanceRevision')::bigint
      OR (v_old_definition->>'definitionVersion')::integer IS DISTINCT FROM (p_request->>'expectedDefinitionVersion')::integer THEN RAISE EXCEPTION 'GOAL_WRITE_CONFLICT'; END IF;
    IF p_request->>'reason' IS NULL OR length(btrim(p_request->>'reason')) NOT BETWEEN 1 AND 2048 THEN RAISE EXCEPTION 'GOAL_COMMAND_INVALID'; END IF;
    IF v_operation='revise' AND v_old_definition#>>'{draft,changePolicy}' IS DISTINCT FROM 'evolving' THEN RAISE EXCEPTION 'GOAL_FIXED'; END IF;
  END IF;
  IF v_operation<>'withdraw' THEN
    IF p_definition->'scope' IS DISTINCT FROM v_scope OR p_definition->'draft' IS DISTINCT FROM p_request->'draft'
      OR p_definition->>'source' IS DISTINCT FROM 'record' OR p_definition->'basisEventIds' IS DISTINCT FROM '[]'::jsonb
      OR p_definition->'activationHead' IS DISTINCT FROM p_request->'expectedHead'
      OR jsonb_typeof(p_definition->'draft') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
    IF v_operation='create' THEN
      IF p_definition->>'definitionVersion' IS DISTINCT FROM '1' OR p_definition->>'changeKind' IS DISTINCT FROM 'created'
        OR p_definition->'supersedesDefinitionId' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
    ELSE
      IF p_definition->>'goalId' IS DISTINCT FROM v_old_definition->>'goalId'
        OR (p_definition->>'definitionVersion')::integer IS DISTINCT FROM (v_old_definition->>'definitionVersion')::integer+1
        OR p_definition->>'changeKind' IS DISTINCT FROM 'manual' OR p_definition->>'changeReason' IS DISTINCT FROM p_request->>'reason'
        OR p_definition->>'supersedesDefinitionId' IS DISTINCT FROM v_previous.definition_id THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
    END IF;
    v_definition:=p_definition; v_goal_id:=p_definition->>'goalInstanceId'; v_revision:=1;
  ELSE
    IF p_definition IS NOT NULL THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
    v_definition:=v_old_definition; v_goal_id:=v_previous.id; v_revision:=v_previous.revision+1;
  END IF;
  SELECT id INTO v_scene FROM public.scenes WHERE workspace_id=p_workspace AND record_id=p_record ORDER BY start_tick DESC,start_ordinal DESC,id ASC LIMIT 1;
  SELECT id INTO v_policy FROM public.visibility_policies WHERE workspace_id=p_workspace AND record_id=p_record AND policy_kind='public' ORDER BY policy_version ASC,id ASC LIMIT 1;
  IF v_scene IS NULL OR v_policy IS NULL THEN RAISE EXCEPTION 'GOAL_CONTEXT_UNAVAILABLE'; END IF;
  v_event:='goal-management:'||encode(public.digest(convert_to(jsonb_build_array(p_workspace,p_record,v_actor,p_key)::text,'UTF8'),'sha256'),'hex');
  -- A successor becoming public does not declassify its predecessor's identity/history.
  IF (v_definition#>>'{draft,visible}')::boolean IS NOT TRUE
    OR (v_operation<>'create' AND (v_old_definition#>>'{draft,visible}')::boolean IS NOT TRUE) THEN
    v_policy:='goal-policy:'||v_event;
    INSERT INTO public.visibility_policies (workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_kind)
      VALUES (p_workspace,v_record.world_id,v_record.worldline_id,p_record,v_policy,v_event,'dm_only');
  END IF;
  IF v_operation<>'create' THEN
    v_resolution:=CASE WHEN v_operation='withdraw' THEN 'withdrawn' ELSE 'superseded' END;
    UPDATE public.goal_instances SET state='settled',resolution_kind=v_resolution,revision=revision+1,completed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP,outcome=NULL
      WHERE workspace_id=p_workspace AND id=v_previous.id;
  END IF;
  IF v_operation<>'withdraw' THEN
    INSERT INTO public.record_goal_definitions (workspace_id,world_id,worldline_id,record_id,id,goal_id,definition_version,goal_key,policy_version,definition,supersedes_definition_id,created_by_principal_id)
    VALUES (p_workspace,v_record.world_id,v_record.worldline_id,p_record,p_definition->>'definitionId',p_definition->>'goalId',(p_definition->>'definitionVersion')::integer,
      p_definition->>'goalKey',p_definition->>'policyVersion',p_definition,p_definition->>'supersedesDefinitionId',v_actor);
    INSERT INTO public.goal_instances (workspace_id,world_id,worldline_id,record_id,id,goal_key,policy_version,definition_source,definition_id,evidence_start_version,evidence_start_ordinal,state,revision,attempt,supersedes_instance_id)
    VALUES (p_workspace,v_record.world_id,v_record.worldline_id,p_record,v_goal_id,p_definition->>'goalKey',p_definition->>'policyVersion','record',p_definition->>'definitionId',
      v_version,v_ordinal,'active',1,1,CASE WHEN v_operation='revise' THEN v_previous.id ELSE NULL END);
  END IF;
  v_event_payload:=jsonb_build_object('operation',v_operation,'goalInstanceId',CASE WHEN v_operation='create' THEN v_goal_id ELSE v_previous.id END,
    'goalKey',CASE WHEN v_operation='create' THEN v_definition->>'goalKey' ELSE v_previous.goal_key END,
    'to',CASE WHEN v_operation='create' THEN 'active' ELSE 'settled' END,'revision',CASE WHEN v_operation='create' THEN 1 ELSE v_previous.revision+1 END,'actorPrincipalId',v_actor);
  IF v_operation<>'create' THEN v_event_payload:=v_event_payload||jsonb_build_object('from','active','resolutionKind',v_resolution); END IF;
  IF v_operation='revise' THEN v_event_payload:=v_event_payload||jsonb_build_object('successorGoalInstanceId',v_goal_id); END IF;
  INSERT INTO public.events (workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,actor_participant_id,speaker_name,content,payload,visibility_policy_id,world_tick,world_ordinal,calendar_id,display_time)
  VALUES (p_workspace,v_record.world_id,v_record.worldline_id,p_record,v_scene,v_event,v_version+1,v_ordinal+1,0,'goal.transition.committed',NULL,'','Record goal management committed',
    jsonb_build_object('__realmRuntimePayload',v_event_payload),v_policy,v_line.head_tick,v_line.head_ordinal+1,v_world.calendar_id,COALESCE(v_world.settings->>'displayTime',''));
  UPDATE public.record_heads SET record_version=v_version+1,next_record_ordinal=v_ordinal+2,last_event_id=v_event,last_world_tick=v_line.head_tick,last_world_ordinal=v_line.head_ordinal+1,updated_at=CURRENT_TIMESTAMP
    WHERE workspace_id=p_workspace AND record_id=p_record;
  UPDATE public.worldlines SET head_ordinal=v_line.head_ordinal+1,updated_at=CURRENT_TIMESTAMP WHERE workspace_id=p_workspace AND world_id=v_record.world_id AND id=v_record.worldline_id;
  v_result:=jsonb_build_object('status','committed','operation',v_operation,'goalInstanceId',v_goal_id,'definitionId',v_definition->>'definitionId',
    'definitionVersion',(v_definition->>'definitionVersion')::integer,'revision',v_revision,'eventId',v_event,'recordVersion',v_version+1,'ordinal',v_ordinal+1);
  INSERT INTO public.record_goal_commands (workspace_id,world_id,worldline_id,record_id,principal_id,idempotency_key,request_fingerprint,operation,goal_instance_id,result)
  VALUES (p_workspace,v_record.world_id,v_record.worldline_id,p_record,v_actor,p_key,v_fingerprint,v_operation,v_goal_id,v_result);
  PERFORM pg_catalog.pg_notify('record_committed',jsonb_build_object('workspaceId',p_workspace,'recordId',p_record,'nextOrdinal',v_ordinal+2)::text);
  RETURN v_result;
END;
$$;
ALTER FUNCTION record_goal_manage(text,text,text,text,jsonb,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_manage(text,text,text,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_manage(text,text,text,text,jsonb,jsonb) TO realm_runtime;
