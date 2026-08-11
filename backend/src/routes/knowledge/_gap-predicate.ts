import { rrfWorstCase } from '../../domains/llm/services/rag-service.js';

/**
 * Fusion-scale knowledge-gap threshold — DERIVED, never restated (#1269
 * code-review layer): the midpoint between "top page found by ONE leg"
 * (rrfWorstCase(false) = 1/61) and "found by BOTH" (rrfWorstCase(true) =
 * 2/61) on the #1106 bounded best-chunk-only fusion scale. A fusion-row
 * gap therefore means "the best hit was single-leg only". If RRF k or the
 * fusion rule is ever retuned, this moves with rrfWorstCase instead of
 * gating on a stale scale — the exact prose-drift failure mode the #1106
 * bounds history ("wrong three times") exists to warn about.
 */
export const GAP_FUSION_THRESHOLD = (rrfWorstCase(false) + rrfWorstCase(true)) / 2;

/**
 * The shared knowledge-gap WHERE fragment for `search_analytics` rows —
 * ONE definition for both consumers (analytics.ts, content-analytics.ts)
 * and for the test that pins it, so the routes and the pin cannot drift.
 *
 * max_score carries a DIFFERENT unit per search_type (the pre-existing
 * defect 09-flow's score table documents), so the low-score half must be
 * per-unit (#1269 review m13 + follow-ups):
 * - hybrid / hybrid_rerank: bounded fusion scale — gap when below
 *   GAP_FUSION_THRESHOLD ("best hit single-leg only"). The old flat 0.3
 *   would classify EVERY fusion row as a gap. Rows persisted before the
 *   #1106 deploy carry the summed scale and are imprecise under any
 *   constant; the 09-flow caveat applies.
 * - keyword_fallback: excluded from the score half entirely — its keyword
 *   leg never sums, so its fusion max (~1/61) sits under any threshold in
 *   both scale eras, and an embedding outage would flood this report with
 *   rows that signal the OUTAGE, not missing content. `result_count = 0`
 *   still catches fallback queries that found nothing.
 * - semantic (cosine) / keyword (raw ts_rank): keep the 0.3 the reports
 *   were tuned against.
 * A NULL search_type falls to the ELSE arm; `faceted` rows carry a NULL
 * max_score and are excluded by SQL NULL semantics, as before.
 */
export const KNOWLEDGE_GAP_PREDICATE_SQL = `(result_count = 0 OR CASE
           WHEN search_type IN ('hybrid', 'hybrid_rerank') THEN max_score < ${GAP_FUSION_THRESHOLD}
           WHEN search_type = 'keyword_fallback' THEN FALSE
           ELSE max_score < 0.3
         END)`;

/**
 * The gap report's average score column, restricted to rows sharing the
 * fusion unit (#1269 code-review layer, finding 3): a bare AVG(max_score)
 * mixed cosines, ts_rank and fusion values into one unitless number — the
 * incomparability the predicate above exists to respect. Groups with no
 * fusion rows report NULL, which the wire type always allowed.
 */
export const GAP_AVG_MAX_SCORE_SQL =
  `AVG(max_score) FILTER (WHERE search_type IN ('hybrid', 'hybrid_rerank', 'keyword_fallback')) AS avg_max_score`;
