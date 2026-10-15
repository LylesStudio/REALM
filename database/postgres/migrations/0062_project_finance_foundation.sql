-- RealmWorld Project + Finance foundation (B3-A).
--
-- Project state, budget plans, finance accounts, and ledger facts are all
-- scoped to one Workspace/World/Worldline. Cash is deliberately not stored as
-- a writable truth: read-side projections derive it from opening balance plus
-- immutable ledger entries. World-specific roles, characters, and Story prose
-- stay in the content repository, not in this engine migration.

ALTER TABLE events
  DROP CONSTRAINT IF EXISTS events_kind_check;

ALTER TABLE events
  ADD CONSTRAINT events_kind_check CHECK (
    event_kind IN (
      'utterance.committed',
      'narration.committed',
      'action.transaction.committed',
      'system.correction.committed',
      'goal.transition.committed',
      'project.created',
      'project.stage.changed',
      'project.milestone.confirmed',
      'finance.budget.allocated',
      'finance.income.recorded',
      'finance.expense.recorded',
      'finance.adjustment.recorded'
    )
  );

CREATE TABLE IF NOT EXISTS projects (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  stage text NOT NULL DEFAULT 'planning',
  title text NOT NULL,
  currency text NOT NULL DEFAULT 'JPY',
  deadline date,
  owner_id text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT projects_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT projects_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT projects_kind_check
    CHECK (kind IN ('production', 'campaign', 'operation', 'initiative')),
  CONSTRAINT projects_status_check
    CHECK (status IN ('planned', 'active', 'completed', 'cancelled', 'archived')),
  CONSTRAINT projects_stage_check
    CHECK (stage IN ('planning', 'funding', 'production', 'scheduled', 'delivery', 'closed')),
  CONSTRAINT projects_currency_check
    CHECK (currency = 'JPY'),
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(title)) > 0),
  CHECK (owner_id IS NULL OR length(btrim(owner_id)) > 0),
  CHECK (version >= 1)
);

CREATE TABLE IF NOT EXISTS project_milestones (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  sequence integer NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'planned',
  due_on date,
  completion_record_id text,
  completion_event_id text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (workspace_id, project_id, sequence),
  CONSTRAINT project_milestones_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT project_milestones_project_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, project_id)
    REFERENCES projects (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT project_milestones_completion_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, completion_record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id),
  CONSTRAINT project_milestones_completion_event_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, completion_record_id, completion_event_id)
    REFERENCES events (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT project_milestones_status_check
    CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  CONSTRAINT project_milestones_completion_shape_check
    CHECK ((completion_record_id IS NULL) = (completion_event_id IS NULL)),
  CHECK (length(btrim(id)) > 0),
  CHECK (sequence >= 1),
  CHECK (length(btrim(title)) > 0)
);

CREATE INDEX IF NOT EXISTS project_milestones_project_idx
  ON project_milestones (workspace_id, project_id, sequence);

CREATE TABLE IF NOT EXISTS project_story_links (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  story_id text NOT NULL,
  link_kind text NOT NULL DEFAULT 'primary',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (workspace_id, project_id, story_id),
  CONSTRAINT project_story_links_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT project_story_links_project_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, project_id)
    REFERENCES projects (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT project_story_links_story_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, story_id)
    REFERENCES stories (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT project_story_links_kind_check
    CHECK (link_kind IN ('primary', 'related')),
  CHECK (length(btrim(id)) > 0)
);

CREATE TABLE IF NOT EXISTS budget_allocations (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  category text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'JPY',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (workspace_id, project_id, category),
  CONSTRAINT budget_allocations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT budget_allocations_project_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, project_id)
    REFERENCES projects (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT budget_allocations_currency_check
    CHECK (currency = 'JPY'),
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(category)) > 0),
  CHECK (amount_minor > 0),
  CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS budget_allocations_project_idx
  ON budget_allocations (workspace_id, project_id, category);

