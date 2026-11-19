-- Deferred observations are NOT applied policies or dispatch authority.
-- Keep source identity even before a local article exists. No content/secrets.
CREATE TABLE IF NOT EXISTS ai_policy_deferred_ingestion (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('confluence', 'notion')),
  source_scope TEXT NOT NULL CHECK (length(source_scope) > 0),
  source_id TEXT NOT NULL CHECK (length(source_id) > 0),
  observed_revision TEXT NOT NULL CHECK (length(observed_revision) > 0),
  policy TEXT NOT NULL CHECK (policy IN ('local_only', 'none')),
  observed_by UUID NOT NULL REFERENCES users(id),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  applied_at TIMESTAMPTZ,
  UNIQUE (source, source_scope, source_id, observed_revision, policy)
);
CREATE INDEX IF NOT EXISTS ai_policy_deferred_ingestion_pending
  ON ai_policy_deferred_ingestion (source, source_scope, source_id)
  WHERE applied_at IS NULL;
