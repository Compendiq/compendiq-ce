-- Migration 019: Add composite indexes for common query patterns
--
-- The embedding service frequently queries by (user_id, embedding_dirty)
-- sorted by last_modified_at. The pages list endpoint queries by
-- (user_id, space_key) sorted by last_modified_at.
-- These composite indexes cover both patterns efficiently.

CREATE INDEX IF NOT EXISTS idx_cached_pages_dirty_modified
  ON cached_pages(user_id, embedding_dirty, last_modified_at DESC);

CREATE INDEX IF NOT EXISTS idx_cached_pages_space_modified
  ON cached_pages(user_id, space_key, last_modified_at DESC);
