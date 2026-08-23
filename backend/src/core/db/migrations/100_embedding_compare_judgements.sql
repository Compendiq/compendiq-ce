-- #1260 Mode 2 — side-by-side judgements from the shadow-migration comparison.
--
-- A real corpus has no ground truth. When a Mode 1 comparison shows the two
-- models disagreeing on a query, the admin can look at both result sets and
-- record which answered better. Each judgement is one row here, and the rows
-- are the accumulating fixture: they survive the run, the migration and even
-- the provider row that produced them (models recorded by NAME, no FK to
-- llm_providers, no FK to retrieval_benchmark_runs), so the SECOND model
-- change is cheaper to evaluate than the first.
--
-- One judgement per (normalised query, live PAIR, candidate PAIR): judging
-- the same query again replaces the verdict rather than stacking votes. The
-- PROVIDER is half of each key, not decoration — "the same model name behind
-- a different provider" is a different index producing different page ids, so
-- keying on the names alone would pool one migration's judgements into a
-- later migration's verdict, and would collapse both sides onto one row when
-- a model is re-hosted (live_model = candidate_model).
-- The key carries NO admin dimension, and that is deliberate: one query is
-- one McNemar trial, so keying per judge would let two admins vote the same
-- query twice and inflate both N and the p drawn from it. The consequence on
-- a multi-admin instance is that the LAST judge of a query wins it and the
-- verdict pools every judge's rows. Page-id arrays record what was ON SCREEN
-- when the human judged — they are historical evidence, deliberately not
-- FK-checked against pages that may be deleted later, and they carry the
-- VISIBILITY of the judge who wrote them (the report's retrieval runs through
-- `visiblePagesPredicate` scoped to the admin who started the run), which is
-- why `judged_by` is recorded even though no read filters on it. Accepted for
-- the single-evaluator go/no-go this surface is written for; a multi-
-- evaluator design needs a per-judge key AND an aggregation rule, which is a
-- different feature rather than a wider index. `query_text` is real user data: it stays inside the
-- instance, on admin-only routes.
CREATE TABLE embedding_compare_judgements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- sha256 hex of LOWER(TRIM(query_text)) — the sampler's own dedup key, so
  -- respellings of one query converge on one judgement row.
  query_hash TEXT NOT NULL,
  query_text TEXT NOT NULL,
  live_provider_id TEXT NOT NULL,
  live_model TEXT NOT NULL,
  candidate_provider_id TEXT NOT NULL,
  candidate_model TEXT NOT NULL,
  judged_side TEXT NOT NULL CHECK (judged_side IN ('live', 'candidate', 'neither', 'both')),
  -- The top-K page ids each side showed, best first, at judgement time.
  live_page_ids INTEGER[] NOT NULL,
  candidate_page_ids INTEGER[] NOT NULL,
  -- The fixture outlives its author.
  judged_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (query_hash, live_provider_id, live_model, candidate_provider_id, candidate_model)
);

-- The verdict reads every judgement for one live/candidate pair.
CREATE INDEX embedding_compare_judgements_pair_idx
  ON embedding_compare_judgements (live_provider_id, live_model, candidate_provider_id, candidate_model);
