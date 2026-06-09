-- Migration 077: real Confluence version metadata on page_versions (#722/#724)
-- edited_at = the version's actual Confluence edit time (version.when)
-- author    = version.by.displayName
-- message   = version.message (change comment)
-- All NULL for local/standalone snapshots, which keep using synced_at.
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ NULL;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS author TEXT NULL;
ALTER TABLE page_versions ADD COLUMN IF NOT EXISTS message TEXT NULL;
