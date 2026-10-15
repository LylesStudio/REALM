-- Member relationship revisions are an append-only command ledger.
-- They are not relationship_states: that table is observer memory and must
-- not be overwritten by a member-relationship command.

CREATE TABLE IF NOT EXISTS member_relationship_revisions (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  subject_entity_key text NOT NULL,
  object_entity_key text NOT NULL,
  relation_kind text NOT NULL,
  revision_ordinal bigint NOT NULL,
  source_event_id text NOT NULL,
  source_record_id text NOT NULL,
  occurred_tick bigint NOT NULL,
  occurred_ordinal bigint NOT NULL,
  command_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (
    workspace_id, world_id, worldline_id,
    subject_entity_key, object_entity_key, relation_kind, revision_ordinal
  ),
  CONSTRAINT member_relationship_revisions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT member_relationship_revisions_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT member_relationship_revisions_event_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, source_record_id, source_event_id)
    REFERENCES events (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT member_relationship_revisions_command_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, command_id)
    REFERENCES committed_fact_commands (workspace_id, world_id, worldline_id, id),
  CHECK (subject_entity_key <> object_entity_key),
  CHECK (relation_kind ~ '^[a-z][a-z0-9_]{0,31}$'),
  CHECK (length(btrim(subject_entity_key)) BETWEEN 1 AND 256),
  CHECK (length(btrim(object_entity_key)) BETWEEN 1 AND 256),
  CHECK (revision_ordinal >= 1),
  CHECK (occurred_tick >= 0),
  CHECK (occurred_ordinal >= 0),
  CHECK (length(btrim(id)) > 0)
);

CREATE OR REPLACE FUNCTION guard_member_relationship_revisions_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'member relationship revisions are append-only';
END;
$$;

DROP TRIGGER IF EXISTS member_relationship_revisions_append_only_guard ON member_relationship_revisions;
CREATE TRIGGER member_relationship_revisions_append_only_guard
BEFORE UPDATE OR DELETE ON member_relationship_revisions
FOR EACH ROW
EXECUTE FUNCTION guard_member_relationship_revisions_append_only();

ALTER TABLE member_relationship_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_relationship_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON member_relationship_revisions;
CREATE POLICY realm_workspace_isolation ON member_relationship_revisions
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON member_relationship_revisions TO realm_runtime;

COMMENT ON TABLE member_relationship_revisions IS
  'Append-only member relationship revisions anchored to a committed event. Not observer memory.';
