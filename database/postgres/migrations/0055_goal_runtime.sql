-- RealmWorld Phase 3：持久 Goal、Assessment evidence 与 durable Judge job。
--
-- Goal definitions remain content-layer data. These tables keep only runtime
-- instances, immutable assessment evidence, and recoverable job state. A Goal
-- transition is represented by the existing formal events plane using the
-- additional event kind `goal.transition.committed`.

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_kind_check;

ALTER TABLE events
  ADD CONSTRAINT events_kind_check CHECK (
    event_kind IN (
      'utterance.committed',
      'narration.committed',
      'action.transaction.committed',
      'system.correction.committed',
      'goal.transition.committed'
    )
  );

CREATE TABLE IF NOT EXISTS goal_instances (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  goal_key text NOT NULL,
  state text NOT NULL DEFAULT 'active',
  revision bigint NOT NULL DEFAULT 0,
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome jsonb,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  UNIQUE (workspace_id, record_id, goal_key),
  CONSTRAINT goal_instances_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT goal_instances_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT goal_instances_state_check
    CHECK (state IN ('active', 'completed', 'failed', 'settled')),
  CHECK (revision >= 0),
  CHECK (length(btrim(goal_key)) > 0),
  CHECK (length(btrim(policy_version)) > 0),
  CHECK (jsonb_typeof(progress) = 'object'),
  CHECK (outcome IS NULL OR jsonb_typeof(outcome) = 'object'),
  CHECK ((state IN ('completed', 'failed', 'settled')) = (completed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS goal_instances_record_idx
  ON goal_instances (workspace_id, record_id, state, updated_at);

CREATE TABLE IF NOT EXISTS goal_assessment_jobs (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  goal_instance_id text NOT NULL,
  source_event_id text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_error_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, goal_instance_id, source_event_id),
  CONSTRAINT goal_assessment_jobs_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT goal_assessment_jobs_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT goal_assessment_jobs_goal_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, goal_instance_id)
    REFERENCES goal_instances (workspace_id, world_id, worldline_id, record_id, id)
    ON DELETE CASCADE,
  CONSTRAINT goal_assessment_jobs_event_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, source_event_id)
    REFERENCES events (workspace_id, world_id, worldline_id, record_id, id)
    ON DELETE CASCADE,
  CONSTRAINT goal_assessment_jobs_state_check
    CHECK (state IN ('pending', 'running', 'retryable', 'completed', 'failed')),
  CONSTRAINT goal_assessment_jobs_lease_shape_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (attempt_count >= 0),
  CHECK (jsonb_typeof(input) = 'object'),
  CHECK (completed_at IS NULL OR state IN ('completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS goal_assessment_jobs_queue_idx
  ON goal_assessment_jobs (workspace_id, state, available_at, created_at);

CREATE TABLE IF NOT EXISTS goal_assessments (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  goal_instance_id text NOT NULL,
  assessment_job_id text,
  source_event_id text NOT NULL,
  source text NOT NULL,
  status text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  evidence_head_version bigint,
  evidence_head_ordinal bigint,
  evidence_snapshot_hash text NOT NULL,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT goal_assessments_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT goal_assessments_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT goal_assessments_goal_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, goal_instance_id)
    REFERENCES goal_instances (workspace_id, world_id, worldline_id, record_id, id)
    ON DELETE CASCADE,
  CONSTRAINT goal_assessments_job_fk
    FOREIGN KEY (workspace_id, assessment_job_id)
    REFERENCES goal_assessment_jobs (workspace_id, id),
  CONSTRAINT goal_assessments_event_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, source_event_id)
    REFERENCES events (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT goal_assessments_source_check
    CHECK (source IN ('deterministic', 'judge', 'fallback')),
  CONSTRAINT goal_assessments_status_check
    CHECK (status IN ('accepted', 'rejected', 'stale', 'failed')),
  CONSTRAINT goal_assessments_head_shape_check CHECK (
    (evidence_head_version IS NULL AND evidence_head_ordinal IS NULL)
    OR
    (evidence_head_version IS NOT NULL AND evidence_head_ordinal IS NOT NULL)
  ),
  CHECK (evidence_head_version IS NULL OR evidence_head_version > 0),
  CHECK (evidence_head_ordinal IS NULL OR evidence_head_ordinal >= 0),
  CHECK (length(btrim(evidence_snapshot_hash)) > 0),
  CHECK (length(btrim(policy_version)) > 0),
  CHECK (jsonb_typeof(result) = 'object')
);

CREATE OR REPLACE FUNCTION guard_goal_assessments_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Parent Record/World deletion may cascade through this table. The
  -- application-facing direct UPDATE/DELETE path remains forbidden, while
  -- referential cleanup is allowed to remove the whole scoped runtime tree.
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'goal assessments are immutable evidence';
END;
$$;

DROP TRIGGER IF EXISTS goal_assessments_append_only_guard ON goal_assessments;
CREATE TRIGGER goal_assessments_append_only_guard
BEFORE UPDATE OR DELETE ON goal_assessments
FOR EACH ROW
EXECUTE FUNCTION guard_goal_assessments_append_only();

ALTER TABLE goal_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_instances FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON goal_instances;
CREATE POLICY realm_workspace_isolation ON goal_instances
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE goal_assessment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_assessment_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON goal_assessment_jobs;
CREATE POLICY realm_workspace_isolation ON goal_assessment_jobs
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE goal_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE goal_assessments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON goal_assessments;
CREATE POLICY realm_workspace_isolation ON goal_assessments
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON goal_instances TO realm_runtime;
GRANT SELECT, INSERT ON goal_assessments TO realm_runtime;
GRANT SELECT, INSERT, UPDATE ON goal_assessment_jobs TO realm_runtime;

COMMENT ON TABLE goal_instances IS
  'Record-scoped runtime Goal state; definitions and rubric text remain in RealmWorld content.';
COMMENT ON TABLE goal_assessment_jobs IS
  'Durable deterministic/Judge assessment queue with lease and stale recovery state.';
COMMENT ON TABLE goal_assessments IS
  'Immutable Goal evidence ledger; model output never becomes a fact without engine validation.';
