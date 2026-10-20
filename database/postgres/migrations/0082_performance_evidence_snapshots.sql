-- Immutable, versioned performance factor/header witnesses. No historical backfill.
-- Runtime/transfer behavior is exercised later by the consolidated disposable-PG suite.
-- PostgreSQL17 CHECK permits NULL: shape/tuple predicates below deliberately fail closed.
-- https://www.postgresql.org/docs/17/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS
-- https://www.postgresql.org/docs/17/ddl-rowsecurity.html
-- https://www.postgresql.org/docs/17/sql-createtrigger.html

CREATE TABLE IF NOT EXISTS performance_evidence_snapshots (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  assessment_id text NOT NULL,
  command_id text NOT NULL,
  version integer NOT NULL,
  manifest_canonical text NOT NULL,
  manifest_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id,assessment_id),
  UNIQUE (workspace_id,world_id,worldline_id,assessment_id),
  UNIQUE (workspace_id,world_id,worldline_id,command_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id),
  FOREIGN KEY (workspace_id,world_id,worldline_id,record_id)
    REFERENCES records(workspace_id,world_id,worldline_id,id),
  FOREIGN KEY (workspace_id,world_id,worldline_id,assessment_id)
    REFERENCES performance_assessments(workspace_id,world_id,worldline_id,id),
  FOREIGN KEY (workspace_id,world_id,worldline_id,command_id)
    REFERENCES committed_fact_commands(workspace_id,world_id,worldline_id,id),
  CHECK (version=1),
  CHECK (octet_length(manifest_canonical) BETWEEN 2 AND 262144),
  CHECK (jsonb_typeof(manifest_canonical::jsonb)='object'),
  CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  CHECK (manifest_hash = encode(public.digest(
    convert_to('performance-evidence-snapshot:v1','UTF8') || decode('00','hex') ||
    convert_to(manifest_canonical,'UTF8'),'sha256'),'hex'))
);

