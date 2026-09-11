-- REALM record-scoped scene tension
--
-- Tension is dynamic play state. It belongs to the active scene/Record, not to
-- the shared World row: a retrospection must be able to start with a blank
-- situation without changing the source Record or another Worldline.
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS tension text NOT NULL DEFAULT '';

-- Preserve the pre-0029 projection for existing scene rows. New retrospection
-- scenes explicitly pass an empty tension and therefore do not inherit this
-- value.
UPDATE scenes AS scene
SET tension = COALESCE(world.settings->>'tension', '')
FROM worlds AS world
WHERE world.workspace_id = scene.workspace_id
  AND world.id = scene.world_id
  AND scene.tension = '';

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
  tension,
  start_tick,
  start_ordinal
) ON scenes TO realm_runtime;

COMMENT ON COLUMN scenes.tension IS
  'Record-scoped dynamic tension. Empty means no current situation pressure.';
