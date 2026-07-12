-- Migration 082: Materialize per-page average embeddings for indexed kNN.
--
-- Issue #919: computePageRelationships computed AVG(embedding) over the ENTIRE
-- page_embeddings table and then ran an exact, index-less pairwise
-- nearest-neighbour scan on EVERY incremental embedding run. As the corpus
-- grew this blew past the 120s statement_timeout. This migration stores each
-- page's average embedding on the pages row and adds an HNSW index so kNN is
-- served from the index and scoped to the changed pages instead.
--
-- The new column mirrors page_embeddings.embedding's CURRENT type and dimension
-- (a prior dimension change via enqueueReembedAll may have altered it — see
-- embedding-service.ts) so `AVG(embedding)` always assigns cleanly. The HNSW
-- opclass and parameters mirror migration 011/048 (m=16, ef_construction=200)
-- and honour pgvector's per-type dimension limits (vector <= 2000,
-- halfvec <= 4000; larger falls back to a sequential scan, no index).

DO $$
DECLARE
  base_type text;   -- 'vector' | 'halfvec'
  dims      int;    -- pgvector stores the dimension directly in atttypmod
  emb_type  text;   -- e.g. 'vector(1024)'
  opclass   text;
BEGIN
  SELECT t.typname, a.atttypmod, format_type(a.atttypid, a.atttypmod)
    INTO base_type, dims, emb_type
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
   WHERE a.attrelid = 'page_embeddings'::regclass
     AND a.attname = 'embedding'
     AND NOT a.attisdropped;

  -- Add the column with the same type as the embedding column (idempotent).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'pages' AND column_name = 'page_avg_embedding'
  ) THEN
    EXECUTE format('ALTER TABLE pages ADD COLUMN page_avg_embedding %s', emb_type);

    -- One-time backfill so existing deployments keep their similarity graph
    -- immediately, before any re-embed. This is the single full-table AVG the
    -- runtime path no longer has to pay per embedding run.
    EXECUTE '
      UPDATE pages p
         SET page_avg_embedding = sub.avg
        FROM (SELECT page_id, AVG(embedding) AS avg
                FROM page_embeddings
               GROUP BY page_id) sub
       WHERE p.id = sub.page_id';
  END IF;

  -- HNSW index for index-served kNN, within pgvector's per-type dim limits.
  opclass := CASE WHEN base_type = 'halfvec' THEN 'halfvec_cosine_ops' ELSE 'vector_cosine_ops' END;

  IF NOT EXISTS (
       SELECT 1 FROM pg_indexes WHERE indexname = 'idx_pages_page_avg_embedding_hnsw'
     ) AND (
       (base_type = 'vector'  AND dims <= 2000) OR
       (base_type = 'halfvec' AND dims <= 4000)
     ) THEN
    EXECUTE format(
      'CREATE INDEX idx_pages_page_avg_embedding_hnsw ON pages USING hnsw (page_avg_embedding %s) WITH (m = 16, ef_construction = 200)',
      opclass
    );
  END IF;
END $$;
