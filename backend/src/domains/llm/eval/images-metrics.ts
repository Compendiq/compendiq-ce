/**
 * #1115 P5b — the image axis's metrics.
 *
 * `metrics.ts` scores ONE run against a fixture. This axis records TWO runs of
 * every query — image leg off, image leg on — so its unit is a PAIR, and every
 * function here either projects a pair onto the existing scorers or measures
 * something only a pair can answer.
 *
 * Kept beside `metrics.ts` rather than inside it, deliberately: the text gate's
 * scorers are what every recorded baseline in `docs/runbooks/retrieval-eval.md`
 * was computed with, and widening `QueryRun` with image fields would have made
 * every one of them carry an absent image list. Same argument, one layer up,
 * that `ImageFixtureSchema` is a separate schema from `FixtureSchema`.
 *
 * Everything is pure. The paired verdict comes from `pairedSignificance` —
 * McNemar exact, the harness's own gate — never a second test invented here.
 */
import { percentile } from './latency-stats.js';
import {
  meanReciprocalRank,
  pairedBootstrapCi,
  pairedSignificance,
  recallAtK,
  winLoss,
  type PairedSignificance,
  type QueryRun,
} from './metrics.js';

/** Which of a pair's two runs a scorer is reading. */
export type ImageArm = 'off' | 'on';

/**
 * One image the leg matched, as the runner recorded it off `SearchResult.imageHits`.
 *
 * `key` is `page_image_embeddings.attachment_key` — the on-disk filename, which
 * is what the seeder wrote the corpus image under and therefore what a fixture
 * label's `images/<slug>__N.ext` maps to.
 */
export interface ImageHitRecord {
  pageId: number;
  source: 'confluence' | 'local';
  key: string;
  /**
   * Cross-modal cosine. Used HERE only to order hits within one query, exactly
   * as it is used inside the leg — never compared across queries, never
   * thresholded, never reported (ADR-025 §8's calibration warning).
   */
  similarity: number;
}

/** One arm of one query. */
export interface ImageArmRun {
  /** Page ids, best first. */
  retrieved: number[];
  /** Wall clock for this arm's search call; the pair's difference is the leg's cost. */
  ms: number;
  /**
   * Every image hit riding on the returned pages. Always empty on the OFF arm
   * — the runner asserts that rather than assuming it, because a non-empty one
   * would mean `imageLeg: false` did not turn the leg off and the whole pairing
   * is measuring one configuration twice.
   */
  imageHits: ImageHitRecord[];
}

/** Both arms of one fixture label, plus what the label expected. */
export interface ImageQueryPair {
  queryId: string;
  style: 'image' | 'image-negative';
  lang: 'de' | 'en';
  /** Page ids a correct answer must surface. */
  expected: number[];
  /**
   * The label's `expectedImages`, mapped to on-disk attachment keys. EMPTY for
   * an `image-negative`, and that is the point — see `imageHitAtK`.
   */
  expectedImageKeys: string[];
  /**
   * Which arm of this pair ran FIRST — the runner alternates it on the label
   * index (review r1).
   *
   * Recorded rather than assumed because it is the one thing `ms` cannot be
   * read without: whichever arm goes first pays this query's first-touch cost
   * (its heap and index pages, its chunk rows), so a rig that always ran the
   * off arm first would charge all of that to the off arm and publish the
   * difference as the leg's cost, understating it.
   */
  offFirst: boolean;
  off: ImageArmRun;
  on: ImageArmRun;
}

/** Project one arm into the shape `metrics.ts` already scores. */
export function armRuns(pairs: readonly ImageQueryPair[], arm: ImageArm): QueryRun[] {
  return pairs.map((p) => ({ queryId: p.queryId, retrieved: p[arm].retrieved, expected: p.expected }));
}

/** Distinct page ids in the arm's top-K, in rank order. */
function topPages(run: ImageArmRun, k: number): number[] {
  return [...new Set(run.retrieved)].slice(0, k);
}

/**
 * Fraction of the labels that NAME an image whose image is among the on-arm's
 * top-K image hits.
 *
 * Denominated over the labels with a non-empty `expectedImageKeys`, never over
 * the whole fixture: an `image-negative`'s correct image answer is "none", so
 * scoring it as a miss here would fold the leg's precision into a recall
 * number and leave neither readable. The negatives are measured by
 * {@link imageNegativeLeakAtK}, which is their own question.
 *
 * The hits are ordered by SIMILARITY across pages before the cut, not by the
 * order they arrived in. The leg is page-denominated, so its hits reach the
 * runner grouped by page — an arrival-order top-1 would score the first page's
 * worst image ahead of the second page's best one.
 *
 * A label naming several images counts as a hit when ANY of them is found: the
 * fixture lists them best-first as alternatives, not as a set that must all be
 * returned.
 */
