-- 普通创世确认的请求级幂等台账。
-- world_command_groups 要求世界线与记录已经存在，不能在创世之前充当幂等键。
-- 同一 workspace + principal + creation_request_id：
--   相同草稿指纹重放返回首次的 world/story/record；
--   不同指纹 fail-closed，不覆盖已提交结果。
-- 行与创世写入在同一事务：回滚则台账一并消失（未提交）；
-- 提交后状态为 committed。不提供 DELETE。

CREATE TABLE IF NOT EXISTS genesis_creation_requests (
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  creation_request_id text NOT NULL,
  draft_fingerprint text NOT NULL,
  state text NOT NULL,
  world_id text NOT NULL,
  story_id text NOT NULL,
  record_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, principal_id, creation_request_id),
  CONSTRAINT genesis_creation_requests_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT genesis_creation_requests_state_check
    CHECK (state IN ('accepted', 'committed')),
  CHECK (length(btrim(principal_id)) > 0),
  CHECK (creation_request_id ~ '^[A-Za-z0-9_-]{8,80}$'),
  CHECK (draft_fingerprint ~ '^[a-f0-9]{64}$'),
  CHECK (length(btrim(world_id)) > 0),
  CHECK (length(btrim(story_id)) > 0),
  CHECK (length(btrim(record_id)) > 0)
);

ALTER TABLE genesis_creation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE genesis_creation_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON genesis_creation_requests;
CREATE POLICY realm_workspace_isolation ON genesis_creation_requests
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON genesis_creation_requests TO realm_runtime;
