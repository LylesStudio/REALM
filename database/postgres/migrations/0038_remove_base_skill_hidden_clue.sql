-- REALM removes the legacy base-skill hidden clue from live definitions.
--
-- 0035/0036 are already-applied immutable migrations and therefore retain
-- their historical SQL text. This follow-up cleans the rows they populated;
-- committed Events and append-only action receipts are intentionally untouched.
UPDATE skill_definitions
SET metadata = metadata - 'outcomes' - 'targets' - 'discovery' - 'privateObservation'
WHERE rule_pack_key = 'realm.base.v1'
  AND skill_key = 'keen_insight';

COMMENT ON TABLE skill_definitions IS
  'World-scoped skill definitions. Base skills carry mechanics/target identifiers; live hidden discoveries come from the action-time generator, not fixed clue prose.';
