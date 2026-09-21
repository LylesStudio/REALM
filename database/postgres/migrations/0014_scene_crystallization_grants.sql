-- REALM Scene Crystallization Grants
-- 设定结晶写回（docs/development/SCENE-CRYSTALLIZATION.md）：
-- realm_runtime 需要向 scenes 追加新场景行（append-oriented，不授予
-- UPDATE/DELETE），并能把裁决通过的天气/局势/世界时间合入 worlds.settings。
-- 事件、record_heads、worldlines 游标与 semantic_conflict_evaluations 审计
-- 的写权限由既有迁移（0002/0004/0011）授予，本迁移不重复。
GRANT INSERT (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  id,
  title,
  status,
  location,
  objective,
  start_tick,
  start_ordinal
) ON scenes TO realm_runtime;

GRANT UPDATE (settings) ON worlds TO realm_runtime;

COMMENT ON TABLE scenes IS
  'Scene states; realm_runtime may INSERT scene transitions (crystallization) but never UPDATE/DELETE existing rows.';
