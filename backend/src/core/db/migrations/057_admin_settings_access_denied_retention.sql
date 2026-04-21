-- Migration 057: retention policy for ADMIN_ACCESS_DENIED audit rows (#264)
--
-- Seeds the admin-configurable retention window (days) for the
-- `data-retention-service`-driven purge of `audit_log` rows with
-- `action = 'ADMIN_ACCESS_DENIED'`.
--
-- Range (Zod): [7, 3650]. Default: 90.
--
-- Read cascade (see `data-retention-service.ts :: runAdminAccessDeniedRetention`):
--   admin_settings.admin_access_denied_retention_days
--     -> env RETENTION_ADMIN_ACCESS_DENIED_DAYS  (optional)
--     -> 90  (hard default)
--
-- Additive + idempotent.
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('admin_access_denied_retention_days', '90', NOW())
ON CONFLICT (setting_key) DO NOTHING;
