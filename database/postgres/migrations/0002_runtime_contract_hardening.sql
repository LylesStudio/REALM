-- REALM Runtime Contract v1 hardening
-- PostgreSQL 16+ / pgvector
--
-- The migration runner owns the transaction boundary. This migration is
-- deliberately repeatable and does not remove or rewrite committed data.

-- An Event is a committed fact. Reject in-place correction and deletion even
-- when a caller accidentally retains broader table privileges.
CREATE OR REPLACE FUNCTION guard_event_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'committed events are append-only; append a correction event';
END;
$$;

DROP TRIGGER IF EXISTS events_append_only_guard ON events;
CREATE TRIGGER events_append_only_guard
BEFORE UPDATE OR DELETE ON events
FOR EACH ROW
EXECUTE FUNCTION guard_event_append_only();

-- The array on visibility_policies remains the canonical import/compatibility
-- representation. This normalized relation gives queries an indexed,
-- workspace-qualified audience edge and lets foreign keys reject unknown
-- CharacterInstances.
CREATE TABLE IF NOT EXISTS visibility_policy_audiences (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  visibility_policy_id text NOT NULL,
  character_instance_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    workspace_id,
    visibility_policy_id,
    character_instance_id
  ),
  CONSTRAINT visibility_policy_audiences_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT visibility_policy_audiences_policy_fk
    FOREIGN KEY (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      visibility_policy_id
    ) REFERENCES visibility_policies (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      id
    ) ON DELETE CASCADE,
  CONSTRAINT visibility_policy_audiences_character_fk
    FOREIGN KEY (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      character_instance_id
    ) REFERENCES character_instances (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      id
    )
);

CREATE INDEX IF NOT EXISTS visibility_policy_audiences_character_idx
  ON visibility_policy_audiences (
    workspace_id,
    worldline_id,
    record_id,
    character_instance_id,
    visibility_policy_id
  );

-- Backfill the normalized edges before installing their immutability guards.
-- DISTINCT deliberately turns a duplicate legacy array into a validation
-- failure below instead of preserving ambiguous audience data.
INSERT INTO visibility_policy_audiences (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  visibility_policy_id,
  character_instance_id
)
SELECT DISTINCT
  policy.workspace_id,
  policy.world_id,
  policy.worldline_id,
  policy.record_id,
  policy.id,
  audience.character_instance_id
FROM visibility_policies AS policy
CROSS JOIN LATERAL unnest(policy.audience_character_instance_ids)
  AS audience(character_instance_id)
WHERE NOT EXISTS (
  SELECT 1
  FROM visibility_policy_audiences AS existing
  WHERE existing.workspace_id = policy.workspace_id
    AND existing.visibility_policy_id = policy.id
    AND existing.character_instance_id = audience.character_instance_id
)
ON CONFLICT (
  workspace_id,
  visibility_policy_id,
  character_instance_id
) DO NOTHING;

DO $validate_visibility_policy_audiences$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM visibility_policies AS policy
    WHERE cardinality(policy.audience_character_instance_ids) <> (
      SELECT count(*)
      FROM visibility_policy_audiences AS audience
      WHERE audience.workspace_id = policy.workspace_id
        AND audience.visibility_policy_id = policy.id
    )
    OR EXISTS (
      SELECT 1
      FROM unnest(policy.audience_character_instance_ids)
        AS expected(character_instance_id)
      WHERE expected.character_instance_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM visibility_policy_audiences AS audience
          WHERE audience.workspace_id = policy.workspace_id
            AND audience.visibility_policy_id = policy.id
            AND audience.character_instance_id = expected.character_instance_id
        )
    )
  ) THEN
    RAISE EXCEPTION
      'visibility policy audience normalization failed: arrays must contain unique, valid CharacterInstance ids';
  END IF;
END;
$validate_visibility_policy_audiences$;

