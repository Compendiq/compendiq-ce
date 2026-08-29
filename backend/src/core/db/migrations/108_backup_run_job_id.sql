-- #1420: correlate queued backup jobs with persisted run history.
-- Nullable for scheduled legacy runs and historical rows created before this migration.

ALTER TABLE backup_runs
  ADD COLUMN IF NOT EXISTS job_id TEXT;

CREATE INDEX IF NOT EXISTS backup_runs_job_id_idx
  ON backup_runs (job_id)
  WHERE job_id IS NOT NULL;
