-- Article qualification ledger + Tavern import source identity.
-- SWM 下一阶段（plan v10 §5）：owner attestation 是 article 正文公共资格的
-- 唯一来源；import entry 持久化 file_exact source identity。
-- 本文件由 scripts/postgres-migrate.mjs 的 per-file transaction 包裹，
-- 禁止出现 BEGIN/COMMIT/ROLLBACK（D10/F27）。

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 资格账本：append-only 事件流；latest-state = 每 article seq 最大者
-- （行锁保证 seq 唯一，id 字典序为双保险 tiebreak）。
CREATE TABLE IF NOT EXISTS article_qualifications (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  article_id text NOT NULL,
  id text NOT NULL,
  seq bigint NOT NULL,
  provenance_kind text NOT NULL,
  status text NOT NULL,
  content_hash text NOT NULL,
  attested_by text,
  attested_at timestamptz,
  available_from_tick bigint NOT NULL DEFAULT 0,
  available_from_ordinal bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, article_id, seq),
  CONSTRAINT aq_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT aq_article_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, article_id)
    REFERENCES world_articles (workspace_id, world_id, worldline_id, id)
    ON DELETE CASCADE,
  CONSTRAINT aq_provenance_check CHECK (
    provenance_kind IN ('canon_generated', 'tavern_import', 'manual', 'owner_attest')
  ),
  CONSTRAINT aq_status_check CHECK (
    status IN ('pending_review', 'qualified_public', 'rejected', 'revoked')
  ),
  CONSTRAINT aq_qualified_provenance_check CHECK (
    status <> 'qualified_public' OR provenance_kind = 'owner_attest'
  ),
  CONSTRAINT aq_identity_check CHECK (
    (status = 'pending_review' AND attested_by IS NULL AND attested_at IS NULL)
    OR (status <> 'pending_review' AND attested_by IS NOT NULL AND attested_at IS NOT NULL)
  ),
  CONSTRAINT aq_cursor_check CHECK (
    available_from_tick >= 0 AND available_from_ordinal >= 0
  ),
  CONSTRAINT aq_hash_check CHECK (length(btrim(content_hash)) > 0)
);

-- 导入 source identity：file_exact 唯一模式（本阶段 CHECK 锁死）。
-- source_namespace 恒等于 bundle_content_hash（整文件 sha256 hex），
-- stable_entry_identity 恒等于 entry_ordinal 的规范文本——realm_runtime
-- 无法插入任意 namespace/identity；不同 bundle 必然不同 namespace，
-- 两个独立 worldbook 不会因相同 uid/name/position 错误合并。
CREATE TABLE IF NOT EXISTS article_import_entries (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  article_id text NOT NULL,
  id text NOT NULL,
  source_kind text NOT NULL,
  source_namespace text NOT NULL,
  stable_entry_identity text NOT NULL,
  identity_kind text NOT NULL,
  entry_uid text,
  entry_ordinal bigint NOT NULL,
  normalized_name text NOT NULL,
  bundle_content_hash text NOT NULL,
  entry_content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (
    workspace_id, world_id, worldline_id,
    source_kind, source_namespace, stable_entry_identity
  ),
  CONSTRAINT aie_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT aie_article_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, article_id)
    REFERENCES world_articles (workspace_id, world_id, worldline_id, id)
    ON DELETE CASCADE,
  CONSTRAINT aie_source_kind_check CHECK (source_kind IN ('tavern_worldbook')),
  CONSTRAINT aie_identity_kind_check CHECK (identity_kind IN ('file_exact')),
  CONSTRAINT aie_ordinal_check CHECK (entry_ordinal >= 0),
  CONSTRAINT aie_hash_check CHECK (
    bundle_content_hash ~ '^[0-9a-f]{64}$'
    AND entry_content_hash ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT aie_namespace_check CHECK (source_namespace = bundle_content_hash),
  CONSTRAINT aie_identity_check CHECK (stable_entry_identity = entry_ordinal::text)
);

CREATE OR REPLACE FUNCTION guard_article_qualification_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard_qualification$
BEGIN
  RAISE EXCEPTION
    'article qualifications are append-only; append a new qualification event';
END;
$guard_qualification$;

DROP TRIGGER IF EXISTS article_qualifications_append_only_guard ON article_qualifications;
CREATE TRIGGER article_qualifications_append_only_guard
BEFORE UPDATE OR DELETE ON article_qualifications
FOR EACH ROW
EXECUTE FUNCTION guard_article_qualification_append_only();

CREATE OR REPLACE FUNCTION guard_article_import_entry_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $guard_import_entry$
BEGIN
  RAISE EXCEPTION
    'article import entries are append-only; re-import reports duplicate';
END;
$guard_import_entry$;

DROP TRIGGER IF EXISTS article_import_entries_append_only_guard ON article_import_entries;
CREATE TRIGGER article_import_entries_append_only_guard
BEFORE UPDATE OR DELETE ON article_import_entries
FOR EACH ROW
EXECUTE FUNCTION guard_article_import_entry_append_only();

ALTER TABLE article_qualifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_qualifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON article_qualifications;
CREATE POLICY realm_workspace_isolation ON article_qualifications
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE article_import_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE article_import_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON article_import_entries;
CREATE POLICY realm_workspace_isolation ON article_import_entries
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON article_qualifications TO realm_runtime;
GRANT SELECT, INSERT ON article_import_entries TO realm_runtime;

COMMENT ON TABLE article_qualifications IS
  'Append-only qualification ledger; owner attestation is the only public-qualification source.';
COMMENT ON TABLE article_import_entries IS
  'Tavern import source identity (file_exact): namespace = bundle sha256, identity = entry ordinal.';
