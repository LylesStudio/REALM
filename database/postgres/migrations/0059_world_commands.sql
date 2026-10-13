-- Engine backend Slice 5：World Command / 跨 Record 领域事务
-- （docs/development/CROSS-RECORD-DOMAIN-TRANSACTION.md）。
--
-- world_command_groups：Command Group 幂等台账——一个 World Command 在单一
-- Workspace/World/Worldline 内的原子提交身份。幂等键作用域为
-- (workspace_id, worldline_id, idempotency_key)；同 key 同 fingerprint
-- replay 返回同一结果清单，同 key 不同 fingerprint 由 repository
-- fail-closed（IDEMPOTENCY_KEY_REUSE），绝不覆盖旧结果。状态机只有
-- committed / rejected 两个稳定终态：失败的事务整体回滚、零残留（不留下
-- 中间态行）；领域拒绝在 scope 校验通过后以 rejected 行持久化，保证同
-- key 重放返回同一拒绝。
--
-- world_command_records：Group 与每个 Touched Record 的关联——子命令身份
-- （command_inbox 复合 FK）、expected/final head 与 ordinal 区间，供审计与
-- 防重复读回。rejected 组无任何 link 行。
--
-- events / action_receipts / observations / outbox 增加受约束的
-- command_group_id correlation（可空，既有行不受影响；非空时经完整
-- 复合外键指向同一 worldline 的 Command Group）——绝不把 group 身份
-- 塞进不受约束的 JSON。

CREATE TABLE IF NOT EXISTS world_command_groups (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  primary_record_id text NOT NULL,
  state text NOT NULL,
  result_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejection_code text,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (workspace_id, worldline_id, idempotency_key),
  CONSTRAINT world_command_groups_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT world_command_groups_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT world_command_groups_primary_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, primary_record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT world_command_groups_state_check
    CHECK (state IN ('committed', 'rejected')),
  CONSTRAINT world_command_groups_state_shape_check CHECK (
    (state = 'committed' AND rejection_code IS NULL AND completed_at IS NOT NULL)
    OR
    (state = 'rejected'
      AND rejection_code IS NOT NULL
      AND length(btrim(rejection_code)) > 0)
  ),
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(idempotency_key)) > 0),
  CHECK (length(idempotency_key) <= 128),
  CHECK (length(btrim(request_fingerprint)) > 0),
  CHECK (length(btrim(policy_version)) > 0),
  CHECK (jsonb_typeof(result_manifest) = 'object'),
  CHECK (octet_length(result_manifest::text) <= 65536)
);

CREATE TABLE IF NOT EXISTS world_command_records (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  command_group_id text NOT NULL,
  record_id text NOT NULL,
  record_role text NOT NULL,
  sub_command_id text NOT NULL,
  expected_record_version bigint NOT NULL,
  final_record_version bigint NOT NULL,
  first_record_ordinal bigint NOT NULL,
  next_record_ordinal bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, command_group_id, record_id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, command_group_id),
  UNIQUE (workspace_id, record_id, sub_command_id),
  CONSTRAINT world_command_records_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT world_command_records_group_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, command_group_id)
    REFERENCES world_command_groups (workspace_id, world_id, worldline_id, id)
    ON DELETE CASCADE,
  CONSTRAINT world_command_records_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT world_command_records_sub_command_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, sub_command_id)
    REFERENCES command_inbox (workspace_id, world_id, worldline_id, record_id, id)
    ON DELETE CASCADE,
  CONSTRAINT world_command_records_role_check
    CHECK (record_role IN ('primary', 'touched')),
  CHECK (expected_record_version >= 0),
  CHECK (final_record_version > expected_record_version),
  CHECK (first_record_ordinal >= 0),
  CHECK (next_record_ordinal > first_record_ordinal)
);

CREATE INDEX IF NOT EXISTS world_command_records_record_idx
  ON world_command_records (workspace_id, record_id, created_at);

