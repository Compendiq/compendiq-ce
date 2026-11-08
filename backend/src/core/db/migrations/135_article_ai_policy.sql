-- Article AI policy foundation (SPEC-CORE-001). The ONLY CE migration owner
-- for the article-AI-policy epic. Every statement is idempotent so fresh,
-- upgrade and re-run paths converge on one shape.
--
-- Invariants encoded here:
--   * Unknown locality never authorizes local_only: llm_providers.locality is
--     NOT NULL DEFAULT 'external', and no backfill ever infers 'local'.
--   * An endpoint edit (base_url, api_key, auth_type, verify_ssl) bumps the
--     configuration revision and resets locality to 'external' unless the
--     same UPDATE re-declares it (a fresh locality_declared_at).
--   * Labels at creation can only make a page STRICTER than its default;
--     labels are never consulted afterwards, so tag removal cannot relax.

-- ─── 1. pages.ai_policy + monotonic revision ────────────────────────────────
ALTER TABLE pages ADD COLUMN IF NOT EXISTS ai_policy TEXT NOT NULL DEFAULT 'all';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS ai_policy_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS ai_policy_block_reason TEXT;

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_ai_policy_check;
ALTER TABLE pages ADD CONSTRAINT pages_ai_policy_check
  CHECK (ai_policy IN ('all', 'local_only', 'none'));
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_ai_policy_revision_check;
ALTER TABLE pages ADD CONSTRAINT pages_ai_policy_revision_check
  CHECK (ai_policy_revision >= 0);
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_ai_policy_block_reason_check;
ALTER TABLE pages ADD CONSTRAINT pages_ai_policy_block_reason_check
  CHECK (ai_policy_block_reason IS NULL
         OR ai_policy_block_reason IN ('policy_none', 'provider_not_local', 'policy_changed'));

CREATE OR REPLACE FUNCTION ai_policy_rank(p TEXT) RETURNS INT
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'none' THEN 2 WHEN 'local_only' THEN 1 ELSE 0 END
$$;

-- Same normalizer as core/services/ai-policy.ts `normalizeAiPolicyLabel`.
CREATE OR REPLACE FUNCTION ai_policy_from_labels(labels TEXT[]) RETURNS TEXT
  LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(
    (SELECT p FROM (
       SELECT CASE regexp_replace(lower(btrim(l)), '[\s_:]+', '-', 'g')
                WHEN 'ai-none' THEN 'none'
                WHEN 'no-ai' THEN 'none'
                WHEN 'ai-local-only' THEN 'local_only'
                WHEN 'ai-local' THEN 'local_only'
              END AS p
         FROM unnest(COALESCE(labels, ARRAY[]::TEXT[])) AS l
     ) s WHERE p IS NOT NULL ORDER BY ai_policy_rank(p) DESC LIMIT 1),
    'all')
$$;

-- Creation only: stricter of the inserted policy and the incoming labels.
CREATE OR REPLACE FUNCTION pages_ai_policy_on_insert() RETURNS trigger AS $$
DECLARE
  from_labels TEXT;
BEGIN
  from_labels := ai_policy_from_labels(NEW.labels);
  IF ai_policy_rank(from_labels) > ai_policy_rank(NEW.ai_policy) THEN
    NEW.ai_policy := from_labels;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_ai_policy_insert_trigger ON pages;
CREATE TRIGGER pages_ai_policy_insert_trigger
  BEFORE INSERT ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_ai_policy_on_insert();

-- Revision is monotonic: any policy change must advance it, and it never
-- moves backwards.
CREATE OR REPLACE FUNCTION pages_ai_policy_revision_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.ai_policy_revision < OLD.ai_policy_revision THEN
    RAISE EXCEPTION 'ai_policy_revision must not decrease' USING ERRCODE = '23514';
  END IF;
  IF NEW.ai_policy IS DISTINCT FROM OLD.ai_policy
     AND NEW.ai_policy_revision = OLD.ai_policy_revision THEN
    NEW.ai_policy_revision := OLD.ai_policy_revision + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pages_ai_policy_revision_trigger ON pages;
CREATE TRIGGER pages_ai_policy_revision_trigger
  BEFORE UPDATE OF ai_policy, ai_policy_revision ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_ai_policy_revision_guard();

-- ─── 2. Provider locality + configuration revision ──────────────────────────
ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS locality TEXT NOT NULL DEFAULT 'external';
ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS locality_declared_by UUID
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS locality_declared_at TIMESTAMPTZ;
ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS locality_config_revision BIGINT;
ALTER TABLE llm_providers ADD COLUMN IF NOT EXISTS config_revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_locality_check;
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_locality_check
  CHECK (locality IN ('local', 'external'));
