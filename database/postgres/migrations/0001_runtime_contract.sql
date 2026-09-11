-- REALM Runtime Contract v1
-- PostgreSQL 16+ / pgvector
--
-- This migration is deliberately repeatable: every extension, table, index,
-- function, and trigger declaration can be applied again without deleting or
-- rewriting user data.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(name)) > 0)
);

CREATE TABLE IF NOT EXISTS worlds (
  workspace_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  calendar_id text NOT NULL,
  summary text NOT NULL DEFAULT '',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT worlds_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT worlds_status_check
    CHECK (status IN ('active', 'archived')),
  CHECK (length(btrim(id)) > 0),
  CHECK (length(btrim(name)) > 0),
  CHECK (length(btrim(calendar_id)) > 0),
  CHECK (jsonb_typeof(settings) = 'object')
);

CREATE TABLE IF NOT EXISTS worldlines (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  id text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  parent_worldline_id text,
  fork_tick bigint,
  fork_ordinal bigint,
  head_tick bigint NOT NULL DEFAULT 0,
  head_ordinal bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, id),
  CONSTRAINT worldlines_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT worldlines_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT worldlines_parent_fk
    FOREIGN KEY (workspace_id, world_id, parent_worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id),
  CONSTRAINT worldlines_status_check
    CHECK (status IN ('active', 'frozen', 'archived')),
  CONSTRAINT worldlines_fork_shape_check CHECK (
    (parent_worldline_id IS NULL AND fork_tick IS NULL AND fork_ordinal IS NULL)
    OR
    (parent_worldline_id IS NOT NULL AND fork_tick IS NOT NULL AND fork_ordinal IS NOT NULL)
  ),
  CHECK (parent_worldline_id IS NULL OR parent_worldline_id <> id),
  CHECK (fork_tick IS NULL OR fork_tick >= 0),
  CHECK (fork_ordinal IS NULL OR fork_ordinal >= 0),
  CHECK (head_tick >= 0),
  CHECK (head_ordinal >= 0)
);

CREATE TABLE IF NOT EXISTS stories (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  premise text NOT NULL DEFAULT '',
  start_tick bigint NOT NULL,
  start_ordinal bigint NOT NULL,
  end_tick bigint,
  end_ordinal bigint,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT stories_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT stories_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT stories_status_check
    CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  CONSTRAINT stories_cursor_check CHECK (
    start_tick >= 0 AND start_ordinal >= 0
    AND (
      (end_tick IS NULL AND end_ordinal IS NULL)
      OR
      (end_tick IS NOT NULL AND end_ordinal IS NOT NULL
        AND (end_tick, end_ordinal) >= (start_tick, start_ordinal))
    )
  )
);

CREATE TABLE IF NOT EXISTS records (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  story_id text NOT NULL,
  id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  start_tick bigint NOT NULL,
  start_ordinal bigint NOT NULL,
  end_tick bigint,
  end_ordinal bigint,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT records_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT records_story_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, story_id)
    REFERENCES stories (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT records_status_check
    CHECK (status IN ('draft', 'active', 'closed', 'archived')),
  CONSTRAINT records_cursor_check CHECK (
    start_tick >= 0 AND start_ordinal >= 0
    AND (
      (end_tick IS NULL AND end_ordinal IS NULL)
      OR
      (end_tick IS NOT NULL AND end_ordinal IS NOT NULL
        AND (end_tick, end_ordinal) >= (start_tick, start_ordinal))
    )
  )
);

CREATE TABLE IF NOT EXISTS scenes (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  location text NOT NULL DEFAULT '',
  objective text NOT NULL DEFAULT '',
  start_tick bigint NOT NULL,
  start_ordinal bigint NOT NULL,
  end_tick bigint,
  end_ordinal bigint,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT scenes_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT scenes_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT scenes_status_check
    CHECK (status IN ('planned', 'active', 'closed', 'cancelled')),
  CONSTRAINT scenes_cursor_check CHECK (
    start_tick >= 0 AND start_ordinal >= 0
    AND (
      (end_tick IS NULL AND end_ordinal IS NULL)
      OR
      (end_tick IS NOT NULL AND end_ordinal IS NOT NULL
        AND (end_tick, end_ordinal) >= (start_tick, start_ordinal))
    )
  )
);

