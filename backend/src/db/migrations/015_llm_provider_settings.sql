-- Add LLM provider configuration columns to user_settings.
-- Each user can independently choose ollama or openai as their LLM provider.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS llm_provider     TEXT NOT NULL DEFAULT 'ollama',
  ADD COLUMN IF NOT EXISTS openai_base_url  TEXT,
  ADD COLUMN IF NOT EXISTS openai_api_key   TEXT,          -- encrypted with AES-256-GCM like confluence_pat
  ADD COLUMN IF NOT EXISTS openai_model     TEXT DEFAULT 'gpt-4o-mini';
