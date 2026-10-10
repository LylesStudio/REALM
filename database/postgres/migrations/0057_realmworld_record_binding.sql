-- RealmWorld Phase 4D：Record 级版本 binding + 版本切换审计。
--
-- worlds.world_version（0054）是世界创建身份与新 Record 的默认绑定；
-- records.world_version 是 Record 的实际运行 binding（record-scope 只读它）。
-- 旧行回填是确定性的：先由 DEFAULT 落哨兵，再把非哨兵世界的记录改为
-- 其世界的版本；哨兵世界的记录保持哨兵（base mode）。

ALTER TABLE records
  ADD COLUMN IF NOT EXISTS world_version text NOT NULL DEFAULT '0.0.0-local';

UPDATE records AS record
SET world_version = world.world_version
FROM worlds AS world
WHERE world.workspace_id = record.workspace_id
  AND world.id = record.world_id
  AND record.world_version = '0.0.0-local'
  AND world.world_version <> '0.0.0-local';

ALTER TABLE records
  DROP CONSTRAINT IF EXISTS records_world_version_check;
ALTER TABLE records
  ADD CONSTRAINT records_world_version_check CHECK (length(btrim(world_version)) > 0);

COMMENT ON COLUMN records.world_version IS
  'RealmWorld Phase 4D: the Record''s actual running binding. ''0.0.0-local'' = base mode sentinel (never a mounted RealmWorld). worlds.world_version remains the creation identity and the default for new Records.';

-- 版本切换审计/幂等台账：每次显式 upgrade/downgrade 一行（同事务于
-- binding UPDATE）；同 (record, idempotency_key) 重放经 UNIQUE 检出。
CREATE TABLE IF NOT EXISTS realmworld_version_switches (
  workspace_id text NOT NULL,
  id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  from_version text NOT NULL,
  to_version text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, record_id, idempotency_key),
  CONSTRAINT realmworld_version_switches_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT realmworld_version_switches_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT realmworld_version_switches_operation_check
    CHECK (operation IN ('upgrade', 'downgrade')),
  CHECK (length(btrim(from_version)) > 0),
  CHECK (length(btrim(to_version)) > 0),
  CHECK (length(btrim(idempotency_key)) > 0)
);

ALTER TABLE realmworld_version_switches ENABLE ROW LEVEL SECURITY;
ALTER TABLE realmworld_version_switches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realmworld_version_switches;
CREATE POLICY realm_workspace_isolation ON realmworld_version_switches
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON realmworld_version_switches TO realm_runtime;
-- 切换是窄写通道：只允许改 records.world_version（不改写 events/head/拓扑）。
GRANT UPDATE (world_version) ON records TO realm_runtime;

COMMENT ON TABLE realmworld_version_switches IS
  'RealmWorld Phase 4D: explicit, auditable Record version switches; idempotency replay is detected by the (record, idempotency_key) UNIQUE pair.';
