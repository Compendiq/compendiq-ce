-- Move LLM configuration to global admin settings.
-- Existing deployments may already have per-user values in user_settings; copy the
-- most recently updated values into admin_settings as a one-time backfill.

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
SELECT 'llm_provider', llm_provider, NOW()
FROM user_settings
WHERE llm_provider IS NOT NULL
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
SELECT 'ollama_model', ollama_model, NOW()
FROM user_settings
WHERE ollama_model IS NOT NULL
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
SELECT 'openai_base_url', openai_base_url, NOW()
FROM user_settings
WHERE openai_base_url IS NOT NULL
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
SELECT 'openai_api_key', openai_api_key, NOW()
FROM user_settings
WHERE openai_api_key IS NOT NULL
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (setting_key) DO NOTHING;

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
SELECT 'openai_model', openai_model, NOW()
FROM user_settings
WHERE openai_model IS NOT NULL
ORDER BY updated_at DESC
LIMIT 1
ON CONFLICT (setting_key) DO NOTHING;
