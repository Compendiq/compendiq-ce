-- Migration 022: Comments & discussions (#356)
--
-- Adds page-level and inline comments with threading, @mentions,
-- resolved/unresolved state, and emoji reactions.

CREATE TABLE comments (
  id          SERIAL PRIMARY KEY,
<<<<<<< HEAD
  page_id     INTEGER NOT NULL REFERENCES cached_pages(id) ON DELETE CASCADE,
=======
  page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
>>>>>>> 46f8d99 (fix: restore missing worktree files + fix cached_pages references (#353))
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES comments(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  anchor_type TEXT CHECK (anchor_type IN ('selection', 'block')),
  anchor_data JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);

CREATE INDEX idx_comments_page_id   ON comments(page_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_comments_parent_id ON comments(parent_id) WHERE deleted_at IS NULL;

CREATE TABLE comment_mentions (
  id          SERIAL PRIMARY KEY,
  comment_id  INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notified_at TIMESTAMPTZ,
  UNIQUE(comment_id, user_id)
);

CREATE INDEX idx_comment_mentions_user ON comment_mentions(user_id);

CREATE TABLE comment_reactions (
  comment_id INTEGER NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (comment_id, user_id, emoji)
);
