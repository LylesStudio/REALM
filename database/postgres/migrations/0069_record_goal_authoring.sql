-- Record-authored goals are versioned content bound to the existing runtime.
-- This migration does not rewrite legacy Goal identities or attempts.
CREATE TABLE IF NOT EXISTS record_goal_definitions (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  goal_id text NOT NULL,
  definition_version integer NOT NULL CHECK (definition_version >= 1),
  goal_key text NOT NULL,
  policy_version text NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  supersedes_definition_id text,
  created_by_principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id, goal_key, policy_version),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, goal_id, definition_version),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT record_goal_definitions_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT record_goal_definitions_previous_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, supersedes_definition_id)
    REFERENCES record_goal_definitions (workspace_id, world_id, worldline_id, record_id, id),
  CHECK (length(btrim(id)) > 0 AND length(btrim(goal_id)) BETWEEN 1 AND 160),
  CHECK (length(btrim(goal_key)) > 0 AND length(btrim(policy_version)) > 0),
  CHECK (length(btrim(created_by_principal_id)) > 0),
  CHECK ((definition_version = 1 AND supersedes_definition_id IS NULL)
    OR (definition_version > 1 AND supersedes_definition_id IS NOT NULL))
);

ALTER TABLE goal_instances
  ADD COLUMN IF NOT EXISTS definition_source text NOT NULL DEFAULT 'content',
  ADD COLUMN IF NOT EXISTS definition_id text,
  ADD COLUMN IF NOT EXISTS resolution_kind text NOT NULL DEFAULT 'natural',
  ADD COLUMN IF NOT EXISTS evidence_start_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS evidence_start_ordinal bigint NOT NULL DEFAULT 0;

ALTER TABLE goal_instances
  ADD CONSTRAINT goal_instances_definition_source_check CHECK (
    (definition_source = 'content' AND definition_id IS NULL)
    OR (definition_source = 'record' AND definition_id IS NOT NULL AND scope_kind = 'record')
  ),
  ADD CONSTRAINT goal_instances_resolution_kind_check CHECK (
    resolution_kind = 'natural' OR (resolution_kind IN ('withdrawn', 'superseded') AND state = 'settled')
  ),
  ADD CONSTRAINT goal_instances_evidence_start_check CHECK (
    evidence_start_version >= 0 AND evidence_start_ordinal >= 0
    AND ((evidence_start_version = 0) = (evidence_start_ordinal = 0))
  ),
  ADD CONSTRAINT goal_instances_record_definition_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, definition_id, goal_key, policy_version)
    REFERENCES record_goal_definitions (workspace_id, world_id, worldline_id, record_id, id, goal_key, policy_version);

CREATE TABLE IF NOT EXISTS record_goal_commands (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  principal_id text NOT NULL,
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 160),
  request_fingerprint text NOT NULL CHECK (length(btrim(request_fingerprint)) > 0),
  operation text NOT NULL CHECK (operation IN ('create', 'revise', 'withdraw', 'evolve')),
  goal_instance_id text NOT NULL,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, world_id, worldline_id, record_id, principal_id, idempotency_key),
  CONSTRAINT record_goal_commands_goal_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, goal_instance_id)
    REFERENCES goal_instances (workspace_id, world_id, worldline_id, record_id, id),
  CHECK (length(btrim(principal_id)) > 0)
);

ALTER TABLE record_goal_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_goal_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY realm_workspace_isolation ON record_goal_definitions
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());
ALTER TABLE record_goal_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_goal_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY realm_workspace_isolation ON record_goal_commands
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());
GRANT SELECT, INSERT ON record_goal_definitions, record_goal_commands TO realm_runtime;

