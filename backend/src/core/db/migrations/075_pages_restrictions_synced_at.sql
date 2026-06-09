-- Migration 075: per-page restriction-sync high-water mark
-- (Compendiq/compendiq-ce restriction-change detection)
--
-- Records when a page's Confluence read-restrictions were last mirrored into
-- access_control_entries. Used by the audit-log-driven restriction-change
-- detection optimization (EE + RAG_PERMISSION_ENFORCEMENT) to decide whether a
-- page's restriction fetch can be skipped on a given sync run:
--
--   skip iff the audit log shows no `Permissions` change for the page within the
--   confirm window AND restrictions_synced_at falls within that same window.
--
-- NULL = never mirrored (the page is always fetched). The optimization fails
-- safe to a full fetch whenever this is NULL or older than the audit-covered
-- window, so the column carries no correctness risk on its own.

ALTER TABLE pages ADD COLUMN IF NOT EXISTS restrictions_synced_at TIMESTAMPTZ NULL;
