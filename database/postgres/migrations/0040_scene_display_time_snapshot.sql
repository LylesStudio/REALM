-- REALM Scene Display-Time Snapshot
-- 批次 T12 验收修正（public documentation）：
-- scenes 增加 display_time 快照列——scene 行创建时落当时世界时间标签，
-- 使场景世界时间成为 Record/世界线级可隔离状态（此前 displayTime 只从
-- worlds.settings / 最新 Event 现场读取，源 Record 推进后重演起点时间
-- 不可恢复）。旧行 display_time=''：projection 按「scene 快照优先」读取；
-- 无快照的 retrospection Record fail-closed 为空（不得回退 worlds.settings
-- 把旧重演拉到当前世界时间），primary 旧数据保留 settings 兼容回退。
-- realm_runtime 对 scenes 的授权是 0014 的显式列级 INSERT——新列必须
-- 显式补授，否则结晶/装配写 scene 会 permission denied。

ALTER TABLE scenes ADD COLUMN IF NOT EXISTS display_time text NOT NULL DEFAULT '';

GRANT INSERT (display_time) ON scenes TO realm_runtime;

COMMENT ON COLUMN scenes.display_time IS
  'Display-time snapshot at scene creation (batch T12 review fix): isolates world-time label per record/worldline; empty means legacy rows (retrospection fail-closed empty, primary falls back to worlds.settings displayTime).';