-- 受约束的 Group correlation：nullable 列 + 完整复合外键（同 worldline 的
-- Command Group），既有行保持 NULL、语义不变。
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS command_group_id text;
ALTER TABLE action_receipts
  ADD COLUMN IF NOT EXISTS command_group_id text;
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS command_group_id text;
ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS command_group_id text;

DO $world_command_correlation_fks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'events_command_group_fk'
      AND conrelid = 'events'::regclass
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT events_command_group_fk
      FOREIGN KEY (workspace_id, world_id, worldline_id, command_group_id)
      REFERENCES world_command_groups (workspace_id, world_id, worldline_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'action_receipts_command_group_fk'
      AND conrelid = 'action_receipts'::regclass
  ) THEN
    ALTER TABLE action_receipts
      ADD CONSTRAINT action_receipts_command_group_fk
      FOREIGN KEY (workspace_id, world_id, worldline_id, command_group_id)
      REFERENCES world_command_groups (workspace_id, world_id, worldline_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'observations_command_group_fk'
      AND conrelid = 'observations'::regclass
  ) THEN
    ALTER TABLE observations
      ADD CONSTRAINT observations_command_group_fk
      FOREIGN KEY (workspace_id, world_id, worldline_id, command_group_id)
      REFERENCES world_command_groups (workspace_id, world_id, worldline_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_command_group_fk'
      AND conrelid = 'outbox'::regclass
  ) THEN
    ALTER TABLE outbox
      ADD CONSTRAINT outbox_command_group_fk
      FOREIGN KEY (workspace_id, world_id, worldline_id, command_group_id)
      REFERENCES world_command_groups (workspace_id, world_id, worldline_id, id);
  END IF;
END;
$world_command_correlation_fks$;

CREATE INDEX IF NOT EXISTS events_command_group_idx
  ON events (workspace_id, command_group_id)
  WHERE command_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS action_receipts_command_group_idx
  ON action_receipts (workspace_id, command_group_id)
  WHERE command_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS observations_command_group_idx
  ON observations (workspace_id, command_group_id)
  WHERE command_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_command_group_idx
  ON outbox (workspace_id, command_group_id)
  WHERE command_group_id IS NOT NULL;

ALTER TABLE world_command_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_command_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON world_command_groups;
CREATE POLICY realm_workspace_isolation ON world_command_groups
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE world_command_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_command_records FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON world_command_records;
CREATE POLICY realm_workspace_isolation ON world_command_records
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

-- realm_runtime 最小权限：台账可插/可补结果清单（同事务一次），link 行
-- append-only；任何角色都无 DELETE。
GRANT SELECT, INSERT, UPDATE ON world_command_groups TO realm_runtime;
GRANT SELECT, INSERT ON world_command_records TO realm_runtime;

-- 既有列级 INSERT 授权只覆盖 0004/0006 的列清单；新 correlation 列与
-- World Command 子命令落库所需列在此补齐（列级授权可叠加）。
GRANT INSERT (command_group_id) ON events TO realm_runtime;
GRANT INSERT (command_group_id) ON action_receipts TO realm_runtime;
GRANT INSERT (command_group_id) ON observations TO realm_runtime;
GRANT INSERT (command_group_id) ON outbox TO realm_runtime;
GRANT INSERT (started_at, completed_at, result_event_ids)
  ON command_inbox TO realm_runtime;
GRANT INSERT (release_receipt, release_fingerprint, completed_record_version, completed_at)
  ON turn_runs TO realm_runtime;
-- 0030 只授予 UPDATE (state)，而正式写路径（commitRelease / World
-- Command 的 characterStateUpdates）同时写 updated_at——列级授权必须
-- 覆盖全部 SET 目标，否则该路径在真实 PG 上 permission denied。
GRANT UPDATE (updated_at) ON character_instances TO realm_runtime;

COMMENT ON TABLE world_command_groups IS
  'World Command cross-Record commit ledger: idempotency key + request fingerprint + committed/rejected result manifest within one Worldline.';
COMMENT ON TABLE world_command_records IS
  'Command Group to touched Record links: sub-command identity and expected/final heads for audit and replay.';
