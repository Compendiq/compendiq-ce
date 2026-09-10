-- Keep asynchronous production benchmark workers recoverable after a process
-- restart. The active-run index is intentionally strict, so an abandoned run
-- must be distinguishable from one that is still making progress.
ALTER TABLE retrieval_benchmark_runs
  ADD COLUMN last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX retrieval_benchmark_runs_heartbeat_idx
  ON retrieval_benchmark_runs (last_heartbeat_at)
  WHERE status IN ('queued', 'running');
