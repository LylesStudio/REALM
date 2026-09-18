-- REALM Account UI Language
-- 批次 Q（public documentation）：用户级界面语言，
-- 默认 zh-CN，三语枚举约束；realm_runtime 只允许更新该列。
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ui_language text NOT NULL DEFAULT 'zh-CN';

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_ui_language_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_ui_language_check
  CHECK (ui_language IN ('zh-CN', 'en', 'ja'));

GRANT UPDATE (ui_language) ON accounts TO realm_runtime;

COMMENT ON COLUMN accounts.ui_language IS
  'User-level interface language (zh-CN/en/ja); defaults to zh-CN.';
