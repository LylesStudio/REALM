-- REALM GUI 测试数据清理脚本（已停用）
--
-- 重要：此仓库的 realm_dev 是共享开发库，包含用户手动创建的世界。
-- 旧版脚本曾按固定白名单 DELETE worlds / stories / records，已经证明会
-- 误删白名单之外的真实世界（例如“云海巡礼”）。禁止在共享库执行物理清理。
--
-- GUI 测试必须改用隔离 PostgreSQL 数据库，并在隔离库生命周期结束时清理。
-- 在隔离方案接线前，本文件保持安全 no-op；不要把 DELETE 加回这里。

BEGIN;
DO $$
BEGIN
  RAISE NOTICE 'GUI cleanup disabled: realm_dev is shared and contains user-created worlds; use an isolated test database.';
END
$$;
COMMIT;
