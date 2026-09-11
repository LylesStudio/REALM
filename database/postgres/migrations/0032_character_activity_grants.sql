-- REALM reversible Record cast activity and audit timestamp grants
-- 0030 is already applied and immutable; this migration extends only the
-- column-level write surface required by character activity/profile updates.
GRANT UPDATE (updated_at, status, retired_tick, retired_ordinal)
  ON character_instances TO realm_runtime;
GRANT UPDATE (is_active, updated_at) ON participants TO realm_runtime;
