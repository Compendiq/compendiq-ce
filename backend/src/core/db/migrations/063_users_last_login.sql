-- Migration 062: users.last_login_at (#307 P0a)
-- Prerequisite for the compliance report's Authentication & Session
-- attestation (Compendiq/compendiq-ee#115 Report 4). Also surfaces
-- useful lifecycle info in the Settings → Users admin page (#304).

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Partial index: "active users who logged in recently" queries are the
-- common lookup pattern.
CREATE INDEX IF NOT EXISTS idx_users_last_login_at
  ON users(last_login_at DESC)
  WHERE last_login_at IS NOT NULL;
