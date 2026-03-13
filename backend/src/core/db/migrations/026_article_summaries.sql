-- Migration 024: Add AI-generated article summaries with change detection (#323)
--
-- Adds columns to cached_pages for background auto-summarization:
--   summary_text       - plain text summary
--   summary_html       - HTML-rendered summary (from Markdown via marked)
--   summary_status     - workflow state: pending | summarizing | summarized | failed | skipped
--   summary_generated_at - when the summary was last generated
--   summary_error      - error message from last failed attempt
--   summary_content_hash - SHA-256 of body_text at summarization time (change detection)
--   summary_model      - which LLM model generated the summary
--   summary_retry_count - number of failed attempts (max 3 before giving up)

ALTER TABLE cached_pages
  ADD COLUMN IF NOT EXISTS summary_text         TEXT,
  ADD COLUMN IF NOT EXISTS summary_html         TEXT,
  ADD COLUMN IF NOT EXISTS summary_status       TEXT NOT NULL DEFAULT 'pending'
    CHECK (summary_status IN ('pending', 'summarizing', 'summarized', 'failed', 'skipped')),
  ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS summary_error        TEXT,
  ADD COLUMN IF NOT EXISTS summary_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS summary_model        TEXT,
  ADD COLUMN IF NOT EXISTS summary_retry_count  INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_cached_pages_summary_status
  ON cached_pages(summary_status);
