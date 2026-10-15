-- Generic committed-fact commands.
-- Inventory changes an existing asset quantity by a delta anchored to an
-- event. Relationship text is revised from that event's cursor, never from a
-- client numeric delta. A performance assessment records a score and evidence
-- hash; it does not change goal or milestone state.

CREATE TABLE IF NOT EXISTS committed_fact_commands (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  kind text NOT NULL,
  result_manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, idempotency_key),
  CONSTRAINT committed_fact_commands_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT committed_fact_commands_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT committed_fact_commands_kind_check
    CHECK (kind IN ('inventory_adjusted', 'relationship_revised', 'performance_assessed')),
  CHECK (jsonb_typeof(result_manifest) = 'object'),
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(idempotency_key)) > 0),
  CHECK (length(request_fingerprint) = 64)
);

CREATE TABLE IF NOT EXISTS performance_assessments (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  policy_version text NOT NULL,
  score integer NOT NULL,
  evidence_event_ids text[] NOT NULL,
  evidence_snapshot_hash text NOT NULL,
  command_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT performance_assessments_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT performance_assessments_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT performance_assessments_command_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, command_id)
    REFERENCES committed_fact_commands (workspace_id, world_id, worldline_id, id),
  CHECK (score BETWEEN -1000000 AND 1000000),
  CHECK (cardinality(evidence_event_ids) BETWEEN 1 AND 32),
  CHECK (array_position(evidence_event_ids, NULL) IS NULL),
  CHECK (length(evidence_snapshot_hash) = 64),
  CHECK (length(btrim(policy_version)) > 0),
  CHECK (length(btrim(id)) > 0)
);

CREATE OR REPLACE FUNCTION guard_performance_assessments_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'performance assessments are append-only';
END;
$$;

DROP TRIGGER IF EXISTS performance_assessments_append_only_guard ON performance_assessments;
CREATE TRIGGER performance_assessments_append_only_guard
BEFORE UPDATE OR DELETE ON performance_assessments
FOR EACH ROW
EXECUTE FUNCTION guard_performance_assessments_append_only();

ALTER TABLE committed_fact_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE committed_fact_commands FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON committed_fact_commands;
CREATE POLICY realm_workspace_isolation ON committed_fact_commands
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE performance_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_assessments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON performance_assessments;
CREATE POLICY realm_workspace_isolation ON performance_assessments
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON committed_fact_commands TO realm_runtime;
GRANT SELECT, INSERT ON performance_assessments TO realm_runtime;

COMMENT ON TABLE committed_fact_commands IS
  'Idempotent inventory, relationship, and performance-assessment commands.';
COMMENT ON TABLE performance_assessments IS
  'Performance assessments record a score and evidence hash. They do not change goal or milestone state.';
