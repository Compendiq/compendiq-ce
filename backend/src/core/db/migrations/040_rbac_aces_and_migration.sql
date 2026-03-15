-- Migration 040: RBAC access control entries + user_space_selections migration (#355)
--
-- 1. Create access_control_entries table for page/space-level permission overrides.
-- 2. Add inherit_perms column to pages table.
-- 3. Migrate user_space_selections rows -> space_role_assignments with 'editor' role.
-- 4. Drop user_space_selections table.

-- ── 1. Access control entries ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS access_control_entries (
  id SERIAL PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('space', 'page')),
  resource_id INTEGER NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'comment', 'edit', 'delete', 'manage')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (resource_type, resource_id, principal_type, principal_id, permission)
);

CREATE INDEX IF NOT EXISTS idx_ace_resource ON access_control_entries(resource_type, resource_id);

-- ── 2. Add inherit_perms to pages ──────────────────────────────────────────
ALTER TABLE pages ADD COLUMN IF NOT EXISTS inherit_perms BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 3. Migrate user_space_selections -> space_role_assignments ─────────────
-- Convert each user's space selection to an 'editor' role assignment.
-- The editor role is id=3 in the seed data from migration 039.
-- Uses a subquery to find the editor role ID dynamically for safety.
DO $$ BEGIN
  INSERT INTO space_role_assignments (space_key, principal_type, principal_id, role_id)
  SELECT DISTINCT
    uss.space_key,
    'user',
    uss.user_id::TEXT,
    (SELECT id FROM roles WHERE name = 'editor' LIMIT 1)
  FROM user_space_selections uss
  WHERE EXISTS (SELECT 1 FROM roles WHERE name = 'editor')
  ON CONFLICT (space_key, principal_type, principal_id) DO NOTHING;
EXCEPTION WHEN undefined_table THEN
  -- user_space_selections may already have been dropped
  NULL;
END $$;

-- ── 4. Drop user_space_selections ──────────────────────────────────────────
-- The table is no longer needed; all access control is via space_role_assignments.
DROP TABLE IF EXISTS user_space_selections;
