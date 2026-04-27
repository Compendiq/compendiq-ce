-- #352: per-space custom home page.
--
-- Today, `spaces.homepage_id` (TEXT) stores the Confluence-derived home page
-- (whatever `space.homepage.id` was at last sync). We add a separate
-- `custom_home_page_id` (INT FK → pages.id) that admins or space owners can
-- set to override the Confluence default — including pointing at a folder or
-- a standalone page that isn't part of any synced Confluence space.
--
-- Resolution at read time:
--   1. If custom_home_page_id IS NOT NULL → use that page.
--   2. Else fall back to the Confluence-derived homepage_id → pages.id lookup
--      (the existing JOIN in routes/confluence/spaces.ts already does this).
--
-- ON DELETE SET NULL so deleting the configured home page doesn't break the
-- space; resolution falls through to the Confluence default.

ALTER TABLE spaces
  ADD COLUMN IF NOT EXISTS custom_home_page_id INTEGER
    REFERENCES pages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_spaces_custom_home_page_id
  ON spaces(custom_home_page_id)
  WHERE custom_home_page_id IS NOT NULL;