CREATE OR REPLACE FUNCTION guard_record_goal_definition_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.definition->>'source' IS DISTINCT FROM 'record'
    OR NEW.definition->>'definitionId' IS DISTINCT FROM NEW.id
    OR NEW.definition->>'goalId' IS DISTINCT FROM NEW.goal_id
    OR NEW.definition->>'goalKey' IS DISTINCT FROM NEW.goal_key
    OR NEW.definition->>'policyVersion' IS DISTINCT FROM NEW.policy_version
    OR jsonb_typeof(NEW.definition->'definitionVersion') IS DISTINCT FROM 'number'
    OR NEW.definition->>'definitionVersion' IS DISTINCT FROM NEW.definition_version::text
    OR NEW.definition->>'supersedesDefinitionId' IS DISTINCT FROM NEW.supersedes_definition_id
    OR NEW.definition#>>'{scope,workspaceId}' IS DISTINCT FROM NEW.workspace_id
    OR NEW.definition#>>'{scope,worldId}' IS DISTINCT FROM NEW.world_id
    OR NEW.definition#>>'{scope,worldlineId}' IS DISTINCT FROM NEW.worldline_id
    OR NEW.definition#>>'{scope,recordId}' IS DISTINCT FROM NEW.record_id
    OR jsonb_typeof(NEW.definition#>'{activationHead,recordVersion}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(NEW.definition#>'{activationHead,ordinal}') IS DISTINCT FROM 'number'
    OR NOT COALESCE((NEW.definition#>>'{activationHead,recordVersion}') ~ '^(0|[1-9][0-9]*)$', false)
    OR NOT COALESCE((NEW.definition#>>'{activationHead,ordinal}') ~ '^(0|[1-9][0-9]*)$', false) THEN
    RAISE EXCEPTION 'Record Goal definition binding invalid';
  END IF;
  IF (NEW.definition#>>'{activationHead,recordVersion}')::numeric > 9007199254740991
    OR (NEW.definition#>>'{activationHead,ordinal}')::numeric > 9007199254740991
    OR (((NEW.definition#>>'{activationHead,recordVersion}')::numeric = 0)
      <> ((NEW.definition#>>'{activationHead,ordinal}')::numeric = 0)) THEN
    RAISE EXCEPTION 'Record Goal definition binding invalid';
  END IF;
  IF NEW.definition_version > 1 AND NOT EXISTS (
    SELECT 1 FROM record_goal_definitions AS previous
    WHERE previous.workspace_id = NEW.workspace_id AND previous.world_id = NEW.world_id
      AND previous.worldline_id = NEW.worldline_id AND previous.record_id = NEW.record_id
      AND previous.id = NEW.supersedes_definition_id AND previous.goal_id = NEW.goal_id
      AND previous.definition_version = NEW.definition_version - 1
  ) THEN
    RAISE EXCEPTION 'Record Goal definition chain invalid';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_goal_definition_binding_guard
  BEFORE INSERT ON record_goal_definitions FOR EACH ROW
  EXECUTE FUNCTION guard_record_goal_definition_binding();

CREATE OR REPLACE FUNCTION guard_record_goal_instance_admission()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound_definition jsonb;
BEGIN
  IF NEW.definition_source = 'record' THEN
    SELECT definition INTO bound_definition FROM record_goal_definitions
    WHERE workspace_id = NEW.workspace_id AND world_id = NEW.world_id
      AND worldline_id = NEW.worldline_id AND record_id = NEW.record_id
      AND id = NEW.definition_id AND goal_key = NEW.goal_key AND policy_version = NEW.policy_version;
    IF bound_definition IS NULL
      OR NEW.evidence_start_version IS DISTINCT FROM (bound_definition#>>'{activationHead,recordVersion}')::bigint
      OR NEW.evidence_start_ordinal IS DISTINCT FROM (bound_definition#>>'{activationHead,ordinal}')::bigint THEN
      RAISE EXCEPTION 'Record Goal instance binding invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_goal_instance_admission_guard
  BEFORE INSERT ON goal_instances FOR EACH ROW
  EXECUTE FUNCTION guard_record_goal_instance_admission();

CREATE OR REPLACE FUNCTION guard_record_goal_instance_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.definition_source IS DISTINCT FROM OLD.definition_source
    OR NEW.definition_id IS DISTINCT FROM OLD.definition_id
    OR NEW.evidence_start_version IS DISTINCT FROM OLD.evidence_start_version
    OR NEW.evidence_start_ordinal IS DISTINCT FROM OLD.evidence_start_ordinal
    OR (OLD.definition_source = 'record' AND (
      NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.world_id IS DISTINCT FROM OLD.world_id
      OR NEW.worldline_id IS DISTINCT FROM OLD.worldline_id
      OR NEW.record_id IS DISTINCT FROM OLD.record_id
      OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
      OR NEW.goal_key IS DISTINCT FROM OLD.goal_key
      OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    )) THEN
    RAISE EXCEPTION 'Record Goal instance binding is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_goal_instance_binding_guard
  BEFORE UPDATE ON goal_instances FOR EACH ROW
  EXECUTE FUNCTION guard_record_goal_instance_binding();

CREATE OR REPLACE FUNCTION guard_goal_terminal_resolution_kind()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state IN ('completed', 'failed', 'settled')
    AND NEW.resolution_kind IS DISTINCT FROM OLD.resolution_kind THEN
    RAISE EXCEPTION 'terminal Goal provenance is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER goal_terminal_resolution_kind_guard
  BEFORE UPDATE ON goal_instances FOR EACH ROW
  EXECUTE FUNCTION guard_goal_terminal_resolution_kind();

CREATE OR REPLACE FUNCTION guard_record_goal_history_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Record Goal history is append-only';
END;
$$;
CREATE TRIGGER record_goal_definitions_append_only_guard
  BEFORE UPDATE OR DELETE ON record_goal_definitions
  FOR EACH ROW EXECUTE FUNCTION guard_record_goal_history_append_only();
CREATE TRIGGER record_goal_commands_append_only_guard
  BEFORE UPDATE OR DELETE ON record_goal_commands
  FOR EACH ROW EXECUTE FUNCTION guard_record_goal_history_append_only();