CREATE TABLE IF NOT EXISTS character_definitions (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  id text NOT NULL,
  display_name text NOT NULL,
  source_format text NOT NULL DEFAULT 'native',
  profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, id),
  CONSTRAINT character_definitions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT character_definitions_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT character_definitions_source_format_check
    CHECK (source_format IN ('native', 'sillytavern_character_card')),
  CHECK (length(btrim(display_name)) > 0),
  CHECK (jsonb_typeof(profile) = 'object')
);

CREATE TABLE IF NOT EXISTS character_continuities (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  definition_id text NOT NULL,
  id text NOT NULL,
  continuity_key text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  born_tick bigint NOT NULL,
  born_ordinal bigint NOT NULL,
  ended_tick bigint,
  ended_ordinal bigint,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  UNIQUE (workspace_id, worldline_id, continuity_key),
  CONSTRAINT character_continuities_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT character_continuities_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT character_continuities_definition_fk
    FOREIGN KEY (workspace_id, world_id, definition_id)
    REFERENCES character_definitions (workspace_id, world_id, id),
  CONSTRAINT character_continuities_status_check
    CHECK (status IN ('active', 'inactive', 'ended')),
  CONSTRAINT character_continuities_cursor_check CHECK (
    born_tick >= 0 AND born_ordinal >= 0
    AND (
      (ended_tick IS NULL AND ended_ordinal IS NULL)
      OR
      (ended_tick IS NOT NULL AND ended_ordinal IS NOT NULL
        AND (ended_tick, ended_ordinal) >= (born_tick, born_ordinal))
    )
  )
);

CREATE TABLE IF NOT EXISTS character_instances (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  continuity_id text NOT NULL,
  predecessor_instance_id text,
  id text NOT NULL,
  controller_mode text NOT NULL,
  status text NOT NULL DEFAULT 'present',
  instantiated_tick bigint NOT NULL,
  instantiated_ordinal bigint NOT NULL,
  inheritance_cutoff_tick bigint NOT NULL,
  inheritance_cutoff_ordinal bigint NOT NULL,
  retired_tick bigint,
  retired_ordinal bigint,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  UNIQUE (workspace_id, worldline_id, continuity_id, id),
  UNIQUE (workspace_id, record_id, continuity_id),
  CONSTRAINT character_instances_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT character_instances_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT character_instances_continuity_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, continuity_id)
    REFERENCES character_continuities (workspace_id, world_id, worldline_id, id),
  CONSTRAINT character_instances_predecessor_fk
    FOREIGN KEY (workspace_id, worldline_id, continuity_id, predecessor_instance_id)
    REFERENCES character_instances (workspace_id, worldline_id, continuity_id, id),
  CONSTRAINT character_instances_controller_check
    CHECK (controller_mode IN ('human', 'ai', 'hybrid')),
  CONSTRAINT character_instances_status_check
    CHECK (status IN ('planned', 'present', 'absent', 'retired')),
  CONSTRAINT character_instances_cursor_check CHECK (
    instantiated_tick >= 0 AND instantiated_ordinal >= 0
    AND inheritance_cutoff_tick >= 0 AND inheritance_cutoff_ordinal >= 0
    AND (inheritance_cutoff_tick, inheritance_cutoff_ordinal)
      <= (instantiated_tick, instantiated_ordinal)
    AND (
      (retired_tick IS NULL AND retired_ordinal IS NULL)
      OR
      (retired_tick IS NOT NULL AND retired_ordinal IS NOT NULL
        AND (retired_tick, retired_ordinal)
          >= (instantiated_tick, instantiated_ordinal))
    )
  ),
  CHECK (jsonb_typeof(state) = 'object')
);

