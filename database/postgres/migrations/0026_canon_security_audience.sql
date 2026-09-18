-- REALM Canon Security Class & Revision Audience
-- 批次 T11-G（public documentation 冻结契约）：
--   1. canon_revisions 增加 security_class（默认 public，兼容既有行与
--      T11-B public 路径）——Revision 是传播安全分类的唯一正史承载点；
--   2. canon_revision_audiences：immutable audience snapshot（merge 同事务
--      写入，之后角色控制权变化不扩大历史 Canon 的受众集合）；
--   3. 非 public Revision 必须至少一条 audience——应用校验 +
--      DEFERRABLE INITIALLY DEFERRED constraint trigger 双保险（提交时校验，
--      同事务内先写 Revision 后写 audience 合法）。

ALTER TABLE canon_revisions
  ADD COLUMN IF NOT EXISTS security_class text NOT NULL DEFAULT 'public';

ALTER TABLE canon_revisions
  DROP CONSTRAINT IF EXISTS canon_revisions_security_check;
ALTER TABLE canon_revisions
  ADD CONSTRAINT canon_revisions_security_check
  CHECK (security_class IN ('public', 'restricted', 'secret'));

CREATE TABLE IF NOT EXISTS canon_revision_audiences (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  revision_id text NOT NULL,
  continuity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, world_id, worldline_id, revision_id, continuity_id),
  CONSTRAINT canon_revision_audiences_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT canon_revision_audiences_revision_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, revision_id)
    REFERENCES canon_revisions (workspace_id, world_id, worldline_id, id)
    ON DELETE CASCADE,
  CONSTRAINT canon_revision_audiences_continuity_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, continuity_id)
    REFERENCES character_continuities (workspace_id, world_id, worldline_id, id)
);

ALTER TABLE canon_revision_audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE canon_revision_audiences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON canon_revision_audiences;
CREATE POLICY realm_workspace_isolation ON canon_revision_audiences
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON canon_revision_audiences TO realm_runtime;

CREATE OR REPLACE FUNCTION guard_canon_revision_audience_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canon revision audiences are immutable snapshots';
END;
$$;

DROP TRIGGER IF EXISTS canon_revision_audiences_append_only_guard ON canon_revision_audiences;
CREATE TRIGGER canon_revision_audiences_append_only_guard
BEFORE UPDATE OR DELETE ON canon_revision_audiences
FOR EACH ROW
EXECUTE FUNCTION guard_canon_revision_audience_append_only();

CREATE OR REPLACE FUNCTION check_canon_revision_audience()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.security_class <> 'public' AND NOT EXISTS (
    SELECT 1 FROM canon_revision_audiences AS audience
    WHERE audience.workspace_id = NEW.workspace_id
      AND audience.world_id = NEW.world_id
      AND audience.worldline_id = NEW.worldline_id
      AND audience.revision_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'non-public canon revision requires at least one audience continuity';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canon_revision_audience_required ON canon_revisions;
CREATE CONSTRAINT TRIGGER canon_revision_audience_required
AFTER INSERT ON canon_revisions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION check_canon_revision_audience();

COMMENT ON COLUMN canon_revisions.security_class IS
  'Propagation security class of this revision (batch T11-G): the only canonical carrier; information_campaigns.security_class is a derived immutable snapshot.';
COMMENT ON TABLE canon_revision_audiences IS
  'Immutable audience snapshot for non-public canon revisions (batch T11-G): which continuities may receive this revision; written in the merge transaction.';
