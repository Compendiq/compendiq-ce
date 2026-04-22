-- Migration 054: multi-LLM-provider tables, seeded from legacy admin_settings.
-- Idempotent: the DO $$ seeding block uses ON CONFLICT DO NOTHING everywhere and
-- only runs when the target tables are empty.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS llm_providers (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL UNIQUE,
  base_url      TEXT        NOT NULL,
  api_key       TEXT        NULL,
  auth_type     TEXT        NOT NULL DEFAULT 'bearer' CHECK (auth_type IN ('bearer','none')),
  verify_ssl    BOOLEAN     NOT NULL DEFAULT TRUE,
  default_model TEXT        NULL,
  is_default    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS llm_providers_one_default
  ON llm_providers (is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS llm_usecase_assignments (
  usecase     TEXT        PRIMARY KEY CHECK (usecase IN ('chat','summary','quality','auto_tag','embedding')),
  provider_id UUID        NULL REFERENCES llm_providers(id) ON DELETE RESTRICT,
  model       TEXT        NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  legacy_llm_provider      TEXT;
  legacy_ollama_model      TEXT;
  legacy_openai_base_url   TEXT;
  legacy_openai_api_key    TEXT;
  legacy_openai_model      TEXT;
  legacy_embedding_model   TEXT;
  openai_id UUID;
  ollama_id UUID;
  default_id UUID;
BEGIN
  -- Read legacy keys (NULL-safe)
  SELECT setting_value INTO legacy_llm_provider     FROM admin_settings WHERE setting_key = 'llm_provider';
  SELECT setting_value INTO legacy_ollama_model     FROM admin_settings WHERE setting_key = 'ollama_model';
  SELECT setting_value INTO legacy_openai_base_url  FROM admin_settings WHERE setting_key = 'openai_base_url';
  SELECT setting_value INTO legacy_openai_api_key   FROM admin_settings WHERE setting_key = 'openai_api_key';
  SELECT setting_value INTO legacy_openai_model     FROM admin_settings WHERE setting_key = 'openai_model';
  SELECT setting_value INTO legacy_embedding_model  FROM admin_settings WHERE setting_key = 'embedding_model';

  -- Seed OpenAI row when any legacy OpenAI signal is present.
  IF legacy_openai_base_url IS NOT NULL OR legacy_openai_api_key IS NOT NULL OR legacy_openai_model IS NOT NULL THEN
    INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
    VALUES (
      'OpenAI',
      -- normalize: ensure /v1 suffix
      CASE
        WHEN legacy_openai_base_url IS NULL THEN 'https://api.openai.com/v1'
        WHEN legacy_openai_base_url LIKE '%/v1' THEN legacy_openai_base_url
        WHEN legacy_openai_base_url LIKE '%/v1/' THEN rtrim(legacy_openai_base_url, '/')
        ELSE rtrim(legacy_openai_base_url, '/') || '/v1'
      END,
      legacy_openai_api_key,
      'bearer',
      TRUE,
      legacy_openai_model
    )
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO openai_id;
  END IF;

  -- Seed Ollama row only when a legacy Ollama signal is present.
  IF legacy_ollama_model IS NOT NULL OR legacy_llm_provider = 'ollama' THEN
    INSERT INTO llm_providers (name, base_url, api_key, auth_type, verify_ssl, default_model)
    VALUES ('Ollama', 'http://localhost:11434/v1', NULL, 'none', TRUE, legacy_ollama_model)
    ON CONFLICT (name) DO NOTHING
    RETURNING id INTO ollama_id;
  END IF;

  -- Set is_default based on legacy llm_provider value.
  IF legacy_llm_provider = 'openai' AND openai_id IS NOT NULL THEN
    UPDATE llm_providers SET is_default = TRUE WHERE id = openai_id;
  ELSIF legacy_llm_provider = 'ollama' AND ollama_id IS NOT NULL THEN
    UPDATE llm_providers SET is_default = TRUE WHERE id = ollama_id;
  END IF;

  -- Seed use-case rows from per-use-case legacy keys.
  SELECT id INTO default_id FROM llm_providers WHERE is_default LIMIT 1;

  INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
  SELECT
    substring(k.setting_key FROM 'llm_usecase_(.+)_provider'),
    CASE k.setting_value
      WHEN 'openai' THEN openai_id
      WHEN 'ollama' THEN ollama_id
    END,
    (SELECT setting_value FROM admin_settings
      WHERE setting_key = 'llm_usecase_' || substring(k.setting_key FROM 'llm_usecase_(.+)_provider') || '_model')
  FROM admin_settings k
  WHERE k.setting_key LIKE 'llm_usecase_%_provider'
    AND substring(k.setting_key FROM 'llm_usecase_(.+)_provider') IN ('chat','summary','quality','auto_tag')
  ON CONFLICT (usecase) DO NOTHING;

  -- Seed embedding use-case row from legacy embedding_model.
  IF legacy_embedding_model IS NOT NULL AND default_id IS NOT NULL THEN
    INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
    VALUES ('embedding', default_id, legacy_embedding_model)
    ON CONFLICT (usecase) DO NOTHING;
  END IF;

  -- Delete the migrated legacy keys.
  DELETE FROM admin_settings WHERE setting_key IN (
    'llm_provider', 'ollama_model', 'openai_base_url', 'openai_api_key', 'openai_model', 'embedding_model',
    'llm_usecase_chat_provider', 'llm_usecase_chat_model',
    'llm_usecase_summary_provider', 'llm_usecase_summary_model',
    'llm_usecase_quality_provider', 'llm_usecase_quality_model',
    'llm_usecase_auto_tag_provider', 'llm_usecase_auto_tag_model'
  );
END $$;
