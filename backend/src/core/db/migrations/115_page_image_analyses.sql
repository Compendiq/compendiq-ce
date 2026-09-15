-- #1615 (ADR-027): the image-analysis store, the `image_analysis` use case and
-- the output-token ceiling. Verbatim ADR-027 "Data model — Migration 115".
--
-- Independent of migration 116 (#1616): neither references the other's
-- objects, so the two packages can merge in either order.
CREATE TABLE IF NOT EXISTS page_image_analyses (
  id               BIGSERIAL    PRIMARY KEY,
  page_id          INTEGER      NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  -- Which attachment store `attachment_key` resolves in; follows the URL
  -- PREFIX in body_html, never `confluence_id IS NULL` (migration 093's note).
  source           TEXT         NOT NULL CHECK (source IN ('confluence', 'local')),
  -- URL-DECODED basename inside that store (the on-disk name).
  attachment_key   TEXT         NOT NULL,
  -- sha256 of the bytes this row describes: the reference revision (D6).
  content_hash     TEXT         NOT NULL,
  format           TEXT         NOT NULL,          -- sniffed: png | jpeg | webp | gif
  width            INTEGER,
  height           INTEGER,
  -- failed_terminal: a deterministic failure class at IMAGE_ANALYSIS_MAX_ATTEMPTS (D13);
  -- left only by the sweep, Retry failed, or new bytes.
  status           TEXT         NOT NULL CHECK (status IN ('pending', 'analyzed', 'failed', 'failed_terminal', 'skipped')),
  skip_reason      TEXT         CHECK (skip_reason IN ('missing', 'unsupported', 'oversized', 'too_large', 'external', 'capped')),
  -- Identity (D5) and constants of the LAST attempt, success or failure; NULL until the first attempt.
  -- The identity columns are the RETAINED identity the batch read (D13 refuses to call when the
  -- resolved pair differs from it), compared — never snapshotted — by the validity predicate.
  provider_id      UUID         REFERENCES llm_providers(id) ON DELETE SET NULL,
  model            TEXT,
  base_url         TEXT,
  identity_hash    TEXT,                           -- sha256(provider_id, model, base_url)
  prompt_version   INTEGER,                        -- IMAGE_ANALYSIS_PROMPT_VERSION at the attempt
  schema_version   INTEGER,                        -- IMAGE_ANALYSIS_SCHEMA_VERSION at the attempt
  -- Non-NULL only when produced under the identity columns beside it (D13): NULLed by a failure
  -- write and by the reconcile when the bytes change; kept across a sweep re-pend so a return to
  -- the same identity is `reused`, not re-analyzed. The chunk text is derived from it at embed time (D8/D9).
  -- ImageAnalysisPayloadV1, validated before write against the bounds of the ceiling
  -- (image_analysis_max_output_tokens) in force at that write; never re-validated on read (D8).
  payload          JSONB,
  analysis_version INTEGER      NOT NULL DEFAULT 0, -- +1 on every successful payload write; a sweep-inverse flip (reused) does not bump it
  -- Failures since the last reset. Five resetters (D13): success, Retry failed, new bytes, the
  -- sweep returning a failed / failed_terminal row whose identity or versions changed, and the
  -- sweep re-opening a 'truncated:<ceiling>' row once the ceiling setting is above <ceiling>.
  attempts         INTEGER      NOT NULL DEFAULT 0,
  -- Due time while failed: the backoff, or NOW() when Retry failed / the sweep return a row (due at
  -- once). NULL for every other status; the CHECK below makes "failed but never due" unrepresentable.
  next_attempt_at  TIMESTAMPTZ,
  -- Failure class (D8), with the number the class needs read back: the HTTP status when one was
  -- received ('rejected:413', 'unavailable:404'), the overrun ceiling for 'truncated:8192', bare
  -- otherwise ('malformed'). Admin-only; never the provider body.
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
-- The worker's question, D13's work predicate: "what is pending, or failed and due?"
CREATE INDEX IF NOT EXISTS page_image_analyses_work_idx
  ON page_image_analyses (next_attempt_at) WHERE status IN ('pending', 'failed');

-- Widen the use-case CHECK, dropping and re-adding with the FULL list, as
-- 097_inline_completion.sql does.
ALTER TABLE llm_usecase_assignments DROP CONSTRAINT IF EXISTS llm_usecase_assignments_usecase_check;
ALTER TABLE llm_usecase_assignments ADD CONSTRAINT llm_usecase_assignments_usecase_check
  CHECK (usecase IN ('chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank',
                     'image_embedding', 'inline_completion', 'image_analysis'));
INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
VALUES ('image_analysis', NULL, NULL) ON CONFLICT (usecase) DO NOTHING;

-- The output-token ceiling (D8): an admin setting, default 8192, [4096, 16384]. NOT part of the
-- retained identity and NOT in any row's cache key; the reader owns the same default for a missing row.
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('image_analysis_max_output_tokens', '8192', NOW()) ON CONFLICT (setting_key) DO NOTHING;