CREATE TABLE IF NOT EXISTS player_world_memberships (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  principal_id text NOT NULL,
  role text NOT NULL DEFAULT 'player',
  omniscient_player_character boolean NOT NULL DEFAULT true,
  can_view_dynamic_knowledge boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, world_id, principal_id),
  CONSTRAINT player_world_memberships_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT player_world_memberships_world_fk
    FOREIGN KEY (workspace_id, world_id)
    REFERENCES worlds (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT player_world_memberships_role_check
    CHECK (role IN ('owner', 'player', 'observer')),
  CHECK (length(btrim(principal_id)) > 0)
);

CREATE TABLE IF NOT EXISTS participants (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  participant_kind text NOT NULL,
  character_instance_id text,
  principal_id text,
  controller_mode text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  speaking_order integer NOT NULL DEFAULT 0,
  shared_control_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT participants_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT participants_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT participants_character_instance_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, character_instance_id)
    REFERENCES character_instances (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT participants_membership_fk
    FOREIGN KEY (workspace_id, world_id, principal_id)
    REFERENCES player_world_memberships (workspace_id, world_id, principal_id),
  CONSTRAINT participants_kind_check
    CHECK (participant_kind IN ('character', 'narrator')),
  CONSTRAINT participants_controller_check
    CHECK (controller_mode IN ('human', 'ai', 'hybrid')),
  CONSTRAINT participants_shape_check CHECK (
    (participant_kind = 'character' AND character_instance_id IS NOT NULL)
    OR
    (participant_kind = 'narrator' AND character_instance_id IS NULL)
  ),
  CHECK (speaking_order >= 0)
);

CREATE TABLE IF NOT EXISTS visibility_policies (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  policy_key text NOT NULL,
  policy_version bigint NOT NULL DEFAULT 1,
  policy_kind text NOT NULL,
  scene_id text,
  restricted_domain_id text,
  private_character_instance_id text,
  audience_character_instance_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  UNIQUE (workspace_id, record_id, policy_key, policy_version),
  CONSTRAINT visibility_policies_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT visibility_policies_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT visibility_policies_scene_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, scene_id)
    REFERENCES scenes (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT visibility_policies_private_character_fk
    FOREIGN KEY (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      private_character_instance_id
    ) REFERENCES character_instances (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      id
    ),
  CONSTRAINT visibility_policies_version_check
    CHECK (policy_version > 0),
  CONSTRAINT visibility_policies_kind_check
    CHECK (policy_kind IN ('public', 'scene', 'restricted', 'private', 'dm_only')),
  CONSTRAINT visibility_policies_shape_check CHECK (
    (
      policy_kind IN ('public', 'dm_only')
      AND scene_id IS NULL
      AND restricted_domain_id IS NULL
      AND private_character_instance_id IS NULL
      AND cardinality(audience_character_instance_ids) = 0
    )
    OR
    (
      policy_kind = 'scene'
      AND scene_id IS NOT NULL
      AND restricted_domain_id IS NULL
      AND private_character_instance_id IS NULL
    )
    OR
    (
      policy_kind = 'restricted'
      AND scene_id IS NULL
      AND restricted_domain_id IS NOT NULL
      AND private_character_instance_id IS NULL
      AND cardinality(audience_character_instance_ids) > 0
    )
    OR
    (
      policy_kind = 'private'
      AND scene_id IS NULL
      AND restricted_domain_id IS NULL
      AND private_character_instance_id IS NOT NULL
      AND cardinality(audience_character_instance_ids) = 0
    )
  )
);

