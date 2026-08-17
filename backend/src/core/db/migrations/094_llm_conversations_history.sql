-- #1361: saved conversations. Three things this table never had:
--   * a page link the pane can render — page_ref replaces the never-written
--     `page_id TEXT` (house style is INTEGER REFERENCES pages(id); SET NULL
--     because deleting a page must not delete history, cf. notifications);
--   * who named the row — title_source: 'question' (trimmed first question),
--     'generated' (LLM auto-title, PR 3), 'user' (rename — never overwritten);
--   * an index for the per-user list, keyset-paged on (updated_at DESC, id DESC).
ALTER TABLE llm_conversations DROP COLUMN page_id;

ALTER TABLE llm_conversations
  ADD COLUMN page_ref INTEGER REFERENCES pages(id) ON DELETE SET NULL,
  ADD COLUMN title_source TEXT NOT NULL DEFAULT 'question'
    CHECK (title_source IN ('question', 'generated', 'user'));

CREATE INDEX IF NOT EXISTS llm_conversations_user_updated_idx
  ON llm_conversations (user_id, updated_at DESC, id DESC);
