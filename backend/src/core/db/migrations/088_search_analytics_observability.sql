-- #1117 stage 2: retrieval observability columns for search_analytics.
--
-- max_score deliberately keeps its historical meaning (the ordering quantity
-- of whichever mode produced the row: RRF fusion for 'hybrid'/'keyword_fallback',
-- cosine for 'semantic', ts_rank for 'keyword', NULL for 'faceted'). No
-- backfill: on rows created before this migration all three new columns are
-- NULL, which for degraded_reason means "not recorded", not "healthy".
--
--   rerank_score       - max rerank score of the returned set, [0,1]. Written
--                        by the #1104 reranker once it exists; a distinct
--                        column so rerank scores never overload max_score and
--                        historical rows stay comparable.
--   degraded_reason    - NULL = healthy. 'no_embeddings' | 'partial_embeddings'
--                        | 'embedding_failed' today; future degraded paths
--                        (e.g. #1104's rerank bypass) add values here. TEXT
--                        without a CHECK on purpose, matching search_type:
--                        the vocabulary is enforced by the TypeScript union in
--                        rag-service.ts, not the schema.
--   embedding_coverage - embedded fraction of the caller-visible embeddable
--                        corpus at query time, [0,1]. Recorded whenever the
--                        retrieval path measured it, degraded or not, so the
--                        re-embed window (#1116) is visible in analytics.

ALTER TABLE search_analytics
  ADD COLUMN IF NOT EXISTS rerank_score REAL,
  ADD COLUMN IF NOT EXISTS degraded_reason TEXT,
  ADD COLUMN IF NOT EXISTS embedding_coverage REAL;
