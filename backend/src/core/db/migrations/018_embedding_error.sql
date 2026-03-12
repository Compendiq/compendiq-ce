-- Add embedding_error column to cached_pages.
-- Stores the error message from the last failed embedding attempt so the UI
-- can surface it to the user for diagnosis instead of a silent "failed" badge.

ALTER TABLE cached_pages
  ADD COLUMN IF NOT EXISTS embedding_error TEXT;
