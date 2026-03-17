-- Add page_type column to distinguish regular pages from folder-only containers
ALTER TABLE pages ADD COLUMN IF NOT EXISTS page_type TEXT NOT NULL DEFAULT 'page';
ALTER TABLE pages ADD CONSTRAINT pages_page_type_check CHECK (page_type IN ('page', 'folder'));
CREATE INDEX IF NOT EXISTS pages_page_type_idx ON pages(page_type);
