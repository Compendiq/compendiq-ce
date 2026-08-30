-- #1527 — the judgement key gains its admin dimension.
--
-- 101 keyed a judgement by (normalised query hash, live PAIR, candidate PAIR)
-- with NO judge column in the key, so the upsert's `DO UPDATE` physically
-- overwrote `live_page_ids`, `candidate_page_ids` and `judged_by`. Those page
-- id arrays are retrieved through `visiblePagesPredicate` scoped to the admin
-- who started the run, so on a multi-admin instance the second admin's click
-- destroyed the first admin's evidence — unrecoverable, and invisible.
--
-- The one-trial-per-query invariant the McNemar N rests on (one query = one
-- trial, so a per-judge key must not let two admins vote a query twice) moves
-- to the READ path instead of the key: `judgementsForReport` now collapses to
-- `DISTINCT ON (query_hash) ... ORDER BY query_hash, created_at DESC, id DESC`,
-- i.e. exactly one row per query, the most recently judged one, whole. The
-- verdict therefore reports one named judge's visibility scope per trial (never
-- a per-column blend of two admins' arrays), N stays the count of DISTINCT
-- judged queries, and every other judge's row is retained here for audit.
-- `created_at` IS "judged at": the upsert bumps `created_at = NOW()` on every
-- re-judge, and no `judged_at` column exists or is wanted.
--
-- Existing rows: nothing to reconcile. The old key was strictly NARROWER than
-- the new one, so no two surviving rows can collide under the wider key. No
-- backfill, no dedup, no data loss.
--
-- The old constraint's name is the 63-byte (NAMEDATALEN) truncation Postgres
-- generated for the inline UNIQUE in 101 — verified against a live database,
-- not guessed.
ALTER TABLE embedding_compare_judgements
  DROP CONSTRAINT IF EXISTS embedding_compare_judgements_query_hash_live_provider_id_li_key;

-- Deliberately DEFAULT (NULLS DISTINCT), never `UNIQUE NULLS NOT DISTINCT`,
-- even though PG17 offers it: `judged_by` is `REFERENCES users(id) ON DELETE
-- SET NULL` and 101's whole point is that the fixture outlives its author.
-- Under NULLS NOT DISTINCT, deleting the SECOND of two admins who judged the
-- same query would SET NULL that row into the first orphan's key and the
-- `DELETE FROM users` itself would fail with a unique violation — the change
-- would make an admin undeletable. With NULLS DISTINCT the orphaned rows
-- coexist and the read path collapses them anyway.
CREATE UNIQUE INDEX IF NOT EXISTS embedding_compare_judgements_judge_key
  ON embedding_compare_judgements
     (query_hash, live_provider_id, live_model, candidate_provider_id, candidate_model, judged_by);

-- `embedding_compare_judgements_pair_idx` (101) is the read index and is
-- untouched: the collapse still scans by live/candidate pair.
