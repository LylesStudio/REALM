-- Initial authored Goals belong to the same uncommitted, proof-bound genesis.
-- This does not grant an observer any post-creation management authority.
GRANT SELECT ON genesis_creation_requests TO realm_goal_authoring;
GRANT SELECT(workspace_id,world_id,principal_id,role) ON player_world_memberships TO realm_goal_authoring;
CREATE FUNCTION record_goal_genesis_materialize(p_workspace text,p_proof text,p_request text,p_definition jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  actor text;
  r public.records%ROWTYPE;
  expected_scope jsonb;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  IF NOT EXISTS (SELECT 1 FROM public.genesis_creation_requests request WHERE request.workspace_id=p_workspace
    AND request.principal_id=actor AND request.creation_request_id=p_request AND request.state='accepted'
    AND request.world_id=p_definition#>>'{scope,worldId}' AND request.record_id=p_definition#>>'{scope,recordId}') THEN
    RAISE EXCEPTION 'GOAL_GENESIS_PROOF_REQUIRED';
  END IF;
  SELECT * INTO r FROM public.records WHERE workspace_id=p_workspace AND world_id=p_definition#>>'{scope,worldId}'
    AND worldline_id=p_definition#>>'{scope,worldlineId}' AND id=p_definition#>>'{scope,recordId}' FOR UPDATE;
  IF NOT FOUND OR r.status IS DISTINCT FROM 'active' OR r.world_version IS DISTINCT FROM '0.0.0-local' THEN
    RAISE EXCEPTION 'GOAL_AUTHORING_POLICY_REQUIRED';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.player_world_memberships member WHERE member.workspace_id=p_workspace
      AND member.world_id=r.world_id AND member.principal_id=actor AND member.role IN ('owner','observer'))
    OR NOT EXISTS (SELECT 1 FROM public.record_heads head WHERE head.workspace_id=p_workspace AND head.record_id=r.id
      AND head.record_version=0 AND head.next_record_ordinal=0)
    OR EXISTS (SELECT 1 FROM public.events event WHERE event.workspace_id=p_workspace AND event.record_id=r.id) THEN
    RAISE EXCEPTION 'GOAL_GENESIS_PROOF_REQUIRED';
  END IF;
  expected_scope:=jsonb_build_object('workspaceId',p_workspace,'worldId',r.world_id,'worldlineId',r.worldline_id,'recordId',r.id);
  IF p_definition IS NULL OR jsonb_typeof(p_definition) IS DISTINCT FROM 'object' OR length(p_definition::text)>131072
    OR p_definition->'scope' IS DISTINCT FROM expected_scope OR p_definition->>'source' IS DISTINCT FROM 'record'
    OR p_definition->>'definitionVersion' IS DISTINCT FROM '1' OR p_definition->>'changeKind' IS DISTINCT FROM 'created'
    OR p_definition->'supersedesDefinitionId' IS DISTINCT FROM 'null'::jsonb
    OR p_definition->'basisEventIds' IS DISTINCT FROM '[]'::jsonb
    OR p_definition->'activationHead' IS DISTINCT FROM jsonb_build_object('recordVersion',0,'ordinal',0)
    OR p_definition->>'goalId' IS NULL OR p_definition->>'goalId' !~ '^genesis[.]goal[.][1-8]$'
    OR p_definition->>'mode' IS DISTINCT FROM 'semantic'
    OR p_definition->'rubric' IS DISTINCT FROM jsonb_build_object('kind','semantic','promptKey','record.authored.v1')
    OR p_definition->'outcome' IS DISTINCT FROM jsonb_build_object('title',p_definition#>>'{draft,title}')
    OR jsonb_typeof(p_definition#>'{draft,visible}') IS DISTINCT FROM 'boolean'
    OR COALESCE(p_definition#>>'{draft,changePolicy}','') NOT IN ('fixed','evolving') THEN RAISE EXCEPTION 'GOAL_DRAFT_INVALID'; END IF;
  INSERT INTO public.record_goal_definitions(workspace_id,world_id,worldline_id,record_id,id,goal_id,definition_version,goal_key,policy_version,definition,created_by_principal_id)
    VALUES(p_workspace,r.world_id,r.worldline_id,r.id,p_definition->>'definitionId',p_definition->>'goalId',1,
      p_definition->>'goalKey',p_definition->>'policyVersion',p_definition,actor);
  INSERT INTO public.goal_instances(workspace_id,world_id,worldline_id,record_id,id,goal_key,policy_version,definition_source,definition_id,
    evidence_start_version,evidence_start_ordinal,state,revision,attempt)
    VALUES(p_workspace,r.world_id,r.worldline_id,r.id,p_definition->>'goalInstanceId',p_definition->>'goalKey',p_definition->>'policyVersion',
      'record',p_definition->>'definitionId',0,0,'active',1,1);
END;
$$;
ALTER FUNCTION record_goal_genesis_materialize(text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_genesis_materialize(text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_genesis_materialize(text,text,text,jsonb) TO realm_runtime;
