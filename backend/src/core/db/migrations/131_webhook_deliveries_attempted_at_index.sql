-- Migration 131: index for the webhook_deliveries retention sweep (#1797)
--
-- `data-retention-service.ts :: runWebhookDeliveriesRetention` deletes in
-- batches by `attempted_at < NOW() - N days` (joined to terminal
-- webhook_outbox rows). Without this index each batch scans the whole ledger.
--
-- Additive + idempotent.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_attempted_at
  ON webhook_deliveries (attempted_at);
