-- Migration 082: Fix materialized path/depth backfill for Confluence-synced pages (#897)
--
-- Migration 041 walked the page tree with `JOIN tree t ON p.parent_id = t.id::text`,
-- but `parent_id` stores the *parent's Confluence id* for synced pages (only local
-- pages store the parent's internal id). Confluence ids never equal internal SERIAL
-- ids, so synced children never matched and were left with path=NULL / depth=0 — and
-- in the rare case a Confluence id numerically collided with some page's internal id,
-- 041 nested the child under the wrong parent.
--
-- This recomputes path/depth for ALL non-deleted pages using the correct dual-key
-- join: COALESCE(confluence_id, id::text). confluence_id is the materialized-path key
-- for synced pages; id::text is the fallback for local (standalone) pages, whose
-- confluence_id is NULL. Path segments remain internal ids to match runtime writers
-- (pages-crud.ts / local-spaces.ts). Recomputed unconditionally so wrong values written
-- by 041's collision case are overwritten, not just NULLs.

WITH RECURSIVE tree AS (
  SELECT id, parent_id, confluence_id, '/' || id::text AS path, 0 AS depth
  FROM pages
  WHERE parent_id IS NULL AND deleted_at IS NULL
  UNION ALL
  SELECT p.id, p.parent_id, p.confluence_id, t.path || '/' || p.id::text, t.depth + 1
  FROM pages p
  JOIN tree t ON p.parent_id = COALESCE(t.confluence_id, t.id::text)
  WHERE p.deleted_at IS NULL
)
UPDATE pages SET path = tree.path, depth = tree.depth
FROM tree
WHERE pages.id = tree.id
  AND (pages.path IS DISTINCT FROM tree.path OR pages.depth IS DISTINCT FROM tree.depth);