CREATE TABLE IF NOT EXISTS command_inbox (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  id text NOT NULL,
  principal_id text,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  command_kind text NOT NULL,
  payload jsonb NOT NULL,
  expected_record_version bigint NOT NULL,
  state text NOT NULL DEFAULT 'accepted',
  result_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_error_code text,
  accepted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  UNIQUE (workspace_id, record_id, idempotency_key),
  CONSTRAINT command_inbox_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT command_inbox_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT command_inbox_membership_fk
    FOREIGN KEY (workspace_id, world_id, principal_id)
    REFERENCES player_world_memberships (workspace_id, world_id, principal_id),
  CONSTRAINT command_inbox_state_check
    CHECK (state IN ('accepted', 'processing', 'completed', 'failed')),
  CHECK (length(btrim(idempotency_key)) > 0),
  CHECK (length(btrim(request_fingerprint)) > 0),
  CHECK (length(btrim(command_kind)) > 0),
  CHECK (expected_record_version >= 0),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS turn_runs (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  command_id text NOT NULL,
  id text NOT NULL,
  attempt_number integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'accepted',
  candidate_payload jsonb,
  validation_summary jsonb,
  completed_record_version bigint,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  UNIQUE (workspace_id, command_id, attempt_number),
  CONSTRAINT turn_runs_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT turn_runs_command_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, command_id)
    REFERENCES command_inbox (workspace_id, world_id, worldline_id, record_id, id)
    ON DELETE CASCADE,
  CONSTRAINT turn_runs_state_check CHECK (
    state IN (
      'accepted',
      'planning',
      'drafting',
      'validating',
      'releasing',
      'completed',
      'failed',
      'retryable'
    )
  ),
  CONSTRAINT turn_runs_lease_shape_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (attempt_number > 0),
  CHECK (completed_record_version IS NULL OR completed_record_version > 0),
  CHECK (candidate_payload IS NULL OR jsonb_typeof(candidate_payload) = 'object'),
  CHECK (validation_summary IS NULL OR jsonb_typeof(validation_summary) = 'object')
);

CREATE TABLE IF NOT EXISTS events (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  scene_id text NOT NULL,
  id text NOT NULL,
  record_version bigint NOT NULL,
  record_ordinal bigint NOT NULL,
  batch_index integer NOT NULL,
  event_kind text NOT NULL,
  actor_participant_id text,
  speaker_name text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  visibility_policy_id text NOT NULL,
  world_tick bigint NOT NULL,
  world_ordinal bigint NOT NULL,
  calendar_id text NOT NULL,
  display_time text NOT NULL DEFAULT '',
  causation_command_id text,
  turn_run_id text,
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, worldline_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  UNIQUE (workspace_id, record_id, record_ordinal),
  UNIQUE (workspace_id, record_id, record_version, batch_index),
  UNIQUE (workspace_id, worldline_id, world_tick, world_ordinal),
  CONSTRAINT events_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT events_scene_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, scene_id)
    REFERENCES scenes (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT events_actor_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, actor_participant_id)
    REFERENCES participants (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT events_visibility_policy_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, visibility_policy_id)
    REFERENCES visibility_policies (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT events_command_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, causation_command_id)
    REFERENCES command_inbox (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT events_turn_run_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, turn_run_id)
    REFERENCES turn_runs (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT events_kind_check CHECK (
    event_kind IN (
      'utterance.committed',
      'narration.committed',
      'action.transaction.committed',
      'system.correction.committed'
    )
  ),
  CHECK (record_version > 0),
  CHECK (record_ordinal >= 0),
  CHECK (batch_index >= 0),
  CHECK (world_tick >= 0),
  CHECK (world_ordinal >= 0),
  CHECK (length(btrim(calendar_id)) > 0),
  CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE IF NOT EXISTS record_heads (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  record_version bigint NOT NULL DEFAULT 0,
  next_record_ordinal bigint NOT NULL DEFAULT 0,
  last_event_id text,
  last_world_tick bigint,
  last_world_ordinal bigint,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, record_id),
  CONSTRAINT record_heads_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT record_heads_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT record_heads_last_event_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, last_event_id)
    REFERENCES events (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT record_heads_cursor_shape_check CHECK (
    (last_world_tick IS NULL AND last_world_ordinal IS NULL)
    OR
    (last_world_tick IS NOT NULL AND last_world_ordinal IS NOT NULL)
  ),
  CHECK (record_version >= 0),
  CHECK (next_record_ordinal >= 0),
  CHECK (last_world_tick IS NULL OR last_world_tick >= 0),
  CHECK (last_world_ordinal IS NULL OR last_world_ordinal >= 0)
);