CREATE OR REPLACE FUNCTION populate_visibility_policy_audiences()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  distinct_audience_count bigint;
BEGIN
  SELECT count(DISTINCT member.character_instance_id)
  INTO distinct_audience_count
  FROM unnest(NEW.audience_character_instance_ids)
    AS member(character_instance_id)
  WHERE member.character_instance_id IS NOT NULL;

  IF EXISTS (
    SELECT 1
    FROM unnest(NEW.audience_character_instance_ids)
      AS member(character_instance_id)
    WHERE member.character_instance_id IS NULL
  ) OR distinct_audience_count <> cardinality(NEW.audience_character_instance_ids) THEN
    RAISE EXCEPTION
      'visibility policy audiences must contain unique, non-null CharacterInstance ids';
  END IF;

  INSERT INTO visibility_policy_audiences (
    workspace_id,
    world_id,
    worldline_id,
    record_id,
    visibility_policy_id,
    character_instance_id
  )
  SELECT
    NEW.workspace_id,
    NEW.world_id,
    NEW.worldline_id,
    NEW.record_id,
    NEW.id,
    member.character_instance_id
  FROM unnest(NEW.audience_character_instance_ids)
    AS member(character_instance_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS visibility_policies_audience_populate
  ON visibility_policies;
CREATE TRIGGER visibility_policies_audience_populate
AFTER INSERT ON visibility_policies
FOR EACH ROW
EXECUTE FUNCTION populate_visibility_policy_audiences();

CREATE OR REPLACE FUNCTION guard_visibility_policy_audience_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM visibility_policies AS policy
    WHERE policy.workspace_id = NEW.workspace_id
      AND policy.world_id = NEW.world_id
      AND policy.worldline_id = NEW.worldline_id
      AND policy.record_id = NEW.record_id
      AND policy.id = NEW.visibility_policy_id
      AND NEW.character_instance_id = ANY (
        policy.audience_character_instance_ids
      )
  ) THEN
    RAISE EXCEPTION
      'normalized audience must already exist in the immutable policy array';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM events AS event
    WHERE event.workspace_id = NEW.workspace_id
      AND event.world_id = NEW.world_id
      AND event.worldline_id = NEW.worldline_id
      AND event.record_id = NEW.record_id
      AND event.visibility_policy_id = NEW.visibility_policy_id
  ) THEN
    RAISE EXCEPTION
      'an audience cannot be expanded after its policy protects a committed event';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_visibility_policy_audience_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'normalized visibility policy audiences are immutable; create a new policy version';
END;
$$;

DROP TRIGGER IF EXISTS visibility_policy_audiences_insert_guard
  ON visibility_policy_audiences;
CREATE TRIGGER visibility_policy_audiences_insert_guard
BEFORE INSERT ON visibility_policy_audiences
FOR EACH ROW
EXECUTE FUNCTION guard_visibility_policy_audience_insert();

DROP TRIGGER IF EXISTS visibility_policy_audiences_mutation_guard
  ON visibility_policy_audiences;
CREATE TRIGGER visibility_policy_audiences_mutation_guard
BEFORE UPDATE OR DELETE ON visibility_policy_audiences
FOR EACH ROW
EXECUTE FUNCTION guard_visibility_policy_audience_immutable();

-- An Event may only bind a fully reconciled audience snapshot. This check is
-- intentionally performed before the Event is committed, rather than trying
-- to repair or filter a policy after the fact.
CREATE OR REPLACE FUNCTION validate_event_visibility_audience()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_audience text[];
  normalized_audience text[];
BEGIN
  SELECT ARRAY(
    SELECT member.character_instance_id
    FROM unnest(policy.audience_character_instance_ids)
      AS member(character_instance_id)
    ORDER BY member.character_instance_id
  )
  INTO source_audience
  FROM visibility_policies AS policy
  WHERE policy.workspace_id = NEW.workspace_id
    AND policy.world_id = NEW.world_id
    AND policy.worldline_id = NEW.worldline_id
    AND policy.record_id = NEW.record_id
    AND policy.id = NEW.visibility_policy_id;

  IF source_audience IS NULL THEN
    RAISE EXCEPTION 'event visibility policy does not exist in its Record scope';
  END IF;

  SELECT ARRAY(
    SELECT audience.character_instance_id
    FROM visibility_policy_audiences AS audience
    WHERE audience.workspace_id = NEW.workspace_id
      AND audience.world_id = NEW.world_id
      AND audience.worldline_id = NEW.worldline_id
      AND audience.record_id = NEW.record_id
      AND audience.visibility_policy_id = NEW.visibility_policy_id
    ORDER BY audience.character_instance_id
  )
  INTO normalized_audience;

  IF source_audience IS DISTINCT FROM normalized_audience THEN
    RAISE EXCEPTION
      'event visibility policy audience is not fully normalized';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_visibility_audience_guard ON events;
