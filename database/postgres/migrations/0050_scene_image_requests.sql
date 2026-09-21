-- REALM Scene Images 自动模式：持久化自动意图队列（scene_image_requests）
-- （docs/development/IMAGE-GENERATION-AUTO-MODE.md §2/§3）。
-- 与 0048 生成台账分离：请求是「意图」（幂等、可排队），生成是「执行」
-- （同一 Record 一条 active，0048 唯一索引护栏）；worker 按 created_at
-- 串行消费同一 Record 的请求，意图不因 active 占用而丢失。
-- source_event_id + trigger_kind 幂等：重复提交/回放/重试不重复排队。
-- realm_runtime 无 DELETE（台账不可删）；lease 走服务端时钟。

CREATE TABLE IF NOT EXISTS scene_image_requests (
  workspace_id text NOT NULL,
  id text NOT NULL,
  world_id text NOT NULL,
  record_id text NOT NULL,
  scene_id text NOT NULL,
  principal_id text NOT NULL,
  trigger_kind text NOT NULL,
  source_event_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  generation_id text,
  attempts integer NOT NULL DEFAULT 0,
  leased_at timestamptz,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT scene_image_requests_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT scene_image_requests_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT scene_image_requests_record_fk
    FOREIGN KEY (workspace_id, record_id)
    REFERENCES records (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT scene_image_requests_generation_fk
    FOREIGN KEY (workspace_id, generation_id)
    REFERENCES scene_image_generations (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT scene_image_requests_trigger_check
    CHECK (trigger_kind IN ('scene_change', 'every_turn')),
  CONSTRAINT scene_image_requests_status_check
    CHECK (status IN ('queued', 'leased', 'completed', 'failed')),
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(source_event_id)) > 0),
  CHECK (attempts >= 0),
  CHECK ((leased_at IS NULL) = (lease_expires_at IS NULL))
);

-- 幂等键：同一触发来源只排一次。
CREATE UNIQUE INDEX IF NOT EXISTS scene_image_requests_idem_idx
  ON scene_image_requests (workspace_id, trigger_kind, source_event_id);

-- worker 消费：workspace 内 queued 按创建顺序；Record 维度串行由
-- worker 的 per-record 处理保证（同 Record 请求聚簇）。
CREATE INDEX IF NOT EXISTS scene_image_requests_queue_idx
  ON scene_image_requests (workspace_id, status, created_at ASC);

-- stale 恢复：lease 过期未完成的 leased 行。
CREATE INDEX IF NOT EXISTS scene_image_requests_lease_idx
  ON scene_image_requests (workspace_id, lease_expires_at)
  WHERE status = 'leased';

ALTER TABLE scene_image_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE scene_image_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON scene_image_requests;
CREATE POLICY realm_workspace_isolation ON scene_image_requests
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON scene_image_requests TO realm_runtime;

COMMENT ON TABLE scene_image_requests IS
  'Persistent scene-image auto-generation intents: idempotent per (trigger_kind, source_event_id); leased by the single worker; completed rows bind a 0048 generation.';
