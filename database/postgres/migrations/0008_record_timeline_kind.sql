-- Record timeline classification for retrospection and merge links.
ALTER TABLE records
  ADD COLUMN IF NOT EXISTS timeline_kind text NOT NULL DEFAULT 'primary';
ALTER TABLE records
  ADD COLUMN IF NOT EXISTS linked_record_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'records_timeline_kind_check'
  ) THEN
    ALTER TABLE records
      ADD CONSTRAINT records_timeline_kind_check
      CHECK (timeline_kind IN ('primary', 'retrospection', 'merged'));
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'records_linked_record_fk'
  ) THEN
    ALTER TABLE records
      ADD CONSTRAINT records_linked_record_fk
      FOREIGN KEY (workspace_id, linked_record_id)
      REFERENCES records (workspace_id, id);
  END IF;
END;
$$;
