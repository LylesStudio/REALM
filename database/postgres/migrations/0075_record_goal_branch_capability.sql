-- Current-head snapshot branching uses the same append-only definition rebase as
-- restore, but only after an owner proof reserves a new, source-locked branch.
-- No table DML privileges are added to realm_runtime.
CREATE FUNCTION record_goal_branch_prepare(p_workspace text,p_proof text,p_source text,p_token text,p_hash text,p_version bigint)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text; source public.records%ROWTYPE; head public.record_heads%ROWTYPE;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  SELECT * INTO source FROM public.records WHERE workspace_id=p_workspace AND id=p_source FOR UPDATE;
  IF NOT FOUND OR source.status='archived' OR p_token IS NULL OR p_token !~ '^[a-f0-9]{18}$'
    OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
    OR NOT EXISTS(SELECT 1 FROM public.worlds world JOIN public.player_world_memberships member
      ON member.workspace_id=world.workspace_id AND member.world_id=world.id
      WHERE world.workspace_id=p_workspace AND world.id=source.world_id AND world.status='active'
        AND member.principal_id=actor AND member.role='owner')
    OR EXISTS(SELECT 1 FROM public.records WHERE workspace_id=p_workspace AND id='record_branch_'||p_token)
    OR EXISTS(SELECT 1 FROM public.worldlines WHERE workspace_id=p_workspace AND id='worldline_branch_'||p_token)
    OR EXISTS(SELECT 1 FROM public.stories WHERE workspace_id=p_workspace AND id='story_branch_'||p_token) THEN
    RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED';
  END IF;
  SELECT * INTO head FROM public.record_heads WHERE workspace_id=p_workspace AND record_id=p_source FOR UPDATE;
  IF NOT FOUND OR head.record_version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'GOAL_BRANCH_HEAD_CHANGED'; END IF;
  INSERT INTO public.record_goal_restore_admissions(workspace_id,world_id,worldline_id,record_id,principal_id,archive_hash,transaction_id)
    VALUES(p_workspace,source.world_id,'worldline_branch_'||p_token,'record_branch_'||p_token,actor,p_hash,pg_current_xact_id());
  RETURN actor;
END;
$$;
ALTER FUNCTION record_goal_branch_prepare(text,text,text,text,text,bigint) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_branch_prepare(text,text,text,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_branch_prepare(text,text,text,text,text,bigint) TO realm_runtime;

CREATE OR REPLACE FUNCTION record_goal_restore_definitions(p_workspace text,p_proof text,p_record text,p_definitions jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text; admission public.record_goal_restore_admissions%ROWTYPE; definition jsonb; expected_scope jsonb;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  SELECT * INTO admission FROM public.record_goal_restore_admissions WHERE workspace_id=p_workspace AND record_id=p_record;
  IF NOT FOUND OR admission.principal_id IS DISTINCT FROM actor OR admission.transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR NOT EXISTS(SELECT 1 FROM public.player_world_memberships WHERE workspace_id=p_workspace AND world_id=admission.world_id AND principal_id=actor AND role='owner')
    OR NOT EXISTS(SELECT 1 FROM public.records record JOIN public.stories story
      ON story.workspace_id=record.workspace_id AND story.world_id=record.world_id AND story.worldline_id=record.worldline_id AND story.id=record.story_id
      WHERE record.workspace_id=p_workspace AND record.id=p_record AND record.world_id=admission.world_id
        AND record.worldline_id=admission.worldline_id AND record.status='active' AND (
          (record.id ~ '^record_restore_[a-f0-9]{24}$' AND story.premise='realm-save:'||admission.archive_hash)
          OR (record.id ~ '^record_branch_[a-f0-9]{18}$' AND record.timeline_kind='branch'
            AND EXISTS(SELECT 1 FROM public.records source
              JOIN public.stories origin ON origin.workspace_id=source.workspace_id AND origin.id=source.story_id
              JOIN public.worldlines line ON line.workspace_id=record.workspace_id AND line.id=record.worldline_id
              JOIN public.record_heads head ON head.workspace_id=source.workspace_id AND head.record_id=source.id
              WHERE source.workspace_id=p_workspace AND source.id=record.linked_record_id AND source.world_id=record.world_id
                AND source.world_version=record.world_version AND line.parent_worldline_id=source.worldline_id
                AND line.fork_tick=COALESCE(head.last_world_tick,source.start_tick)
                AND line.fork_ordinal=COALESCE(head.last_world_ordinal,source.start_ordinal)
                AND story.premise=origin.premise))))
    OR EXISTS(SELECT 1 FROM public.record_goal_definitions WHERE workspace_id=p_workspace AND record_id=p_record) THEN
    RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED';
  END IF;
  IF p_definitions IS NULL OR jsonb_typeof(p_definitions) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_definitions) NOT BETWEEN 1 AND 10000 OR octet_length(p_definitions::text)>16777216 THEN
    RAISE EXCEPTION 'GOAL_DEFINITION_INVALID';
  END IF;
  expected_scope:=jsonb_build_object('workspaceId',p_workspace,'worldId',admission.world_id,'worldlineId',admission.worldline_id,'recordId',p_record);
  FOR definition IN SELECT value FROM jsonb_array_elements(p_definitions) LOOP
    IF jsonb_typeof(definition) IS DISTINCT FROM 'object' OR definition->'scope' IS DISTINCT FROM expected_scope
      OR definition->>'source' IS DISTINCT FROM 'record' OR definition->>'mode' IS DISTINCT FROM 'semantic'
      OR definition->'rubric' IS DISTINCT FROM jsonb_build_object('kind','semantic','promptKey','record.authored.v1')
      OR definition->'outcome' IS DISTINCT FROM jsonb_build_object('title',definition#>>'{draft,title}')
      OR COALESCE(definition#>>'{draft,changePolicy}','') NOT IN ('fixed','evolving')
      OR jsonb_typeof(definition->'basisEventIds') IS DISTINCT FROM 'array'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(definition->'basisEventIds') basis(id)
        WHERE NOT EXISTS(SELECT 1 FROM public.events event WHERE event.workspace_id=p_workspace AND event.world_id=admission.world_id
          AND event.worldline_id=admission.worldline_id AND event.record_id=p_record AND event.id=basis.id
          AND event.event_kind IN ('narration.committed','world.consequence.committed','action.resolved','scene.crystallized')
          AND event.record_version<=(definition#>>'{activationHead,recordVersion}')::bigint
          AND event.record_ordinal<=(definition#>>'{activationHead,ordinal}')::bigint)) THEN
      RAISE EXCEPTION 'GOAL_DEFINITION_INVALID';
    END IF;
    INSERT INTO public.record_goal_definitions(workspace_id,world_id,worldline_id,record_id,id,goal_id,definition_version,goal_key,policy_version,
      definition,supersedes_definition_id,created_by_principal_id)
      VALUES(p_workspace,admission.world_id,admission.worldline_id,p_record,definition->>'definitionId',definition->>'goalId',
        (definition->>'definitionVersion')::integer,definition->>'goalKey',definition->>'policyVersion',definition,
        definition->>'supersedesDefinitionId',actor);
  END LOOP;
END;
$$;
ALTER FUNCTION record_goal_restore_definitions(text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_definitions(text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_restore_definitions(text,text,text,jsonb) TO realm_runtime;
