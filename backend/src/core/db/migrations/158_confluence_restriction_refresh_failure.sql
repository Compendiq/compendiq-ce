-- Keep failed periodic refreshes eligible for retry without letting them
-- monopolize the refresh cap or advancing the last successful mirror.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS restrictions_refresh_failed_at TIMESTAMPTZ;
