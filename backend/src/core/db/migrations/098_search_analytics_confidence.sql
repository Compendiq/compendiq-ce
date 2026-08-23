-- #1284: record the refuse gate's own verdict on the analytics row.
--
-- The Retrieval panel's confidence thresholds have no universal value — the
-- embedding model moves the cosine distribution and the reranker's
-- normalisation moves the relevance one — so the panel told operators to read
-- their own logged `rag.confidence` values before picking a number. That data
-- rode the OTel span and one log line only: nothing in `search_analytics`
-- could answer it. `max_score` is the RRF fusion value and `rerank_score` is
-- the reranker's own scale; neither IS the number the gate compares, and
-- deriving the readout from either would publish a distribution on the wrong
-- scale.
--
-- No backfill, all nullable: on rows created before this migration all three
-- columns are NULL, which means "not recorded" and not "0".
--
--   confidence       - the #1105 gate's score for this search, [0,1], as
--                      `computeRetrievalConfidence` returned it. NULL when the
--                      set carried no measurable signal (basis 'none' on a
--                      keyword-led set, or an outage), which is why the basis
--                      is its own column rather than being inferred from a
--                      number that may legitimately be absent.
--   confidence_basis - 'rerank' | 'similarity' | 'none'. The basis flips per
--                      request (a rerank bypass measures that request on the
--                      cosine scale), so the two thresholds are two
--                      distributions and must never be merged into one.
--                      TEXT without a CHECK on purpose, matching `search_type`
--                      and 088's `degraded_reason`: the vocabulary is enforced
--                      by the TypeScript union in retrieval-confidence.ts.
--   surface          - 'ask' | 'search'. Which product surface produced the
--                      row. The gate is evaluated on /llm/ask only, so the
--                      readout filters on 'ask' and a page search can never
--                      dilute the distribution an operator tunes against.
--                      NULL on historical rows = unknown, never assumed.
--
-- No new index: the readout is one admin-triggered query over a 7-day window,
-- and `idx_search_analytics_created` (013) already bounds that scan. A partial
-- index on (surface, confidence_basis) would be added only if a measurement
-- showed the scan mattered — it has not been measured, so it is not added.

ALTER TABLE search_analytics
  ADD COLUMN IF NOT EXISTS confidence REAL,
  ADD COLUMN IF NOT EXISTS confidence_basis TEXT,
  ADD COLUMN IF NOT EXISTS surface TEXT;
