-- Migration 130: retention policy for webhook_deliveries attempt rows (#1797)
--
-- Seeds the admin-configurable retention window (days) for the
-- `data-retention-service`-driven purge of the `webhook_deliveries`
-- attempt ledger promised by migration 068.
--
-- Range (Zod): [7, 3650]. Default: 90.
--
-- Read cascade (see `data-retention-service.ts :: runWebhookDeliveriesRetention`):
--   admin_settings.webhook_deliveries_retention_days
--     -> env RETENTION_WEBHOOK_DELIVERIES_DAYS  (optional)
--     -> 90  (hard default)
--
-- Additive + idempotent.
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('webhook_deliveries_retention_days', '90', NOW())
ON CONFLICT (setting_key) DO NOTHING;
