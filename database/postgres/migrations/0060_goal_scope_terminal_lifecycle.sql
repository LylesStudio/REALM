-- REALM B1 地基：Goal scope 三态（record | story | worldline）与
-- failed/settled 终态生命周期。
--
-- - goal_instances 从 Record-only 扩展为判别联合 scope：nullable 锚
--   （record_id / story_id）+ scope_kind CHECK 保证恰好一个锚；
-- - attempt / supersedes_instance_id 支撑终态后的确定性重试（终态绝不
--   原地复活，重试开新 attempt、新 instance id）；同 scope+goal_key
--   同时只能有一个 active attempt（partial unique index）；
-- - 终态实例不可变：terminal 行的 state/revision/progress/outcome/
--   completed_at/attempt/supersedes 任何 UPDATE 都被触发器拒绝；
-- - 四态 CHECK、RLS/FORCE RLS 与 append-only assessment 语义保持不变；
--   迁移本身不改写任何既有行（既有行即 scope_kind='record'、attempt=1，
--   旧 Record 实例身份与读取路径逐字节兼容）。

ALTER TABLE goal_instances
  ALTER COLUMN record_id DROP NOT NULL;

ALTER TABLE goal_instances
  ADD COLUMN IF NOT EXISTS scope_kind text NOT NULL DEFAULT 'record',
  ADD COLUMN IF NOT EXISTS story_id text,
  ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS supersedes_instance_id text;

ALTER TABLE goal_instances
  DROP CONSTRAINT IF EXISTS goal_instances_scope_kind_check,
  DROP CONSTRAINT IF EXISTS goal_instances_scope_anchor_check,
  DROP CONSTRAINT IF EXISTS goal_instances_attempt_check,
  DROP CONSTRAINT IF EXISTS goal_instances_supersedes_fk;

ALTER TABLE goal_instances
  ADD CONSTRAINT goal_instances_scope_kind_check
    CHECK (scope_kind IN ('record', 'story', 'worldline')),
  ADD CONSTRAINT goal_instances_scope_anchor_check CHECK (
    (scope_kind = 'record' AND record_id IS NOT NULL AND story_id IS NULL)
    OR (
      scope_kind = 'story'
      AND record_id IS NULL
      AND story_id IS NOT NULL
      AND length(btrim(story_id)) > 0
    )
    OR (scope_kind = 'worldline' AND record_id IS NULL AND story_id IS NULL)
  ),
  ADD CONSTRAINT goal_instances_attempt_check CHECK (attempt >= 1),
  ADD CONSTRAINT goal_instances_supersedes_fk
    FOREIGN KEY (workspace_id, supersedes_instance_id)
    REFERENCES goal_instances (workspace_id, id) ON DELETE CASCADE;

-- 0055 的 Record-only 唯一键不含 scope/attempt，无法表达重试；由 scope
-- 感知的唯一索引取代（表达式索引以 '' 归一化 NULL 锚，保证 story 与
-- worldline scope 的唯一性同样强制）。
ALTER TABLE goal_instances
  DROP CONSTRAINT IF EXISTS goal_instances_workspace_id_record_id_goal_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS goal_instances_scope_goal_attempt_key
  ON goal_instances (
    workspace_id, world_id, worldline_id,
    COALESCE(record_id, ''), COALESCE(story_id, ''),
    goal_key, attempt
  );

-- 同 scope+goal_key 同时只能有一个 active attempt；终态行不占位，重试的
-- 新 attempt 得以插入。
CREATE UNIQUE INDEX IF NOT EXISTS goal_instances_scope_single_active_key
  ON goal_instances (
    workspace_id, world_id, worldline_id,
    COALESCE(record_id, ''), COALESCE(story_id, ''),
    goal_key
  )
  WHERE state = 'active';

-- 终态不可变：terminal 行的状态/证据/身份字段一律不得再 UPDATE。
-- （cascade DELETE 不经过 UPDATE 触发器，workspace/record 级联清理不受
-- 影响。）
CREATE OR REPLACE FUNCTION guard_goal_instances_terminal_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state IN ('completed', 'failed', 'settled') AND (
    NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.world_id IS DISTINCT FROM OLD.world_id
    OR NEW.worldline_id IS DISTINCT FROM OLD.worldline_id
    OR NEW.record_id IS DISTINCT FROM OLD.record_id
    OR NEW.story_id IS DISTINCT FROM OLD.story_id
    OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.goal_key IS DISTINCT FROM OLD.goal_key
    OR NEW.state IS DISTINCT FROM OLD.state
    OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.progress IS DISTINCT FROM OLD.progress
    OR NEW.outcome IS DISTINCT FROM OLD.outcome
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at IS DISTINCT FROM OLD.updated_at
    OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    OR NEW.attempt IS DISTINCT FROM OLD.attempt
    OR NEW.supersedes_instance_id IS DISTINCT FROM OLD.supersedes_instance_id
  ) THEN
    RAISE EXCEPTION 'terminal goal instances are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS goal_instances_terminal_immutable_guard ON goal_instances;
CREATE TRIGGER goal_instances_terminal_immutable_guard
BEFORE UPDATE ON goal_instances
FOR EACH ROW
EXECUTE FUNCTION guard_goal_instances_terminal_immutable();

COMMENT ON COLUMN goal_instances.scope_kind IS
  'Goal runtime scope discriminant: record | story | worldline (B1).';
COMMENT ON COLUMN goal_instances.story_id IS
  'story scope anchor; exactly one of record_id/story_id is set per scope_kind.';
COMMENT ON COLUMN goal_instances.attempt IS
  'Retry attempt counter; terminal instances never reopen in place.';
COMMENT ON COLUMN goal_instances.supersedes_instance_id IS
  'Previous terminal instance this attempt supersedes (null for attempt 1).';
