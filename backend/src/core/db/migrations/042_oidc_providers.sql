-- Migration 040: OIDC provider configuration (#370)
--
-- Stores OIDC/SSO provider settings (issuer, client credentials, etc.).
-- The oidc_group_role_mappings and users OIDC columns already exist from 039_rbac.sql.

CREATE TABLE IF NOT EXISTS oidc_providers (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT 'default',
  issuer_url  TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  client_secret_encrypted TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  groups_claim TEXT NOT NULL DEFAULT 'groups',
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name)
);

-- Index for quick lookup of enabled providers
CREATE INDEX IF NOT EXISTS idx_oidc_providers_enabled ON oidc_providers (enabled) WHERE enabled = TRUE;
