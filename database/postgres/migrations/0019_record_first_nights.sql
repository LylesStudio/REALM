-- REALM Record First Nights
-- 批次 T1（docs/development/T1-FIRST-NIGHT.md）：记录级「世界初夜」状态行。
-- 落笔入界事务内写入 pending 与创世提案上下文；异步初夜生成完成后转
-- ready（钩子正文与开场提案镜像入库），模型失败落确定性降级包转 degraded。
-- 旧记录没有状态行 → 交付投影 firstNight=null，行为完全向后兼容。
-- 记录删除时级联清除（清理脚本删 records 即带走状态行）。

CREATE TABLE IF NOT EXISTS record_first_nights (
  workspace_id text NOT NULL,
  record_id text NOT NULL,
  world_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'ready', 'degraded')),
  attempts integer NOT NULL DEFAULT 0,
  hook_content text NOT NULL DEFAULT '',
  suggestions text[] NOT NULL DEFAULT '{}',
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, record_id),
  CONSTRAINT record_first_nights_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT record_first_nights_record_fk
    FOREIGN KEY (workspace_id, record_id)
    REFERENCES records (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE record_first_nights ENABLE ROW LEVEL SECURITY;
ALTER TABLE record_first_nights FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON record_first_nights;
CREATE POLICY realm_workspace_isolation ON record_first_nights
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON record_first_nights TO realm_runtime;

COMMENT ON TABLE record_first_nights IS
  'Per-record first-night enrichment state (batch T1): pending while the async generation runs, ready when scene/character/hook events are committed, degraded on deterministic fallback.';
COMMENT ON COLUMN record_first_nights.context IS
  'Compact genesis draft snapshot (world/story/scene/companions/style/opening) used by the async first-night generation; written once at seal time.';
