-- Migration 031: Draft-while-published workflow (#362)
-- Adds separate draft content columns so users can edit a draft without
-- affecting the live published version. Publishing atomically swaps
-- draft content into the live columns and clears the draft fields.

ALTER TABLE pages ADD COLUMN draft_body_html TEXT;
ALTER TABLE pages ADD COLUMN draft_body_text TEXT;
ALTER TABLE pages ADD COLUMN draft_body_storage TEXT;
ALTER TABLE pages ADD COLUMN draft_updated_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN draft_updated_by UUID REFERENCES users(id) ON DELETE SET NULL;
