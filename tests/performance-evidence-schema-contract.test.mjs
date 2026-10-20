/** Static source contract only; catalog, RLS and rollback behavior require the deferred real PG run. */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import test from 'node:test';

const file = new URL('../database/postgres/migrations/0082_performance_evidence_snapshots.sql', import.meta.url);
function migration() {
  assert.equal(existsSync(file), true, 'approved A4 schema migration must exist after the occupied 0081');
  return readFileSync(file, 'utf8');
}

test('A4 source migration installs typed immutable snapshot storage without broad old-table privileges', () => {
  const sql = migration();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS performance_evidence_snapshots\s*\(/);
  for (const name of ['workspace_id', 'world_id', 'worldline_id', 'record_id', 'assessment_id', 'command_id', 'version', 'manifest_canonical', 'manifest_hash']) assert.match(sql, new RegExp(`\\b${name}\\b`));
  assert.match(sql, /PRIMARY KEY\s*\(workspace_id,\s*assessment_id\)/);
  for (const parent of ['records', 'performance_assessments', 'committed_fact_commands']) assert.match(sql, new RegExp(`REFERENCES ${parent}\\(workspace_id,\\s*world_id,\\s*worldline_id,`));
  assert.match(sql, /octet_length\(manifest_canonical\) BETWEEN 2 AND 262144/);
  assert.match(sql, /convert_to\('performance-evidence-snapshot:v1','UTF8'\) \|\| decode\('00','hex'\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /WITH CHECK \(workspace_id\s*=\s*realm_current_workspace_id\(\)\)/);
  assert.match(sql, /GRANT SELECT,INSERT ON performance_evidence_snapshots TO realm_runtime/);
  assert.doesNotMatch(sql, /SECURITY DEFINER|BYPASSRLS|ON DELETE CASCADE|GRANT (?:ALL|UPDATE|DELETE|TRUNCATE)\b/i);
});

test('A4 tuple guard rejects missing and JSON-null facts instead of letting SQL NULL pass', () => {
  const sql = migration();
  assert.match(sql, /jsonb_typeof\(m->'evidence'\) IS DISTINCT FROM 'array'/);
  assert.match(sql, /jsonb_typeof\(m#>'\{factors,milestoneCompleted\}'\) IS DISTINCT FROM 'boolean'/);
  assert.match(sql, /jsonb_typeof\(m#>'\{factors,score\}'\) IS DISTINCT FROM 'number'/);
  assert.match(sql, /jsonb_typeof\(m#>'\{factors,evidenceCount\}'\) IS DISTINCT FROM 'number'/);
  assert.match(sql, /NOT \(m \? 'milestoneWitness'\)/);
  assert.match(sql, /IS NOT TRUE THEN\s+RAISE EXCEPTION 'PERFORMANCE_WITNESS_TUPLE'/);
  for (const path of ['request,command', 'request,recordId', 'request,policyVersion', 'request,score', 'request,evidenceEventIds', 'result,assessmentId', 'result,score', 'result,evidenceSnapshotHash', 'performanceWitness,manifestHash']) assert.ok(sql.includes(`'{${path}}'`), path);
  assert.match(sql, /array_agg\(x->>'id' ORDER BY n\)/);
  assert.match(sql, /c\.request_fingerprint/);
  assert.match(sql, /a\.score = cardinality\(a\.evidence_event_ids\)\*10/);
});

test('A4 has append-only row and truncate guards, least privilege functions and bounded capture indexes', () => {
  const sql = migration();
  assert.match(sql, /BEFORE UPDATE OR DELETE ON performance_evidence_snapshots/);
  assert.match(sql, /BEFORE TRUNCATE ON performance_evidence_snapshots FOR EACH STATEMENT/);
  assert.match(sql, /SET search_path=pg_catalog,public/);
  for (const fn of ['guard_performance_evidence_snapshot_insert', 'guard_performance_evidence_snapshots_append_only']) assert.ok(sql.includes(`REVOKE ALL ON FUNCTION ${fn}() FROM PUBLIC`));
  assert.match(sql, /CREATE INDEX IF NOT EXISTS performance_milestone_capture_idx ON project_milestones/);
  assert.match(sql, /WHERE status='completed' AND completion_record_id IS NOT NULL/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS performance_scene_capture_idx ON scenes/);
});
