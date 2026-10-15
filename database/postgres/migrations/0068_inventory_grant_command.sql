-- Allow the first-holding grant to share the committed-fact command ledger
-- without overloading the adjustment kind.

ALTER TABLE committed_fact_commands
  DROP CONSTRAINT IF EXISTS committed_fact_commands_kind_check;

ALTER TABLE committed_fact_commands
  ADD CONSTRAINT committed_fact_commands_kind_check
  CHECK (kind IN (
    'inventory_adjusted',
    'inventory_granted',
    'relationship_revised',
    'performance_assessed'
  ));
