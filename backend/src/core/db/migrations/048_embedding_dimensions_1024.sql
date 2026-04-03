-- Migration 048: Upgrade embedding dimensions from 768 to 1024 for BGE-M3.
--
-- BGE-M3 (via Ollama) produces 1024-dimensional embeddings vs nomic-embed-text's 768.
-- Existing 768-dim embeddings are incompatible and must be cleared.
-- All pages are marked dirty so the background worker re-embeds them.

-- 1. Clear incompatible 768-dim embeddings.
DELETE FROM page_embeddings;

-- 2. Clear derived similarity relationships (recomputed after re-embedding).
DELETE FROM page_relationships WHERE relationship_type = 'embedding_similarity';

-- 3. Drop HNSW index before altering column type.
DROP INDEX IF EXISTS idx_page_embeddings_hnsw;
DROP INDEX IF EXISTS idx_page_embeddings_vector;

-- 4. Change vector dimension from 768 to 1024.
ALTER TABLE page_embeddings ALTER COLUMN embedding TYPE vector(1024);

-- 5. Rebuild HNSW index with same parameters as migration 011.
CREATE INDEX idx_page_embeddings_hnsw ON page_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- 6. Mark all embeddable pages dirty for re-embedding with the new model.
UPDATE pages
SET embedding_dirty = TRUE,
    embedding_status = 'not_embedded',
    embedded_at = NULL,
    embedding_error = NULL
WHERE deleted_at IS NULL
  AND COALESCE(page_type, 'page') != 'folder';

-- 7. Store the expected dimension in admin_settings for runtime validation.
INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('embedding_dimensions', '1024', NOW())
ON CONFLICT (setting_key) DO UPDATE
  SET setting_value = '1024', updated_at = NOW();

-- 8. Update embedding model for existing deployments still on nomic-embed-text.
UPDATE admin_settings
SET setting_value = 'bge-m3', updated_at = NOW()
WHERE setting_key = 'embedding_model'
  AND setting_value = 'nomic-embed-text';
