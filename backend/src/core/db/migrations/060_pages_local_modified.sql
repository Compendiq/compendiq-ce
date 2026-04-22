-- Migration 060: track local edits for conflict detection (#305)
-- Prerequisite for Compendiq/compendiq-ee#118 (sync conflict resolution):
-- sync cannot decide whether it is about to clobber a local edit without a
-- column that says "this page has been edited since last_synced."
--
-- ALSO closes a latent CE bug: AI-improved / AI-generated content that was
-- written directly to pages.body_* was silently overwritten on the next sync
-- because sync had no way to detect the write.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS local_modified_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS local_modified_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Partial index: only pages with a pending local edit are interesting.
CREATE INDEX IF NOT EXISTS idx_pages_local_modified_at
  ON pages(local_modified_at)
  WHERE local_modified_at IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────
-- BEFORE UPDATE trigger — belt-and-braces stamp for local edits.
--
-- The explicit write-site code (pages-crud, llm-conversations, draft
-- publish) sets `local_modified_by = $actor` and `local_modified_at =
-- NOW()`. The trigger exists to:
--   (a) fill `local_modified_at` when a caller sets `local_modified_by`
--       but forgets to bump the timestamp (Rule A), and
--   (b) bump the timestamp when a caller re-writes an already-dirty page
--       without touching `local_modified_at` (Rule B).
--
-- Sync / publish paths explicitly pass `local_modified_at = NULL` AND
-- `local_modified_by = NULL` in the same UPDATE to signal "back in sync";
-- neither rule fires because Rule A requires `local_modified_by IS NOT
-- NULL` and Rule B requires `local_modified_at IS NOT NULL`.
-- ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_pages_local_modified() RETURNS trigger AS $$
BEGIN
  IF (NEW.body_html IS DISTINCT FROM OLD.body_html
      OR NEW.body_storage IS DISTINCT FROM OLD.body_storage
      OR NEW.body_text IS DISTINCT FROM OLD.body_text) THEN

    -- Rule A: caller flagged a local edit via `local_modified_by` but
    -- forgot to bump the timestamp — stamp it.
    IF NEW.local_modified_by IS NOT NULL AND NEW.local_modified_at IS NULL THEN
      NEW.local_modified_at := NOW();
    END IF;

    -- Rule B: page was already dirty and the caller re-wrote the body
    -- without refreshing the timestamp — refresh it.
    IF NEW.local_modified_at IS NOT NULL
       AND OLD.local_modified_at IS NOT NULL
       AND NEW.local_modified_at = OLD.local_modified_at THEN
      NEW.local_modified_at := NOW();
    END IF;

    -- Sync / publish paths set BOTH columns to NULL in the same UPDATE;
    -- neither rule fires and the markers stay cleared.
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_local_modified_trigger ON pages;
CREATE TRIGGER pages_local_modified_trigger
  BEFORE UPDATE ON pages
  FOR EACH ROW EXECUTE FUNCTION set_pages_local_modified();
