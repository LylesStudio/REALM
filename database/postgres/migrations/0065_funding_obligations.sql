-- Generic funding obligations. Cash still moves only through ledger_entries.
-- Creating an obligation does not change cash. Repayment writes an expense
-- and an append-only settlement in the same transaction.

CREATE TABLE IF NOT EXISTS obligations (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  project_id text,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  principal_minor bigint NOT NULL,
  outstanding_minor bigint NOT NULL,
  share_bps integer,
  undelivered_count integer NOT NULL DEFAULT 0,
  due_on date,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT obligations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT obligations_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT obligations_project_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, project_id)
    REFERENCES projects (workspace_id, world_id, worldline_id, id),
  CONSTRAINT obligations_kind_check
    CHECK (kind IN ('loan', 'presale', 'revenue_share')),
  CONSTRAINT obligations_status_check
    CHECK (status IN ('open', 'settled', 'cancelled')),
  CONSTRAINT obligations_share_check CHECK (
    (kind = 'revenue_share' AND share_bps BETWEEN 0 AND 10000)
    OR (kind <> 'revenue_share' AND share_bps IS NULL)
  ),
  CHECK (principal_minor >= 0),
  CHECK (outstanding_minor >= 0),
  CHECK (outstanding_minor <= principal_minor),
  CHECK (undelivered_count >= 0),
  CHECK (version >= 1),
  CHECK (length(btrim(id)) > 0)
);

CREATE TABLE IF NOT EXISTS obligation_settlements (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  obligation_id text NOT NULL,
  ledger_entry_id text,
  kind text NOT NULL,
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT obligation_settlements_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT obligation_settlements_obligation_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, obligation_id)
    REFERENCES obligations (workspace_id, world_id, worldline_id, id),
  CONSTRAINT obligation_settlements_ledger_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, ledger_entry_id)
    REFERENCES ledger_entries (workspace_id, world_id, worldline_id, id),
  CONSTRAINT obligation_settlements_kind_check
    CHECK (kind IN ('repayment', 'draw', 'share')),
  CHECK (amount_minor > 0),
  CHECK (length(btrim(id)) > 0)
);

CREATE OR REPLACE FUNCTION guard_obligation_settlements_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'obligation_settlements are append-only';
END;
$$;

DROP TRIGGER IF EXISTS obligation_settlements_append_only_guard ON obligation_settlements;
CREATE TRIGGER obligation_settlements_append_only_guard
BEFORE UPDATE OR DELETE ON obligation_settlements
FOR EACH ROW
EXECUTE FUNCTION guard_obligation_settlements_append_only();

ALTER TABLE obligations ENABLE ROW LEVEL SECURITY;
ALTER TABLE obligations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON obligations;
CREATE POLICY realm_workspace_isolation ON obligations
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE obligation_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE obligation_settlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON obligation_settlements;
CREATE POLICY realm_workspace_isolation ON obligation_settlements
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON obligations TO realm_runtime;
GRANT SELECT, INSERT ON obligation_settlements TO realm_runtime;

COMMENT ON TABLE obligations IS
  'Generic funding obligations. Cash changes only through ledger_entries.';
COMMENT ON TABLE obligation_settlements IS
  'Append-only obligation draws, repayments, and revenue-share postings.';
