-- Migration 023: Add quality scoring columns to cached_pages (#322)
--
-- Supports background batch quality analysis by the quality-worker.
-- Each page gets an overall score (0-100), five per-dimension scores,
-- a textual summary, and status tracking for the analysis pipeline.

ALTER TABLE cached_pages
  ADD COLUMN IF NOT EXISTS quality_score          INT,
  ADD COLUMN IF NOT EXISTS quality_completeness   INT,
  ADD COLUMN IF NOT EXISTS quality_clarity        INT,
  ADD COLUMN IF NOT EXISTS quality_structure      INT,
  ADD COLUMN IF NOT EXISTS quality_accuracy       INT,
  ADD COLUMN IF NOT EXISTS quality_readability    INT,
  ADD COLUMN IF NOT EXISTS quality_summary        TEXT,
  ADD COLUMN IF NOT EXISTS quality_analyzed_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_error          TEXT,
  ADD COLUMN IF NOT EXISTS quality_status         TEXT DEFAULT 'pending'
    CHECK (quality_status IN ('pending', 'analyzing', 'analyzed', 'failed', 'skipped'));

-- Index for filtering/sorting by quality score
CREATE INDEX IF NOT EXISTS idx_cached_pages_quality_score
  ON cached_pages(quality_score)
  WHERE quality_score IS NOT NULL;

-- Index for the worker to find pages needing analysis
CREATE INDEX IF NOT EXISTS idx_cached_pages_quality_status
  ON cached_pages(quality_status);
