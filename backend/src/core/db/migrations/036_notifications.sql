-- Migration 022: Notification center tables (#364)
--
-- Tables:
--   notifications: stores in-app notifications per user
--   notification_preferences: per-user, per-type delivery preferences
--   article_watchers: tracks which users watch which articles

CREATE TABLE notifications (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  link            TEXT,
  source_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  source_page_id  INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  is_read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user_unread ON notifications(user_id, is_read) WHERE is_read = FALSE;
CREATE INDEX idx_notifications_user_date ON notifications(user_id, created_at DESC);

CREATE TABLE notification_preferences (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type     TEXT NOT NULL,
  in_app   BOOLEAN NOT NULL DEFAULT TRUE,
  email    BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, type)
);

CREATE TABLE article_watchers (
  page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (page_id, user_id)
);
