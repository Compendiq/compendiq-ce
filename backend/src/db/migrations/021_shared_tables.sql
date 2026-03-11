-- Migration 021: Migrate pages/embeddings/spaces/versions to shared tables (#238)
--
-- Changes from per-user isolation to space-based access control:
--   • user_space_selections: replaces user_settings.selected_spaces array
--   • admin_settings: new global key-value store for server-wide settings
--   • cached_spaces / cached_pages / page_embeddings / page_versions /
--     page_relationships: drop user_id column; add unique constraints on
--     content identity keys instead of (user_id, content_key) pairs.
--   • page_embeddings gets a CASCADE FK to cached_pages so deletions are
--     automatically propagated without explicit DELETE statements.
--
-- Data impact: cached content is TRUNCATED and will be re-synced.
-- User credentials (user_settings) and auth state are preserved.
-- Selected-spaces memberships are migrated to user_space_selections
-- before the source column is dropped.

-- ── 1. Create user_space_selections ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_space_selections (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  space_key TEXT NOT NULL,
  PRIMARY KEY (user_id, space_key)
);

-- Migrate existing selected_spaces arrays → individual rows
INSERT INTO user_space_selections (user_id, space_key)
SELECT user_id, unnest(selected_spaces)
FROM   user_settings
WHERE  array_length(selected_spaces, 1) > 0
ON CONFLICT DO NOTHING;

-- ── 2. Create admin_settings ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_settings (
  setting_key   TEXT PRIMARY KEY,
  setting_value TEXT        NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 3. Truncate cached data ───────────────────────────────────────────────────
-- All cached content will be re-synced after the migration.
-- Order matters: page_embeddings references nothing in these tables (yet).

TRUNCATE page_relationships, page_versions, page_embeddings, cached_pages, cached_spaces;

-- ── 4. cached_spaces: drop user_id, new unique constraint ────────────────────

ALTER TABLE cached_spaces DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE cached_spaces ADD CONSTRAINT cached_spaces_space_key_key UNIQUE (space_key);

-- ── 5. cached_pages: drop user_id, new unique, update indexes ────────────────

-- Drop per-user composite indexes before removing the column
DROP INDEX IF EXISTS idx_cached_pages_space;
DROP INDEX IF EXISTS idx_cached_pages_title;
DROP INDEX IF EXISTS idx_cached_pages_parent;
DROP INDEX IF EXISTS idx_cached_pages_dirty_modified;
DROP INDEX IF EXISTS idx_cached_pages_space_modified;
-- Note: idx_cached_pages_dirty (partial), idx_cached_pages_fts (GIN),
-- and idx_cached_pages_embedding_status do not include user_id and are
-- preserved automatically.

ALTER TABLE cached_pages DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE cached_pages ADD CONSTRAINT cached_pages_confluence_id_key UNIQUE (confluence_id);

-- Recreate indexes without user_id
CREATE INDEX IF NOT EXISTS idx_cached_pages_space         ON cached_pages(space_key);
CREATE INDEX IF NOT EXISTS idx_cached_pages_title         ON cached_pages(title text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_cached_pages_parent        ON cached_pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_cached_pages_dirty_modified ON cached_pages(embedding_dirty, last_modified_at DESC);
CREATE INDEX IF NOT EXISTS idx_cached_pages_space_modified ON cached_pages(space_key, last_modified_at DESC);

-- ── 6. page_embeddings: drop user_id, new unique, add cascade FK ─────────────

DROP INDEX IF EXISTS idx_page_embeddings_user;

ALTER TABLE page_embeddings DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE page_embeddings
  ADD CONSTRAINT page_embeddings_confluence_id_chunk_index_key
    UNIQUE (confluence_id, chunk_index);

-- Cascade FK: deleting a cached_page auto-removes its embeddings
ALTER TABLE page_embeddings
  ADD CONSTRAINT fk_page_embeddings_page
    FOREIGN KEY (confluence_id) REFERENCES cached_pages(confluence_id) ON DELETE CASCADE;

-- ── 7. page_versions: drop user_id, new unique, update index ─────────────────

DROP INDEX IF EXISTS idx_page_versions_page;

ALTER TABLE page_versions DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE page_versions
  ADD CONSTRAINT page_versions_confluence_id_version_number_key
    UNIQUE (confluence_id, version_number);

CREATE INDEX IF NOT EXISTS idx_page_versions_page ON page_versions(confluence_id);

-- ── 8. page_relationships: drop user_id, new unique, update indexes ──────────

DROP INDEX IF EXISTS idx_page_relationships_user;
DROP INDEX IF EXISTS idx_page_relationships_page1;
DROP INDEX IF EXISTS idx_page_relationships_page2;
DROP INDEX IF EXISTS idx_page_relationships_type;

ALTER TABLE page_relationships DROP COLUMN IF EXISTS user_id CASCADE;
ALTER TABLE page_relationships
  ADD CONSTRAINT page_relationships_page_id_1_page_id_2_type_key
    UNIQUE (page_id_1, page_id_2, relationship_type);

CREATE INDEX IF NOT EXISTS idx_page_relationships_page1 ON page_relationships(page_id_1);
CREATE INDEX IF NOT EXISTS idx_page_relationships_page2 ON page_relationships(page_id_2);
CREATE INDEX IF NOT EXISTS idx_page_relationships_type  ON page_relationships(relationship_type);

-- ── 9. Clean up user_settings ────────────────────────────────────────────────
-- selected_spaces is now superseded by user_space_selections.

ALTER TABLE user_settings DROP COLUMN IF EXISTS selected_spaces;