CREATE TABLE IF NOT EXISTS observations (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  observer_character_instance_id text NOT NULL,
  source_event_id text,
  id text NOT NULL,
  dedupe_key text NOT NULL,
  observation_kind text NOT NULL,
  content text NOT NULL,
  fidelity numeric(5, 4) NOT NULL DEFAULT 1.0,
  occurred_tick bigint NOT NULL,
  occurred_ordinal bigint NOT NULL,
  available_from_tick bigint NOT NULL,
  available_from_ordinal bigint NOT NULL,
  learned_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  semantic_embedding vector,
  search_document tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', content)
  ) STORED,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  UNIQUE (workspace_id, observer_character_instance_id, dedupe_key),
  CONSTRAINT observations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT observations_observer_fk
    FOREIGN KEY (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      observer_character_instance_id
    ) REFERENCES character_instances (
      workspace_id,
      world_id,
      worldline_id,
      record_id,
      id
    ) ON DELETE CASCADE,
  CONSTRAINT observations_source_event_fk
    FOREIGN KEY (workspace_id, worldline_id, source_event_id)
    REFERENCES events (workspace_id, worldline_id, id),
  CONSTRAINT observations_kind_check
    CHECK (observation_kind IN ('direct', 'inferred', 'rumor', 'system_grant')),
  CONSTRAINT observations_cursor_check CHECK (
    occurred_tick >= 0
    AND occurred_ordinal >= 0
    AND available_from_tick >= 0
    AND available_from_ordinal >= 0
    AND (available_from_tick, available_from_ordinal)
      >= (occurred_tick, occurred_ordinal)
  ),
  CHECK (fidelity >= 0.0 AND fidelity <= 1.0),
  CHECK (length(btrim(content)) > 0),
  CHECK (length(btrim(dedupe_key)) > 0),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE IF NOT EXISTS context_manifests (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  turn_run_id text,
  id text NOT NULL,
  consumer_kind text NOT NULL,
  consumer_id text,
  purpose text NOT NULL,
  effective_tick bigint NOT NULL,
  effective_ordinal bigint NOT NULL,
  protocol_version text NOT NULL,
  cache_epoch text NOT NULL,
  visibility_policy_version text NOT NULL,
  cache_family_id text NOT NULL,
  prefix_hash text NOT NULL,
  dynamic_hash text NOT NULL,
  selected_entry_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  filtered_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_budget jsonb NOT NULL DEFAULT '{}'::jsonb,
  control_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT context_manifests_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT context_manifests_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT context_manifests_turn_run_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, turn_run_id)
    REFERENCES turn_runs (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT context_manifests_consumer_check
    CHECK (consumer_kind IN ('dm', 'narrator', 'character', 'principal')),
  CONSTRAINT context_manifests_consumer_shape_check CHECK (
    (consumer_kind IN ('dm', 'narrator') AND consumer_id IS NULL)
    OR
    (consumer_kind IN ('character', 'principal') AND consumer_id IS NOT NULL)
  ),
  CHECK (effective_tick >= 0),
  CHECK (effective_ordinal >= 0),
  CHECK (length(btrim(purpose)) > 0),
  CHECK (length(btrim(cache_family_id)) > 0),
  CHECK (length(btrim(prefix_hash)) > 0),
  CHECK (length(btrim(dynamic_hash)) > 0),
  CHECK (jsonb_typeof(filtered_counts) = 'object'),
  CHECK (jsonb_typeof(token_budget) = 'object'),
  CHECK (jsonb_typeof(control_details) = 'object'),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS outbox (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  record_id text NOT NULL,
  event_id text,
  turn_run_id text,
  id text NOT NULL,
  dedupe_key text NOT NULL,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_owner text,
  lease_expires_at timestamptz,
  published_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, dedupe_key),
  CONSTRAINT outbox_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT outbox_record_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id)
    REFERENCES records (workspace_id, world_id, worldline_id, id) ON DELETE CASCADE,
  CONSTRAINT outbox_event_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, event_id)
    REFERENCES events (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT outbox_turn_run_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, record_id, turn_run_id)
    REFERENCES turn_runs (workspace_id, world_id, worldline_id, record_id, id),
  CONSTRAINT outbox_state_check
    CHECK (state IN ('pending', 'dispatching', 'published', 'dead_letter')),
  CONSTRAINT outbox_lease_shape_check CHECK (
    (lease_owner IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CHECK (attempt_count >= 0),
  CHECK (length(btrim(dedupe_key)) > 0),
  CHECK (length(btrim(topic)) > 0),
  CHECK (jsonb_typeof(payload) = 'object')
);

-- Lookup and ordering indexes always begin with workspace_id so an adapter can
-- preserve the tenant boundary in every normal access path.
CREATE INDEX IF NOT EXISTS worlds_workspace_status_idx
  ON worlds (workspace_id, status);
CREATE INDEX IF NOT EXISTS worldlines_world_status_idx
  ON worldlines (workspace_id, world_id, status);
CREATE INDEX IF NOT EXISTS worldlines_parent_idx
  ON worldlines (workspace_id, world_id, parent_worldline_id);
CREATE INDEX IF NOT EXISTS stories_worldline_status_idx
  ON stories (workspace_id, worldline_id, status);
CREATE INDEX IF NOT EXISTS records_story_status_idx
  ON records (workspace_id, story_id, status);
CREATE INDEX IF NOT EXISTS records_worldline_cursor_idx
  ON records (workspace_id, worldline_id, start_tick, start_ordinal);
CREATE INDEX IF NOT EXISTS scenes_record_cursor_idx
  ON scenes (workspace_id, record_id, start_tick, start_ordinal);
CREATE INDEX IF NOT EXISTS character_definitions_world_idx
  ON character_definitions (workspace_id, world_id, display_name);
CREATE INDEX IF NOT EXISTS character_continuities_definition_idx
  ON character_continuities (workspace_id, worldline_id, definition_id);
CREATE INDEX IF NOT EXISTS character_instances_continuity_cursor_idx
  ON character_instances (
    workspace_id,
    worldline_id,
    continuity_id,
    instantiated_tick,
    instantiated_ordinal
  );
CREATE INDEX IF NOT EXISTS character_instances_record_status_idx
  ON character_instances (workspace_id, record_id, status);
CREATE INDEX IF NOT EXISTS player_world_memberships_principal_idx
  ON player_world_memberships (workspace_id, principal_id);
CREATE UNIQUE INDEX IF NOT EXISTS participants_record_character_uidx
  ON participants (workspace_id, record_id, character_instance_id)
  WHERE character_instance_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS participants_record_narrator_uidx
  ON participants (workspace_id, record_id)
  WHERE participant_kind = 'narrator';
CREATE INDEX IF NOT EXISTS participants_record_speaking_idx
  ON participants (workspace_id, record_id, is_active, speaking_order);
CREATE INDEX IF NOT EXISTS visibility_policies_audience_gin_idx
  ON visibility_policies USING gin (audience_character_instance_ids);
CREATE INDEX IF NOT EXISTS command_inbox_recovery_idx
  ON command_inbox (workspace_id, state, updated_at)
  WHERE state IN ('accepted', 'processing');
CREATE INDEX IF NOT EXISTS turn_runs_recovery_idx
  ON turn_runs (workspace_id, state, lease_expires_at)
  WHERE state NOT IN ('completed', 'failed');
CREATE INDEX IF NOT EXISTS events_record_order_idx
  ON events (workspace_id, record_id, record_ordinal);
CREATE INDEX IF NOT EXISTS events_worldline_cursor_idx
  ON events (workspace_id, worldline_id, world_tick, world_ordinal);
CREATE INDEX IF NOT EXISTS events_record_version_idx
  ON events (workspace_id, record_id, record_version, batch_index);
CREATE UNIQUE INDEX IF NOT EXISTS events_command_batch_uidx
  ON events (workspace_id, record_id, causation_command_id, batch_index)
  WHERE causation_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS observations_character_available_idx
  ON observations (
    workspace_id,
    worldline_id,
    observer_character_instance_id,
    available_from_tick,
    available_from_ordinal
  );
CREATE INDEX IF NOT EXISTS observations_source_event_idx
  ON observations (workspace_id, worldline_id, source_event_id);
CREATE INDEX IF NOT EXISTS observations_search_document_gin_idx
  ON observations USING gin (search_document);
CREATE INDEX IF NOT EXISTS context_manifests_consumer_cursor_idx
  ON context_manifests (
    workspace_id,
    worldline_id,
    record_id,
    consumer_kind,
    consumer_id,
    effective_tick,
    effective_ordinal
  );
CREATE INDEX IF NOT EXISTS context_manifests_cache_family_idx
  ON context_manifests (workspace_id, cache_family_id, created_at);
CREATE INDEX IF NOT EXISTS outbox_dispatch_idx
  ON outbox (workspace_id, available_at, created_at)
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS outbox_record_idx
  ON outbox (workspace_id, record_id, created_at);

-- A repository transaction must set the local tenant before touching scoped
-- data, for example: SET LOCAL realm.workspace_id = 'workspace_demo'. When the
-- setting is absent, the comparison evaluates to NULL and RLS denies access.
CREATE OR REPLACE FUNCTION realm_current_workspace_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('realm.workspace_id', true), '');
$$;

