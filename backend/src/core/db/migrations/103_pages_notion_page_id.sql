-- #1465 / #1459: store the Notion page id on a standalone import so a
-- re-run cannot silently duplicate. source stays 'standalone' — there is
-- no pages.source = 'notion'.
ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS notion_page_id TEXT;

COMMENT ON COLUMN pages.notion_page_id IS
  'Notion page id for one-shot import idempotency (#1465). NULL unless this standalone page was imported from Notion. Never a source-type.';

-- Same owner, same Notion id, still live → one local page. Dashes are
-- stripped so "uuid" and "uuid-without-dashes" collide. Trashed rows are
-- excluded so trash-then-reimport is allowed. Restoring the trashed copy
-- while a live import exists is a 409 from POST /pages/:id/restore, not
-- a unique-index 500.
CREATE UNIQUE INDEX IF NOT EXISTS pages_notion_page_id_owner_live_uidx
  ON pages (
    created_by_user_id,
    (lower(replace(notion_page_id, '-', '')))
  )
  WHERE notion_page_id IS NOT NULL AND deleted_at IS NULL;
