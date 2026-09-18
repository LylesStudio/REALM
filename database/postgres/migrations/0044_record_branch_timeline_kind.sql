-- Playable record branches: extend records.timeline_kind with 'branch'.
--
-- 语义（BRANCH-TREE-RESEARCH §二）：branch record 是从源 Record 的某个
-- 已提交因果游标分叉出的新世界线上的可游玩记录；它不复用
-- 'retrospection'——回溯记录的「写入正史」流程（retrospection/commit）
-- 只对 timeline_kind='retrospection' 放行，分支记录不得进入该流程，
-- 也不得在 Library/StoryView 被误标为回溯。旧数据不受影响（枚举仅追加）。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'records_timeline_kind_check'
  ) THEN
    ALTER TABLE records DROP CONSTRAINT records_timeline_kind_check;
  END IF;
END;
$$;

ALTER TABLE records
  ADD CONSTRAINT records_timeline_kind_check
  CHECK (timeline_kind IN ('primary', 'retrospection', 'merged', 'branch'));
