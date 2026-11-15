-- #1710: a failed retention prune after a completed S3 upload is a warning on a
-- successful run, not a failed run. `error` stays NULL on success; the warning
-- is written by a dedicated UPDATE after the run is already recorded as success.
-- Additive + idempotent; existing rows keep a NULL warning.

ALTER TABLE backup_runs ADD COLUMN IF NOT EXISTS warning TEXT;
