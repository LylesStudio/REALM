-- REALM enriches the base keen_insight contract with a concrete,
-- target-scoped discovery. Existing custom keys remain untouched.
UPDATE skill_definitions
SET metadata = jsonb_set(
  jsonb_set(
    metadata,
    '{outcomes}',
    COALESCE(metadata->'outcomes', '{}'::jsonb) || CASE
      WHEN (metadata #> '{outcomes,discovery}') IS NULL THEN '{
        "discovery": {
          "subject": "目标边缘的一条细线",
          "feature": "它横切周围连续的纹理，边缘比周围更整齐，而且没有延伸到相邻区域",
          "nextCheck": "从细线的起点检查相邻接缝和遮挡处"
        }
      }'::jsonb
      ELSE '{}'::jsonb
    END,
    true
  ),
  '{targets,scene_surroundings}',
  COALESCE(metadata #> '{targets,scene_surroundings}', '{}'::jsonb) ||
    CASE
      WHEN (metadata #> '{targets,scene_surroundings,discovery}') IS NULL THEN '{
        "discovery": {
          "subject": "甲板木纹上的一条细线",
          "feature": "它横切周围连续的木纹，边缘比周围更整齐，而且没有延伸到相邻区域",
          "nextCheck": "从细线的起点检查相邻接缝和被遮挡的甲板边缘"
        }
      }'::jsonb
      ELSE '{}'::jsonb
    END,
    true
  )
WHERE rule_pack_key = 'realm.base.v1'
  AND skill_key = 'keen_insight'
  AND (metadata #> '{targets,scene_surroundings,discovery}') IS NULL;
