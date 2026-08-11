// Dependency-free leaf module (#1268 review): the confidence formula is the
// one piece of rag-service that route suites need REAL (stubbing it would
// let route and formula drift), and importing it from rag-service forced
// those suites to load rag-service's whole module graph via importOriginal
// spreads. Routes import the formula from here; rag-service re-exports it
// so service-side callers and tests keep their import path.
import type { SearchResult, DegradedReason } from './rag-service.js';

/**
 * Retrieval-health caveat for the #1105 gate: a {@link DegradedReason} from
 * the pipeline, or 'coverage_unknown' when the embedding-coverage probe
 * itself failed — the gate must not claim "the knowledge base has nothing"
 * on health evidence it could not collect.
 */
export type RetrievalHealthCaveat = DegradedReason | 'coverage_unknown';

/**
 * Retrieval confidence for the #1105 refuse gate — computed from RETRIEVAL
 * signals only, never from LLM self-report (the guide's "confident liar"
 * rule). Two bases, never blended (their scales are unrelated):
 *
 * - `rerank`: the #1104 stage ran AND scored every returned row — max
 *   rerank relevance is the best evidence available. Deployment-specific
 *   scale (see SearchResult.rerankScore's comparability caveat). Partial
 *   coverage (a truncating or malformed provider) downgrades to
 *   `similarity`: one measured score must not speak for rows the
 *   cross-encoder never saw.
 * - `similarity`: no full rerank — max cosine over the returned set, and
 *   only when the fused ranking is VECTOR-LED (the top-ranked row carries a
 *   vectorScore). A keyword-led set whose tail happens to contain one
 *   marginal vector chunk is grounded by rows the vector leg never
 *   measured; gating it on that one stray cosine would refuse a set whose
 *   zero-vector twin answers (#1268 review: the partial-embeddings
 *   discontinuity).
 * - `none`: keyword-only or keyword-led results carry NO measurable signal
 *   — score is null, and the gate must not refuse what it cannot measure
 *   (refusing every keyword-fallback would turn the degraded mode into an
 *   outage).
 *
 * An empty result set from HEALTHY retrieval scores 0 with basis 'none' —
 * the one case that DOES refuse when the gate is on, because "no grounding
 * at all" is exactly what the gate exists to say honestly. An empty set
 * under a health caveat (vector leg down, corpus unembedded, coverage probe
 * failed) is an outage symptom, scores null, and never refuses.
 */
export interface RetrievalConfidence {
  score: number | null;
  basis: 'rerank' | 'similarity' | 'none';
}

export function computeRetrievalConfidence(
  results: SearchResult[],
  healthCaveat: RetrievalHealthCaveat | null = null,
): RetrievalConfidence {
  if (results.length === 0) {
    // Empty is a MEASUREMENT ("the KB has nothing for this") only when
    // retrieval was verifiably healthy. With the vector leg down, the
    // corpus unembedded, or the coverage probe itself failed, empty is an
    // OUTAGE symptom — unmeasurable, never refusable (#1268 review B1 + the
    // probe-failure finding: unverifiable health must not fail toward a
    // false corpus claim).
    return healthCaveat === null ? { score: 0, basis: 'none' } : { score: null, basis: 'none' };
  }
  let maxRerank: number | null = null;
  let maxSim: number | null = null;
  let allReranked = true;
  for (const r of results) {
    if (r.rerankScore != null) {
      if (maxRerank === null || r.rerankScore > maxRerank) maxRerank = r.rerankScore;
    } else {
      allReranked = false;
    }
    if (r.vectorScore !== null && (maxSim === null || r.vectorScore > maxSim)) {
      maxSim = r.vectorScore;
    }
  }
  // The rerank basis requires FULL coverage. A provider that returns fewer
  // valid entries than topK (truncation, malformed rows) leaves unscored
  // rows appended after the scored ones, and the one measured score would
  // then speak for evidence the cross-encoder never looked at — a lone 0.12
  // must not refuse over an unscored row carrying cosine 0.88 in the same
  // set. Partial coverage falls through to the similarity basis, which
  // covers every vector-leg row.
  if (maxRerank !== null && allReranked) return { score: maxRerank, basis: 'rerank' };
  // The similarity basis requires a VECTOR-LED set: if the top-ranked row is
  // keyword-only, the strongest evidence feeding the prompt is unmeasured,
  // and the set is treated exactly like its all-keyword twin (see the module
  // doc). Clamp: cosine can run negative (see vectorScore's JSDoc); a
  // threshold in [0,1) must still catch it, so floor at 0.
  if (maxSim !== null && results[0]!.vectorScore !== null) {
    return { score: Math.max(0, maxSim), basis: 'similarity' };
  }
  return { score: null, basis: 'none' };
}
