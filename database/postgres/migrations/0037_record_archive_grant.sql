-- REALM Record deletion surface
--
-- Record deletion is implemented as an owner-authorized archive/hide operation.
-- Committed Events remain append-only and are retained for worldline/audit
-- integrity; the runtime only needs to mutate the Record status and timestamp.
GRANT UPDATE (status, updated_at) ON records TO realm_runtime;

COMMENT ON COLUMN records.status IS
  'Record lifecycle: draft/active/closed remain visible; archived is a user-requested hidden Record retained for audit integrity.';
