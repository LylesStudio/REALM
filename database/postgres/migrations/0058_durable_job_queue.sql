-- Engine backend Slice 3：统一 durable job 队列。
--
-- first-night / memory-prefetch / self-play-beat 三类后台工作从 ad-hoc
-- 进程内调度迁入单张持久队列表。每行携带 workspace/record 作用域、job
-- 种类、有界 payload JSON、租约（lease owner + 过期时间）、尝试计数、
-- 可见时间与状态机（pending → claimed → completed/failed）。worker 崩溃
-- 留下的 claimed 行在租约过期后被后续 claim 回收（stale recovery）；
-- complete/fail 以 (state, attempt_count, lease_owner)  fencing，幂等重放
-- 零影响。负载上界由 CHECK 强制（4 KiB），绝不承载无界文本。

CREATE TABLE IF NOT EXISTS realm_durable_jobs (
  workspace_id text NOT NULL,
  id text NOT NULL,
  job_kind text NOT NULL,
  record_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT realm_durable_jobs_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT realm_durable_jobs_kind_check
    CHECK (job_kind IN ('first-night', 'memory-prefetch', 'self-play-beat')),
  CONSTRAINT realm_durable_jobs_state_check
    CHECK (state IN ('pending', 'claimed', 'completed', 'failed')),
  CONSTRAINT realm_durable_jobs_lease_shape_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(record_id)) > 0),
  CHECK (attempt_count >= 0),
  CHECK (jsonb_typeof(payload) = 'object'),
  CHECK (octet_length(payload::text) <= 4096),
  CHECK (completed_at IS NULL OR state IN ('completed', 'failed'))
);

CREATE INDEX IF NOT EXISTS realm_durable_jobs_queue_idx
  ON realm_durable_jobs (workspace_id, job_kind, state, available_at, created_at);

CREATE INDEX IF NOT EXISTS realm_durable_jobs_record_idx
  ON realm_durable_jobs (workspace_id, record_id, job_kind, state, updated_at);

ALTER TABLE realm_durable_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE realm_durable_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realm_durable_jobs;
CREATE POLICY realm_workspace_isolation ON realm_durable_jobs
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON realm_durable_jobs TO realm_runtime;

COMMENT ON TABLE realm_durable_jobs IS
  'Unified durable job queue (first-night, memory-prefetch, self-play-beat) with lease fencing and stale recovery; payloads are bounded operational metadata, never domain facts.';
