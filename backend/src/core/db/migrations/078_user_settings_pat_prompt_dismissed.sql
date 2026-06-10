-- Migration 078: Confluence-PAT onboarding prompt dismissal (#771)
--
-- The Confluence PAT is per-user (user_settings.confluence_pat) and nothing
-- prompts a freshly-onboarded user to configure one — the setup wizard's
-- Confluence step runs once per deployment and is skippable. The frontend now
-- shows a dismissible banner to users without a PAT; dismissal is persisted
-- server-side so it follows the user across devices and survives refresh.
--
-- NULL  = never dismissed (banner may show while no PAT is configured).
-- NOW() = written by PUT /api/settings { confluencePatPromptDismissed: true }.
--
-- Only the derived boolean (IS NOT NULL) is exposed via GET /api/settings as
-- `confluencePatPromptDismissed` — the timestamp itself stays server-side.

ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS confluence_pat_prompt_dismissed_at TIMESTAMPTZ NULL;
