-- REALM Account Last Opened FK: targeted SET NULL
-- 批次 S 修复：0017 的复合外键 (workspace_id, last_record_id) 使用
-- ON DELETE SET NULL 时，PostgreSQL 会把外键里的“所有”列都置空，
-- 包括 accounts.workspace_id（NOT NULL），导致删除记录/批量清理时
-- 触发 not-null 违约。PG15+ 支持在 SET NULL 后指定列清单，
-- 这里改为只置空 last_record_id，保留 workspace_id。
-- 语义不变：记录被删自动清空「最近打开」记忆，避免悬空引用。

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_last_record_fk;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_last_record_fk
  FOREIGN KEY (workspace_id, last_record_id)
  REFERENCES records (workspace_id, id) ON DELETE SET NULL (last_record_id);

COMMENT ON COLUMN accounts.last_record_id IS
  'Last opened record (default-entry memory; SET NULL when the record is deleted).';
