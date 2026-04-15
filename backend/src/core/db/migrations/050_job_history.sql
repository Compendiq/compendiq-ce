-- Migration 050: Job history table for BullMQ worker observability
CREATE TABLE IF NOT EXISTS job_history (
  id            BIGSERIAL PRIMARY KEY,
  queue_name    TEXT NOT NULL,
  job_id        TEXT NOT NULL,
  job_name      TEXT,
  status        TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  duration_ms   INTEGER,
  error_message TEXT,
  result_summary TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_job_history_queue_created
  ON job_history (queue_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_job_history_status
  ON job_history (status) WHERE status = 'failed';
