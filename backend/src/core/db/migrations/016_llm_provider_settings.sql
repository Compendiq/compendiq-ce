-- Add LLM provider settings columns to user_settings.
-- Supports switching between Ollama and OpenAI-compatible API providers.
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS llm_provider TEXT NOT NULL DEFAULT 'ollama';
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openai_base_url TEXT;
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openai_api_key TEXT; -- AES-256-GCM encrypted (same as confluence_pat)
ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS openai_model TEXT;
