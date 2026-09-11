-- REALM final least-privilege correction
-- Base skill metadata is backfilled by migration 0031, and future base
-- definitions are inserted with their complete metadata. Runtime must not
-- update arbitrary skill_definitions rows after assembly.
REVOKE UPDATE (metadata) ON skill_definitions FROM realm_runtime;