-- SECURITY INVOKER: uses the caller's existing scoped SELECT permissions.
-- This validates the stored accepted tuple, not filesystem signatures or viewer access.
CREATE OR REPLACE FUNCTION guard_performance_evidence_snapshot_insert() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a public.performance_assessments%ROWTYPE;
        c public.committed_fact_commands%ROWTYPE;
        m jsonb := NEW.manifest_canonical::jsonb;
        ids text[];
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM public.realm_current_workspace_id() THEN
    RAISE EXCEPTION 'PERFORMANCE_WITNESS_SCOPE';
  END IF;
  SELECT * INTO a FROM public.performance_assessments
   WHERE workspace_id=NEW.workspace_id AND world_id=NEW.world_id
     AND worldline_id=NEW.worldline_id AND id=NEW.assessment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERFORMANCE_WITNESS_ASSESSMENT'; END IF;
  SELECT * INTO c FROM public.committed_fact_commands
   WHERE workspace_id=NEW.workspace_id AND world_id=NEW.world_id
     AND worldline_id=NEW.worldline_id AND id=NEW.command_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PERFORMANCE_WITNESS_COMMAND'; END IF;

  -- Check types BEFORE casts/array iteration; missing and JSON null both refuse.
  IF jsonb_typeof(m) IS DISTINCT FROM 'object'
    OR jsonb_typeof(m->'scope') IS DISTINCT FROM 'object'
    OR jsonb_typeof(m->'admission') IS DISTINCT FROM 'object'
    OR jsonb_typeof(m->'evidence') IS DISTINCT FROM 'array'
    OR jsonb_typeof(m->'factors') IS DISTINCT FROM 'object'
    OR jsonb_typeof(m->'version') IS DISTINCT FROM 'number'
    OR jsonb_typeof(m#>'{factors,milestoneCompleted}') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(m#>'{factors,score}') IS DISTINCT FROM 'number'
    OR jsonb_typeof(m#>'{factors,evidenceCount}') IS DISTINCT FROM 'number'
    OR NOT (m ? 'milestoneWitness')
    OR jsonb_typeof(m->'milestoneWitness') NOT IN ('object','null')
  THEN RAISE EXCEPTION 'PERFORMANCE_WITNESS_TUPLE'; END IF;
  IF jsonb_array_length(m->'evidence') NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'PERFORMANCE_WITNESS_TUPLE';
  END IF;
  SELECT array_agg(x->>'id' ORDER BY n) INTO ids
    FROM jsonb_array_elements(m->'evidence') WITH ORDINALITY AS q(x,n);

  -- IS NOT TRUE is essential: SQL NULL must never mean accepted missing proof.
  IF (
    a.record_id = NEW.record_id AND a.command_id = NEW.command_id
    AND c.kind = 'performance_assessed'
    AND m->>'version' = '1'
    AND m#>>'{scope,workspaceId}' = NEW.workspace_id
    AND m#>>'{scope,worldId}' = NEW.world_id
    AND m#>>'{scope,worldlineId}' = NEW.worldline_id
    AND m#>>'{scope,recordId}' = NEW.record_id
    AND m->>'assessmentId' = NEW.assessment_id
    AND m->>'commandId' = NEW.command_id
    AND m->>'requestFingerprint' = c.request_fingerprint
    AND m->>'policyVersion' = a.policy_version
    AND m->>'policyVersion' = 'structured-factors:v1'
    AND m#>>'{admission,evidenceMode}' = 'engine-authoritative-v1'
    AND m#>>'{admission,role}' IN ('owner','player')
    AND length(btrim(m#>>'{admission,principalId}')) > 0
    AND length(btrim(m#>>'{admission,evidencePolicyId}')) > 0
    AND (m#>>'{factors,score}')::integer = a.score
    AND (m#>>'{factors,evidenceCount}')::integer = cardinality(a.evidence_event_ids)
    AND ids = a.evidence_event_ids
    AND c.result_manifest#>>'{request,command}' = 'performance.assessed'
    AND c.result_manifest#>>'{request,recordId}' = NEW.record_id
    AND c.result_manifest#>>'{request,policyVersion}' = a.policy_version
    AND (c.result_manifest#>>'{request,score}')::integer = a.score
    AND c.result_manifest#>'{request,evidenceEventIds}' = to_jsonb(a.evidence_event_ids)
    AND c.result_manifest#>>'{result,assessmentId}' = a.id
    AND (c.result_manifest#>>'{result,score}')::integer = a.score
    AND c.result_manifest#>>'{result,evidenceSnapshotHash}' = a.evidence_snapshot_hash
    AND c.result_manifest#>>'{performanceWitness,version}' = '1'
    AND c.result_manifest#>>'{performanceWitness,manifestHash}' = NEW.manifest_hash
    AND a.score = cardinality(a.evidence_event_ids)*10 +
         CASE WHEN (m#>>'{factors,milestoneCompleted}')::boolean THEN 20 ELSE 0 END
    AND ((m->'milestoneWitness' <> 'null'::jsonb) =
          (m#>>'{factors,milestoneCompleted}')::boolean)
    AND (m->'milestoneWitness' = 'null'::jsonb OR (
      m#>>'{milestoneWitness,completionRecordId}' = NEW.record_id
      AND length(btrim(m#>>'{milestoneWitness,id}')) > 0
      AND length(btrim(m#>>'{milestoneWitness,projectId}')) > 0
      AND length(btrim(m#>>'{milestoneWitness,completionEventId}')) > 0
      AND m#>>'{milestoneWitness,completionHeader,id}' = m#>>'{milestoneWitness,completionEventId}'
    ))
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'PERFORMANCE_WITNESS_TUPLE';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS performance_evidence_snapshot_insert_guard ON performance_evidence_snapshots;
CREATE TRIGGER performance_evidence_snapshot_insert_guard
  BEFORE INSERT ON performance_evidence_snapshots FOR EACH ROW
  EXECUTE FUNCTION guard_performance_evidence_snapshot_insert();

CREATE OR REPLACE FUNCTION guard_performance_evidence_snapshots_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN RAISE EXCEPTION 'performance evidence snapshots are append-only'; END; $$;
DROP TRIGGER IF EXISTS performance_evidence_snapshots_append_only_guard ON performance_evidence_snapshots;
CREATE TRIGGER performance_evidence_snapshots_append_only_guard
  BEFORE UPDATE OR DELETE ON performance_evidence_snapshots FOR EACH ROW
  EXECUTE FUNCTION guard_performance_evidence_snapshots_append_only();
DROP TRIGGER IF EXISTS performance_evidence_snapshots_no_truncate ON performance_evidence_snapshots;
CREATE TRIGGER performance_evidence_snapshots_no_truncate
  BEFORE TRUNCATE ON performance_evidence_snapshots FOR EACH STATEMENT
  EXECUTE FUNCTION guard_performance_evidence_snapshots_append_only();
ALTER TABLE performance_evidence_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_evidence_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON performance_evidence_snapshots;
CREATE POLICY realm_workspace_isolation ON performance_evidence_snapshots
  USING (workspace_id=realm_current_workspace_id())
  WITH CHECK (workspace_id=realm_current_workspace_id());
REVOKE ALL ON performance_evidence_snapshots FROM PUBLIC,realm_runtime,realm_transfer,realm_control;
GRANT SELECT,INSERT ON performance_evidence_snapshots TO realm_runtime;
REVOKE ALL ON FUNCTION guard_performance_evidence_snapshot_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_performance_evidence_snapshots_append_only() FROM PUBLIC;
CREATE INDEX IF NOT EXISTS performance_milestone_capture_idx ON project_milestones
  (workspace_id,world_id,worldline_id,completion_record_id,id COLLATE "C")
  WHERE status='completed' AND completion_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS performance_scene_capture_idx ON scenes
  (workspace_id,world_id,worldline_id,record_id,start_tick DESC,start_ordinal DESC,id ASC);
COMMENT ON TABLE performance_evidence_snapshots IS
  'Immutable v1 performance header/factor witness. Not a viewer projection; dedicated versioned runtime-save transport is required.';
