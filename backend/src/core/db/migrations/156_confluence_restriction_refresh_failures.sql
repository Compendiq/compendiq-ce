-- A failed refresh delays retries with that sync user's credentials only.
CREATE TABLE IF NOT EXISTS confluence_restriction_refresh_failures (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  failed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_confluence_restriction_refresh_failures_page
  ON confluence_restriction_refresh_failures (page_id);
