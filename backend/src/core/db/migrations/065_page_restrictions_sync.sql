-- Migration 065: per-page ACL enforcement sync provenance (Compendiq/compendiq-ee#112)
--
-- The Confluence sync now mirrors per-page view restrictions into
-- `access_control_entries` so the RAG post-filter (rag-service.ts) can gate
-- retrieval via `userCanAccessPage`. Confluence restrictions inherit down
-- the ancestor chain (view restrictions, not edit); the sync walks the
-- chain, computes effective restrictions, and writes ACEs with
-- `source='confluence'`.
--
-- Two columns added:
--
--   source     — differentiates Confluence-synced ACEs from admin-created
--                ('local') ones. Stale-ACE cleanup on re-sync only touches
--                rows with source='confluence', so admin-authored ACEs
--                never get wiped by a sync run.
--
--   synced_at  — timestamps the sync run that wrote the row. Cleanup is
--                "delete rows where source='confluence' AND synced_at <
--                <current_run_started_at>" for each page whose
--                restrictions have been re-evaluated this run.
--
-- No backfill — pre-existing ACEs (all admin-authored) default to
-- source='local' via the column default. Matches the intent of the
-- existing inherit_perms column from migration 040.
--
-- Slot rationale (.plans/112-per-space-rag-acls.md §1.1): the epic §3.7
-- matrix originally allocated `058` to this change, but `058`/`059` are
-- holes in the sequence (never landed); `060`-`064` took the next
-- contiguous block for other v0.4 work. `065` is the next free slot.

ALTER TABLE access_control_entries
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'local'
    CHECK (source IN ('local', 'confluence'));

ALTER TABLE access_control_entries
  ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;

-- Fast sync-cleanup scan: find stale Confluence-sourced rows to delete.
-- Partial index keeps the admin-authored rows (the majority) out of the
-- index — they never have source='confluence', so there's no benefit to
-- carrying them.
CREATE INDEX IF NOT EXISTS idx_ace_confluence_synced_at
  ON access_control_entries (source, synced_at)
  WHERE source = 'confluence';
