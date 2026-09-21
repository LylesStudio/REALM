-- REALM 账户名 + 可选密码登录（accounts.password_hash）
-- （docs/development/DEPLOY-AUTH.md 新版语义）。
-- 既有账号零改写：默认 NULL = 无密码账户（账户名 + 空密码即可登录）。
-- hash 格式 scrypt（每账户随机 salt）；列级最小授权沿用 0015/0049 先例。
-- 内容绝不回显进日志/响应（应用层白名单字段查询）。

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS password_hash text;

-- 形状约束：scrypt$N$r$p$saltHex$hashHex（只校验编码形状，不校验内容）。
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_password_hash_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_password_hash_check
    CHECK (password_hash IS NULL OR password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[0-9a-f]{32}\$[0-9a-f]{128}$');

GRANT UPDATE (password_hash) ON accounts TO realm_runtime;

COMMENT ON COLUMN accounts.password_hash IS
  'Optional account password (scrypt$N format, per-account random salt); NULL = passwordless account (name-only login). Never echoed to clients.';
