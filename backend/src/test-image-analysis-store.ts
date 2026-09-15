import { query } from './core/db/postgres.js';
import { _resetImageAnalysisStorePresenceForTests } from './domains/llm/services/image-analysis-validity.js';

/**
 * Test-only provisioning of `page_image_analyses` (ADR-027 migration 115,
 * #1615) for the #1616 suites while the two packages are on separate
 * branches.
 *
 * The ingestion side's tests need the store to exist; migration 116
 * deliberately does not create it (the ADR gives 115 to #1615 and the two
 * must merge in either order). So a suite calls `ensureImageAnalysisStore()`
 * once: when the table is already there (115 has landed), nothing happens;
 * when it is absent, the ADR's table DDL is applied verbatim and
 * `dropImageAnalysisStoreIfProvisioned()` removes it again at the end of the
 * file, so no later suite — least of all 115's own — sees a table its
 * migration did not create. The `_migrations` ledger is never touched.
 */
let provisioned = false;

const STORE_DDL = `
CREATE TABLE IF NOT EXISTS page_image_analyses (
  id               BIGSERIAL    PRIMARY KEY,
  page_id          INTEGER      NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source           TEXT         NOT NULL CHECK (source IN ('confluence', 'local')),
  attachment_key   TEXT         NOT NULL,
  content_hash     TEXT         NOT NULL,
  format           TEXT         NOT NULL,
  width            INTEGER,
  height           INTEGER,
  status           TEXT         NOT NULL CHECK (status IN ('pending', 'analyzed', 'failed', 'failed_terminal', 'skipped')),
  skip_reason      TEXT         CHECK (skip_reason IN ('missing', 'unsupported', 'oversized', 'too_large', 'external', 'capped')),
  provider_id      UUID         REFERENCES llm_providers(id) ON DELETE SET NULL,
  model            TEXT,
  base_url         TEXT,
  identity_hash    TEXT,
  prompt_version   INTEGER,
  schema_version   INTEGER,
  payload          JSONB,
  analysis_version INTEGER      NOT NULL DEFAULT 0,
  attempts         INTEGER      NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  error            TEXT,
  analyzed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (page_id, source, attachment_key),
  CHECK (status <> 'analyzed'
         OR (payload IS NOT NULL AND identity_hash IS NOT NULL AND prompt_version IS NOT NULL AND schema_version IS NOT NULL)),
  CHECK (status <> 'failed' OR next_attempt_at IS NOT NULL),
  CHECK (status <> 'failed_terminal' OR next_attempt_at IS NULL),
  CHECK (status <> 'skipped' OR skip_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS page_image_analyses_page_id_idx ON page_image_analyses (page_id);
CREATE INDEX IF NOT EXISTS page_image_analyses_work_idx
  ON page_image_analyses (next_attempt_at) WHERE status IN ('pending', 'failed');
`;

/** Whether migration 115's table is present, provisioned or not. */
export async function imageAnalysisStoreExists(): Promise<boolean> {
  const r = await query<{ present: string | null }>(
    `SELECT to_regclass('public.page_image_analyses')::text AS present`,
  );
  return r.rows[0]?.present != null;
}

export async function ensureImageAnalysisStore(): Promise<void> {
  if (await imageAnalysisStoreExists()) return;
  await query(STORE_DDL);
  provisioned = true;
  // Readers cache a negative presence check for a minute; a suite that
  // embedded before provisioning must see the table now.
  _resetImageAnalysisStorePresenceForTests();
}

export async function dropImageAnalysisStoreIfProvisioned(): Promise<void> {
  if (!provisioned) return;
  await query(`DROP TABLE IF EXISTS page_image_analyses`);
  provisioned = false;
  _resetImageAnalysisStorePresenceForTests();
}
