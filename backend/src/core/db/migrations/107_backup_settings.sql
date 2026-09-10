-- #1420: encrypted backup settings + run history.
-- Additive + idempotent. S3 secrets are stored via encryptPat() from the admin
-- route, never as plaintext in this seed.

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES
  ('backup_s3_enabled', 'false', NOW()),
  ('backup_s3_endpoint', '', NOW()),
  ('backup_s3_bucket', '', NOW()),
  ('backup_s3_region', 'us-east-1', NOW()),
  ('backup_s3_access_key', '', NOW()),
  ('backup_s3_secret_key', '', NOW()),
  ('backup_s3_prefix', 'compendiq-backups/', NOW()),
  ('backup_s3_force_path_style', 'true', NOW()),
  ('backup_schedule_enabled', 'false', NOW()),
  ('backup_interval_hours', '24', NOW()),
  ('backup_retention_count', '7', NOW()),
  ('backup_retention_days', '30', NOW())
ON CONFLICT (setting_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS backup_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  destination   TEXT NOT NULL CHECK (destination IN ('download', 's3')),
  status        TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  bytes         BIGINT,
  object_key    TEXT,
  error         TEXT,
  triggered_by  TEXT
);

CREATE INDEX IF NOT EXISTS backup_runs_created_at_idx ON backup_runs (created_at DESC);
