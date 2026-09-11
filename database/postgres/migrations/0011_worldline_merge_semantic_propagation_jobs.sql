-- REALM M5 Batch 2 Contract
-- PostgreSQL 16+
--
--   1. worldline_merges              — immutable merge audit + manifest;
--   2. semantic_conflict_evaluations — model evaluation evidence, kept out of
--      the formal state plane;
--   3. propagation_jobs              — offline propagation worker queue.

CREATE TABLE IF NOT EXISTS worldline_merges (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  id text NOT NULL,
  idempotency_key text NOT NULL,
  source_worldline_a text NOT NULL,
  source_worldline_b text NOT NULL,
  merged_worldline_id text,
  operator text NOT NULL,
  status text NOT NULL,
  conflict_report jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT worldline_merges_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT worldline_merges_status_check
    CHECK (status IN ('merged', 'rejected')),
  CONSTRAINT worldline_merges_shape_check CHECK (
    (status = 'merged' AND merged_worldline_id IS NOT NULL)
    OR (status = 'rejected' AND merged_worldline_id IS NULL)
  ),
  CHECK (jsonb_typeof(conflict_report) = 'object'),
  CHECK (jsonb_typeof(manifest) = 'array')
);

CREATE OR REPLACE FUNCTION guard_worldline_merge_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'worldline merges are immutable audit rows';
END;
$$;

DROP TRIGGER IF EXISTS worldline_merges_append_only_guard ON worldline_merges;
CREATE TRIGGER worldline_merges_append_only_guard
BEFORE UPDATE OR DELETE ON worldline_merges
FOR EACH ROW
EXECUTE FUNCTION guard_worldline_merge_append_only();

CREATE TABLE IF NOT EXISTS semantic_conflict_evaluations (
  workspace_id text NOT NULL,
  id text NOT NULL,
  source text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  input_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT semantic_conflict_evaluations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT semantic_conflict_evaluations_source_check
    CHECK (source IN ('model', 'fallback')),
  CHECK (jsonb_typeof(result) = 'object')
);

CREATE OR REPLACE FUNCTION guard_semantic_evaluation_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'semantic conflict evaluations are immutable evidence';
END;
$$;

DROP TRIGGER IF EXISTS semantic_conflict_evaluations_append_only_guard
  ON semantic_conflict_evaluations;
CREATE TRIGGER semantic_conflict_evaluations_append_only_guard
BEFORE UPDATE OR DELETE ON semantic_conflict_evaluations
FOR EACH ROW
EXECUTE FUNCTION guard_semantic_evaluation_append_only();

CREATE TABLE IF NOT EXISTS propagation_jobs (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  campaign_id text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at timestamptz,
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT propagation_jobs_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT propagation_jobs_campaign_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, campaign_id)
    REFERENCES information_campaigns (workspace_id, world_id, worldline_id, id),
  CONSTRAINT propagation_jobs_status_check
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  CHECK (attempts >= 0),
  CHECK (jsonb_typeof(input) = 'object')
);

CREATE INDEX IF NOT EXISTS propagation_jobs_queue_idx
  ON propagation_jobs (workspace_id, status, created_at);

ALTER TABLE worldline_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE worldline_merges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON worldline_merges;
CREATE POLICY realm_workspace_isolation ON worldline_merges
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE semantic_conflict_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE semantic_conflict_evaluations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON semantic_conflict_evaluations;
CREATE POLICY realm_workspace_isolation ON semantic_conflict_evaluations
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE propagation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE propagation_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON propagation_jobs;
CREATE POLICY realm_workspace_isolation ON propagation_jobs
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON worldline_merges TO realm_runtime;
GRANT SELECT, INSERT ON semantic_conflict_evaluations TO realm_runtime;
GRANT SELECT, INSERT, UPDATE ON propagation_jobs TO realm_runtime;

COMMENT ON TABLE worldline_merges IS
  'Immutable audit rows for worldline merges: sources, operator, idempotency key, conflict report and merged timeline manifest.';
COMMENT ON TABLE semantic_conflict_evaluations IS
  'Immutable evidence for model semantic conflict evaluation; never part of formal canon state.';
COMMENT ON TABLE propagation_jobs IS
  'Offline propagation worker queue; stale running jobs are recovered to pending on restart.';