DO $realm_workspace_rls$
DECLARE
  relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'worlds',
    'worldlines',
    'stories',
    'records',
    'scenes',
    'character_definitions',
    'character_continuities',
    'character_instances',
    'player_world_memberships',
    'participants',
    'visibility_policies',
    'command_inbox',
    'turn_runs',
    'events',
    'record_heads',
    'observations',
    'context_manifests',
    'outbox'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation_name);
    EXECUTE format(
      'DROP POLICY IF EXISTS realm_workspace_isolation ON %I',
      relation_name
    );
    EXECUTE format(
      'CREATE POLICY realm_workspace_isolation ON %I '
      || 'USING (workspace_id = realm_current_workspace_id()) '
      || 'WITH CHECK (workspace_id = realm_current_workspace_id())',
      relation_name
    );
  END LOOP;
END;
$realm_workspace_rls$;

-- This setting is selected when a world is created and must not be changed by
-- a later UI update. Dynamic knowledge visibility remains mutable.
CREATE OR REPLACE FUNCTION guard_membership_omniscience_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.omniscient_player_character IS DISTINCT FROM OLD.omniscient_player_character THEN
    RAISE EXCEPTION 'omniscient_player_character is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS player_world_memberships_omniscience_guard
  ON player_world_memberships;
CREATE TRIGGER player_world_memberships_omniscience_guard
BEFORE UPDATE ON player_world_memberships
FOR EACH ROW
EXECUTE FUNCTION guard_membership_omniscience_immutable();

-- Policies are immutable snapshots. Audience changes create a new policy
-- version so old events never gain or lose readers retroactively.
CREATE OR REPLACE FUNCTION guard_visibility_policy_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'visibility policies are immutable; create a new version';
END;
$$;

DROP TRIGGER IF EXISTS visibility_policies_update_guard
  ON visibility_policies;
CREATE TRIGGER visibility_policies_update_guard
BEFORE UPDATE ON visibility_policies
FOR EACH ROW
EXECUTE FUNCTION guard_visibility_policy_immutable();

COMMENT ON TABLE context_manifests IS
  'Protected control-plane diagnostics; never expose through ordinary player APIs or model input.';
COMMENT ON COLUMN observations.semantic_embedding IS
  'Nullable pgvector hook only; M1 does not generate embeddings or perform vector recall.';
