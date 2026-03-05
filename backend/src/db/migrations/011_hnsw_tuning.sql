-- Ensure HNSW index exists with good defaults for RAG recall.
--
-- The original index (006_page_embeddings.sql) uses ef_construction=64.
-- This migration upgrades to ef_construction=200 for better index quality.
-- Higher ef_construction = slower index build but better recall.
--
-- Runtime ef_search is set per-query via SET LOCAL (see rag-service.ts).
-- Default PostgreSQL ef_search=40; we use 100 for better recall at slight latency cost.
--
-- Tradeoff: ef_search 100 vs 40:
--   - ~2x slower vector search (still <50ms for ~10K embeddings)
--   - ~10-20% better recall on approximate nearest neighbor queries
--   - Worth it for RAG where answer quality matters more than latency

DO $$ BEGIN
  -- Drop old index with lower ef_construction if it exists
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_page_embeddings_vector'
  ) THEN
    DROP INDEX idx_page_embeddings_vector;
  END IF;

  -- Create new HNSW index with improved parameters
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_page_embeddings_hnsw'
  ) THEN
    CREATE INDEX idx_page_embeddings_hnsw ON page_embeddings
      USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 200);
  END IF;
END $$;
