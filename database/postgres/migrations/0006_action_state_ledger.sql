-- REALM Action State Ledger v1
-- PostgreSQL 16+
--
-- Durable character skills, assets, effects and Action Receipts. Runtime
-- mutations are committed in the same transaction as their source Event.

CREATE TABLE IF NOT EXISTS skill_definitions (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  id text NOT NULL,
  skill_key text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  rule_pack_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, id),
  UNIQUE (workspace_id, world_id, skill_key),
  CONSTRAINT skill_definitions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT skill_definitions_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CHECK (length(btrim(skill_key)) > 0),
  CHECK (length(btrim(title)) > 0),
  CHECK (length(btrim(rule_pack_key)) > 0),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS character_skills (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  character_instance_id text NOT NULL,
  skill_definition_id text NOT NULL,
  acquired_tick bigint NOT NULL,
  acquired_ordinal bigint NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    workspace_id, record_id, character_instance_id, skill_definition_id
  ),
  CONSTRAINT character_skills_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT character_skills_instance_fk
    FOREIGN KEY (
      workspace_id, world_id, worldline_id, record_id, character_instance_id
    ) REFERENCES character_instances (
      workspace_id, world_id, worldline_id, record_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT character_skills_definition_fk
    FOREIGN KEY (workspace_id, world_id, skill_definition_id)
    REFERENCES skill_definitions (workspace_id, world_id, id),
  CHECK (acquired_tick >= 0 AND acquired_ordinal >= 0),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS asset_definitions (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  id text NOT NULL,
  asset_key text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  rule_pack_key text NOT NULL,
  consumable boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, id),
  UNIQUE (workspace_id, world_id, asset_key),
  CONSTRAINT asset_definitions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT asset_definitions_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CHECK (length(btrim(asset_key)) > 0),
  CHECK (length(btrim(title)) > 0),
  CHECK (length(btrim(rule_pack_key)) > 0),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS character_assets (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  character_instance_id text NOT NULL,
  asset_definition_id text NOT NULL,
  quantity bigint NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (
    workspace_id, record_id, character_instance_id, asset_definition_id
  ),
  CONSTRAINT character_assets_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT character_assets_instance_fk
    FOREIGN KEY (
      workspace_id, world_id, worldline_id, record_id, character_instance_id
    ) REFERENCES character_instances (
      workspace_id, world_id, worldline_id, record_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT character_assets_definition_fk
    FOREIGN KEY (workspace_id, world_id, asset_definition_id)
    REFERENCES asset_definitions (workspace_id, world_id, id),
  CHECK (quantity >= 0),
  CHECK (revision >= 0),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS effect_definitions (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  id text NOT NULL,
  effect_key text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  rule_pack_key text NOT NULL,
  effect_kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, id),
  UNIQUE (workspace_id, world_id, effect_key),
  CONSTRAINT effect_definitions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT effect_definitions_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT effect_definitions_kind_check
    CHECK (effect_kind IN ('stance', 'condition', 'buff', 'debuff', 'narrative')),
  CHECK (length(btrim(effect_key)) > 0),
  CHECK (length(btrim(title)) > 0),
  CHECK (length(btrim(rule_pack_key)) > 0),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS action_receipts (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  actor_character_instance_id text NOT NULL,
  source_event_id text NOT NULL,
  id text NOT NULL,
  transaction_id text NOT NULL,
  call_fingerprint text NOT NULL,
  receipt jsonb NOT NULL,
  world_tick bigint NOT NULL,
  world_ordinal bigint NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, record_id, transaction_id),
  CONSTRAINT action_receipts_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT action_receipts_instance_fk
    FOREIGN KEY (
      workspace_id, world_id, worldline_id, record_id,
      actor_character_instance_id
    ) REFERENCES character_instances (
      workspace_id, world_id, worldline_id, record_id, id
    ),
  CONSTRAINT action_receipts_event_fk
    FOREIGN KEY (
      workspace_id, world_id, worldline_id, record_id, source_event_id
    ) REFERENCES events (
      workspace_id, world_id, worldline_id, record_id, id
    ),
  CHECK (length(btrim(transaction_id)) > 0),
  CHECK (length(btrim(call_fingerprint)) > 0),
  CHECK (world_tick >= 0 AND world_ordinal >= 0),
  CHECK (jsonb_typeof(receipt) = 'object')
);

CREATE TABLE IF NOT EXISTS character_effects (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  character_instance_id text NOT NULL,
  effect_definition_id text NOT NULL,
  source_action_receipt_id text NOT NULL,
  id text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  applied_tick bigint NOT NULL,
  applied_ordinal bigint NOT NULL,
  ended_tick bigint,
  ended_ordinal bigint,
  revision bigint NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT character_effects_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT character_effects_instance_fk
    FOREIGN KEY (
      workspace_id, world_id, worldline_id, record_id, character_instance_id
    ) REFERENCES character_instances (
      workspace_id, world_id, worldline_id, record_id, id
    ) ON DELETE CASCADE,
  CONSTRAINT character_effects_definition_fk
    FOREIGN KEY (workspace_id, world_id, effect_definition_id)
    REFERENCES effect_definitions (workspace_id, world_id, id),
  CONSTRAINT character_effects_receipt_fk
    FOREIGN KEY (workspace_id, source_action_receipt_id)
    REFERENCES action_receipts (workspace_id, id),
  CONSTRAINT character_effects_status_check
    CHECK (status IN ('active', 'expired', 'removed')),
  CONSTRAINT character_effects_cursor_check CHECK (
    applied_tick >= 0 AND applied_ordinal >= 0
    AND (
      (ended_tick IS NULL AND ended_ordinal IS NULL)
      OR (ended_tick IS NOT NULL AND ended_ordinal IS NOT NULL
        AND (ended_tick, ended_ordinal) >= (applied_tick, applied_ordinal))
    )
  ),
  CHECK (revision >= 0),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE UNIQUE INDEX IF NOT EXISTS character_effects_one_active_idx
  ON character_effects (
    workspace_id, record_id, character_instance_id, effect_definition_id
  ) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS character_assets_available_idx
  ON character_assets (workspace_id, record_id, character_instance_id)
  WHERE quantity > 0;
CREATE INDEX IF NOT EXISTS character_effects_active_idx
  ON character_effects (workspace_id, record_id, character_instance_id)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION guard_action_receipt_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'action receipts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS action_receipts_append_only_guard ON action_receipts;
CREATE TRIGGER action_receipts_append_only_guard
BEFORE UPDATE OR DELETE ON action_receipts
FOR EACH ROW EXECUTE FUNCTION guard_action_receipt_append_only();

ALTER TABLE skill_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE character_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_skills FORCE ROW LEVEL SECURITY;
ALTER TABLE asset_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE character_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE effect_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE effect_definitions FORCE ROW LEVEL SECURITY;
ALTER TABLE action_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE character_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE character_effects FORCE ROW LEVEL SECURITY;

DO $policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'skill_definitions', 'character_skills', 'asset_definitions',
    'character_assets', 'effect_definitions', 'action_receipts',
    'character_effects'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS realm_workspace_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY realm_workspace_isolation ON %I USING (workspace_id = realm_current_workspace_id()) WITH CHECK (workspace_id = realm_current_workspace_id())',
      table_name
    );
  END LOOP;
END;
$policies$;

GRANT ALL PRIVILEGES ON
  skill_definitions, character_skills, asset_definitions, character_assets,
  effect_definitions, action_receipts, character_effects
TO realm_control;

GRANT SELECT ON
  skill_definitions, character_skills, asset_definitions, character_assets,
  effect_definitions, action_receipts, character_effects
TO realm_runtime;

GRANT UPDATE (quantity, revision, updated_at)
  ON character_assets TO realm_runtime;
GRANT INSERT (
  workspace_id, world_id, worldline_id, record_id,
  actor_character_instance_id, source_event_id, id, transaction_id,
  call_fingerprint, receipt, world_tick, world_ordinal, recorded_at
) ON action_receipts TO realm_runtime;
GRANT INSERT (
  workspace_id, world_id, worldline_id, record_id,
  character_instance_id, effect_definition_id, source_action_receipt_id,
  id, status, applied_tick, applied_ordinal, revision, metadata,
  created_at, updated_at
) ON character_effects TO realm_runtime;
GRANT UPDATE (
  status, ended_tick, ended_ordinal, revision, metadata, updated_at
) ON character_effects TO realm_runtime;

COMMENT ON TABLE action_receipts IS
  'Append-only durable rule receipts committed atomically with their source Events.';
COMMENT ON TABLE character_assets IS
  'Record-scoped CharacterInstance asset balances guarded by revisioned atomic updates.';
COMMENT ON TABLE character_effects IS
  'Durable active and historical effects, including actor-controlled stances.';
