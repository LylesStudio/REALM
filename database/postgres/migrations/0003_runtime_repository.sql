-- REALM recoverable Runtime Repository v1
-- PostgreSQL 16+ / pgvector
--
-- The migration runner owns the transaction boundary. This migration only
-- extends recoverable runtime checkpoints and Outbox delivery metadata; it
-- does not rewrite committed Events.

-- A legacy Turn cannot be reconstructed from the v1 columns: plans,
-- transitions, failures, and release identity were not stored. Refuse the
-- first upgrade rather than manufacture an unreadable `{}` checkpoint. This
-- preflight is skipped on repeat application once the new column exists.
DO $runtime_repository_legacy_turn_preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'turn_runs'
      AND column_name = 'run_checkpoint'
  ) AND EXISTS (SELECT 1 FROM turn_runs) THEN
    RAISE EXCEPTION
      '0003 cannot upgrade non-empty legacy turn_runs; resolve or explicitly discard prototype Turns first';
  END IF;
END;
$runtime_repository_legacy_turn_preflight$;

ALTER TABLE turn_runs
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attempts jsonb NOT NULL DEFAULT
    '{"planning":0,"drafting":0,"validating":0,"releasing":0}'::jsonb,
  ADD COLUMN IF NOT EXISTS plan_payload jsonb,
  ADD COLUMN IF NOT EXISTS run_checkpoint jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS failure_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS transition_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS release_receipt jsonb,
  ADD COLUMN IF NOT EXISTS release_fingerprint text;

-- Reconcile a partially applied development migration that may have installed
-- the old invalid default. New Turns must always provide their full checkpoint.
ALTER TABLE turn_runs ALTER COLUMN run_checkpoint DROP DEFAULT;

DO $runtime_repository_checkpoint_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM turn_runs
    WHERE jsonb_typeof(run_checkpoint) IS DISTINCT FROM 'object'
      OR NOT (run_checkpoint ? 'turnId')
      OR jsonb_typeof(run_checkpoint->'turnId') IS DISTINCT FROM 'string'
      OR length(btrim(run_checkpoint->>'turnId')) = 0
  ) THEN
    RAISE EXCEPTION
      '0003 found an invalid Turn checkpoint; repair it before applying Runtime Repository constraints';
  END IF;
END;
$runtime_repository_checkpoint_preflight$;

DO $runtime_repository_turn_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'turn_runs_revision_check'
      AND conrelid = 'turn_runs'::regclass
  ) THEN
    ALTER TABLE turn_runs
      ADD CONSTRAINT turn_runs_revision_check CHECK (revision >= 0);
  END IF;

  ALTER TABLE turn_runs
    DROP CONSTRAINT IF EXISTS turn_runs_repository_json_check;
  ALTER TABLE turn_runs
    ADD CONSTRAINT turn_runs_repository_json_check CHECK (
      jsonb_typeof(attempts) = 'object'
      AND jsonb_typeof(run_checkpoint) = 'object'
      AND run_checkpoint ? 'turnId'
      AND jsonb_typeof(run_checkpoint->'turnId') = 'string'
      AND length(btrim(run_checkpoint->>'turnId')) > 0
      AND jsonb_typeof(failure_history) = 'array'
      AND jsonb_typeof(transition_history) = 'array'
      AND (plan_payload IS NULL OR jsonb_typeof(plan_payload) = 'object')
      AND (release_receipt IS NULL OR jsonb_typeof(release_receipt) = 'object')
    );

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'turn_runs_release_shape_check'
      AND conrelid = 'turn_runs'::regclass
  ) THEN
    ALTER TABLE turn_runs
      ADD CONSTRAINT turn_runs_release_shape_check CHECK (
        (release_receipt IS NULL AND release_fingerprint IS NULL)
        OR
        (release_receipt IS NOT NULL
          AND release_fingerprint IS NOT NULL
          AND length(btrim(release_fingerprint)) > 0)
      );
  END IF;
END;
$runtime_repository_turn_checks$;

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_message text,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz;

ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_state_check;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_failure_shape_check;
ALTER TABLE outbox DROP CONSTRAINT IF EXISTS outbox_runtime_state_shape_check;

-- Canonicalize every legacy delivery state before installing the stricter
-- Runtime state machine. A dispatch without a lease is recoverable work, not
-- an in-flight delivery. A pending row carrying a failure is likewise a retry.
UPDATE outbox
SET state = CASE
  WHEN state = 'dispatching'
    AND lease_owner IS NOT NULL
    AND lease_expires_at IS NOT NULL
    THEN 'delivering'
  WHEN state = 'dispatching' THEN 'retryable'
  WHEN state = 'published' THEN 'delivered'
  WHEN state = 'dead_letter' THEN 'failed'
  WHEN state = 'delivering'
    AND (lease_owner IS NULL OR lease_expires_at IS NULL)
    THEN 'retryable'
  WHEN state = 'pending'
    AND (
      last_error_code IS NOT NULL
      OR last_error_message IS NOT NULL
      OR last_error_at IS NOT NULL
    )
    THEN 'retryable'
  ELSE state
END;

UPDATE outbox
SET lease_owner = NULL,
    lease_expires_at = NULL
WHERE state <> 'delivering';

UPDATE outbox
SET published_at = CASE
      WHEN state = 'delivered'
        THEN COALESCE(published_at, updated_at, created_at)
      ELSE NULL
    END;