CREATE TABLE IF NOT EXISTS finance_accounts (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  currency text NOT NULL DEFAULT 'JPY',
  status text NOT NULL DEFAULT 'active',
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT finance_accounts_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT finance_accounts_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT finance_accounts_currency_check
    CHECK (currency = 'JPY'),
  CONSTRAINT finance_accounts_status_check
    CHECK (status IN ('active', 'closed')),
  CHECK (length(btrim(id)) > 0),
  CHECK (opening_balance_minor >= 0)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  account_id text NOT NULL,
  kind text NOT NULL,
  direction text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'JPY',
  category text NOT NULL,
  memo text NOT NULL,
  project_id text,
  source_record_id text,
  source_event_id text,
  occurred_at timestamptz NOT NULL,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (workspace_id, worldline_id, account_id, idempotency_key),
  CONSTRAINT ledger_entries_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT ledger_entries_account_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, account_id)
    REFERENCES finance_accounts (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT ledger_entries_project_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, project_id)
    REFERENCES projects (workspace_id, world_id, worldline_id, id),
  CONSTRAINT ledger_entries_source_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, source_record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id),
  CONSTRAINT ledger_entries_source_event_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, source_record_id, source_event_id)
    REFERENCES events (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT ledger_entries_kind_check
    CHECK (kind IN ('income', 'expense', 'adjustment')),
  CONSTRAINT ledger_entries_direction_check
    CHECK (direction IN ('income', 'expense')),
  CONSTRAINT ledger_entries_kind_direction_check
    CHECK (
      (kind = 'income' AND direction = 'income')
      OR (kind = 'expense' AND direction = 'expense')
      OR kind = 'adjustment'
    ),
  CONSTRAINT ledger_entries_currency_check
    CHECK (currency = 'JPY'),
  CHECK (length(btrim(id)) > 0),
  CHECK (amount_minor > 0),
  CHECK (length(btrim(category)) > 0),
  CHECK (length(btrim(memo)) > 0),
  CHECK (length(btrim(idempotency_key)) > 0),
  CHECK (length(idempotency_key) <= 128),
  CHECK (source_event_id IS NULL OR source_record_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS ledger_entries_account_time_idx
  ON ledger_entries (workspace_id, account_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS ledger_entries_project_time_idx
  ON ledger_entries (workspace_id, project_id, occurred_at, id)
  WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_finance_command_groups (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  state text NOT NULL,
  result_manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  rejection_code text,
  policy_version text NOT NULL,
  source_record_id text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (workspace_id, worldline_id, idempotency_key),
  CONSTRAINT project_finance_command_groups_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT project_finance_command_groups_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT project_finance_command_groups_source_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, source_record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id),
  CONSTRAINT project_finance_command_groups_state_check
    CHECK (state IN ('committed', 'rejected')),
  CONSTRAINT project_finance_command_groups_state_shape_check CHECK (
    (state = 'committed' AND rejection_code IS NULL AND completed_at IS NOT NULL)
    OR
    (state = 'rejected' AND rejection_code IS NOT NULL AND length(btrim(rejection_code)) > 0)
  ),
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(idempotency_key)) > 0),
  CHECK (length(idempotency_key) <= 128),
  CHECK (length(btrim(request_fingerprint)) > 0),
  CHECK (length(btrim(policy_version)) > 0),
  CHECK (jsonb_typeof(result_manifest) = 'object'),
  CHECK (octet_length(result_manifest::text) <= 65536)
);

CREATE INDEX IF NOT EXISTS project_finance_command_groups_source_record_idx
  ON project_finance_command_groups (workspace_id, source_record_id, created_at)
  WHERE source_record_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_ledger_entries_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ledger entries are immutable';
END;
$$;

DROP TRIGGER IF EXISTS ledger_entries_append_only_guard ON ledger_entries;
CREATE TRIGGER ledger_entries_append_only_guard
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION guard_ledger_entries_append_only();

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON projects;
CREATE POLICY realm_workspace_isolation ON projects
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE project_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_milestones FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON project_milestones;
CREATE POLICY realm_workspace_isolation ON project_milestones
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE project_story_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_story_links FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON project_story_links;
CREATE POLICY realm_workspace_isolation ON project_story_links
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE budget_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_allocations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON budget_allocations;
CREATE POLICY realm_workspace_isolation ON budget_allocations
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE finance_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON finance_accounts;
CREATE POLICY realm_workspace_isolation ON finance_accounts
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON ledger_entries;
CREATE POLICY realm_workspace_isolation ON ledger_entries
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE project_finance_command_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_finance_command_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON project_finance_command_groups;
CREATE POLICY realm_workspace_isolation ON project_finance_command_groups
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

-- Read/write is granted only to the server runtime. The ledger has no UPDATE
-- or DELETE grant; the trigger is a second, database-level immutability fence.
GRANT SELECT, INSERT, UPDATE ON projects TO realm_runtime;
GRANT SELECT, INSERT, UPDATE ON project_milestones TO realm_runtime;
GRANT SELECT, INSERT ON project_story_links TO realm_runtime;
GRANT SELECT, INSERT, UPDATE ON budget_allocations TO realm_runtime;
GRANT SELECT, INSERT ON finance_accounts TO realm_runtime;
GRANT UPDATE (status, updated_at) ON finance_accounts TO realm_runtime;
GRANT SELECT, INSERT ON ledger_entries TO realm_runtime;
GRANT SELECT, INSERT ON project_finance_command_groups TO realm_runtime;
GRANT UPDATE (state, result_manifest, rejection_code, updated_at, completed_at)
  ON project_finance_command_groups TO realm_runtime;

COMMENT ON TABLE projects IS
  'Server-owned production/project aggregate. World-specific content remains outside the public engine schema.';
COMMENT ON TABLE budget_allocations IS
  'Project budget plan; actual spending is derived from immutable ledger_entries, never copied into this table.';
COMMENT ON TABLE finance_accounts IS
  'Worldline-scoped finance account with opening balance; current cash is derived from ledger_entries.';
COMMENT ON TABLE ledger_entries IS
  'Immutable financial facts. Corrections append a new adjustment entry rather than updating or deleting history.';
COMMENT ON TABLE project_finance_command_groups IS
  'Project/Finance idempotency ledger: request fingerprint and committed/rejected result manifest.';
