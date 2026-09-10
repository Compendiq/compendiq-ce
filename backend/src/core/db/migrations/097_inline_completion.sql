-- #1417: opt-in, low-latency inline completion for the article editor.
--
-- The use case is deliberately non-inheriting. Inline completion can issue a
-- request after every short typing pause, so a new deployment must not begin
-- sending that traffic to its default chat model merely because it upgraded.
-- The explicit NULL row makes the disabled state visible in the assignment
-- grid and keeps it stable across bootstrap paths.
ALTER TABLE llm_usecase_assignments
  DROP CONSTRAINT IF EXISTS llm_usecase_assignments_usecase_check;
ALTER TABLE llm_usecase_assignments
  ADD CONSTRAINT llm_usecase_assignments_usecase_check
  CHECK (usecase IN (
    'chat', 'summary', 'quality', 'auto_tag', 'embedding', 'rerank',
    'image_embedding', 'inline_completion'
  ));

INSERT INTO llm_usecase_assignments (usecase, provider_id, model)
VALUES ('inline_completion', NULL, NULL)
ON CONFLICT (usecase) DO NOTHING;

-- Personal editor preferences. "Balanced" is the issue's 500 ms default;
-- manual keeps all automatic requests off while retaining the force shortcut.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS inline_completion_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS inline_completion_delay TEXT NOT NULL DEFAULT 'balanced',
  ADD COLUMN IF NOT EXISTS inline_completion_code_only BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_inline_completion_delay_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_inline_completion_delay_check
  CHECK (inline_completion_delay IN ('fast', 'balanced', 'deliberate', 'manual'));