-- A 'local' declaration is meaningful only with its actor time and the
-- configuration revision it was made against.
ALTER TABLE llm_providers DROP CONSTRAINT IF EXISTS llm_providers_local_declared_check;
ALTER TABLE llm_providers ADD CONSTRAINT llm_providers_local_declared_check
  CHECK (locality <> 'local'
         OR (locality_declared_at IS NOT NULL AND locality_config_revision = config_revision));

CREATE OR REPLACE FUNCTION llm_providers_config_revision_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.base_url IS DISTINCT FROM OLD.base_url
     OR NEW.api_key IS DISTINCT FROM OLD.api_key
     OR NEW.auth_type IS DISTINCT FROM OLD.auth_type
     OR NEW.verify_ssl IS DISTINCT FROM OLD.verify_ssl THEN
    NEW.config_revision := OLD.config_revision + 1;
    IF NEW.locality_declared_at IS NOT DISTINCT FROM OLD.locality_declared_at THEN
      -- Not reconfirmed in this statement: the endpoint is unknown again.
      NEW.locality := 'external';
      NEW.locality_declared_by := NULL;
      NEW.locality_declared_at := NULL;
      NEW.locality_config_revision := NULL;
    ELSE
      NEW.locality_config_revision := NEW.config_revision;
    END IF;
  ELSIF NEW.config_revision < OLD.config_revision THEN
    RAISE EXCEPTION 'config_revision must not decrease' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS llm_providers_config_revision_trigger ON llm_providers;
CREATE TRIGGER llm_providers_config_revision_trigger
  BEFORE UPDATE ON llm_providers
  FOR EACH ROW EXECUTE FUNCTION llm_providers_config_revision_guard();

-- ─── 3. policy_blocked in every worker status CHECK ─────────────────────────
-- Status constraints are inline/auto-named and normalize to
-- `col = ANY (ARRAY[...])`; prepend 'policy_blocked' to each array that lacks
-- it, keeping the constraint name. Columns without a CHECK accept it already.
DO $$
DECLARE
  target RECORD;
  con RECORD;
  def TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('pages', 'quality_status'),
      ('pages', 'summary_status'),
      ('pages', 'embedding_status'),
      ('page_image_analyses', 'status')
    ) AS t(tbl, col)
  LOOP
    IF to_regclass(target.tbl) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = target.tbl
         AND column_name = target.col
    ) THEN CONTINUE; END IF;
    FOR con IN
      SELECT c.conname, pg_get_constraintdef(c.oid) AS condef
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
       WHERE c.conrelid = to_regclass(target.tbl) AND c.contype = 'c'
         AND a.attname = target.col
         AND array_length(c.conkey, 1) = 1
    LOOP
      IF con.condef LIKE '%policy_blocked%' OR con.condef NOT LIKE '%ARRAY[%' THEN
        CONTINUE;
      END IF;
      def := regexp_replace(con.condef, 'ARRAY\[', 'ARRAY[''policy_blocked''::text, ');
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.tbl, con.conname);
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I %s', target.tbl, con.conname, def);
    END LOOP;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('page_image_analyses') IS NOT NULL THEN
    ALTER TABLE page_image_analyses ADD COLUMN IF NOT EXISTS ai_policy_block_reason TEXT;
    ALTER TABLE page_image_analyses DROP CONSTRAINT IF EXISTS page_image_analyses_ai_policy_block_reason_check;
    ALTER TABLE page_image_analyses ADD CONSTRAINT page_image_analyses_ai_policy_block_reason_check
      CHECK (ai_policy_block_reason IS NULL
             OR ai_policy_block_reason IN ('policy_none', 'provider_not_local', 'policy_changed'));
  END IF;
END $$;

-- ─── 4. Provenance completeness/version for exchanges and caches ────────────
-- NULL version + complete = FALSE is the honest state for historical rows:
-- their policy/provider provenance was never recorded and is not inferred.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['llm_conversations', 'llm_audit_log', 'page_image_analyses']
  LOOP
    IF to_regclass(tbl) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS ai_provenance_version INT', tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS ai_provenance_complete BOOLEAN NOT NULL DEFAULT FALSE', tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS ai_policy_revision BIGINT', tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS provider_config_revision BIGINT', tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS provider_locality TEXT', tbl);
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', tbl, tbl || '_ai_provenance_check');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ('
      || '(provider_locality IS NULL OR provider_locality IN (''local'', ''external'')) AND '
      || '(NOT ai_provenance_complete OR (ai_provenance_version IS NOT NULL '
      || 'AND provider_config_revision IS NOT NULL AND provider_locality IS NOT NULL)))',
      tbl, tbl || '_ai_provenance_check');
  END LOOP;
END $$;
