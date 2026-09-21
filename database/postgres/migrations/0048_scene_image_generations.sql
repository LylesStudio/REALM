-- REALM Scene Images：ComfyUI 输出落库（world_files bytea）+ 生成台账
-- （docs/development/IMAGE-GENERATION-STORAGE-FRONTEND.md）。
-- 二进制只进 world_files（既有 bytea 语义），不进文件系统/worlds.settings；
-- 台账记录生成状态与 Record 绑定，realm_runtime 无 DELETE（台账不可删）。

-- world_files.kind 扩展到 scene_background（constraint 替换，不触及既有行）。
ALTER TABLE world_files DROP CONSTRAINT IF EXISTS world_files_kind_check;
ALTER TABLE world_files
  ADD CONSTRAINT world_files_kind_check
    CHECK (kind IN ('character_avatar', 'scene_background'));

CREATE TABLE IF NOT EXISTS scene_image_generations (
  workspace_id text NOT NULL,
  id text NOT NULL,
  world_id text NOT NULL,
  record_id text NOT NULL,
  scene_id text NOT NULL,
  file_id text,
  status text NOT NULL DEFAULT 'queued',
  prompt_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT scene_image_generations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT scene_image_generations_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT scene_image_generations_record_fk
    FOREIGN KEY (workspace_id, record_id)
    REFERENCES records (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT scene_image_generations_scene_fk
    FOREIGN KEY (workspace_id, scene_id)
    REFERENCES scenes (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT scene_image_generations_file_fk
    FOREIGN KEY (workspace_id, file_id)
    REFERENCES world_files (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT scene_image_generations_status_check
    CHECK (status IN ('queued', 'running', 'ready', 'failed')),
  CHECK (length(btrim(id)) > 0),
  CHECK (file_id IS NOT NULL OR status <> 'ready'),
  CHECK (file_id IS NULL OR status = 'ready')
);

-- active 复用（queued/running 命中）与 latest ready 查询同一条索引。
CREATE INDEX IF NOT EXISTS scene_image_generations_record_idx
  ON scene_image_generations (workspace_id, record_id, status, created_at DESC);

-- DB 级并发护栏：即使调用方绕过 claim helper，也不能产生两条 active 生成。
CREATE UNIQUE INDEX IF NOT EXISTS scene_image_generations_one_active_idx
  ON scene_image_generations (workspace_id, record_id)
  WHERE status IN ('queued', 'running');

ALTER TABLE scene_image_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scene_image_generations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON scene_image_generations;
CREATE POLICY realm_workspace_isolation ON scene_image_generations
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON scene_image_generations TO realm_runtime;

COMMENT ON TABLE scene_image_generations IS
  'Scene image generation ledger: one active generation per record (active reuse), file binding via world_files, no DELETE for realm_runtime.';
