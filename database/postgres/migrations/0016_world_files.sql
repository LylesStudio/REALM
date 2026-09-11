-- REALM World Files
-- 批次 R（docs/development/TAVERN-IMPORT.md）：二进制文件存储层，
-- 承载角色卡头像等世界资产。Postgres bytea：与运行时契约一致、
-- 导入与元数据同事务提交、pg_dump 即备份，不走文件系统。
CREATE TABLE IF NOT EXISTS world_files (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL DEFAULT 'character_avatar',
  content_type text NOT NULL,
  filename text,
  sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, id),
  CONSTRAINT world_files_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT world_files_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT world_files_kind_check
    CHECK (kind IN ('character_avatar')),
  CHECK (length(btrim(content_type)) > 0),
  CHECK (size_bytes > 0)
);

ALTER TABLE world_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_files FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON world_files;
CREATE POLICY realm_workspace_isolation ON world_files
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON world_files TO realm_runtime;

COMMENT ON TABLE world_files IS
  'World-scoped binary assets (character avatars from tavern card imports); realm_runtime may SELECT/INSERT only.';

-- 酒馆导入版本标识：source_format 既有契约值为
-- sillytavern_character_card；V1 卡与 V2/嵌入结构以 profile.spec 区分
-- （tavern-v1 / chara_card_v2 / chara_card_v3），不改既有 CHECK。
