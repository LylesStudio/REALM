-- REALM Record Self-Play Sessions
-- 批次 T7（public documentation）：记录级「世界自演」会话账本。
-- 观察者/成员显式触发一次自演（beat_budget 拍），调度器逐拍推进并心跳；
-- 取消只进 stopping，拍边界收束为 cancelled；进程崩溃残留的活动行由
-- 信封投影懒恢复（心跳超时落 failed）。终态行保留作审计，不删除。
-- 记录删除时级联清除（清理脚本删 records 即带走会话行）。

CREATE TABLE IF NOT EXISTS record_self_play_sessions (
  workspace_id text NOT NULL,
  id text NOT NULL,
  record_id text NOT NULL,
  world_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'stopping', 'completed', 'failed', 'cancelled')),
  beat_budget integer NOT NULL,
  beats_completed integer NOT NULL DEFAULT 0,
  requested_by text NOT NULL,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT record_self_play_sessions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT record_self_play_sessions_record_fk
    FOREIGN KEY (workspace_id, record_id)
    REFERENCES records (workspace_id, id) ON DELETE CASCADE
);

-- 同一记录至多一条活动会话（running/stopping）；终态行不占位。
CREATE UNIQUE INDEX IF NOT EXISTS record_self_play_sessions_active_idx
  ON record_self_play_sessions (workspace_id, record_id)
  WHERE state IN ('running', 'stopping');

ALTER TABLE record_self_play_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_self_play_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON record_self_play_sessions;
CREATE POLICY realm_workspace_isolation ON record_self_play_sessions
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON record_self_play_sessions TO realm_runtime;

COMMENT ON TABLE record_self_play_sessions IS
  'Per-record world self-play session ledger (batch T7): running while the scheduler advances beats, stopping after a cancel request, completed/failed/cancelled as terminal audit rows.';
