-- Migration 045: Add GIN trigram index on pages.title for fuzzy title matching.
-- pg_trgm extension is already installed by migration 001_extensions.sql.

CREATE INDEX IF NOT EXISTS idx_pages_title_trgm
  ON pages USING gin (title gin_trgm_ops);
