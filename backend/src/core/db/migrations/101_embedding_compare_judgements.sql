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
-- One judgement per (normalised query, live PAIR, candidate PAIR, JUDGE):
-- the same admin judging the same query again replaces their own verdict
-- rather than stacking votes. The PROVIDER is half of each key, not
-- decoration — "the same model name behind a different provider" is a
-- different index producing different page ids, so keying on the names alone
-- would pool one migration's judgements into a later migration's verdict, and
-- would collapse both sides onto one row when a model is re-hosted
-- (live_model = candidate_model).
-- `judged_by` joined the key in 109 (#1527); it was absent here, and the
-- consequence was that on a multi-admin instance the last judge of a query
-- OVERWROTE the earlier judge's row — including page-id arrays retrieved
-- under a different admin's visibility. One query is still ONE McNemar trial:
-- that invariant lives in the READ path now, where `judgementsForReport`
-- collapses to `DISTINCT ON (query_hash) … ORDER BY query_hash, created_at
-- DESC, id DESC` — the most recently judged row per query, taken WHOLE, so
-- the verdict never blends two admins' arrays and N stays the count of
-- distinct judged queries.
-- Page-id arrays record what was ON SCREEN when the human judged — they are
-- historical evidence, deliberately not FK-checked against pages that may be
-- deleted later, and they carry the VISIBILITY of the judge who wrote them
-- (the report's retrieval runs through `visiblePagesPredicate` scoped to the
-- admin who started the run), which is why `judged_by` is recorded and, since
-- 109, keyed. `query_text` is real user data: it stays inside the
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
  -- SUPERSEDED by 109, which drops this and creates
  -- `embedding_compare_judgements_judge_key` with `judged_by` appended. Left
  -- verbatim: migrations are history, and the runner tracks them by filename.
  UNIQUE (query_hash, live_provider_id, live_model, candidate_provider_id, candidate_model)
);

-- The verdict reads one judgement per query for one live/candidate pair
-- (`DISTINCT ON (query_hash)` since 109); this is the index it scans.
CREATE INDEX embedding_compare_judgements_pair_idx
  ON embedding_compare_judgements (live_provider_id, live_model, candidate_provider_id, candidate_model);
