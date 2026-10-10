-- RealmWorld Phase 1A：world identity——worlds.world_version。
--
-- 语义（docs/development/REALMWORLD-ENGINE-UPGRADE-PLAN.md §2.1/§6）：
-- world_version 是世界的内容身份版本。base mode / 本地自建世界携带确定性
-- 哨兵 '0.0.0-local'（pre-contract local world）；world-bound 世界携带所
-- 挂载 RealmWorld 的 worldVersion（装载生命周期属后续阶段，本迁移不引入
-- 内容 registry、不新增内容表、不授新权限）。
--
-- 回填策略：ADD COLUMN ... DEFAULT 同一常量——对全部存量行确定性、显式、
-- 可审计（本文件即审计记录），不使用随机值。既有 INSERT 路径（genesis /
-- seed / library create）经列 DEFAULT 自动携带哨兵，调用方无需改动。

ALTER TABLE worlds
  ADD COLUMN IF NOT EXISTS world_version text NOT NULL DEFAULT '0.0.0-local';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'worlds_world_version_check'
  ) THEN
    ALTER TABLE worlds
      ADD CONSTRAINT worlds_world_version_check
      CHECK (length(btrim(world_version)) > 0);
  END IF;
END;
$$;

COMMENT ON COLUMN worlds.world_version IS
  'Content identity version of the world. ''0.0.0-local'' = pre-contract local world (base mode); world-bound worlds carry the mounted RealmWorld worldVersion. Deterministic backfill for pre-existing rows.';
