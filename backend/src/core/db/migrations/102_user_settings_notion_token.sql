-- #1462 / #1459: per-user Notion internal integration token, encrypted at rest
-- with the same AES-256-GCM helpers as confluence_pat (`encryptPat`).
-- Client-visible APIs return hasToken only and never echo this column.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS notion_integration_token TEXT;

COMMENT ON COLUMN user_settings.notion_integration_token IS
  'AES-256-GCM ciphertext of the user Notion internal integration token (#1462). Never returned on client-visible routes.';
