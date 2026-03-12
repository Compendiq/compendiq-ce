-- Migration 022: Per-user custom system prompts for AI improvement types
-- Allows users to override default system prompts from the Settings > AI Prompts tab.
-- Stored as JSONB: { "improve_grammar": "...", "improve_structure": "...", ... }
-- NULL keys fall back to the built-in defaults in ollama-service.ts.

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS custom_prompts JSONB NOT NULL DEFAULT '{}';
