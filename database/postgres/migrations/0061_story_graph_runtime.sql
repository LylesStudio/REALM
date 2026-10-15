-- REALM B2：Story Graph / UnlockRule runtime。
--
-- Story definitions remain content-owned declarations. These tables keep only
-- the server-authoritative runtime state for a Story's record nodes:
--
-- - story_node_instances is a mutable projection with a revision and an
--   optional instantiated Record binding;
-- - story_unlock_ledger is append-only evidence of unlock/rollback decisions;
-- - every unlock is derived from committed database facts by the repository,
--   never from a client click, free text, or an unvalidated model sentence.
--
-- Record creation and node activation are committed in the same transaction as
-- the unlock ledger row. A failed Record insert therefore rolls back the node
-- projection and its ledger evidence together.

-- The node-to-record foreign key includes story_id so a malformed runtime write
-- cannot bind a node to a Record from a different Story while retaining the
-- same worldline anchors.
CREATE UNIQUE INDEX IF NOT EXISTS records_story_node_identity_key
  ON records (workspace_id, world_id, worldline_id, story_id, id);

CREATE TABLE IF NOT EXISTS story_node_instances (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  story_id text NOT NULL,
  node_key text NOT NULL,
  id text NOT NULL,
  state text NOT NULL DEFAULT 'locked',
  revision bigint NOT NULL DEFAULT 0,
  record_id text,
  definition_hash text NOT NULL,
  unlock_evidence_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  unlock_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unlocked_at timestamptz,
  activated_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, story_id, node_key),
  CONSTRAINT story_node_instances_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT story_node_instances_story_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, story_id)
    REFERENCES stories (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT story_node_instances_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, story_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, story_id, id)
    ON DELETE CASCADE,
  CONSTRAINT story_node_instances_state_check
    CHECK (state IN ('locked', 'active', 'completed', 'failed')),
  CONSTRAINT story_node_instances_revision_check
    CHECK (revision >= 0),
  CONSTRAINT story_node_instances_identity_check
    CHECK (length(btrim(node_key)) > 0),
  CONSTRAINT story_node_instances_definition_hash_check
    CHECK (length(btrim(definition_hash)) > 0),
  CONSTRAINT story_node_instances_evidence_array_check
    CHECK (array_position(unlock_evidence_event_ids, NULL) IS NULL),
  CONSTRAINT story_node_instances_evidence_shape_check
    CHECK (jsonb_typeof(unlock_evidence) = 'object'),
  CONSTRAINT story_node_instances_state_shape_check
    CHECK (
      (state = 'locked' AND record_id IS NULL AND unlocked_at IS NULL AND activated_at IS NULL)
      OR
      (state IN ('active', 'completed', 'failed')
        AND record_id IS NOT NULL
        AND unlocked_at IS NOT NULL
        AND activated_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS story_node_instances_story_idx
  ON story_node_instances (workspace_id, story_id, state, updated_at, node_key);

CREATE UNIQUE INDEX IF NOT EXISTS story_node_instances_scope_identity_key
  ON story_node_instances (workspace_id, world_id, worldline_id, story_id, node_key, id);

CREATE TABLE IF NOT EXISTS story_unlock_ledger (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  story_id text NOT NULL,
  id text NOT NULL,
  story_node_instance_id text NOT NULL,
  node_key text NOT NULL,
  transition text NOT NULL,
  idempotency_key text NOT NULL,
  record_id text,
  evidence_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  evidence_hash text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT story_unlock_ledger_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT story_unlock_ledger_story_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, story_id)
    REFERENCES stories (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT story_unlock_ledger_node_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, story_id, node_key, story_node_instance_id)
    REFERENCES story_node_instances (workspace_id, world_id, worldline_id, story_id, node_key, id)
    ON DELETE CASCADE,
  CONSTRAINT story_unlock_ledger_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, story_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, story_id, id)
    ON DELETE CASCADE,
  CONSTRAINT story_unlock_ledger_transition_check
    CHECK (transition IN ('unlocked', 'rolled_back')),
  CONSTRAINT story_unlock_ledger_identity_check
    CHECK (length(btrim(node_key)) > 0 AND length(btrim(idempotency_key)) > 0),
  CONSTRAINT story_unlock_ledger_hash_check
    CHECK (length(btrim(evidence_hash)) > 0),
  CONSTRAINT story_unlock_ledger_key_length_check
    CHECK (length(idempotency_key) <= 256),
  CONSTRAINT story_unlock_ledger_evidence_array_check
    CHECK (array_position(evidence_event_ids, NULL) IS NULL),
  CONSTRAINT story_unlock_ledger_evidence_shape_check
    CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE INDEX IF NOT EXISTS story_unlock_ledger_story_idx
  ON story_unlock_ledger (workspace_id, story_id, created_at, id);

CREATE OR REPLACE FUNCTION guard_story_unlock_ledger_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Parent Story deletion may cascade through this table. Direct UPDATE/DELETE
  -- remains forbidden for the application-facing runtime role.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'story unlock ledger is immutable';
END;
$$;

DROP TRIGGER IF EXISTS story_unlock_ledger_append_only_guard ON story_unlock_ledger;
CREATE TRIGGER story_unlock_ledger_append_only_guard
BEFORE UPDATE OR DELETE ON story_unlock_ledger
FOR EACH ROW
EXECUTE FUNCTION guard_story_unlock_ledger_append_only();

ALTER TABLE story_node_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_node_instances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON story_node_instances;
CREATE POLICY realm_workspace_isolation ON story_node_instances
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE story_unlock_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_unlock_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON story_unlock_ledger;
CREATE POLICY realm_workspace_isolation ON story_unlock_ledger
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON story_node_instances TO realm_runtime;
GRANT SELECT, INSERT ON story_unlock_ledger TO realm_runtime;

COMMENT ON TABLE story_node_instances IS
  'Story Graph record-node runtime state; definitions remain in RealmWorld content.';
COMMENT ON TABLE story_unlock_ledger IS
  'Append-only Story Graph unlock evidence ledger; unlocks are derived from formal server facts.';
COMMENT ON COLUMN story_node_instances.definition_hash IS
  'Canonical hash of the content-owned node definition used for identity-safe replay.';
COMMENT ON COLUMN story_node_instances.record_id IS
  'Deterministic Record instance created atomically when the node unlocks.';
