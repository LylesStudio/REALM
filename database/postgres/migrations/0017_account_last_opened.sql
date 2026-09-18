-- REALM Account Last Opened
-- 批次 S（public documentation）：账号级「最近打开」记忆。
-- 默认入口 GET /api/record 读取 accounts.last_record_id；无记忆时前端进入
-- 创世引导。列模式沿用批次 Q（0015）：用户级列 + realm_runtime 最小列级授权。

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_world_id text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_record_id text;

-- 记录被删自动置空，避免悬空引用（清理脚本批量删记录时同样安全）。
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_last_record_fk;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_last_record_fk
  FOREIGN KEY (workspace_id, last_record_id)
  REFERENCES records (workspace_id, id) ON DELETE SET NULL;

GRANT UPDATE (last_world_id, last_record_id) ON accounts TO realm_runtime;

COMMENT ON COLUMN accounts.last_world_id IS
  'Last opened world (default-entry memory; informational).';
COMMENT ON COLUMN accounts.last_record_id IS
  'Last opened record (default-entry memory; SET NULL when the record is deleted).';

-- 一次性回填：为每个账号挑选其 membership 所辖非演示世界中最近创建的记录。
-- 仅演示世界成员资格的账号保持 NULL（首次打开进引导；演示世界仍可从
-- 引导屏/世界库进入）。幂等：只写仍为 NULL 的账号。
UPDATE accounts AS account
SET last_world_id = picked.world_id,
    last_record_id = picked.record_id
FROM (
  SELECT DISTINCT ON (membership.workspace_id, membership.principal_id)
         membership.workspace_id,
         membership.principal_id,
         record.world_id,
         record.id AS record_id
  FROM player_world_memberships AS membership
  JOIN records AS record
    ON record.workspace_id = membership.workspace_id
   AND record.world_id = membership.world_id
  WHERE membership.world_id <> 'world_ember_coast'
  ORDER BY membership.workspace_id, membership.principal_id,
           record.created_at DESC, record.id DESC
) AS picked
WHERE account.workspace_id = picked.workspace_id
  AND account.principal_id = picked.principal_id
  AND account.last_record_id IS NULL;
