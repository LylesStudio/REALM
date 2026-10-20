-- A group reserves only fresh topology in this transaction. Legacy admissions
-- and the original restore/branch capabilities keep their original protocol.
ALTER TABLE record_goal_restore_admissions
  ADD COLUMN group_root text,
  ADD COLUMN operation text,
  ADD COLUMN body_commitment text,
  ADD COLUMN plan_commitment text,
  ADD COLUMN group_plan jsonb,
  ADD COLUMN source_record_id text,
  ADD COLUMN target_story_id text,
  ADD COLUMN target_status text,
  ADD CONSTRAINT record_goal_restore_group_shape CHECK (
    (group_root IS NULL AND operation IS NULL AND body_commitment IS NULL
      AND plan_commitment IS NULL AND group_plan IS NULL AND source_record_id IS NULL
      AND target_story_id IS NULL AND target_status IS NULL)
    OR (group_root IS NOT NULL AND operation IS NOT NULL AND operation IN ('restore','branch')
      AND body_commitment IS NOT NULL AND plan_commitment IS NOT NULL AND group_plan IS NOT NULL
      AND body_commitment ~ '^[a-f0-9]{64}$' AND plan_commitment ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(group_plan) = 'object' AND source_record_id IS NOT NULL
      AND target_story_id IS NOT NULL AND target_status IS NOT NULL AND target_status IN ('draft','active','closed','archived'))
  );