export function imageHitAtK(pairs: readonly ImageQueryPair[], k: number): number {
  const scored = pairs.filter((p) => p.expectedImageKeys.length > 0);
  if (scored.length === 0) return 0;
  const hits = scored.filter((p) => {
    const wanted = new Set(p.expectedImageKeys);
    return [...p.on.imageHits]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, k)
      .some((h) => wanted.has(h.key));
  });
  return hits.length / scored.length;
}

/**
 * The leg's false-positive pressure: for an `image-negative` label, the
 * fraction where a page the label does NOT expect entered the top-K **only
 * because of the image leg**.
 *
 * "Only because of" is three conditions, and dropping any one of them measures
 * something else:
 *
 *  - not one of the label's own expected pages (that page is the right answer);
 *  - absent from the OFF arm's top-K (a page the text legs already had is not
 *    the leg's doing, however the ranks moved);
 *  - and the leg actually REACHED it — the page carries an image hit. Adding a
 *    third leg re-ranks the fused set, so a page can drift into the window
 *    without the leg having matched anything on it; counting that would make
 *    this a measurement of RRF's tie-breaking rather than of the leg.
 */
export function imageNegativeLeakAtK(pairs: readonly ImageQueryPair[], k: number): number {
  const negatives = pairs.filter((p) => p.style === 'image-negative');
  if (negatives.length === 0) return 0;
  const leaked = negatives.filter((p) => {
    const expected = new Set(p.expected);
    const before = new Set(topPages(p.off, k));
    const reachedByLeg = new Set(p.on.imageHits.map((h) => h.pageId));
    return topPages(p.on, k).some(
      (pageId) => !expected.has(pageId) && !before.has(pageId) && reachedByLeg.has(pageId),
    );
  });
  return leaked.length / negatives.length;
}

export interface PairedDelta {
  k: number;
  /** Queries in this slice. Printed beside every verdict — a slice of 7 is not a result. */
  n: number;
  /** Recall@k of each arm over this slice. */
  off: number;
  on: number;
  observedDelta: number;
  /** Descriptive bootstrap interval, exactly as the text gate reports it. */
  lower: number;
  upper: number;
  wins: number;
  losses: number;
  ties: number;
  method: PairedSignificance['method'];
  pValue: number | null;
  significant: boolean;
  direction: PairedSignificance['direction'];
}

/**
 * The paired verdict at one K: leg-on against leg-off, over the same queries.
 *
 * Seeded (`1115`, the issue, as the text gate seeds `1102`) so a re-run of the
 * same report produces the same interval — a gate that resamples differently on
 * a re-run can pass and fail the same measurement.
 */
export function pairedDelta(
  pairs: readonly ImageQueryPair[],
  k: number,
  opts: { seed?: number } = {},
): PairedDelta {
  const off = armRuns(pairs, 'off');
  const on = armRuns(pairs, 'on');
  const scoreOne = (run: QueryRun): number => recallAtK([run], k);

  const empty = {
    k,
    n: 0,
    off: 0,
    on: 0,
    observedDelta: 0,
    lower: 0,
    upper: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    method: 'mcnemar-exact' as const,
    pValue: 1,
    significant: false,
    direction: 'none' as const,
  };
  if (pairs.length === 0) return empty;

  const ci = pairedBootstrapCi(off, on, scoreOne, { seed: opts.seed ?? 1115 });
  const table = winLoss(off, on, scoreOne);
  const verdict = pairedSignificance(off, on, scoreOne);
  return {
    k,
    n: pairs.length,
    off: recallAtK(off, k),
    on: recallAtK(on, k),
    observedDelta: ci.observedDelta,
    lower: ci.lower,
    upper: ci.upper,
    wins: table.wins.length,
    losses: table.losses.length,
    ties: table.ties,
    method: verdict.method,
    pValue: verdict.pValue,
    significant: verdict.significant,
    direction: verdict.direction,
  };
}

/** MRR of one arm, through the shared scorer. */
export function armMrr(pairs: readonly ImageQueryPair[], arm: ImageArm): number {
  return meanReciprocalRank(armRuns(pairs, arm));
}

/** Group pairs by an arbitrary key, for the per-style and per-lang verdicts. */
export function partitionPairs<K extends string>(
  pairs: readonly ImageQueryPair[],
  key: (pair: ImageQueryPair) => K,
): Record<K, ImageQueryPair[]> {
  const out = {} as Record<K, ImageQueryPair[]>;
  for (const pair of pairs) {
    const k = key(pair);
    (out[k] ??= []).push(pair);
  }
  return out;
}

export interface QueryCost {
  p50: number;
  p95: number;
}

/**
 * One arm's wall-clock cost, through `latency-stats.ts`'s nearest-rank
 * percentile — the same arithmetic every other latency figure in this
 * directory reports, so the two can be read side by side.
 */
export function queryCostMs(pairs: readonly ImageQueryPair[], arm: ImageArm): QueryCost {
  const samples = pairs.map((p) => p[arm].ms);
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95) };
}
