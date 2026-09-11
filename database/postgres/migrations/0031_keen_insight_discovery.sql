-- REALM backfill for the base keen_insight discovery contract
-- Only definitions that still lack custom outcomes are enriched. Existing
-- world-authored outcomes remain untouched; no events or character state is
-- rewritten.
UPDATE skill_definitions
SET metadata = metadata || '{
  "check": {
    "system": "d20",
    "modifier": 1,
    "target": 10,
    "partialMargin": 2
  },
  "defaultTargetId": "scene_surroundings",
  "outcomes": {
    "success": "{actor}从目标中找到了一个可复核的异常细节。",
    "partial": "{actor}捕捉到一处可疑痕迹，但还无法确认来源。",
    "failure": "{actor}没有找到足够可靠的新线索。",
    "impossible": "当前条件不足以完成「{title}」。",
    "privateObservation": "你确认目标上有一处可复核的异常，但还不能判断它的来源。"
  },
  "targets": {
    "scene_surroundings": {
      "success": "{actor}在当前场景中确认了一处与表面叙述不一致的细节。",
      "partial": "{actor}在当前场景中捕捉到一处可疑细节，但还不能确认原因。",
      "failure": "当前场景的线索被遮蔽，无法确认可靠异常。",
      "impossible": "当前条件不足以辨认场景细节。",
      "privateObservation": "你确认当前场景有一处细节与表面叙述不一致，但还不能判断来源。"
    }
  }
}'::jsonb
WHERE rule_pack_key = 'realm.base.v1'
  AND skill_key = 'keen_insight'
  AND NOT (metadata ? 'outcomes');
