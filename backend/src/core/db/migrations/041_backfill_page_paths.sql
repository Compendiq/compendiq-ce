-- Migration 041: Backfill materialized path/depth for existing pages (#354)
--
-- Pages synced from Confluence have parent_id set but path/depth were added in
-- migration 038 with defaults (path=NULL, depth=0). This CTE computes the
-- correct values using the parent_id tree.

WITH RECURSIVE tree AS (
  SELECT id, parent_id, '/' || id::text AS path, 0 AS depth
  FROM pages
  WHERE parent_id IS NULL AND deleted_at IS NULL
  UNION ALL
  SELECT p.id, p.parent_id, t.path || '/' || p.id::text, t.depth + 1
  FROM pages p
  JOIN tree t ON p.parent_id = t.id::text
  WHERE p.deleted_at IS NULL
)
UPDATE pages SET path = tree.path, depth = tree.depth
FROM tree
WHERE pages.id = tree.id AND (pages.path IS NULL OR pages.path != tree.path);
