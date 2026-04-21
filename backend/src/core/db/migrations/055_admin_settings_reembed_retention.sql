-- Migration 055: admin-configurable reembed-all job history retention (#257)
--
-- Introduces the `reembed_history_retention` admin setting (integer stored as
-- text). Controls how many completed / failed re-embed-all BullMQ job records
-- are retained in Redis before the oldest get swept.
--
-- Additive + idempotent:
--   - No schema DDL.
--   - No column or table changes.
--   - Uses ON CONFLICT DO NOTHING so existing deployments that already set an
--     explicit value (via a manual UPDATE before this migration ran) keep it.
--
-- Default: 150. Valid range (enforced by Zod at the API boundary +
-- `getReembedHistoryRetention` clamp inside `admin-settings-service.ts`):
-- [10, 10000].
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('reembed_history_retention', '150', NOW())
ON CONFLICT (setting_key) DO NOTHING;
