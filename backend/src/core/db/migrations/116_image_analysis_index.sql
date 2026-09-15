-- Migration 116: image analysis in the text index — the #1616 half of ADR-027.
--
-- Independent of migration 115 (`page_image_analyses`, #1615): nothing here
-- references that table, so the two can land in either order. The SQL is the
-- ADR's "Data model" section verbatim, plus comments.
--
-- Runs under `statement_timeout = 0` because `runMigrations` sets it for the
-- whole migration session — the `UPDATE page_embeddings` backfill is one pass
-- over the chunk table (like 049's page rebuild) and must not be cut off by a
-- deployment's PG_STATEMENT_TIMEOUT.

-- The page-level backlog carrier (ADR-027 D4): "re-enumerate this page's
-- images". Raised by every writer that raises image_embedding_dirty (the two
-- coexist until #1618 retires the legacy flag); consumed by the reconcile step,
-- which CLAIMS it before enumerating (D6.2).
ALTER TABLE pages ADD COLUMN IF NOT EXISTS image_analysis_dirty    BOOLEAN NOT NULL DEFAULT FALSE;
-- The revision token embedPage compares before clearing embedding_dirty
-- (D6.3): bumped whenever the page's valid derived set changes.
ALTER TABLE pages ADD COLUMN IF NOT EXISTS image_analysis_revision BIGINT  NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS pages_image_analysis_dirty_idx ON pages (id) WHERE image_analysis_dirty;

-- Per-chunk lexical document (D10), maintained like pages.tsv (049). Populated
-- for EVERY chunk, authored and derived — authored rows are what #1617's chunk
-- resolution needs; derived rows are the lexical union's second half.
ALTER TABLE page_embeddings ADD COLUMN IF NOT EXISTS chunk_tsv tsvector;
CREATE OR REPLACE FUNCTION page_embeddings_tsv_update() RETURNS trigger AS $$
DECLARE lang regconfig;
BEGIN
  SELECT COALESCE((SELECT setting_value::regconfig FROM admin_settings WHERE setting_key = 'fts_language'),
                  'simple'::regconfig) INTO lang;
  NEW.chunk_tsv := to_tsvector(lang, coalesce(NEW.chunk_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_page_embeddings_tsv ON page_embeddings;
CREATE TRIGGER trg_page_embeddings_tsv
  BEFORE INSERT OR UPDATE OF chunk_text ON page_embeddings
  FOR EACH ROW EXECUTE FUNCTION page_embeddings_tsv_update();
UPDATE page_embeddings SET chunk_tsv = to_tsvector(
  COALESCE((SELECT setting_value::regconfig FROM admin_settings WHERE setting_key = 'fts_language'), 'simple'::regconfig),
  coalesce(chunk_text, ''));
ALTER TABLE page_embeddings ALTER COLUMN chunk_tsv SET NOT NULL;
CREATE INDEX IF NOT EXISTS page_embeddings_chunk_tsv_idx ON page_embeddings USING gin (chunk_tsv);
-- The derived-candidate half of the lexical union and the composition read.
CREATE INDEX IF NOT EXISTS page_embeddings_derived_idx
  ON page_embeddings (page_id) WHERE (metadata->>'source') = 'image_analysis';

-- Initial backlog: every non-folder page that references an attachment image.
UPDATE pages SET image_analysis_dirty = TRUE
 WHERE deleted_at IS NULL AND COALESCE(page_type, 'page') <> 'folder'
   AND body_html ~ '/api/(local-)?attachments/';

-- Images per analysis batch (D13): one bounded batch per scheduled cycle and
-- per Run Now, Settings → AI Models → Workers. Default 50, [1, 500].
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('image_analysis_batch_size', '50', NOW()) ON CONFLICT (setting_key) DO NOTHING;
