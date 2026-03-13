-- Migration 022: Reader feedback, page views, and content analytics (#361)
--
-- article_feedback: "Was this helpful?" per-user voting with optional comment
-- page_views: Article view tracking with session deduplication
-- (search_queries not needed — search_analytics from migration 013 already covers that)

CREATE TABLE article_feedback (
  id         SERIAL PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id    UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_helpful BOOLEAN NOT NULL,
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(page_id, user_id)
);

CREATE INDEX idx_article_feedback_page ON article_feedback(page_id);

CREATE TABLE page_views (
  id         SERIAL PRIMARY KEY,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id    UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id TEXT
);

CREATE INDEX idx_page_views_page ON page_views(page_id, viewed_at);
CREATE INDEX idx_page_views_user ON page_views(user_id, viewed_at);
