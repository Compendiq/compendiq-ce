-- Migration 081: persist expected asset filenames per page (#887)
--
-- getSyncOverview previously re-derived each page's expected image/draw.io
-- filenames from raw XHTML on every dashboard request: the overview query
-- materialised the whole corpus's body_storage in one result set and then
-- JSDOM-parsed every body twice per request. Those derived filename sets are a
-- pure function of body_storage + space_key and only change when body_storage
-- changes, so we persist them here and recompute only on churn.
--
-- Columns are nullable on purpose:
--   NULL -> not yet computed (lazy-backfilled on the next overview read)
--   '{}' -> computed, page has no assets
ALTER TABLE pages ADD COLUMN IF NOT EXISTS expected_image_files TEXT[];
ALTER TABLE pages ADD COLUMN IF NOT EXISTS expected_drawio_files TEXT[];

-- ────────────────────────────────────────────────────────────────────────
-- BEFORE UPDATE trigger — invalidate the cached filename sets whenever
-- body_storage changes, so every body_storage writer (sync upsert, editor,
-- AI edits, import, restore, attachments) gets the cache reset with zero
-- changes to those call sites. Resetting to NULL forces a lazy recompute on
-- the next overview read.
--
-- This trigger and migration 060's pages_local_modified_trigger are
-- independent (disjoint columns), so their fire-order does not matter.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION invalidate_pages_expected_assets() RETURNS trigger AS $$
BEGIN
  IF NEW.body_storage IS DISTINCT FROM OLD.body_storage THEN
    NEW.expected_image_files := NULL;
    NEW.expected_drawio_files := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_expected_assets_invalidate ON pages;
CREATE TRIGGER pages_expected_assets_invalidate
  BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION invalidate_pages_expected_assets();
