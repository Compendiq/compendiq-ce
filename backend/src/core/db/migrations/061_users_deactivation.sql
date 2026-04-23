-- Migration 061: soft-deactivation columns on users (#304)
-- Admin CRUD (Settings → Users) needs a way to disable a user without
-- deleting them. Hard delete stays available (DELETE /api/admin/users/:id)
-- but the default recommended flow is deactivate + reactivate so that
-- history (audit_log, pages.created_by_user_id, comments, …) stays intact.

ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_reason TEXT;

-- Partial index: only active-ness checks look at deactivated users, so a
-- covering partial index keeps the common "WHERE deactivated_at IS NULL"
-- queries cheap.
CREATE INDEX IF NOT EXISTS idx_users_deactivated_at
  ON users(deactivated_at)
  WHERE deactivated_at IS NOT NULL;
