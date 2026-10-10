-- REALM runtime-save restore write surface
--
-- Restore creates a fresh Record topology inside the authenticated workspace
-- transaction. The runtime role already owns the corresponding write path for
-- Worldline/Story/Record/character rows; grant only the two missing topology
-- tables needed to materialize source->target Scene and visibility-policy
-- mappings. RLS and workspace/world write gates remain authoritative.

GRANT INSERT ON scenes TO realm_runtime;
GRANT INSERT ON visibility_policies TO realm_runtime;
