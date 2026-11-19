-- Migration 154: retention windows for job_history and read notifications (#1760)
--
-- Seeds the admin-configurable retention windows (days) for the
-- `data-retention-service`-driven sweeps of `job_history` (050_job_history.sql)
-- and READ `notifications` (036_notifications.sql; unread rows are never deleted).
--
-- Range (Zod): [7, 3650]. Default: 90.
--
-- Read cascade (see `data-retention-service.ts :: runJobHistoryRetention` and
-- `runReadNotificationsRetention`):
--   admin_settings.job_history_retention_days
--     -> env RETENTION_JOB_HISTORY_DAYS  (optional)
--     -> 90  (hard default)
--   admin_settings.notifications_read_retention_days
--     -> env RETENTION_NOTIFICATIONS_READ_DAYS  (optional)
--     -> 90  (hard default)
--
-- No index: the sweeps run once a day over a few hundred rows a day.
-- Additive + idempotent.
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('job_history_retention_days', '90', NOW()),
       ('notifications_read_retention_days', '90', NOW())
ON CONFLICT (setting_key) DO NOTHING;
