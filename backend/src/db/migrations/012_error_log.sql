-- Error log table for lightweight self-hosted error monitoring
CREATE TABLE error_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  context JSONB DEFAULT '{}',
  user_id UUID REFERENCES users(id),
  request_path TEXT,
  correlation_id TEXT,
  resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_error_log_created ON error_log(created_at);
CREATE INDEX idx_error_log_type ON error_log(error_type);
CREATE INDEX idx_error_log_unresolved ON error_log(resolved) WHERE resolved = FALSE;
