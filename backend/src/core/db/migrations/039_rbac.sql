-- Migration 039: RBAC with groups, OIDC-ready (#355)
--
-- Replace simple admin/user model with full role-based access control:
-- roles, groups, per-space permissions. Schema designed for future OIDC integration.
-- The existing users.role column is kept for backward compatibility.

-- Roles table (system + custom)
CREATE TABLE roles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT FALSE,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed system roles
INSERT INTO roles (name, display_name, is_system, permissions) VALUES
  ('system_admin', 'System Administrator', TRUE, ARRAY['read','comment','edit','delete','manage','admin']),
  ('space_admin', 'Space Administrator', TRUE, ARRAY['read','comment','edit','delete','manage']),
  ('editor', 'Editor', TRUE, ARRAY['read','comment','edit','delete']),
  ('commenter', 'Commenter', TRUE, ARRAY['read','comment']),
  ('viewer', 'Viewer', TRUE, ARRAY['read']);

-- Groups
CREATE TABLE groups (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  oidc_claim TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- User -> Group memberships
CREATE TABLE group_memberships (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

-- Space role assignments (who has what role in what space)
CREATE TABLE space_role_assignments (
  id SERIAL PRIMARY KEY,
  space_key TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
  principal_id TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (space_key, principal_type, principal_id)
);

CREATE INDEX idx_space_roles_space ON space_role_assignments(space_key);
CREATE INDEX idx_space_roles_principal ON space_role_assignments(principal_type, principal_id);

-- OIDC-ready columns on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_issuer TEXT;

-- OIDC group -> role mapping (for future OIDC integration)
CREATE TABLE oidc_group_role_mappings (
  id SERIAL PRIMARY KEY,
  oidc_group TEXT NOT NULL,
  role_id INTEGER REFERENCES roles(id),
  space_key TEXT,
  UNIQUE (oidc_group, space_key)
);
