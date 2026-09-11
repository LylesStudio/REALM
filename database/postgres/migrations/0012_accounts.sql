-- REALM Accounts Contract
-- 昵称即身份：无密码、无凭据列、无注册审批。

CREATE TABLE IF NOT EXISTS accounts (
  workspace_id text NOT NULL,
  principal_id text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, principal_id),
  UNIQUE (workspace_id, display_name),
  CONSTRAINT accounts_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CHECK (length(btrim(principal_id)) > 0),
  CHECK (length(btrim(display_name)) > 0)
);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON accounts;
CREATE POLICY realm_workspace_isolation ON accounts
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON accounts TO realm_runtime;

COMMENT ON TABLE accounts IS
  'Display-name identity mapping; stores no credentials of any kind.';
