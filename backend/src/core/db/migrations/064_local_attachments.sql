-- Migration 063: local attachment storage (#302 Gap 4)
--
-- Standalone (non-Confluence) pages had nowhere to persist diagram blobs
-- or pasted images — the existing /api/attachments/:pageId/:filename route
-- requires a Confluence page and filesystem cache keyed by confluence_id.
-- This migration adds a parallel attachment store rooted at the local
-- page's numeric PK so standalone pages can edit draw.io diagrams and
-- paste images the same way Confluence-synced pages can.
--
-- Filesystem layout (see backend/src/core/services/local-attachment-service.ts):
--   ATTACHMENTS_DIR/local/<page_id>/<filename>
-- Separate from the Confluence attachment cache at
--   ATTACHMENTS_DIR/<confluence_id>/<filename>
-- so there's no risk of namespace collision.

CREATE TABLE IF NOT EXISTS local_attachments (
  id              BIGSERIAL PRIMARY KEY,
  page_id         INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  sha256          TEXT NOT NULL,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT local_attachments_page_filename_key UNIQUE (page_id, filename)
);

-- Fast lookup by page (list attachments for a page) — the UNIQUE index
-- above already covers `page_id` as a prefix, but a dedicated BTree makes
-- "orphan scan" queries and JOINs against pages cheap.
CREATE INDEX IF NOT EXISTS idx_local_attachments_page_id
  ON local_attachments(page_id);
