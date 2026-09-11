-- Realm Runtime Contract v1 dynamic visibility policies.
-- The migration runner owns the transaction boundary. This migration only
-- lets the runtime append an immutable restricted-audience snapshot inside the
-- same atomic Turn release that commits the protected Event.

GRANT INSERT (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  id,
  policy_key,
  policy_version,
  policy_kind,
  restricted_domain_id,
  audience_character_instance_ids
) ON visibility_policies TO realm_runtime;

-- Audience rows are normally produced by the policy normalization trigger.
-- The runtime receives INSERT only so that trigger can run under the same
-- least-privilege role; direct partial audiences still fail the Event guard.
GRANT INSERT (
  workspace_id,
  world_id,
  worldline_id,
  record_id,
  visibility_policy_id,
  character_instance_id
) ON visibility_policy_audiences TO realm_runtime;
