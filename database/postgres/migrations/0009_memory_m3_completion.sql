-- REALM M3 Memory Completion Contract
-- PostgreSQL 16+ / pgvector
--
-- Three additions on top of the append-only memory evidence store:
--   1. relationship_states   — observer-scoped, revisable subjective
--      relationship projection (never an objective world relation);
--   2. memory_snapshots      — immutable recall/representation snapshots;
--   3. memory_cache_epochs   — monotonically increasing cache epochs that
--      advance only when history interpretation is rewritten
--      (update/retract conclusions), so additive appends stay delta-served.

CREATE TABLE IF NOT EXISTS relationship_states (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  observer_continuity_id text NOT NULL,
  target_entity_key text NOT NULL,
  relation_kind text NOT NULL,
  content text NOT NULL,
  fidelity numeric(5, 4) NOT NULL DEFAULT 1.0,
  source_record_id text,
  source_observation_id text,
  occurred_tick bigint NOT NULL,
  occurred_ordinal bigint NOT NULL,
  available_from_tick bigint NOT NULL,
  available_from_ordinal bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    workspace_id,
    observer_continuity_id,
    target_entity_key,
    relation_kind
  ),
  UNIQUE (workspace_id, world_id, worldline_id, observer_continuity_id, target_entity_key, relation_kind),
  CONSTRAINT relationship_states_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT relationship_states_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT relationship_states_observer_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, observer_continuity_id)
    REFERENCES character_continuities (workspace_id, world_id, worldline_id, id),
  CONSTRAINT relationship_states_kind_check
    CHECK (relation_kind IN (
      'trust', 'hostile', 'alliance', 'kinship', 'debt', 'acquaintance', 'note'
    )),
  CONSTRAINT relationship_states_cursor_check CHECK (
    occurred_tick >= 0
    AND occurred_ordinal >= 0
    AND available_from_tick >= 0
    AND available_from_ordinal >= 0
    AND (available_from_tick, available_from_ordinal)
      >= (occurred_tick, occurred_ordinal)
  ),
  CHECK (fidelity >= 0.0 AND fidelity <= 1.0),
  CHECK (length(btrim(target_entity_key)) > 0),
  CHECK (length(btrim(content)) > 0),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS relationship_states_scope_idx
  ON relationship_states (
    workspace_id,
    worldline_id,
    observer_continuity_id,
    available_from_tick,
    available_from_ordinal
  );

ALTER TABLE relationship_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON relationship_states;
CREATE POLICY realm_workspace_isolation ON relationship_states
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON relationship_states TO realm_runtime;

COMMENT ON TABLE relationship_states IS
  'Observer-scoped subjective relationship projection; revisable, never an objective world relation. Every revision appends a relationship memory_conclusion as evidence.';

CREATE TABLE IF NOT EXISTS memory_snapshots (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  observer_continuity_id text NOT NULL,
  id text NOT NULL,
  snapshot_kind text NOT NULL,
  content text NOT NULL,
  item_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  cursor_tick bigint NOT NULL,
  cursor_ordinal bigint NOT NULL,
  cache_epoch integer NOT NULL,
  token_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT memory_snapshots_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT memory_snapshots_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT memory_snapshots_observer_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, observer_continuity_id)
    REFERENCES character_continuities (workspace_id, world_id, worldline_id, id),
  CONSTRAINT memory_snapshots_kind_check
    CHECK (snapshot_kind IN ('representation', 'recall')),
  CONSTRAINT memory_snapshots_cursor_check CHECK (
    cursor_tick >= 0 AND cursor_ordinal >= 0
  ),
  CHECK (cache_epoch >= 0),
  CHECK (token_count >= 0),
  CHECK (array_position(item_ids, NULL) IS NULL)
);

CREATE INDEX IF NOT EXISTS memory_snapshots_scope_idx
  ON memory_snapshots (
    workspace_id,
    worldline_id,
    observer_continuity_id,
    created_at
  );

CREATE OR REPLACE FUNCTION guard_memory_snapshot_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'memory snapshots are immutable; take a new snapshot instead';
END;
$$;

DROP TRIGGER IF EXISTS memory_snapshots_append_only_guard
  ON memory_snapshots;
CREATE TRIGGER memory_snapshots_append_only_guard
BEFORE UPDATE OR DELETE ON memory_snapshots
FOR EACH ROW
EXECUTE FUNCTION guard_memory_snapshot_append_only();

ALTER TABLE memory_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON memory_snapshots;
CREATE POLICY realm_workspace_isolation ON memory_snapshots
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON memory_snapshots TO realm_runtime;

COMMENT ON TABLE memory_snapshots IS
  'Immutable memory recall/representation snapshots bound to an effective cursor and cache epoch.';

CREATE TABLE IF NOT EXISTS memory_cache_epochs (
  workspace_id text NOT NULL,
  observer_continuity_id text NOT NULL,
  epoch integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, observer_continuity_id),
  CONSTRAINT memory_cache_epochs_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CHECK (epoch >= 0)
);

ALTER TABLE memory_cache_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_cache_epochs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON memory_cache_epochs;
CREATE POLICY realm_workspace_isolation ON memory_cache_epochs
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON memory_cache_epochs TO realm_runtime;

COMMENT ON TABLE memory_cache_epochs IS
  'Per-continuity memory cache epoch; advances only when update/retract conclusions rewrite history interpretation.';
