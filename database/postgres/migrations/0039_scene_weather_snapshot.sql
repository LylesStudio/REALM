-- REALM Scene Weather Snapshot
-- 批次 T12（public documentation §一）：
-- scenes 增加 weather 快照列——scene 行创建时落当时天气，使场景天气成为
-- Record/世界线级可隔离状态（此前 weather 只从 worlds.settings 现场读取，
-- 结晶推进后起点天气不可恢复）。旧行 weather=''：projection 按
-- 「scene 快照优先、worlds.settings 回退」兼容（设计记录 §1.2）。
-- realm_runtime 对 scenes 的授权是 0014 的显式列级 INSERT（11 列）——
-- 新列必须显式补授，否则结晶/装配写 scene 会 permission denied。

ALTER TABLE scenes ADD COLUMN IF NOT EXISTS weather text NOT NULL DEFAULT '';

GRANT INSERT (weather) ON scenes TO realm_runtime;

COMMENT ON COLUMN scenes.weather IS
  'Weather snapshot at scene creation (batch T12): isolates scene weather per record/worldline; empty means legacy rows (projection falls back to worlds.settings weather).';
