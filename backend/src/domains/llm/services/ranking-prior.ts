/**
 * #1111 — a small quality/recency prior over the fused ordering.
 *
 * **This stage ships DISABLED (`RANKING_PRIOR_WEIGHT_DEFAULT = 0`).** The
 * mechanism is here for a future placement decision and for deployments with
 * no reranker; it is not a behaviour we claim improves retrieval today.
 * Measurement on the local rig (275 pages, 164 queries) is why:
 *
 * - **With a rerank provider assigned it is provably ZERO** — byte-identical
 *   results. The rerank pool (30) is wider than the fused candidate set
 *   (10), so the cross-encoder rescores every candidate and the prior's
 *   ordering is discarded wholesale. That is arithmetic, and it is what the
 *   pre-rerank ruling below costs.
 * - **Without rerank it moved two queries: one intended gain and one
 *   REGRESSION**, where a scored page passed the correct unscored one purely
 *   for carrying signals at all. See "what neutral does not promise" below.
 *
 * The issue as filed was explicitly "too thin to be actionable"; these are
 * the decisions that made it implementable, all owner rulings:
 *
 * - **Demote, never exclude.** A low score or a stale timestamp pushes a
 *   page down; it never removes one. Exclusion would be an ACL-adjacent
 *   correctness change — a page silently unreachable with no user-facing
 *   explanation — and a wrong LLM-computed score should not be able to do
 *   that. Demotion is reversible and cannot hide the only answer to a
 *   question.
 * - **Unscored is NEUTRAL.** `quality_score` is LLM-computed with unknown
 *   coverage, and an unscored page is overwhelmingly a *recently synced*
 *   one rather than a bad one. Treating NULL as low would systematically
 *   demote the freshest content in a space — the opposite of the intent.
 *   So the prior applies only where a signal exists.
 *
 *   **What neutral does NOT promise**, and the measured regression above is
 *   this in the act: nothing is *subtracted* for lacking a score, but a
 *   scored page in a near-tie still *gains*, so where scoring coverage is
 *   partial the unscored page is demoted RELATIVELY. That is inherent to an
 *   additive prior over a partly-scored corpus, not a bug in the blend, and
 *   it is the strongest argument for shipping the weight at 0.
 * - **Pre-rerank.** The prior adjusts the fused order the cross-encoder
 *   then judges, so #1104 can overrule it on relevance grounds. Applying it
 *   after rerank would override the epic's biggest measured win.
 *
 * ## What "weak" actually buys ONCE ENABLED, measured against RRF's own scale
 *
 * Everything below is about `RANKING_PRIOR_WEIGHT_TUNED` (0.003), the value
 * an operator sets to turn the stage on. At the shipped default of 0 none of
 * it happens.
 *
 * The scores reaching this stage are RRF fusion values (#1117): ordering
 * only, ~0.0164 for a single-leg hit and ~0.0328 for both. Those two numbers
 * are what the weight is sized against, and the useful statement is about
 * the BOUNDARY between them, not about adjacent ranks:
 *
 * - The gap between "both legs found it" and "one leg did" is ~0.0164. The
 *   maximum prior is `weight` x 1 = 0.003, so a perfectly-scored, freshly
 *   edited page CANNOT climb over a page both legs agreed on. That is the
 *   guarantee, and `applyRankingPrior`'s second test pins it.
 * - WITHIN one of those tiers the gaps are tiny: consecutive ranks differ by
 *   1/(k+r) - 1/(k+r+1) ~ 0.00026 at k=60. So 0.003 spans roughly fourteen
 *   adjacent positions inside a tier. This is NOT a "one or two rank"
 *   nudge, and earlier drafts of this comment said so wrongly.
 *
 * That is the intended shape rather than a flaw: RRF deliberately throws
 * away the retrieval legs' own confidence, so within a tier it asserts an
 * ordering it has almost no evidence for. Those are exactly the positions a
 * secondary signal should be allowed to decide. The boundary it must not
 * cross is leg agreement, and it cannot.
 *
 * It is also why the stage runs PRE-rerank. The cross-encoder re-scores the
 * whole pool afterwards, so wherever rerank is live the prior only chooses
 * which candidates that pool contains — it never survives into the final
 * order on its own. And at the shipped widths it does not even choose that:
 * the pool (30) is wider than the candidate set (10), so it contains all of
 * them however they were ordered. Moving the stage after rerank, or
 * narrowing the pool below the fetch width, would both contradict the
 * pre-rerank ruling and need a fresh decision — they are the open follow-up
 * on #1111, not something to change here.
 */

