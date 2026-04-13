-- AI Safety: seed default guardrail and output-rule settings.
-- Uses ON CONFLICT DO NOTHING so existing values are preserved.
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES
  ('ai_guardrail_no_fabrication', 'IMPORTANT: Do not fabricate, invent, or hallucinate references, sources, URLs, citations, or bibliographic entries. If you do not have a verified source for a claim, say so explicitly. Never generate fake links or made-up author names. Only cite sources that were provided to you in the context.', NOW()),
  ('ai_guardrail_no_fabrication_enabled', 'true', NOW()),
  ('ai_output_rule_strip_references', 'true', NOW()),
  ('ai_output_rule_reference_action', 'flag', NOW())
ON CONFLICT (setting_key) DO NOTHING;
