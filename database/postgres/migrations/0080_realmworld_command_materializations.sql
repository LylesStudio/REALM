-- A2 portable authored identity map. Existing table privileges remain unchanged.
ALTER TABLE project_milestones ADD CONSTRAINT project_milestones_command_identity_unique
  UNIQUE (workspace_id, world_id, worldline_id, project_id, id);
ALTER TABLE records ADD CONSTRAINT records_command_identity_unique
  UNIQUE (workspace_id, world_id, worldline_id, story_id, id);
ALTER TABLE project_story_links ADD CONSTRAINT project_story_links_command_identity_unique
  UNIQUE (workspace_id, project_id, story_id, link_kind);

CREATE TABLE IF NOT EXISTS realmworld_command_materializations (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  world_version text NOT NULL CHECK (length(world_version) BETWEEN 1 AND 256),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  policy_version text NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 128 AND policy_version ~ '^[A-Za-z0-9._:-]+$' AND policy_version NOT IN ('.','..')),
  project_key text NOT NULL CHECK (length(project_key) BETWEEN 1 AND 128 AND project_key ~ '^[A-Za-z0-9._:-]+$' AND project_key NOT IN ('.','..')),
  milestone_key text NOT NULL CHECK (length(milestone_key) BETWEEN 1 AND 128 AND milestone_key ~ '^[A-Za-z0-9._:-]+$' AND milestone_key NOT IN ('.','..')),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 256 AND project_id ~ '^[A-Za-z0-9._:-]+$' AND project_id NOT IN ('.','..')),
  milestone_id text NOT NULL CHECK (length(milestone_id) BETWEEN 1 AND 256 AND milestone_id ~ '^[A-Za-z0-9._:-]+$' AND milestone_id NOT IN ('.','..')),
  story_id text NOT NULL CHECK (length(story_id) BETWEEN 1 AND 256 AND story_id ~ '^[A-Za-z0-9._:-]+$' AND story_id NOT IN ('.','..')),
  record_id text NOT NULL CHECK (length(record_id) BETWEEN 1 AND 256 AND record_id ~ '^[A-Za-z0-9._:-]+$' AND record_id NOT IN ('.','..')),
  link_kind text NOT NULL CHECK (link_kind = 'primary'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, world_id, worldline_id, project_key, milestone_key),
  UNIQUE (workspace_id, world_id, worldline_id, milestone_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, world_id, worldline_id) REFERENCES worldlines(workspace_id, world_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, world_id, worldline_id, project_id, milestone_id)
    REFERENCES project_milestones(workspace_id, world_id, worldline_id, project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, world_id, worldline_id, story_id, record_id)
    REFERENCES records(workspace_id, world_id, worldline_id, story_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, project_id, story_id, link_kind)
    REFERENCES project_story_links(workspace_id, project_id, story_id, link_kind)
);
CREATE FUNCTION guard_realmworld_command_materializations_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'command materializations are immutable';
END;
$$;
CREATE TRIGGER realmworld_command_materializations_append_only_guard
BEFORE UPDATE OR DELETE ON realmworld_command_materializations FOR EACH ROW
EXECUTE FUNCTION guard_realmworld_command_materializations_append_only();
ALTER TABLE realmworld_command_materializations ENABLE ROW LEVEL SECURITY;
ALTER TABLE realmworld_command_materializations FORCE ROW LEVEL SECURITY;
CREATE POLICY realm_workspace_isolation ON realmworld_command_materializations
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());
GRANT SELECT, INSERT ON realmworld_command_materializations TO realm_runtime;
