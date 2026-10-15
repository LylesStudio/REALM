-- 玩家回合后台执行：record-turn 进入统一 durable job 队列。
-- 取消请求单独成表，绑定 workspace + record + turn，供另一个进程在阶段边界看到。

ALTER TABLE realm_durable_jobs DROP CONSTRAINT IF EXISTS realm_durable_jobs_kind_check;
ALTER TABLE realm_durable_jobs ADD CONSTRAINT realm_durable_jobs_kind_check
  CHECK (job_kind IN ('first-night', 'memory-prefetch', 'self-play-beat', 'record-turn'));

CREATE TABLE IF NOT EXISTS turn_cancel_requests (
  workspace_id text NOT NULL,
  record_id text NOT NULL,
  turn_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, record_id, turn_id),
  CONSTRAINT turn_cancel_requests_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CHECK (length(btrim(record_id)) > 0),
  CHECK (length(btrim(turn_id)) > 0)
);

ALTER TABLE turn_cancel_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE turn_cancel_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON turn_cancel_requests;
CREATE POLICY realm_workspace_isolation ON turn_cancel_requests
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON turn_cancel_requests TO realm_runtime;
