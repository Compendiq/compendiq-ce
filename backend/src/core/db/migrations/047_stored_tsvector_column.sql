-- Migration 047: Add stored tsvector column for full-text search
-- Replaces runtime to_tsvector() computation with a pre-computed STORED column.
-- The old expression-based GIN index (idx_cached_pages_fts from migration 005)
-- is superseded by the new column-based index.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_text, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_pages_tsv ON pages USING gin(tsv);

-- Drop the old expression-based GIN index.
-- Named idx_cached_pages_fts (from migration 005, table was renamed in 028
-- but the index name was not updated).
DROP INDEX IF EXISTS idx_cached_pages_fts;