/** Quality is stored 0-100. */
const QUALITY_MAX = 100;

/**
 * Recency half-life. Documentation ages slowly and a runbook two years old
 * is not twice as wrong as one a year old, so this is deliberately long: at
 * one half-life the recency term is worth half its maximum, and a page must
 * be several years stale before the term approaches zero.
 */
export const RECENCY_HALF_LIFE_DAYS = 365;

/**
 * The SHIPPED weight: 0, i.e. the stage is off. Kept as the default for
 * `applyRankingPrior` so a caller that forgets to pass one gets the identity
 * ordering rather than a silently-live ranking stage. It matches
 * `RAG_RANKING_PRIOR_WEIGHT_DEFAULT` in `admin-settings-service.ts`, which
 * is what a deployment with no `rag_ranking_prior_weight` row resolves to;
 * the two must not drift.
 */
export const RANKING_PRIOR_WEIGHT_DEFAULT = 0;

/**
 * The tuned-but-unshipped weight — what an operator sets
 * `rag_ranking_prior_weight` to when turning the stage on, and the value the
 * measurements in the module header were taken at.
 *
 * Sized against RRF's own scale rather than picked: the gap between "found
 * by both legs" (~0.0328) and "found by one" (~0.0164) is ~0.0164, and this
 * is under a fifth of it, so the prior can never carry a page across leg
 * agreement. See the module header for what it CAN do — reorder freely
 * inside a tier (roughly fourteen adjacent positions), which is where RRF's
 * ordering is least evidenced.
 */
export const RANKING_PRIOR_WEIGHT_TUNED = 0.003;

export interface PriorSignals {
  /** 0-100, or null/undefined when the page was never analysed. */
  qualityScore?: number | null;
  /** Page's last modification time, or null when unknown. */
  lastModifiedAt?: Date | string | null;
}

/**
 * The prior for one page, in [0,1], or `null` when NO signal is available —
 * which the caller must treat as "add nothing", not as zero. Zero would be
 * the worst possible score; null is the absence of a claim.
 */
export function computePrior(signals: PriorSignals, now: number = Date.now()): number | null {
  const terms: number[] = [];

  if (typeof signals.qualityScore === 'number' && Number.isFinite(signals.qualityScore)) {
    terms.push(Math.min(1, Math.max(0, signals.qualityScore / QUALITY_MAX)));
  }

  const raw = signals.lastModifiedAt;
  if (raw !== null && raw !== undefined) {
    const ts = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
    if (Number.isFinite(ts)) {
      const ageDays = Math.max(0, (now - ts) / 86_400_000);
      // Exponential decay: 1 at age 0, 0.5 at one half-life. A FUTURE
      // timestamp clamps to 1 rather than exceeding it — clock skew and
      // bad imports both produce those, and neither should out-rank a
      // genuinely fresh page.
      terms.push(2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS));
    }
  }

  if (terms.length === 0) return null;
  return terms.reduce((a, b) => a + b, 0) / terms.length;
}

/**
 * Apply the prior to a fused ordering. Returns a NEW array; the input is
 * untouched. Pages with no signal keep their fused score exactly, so an
 * unscored page competes on retrieval merit alone — it is neither helped
 * nor punished for lacking a score.
 */
export function applyRankingPrior<T extends { score: number }>(
  results: readonly T[],
  signalsOf: (r: T) => PriorSignals,
  opts: { weight?: number; now?: number } = {},
): T[] {
  const weight = opts.weight ?? RANKING_PRIOR_WEIGHT_DEFAULT;
  if (weight <= 0 || results.length < 2) return [...results];

  return results
    .map((r, index) => {
      const prior = computePrior(signalsOf(r), opts.now);
      return { r, index, adjusted: r.score + (prior === null ? 0 : weight * prior) };
    })
    // Stable on ties by original index: without it, two equally-scored
    // unscored pages could swap order run to run, and the eval would report
    // that churn as a retrieval change.
    .sort((a, b) => (b.adjusted - a.adjusted) || (a.index - b.index))
    .map((x) => x.r);
}
