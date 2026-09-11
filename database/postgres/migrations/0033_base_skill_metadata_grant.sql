-- REALM runtime can backfill the metadata of existing base skills
-- idempotently when a new Record is assembled.
GRANT UPDATE (metadata) ON skill_definitions TO realm_runtime;
