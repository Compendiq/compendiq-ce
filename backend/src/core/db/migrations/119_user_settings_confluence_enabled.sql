-- #1623: per-user Confluence integration toggle.
--
-- Confluence off means STANDALONE MODE, not a degraded product: every feature
-- keeps working on the local corpus, nothing is pushed to or pulled from
-- Confluence, and the spaces/sync surfaces stop asking for credentials. It is
-- deliberately NOT a credential state — `confluence_url` and `confluence_pat`
-- survive a toggle-off, so re-enabling needs no re-paste, and previously
-- synced pages keep their `confluence_id` and their history.
--
-- DEFAULT TRUE: every existing deployment is Confluence-enabled today, and a
-- row that predates this column must keep behaving exactly as it did. The
-- no-row read path in `routes/foundation/settings.ts` emits the same default.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS confluence_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN user_settings.confluence_enabled IS
  'Per-user Confluence integration toggle (#1623). FALSE = standalone mode: no scheduled or manual sync, no upstream push on save/delete, no spaces UI. Credentials are retained, not cleared. Distinct from the derived confluenceConnected, which reports whether credentials exist.';
