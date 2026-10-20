-- A delivery classification, not an authenticity or source-trust assertion.
ALTER TABLE public.outbox ADD COLUMN restore_delivery_kind text;
ALTER TABLE public.outbox
  ADD CONSTRAINT outbox_restore_delivery_kind_check CHECK (
    restore_delivery_kind IS NULL
    OR (
      restore_delivery_kind = 'record-events-v1'
      AND turn_run_id IS NULL
      AND topic = 'record.events.committed'
    )
  );
GRANT INSERT (restore_delivery_kind) ON public.outbox TO realm_runtime;
