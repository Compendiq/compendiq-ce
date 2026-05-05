-- Migration 067: transactional outbox for webhook events (Compendiq/compendiq-ee#114)
--
-- Classic outbox pattern: event-producer code (sync-service, pages-crud,
-- scheduled workers) writes a row here in the SAME transaction as the
-- domain mutation that caused the event. The outbox poller then picks
-- pending rows and hands them to the BullMQ delivery worker, keeping the
-- receiver dedup key stable (`webhook_id`) across retries.
--
-- Key design points:
--   - `webhook_id`         stable across retries → receivers use it as
--                          their idempotency key per the Standard Webhooks
--                          spec.
--   - `payload_bytes`      denormalised size so the admin-settings payload
--                          cap can be enforced on insert without re-
--                          measuring jsonb size. Rows exceeding the cap
--                          (plan §1.7) are rejected at insert time, not
--                          silently truncated.
--   - `status` state machine:
--       pending    → outbox poller has not claimed it yet
--       dispatched → claimed; a BullMQ job is enqueued (bullmq_job_id set)
--       done       → delivery worker succeeded (at least one 2xx response)
--       dead       → exhausted retries; requires operator action
--   - `next_dispatch_at`   drives the pending-row scan; the delivery
--                          worker updates it with back-off deltas on
--                          transient failure so the poller re-tries later
--                          rather than spinning.
--
-- Partial index keeps the working set small: the vast majority of rows
-- are `done` and need no scan; only `status='pending'` rows are hot.

CREATE TABLE IF NOT EXISTS webhook_outbox (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  webhook_id       UUID NOT NULL DEFAULT gen_random_uuid(),
  event_type       TEXT NOT NULL,
  payload          JSONB NOT NULL,
  payload_bytes    INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'dispatched', 'done', 'dead')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_dispatch_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at    TIMESTAMPTZ,
  bullmq_job_id    TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_pending
  ON webhook_outbox (status, next_dispatch_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_subscription
  ON webhook_outbox (subscription_id, created_at DESC);
