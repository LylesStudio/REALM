-- Source authoring only. 0082 belongs to A4. No historical backfill and no
-- change to the existing authored Goal or body-v1 restore capabilities.
-- PostgreSQL 17 semantics used here follow the existing 0070/0074/0077
-- capability pattern: NOBYPASSRLS owner, fixed search_path, xid8 admissions,
-- deferred constraint triggers and NOT VALID FKs for unscanned historical rows.
ALTER TABLE goal_instances ADD CONSTRAINT goal_instances_typed_identity_key
  UNIQUE(workspace_id,world_id,worldline_id,id);
ALTER TABLE goal_instances ADD CONSTRAINT goal_instances_worldline_owner_fk
  FOREIGN KEY(workspace_id,world_id,worldline_id)
  REFERENCES worldlines(workspace_id,world_id,id) NOT VALID;
ALTER TABLE goal_instances ADD CONSTRAINT goal_instances_story_owner_fk
  FOREIGN KEY(workspace_id,world_id,worldline_id,story_id)
  REFERENCES stories(workspace_id,world_id,worldline_id,id) NOT VALID;

CREATE TABLE IF NOT EXISTS goal_content_instance_bindings (
  workspace_id text NOT NULL REFERENCES workspaces(id), world_id text NOT NULL, worldline_id text NOT NULL,
  goal_instance_id text NOT NULL, scope_kind text NOT NULL, record_id text, story_id text,
  goal_key text NOT NULL CHECK(length(btrim(goal_key))>0),
  policy_version text NOT NULL CHECK(length(btrim(policy_version))>0),
  binding_version integer NOT NULL CHECK(binding_version=1),
  normalization text NOT NULL CHECK(normalization='goal-definition-c14n-v1'),
  source_kind text NOT NULL CHECK(source_kind IN ('installed','base')),
  source_world_id text NOT NULL, source_world_version text NOT NULL,
  package_content_hash text, base_revision text, base_content_hash text,
  definition_hash text NOT NULL CHECK(definition_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(workspace_id,goal_instance_id),
  FOREIGN KEY (workspace_id, world_id, worldline_id, goal_instance_id)
    REFERENCES goal_instances (workspace_id, world_id, worldline_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,world_id,worldline_id) REFERENCES worldlines(workspace_id,world_id,id),
  FOREIGN KEY(workspace_id,world_id,worldline_id,record_id) REFERENCES records(workspace_id,world_id,worldline_id,id),
  FOREIGN KEY(workspace_id,world_id,worldline_id,story_id) REFERENCES stories(workspace_id,world_id,worldline_id,id),
  CHECK ((scope_kind='record' AND record_id IS NOT NULL AND story_id IS NULL)
    OR (scope_kind='story' AND record_id IS NULL AND story_id IS NOT NULL)
    OR (scope_kind='worldline' AND record_id IS NULL AND story_id IS NULL)),
  CHECK (((source_kind='installed' AND source_world_id=world_id AND length(source_world_id)>0
      AND length(source_world_version)>0 AND source_world_version<>'0.0.0-local'
      AND package_content_hash ~ '^[0-9a-f]{64}$' AND base_revision IS NULL AND base_content_hash IS NULL)
    OR (source_kind='base' AND source_world_id='' AND source_world_version='0.0.0-local'
      AND package_content_hash IS NULL AND base_revision IS NOT NULL AND length(btrim(base_revision))>0
      AND base_content_hash ~ '^[0-9a-f]{64}$')) IS TRUE)
);
ALTER TABLE goal_content_instance_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_content_instance_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY realm_workspace_isolation ON goal_content_instance_bindings
  USING(workspace_id=realm_current_workspace_id()) WITH CHECK(workspace_id=realm_current_workspace_id());
REVOKE ALL ON goal_content_instance_bindings FROM PUBLIC,realm_runtime;
GRANT SELECT ON goal_content_instance_bindings TO realm_runtime;
GRANT SELECT,INSERT ON goal_content_instance_bindings TO realm_goal_authoring;

CREATE TABLE IF NOT EXISTS goal_content_write_admissions (
  workspace_id text NOT NULL REFERENCES workspaces(id), world_id text NOT NULL, worldline_id text NOT NULL,
  goal_instance_id text NOT NULL, scope_kind text NOT NULL, record_id text, story_id text,
  principal_id text NOT NULL CHECK(length(btrim(principal_id))>0),
  operation text NOT NULL CHECK(operation IN ('materialize','retry','clone','restore-v2','restore-v1-legacy')),
  transaction_id xid8 NOT NULL,
  body_commitment text NOT NULL CHECK(body_commitment ~ '^[0-9a-f]{64}$'),
  plan_commitment text NOT NULL CHECK(plan_commitment ~ '^[0-9a-f]{64}$'),
  plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(workspace_id,goal_instance_id),
  FOREIGN KEY (workspace_id, world_id, worldline_id, goal_instance_id)
    REFERENCES goal_instances (workspace_id, world_id, worldline_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(workspace_id,world_id,worldline_id) REFERENCES worldlines(workspace_id,world_id,id),
  FOREIGN KEY(workspace_id,world_id,worldline_id,record_id) REFERENCES records(workspace_id,world_id,worldline_id,id),
  FOREIGN KEY(workspace_id,world_id,worldline_id,story_id) REFERENCES stories(workspace_id,world_id,worldline_id,id),
  CHECK ((scope_kind='record' AND record_id IS NOT NULL AND story_id IS NULL)
    OR (scope_kind='story' AND record_id IS NULL AND story_id IS NOT NULL)
    OR (scope_kind='worldline' AND record_id IS NULL AND story_id IS NULL)),
  CHECK(operation<>'restore-v1-legacy' OR scope_kind='record')
);
ALTER TABLE goal_content_write_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_content_write_admissions FORCE ROW LEVEL SECURITY;
CREATE POLICY realm_workspace_isolation ON goal_content_write_admissions
  USING(workspace_id=realm_current_workspace_id()) WITH CHECK(workspace_id=realm_current_workspace_id());
REVOKE ALL ON goal_content_write_admissions FROM PUBLIC,realm_runtime;
GRANT SELECT,INSERT ON goal_content_write_admissions TO realm_goal_authoring;

CREATE FUNCTION goal_content_source_assert(p_source jsonb,p_world text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF p_source IS NULL OR jsonb_typeof(p_source) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(p_source))<>6
    OR NOT p_source ?& ARRAY['sourceKind','sourceWorldId','sourceWorldVersion','packageContentHash','baseRevision','baseContentHash'] THEN
    RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
  IF NOT (((p_source->>'sourceKind'='installed' AND p_source->>'sourceWorldId'=p_world
      AND length(p_world)>0 AND length(p_source->>'sourceWorldVersion')>0
      AND p_source->>'sourceWorldVersion'<>'0.0.0-local'
      AND p_source->>'packageContentHash' ~ '^[0-9a-f]{64}$'
      AND p_source->'baseRevision'='null'::jsonb AND p_source->'baseContentHash'='null'::jsonb)
    OR (p_source->>'sourceKind'='base' AND p_source->>'sourceWorldId'=''
      AND p_source->>'sourceWorldVersion'='0.0.0-local' AND p_source->'packageContentHash'='null'::jsonb
      AND length(btrim(p_source->>'baseRevision'))>0 AND p_source->>'baseContentHash' ~ '^[0-9a-f]{64}$')) IS TRUE) THEN
    RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(p_source) entry WHERE entry.value<>'null'::jsonb AND jsonb_typeof(entry.value)<>'string') THEN
    RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
END;
$$;
ALTER FUNCTION goal_content_source_assert(jsonb,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION goal_content_source_assert(jsonb,text) FROM PUBLIC;

CREATE FUNCTION goal_content_binding_assert(p_workspace text,p_instance text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE goal public.goal_instances%ROWTYPE; binding public.goal_content_instance_bindings%ROWTYPE;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  SELECT * INTO goal FROM public.goal_instances WHERE workspace_id=p_workspace AND id=p_instance;
  IF NOT FOUND OR goal.definition_source<>'content' THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
  SELECT * INTO binding FROM public.goal_content_instance_bindings WHERE workspace_id=p_workspace AND goal_instance_id=p_instance;
  IF NOT FOUND OR ROW(binding.world_id,binding.worldline_id,binding.scope_kind,binding.record_id,binding.story_id,binding.goal_key,binding.policy_version)
    IS DISTINCT FROM ROW(goal.world_id,goal.worldline_id,goal.scope_kind,goal.record_id,goal.story_id,goal.goal_key,goal.policy_version) THEN
    RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
END;
$$;
ALTER FUNCTION goal_content_binding_assert(text,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION goal_content_binding_assert(text,text) FROM PUBLIC;

CREATE FUNCTION guard_goal_content_binding_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME<>'goal_instances' THEN RAISE EXCEPTION 'GOAL_CONTENT_APPEND_ONLY'; END IF;
  IF EXISTS(SELECT 1 FROM public.goal_content_instance_bindings WHERE workspace_id=OLD.workspace_id AND goal_instance_id=OLD.id)
    AND ROW(NEW.workspace_id,NEW.world_id,NEW.worldline_id,NEW.record_id,NEW.story_id,NEW.scope_kind,NEW.id,
      NEW.goal_key,NEW.policy_version,NEW.definition_source,NEW.definition_id,NEW.attempt,NEW.supersedes_instance_id)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.world_id,OLD.worldline_id,OLD.record_id,OLD.story_id,OLD.scope_kind,OLD.id,
      OLD.goal_key,OLD.policy_version,OLD.definition_source,OLD.definition_id,OLD.attempt,OLD.supersedes_instance_id) THEN
    RAISE EXCEPTION 'GOAL_CONTENT_IDENTITY_IMMUTABLE'; END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_goal_content_binding_immutable() OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION guard_goal_content_binding_immutable() FROM PUBLIC;
CREATE TRIGGER goal_content_binding_immutable BEFORE UPDATE OR DELETE ON goal_content_instance_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_goal_content_binding_immutable();
CREATE TRIGGER goal_content_admission_immutable BEFORE UPDATE OR DELETE ON goal_content_write_admissions
  FOR EACH ROW EXECUTE FUNCTION guard_goal_content_binding_immutable();
CREATE TRIGGER goal_content_identity_immutable BEFORE UPDATE ON goal_instances
  FOR EACH ROW EXECUTE FUNCTION guard_goal_content_binding_immutable();

CREATE FUNCTION goal_content_write_prepare(p_workspace text,p_proof text,p_operation text,p_body text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text; item jsonb; owner jsonb; plan_hash text; count_items integer;
  source_record public.records%ROWTYPE; source_head public.record_heads%ROWTYPE;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  -- D3: no playable legacy preservation capability is exposed. Unknown historical
  -- source cannot be silently admitted as current content.
  IF p_operation IS NULL OR p_operation NOT IN ('materialize','retry','clone','restore-v2')
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
  IF p_operation='restore-v2' THEN
    IF NOT EXISTS(SELECT 1 FROM public.record_goal_restore_admissions group_admission
      WHERE group_admission.workspace_id=p_workspace AND group_admission.record_id=p_plan->>'restoreGroupRoot'
        AND group_admission.group_plan->'bodyVersion'='2'::jsonb AND group_admission.body_commitment=p_body
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
        AND worldline_id=owner->>'worldlineId' AND id=owner->>'recordId' AND (p_operation='restore-v2' OR status<>'archived'))) THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
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
ALTER FUNCTION goal_content_write_prepare(text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION goal_content_write_prepare(text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION goal_content_write_prepare(text,text,text,text,jsonb) TO realm_runtime;

CREATE FUNCTION guard_goal_content_admission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission public.goal_content_write_admissions%ROWTYPE; item jsonb;
BEGIN
  IF NEW.definition_source<>'content' THEN RETURN NEW; END IF;
  SELECT * INTO admission FROM public.goal_content_write_admissions WHERE workspace_id=NEW.workspace_id AND goal_instance_id=NEW.id;
  IF NOT FOUND OR public.realm_current_workspace_id() IS DISTINCT FROM NEW.workspace_id
    OR admission.transaction_id IS DISTINCT FROM pg_current_xact_id()
    OR ROW(admission.world_id,admission.worldline_id,admission.scope_kind,admission.record_id,admission.story_id)
      IS DISTINCT FROM ROW(NEW.world_id,NEW.worldline_id,NEW.scope_kind,NEW.record_id,NEW.story_id) THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  SELECT value INTO item FROM jsonb_array_elements(admission.plan->'instances') WHERE value->>'instanceId'=NEW.id;
  IF NOT FOUND OR NEW.goal_key IS DISTINCT FROM item->>'goalKey' OR NEW.policy_version IS DISTINCT FROM item->>'policyVersion'
    OR NEW.supersedes_instance_id IS DISTINCT FROM item->>'predecessor'
    OR (admission.operation IN ('materialize','clone') AND (NEW.attempt<>1 OR NEW.supersedes_instance_id IS NOT NULL))
    OR (admission.operation='materialize' AND (NEW.state<>'active' OR NEW.revision<>0 OR NEW.progress<>'{}'::jsonb OR NEW.outcome IS NOT NULL)) THEN
    RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_goal_content_admission() OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION guard_goal_content_admission() FROM PUBLIC;
CREATE TRIGGER goal_content_insert_admission BEFORE INSERT ON goal_instances
  FOR EACH ROW EXECUTE FUNCTION guard_goal_content_admission();

CREATE FUNCTION goal_content_write_bind(p_workspace text,p_proof text,p_body text,p_plan_hash text,p_bindings jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actor text; binding jsonb; admission public.goal_content_write_admissions%ROWTYPE; item jsonb; first_plan jsonb;
  stored public.goal_content_instance_bindings%ROWTYPE;
BEGIN
  IF public.realm_current_workspace_id() IS DISTINCT FROM p_workspace THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
  actor:=public.realm_capability_session_actor(p_proof,p_workspace);
  IF p_bindings IS NULL OR jsonb_typeof(p_bindings) IS DISTINCT FROM 'array' OR octet_length(p_bindings::text)>16777216 THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
  IF jsonb_array_length(p_bindings) NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
  IF (SELECT count(DISTINCT value->>'instanceId') FROM jsonb_array_elements(p_bindings))<>jsonb_array_length(p_bindings) THEN
    RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
  FOR binding IN SELECT value FROM jsonb_array_elements(p_bindings) LOOP
    IF jsonb_typeof(binding) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(binding))<>9
      OR NOT binding ?& ARRAY['bindingVersion','workspaceId','owner','instanceId','goalKey','policyVersion','definitionHash','normalization','source'] THEN
      RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_object_keys(binding) key WHERE key NOT IN ('bindingVersion','workspaceId','owner','instanceId','goalKey','policyVersion','definitionHash','normalization','source'))
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['workspaceId','instanceId','goalKey','policyVersion','definitionHash','normalization']) AS field(key)
        WHERE jsonb_typeof(binding->field.key) IS DISTINCT FROM 'string')
      OR binding->'bindingVersion' IS DISTINCT FROM '1'::jsonb OR binding->>'workspaceId' IS DISTINCT FROM p_workspace
      OR binding->>'normalization' IS DISTINCT FROM 'goal-definition-c14n-v1' THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
    SELECT * INTO admission FROM public.goal_content_write_admissions WHERE workspace_id=p_workspace AND goal_instance_id=binding->>'instanceId';
    IF NOT FOUND OR admission.principal_id IS DISTINCT FROM actor OR admission.transaction_id IS DISTINCT FROM pg_current_xact_id()
      OR admission.body_commitment IS DISTINCT FROM p_body OR admission.plan_commitment IS DISTINCT FROM p_plan_hash
      OR admission.plan_commitment IS DISTINCT FROM encode(public.digest(admission.plan::text,'sha256'),'hex') THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
    PERFORM public.membership_assert_world_owner(p_workspace,admission.world_id,actor);
    IF NOT EXISTS(SELECT 1 FROM public.worlds WHERE workspace_id=p_workspace AND id=admission.world_id AND status='active') THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
    IF first_plan IS NOT NULL AND first_plan IS DISTINCT FROM admission.plan THEN RAISE EXCEPTION 'GOAL_CONTENT_PROOF_REQUIRED'; END IF;
    first_plan:=admission.plan;
    SELECT value INTO item FROM jsonb_array_elements(admission.plan->'instances') WHERE value->>'instanceId'=binding->>'instanceId';
    IF NOT FOUND OR binding->'owner' IS DISTINCT FROM item->'owner' OR binding->>'goalKey' IS DISTINCT FROM item->>'goalKey'
      OR binding->>'policyVersion' IS DISTINCT FROM item->>'policyVersion' OR binding->>'definitionHash' IS DISTINCT FROM item->>'definitionHash'
      OR binding->'source' IS DISTINCT FROM item->'source' THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
    SELECT * INTO stored FROM public.goal_content_instance_bindings WHERE workspace_id=p_workspace AND goal_instance_id=admission.goal_instance_id;
    IF FOUND THEN
      IF ROW(stored.binding_version,stored.normalization,stored.goal_key,stored.policy_version,stored.definition_hash,
        stored.source_kind,stored.source_world_id,stored.source_world_version,stored.package_content_hash,stored.base_revision,stored.base_content_hash)
        IS DISTINCT FROM ROW(1,'goal-definition-c14n-v1'::text,binding->>'goalKey',binding->>'policyVersion',binding->>'definitionHash',
        binding#>>'{source,sourceKind}',binding#>>'{source,sourceWorldId}',binding#>>'{source,sourceWorldVersion}',binding#>>'{source,packageContentHash}',
        binding#>>'{source,baseRevision}',binding#>>'{source,baseContentHash}') THEN RAISE EXCEPTION 'GOAL_CONTENT_IDENTITY_CONFLICT'; END IF;
    ELSE
      INSERT INTO public.goal_content_instance_bindings(workspace_id,world_id,worldline_id,goal_instance_id,scope_kind,record_id,story_id,
      goal_key,policy_version,binding_version,normalization,source_kind,source_world_id,source_world_version,package_content_hash,base_revision,base_content_hash,definition_hash)
    VALUES(p_workspace,admission.world_id,admission.worldline_id,admission.goal_instance_id,admission.scope_kind,admission.record_id,admission.story_id,
      binding->>'goalKey',binding->>'policyVersion',1,'goal-definition-c14n-v1',binding#>>'{source,sourceKind}',binding#>>'{source,sourceWorldId}',
      binding#>>'{source,sourceWorldVersion}',binding#>>'{source,packageContentHash}',binding#>>'{source,baseRevision}',binding#>>'{source,baseContentHash}',binding->>'definitionHash');
    END IF;
    PERFORM public.goal_content_binding_assert(p_workspace,admission.goal_instance_id);
  END LOOP;
  IF jsonb_array_length(p_bindings)<>jsonb_array_length(first_plan->'instances') THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
END;
$$;
ALTER FUNCTION goal_content_write_bind(text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION goal_content_write_bind(text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION goal_content_write_bind(text,text,text,text,jsonb) TO realm_runtime;

CREATE FUNCTION guard_goal_content_predecessor()
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
CREATE CONSTRAINT TRIGGER goal_content_binding_required AFTER INSERT ON goal_instances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_goal_content_predecessor();
CREATE CONSTRAINT TRIGGER goal_content_admission_complete AFTER INSERT ON goal_content_write_admissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_goal_content_predecessor();


-- Version metadata lives in the existing immutable group plan. No new grant to
-- admissions tables, no replacement of the body-v1 capability or source authority.
CREATE FUNCTION goal_restore_v2_plan_assert(p_workspace text,p_world text,p_plan jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE body jsonb; source_goal jsonb; target_goal jsonb; mapping jsonb; owner jsonb; target_owner jsonb; binding jsonb;
  source_goals jsonb; target_goals jsonb; count_goals integer; source_fact jsonb; target_fact jsonb;
BEGIN
  body:=(p_plan->>'sourceBody')::jsonb;
  source_goals:=body->'goals'; target_goals:=p_plan->'goals';
  IF source_goals->'schemaVersion' IS DISTINCT FROM '2'::jsonb
    OR source_goals->>'workspaceId' IS DISTINCT FROM body#>>'{manifest,scope,workspaceId}'
    OR jsonb_typeof(source_goals->'roots') IS DISTINCT FROM 'array'
    OR jsonb_typeof(target_goals->'roots') IS DISTINCT FROM 'array'
    OR jsonb_typeof(target_goals->'definitions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(target_goals->'assessments') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'mappings') m
    WHERE m#>>'{source,workspaceId}' IS DISTINCT FROM source_goals->>'workspaceId'
      OR m#>>'{target,workspaceId}' IS DISTINCT FROM p_workspace
      OR m#>>'{target,owner,worldId}' IS DISTINCT FROM p_world
      OR m#>>'{target,owner,worldlineId}' IS DISTINCT FROM p_plan->>'worldlineId'
      OR m#>>'{source,owner,scopeKind}' IS DISTINCT FROM m#>>'{target,owner,scopeKind}')
    OR (SELECT count(*) FROM jsonb_array_elements(p_plan->'mappings'))<>(SELECT count(DISTINCT jsonb_build_array(m->'entityKind',m->'source')) FROM jsonb_array_elements(p_plan->'mappings') m)
    OR (SELECT count(*) FROM jsonb_array_elements(p_plan->'mappings'))<>(SELECT count(DISTINCT jsonb_build_array(m->'entityKind',m->'target')) FROM jsonb_array_elements(p_plan->'mappings') m) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF jsonb_array_length(p_plan->'records')<>1+COALESCE(jsonb_array_length(body#>'{domain,records}'),0)
    OR p_plan#>>'{records,0,sourceRecordId}' IS DISTINCT FROM body#>>'{record,scope,recordId}'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(body#>'{domain,records}') saved WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_plan->'records') member WHERE member->>'sourceRecordId'=saved->>'recordId'))
    OR jsonb_array_length(p_plan->'stories')<>COALESCE(jsonb_array_length(body#>'{domain,stories}'),1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(body#>'{domain,stories}') saved WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_plan->'stories') member WHERE member->>'sourceStoryId'=saved->>'id'))
    OR jsonb_array_length(source_goals->'definitions')<>jsonb_array_length(target_goals->'definitions')
    OR jsonb_array_length(source_goals->'assessments')<>jsonb_array_length(target_goals->'assessments') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  FOR source_fact IN SELECT value FROM jsonb_array_elements(source_goals->'definitions') LOOP
    SELECT d INTO target_fact FROM jsonb_array_elements(target_goals->'definitions') d WHERE EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_plan->'mappings') m WHERE m->>'entityKind'='definition'
        AND m#>>'{source,id}'=source_fact->>'definitionId' AND m#>>'{source,owner,recordId}'=source_fact#>>'{scope,recordId}'
        AND m#>>'{target,id}'=d->>'definitionId' AND m#>>'{target,owner,recordId}'=d#>>'{scope,recordId}');
    IF NOT FOUND OR (source_fact-'scope'-'definitionId'-'goalInstanceId'-'policyVersion'-'supersedesDefinitionId'-'basisEventIds') IS DISTINCT FROM
      (target_fact-'scope'-'definitionId'-'goalInstanceId'-'policyVersion'-'supersedesDefinitionId'-'basisEventIds')
      OR jsonb_array_length(source_fact->'basisEventIds')<>jsonb_array_length(target_fact->'basisEventIds')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(source_fact->'basisEventIds') WITH ORDINALITY basis(id,pos) WHERE NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(p_plan->'mappings') m WHERE m->>'entityKind'='event' AND m#>>'{source,id}'=basis.id
          AND m#>>'{source,owner,recordId}'=source_fact#>>'{scope,recordId}' AND m#>>'{target,id}'=target_fact->'basisEventIds'->>(basis.pos::integer-1))) THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
  END LOOP;
  FOR source_fact IN SELECT value FROM jsonb_array_elements(source_goals->'assessments') LOOP
    SELECT a INTO target_fact FROM jsonb_array_elements(target_goals->'assessments') a WHERE EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_plan->'mappings') m WHERE m->>'entityKind'='assessment'
        AND m#>>'{source,id}'=source_fact->>'id' AND m#>'{source,owner}'=source_fact#>'{goal,owner}'
        AND m#>>'{target,id}'=a->>'id' AND m#>'{target,owner}'=a#>'{goal,owner}');
    IF NOT FOUND OR (source_fact-'id'-'goal'-'sourceEvent'-'evidenceEvents'-'evidenceSnapshotHash'-'policyVersion'-'result') IS DISTINCT FROM
      (target_fact-'id'-'goal'-'sourceEvent'-'evidenceEvents'-'evidenceSnapshotHash'-'policyVersion'-'result')
      OR ((source_fact->'result')-'policyVersion'-'evidenceSnapshotHash'-'evidenceEventIds') IS DISTINCT FROM
        ((target_fact->'result')-'policyVersion'-'evidenceSnapshotHash'-'evidenceEventIds')
      OR jsonb_array_length(source_fact->'evidenceEvents')<>jsonb_array_length(target_fact->'evidenceEvents')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'mappings') m WHERE m->>'entityKind'='instance'
        AND m#>>'{source,id}'=source_fact#>>'{goal,instanceId}' AND m#>'{source,owner}'=source_fact#>'{goal,owner}'
        AND m#>>'{target,id}'=target_fact#>>'{goal,instanceId}' AND m#>'{target,owner}'=target_fact#>'{goal,owner}')
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'mappings') m WHERE m->>'entityKind'='event'
        AND m#>>'{source,id}'=source_fact#>>'{sourceEvent,eventId}' AND m#>>'{source,owner,recordId}'=source_fact#>>'{sourceEvent,recordId}'
        AND m#>>'{target,id}'=target_fact#>>'{sourceEvent,eventId}' AND m#>>'{target,owner,recordId}'=target_fact#>>'{sourceEvent,recordId}')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(source_fact->'evidenceEvents') WITH ORDINALITY evidence(ref,pos) WHERE NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(p_plan->'mappings') m WHERE m->>'entityKind'='event' AND m#>>'{source,id}'=evidence.ref->>'eventId'
          AND m#>>'{source,owner,recordId}'=evidence.ref->>'recordId' AND m#>>'{target,id}'=target_fact->'evidenceEvents'->(evidence.pos::integer-1)->>'eventId'
          AND m#>>'{target,owner,recordId}'=target_fact->'evidenceEvents'->(evidence.pos::integer-1)->>'recordId')) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  END LOOP;
  count_goals:=0;
  FOR source_goal IN SELECT g FROM jsonb_array_elements(source_goals->'roots') r,LATERAL jsonb_array_elements(r->'instances') g LOOP
    count_goals:=count_goals+1;
    SELECT m INTO mapping FROM jsonb_array_elements(p_plan->'mappings') m WHERE m->>'entityKind'='instance'
      AND m#>'{source,owner}'=source_goal#>'{ref,owner}' AND m#>>'{source,id}'=source_goal#>>'{ref,instanceId}';
    IF NOT FOUND THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    SELECT g INTO target_goal FROM jsonb_array_elements(target_goals->'roots') r,LATERAL jsonb_array_elements(r->'instances') g
      WHERE g#>'{ref,owner}'=mapping#>'{target,owner}' AND g#>>'{ref,instanceId}'=mapping#>>'{target,id}';
    IF NOT FOUND OR (target_goal - 'ref' - 'definition' - 'predecessor' - 'policyVersion') IS DISTINCT FROM
      (source_goal - 'ref' - 'definition' - 'predecessor' - 'policyVersion') THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
    owner:=source_goal#>'{ref,owner}'; target_owner:=target_goal#>'{ref,owner}';
    IF target_owner->>'worldId' IS DISTINCT FROM p_world OR target_owner->>'worldlineId' IS DISTINCT FROM p_plan->>'worldlineId'
      OR (target_owner->>'scopeKind'='record' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'records') member
        WHERE member->>'sourceRecordId'=owner->>'recordId' AND member->>'recordId'=target_owner->>'recordId'))
      OR (target_owner->>'scopeKind'='story' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'stories') member
        WHERE member->>'sourceStoryId'=owner->>'storyId' AND member->>'storyId'=target_owner->>'storyId')) THEN RAISE EXCEPTION 'GOAL_SCOPE_MISMATCH'; END IF;
    IF source_goal#>>'{definition,kind}'='content' THEN
      binding:=target_goal#>'{definition,binding}';
      PERFORM public.goal_content_source_assert(binding->'source',p_world);
      IF binding - 'workspaceId' - 'owner' - 'instanceId' IS DISTINCT FROM (source_goal#>'{definition,binding}') - 'workspaceId' - 'owner' - 'instanceId'
        OR binding->>'workspaceId' IS DISTINCT FROM p_workspace OR binding->'owner' IS DISTINCT FROM target_owner
        OR binding->>'instanceId' IS DISTINCT FROM target_goal#>>'{ref,instanceId}'
        OR target_goal->>'policyVersion' IS DISTINCT FROM source_goal->>'policyVersion' THEN RAISE EXCEPTION 'GOAL_CONTENT_BINDING_INVALID'; END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(target_goals->'definitions') d
      WHERE d->>'goalInstanceId'=target_goal#>>'{ref,instanceId}' AND d->>'definitionId'=target_goal#>>'{definition,definitionId}'
        AND d#>>'{scope,recordId}'=target_owner->>'recordId' AND d->>'policyVersion'=target_goal->>'policyVersion') THEN RAISE EXCEPTION 'GOAL_DEFINITION_INVALID'; END IF;
    IF source_goal->'predecessor'='null'::jsonb THEN
      IF target_goal->'predecessor' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'GOAL_CONTENT_PREDECESSOR_INVALID'; END IF;
    ELSIF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'mappings') m WHERE m->>'entityKind'='instance'
      AND m#>'{source,owner}'=source_goal#>'{predecessor,ref,owner}' AND m#>>'{source,id}'=source_goal#>>'{predecessor,ref,instanceId}'
      AND m#>'{target,owner}'=target_goal#>'{predecessor,ref,owner}' AND m#>>'{target,id}'=target_goal#>>'{predecessor,ref,instanceId}'
      AND source_goal#>>'{predecessor,kind}'=target_goal#>>'{predecessor,kind}') THEN RAISE EXCEPTION 'GOAL_CONTENT_PREDECESSOR_INVALID'; END IF;
  END LOOP;
  IF count_goals<>(SELECT count(*) FROM jsonb_array_elements(target_goals->'roots') r,LATERAL jsonb_array_elements(r->'instances'))
    OR count_goals<>(SELECT count(DISTINCT g#>>'{ref,instanceId}') FROM jsonb_array_elements(target_goals->'roots') r,LATERAL jsonb_array_elements(r->'instances') g)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'records') member WHERE member->'definitions' IS DISTINCT FROM
      COALESCE((SELECT jsonb_agg(d ORDER BY d->>'definitionId') FROM jsonb_array_elements(target_goals->'definitions') d WHERE d#>>'{scope,recordId}'=member->>'recordId'),'[]'::jsonb)) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
END;
$$;
ALTER FUNCTION goal_restore_v2_plan_assert(text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION goal_restore_v2_plan_assert(text,text,jsonb) FROM PUBLIC;

CREATE FUNCTION record_goal_restore_group_prepare_v2(
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
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_plan) key WHERE key NOT IN ('operation','worldlineId','records','stories','source','bodyVersion','sourceBody','goals','mappings'))
    OR COALESCE(p_plan->>'operation','') NOT IN ('restore','branch')
    OR jsonb_typeof(p_plan->'records') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_plan->'stories') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  IF jsonb_array_length(p_plan->'records') NOT BETWEEN 1 AND 65
    OR jsonb_array_length(p_plan->'stories') NOT BETWEEN 1 AND 65 THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  -- The complete detached source, never an asserted digest or a key summary.
  IF p_plan->'bodyVersion' IS DISTINCT FROM '2'::jsonb
    OR jsonb_typeof(p_plan->'sourceBody') IS DISTINCT FROM 'string'
    OR p_body IS DISTINCT FROM encode(public.digest('realm-runtime-restore-body:v2:'||(p_plan->>'sourceBody'),'sha256'),'hex')
    OR jsonb_typeof(p_plan->'goals') IS DISTINCT FROM 'object'
    OR p_plan#>>'{goals,schemaVersion}' IS DISTINCT FROM '2'
    OR p_plan#>>'{goals,workspaceId}' IS DISTINCT FROM p_workspace
    OR jsonb_typeof(p_plan->'mappings') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  PERFORM public.goal_restore_v2_plan_assert(p_workspace,p_world,p_plan);
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
ALTER FUNCTION record_goal_restore_group_prepare_v2(text,text,text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_prepare_v2(text,text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_restore_group_prepare_v2(text,text,text,text,text,text,jsonb) TO realm_runtime;

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
  IF admission.group_plan->'bodyVersion'='2'::jsonb AND NOT EXISTS(
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
        AND story.premise=CASE WHEN admission.group_plan->'bodyVersion'='2'::jsonb THEN 'realm-save:body-v2:' ELSE 'realm-save:body-v1:' END||admission.body_commitment) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
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
        AND (admission.group_plan->'bodyVersion' IS DISTINCT FROM '2'::jsonb OR head.next_record_ordinal=(admission.group_plan#>>'{source,nextRecordOrdinal}')::bigint)
        AND line.parent_worldline_id=source.worldline_id AND story.premise=origin.premise
        AND record.start_tick=line.fork_tick AND record.start_ordinal=line.fork_ordinal
        AND line.fork_tick=COALESCE(head.last_world_tick,source.start_tick)
        AND line.fork_ordinal=COALESCE(head.last_world_ordinal,source.start_ordinal)) THEN RAISE EXCEPTION 'GOAL_BRANCH_PROOF_REQUIRED'; END IF;
  END IF;
END;
$$;
ALTER FUNCTION record_goal_restore_group_check(text,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_check(text,text) FROM PUBLIC;


CREATE FUNCTION goal_restore_v2_complete(p_workspace text,p_root text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE admission public.record_goal_restore_admissions%ROWTYPE; item jsonb; goal public.goal_instances%ROWTYPE; b jsonb;
BEGIN
  SELECT * INTO admission FROM public.record_goal_restore_admissions WHERE workspace_id=p_workspace AND record_id=p_root;
  IF NOT FOUND OR admission.group_plan->'bodyVersion' IS DISTINCT FROM '2'::jsonb THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
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
ALTER FUNCTION goal_restore_v2_complete(text,text) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION goal_restore_v2_complete(text,text) FROM PUBLIC;
CREATE FUNCTION guard_goal_restore_v2_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET realm.workspace_id='' AS $$
BEGIN
  PERFORM set_config('realm.workspace_id',NEW.workspace_id,true);
  IF NEW.group_plan->'bodyVersion'='2'::jsonb THEN PERFORM public.goal_restore_v2_complete(NEW.workspace_id,NEW.group_root); END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_goal_restore_v2_complete() OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION guard_goal_restore_v2_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER goal_restore_v2_group_complete AFTER INSERT ON record_goal_restore_admissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_goal_restore_v2_complete();

CREATE FUNCTION record_goal_restore_group_replay_v2(p_workspace text,p_proof text,p_world text,p_root text,p_body text,p_plan jsonb)
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
    OR admission.group_plan->'bodyVersion' IS DISTINCT FROM '2'::jsonb OR admission.group_plan IS DISTINCT FROM p_plan
    OR admission.body_commitment IS DISTINCT FROM p_body OR admission.plan_commitment IS DISTINCT FROM encode(public.digest(p_plan::text,'sha256'),'hex')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan->'records') member WHERE NOT EXISTS(SELECT 1 FROM public.record_goal_restore_admissions sibling JOIN public.records record
      ON record.workspace_id=sibling.workspace_id AND record.id=sibling.record_id WHERE sibling.workspace_id=p_workspace AND sibling.record_id=member->>'recordId'
        AND sibling.group_root=p_root AND sibling.group_plan=p_plan AND sibling.principal_id=actor AND sibling.transaction_id=admission.transaction_id
        AND record.world_id=admission.world_id AND record.worldline_id=admission.worldline_id AND record.story_id=sibling.target_story_id)) THEN RAISE EXCEPTION 'GOAL_RESTORE_PROOF_REQUIRED'; END IF;
  RETURN actor;
END;
$$;
ALTER FUNCTION record_goal_restore_group_replay_v2(text,text,text,text,text,jsonb) OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION record_goal_restore_group_replay_v2(text,text,text,text,text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_goal_restore_group_replay_v2(text,text,text,text,text,jsonb) TO realm_runtime;

-- Requeue after changes following an early SET CONSTRAINTS; the admission is
-- still restricted to its original transaction, not later gameplay.
CREATE FUNCTION guard_goal_restore_v2_member_complete() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp SET realm.workspace_id='' AS $$
DECLARE ws text; line text; root text;
BEGIN
  ws:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
  IF TG_TABLE_NAME='worldlines' THEN
    line:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
  ELSE
    line:=CASE WHEN TG_OP='DELETE' THEN OLD.worldline_id ELSE NEW.worldline_id END;
  END IF;
  PERFORM set_config('realm.workspace_id',ws,true);
  SELECT group_root INTO root FROM public.record_goal_restore_admissions WHERE workspace_id=ws AND worldline_id=line
    AND transaction_id=pg_current_xact_id() AND group_plan->'bodyVersion'='2'::jsonb LIMIT 1;
  IF FOUND THEN PERFORM public.goal_restore_v2_complete(ws,root); END IF;
  RETURN NEW;
END;
$$;
ALTER FUNCTION guard_goal_restore_v2_member_complete() OWNER TO realm_goal_authoring;
REVOKE ALL ON FUNCTION guard_goal_restore_v2_member_complete() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER goal_restore_v2_instance_complete AFTER INSERT OR UPDATE OR DELETE ON goal_instances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_goal_restore_v2_member_complete();
CREATE CONSTRAINT TRIGGER goal_restore_v2_assessment_complete AFTER INSERT OR UPDATE OR DELETE ON goal_assessments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_goal_restore_v2_member_complete();
CREATE CONSTRAINT TRIGGER goal_restore_v2_worldline_complete AFTER UPDATE OR DELETE ON worldlines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_goal_restore_v2_member_complete();
CREATE CONSTRAINT TRIGGER goal_restore_v2_story_complete AFTER UPDATE OR DELETE ON stories
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_goal_restore_v2_member_complete();
CREATE CONSTRAINT TRIGGER goal_restore_v2_record_complete AFTER UPDATE OR DELETE ON records
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_goal_restore_v2_member_complete();
-- Read-only validation inside the existing NOBYPASSRLS capability role.
GRANT SELECT ON goal_assessments TO realm_goal_authoring;
