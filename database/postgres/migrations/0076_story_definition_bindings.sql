-- REALM engine closure F1：server-authoritative Story definition bindings.
--
-- Story Graph node rows (0061) only store the definition HASH. The exact
-- normalized definition a Story was materialized from lived only in caller
-- memory, so an ordinary runtime save could not prove which definition the
-- node rows belong to, and a restored worldline could never reconcile again
-- after a process restart. This table persists the authoritative binding
-- once, in the same transaction as node materialization or archive restore:
--
-- - one row per Story (the composite primary key is the Story itself);
-- - definition_hash is the canonical hash of the normalized definition and
--   must match every node row of the Story;
-- - definition is the exact normalized content-owned declaration (it may
--   reference runtime milestone/obligation/Record identities of its own
--   worldline);
-- - origin_* columns record immutable source identity for restored
--   worldlines (NULL for native materialization), so provenance survives
--   save-again/restore-again cycles without trusting client payloads.
--
-- Bindings are immutable after insert: the runtime role has no UPDATE/DELETE
-- grant and the append-only trigger rejects direct mutation.

CREATE TABLE IF NOT EXISTS story_definition_bindings (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  story_id text NOT NULL,
  definition_hash text NOT NULL,
  definition jsonb NOT NULL,
  origin text NOT NULL DEFAULT 'materialization',
  source_workspace_id text,
  source_story_id text,
  source_definition_hash text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, world_id, worldline_id, story_id),
  CONSTRAINT story_definition_bindings_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT story_definition_bindings_story_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, story_id)
    REFERENCES stories (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT story_definition_bindings_origin_check
    CHECK (origin IN ('materialization', 'restore')),
  CONSTRAINT story_definition_bindings_hash_check
    CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT story_definition_bindings_source_hash_check
    CHECK (source_definition_hash IS NULL OR source_definition_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT story_definition_bindings_definition_shape_check
    CHECK (jsonb_typeof(definition) = 'object'),
  CONSTRAINT story_definition_bindings_origin_shape_check
    CHECK (
      (origin = 'materialization'
        AND source_workspace_id IS NULL
        AND source_story_id IS NULL
        AND source_definition_hash IS NULL)
      OR
      (origin = 'restore'
        AND source_workspace_id IS NOT NULL
        AND source_story_id IS NOT NULL
        AND source_definition_hash IS NOT NULL)
    )
);

CREATE OR REPLACE FUNCTION guard_story_definition_bindings_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Parent Story deletion may cascade through this table. Direct UPDATE/DELETE
  -- remains forbidden for the application-facing runtime role.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'story definition bindings are immutable';
END;
$$;

DROP TRIGGER IF EXISTS story_definition_bindings_append_only_guard ON story_definition_bindings;
CREATE TRIGGER story_definition_bindings_append_only_guard
BEFORE UPDATE OR DELETE ON story_definition_bindings
FOR EACH ROW
EXECUTE FUNCTION guard_story_definition_bindings_append_only();

ALTER TABLE story_definition_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE story_definition_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON story_definition_bindings;
CREATE POLICY realm_workspace_isolation ON story_definition_bindings
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON story_definition_bindings TO realm_runtime;

COMMENT ON TABLE story_definition_bindings IS
  'Server-authoritative Story Graph definition bindings persisted at materialization/restore; immutable.';
COMMENT ON COLUMN story_definition_bindings.definition_hash IS
  'Canonical hash of the normalized definition every node row of the Story is bound to.';
COMMENT ON COLUMN story_definition_bindings.origin IS
  'materialization = native graph creation; restore = runtime-save archive restore (source identity recorded).';
