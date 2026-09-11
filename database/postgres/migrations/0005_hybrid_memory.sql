-- REALM Hybrid Memory Contract v1
-- PostgreSQL 16+ / pgvector
--
-- Memory Conclusions are append-only, Character-continuity scoped and always
-- filtered by Worldline plus effective world cursor before relevance ranking.

CREATE TABLE IF NOT EXISTS memory_conclusions (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  observer_continuity_id text NOT NULL,
  observed_entity_key text NOT NULL,
  source_record_id text,
  source_observation_id text,
  supersedes_memory_id text,
  id text NOT NULL,
  operation text NOT NULL DEFAULT 'add',
  memory_kind text NOT NULL,
  content text NOT NULL,
  keywords text[] NOT NULL DEFAULT ARRAY[]::text[],
  semantic_embedding vector(384) NOT NULL,
  embedding_model text NOT NULL,
  fidelity numeric(5, 4) NOT NULL DEFAULT 1.0,
  occurred_tick bigint NOT NULL,
  occurred_ordinal bigint NOT NULL,
  available_from_tick bigint NOT NULL,
  available_from_ordinal bigint NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (
    workspace_id,
    observer_continuity_id,
    source_record_id,
    source_observation_id
  ),
  CONSTRAINT memory_conclusions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT memory_conclusions_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT memory_conclusions_observer_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, observer_continuity_id)
    REFERENCES character_continuities (workspace_id, world_id, worldline_id, id),
  CONSTRAINT memory_conclusions_source_observation_fk
    FOREIGN KEY (
      workspace_id,
      world_id,
      worldline_id,
      source_record_id,
      source_observation_id
    ) REFERENCES observations (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      id
    ),
  CONSTRAINT memory_conclusions_supersedes_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, supersedes_memory_id)
    REFERENCES memory_conclusions (workspace_id, world_id, worldline_id, id),
  CONSTRAINT memory_conclusions_operation_check
    CHECK (operation IN ('add', 'update', 'retract')),
  CONSTRAINT memory_conclusions_kind_check
    CHECK (memory_kind IN ('explicit', 'inferred', 'summary', 'preference', 'relationship')),
  CONSTRAINT memory_conclusions_source_shape_check CHECK (
    (source_record_id IS NULL AND source_observation_id IS NULL)
    OR (source_record_id IS NOT NULL AND source_observation_id IS NOT NULL)
  ),
  CONSTRAINT memory_conclusions_revision_shape_check CHECK (
    (operation = 'add' AND supersedes_memory_id IS NULL)
    OR (operation IN ('update', 'retract') AND supersedes_memory_id IS NOT NULL)
  ),
  CONSTRAINT memory_conclusions_cursor_check CHECK (
    occurred_tick >= 0
    AND occurred_ordinal >= 0
    AND available_from_tick >= 0
    AND available_from_ordinal >= 0
    AND (available_from_tick, available_from_ordinal)
      >= (occurred_tick, occurred_ordinal)
  ),
  CHECK (fidelity >= 0.0 AND fidelity <= 1.0),
  CHECK (length(btrim(observed_entity_key)) > 0),
  CHECK (length(btrim(content)) > 0),
  CHECK (length(btrim(embedding_model)) > 0),
  CHECK (array_position(keywords, NULL) IS NULL),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS memory_conclusions_scope_cursor_idx
  ON memory_conclusions (
    workspace_id,
    worldline_id,
    observer_continuity_id,
    available_from_tick,
    available_from_ordinal
  );
CREATE INDEX IF NOT EXISTS memory_conclusions_keywords_gin_idx
  ON memory_conclusions USING gin (keywords);
CREATE INDEX IF NOT EXISTS memory_conclusions_embedding_hnsw_idx
  ON memory_conclusions USING hnsw (semantic_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS memory_conclusions_observed_entity_idx
  ON memory_conclusions (
    workspace_id,
    worldline_id,
    observer_continuity_id,
    observed_entity_key
  );

CREATE OR REPLACE FUNCTION guard_memory_conclusion_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'memory conclusions are append-only; append an update or retraction conclusion';
END;
$$;

DROP TRIGGER IF EXISTS memory_conclusions_append_only_guard
  ON memory_conclusions;
CREATE TRIGGER memory_conclusions_append_only_guard
BEFORE UPDATE OR DELETE ON memory_conclusions
FOR EACH ROW
EXECUTE FUNCTION guard_memory_conclusion_append_only();

ALTER TABLE memory_conclusions ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_conclusions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON memory_conclusions;
CREATE POLICY realm_workspace_isolation ON memory_conclusions
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

-- This is the first explicit knowledge-reader grant. Repository queries must
-- still bind one observer continuity and an effective world cursor; RLS alone
-- is intentionally not treated as a character-knowledge authorization layer.
GRANT SELECT ON observations TO realm_runtime;
GRANT SELECT, INSERT ON memory_conclusions TO realm_runtime;

COMMENT ON TABLE memory_conclusions IS
  'Append-only, observer-to-observed conclusions used by time-safe hybrid recall and CharacterInstance inheritance.';
COMMENT ON COLUMN memory_conclusions.semantic_embedding IS
  '384-dimensional local lexical embedding in v1; the EmbeddingProvider port permits a future semantic model without changing recall authority.';
