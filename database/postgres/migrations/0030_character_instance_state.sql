-- REALM Record-scoped character state
-- Dynamic profile updates belong to character_instances.state for the current
-- Record. They must never mutate the shared character_definitions.profile.
GRANT UPDATE (state) ON character_instances TO realm_runtime;