CREATE TRIGGER events_visibility_audience_guard
BEFORE INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION validate_event_visibility_audience();

-- Exact compiled context is a protected, immutable audit artifact. It records
-- who the projection was built for, the causal cutoff used, and cache identity
-- without allowing a later retry to rewrite history.
CREATE TABLE IF NOT EXISTS context_snapshots (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  context_manifest_id text NOT NULL,
  turn_run_id text,
  id text NOT NULL,
  scope_kind text NOT NULL,
  scope_id text,
  purpose text NOT NULL,
  effective_tick bigint NOT NULL,
  effective_ordinal bigint NOT NULL,
  knowledge_cutoff_tick bigint NOT NULL,
  knowledge_cutoff_ordinal bigint NOT NULL,
  protocol_version text NOT NULL,
  cache_epoch text NOT NULL,
  cache_family_id text NOT NULL,
  prefix_hash text NOT NULL,
  dynamic_hash text NOT NULL,
  snapshot_hash text NOT NULL,
  prefix_payload jsonb NOT NULL,
  dynamic_payload jsonb NOT NULL,
  token_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT context_snapshots_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT context_snapshots_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id)
    ON DELETE CASCADE,
  CONSTRAINT context_snapshots_manifest_fk
    FOREIGN KEY (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      context_manifest_id
    ) REFERENCES context_manifests (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      id
    ),
  CONSTRAINT context_snapshots_turn_run_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, turn_run_id)
    REFERENCES turn_runs (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT context_snapshots_scope_kind_check
    CHECK (scope_kind IN ('dm', 'narrator', 'character', 'principal')),
  CONSTRAINT context_snapshots_scope_shape_check CHECK (
    (scope_kind IN ('dm', 'narrator') AND scope_id IS NULL)
    OR
    (scope_kind IN ('character', 'principal') AND scope_id IS NOT NULL)
  ),
  CONSTRAINT context_snapshots_temporal_check CHECK (
    effective_tick >= 0
    AND effective_ordinal >= 0
    AND knowledge_cutoff_tick >= 0
    AND knowledge_cutoff_ordinal >= 0
    AND (knowledge_cutoff_tick, knowledge_cutoff_ordinal)
      <= (effective_tick, effective_ordinal)
  ),
  CHECK (length(btrim(purpose)) > 0),
  CHECK (length(btrim(protocol_version)) > 0),
  CHECK (length(btrim(cache_epoch)) > 0),
  CHECK (length(btrim(cache_family_id)) > 0),
  CHECK (length(btrim(prefix_hash)) > 0),
  CHECK (length(btrim(dynamic_hash)) > 0),
  CHECK (length(btrim(snapshot_hash)) > 0),
  CHECK (jsonb_typeof(prefix_payload) = 'object'),
  CHECK (jsonb_typeof(dynamic_payload) = 'object'),
  CHECK (token_count >= 0),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS context_snapshots_scope_cursor_idx
  ON context_snapshots (
    workspace_id,
    worldline_id,
    record_id,
    scope_kind,
    scope_id,
    effective_tick,
    effective_ordinal
  );
CREATE INDEX IF NOT EXISTS context_snapshots_cache_family_idx
  ON context_snapshots (
    workspace_id,
    cache_family_id,
    cache_epoch,
    created_at
  );
CREATE UNIQUE INDEX IF NOT EXISTS context_snapshots_snapshot_hash_uidx
  ON context_snapshots (workspace_id, cache_family_id, snapshot_hash);

CREATE OR REPLACE FUNCTION guard_context_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'context snapshots are immutable audit artifacts';
END;
$$;

DROP TRIGGER IF EXISTS context_snapshots_mutation_guard
  ON context_snapshots;
CREATE TRIGGER context_snapshots_mutation_guard
BEFORE UPDATE OR DELETE ON context_snapshots
FOR EACH ROW
EXECUTE FUNCTION guard_context_snapshot_immutable();

COMMENT ON TABLE visibility_policy_audiences IS
  'Normalized immutable audience snapshot. It must exactly match its visibility policy array before Event commit.';
COMMENT ON TABLE context_snapshots IS
  'Protected exact context projection and cache identity; only control-plane readers may inspect it.';

-- FORCE RLS also applies to the table owner. The application roles below must
-- never own these relations and receive no BYPASSRLS capability.
DO $realm_hardening_workspace_rls$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'visibility_policy_audiences',
    'context_snapshots'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format(
      'DROP POLICY IF EXISTS realm_workspace_isolation ON %I',
      relation_name
    );
    EXECUTE format(
      'CREATE POLICY realm_workspace_isolation ON %I '
      || 'USING (workspace_id = realm_current_workspace_id()) '
      || 'WITH CHECK (workspace_id = realm_current_workspace_id())',
      relation_name
    );
  END LOOP;
END;
$realm_hardening_workspace_rls$;

-- Local application roles have no password embedded in source. Deployment or
-- local bootstrap code owns credential assignment and connection admission.
DO $realm_application_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realm_runtime') THEN
    EXECUTE 'CREATE ROLE realm_runtime LOGIN NOSUPERUSER NOCREATEDB '
      || 'NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  ELSE
    EXECUTE 'ALTER ROLE realm_runtime WITH LOGIN NOSUPERUSER NOCREATEDB '
      || 'NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realm_control') THEN
    EXECUTE 'CREATE ROLE realm_control LOGIN NOSUPERUSER NOCREATEDB '
      || 'NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  ELSE
    EXECUTE 'ALTER ROLE realm_control WITH LOGIN NOSUPERUSER NOCREATEDB '
      || 'NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$realm_application_roles$;

