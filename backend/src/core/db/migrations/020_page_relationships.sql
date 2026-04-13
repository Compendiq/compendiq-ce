-- Pre-computed page relationships for knowledge graph visualization.
-- Populated after embedding completes; refreshed on re-embed.
CREATE TABLE IF NOT EXISTS page_relationships (
  id                SERIAL PRIMARY KEY,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_id_1         TEXT NOT NULL,
  page_id_2         TEXT NOT NULL,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('embedding_similarity', 'label_overlap', 'explicit_link')),
  score             REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, page_id_1, page_id_2, relationship_type)
);

CREATE INDEX IF NOT EXISTS idx_page_relationships_user ON page_relationships(user_id);
CREATE INDEX IF NOT EXISTS idx_page_relationships_page1 ON page_relationships(user_id, page_id_1);
CREATE INDEX IF NOT EXISTS idx_page_relationships_page2 ON page_relationships(user_id, page_id_2);
CREATE INDEX IF NOT EXISTS idx_page_relationships_type ON page_relationships(user_id, relationship_type);
