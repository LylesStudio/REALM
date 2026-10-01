-- Fence completions from workers whose scene-image request lease expired
-- and was reclaimed by a newer worker.
ALTER TABLE scene_image_requests
  ADD COLUMN IF NOT EXISTS lease_revision bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'scene_image_requests_lease_revision_check'
       AND conrelid = 'scene_image_requests'::regclass
  ) THEN
    ALTER TABLE scene_image_requests
      ADD CONSTRAINT scene_image_requests_lease_revision_check
      CHECK (lease_revision >= 0);
  END IF;
END
$$;

COMMENT ON COLUMN scene_image_requests.lease_revision IS
  'Monotonic worker lease fencing token; increments on every successful claim.';
