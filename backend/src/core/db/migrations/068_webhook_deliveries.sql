-- Migration 068: webhook delivery attempt log (Compendiq/compendiq-ee#114)
--
-- Append-only ledger of every delivery attempt (successful or otherwise).
-- One row per HTTP call, not per outbox item — a row in `webhook_outbox`
-- may have multiple delivery rows if retries occurred.
--
-- The admin UI surfaces this table for failure diagnosis: the operator
-- sees per-attempt `http_status`, truncated response body (1 KB cap in
-- the delivery worker to keep the DB bounded), and for SSRF-guard blocks
-- the specific `error_message`.
--
-- `status` vocabulary:
--   success       2xx response, delivery complete (outbox row also marked done)
--   failure       non-2xx response
--   timeout       socket or overall request timeout hit
--   ssrf_blocked  ssrf-guard refused the URL — counted against the
--                 retry budget like any other failure so a misconfigured
--                 URL eventually lands in `dead` instead of looping.
--
-- Retention: swept by the daily retention worker per
-- `webhook_deliveries_retention_days` admin setting (default 90). Plan
-- .plans/114-webhooks.md §1.1 inline convention.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id       UUID NOT NULL REFERENCES webhook_outbox(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  webhook_id      UUID NOT NULL,
  attempt_number  INTEGER NOT NULL,
  status          TEXT NOT NULL
                    CHECK (status IN ('success', 'failure', 'timeout', 'ssrf_blocked')),
  http_status     INTEGER,
  response_body   TEXT,
  error_message   TEXT,
  duration_ms     INTEGER,
  attempted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_outbox
  ON webhook_deliveries (outbox_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries (subscription_id, attempted_at DESC);
