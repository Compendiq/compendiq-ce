CREATE TABLE IF NOT EXISTS pinned_pages (
  id         SERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id    TEXT NOT NULL,
  pin_order  INT NOT NULL DEFAULT 0,
  pinned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_pinned_pages_user ON pinned_pages(user_id, pin_order);
