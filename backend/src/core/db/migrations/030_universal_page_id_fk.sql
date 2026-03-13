-- Migration 030: Migrate all dependent tables from confluence_id TEXT → page_id INT
-- Part of #353: Standalone KB Articles
-- The SERIAL `id` on pages becomes the universal foreign key.
-- This eliminates the dual-identifier problem and ensures standalone articles
-- (which have no confluence_id) can have embeddings, versions, etc.

-- ============================================================
-- 1. page_embeddings
-- ============================================================
ALTER TABLE page_embeddings ADD COLUMN page_id INTEGER;

UPDATE page_embeddings pe
SET page_id = p.id
FROM pages p
WHERE pe.confluence_id = p.confluence_id;

-- Delete any orphaned embeddings (no matching page)
DELETE FROM page_embeddings WHERE page_id IS NULL;

ALTER TABLE page_embeddings ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE page_embeddings ADD CONSTRAINT page_embeddings_page_id_fk
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
CREATE INDEX page_embeddings_page_id_idx ON page_embeddings(page_id);

-- Drop old columns
ALTER TABLE page_embeddings DROP COLUMN IF EXISTS confluence_id;
ALTER TABLE page_embeddings DROP COLUMN IF EXISTS space_key;

-- ============================================================
-- 2. page_versions
-- ============================================================
ALTER TABLE page_versions ADD COLUMN page_id INTEGER;

UPDATE page_versions pv
SET page_id = p.id
FROM pages p
WHERE pv.confluence_id = p.confluence_id;

DELETE FROM page_versions WHERE page_id IS NULL;

ALTER TABLE page_versions ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE page_versions ADD CONSTRAINT page_versions_page_id_fk
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;

-- Replace old unique constraint
DROP INDEX IF EXISTS page_versions_confluence_id_version_number_key;
CREATE UNIQUE INDEX page_versions_page_id_version_unique
  ON page_versions(page_id, version_number);

ALTER TABLE page_versions DROP COLUMN IF EXISTS confluence_id;

-- ============================================================
-- 3. llm_improvements
-- ============================================================
ALTER TABLE llm_improvements ADD COLUMN page_id INTEGER;

UPDATE llm_improvements li
SET page_id = p.id
FROM pages p
WHERE li.confluence_id = p.confluence_id;

DELETE FROM llm_improvements WHERE page_id IS NULL;

ALTER TABLE llm_improvements ALTER COLUMN page_id SET NOT NULL;
ALTER TABLE llm_improvements ADD CONSTRAINT llm_improvements_page_id_fk
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE;
CREATE INDEX llm_improvements_page_id_idx ON llm_improvements(page_id);

ALTER TABLE llm_improvements DROP COLUMN IF EXISTS confluence_id;

-- ============================================================
-- 4. pinned_pages
-- ============================================================
-- pinned_pages.page_id is currently TEXT (stores confluence_id)
-- Need to rename, add new INT column, backfill, drop old
ALTER TABLE pinned_pages ADD COLUMN new_page_id INTEGER;

UPDATE pinned_pages pp
SET new_page_id = p.id
FROM pages p
WHERE pp.page_id = p.confluence_id;

DELETE FROM pinned_pages WHERE new_page_id IS NULL;

ALTER TABLE pinned_pages ALTER COLUMN new_page_id SET NOT NULL;
ALTER TABLE pinned_pages ADD CONSTRAINT pinned_pages_page_id_fk
  FOREIGN KEY (new_page_id) REFERENCES pages(id) ON DELETE CASCADE;

-- Drop old TEXT column and rename new one
ALTER TABLE pinned_pages DROP COLUMN page_id;
ALTER TABLE pinned_pages RENAME COLUMN new_page_id TO page_id;

-- Recreate unique constraint if it existed
-- Original was UNIQUE(user_id, page_id) — recreate with new INT column
CREATE UNIQUE INDEX IF NOT EXISTS pinned_pages_user_page_unique
  ON pinned_pages(user_id, page_id);

-- ============================================================
-- 5. page_relationships
-- ============================================================
ALTER TABLE page_relationships ADD COLUMN new_page_id_1 INTEGER;
ALTER TABLE page_relationships ADD COLUMN new_page_id_2 INTEGER;

UPDATE page_relationships pr
SET new_page_id_1 = p1.id
FROM pages p1
WHERE pr.page_id_1 = p1.confluence_id;

UPDATE page_relationships pr
SET new_page_id_2 = p2.id
FROM pages p2
WHERE pr.page_id_2 = p2.confluence_id;

-- Delete orphaned relationships
DELETE FROM page_relationships
WHERE new_page_id_1 IS NULL OR new_page_id_2 IS NULL;

ALTER TABLE page_relationships ALTER COLUMN new_page_id_1 SET NOT NULL;
ALTER TABLE page_relationships ALTER COLUMN new_page_id_2 SET NOT NULL;

ALTER TABLE page_relationships ADD CONSTRAINT page_relationships_page_id_1_fk
  FOREIGN KEY (new_page_id_1) REFERENCES pages(id) ON DELETE CASCADE;
ALTER TABLE page_relationships ADD CONSTRAINT page_relationships_page_id_2_fk
  FOREIGN KEY (new_page_id_2) REFERENCES pages(id) ON DELETE CASCADE;

-- Drop old TEXT columns and rename
ALTER TABLE page_relationships DROP COLUMN page_id_1;
ALTER TABLE page_relationships DROP COLUMN page_id_2;
ALTER TABLE page_relationships RENAME COLUMN new_page_id_1 TO page_id_1;
ALTER TABLE page_relationships RENAME COLUMN new_page_id_2 TO page_id_2;

-- Recreate indexes
CREATE INDEX page_relationships_page_id_1_idx ON page_relationships(page_id_1);
CREATE INDEX page_relationships_page_id_2_idx ON page_relationships(page_id_2);
