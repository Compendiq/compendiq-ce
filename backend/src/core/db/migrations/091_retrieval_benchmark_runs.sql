-- Production retrieval benchmark runs.
--
-- A run is operational metadata only: it never copies or mutates pages or
-- embeddings. The JSON columns keep the submitted query set and the compact
-- paired result report together so an admin can poll a run across requests.
CREATE TABLE retrieval_benchmark_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  config JSONB NOT NULL,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX retrieval_benchmark_runs_created_idx
  ON retrieval_benchmark_runs (created_at DESC);

-- Retrieval is expensive and shares the configured LLM/embedding capacity.
-- Keep one queued or running comparison per deployment so two admins cannot
-- accidentally turn one click into four concurrent retrievals per question.
CREATE UNIQUE INDEX retrieval_benchmark_runs_one_active_idx
  ON retrieval_benchmark_runs ((TRUE))
  WHERE status IN ('queued', 'running');
