-- REALM Runtime Repository security hardening
-- PostgreSQL 16+ / pgvector
--
-- The migration runner owns the transaction boundary. This migration closes
-- the Scene visibility binding and reconciles realm_runtime to the exact
-- table and column privileges used by the PostgreSQL RuntimeRepository.

-- A Scene policy is an immutable audience snapshot for one particular Scene.
-- Reject a pre-existing mismatch rather than preserving a route by which an
-- Event in another Scene could borrow that audience.
DO $event_scene_visibility_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM events AS event
    JOIN visibility_policies AS policy
      ON policy.workspace_id = event.workspace_id
     AND policy.world_id = event.world_id
     AND policy.worldline_id = event.worldline_id
     AND policy.record_id = event.record_id
     AND policy.id = event.visibility_policy_id
    WHERE policy.policy_kind = 'scene'
      AND policy.scene_id IS DISTINCT FROM event.scene_id
  ) THEN
    RAISE EXCEPTION
      '0004 found a Scene Event bound to a visibility policy for another Scene';
  END IF;
END;
$event_scene_visibility_preflight$;

CREATE OR REPLACE FUNCTION validate_event_scene_visibility_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_kind text;
  policy_scene_id text;
BEGIN
  SELECT policy.policy_kind, policy.scene_id
  INTO policy_kind, policy_scene_id
  FROM visibility_policies AS policy
  WHERE policy.workspace_id = NEW.workspace_id
    AND policy.world_id = NEW.world_id
    AND policy.worldline_id = NEW.worldline_id
    AND policy.record_id = NEW.record_id
    AND policy.id = NEW.visibility_policy_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'event visibility policy does not exist in its Record scope';
  END IF;

  IF policy_kind = 'scene'
    AND policy_scene_id IS DISTINCT FROM NEW.scene_id THEN
    RAISE EXCEPTION
      'Scene visibility policy must belong to the Event Scene';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS events_scene_visibility_guard ON events;
CREATE TRIGGER events_scene_visibility_guard
BEFORE INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION validate_event_scene_visibility_policy();

-- Migration 0002 intentionally started with broad application grants while
-- the adapter contract was unfinished. Revoke them before granting only what
-- RuntimeRepository currently reads, appends, and advances. It receives no
-- DELETE/TRUNCATE privilege and cannot mutate Workspace or canonical content.
REVOKE ALL PRIVILEGES ON
  workspaces,
  worlds,
  worldlines,
  stories,
  records,
  scenes,
  character_definitions,
  character_continuities,
  character_instances,
  player_world_memberships,
  participants,
  visibility_policies,
  visibility_policy_audiences,
  command_inbox,
  turn_runs,
  events,
  record_heads,
  observations,
  context_manifests,
  context_snapshots,
  outbox
FROM realm_runtime;

GRANT SELECT ON
  worlds,
  worldlines,
  stories,
  records,
  scenes,
  character_definitions,
  character_continuities,
  character_instances,
  player_world_memberships,
  participants,
  visibility_policies,
  visibility_policy_audiences,
  command_inbox,
  turn_runs,
  record_heads,
  events,
  outbox
TO realm_runtime;

GRANT INSERT (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  id,
  principal_id,
  idempotency_key,
  request_fingerprint,
  command_kind,
  payload,
  expected_record_version,
  state,
  accepted_at,
  updated_at
) ON command_inbox TO realm_runtime;

GRANT UPDATE (
  state,
  result_event_ids,
  last_error_code,
  started_at,
  completed_at,
  updated_at
) ON command_inbox TO realm_runtime;

GRANT INSERT (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  command_id,
  id,
  attempt_number,
  state,
  revision,
  attempts,
  run_checkpoint,
  failure_history,
  transition_history,
  created_at,
  updated_at
) ON turn_runs TO realm_runtime;

GRANT UPDATE (
  state,
  revision,
  attempts,
  plan_payload,
  candidate_payload,
  validation_summary,
  run_checkpoint,
  failure_history,
  transition_history,
  release_receipt,
  release_fingerprint,
  completed_record_version,
  last_error_code,
  updated_at,
  completed_at
) ON turn_runs TO realm_runtime;

GRANT INSERT (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  scene_id,
  id,
  record_version,
  record_ordinal,
  batch_index,
  event_kind,
  actor_participant_id,
  speaker_name,
  content,
  payload,
  visibility_policy_id,
  world_tick,
  world_ordinal,
  calendar_id,
  display_time,
  causation_command_id,
  turn_run_id,
  recorded_at
) ON events TO realm_runtime;

GRANT INSERT (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  observer_character_instance_id,
  source_event_id,
  id,
  dedupe_key,
  observation_kind,
  content,
  fidelity,
  occurred_tick,
  occurred_ordinal,
  available_from_tick,
  available_from_ordinal,
  learned_at,
  metadata
) ON observations TO realm_runtime;

GRANT UPDATE (
  record_version,
  next_record_ordinal,
  last_event_id,
  last_world_tick,
  last_world_ordinal,
  updated_at
) ON record_heads TO realm_runtime;

GRANT UPDATE (
  head_tick,
  head_ordinal,
  updated_at
) ON worldlines TO realm_runtime;

GRANT INSERT (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  event_id,
  turn_run_id,
  id,
  dedupe_key,
  topic,
  payload,
  state,
  revision,
  attempt_count,
  available_at,
  created_at,
  updated_at
) ON outbox TO realm_runtime;

GRANT UPDATE (
  state,
  revision,
  attempt_count,
  available_at,
  lease_owner,
  lease_expires_at,
  published_at,
  last_error_code,
  last_error_message,
  last_error_at,
  updated_at
) ON outbox TO realm_runtime;

COMMENT ON FUNCTION validate_event_scene_visibility_policy() IS
  'Rejects a Scene Event that attempts to borrow another Scene visibility audience.';
