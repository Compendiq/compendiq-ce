/**
 * #1260 Mode 1 — agreement statistics between two ranked page-id lists.
 *
 * These are pure functions over the two sides' retrieved page ids, knowing
 * nothing about models or retrieval — the same split `metrics.ts` uses, and
 * for the same reason: the arithmetic is unit-testable in CI while the lists
 * themselves come from a run against the real corpus.
 *
 * They measure AGREEMENT, never quality. Without ground truth "the candidate
 * returns different pages" is all a comparison can say; which side is right
 * is Mode 2's judgement data (`embedding_compare_judgements`) or a labelled
 * fixture (#1102). Every consumer must present these numbers that way.
 */

/** One query's two top-K page-id lists. Lists are distinct-by-construction
 *  (page-denominated retrieval dedups), best first. */
export interface AgreementPair {
  live: number[];
  candidate: number[];
}

/**
 * |A ∩ B| / |A ∪ B| over the two id sets. Two empty lists agree (1) — both
 * models returned nothing, which is the production benchmark's convention for
 * its paired overlap too; one empty side is total disagreement (0).
 */
export function jaccardOverlap(a: number[], b: number[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const id of setA) if (setB.has(id)) intersection++;
  return intersection / union.size;
}

/** Whether the top result moved. Both-empty is "no change" (they agree on
 *  nothing); exactly one empty side is a change. */
export function top1Changed(a: number[], b: number[]): boolean {
  if (a.length === 0 && b.length === 0) return false;
  return a[0] !== b[0];
}

/**
 * Rank-biased overlap over the two lists, p = 0.9 by default — the standard
 * top-weighted rank-agreement measure (Webber et al. 2010): the agreement of
 * the depth-d prefixes, averaged with geometrically decaying weight p^(d-1),
 * so a disagreement at rank 1 costs more than one at rank 10.
 *
 * This is the FINITE-PREFIX form, normalised by the maximum achievable at
 * this depth (Σ p^(d-1)) so identical lists score exactly 1 and disjoint
 * lists 0 — the unnormalised infinite form can never reach 1 on a truncated
 * list, which would read as disagreement the run does not have. A shorter
 * list simply stops contributing to the prefix intersection, so a missing
 * tail on one side is penalised at the depths it is missing from.
 *
 * Assumes each list is duplicate-free (page-denominated retrieval dedups by
 * construction).
 */
export function rankBiasedOverlap(a: number[], b: number[], p = 0.9): number {
  const depth = Math.max(a.length, b.length);
  if (depth === 0) return 1;
  const seenA = new Set<number>();
  const seenB = new Set<number>();
  let intersection = 0;
  let weighted = 0;
  let weightTotal = 0;
  let weight = 1; // p^(d-1)
  for (let d = 1; d <= depth; d++) {
    const x = a[d - 1];
    const y = b[d - 1];
    if (x !== undefined && x === y) {
      // Same id enters both prefixes at this depth — one new shared member.
      seenA.add(x);
      seenB.add(y);
      intersection++;
    } else {
      if (x !== undefined) {
        seenA.add(x);
        if (seenB.has(x)) intersection++;
      }
      if (y !== undefined) {
        seenB.add(y);
        if (seenA.has(y)) intersection++;
      }
    }
    weighted += weight * (intersection / d);
    weightTotal += weight;
    weight *= p;
  }
  return weighted / weightTotal;
}

export interface AgreementSummary {
  queryCount: number;
  top1ChangedQueries: number;
  /** 0 when there are no queries — a rate over nothing is reported as none. */
  top1ChangeRate: number;
  meanJaccard: number;
  meanRbo: number;
  /** Queries whose head moved OR whose sets differ — rank-only disagreements
   *  (same set, different order) count, or the list under-reports movement. */
  disagreementCount: number;
}

export function summarizeAgreement(pairs: AgreementPair[]): AgreementSummary {
  let top1ChangedQueries = 0;
  let jaccardTotal = 0;
  let rboTotal = 0;
  let disagreementCount = 0;
  for (const pair of pairs) {
    const headMoved = top1Changed(pair.live, pair.candidate);
    const jaccard = jaccardOverlap(pair.live, pair.candidate);
    if (headMoved) top1ChangedQueries++;
    if (headMoved || jaccard < 1) disagreementCount++;
    jaccardTotal += jaccard;
    rboTotal += rankBiasedOverlap(pair.live, pair.candidate);
  }
  const n = pairs.length;
  return {
    queryCount: n,
    top1ChangedQueries,
    top1ChangeRate: n === 0 ? 0 : top1ChangedQueries / n,
    meanJaccard: n === 0 ? 0 : jaccardTotal / n,
    meanRbo: n === 0 ? 0 : rboTotal / n,
    disagreementCount,
  };
}
