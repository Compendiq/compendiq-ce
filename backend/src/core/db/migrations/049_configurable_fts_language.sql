-- Migration 049: Make full-text search language configurable via admin_settings.
--
-- Replaces the STORED generated tsvector column (fixed language) with a
-- trigger-maintained column that reads the configured language at runtime.
-- Default language is 'simple' (language-neutral).

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('fts_language', 'simple', NOW())
ON CONFLICT (setting_key) DO NOTHING;

DROP INDEX IF EXISTS idx_pages_tsv;
ALTER TABLE pages DROP COLUMN IF EXISTS tsv;
ALTER TABLE pages ADD COLUMN tsv tsvector;

CREATE OR REPLACE FUNCTION pages_tsv_update() RETURNS trigger AS $$
DECLARE
  lang regconfig;
BEGIN
  SELECT COALESCE(
    (SELECT setting_value::regconfig FROM admin_settings
     WHERE setting_key = 'fts_language'),
    'simple'::regconfig
  ) INTO lang;
  NEW.tsv := to_tsvector(lang,
    coalesce(NEW.title, '') || ' ' || coalesce(NEW.body_text, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_pages_tsv
  BEFORE INSERT OR UPDATE OF title, body_text ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_tsv_update();

UPDATE pages SET tsv = to_tsvector(
  COALESCE(
    (SELECT setting_value::regconfig FROM admin_settings
     WHERE setting_key = 'fts_language'),
    'simple'::regconfig
  ),
  coalesce(title, '') || ' ' || coalesce(body_text, '')
)
WHERE deleted_at IS NULL;

CREATE INDEX idx_pages_tsv ON pages USING gin(tsv);
