-- REALM makes the base discovery location-aware so the generic skill does
-- not leak a deck-specific clue into unrelated worlds.
UPDATE skill_definitions
SET metadata = jsonb_set(
  jsonb_set(
    metadata,
    '{outcomes}',
    COALESCE(metadata->'outcomes', '{}'::jsonb) || '{
      "success": "{actor}在{location}确认一条横切连续纹理的细线；边缘整齐，痕迹没有延伸到相邻区域。",
      "partial": "{actor}在{location}捕捉到一条横切连续纹理的细线，但起点被雾气或遮挡物挡住。",
      "discovery": {
        "subject": "{location}边缘的一条细线",
        "feature": "它横切周围连续的纹理，边缘比周围更整齐，而且没有延伸到相邻区域",
        "nextCheck": "从细线的起点检查相邻接缝和被遮挡的边缘"
      }
    }'::jsonb,
    true
  ),
  '{targets,scene_surroundings}',
  COALESCE(metadata #> '{targets,scene_surroundings}', '{}'::jsonb) || '{
    "success": "{actor}在{location}确认一条横切连续纹理的细线；边缘整齐，痕迹没有延伸到相邻区域。",
    "partial": "{actor}在{location}捕捉到一条横切连续纹理的细线，但起点被雾气或遮挡物挡住。",
    "discovery": {
      "subject": "{location}边缘的一条细线",
      "feature": "它横切周围连续的纹理，边缘比周围更整齐，而且没有延伸到相邻区域",
      "nextCheck": "从细线的起点检查相邻接缝和被遮挡的边缘"
    }
  }'::jsonb,
  true
)
WHERE rule_pack_key = 'realm.base.v1'
  AND skill_key = 'keen_insight';
