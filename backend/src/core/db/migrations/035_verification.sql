-- Migration 022: Content verification & staleness system (#360)
--
-- Adds per-article review intervals, named owners, verification tracking,
-- and supporting indexes for the verification health dashboard.

ALTER TABLE pages ADD COLUMN owner_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN review_interval_days INTEGER NOT NULL DEFAULT 90;
ALTER TABLE pages ADD COLUMN next_review_at TIMESTAMPTZ;
ALTER TABLE pages ADD COLUMN verified_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN verified_at TIMESTAMPTZ;

CREATE INDEX pages_next_review_idx ON pages(next_review_at) WHERE next_review_at IS NOT NULL;
CREATE INDEX pages_owner_idx ON pages(owner_id) WHERE owner_id IS NOT NULL;