CREATE FUNCTION record_goal_restore_group_prepare(
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
    OR octet_length(p_plan::text)>67108864 THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_plan) key WHERE key NOT IN ('operation','worldlineId','records','stories','source'))
    OR COALESCE(p_plan->>'operation','') NOT IN ('restore','branch')
    OR jsonb_typeof(p_plan->'records') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_plan->'stories') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF jsonb_array_length(p_plan->'records') NOT BETWEEN 1 AND 65
    OR jsonb_array_length(p_plan->'stories') NOT BETWEEN 1 AND 65 THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
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
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_plan->'source') key WHERE key NOT IN ('recordId','recordVersion'))
      OR jsonb_typeof(p_plan#>'{source,recordVersion}') IS DISTINCT FROM 'number'
      OR COALESCE(p_plan#>>'{source,recordVersion}','') !~ '^(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    token:=substring(p_root FROM 15);line_id:='worldline_branch_'||token;
    SELECT * INTO source FROM public.records WHERE workspace_id=p_workspace AND id=p_plan#>>'{source,recordId}' FOR UPDATE;
    IF NOT FOUND OR source.world_id IS DISTINCT FROM p_world OR source.status='archived'
      OR p_plan#>>'{records,0,sourceRecordId}' IS DISTINCT FROM source.id THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
    SELECT * INTO head FROM public.record_heads WHERE workspace_id=p_workspace AND record_id=source.id FOR UPDATE;
    IF NOT FOUND OR head.record_version IS DISTINCT FROM (p_plan#>>'{source,recordVersion}')::bigint THEN RAISE EXCEPTION 'GOAL_BRANCH_HEAD_CHANGED'; END IF;
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
ALTER FUNCTION record_goal_restore_group_prepare(text,text,text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_prepare(text,text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_restore_group_prepare(text,text,text,text,text,text,jsonb) TO realm_runtime;

-- Shared internal check also protects legacy entry points from consuming a
-- grouped admission without checking its complete topology and exact plan.
CREATE FUNCTION record_goal_restore_group_check(p_workspace text,p_record text)
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
        AND story.premise='realm-save:body-v1:'||admission.body_commitment) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
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
        AND line.parent_worldline_id=source.worldline_id AND story.premise=origin.premise
        AND record.start_tick=line.fork_tick AND record.start_ordinal=line.fork_ordinal
        AND line.fork_tick=COALESCE(head.last_world_tick,source.start_tick)
        AND line.fork_ordinal=COALESCE(head.last_world_ordinal,source.start_ordinal)) THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
  END IF;
END;
$$;
ALTER FUNCTION record_goal_restore_group_check(text,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_check(text,text) FROM PUBLIC;

CREATE FUNCTION guard_record_goal_restore_group()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission public.record_goal_restore_admissions%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='record_goal_restore_admissions' THEN
    IF NEW.group_root IS NOT NULL THEN
      PERFORM public.record_goal_restore_group_check(NEW.workspace_id,NEW.record_id);
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.group_plan->'records') member,
        LATERAL jsonb_array_elements(member->'definitions') planned
        WHERE member->>'recordId'=NEW.record_id AND NOT EXISTS(
          SELECT 1 FROM public.record_goal_definitions stored WHERE stored.workspace_id=NEW.workspace_id
            AND stored.record_id=NEW.record_id AND stored.definition=planned)) THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
    END IF;
  ELSE
    SELECT * INTO admission FROM public.record_goal_restore_admissions WHERE workspace_id=NEW.workspace_id AND record_id=NEW.record_id;
    IF FOUND AND admission.group_root IS NOT NULL AND admission.transaction_id=pg_current_xact_id() THEN
      PERFORM public.record_goal_restore_group_check(NEW.workspace_id,NEW.record_id);
      IF NEW.created_by_principal_id IS DISTINCT FROM admission.principal_id
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(admission.group_plan->'records') member,
          LATERAL jsonb_array_elements(member->'definitions') definition
          WHERE member->>'recordId'=NEW.record_id AND definition=NEW.definition) THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_record_goal_restore_group() OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION guard_record_goal_restore_group() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER record_goal_restore_group_complete
  AFTER INSERT ON record_goal_restore_admissions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_record_goal_restore_group();
CREATE TRIGGER record_goal_restore_group_definition_guard BEFORE INSERT ON record_goal_definitions
  FOR EACH ROW EXECUTE FUNCTION guard_record_goal_restore_group();

CREATE FUNCTION record_goal_restore_group_definitions(p_workspace text,p_proof text,p_record text,p_body text,p_plan text,p_definitions jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text; admission public.record_goal_restore_admissions%ROWTYPE; definition jsonb; expected_scope jsonb;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  SELECT * INTO admission FROM public.record_goal_restore_admissions WHERE workspace_id=p_workspace AND record_id=p_record;
  IF NOT FOUND OR admission.group_root IS NULL OR admission.principal_id IS DISTINCT FROM actor
    OR admission.body_commitment IS DISTINCT FROM p_body OR admission.plan_commitment IS DISTINCT FROM p_plan
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(admission.group_plan->'records') member
      WHERE member->>'recordId'=p_record AND member->'definitions'=p_definitions)
    OR EXISTS(SELECT 1 FROM public.record_goal_definitions WHERE workspace_id=p_workspace AND record_id=p_record) THEN
    RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED';
  END IF;
  PERFORM public.record_goal_restore_group_check(p_workspace,p_record);
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
ALTER FUNCTION record_goal_restore_group_definitions(text,text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_definitions(text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_restore_group_definitions(text,text,text,text,text,jsonb) TO realm_runtime;

-- Replay exposes only the authenticated actor for an exact branch commitment.
-- It grants no admissions table read and never reserves new write authority.
CREATE FUNCTION record_goal_restore_branch_replay(
  p_workspace text,p_proof text,p_world text,p_record text,p_body text,
  p_source text,p_parent text,p_tick bigint,p_ordinal bigint
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  PERFORM public.membership_assert_world_owner(p_workspace,p_world,actor);
  IF NOT EXISTS(SELECT 1 FROM public.record_goal_restore_admissions admission
    JOIN public.records record ON record.workspace_id=admission.workspace_id AND record.id=admission.record_id
    JOIN public.worldlines line ON line.workspace_id=record.workspace_id AND line.id=record.worldline_id
    WHERE admission.workspace_id=p_workspace AND admission.record_id=p_record
      AND admission.world_id=p_world AND admission.worldline_id=record.worldline_id
      AND admission.group_root=p_record AND admission.operation='branch'
      AND admission.principal_id=actor AND admission.body_commitment=p_body
      AND admission.source_record_id=p_source AND admission.group_plan#>>'{source,recordId}'=p_source
      AND record.world_id=p_world AND record.story_id=admission.target_story_id
      AND record.timeline_kind='branch' AND record.linked_record_id=p_source
      AND line.parent_worldline_id=p_parent AND line.fork_tick=p_tick AND line.fork_ordinal=p_ordinal
      AND record.start_tick=p_tick AND record.start_ordinal=p_ordinal) THEN
    RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED';
  END IF;
  RETURN actor;
END;
$$;
ALTER FUNCTION record_goal_restore_branch_replay(text,text,text,text,text,text,text,bigint,bigint) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_branch_replay(text,text,text,text,text,text,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_restore_branch_replay(text,text,text,text,text,text,text,bigint,bigint) TO realm_runtime;

-- An early SET CONSTRAINTS consumes existing events, not future status edits.
-- Queue a fresh final-state check on every status edit of a newly admitted
-- member. Admissions from earlier transactions impose no lifecycle restriction.
CREATE FUNCTION guard_record_goal_restore_member_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
SET realm.workspace_id='' AS $$
BEGIN
  -- A deferred event belongs to this actual row, not the caller's later GUC.
  -- Bind FORCE RLS to the trigger row only; the function SET frame restores
  -- the caller's scope on return (and on error). No public callable scope
  -- switch or bypass role is introduced. Immutable admissions still restrict
  -- the check to the original restore transaction.
  PERFORM set_config('realm.workspace_id',NEW.workspace_id,true);
  IF EXISTS(SELECT 1 FROM public.record_goal_restore_admissions admission
    WHERE admission.workspace_id=NEW.workspace_id AND admission.record_id=NEW.id
      AND admission.group_root IS NOT NULL AND admission.transaction_id=pg_current_xact_id()) THEN
    PERFORM public.record_goal_restore_group_check(NEW.workspace_id,NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_record_goal_restore_member_status() OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION guard_record_goal_restore_member_status() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER record_goal_restore_member_status_complete
  AFTER UPDATE OF status ON records DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_record_goal_restore_member_status();
