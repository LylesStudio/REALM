-- Narrative state is a rebuildable public Record projection, never an alternate fact ledger.
CREATE TABLE IF NOT EXISTS record_narrative_state (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  source_event_id text NOT NULL,
  source_record_version bigint NOT NULL CHECK (source_record_version>=1),
  source_ordinal bigint NOT NULL CHECK (source_ordinal>=1),
  document jsonb NOT NULL CHECK (jsonb_typeof(document)='object' AND octet_length(document::text)<=2097152),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id,record_id),
  CONSTRAINT record_narrative_state_workspace_fk FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT record_narrative_state_record_fk FOREIGN KEY (workspace_id,world_id,worldline_id,record_id)
    REFERENCES records (workspace_id,world_id,worldline_id,id) ON DELETE CASCADE,
  CONSTRAINT record_narrative_state_source_fk FOREIGN KEY (workspace_id,world_id,worldline_id,record_id,source_event_id)
    REFERENCES events (workspace_id,world_id,worldline_id,record_id,id) ON DELETE CASCADE
);
ALTER TABLE record_narrative_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_narrative_state FORCE ROW LEVEL SECURITY;
CREATE POLICY realm_workspace_isolation ON record_narrative_state
  USING (workspace_id=realm_current_workspace_id()) WITH CHECK (workspace_id=realm_current_workspace_id());
GRANT SELECT,INSERT,UPDATE ON record_narrative_state TO realm_runtime;

CREATE FUNCTION guard_record_narrative_state_source()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE v_event public.events%ROWTYPE; v_payload jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.workspace_id,NEW.world_id,NEW.worldline_id,NEW.record_id)
      IS DISTINCT FROM ROW(OLD.workspace_id,OLD.world_id,OLD.worldline_id,OLD.record_id)
      OR NEW.source_record_version<OLD.source_record_version OR NEW.source_ordinal<OLD.source_ordinal
      OR NEW.revision<OLD.revision THEN RAISE EXCEPTION 'NARRATIVE_SOURCE_INVALID'; END IF;
  END IF;
  SELECT event.* INTO v_event FROM public.events event JOIN public.visibility_policies policy
    ON policy.workspace_id=event.workspace_id AND policy.id=event.visibility_policy_id
    AND policy.world_id=event.world_id AND policy.worldline_id=event.worldline_id AND policy.record_id=event.record_id
    WHERE event.workspace_id=NEW.workspace_id AND event.world_id=NEW.world_id AND event.worldline_id=NEW.worldline_id
      AND event.record_id=NEW.record_id AND event.id=NEW.source_event_id AND policy.policy_kind='public';
  IF NOT FOUND THEN RAISE EXCEPTION 'NARRATIVE_SOURCE_INVALID'; END IF;
  v_payload:=COALESCE(v_event.payload->'__realmRuntimePayload',v_event.payload);
  IF v_event.event_kind IS DISTINCT FROM 'narration.committed' OR v_payload->>'role' IS DISTINCT FROM 'narrator'
    OR NEW.source_record_version IS DISTINCT FROM v_event.record_version OR NEW.source_ordinal IS DISTINCT FROM v_event.record_ordinal
    OR NEW.document IS DISTINCT FROM v_payload->'narrativeState'
    OR NEW.document->>'lastEventId' IS DISTINCT FROM NEW.source_event_id
    OR NEW.document->>'revision' IS DISTINCT FROM NEW.revision::text
    OR NEW.document->'scope' IS DISTINCT FROM jsonb_build_object('workspaceId',NEW.workspace_id,'worldId',NEW.world_id,
      'worldlineId',NEW.worldline_id,'recordId',NEW.record_id) THEN RAISE EXCEPTION 'NARRATIVE_SOURCE_INVALID'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_narrative_state_source_guard BEFORE INSERT OR UPDATE ON record_narrative_state
  FOR EACH ROW EXECUTE FUNCTION guard_record_narrative_state_source();
