-- Migration 038: Local spaces + page hierarchy support (#354)
--
-- Adds support for local spaces (created in-app, not synced from Confluence)
-- and materialized path for page hierarchy navigation.

-- Add columns to support local spaces alongside Confluence-synced spaces
ALTER TABLE cached_spaces ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'confluence';
ALTER TABLE cached_spaces ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE cached_spaces ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- description already exists from migration 004, so no ADD COLUMN needed.

DO $$ BEGIN
  ALTER TABLE cached_spaces ADD CONSTRAINT cached_spaces_source_check
    CHECK (source IN ('confluence', 'local'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Add materialized path to pages for hierarchy support
ALTER TABLE pages ADD COLUMN IF NOT EXISTS path TEXT;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

-- Index for subtree queries (text_pattern_ops enables LIKE 'prefix%' lookups)
CREATE INDEX IF NOT EXISTS pages_path_idx ON pages(path text_pattern_ops) WHERE path IS NOT NULL;
CREATE INDEX IF NOT EXISTS pages_sort_idx ON pages(space_key, parent_id, sort_order);
