-- REALM Scene Images 自动模式：账号级偏好（accounts.scene_image_mode）
-- （docs/development/IMAGE-GENERATION-AUTO-MODE.md §1）。
-- 每个 principal 自己决定是否为自己的游玩消耗 GPU；默认 off（打开页面
-- 不自动消耗）；observer 无玩家回合（不触发）但可读/可改自己的偏好。
-- 列级最小授权与 ui_language（0015）同一先例。

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS scene_image_mode text NOT NULL DEFAULT 'off';

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_scene_image_mode_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_scene_image_mode_check
    CHECK (scene_image_mode IN ('off', 'scene_change', 'every_turn'));

-- 列级 UPDATE（与 accounts 既有 SELECT/INSERT + ui_language UPDATE 并存）。
GRANT UPDATE (scene_image_mode) ON accounts TO realm_runtime;

COMMENT ON COLUMN accounts.scene_image_mode IS
  'Per-account scene image auto-generation mode: off (default, zero GPU) / scene_change (after crystallization writes a real new scene) / every_turn (after each successful committed player turn).';