GRANT USAGE ON SCHEMA public TO realm_runtime, realm_control;

-- Start from explicit table capabilities so rerunning this migration also
-- reconciles an accidentally over-broad direct grant.
REVOKE ALL PRIVILEGES ON
  workspaces,
  worlds,
  worldlines,
  stories,
  records,
  scenes,
  character_definitions,
  character_continuities,
  character_instances,
  player_world_memberships,
  participants,
  visibility_policies,
  visibility_policy_audiences,
  command_inbox,
  turn_runs,
  events,
  record_heads,
  observations,
  context_manifests,
  context_snapshots,
  outbox
FROM realm_runtime, realm_control;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspaces,
  worlds,
  worldlines,
  stories,
  records,
  scenes,
  character_definitions,
  character_continuities,
  character_instances,
  player_world_memberships,
  participants,
  visibility_policies,
  command_inbox,
  turn_runs,
  record_heads,
  observations,
  outbox
TO realm_runtime, realm_control;

GRANT SELECT, INSERT ON events
TO realm_runtime, realm_control;
REVOKE UPDATE, DELETE ON events
FROM PUBLIC, realm_runtime, realm_control;

GRANT SELECT, INSERT ON visibility_policy_audiences
TO realm_runtime, realm_control;
REVOKE UPDATE, DELETE ON visibility_policy_audiences
FROM PUBLIC, realm_runtime, realm_control;

-- Runtime workers may persist diagnostics but may not read prompt-selection
-- details or exact compiled context. The control plane remains RLS-scoped and
-- is the only ordinary application role permitted to inspect either table.
REVOKE ALL PRIVILEGES ON context_manifests, context_snapshots
FROM PUBLIC, realm_runtime, realm_control;
GRANT INSERT ON context_manifests, context_snapshots
TO realm_runtime;
GRANT SELECT, INSERT ON context_manifests, context_snapshots
TO realm_control;
