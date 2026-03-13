-- Migration 029: Add standalone article support columns
-- Part of #353: Standalone KB Articles

-- Source discriminator: 'confluence' (synced) or 'standalone' (local)
ALTER TABLE pages ADD COLUMN source TEXT NOT NULL DEFAULT 'confluence';
ALTER TABLE pages ADD CONSTRAINT pages_source_check CHECK (source IN ('confluence', 'standalone'));

-- Owner for standalone articles
ALTER TABLE pages ADD COLUMN created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- Visibility for standalone articles: 'private' (owner-only) or 'shared' (all users)
ALTER TABLE pages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
ALTER TABLE pages ADD CONSTRAINT pages_visibility_check CHECK (visibility IN ('private', 'shared'));

-- Soft delete for standalone articles (NULL = active)
ALTER TABLE pages ADD COLUMN deleted_at TIMESTAMPTZ;

-- Make Confluence-specific columns nullable (standalone articles don't have these)
ALTER TABLE pages ALTER COLUMN confluence_id DROP NOT NULL;
ALTER TABLE pages ALTER COLUMN space_key DROP NOT NULL;

-- Replace absolute unique index with partial unique (Confluence pages only)
DROP INDEX IF EXISTS pages_confluence_id_key;
CREATE UNIQUE INDEX pages_confluence_id_unique
  ON pages(confluence_id) WHERE confluence_id IS NOT NULL;

-- Performance indexes for new access control queries
CREATE INDEX pages_source_idx ON pages(source);
CREATE INDEX pages_visibility_idx ON pages(source, visibility) WHERE source = 'standalone';
CREATE INDEX pages_created_by_idx ON pages(created_by_user_id) WHERE created_by_user_id IS NOT NULL;
CREATE INDEX pages_deleted_at_idx ON pages(deleted_at) WHERE deleted_at IS NOT NULL;
