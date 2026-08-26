-- #1418: optional on-device WebGPU inference + Hunspell EN/DE spell lint.
--
-- The browser model is NOT an ADR-021 use case. Dual opt-in lives as:
--   admin_settings.client_inference_enabled  (default false)
--   user_settings.client_inference_enabled   (default false)
-- Local ghost text when inline_completion is unassigned is a separate
-- personal pref (default true) so air-gapped authors can opt in without a
-- server coder model. Spellcheck is independent of WebGPU.

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('client_inference_enabled', 'false', NOW())
ON CONFLICT (setting_key) DO NOTHING;

ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS client_inference_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS client_inference_without_server BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS client_spellcheck_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS client_spellcheck_languages JSONB NOT NULL DEFAULT '["en_US", "de_DE"]'::jsonb;

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_client_spellcheck_languages_check;

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_client_spellcheck_languages_check
  CHECK (
    jsonb_typeof(client_spellcheck_languages) = 'array'
    AND client_spellcheck_languages <@ '["en_US", "de_DE"]'::jsonb
  );
