-- Add embedding_status enum and embedded_at timestamp to cached_pages.
-- Replaces the boolean embedding_dirty with a richer 4-state model:
--   not_embedded  - page has never been embedded
--   embedding     - embedding is currently in progress
--   embedded      - page is fully indexed for AI search
--   failed        - last embedding attempt failed

ALTER TABLE cached_pages
  ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'not_embedded'
    CHECK (embedding_status IN ('not_embedded', 'embedding', 'embedded', 'failed')),
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- Back-fill from existing embedding_dirty boolean:
--   embedding_dirty = FALSE  ->  embedded (page was successfully embedded)
--   embedding_dirty = TRUE   ->  not_embedded (page needs embedding)
UPDATE cached_pages SET embedding_status = 'embedded', embedded_at = last_synced
  WHERE embedding_dirty = FALSE;
UPDATE cached_pages SET embedding_status = 'not_embedded'
  WHERE embedding_dirty = TRUE;

CREATE INDEX IF NOT EXISTS idx_cached_pages_embedding_status
  ON cached_pages(embedding_status);
