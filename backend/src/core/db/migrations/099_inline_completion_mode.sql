-- Personal default for the amount of inline completion shown in the editor.
-- "full" preserves the behaviour users had before this preference existed.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS inline_completion_mode TEXT NOT NULL DEFAULT 'full';

ALTER TABLE user_settings
  DROP CONSTRAINT IF EXISTS user_settings_inline_completion_mode_check;
ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_inline_completion_mode_check
  CHECK (inline_completion_mode IN ('word', 'full'));
