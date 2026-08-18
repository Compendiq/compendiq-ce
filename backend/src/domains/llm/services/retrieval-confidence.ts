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
 *   — score is null, and the THRESHOLD gate must not refuse what it cannot
 *   measure (thresholding every keyword-fallback would turn the degraded
 *   mode into an outage).
 *
 * An empty result set from HEALTHY retrieval scores 0 with basis 'none'; an
 * empty set under a health caveat (vector leg down, corpus unembedded,
 * coverage probe failed) is an outage symptom and scores null.
 *
 * ## "Unmeasurable" no longer means "unrefusable" (owner reversal)
 *
 * This module used to carry the stronger claim that an outage is
 * "unmeasurable, never refusable" — i.e. that a health caveat always
 * ANSWERS. That was a claim about a decision this module does not make, and
 * the owner has reversed the consumer half of it. `null` still means
 * exactly what it meant: there is no number here, so no threshold may be
 * applied to it. What changed is that `/llm/ask` no longer reads the
 * absence of a number as permission to answer. On `degradedReason ===
 * 'embedding_failed'` it refuses the turn outright, without consulting
 * either knob.
 *
 * Why: a keyword-only answer is indistinguishable, to the person reading
 * it, from one the whole index produced — same prose, same source chips, no
 * caveat anywhere. The original argument ("refusing every fallback turns a
 * degraded mode into an outage") weighed availability and left honesty out,
 * and it is weakest exactly during the #1116 re-embed window: the one time
 * this fires at corpus scale, and the one time the user most needs to know
 * that today's answers never saw the semantic index. Both knobs default to
 * 0, so routing the outage case through a threshold would have shipped it
 * dark in most deployments.
 *
 * Two things the reversal deliberately does NOT touch. `no_embeddings` /
 * `partial_embeddings` / `coverage_unknown` still answer: the vector call
 * SUCCEEDED, the corpus is merely thin or unverified, and rows a healthy
 * leg returned are real grounding. And grounding that materialised
 * elsewhere — an assembled sub-page tree, attached documents, web results,
 * a substantive prior turn — stands the refusal down, because none of it
 * depends on the vector index being up.
 */
export interface RetrievalConfidence {
  score: number | null;
  basis: 'rerank' | 'similarity' | 'none';
}

export function computeRetrievalConfidence(
  results: SearchResult[],
  healthCaveat: RetrievalHealthCaveat | null = null,
): RetrievalConfidence {
  // #1107 (via #1273 review B3): a pinned head is a VERIFIED exact-
  // identifier match — the gate must never refuse it. Without this guard
  // the claim held only for NEW pins (vectorScore null): a MOVED pin keeps
  // its measured cosine/rerank score, and pinning could then CAUSE a
  // refusal that the unpinned ranking would not have produced — refusing
  // "the KB has nothing" about a page just verified to exist.
  if (results[0]?.pinned === true) {
    return { score: null, basis: 'none' };
  }
  if (results.length === 0) {
    // Empty is a MEASUREMENT ("the KB has nothing for this") only when
    // retrieval was verifiably healthy. With the vector leg down, the
    // corpus unembedded, or the coverage probe itself failed, empty is an
    // OUTAGE symptom — no number exists for it, so no threshold applies
    // (#1268 review B1 + the probe-failure finding: unverifiable health must
    // not fail toward a false corpus claim). Unrefusable is a separate
    // claim, and no longer true: the route refuses an empty set on its own
    // terms, and refuses `embedding_failed` on health grounds — see the
    // reversal note in the module doc.
    return healthCaveat === null ? { score: 0, basis: 'none' } : { score: null, basis: 'none' };
  }
  // #1115 P3 — a page reached ONLY by the image leg is invisible to this
  // formula, in BOTH directions. The ruling ADR-025 §5 left to P3, and the
  // reason it is an exclusion rather than "image hits carry no vectorScore":
  //
  //  - Its `chunkText` is a stand-in — the page's chunk 0, or its title —
  //    chosen because every stage downstream needs a row, not because anything
  //    matched it. The rerank stage will happily score that text, and a
  //    rerankScore over text no leg matched is a measurement of the wrong
  //    thing. Left in, it could REFUSE a turn: the `rerank` basis needs full
  //    coverage, so one title-only row scoring 0.05 becomes the max nothing,
  //    and, worse, an UNRERANKED image-only row flips `allReranked` false and
  //    silently demotes a fully-reranked set to the similarity basis.
  //  - It also cannot LIFT the number: it carries no `vectorScore`, so it can
  //    only ever displace a measured row from position 0 and turn a
  //    vector-led set into an unmeasurable one.
  //
  // Its own image similarity never appears here at all — it is cross-modal and
  // sits in a different band from text cosines (ADR-025 §8), so no threshold
  // tuned on one has a meaning on the other.
  //
  // The empty-set branch above deliberately reads the ORIGINAL results: a set
  // of nothing but image hits is not an empty corpus, so it must not score 0
  // and be refused as one. It falls through to `basis: 'none'`, score null —
  // the same verdict a keyword-only set gets, and for the same reason.
  const measurable = results.filter((r) => r.imageOnly !== true);
  if (measurable.length === 0) return { score: null, basis: 'none' };
  let maxRerank: number | null = null;
  let maxSim: number | null = null;
  let allReranked = true;
  for (const r of measurable) {
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
  // "Vector-led" is asked of the best MEASURABLE row, not of `results[0]`: an
  // image-only row that fused above a measured vector row is not evidence the
  // vector leg failed to lead, and reading position 0 would let the image leg
  // turn a measurable set unmeasurable by arriving one rank higher.
  if (maxSim !== null && measurable[0]!.vectorScore !== null) {
    return { score: Math.max(0, maxSim), basis: 'similarity' };
  }
  return { score: null, basis: 'none' };
}
