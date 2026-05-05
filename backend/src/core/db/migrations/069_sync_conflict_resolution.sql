-- Migration 069: sync conflict resolution scaffolding (Compendiq/compendiq-ee#118)
--
-- Adds the data shapes the Enterprise sync-conflict-resolution feature
-- needs to detect and queue conflicts without losing locally-authored
-- edits. Builds on CE #305's `local_modified_at` / `local_modified_by`
-- columns (migration 060) — those supply the "was this page edited
-- locally since the last sync?" signal; this migration supplies the
-- "stash the incoming Confluence version pending admin review" surface.
--
-- Columns added to `pages`:
--   conflict_pending     TRUE while at least one unresolved pending
--                        version exists for this page. Flips back to
--                        FALSE when the queue is drained. Cheap guard
--                        for the sync path — avoids a per-page
--                        `SELECT EXISTS` against `pending_sync_versions`.
--   conflict_detected_at timestamp of the most recent conflict detection.
--                        Exposed in the admin conflicts list for age
--                        sorting.
--
-- Table `pending_sync_versions`:
--   Append-only queue of Confluence-side versions that the sync path
--   chose NOT to apply because a local edit was newer. Each row carries
--   the full Confluence content (body_storage + body_html + body_text)
--   so the conflict-resolution UI can diff against the live Compendiq
--   page without a second Confluence round-trip.
--
--   The `sync_run_id` column pairs rows from a single sync run so the
--   retention sweep / operator report can reason about "the 12 conflicts
--   detected during yesterday's 14:00 sync" as a unit.
--
-- Retention: `data-retention-service.ts` prunes rows older than
-- `pending_sync_versions_retention_days` (admin_settings key, default 90)
-- to keep the table bounded. Resolution deletes the row immediately, so
-- the retention sweep only catches genuinely-abandoned conflicts.
--
-- Slot rationale: plan .plans/118-sync-conflict-resolution.md §3 named
-- `ce/063` — stale. CE head is now at 068 after EE #112's 065 and EE
-- #114's 066/067/068. Next free slot is 069.

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS conflict_pending BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE pages
  ADD COLUMN IF NOT EXISTS conflict_detected_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS pending_sync_versions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id            INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  confluence_version INTEGER NOT NULL,
  body_storage       TEXT NOT NULL,
  body_html          TEXT NOT NULL,
  body_text          TEXT NOT NULL,
  sync_run_id        UUID NOT NULL,
  detected_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_sync_versions_page_id
  ON pending_sync_versions (page_id);

CREATE INDEX IF NOT EXISTS idx_pending_sync_versions_detected_at
  ON pending_sync_versions (detected_at);