UPDATE outbox
SET last_error_code = CASE
      WHEN state IN ('retryable', 'failed')
        OR (
          state = 'delivering'
          AND (
            last_error_code IS NOT NULL
            OR last_error_message IS NOT NULL
            OR last_error_at IS NOT NULL
          )
        )
        THEN COALESCE(
          NULLIF(btrim(last_error_code), ''),
          'LEGACY_OUTBOX_FAILURE'
        )
      ELSE NULL
    END,
    last_error_message = CASE
      WHEN state IN ('retryable', 'failed')
        OR (
          state = 'delivering'
          AND (
            last_error_code IS NOT NULL
            OR last_error_message IS NOT NULL
            OR last_error_at IS NOT NULL
          )
        )
        THEN COALESCE(
          NULLIF(btrim(last_error_message), ''),
          'Legacy Outbox failure details are unavailable.'
        )
      ELSE NULL
    END,
    last_error_at = CASE
      WHEN state IN ('retryable', 'failed')
        OR (
          state = 'delivering'
          AND (
            last_error_code IS NOT NULL
            OR last_error_message IS NOT NULL
            OR last_error_at IS NOT NULL
          )
        )
        THEN COALESCE(last_error_at, updated_at, created_at)
      ELSE NULL
    END;

DO $runtime_repository_outbox_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM outbox
    WHERE state NOT IN (
      'pending', 'delivering', 'retryable', 'delivered', 'failed'
    )
      OR (
        state = 'delivering'
        AND (lease_owner IS NULL OR lease_expires_at IS NULL)
      )
      OR (
        state <> 'delivering'
        AND (lease_owner IS NOT NULL OR lease_expires_at IS NOT NULL)
      )
      OR (
        state IN ('pending', 'delivered')
        AND (
          last_error_code IS NOT NULL
          OR last_error_message IS NOT NULL
          OR last_error_at IS NOT NULL
        )
      )
      OR (
        state IN ('retryable', 'failed')
        AND (
          last_error_code IS NULL
          OR last_error_message IS NULL
          OR last_error_at IS NULL
          OR length(btrim(last_error_code)) = 0
          OR length(btrim(last_error_message)) = 0
        )
      )
      OR (
        state = 'delivering'
        AND NOT (
          (
            last_error_code IS NULL
            AND last_error_message IS NULL
            AND last_error_at IS NULL
          )
          OR
          (
            last_error_code IS NOT NULL
            AND last_error_message IS NOT NULL
            AND last_error_at IS NOT NULL
            AND length(btrim(last_error_code)) > 0
            AND length(btrim(last_error_message)) > 0
          )
        )
      )
  ) THEN
    RAISE EXCEPTION
      '0003 could not normalize legacy Outbox rows to the canonical Runtime state machine';
  END IF;
END;
$runtime_repository_outbox_preflight$;

ALTER TABLE outbox
  ADD CONSTRAINT outbox_state_check CHECK (
    state IN ('pending', 'delivering', 'retryable', 'delivered', 'failed')
  );

DO $runtime_repository_outbox_checks$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'outbox_revision_check'
      AND conrelid = 'outbox'::regclass
  ) THEN
    ALTER TABLE outbox
      ADD CONSTRAINT outbox_revision_check CHECK (revision >= 0);
  END IF;

  ALTER TABLE outbox
    ADD CONSTRAINT outbox_failure_shape_check CHECK (
      (last_error_code IS NULL
        AND last_error_message IS NULL
        AND last_error_at IS NULL)
      OR
      (last_error_code IS NOT NULL
        AND last_error_message IS NOT NULL
        AND last_error_at IS NOT NULL
        AND length(btrim(last_error_code)) > 0
        AND length(btrim(last_error_message)) > 0)
    );

  ALTER TABLE outbox
    ADD CONSTRAINT outbox_runtime_state_shape_check CHECK (
      (
        (
          state = 'delivering'
          AND lease_owner IS NOT NULL
          AND lease_expires_at IS NOT NULL
        )
        OR
        (
          state <> 'delivering'
          AND lease_owner IS NULL
          AND lease_expires_at IS NULL
        )
      )
      AND
      (
        state = 'delivering'
        OR (
          state IN ('pending', 'delivered')
          AND last_error_code IS NULL
          AND last_error_message IS NULL
          AND last_error_at IS NULL
        )
        OR (
          state IN ('retryable', 'failed')
          AND last_error_code IS NOT NULL
          AND last_error_message IS NOT NULL
          AND last_error_at IS NOT NULL
        )
      )
      AND
      (
        (state = 'delivered' AND published_at IS NOT NULL)
        OR (state <> 'delivered' AND published_at IS NULL)
      )
    );
END;
$runtime_repository_outbox_checks$;

DROP INDEX IF EXISTS outbox_dispatch_idx;
CREATE INDEX IF NOT EXISTS outbox_dispatch_idx
  ON outbox (workspace_id, available_at, created_at)
  WHERE state IN ('pending', 'retryable');

COMMENT ON COLUMN turn_runs.run_checkpoint IS
  'Complete persistence-neutral TurnRun checkpoint; candidates remain outside the committed Event plane.';
COMMENT ON COLUMN turn_runs.revision IS
  'Application revision used for optimistic concurrency; never substitute xmin.';
COMMENT ON COLUMN outbox.revision IS
  'Application revision fencing claims, lease recovery, and settlement.';
