/**
 * #1102 — retrieval quality metrics.
 *
 * Pure functions over recorded runs, deliberately knowing nothing about the
 * retrieval stack: the eval runner records what came back, this scores it.
 * That split is what lets the metric implementation be unit-tested in CI
 * without an embedding model, while the quality numbers themselves come from
 * the dedicated job that has one.
 *
 * The fixture unit is the **page id** throughout, because RRF already dedups
 * to one entry per page (`rag-service.ts`) and because pinning it that way is
 * what keeps #1106's page-merge from silently invalidating the fixture.
 */

export interface QueryRun {
  /** Stable identity, used to pair a baseline run against a candidate run. */
  queryId: string;
  /** Retrieved page ids, best first. */
  retrieved: number[];
  /** Page ids a correct answer must surface. */
  expected: number[];
}

/**
 * Mean over queries of |top-K ∩ expected| / |expected|.
 *
 * Averaged per query, not pooled over hits: pooling lets a fixture with many
 * expected pages dominate the score, so one easy query could mask a hard one.
 * With the single-expected-page fixtures this harness mostly carries, the
 * per-query score is 0 or 1 and the mean moves in 1/N increments — which is
 * the arithmetic behind the issue's N ≥ 100 requirement.
 */
export function recallAtK(runs: QueryRun[], k: number): number {
  if (runs.length === 0) return 0;
  const total = runs.reduce((sum, r) => {
    if (r.expected.length === 0) return sum;
    // Dedup BEFORE truncating: a run recorded at chunk level can repeat a
    // page, and a repeat inside the cut would otherwise consume a top-K slot
    // and push a genuine result out of the window being scored.
    const topK = new Set([...new Set(r.retrieved)].slice(0, k));
    const hits = new Set(r.expected.filter((id) => topK.has(id)));
    return sum + hits.size / new Set(r.expected).size;
  }, 0);
  return total / runs.length;
}

/** Mean of 1/rank of the FIRST expected page; 0 for a query that never finds one. */
export function meanReciprocalRank(runs: QueryRun[]): number {
  if (runs.length === 0) return 0;
  const total = runs.reduce((sum, r) => {
    const expected = new Set(r.expected);
    const rank = r.retrieved.findIndex((id) => expected.has(id));
    return sum + (rank === -1 ? 0 : 1 / (rank + 1));
  }, 0);
  return total / runs.length;
}

export interface BootstrapCi {
  observedDelta: number;
  lower: number;
  upper: number;
  /**
   * DESCRIPTIVE ONLY — not the gate. `pairedSignificance` replaced it (review
   * r1): with binary per-query scores this fires at four discordant pairs for
   * ANY fixture size, at a true two-sided p of 0.125.
   */
  excludesZero: boolean;
  iterations: number;
  confidence: number;
}

/**
 * Paired bootstrap over per-query deltas — the gate that replaces
 * "regressions > 0.01 fail", which is unrepresentable below N=100 because the
 * mean can only move in 1/N steps.
 *
 * Paired, because the same queries run on both sides: resampling queries
 * independently would add between-query variance that the comparison does not
 * actually have, widening the interval and hiding real effects.
 */
export function pairedBootstrapCi(
  baseline: QueryRun[],
  candidate: QueryRun[],
  scoreOne: (run: QueryRun) => number,
  opts: { seed: number; iterations?: number; confidence?: number },
): BootstrapCi {
  const iterations = opts.iterations ?? 2000;
  const confidence = opts.confidence ?? 0.95;

  const byId = new Map(candidate.map((r) => [r.queryId, r]));
  if (byId.size !== baseline.length || baseline.some((r) => !byId.has(r.queryId))) {
    throw new Error('Bootstrap needs the same queries on both sides — baseline and candidate differ');
  }

  const deltas = baseline.map((b) => scoreOne(byId.get(b.queryId)!) - scoreOne(b));
  const observedDelta = mean(deltas);

  const random = mulberry32(opts.seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < deltas.length; j++) {
      sum += deltas[Math.floor(random() * deltas.length)]!;
    }
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);

  const tail = (1 - confidence) / 2;
  const lower = quantile(means, tail);
  const upper = quantile(means, 1 - tail);
  return {
    observedDelta,
    lower,
    upper,
    excludesZero: (lower > 0 && upper > 0) || (lower < 0 && upper < 0),
    iterations,
    confidence,
  };
}

export interface PairedSignificance {
  method: 'mcnemar-exact' | 'bootstrap-percentile';
  /** Queries the candidate fixed / broke. Only these carry information. */
  wins: number;
  losses: number;
  /** Exact two-sided p under the sign null, for the McNemar path. */
  pValue: number | null;
  significant: boolean;
  direction: 'improvement' | 'regression' | 'none';
}

/**
 * The decision rule. Which test applies depends on the scores, not on taste.
 *
 * Every fixture label today names exactly one expected page, so per-query
 * Recall@K is 0 or 1 and each paired delta is in {-1, 0, +1}. In that discrete
 * regime the percentile bootstrap has no coverage guarantee: with unanimous
 * deltas every resample mean sits on one side of zero, so `excludesZero`
 * reduces to P(a resample draws none of the m moved queries) ≈ e^-m, which
 * crosses the 2.5% tail at m ≥ 4 **for any N** — it fired on 4 flipped
 * queries out of 144 and would fire on 4 out of 10,000, at an actual
 * two-sided p of 0.125 (review r1). Growing the fixture did not help; it only
 * shrank the delta printed beside the same verdict.
 *
 * For binary outcomes the correct paired test is McNemar's, exact: only the
 * discordant pairs carry information, and under the null each is a coin flip.
 * The bootstrap interval is still reported, as a description of effect size.
 */
export function pairedSignificance(
  baseline: QueryRun[],
  candidate: QueryRun[],
  scoreOne: (run: QueryRun) => number,
): PairedSignificance {
  const byId = new Map(candidate.map((r) => [r.queryId, r]));
  let wins = 0;
  let losses = 0;
  let binary = true;

  for (const b of baseline) {
    const c = byId.get(b.queryId);
    if (!c) continue;
    const before = scoreOne(b);
    const after = scoreOne(c);
    if (before !== 0 && before !== 1) binary = false;
    if (after !== 0 && after !== 1) binary = false;
    if (after > before) wins++;
    else if (after < before) losses++;
  }

  if (!binary) {
    // Graded scores (a fixture with multi-page expectations) are outside
    // McNemar's assumptions. The caller REPORTS and does not gate — it does
    // not fall back to the interval as a decision rule, which is what this
    // comment used to imply (review r4).
    return { method: 'bootstrap-percentile', wins, losses, pValue: null, significant: false, direction: 'none' };
  }

  const pValue = mcnemarExactTwoSided(wins, losses);
  const significant = pValue < 0.05 && wins !== losses;
  return {
    method: 'mcnemar-exact',
    wins,
    losses,
    pValue,
    significant,
    direction: !significant ? 'none' : wins > losses ? 'improvement' : 'regression',
  };
}

/**
 * Exact two-sided sign test over the discordant pairs: 2·P(X ≤ min(w,l)) for
 * X ~ Binomial(w+l, ½), clamped to 1. With 4 discordant pairs all one way
 * this is 0.125 — which is why the bootstrap's verdict at m=4 was wrong, and
 * why no honest test can call 4 flipped queries significant.
 */
export function mcnemarExactTwoSided(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);

  // Two numeric failure modes, both silent (review r2). Summing raw C(n,i)
  // over 2**n overflows to NaN past ~1024 pairs, and building the pmf from
  // 2**-n instead UNDERFLOWS to zero past ~1070 — either way `p < 0.05`
  // quietly flips and the gate disappears exactly when the evidence is
  // largest. Today's fixture caps n at 144; a bigger one is the documented
  // direction of travel, so neither ceiling is left in place.
  if (n <= 1000) {
    // Exact, built incrementally: pmf(0) = 2^-n, pmf(i) = pmf(i-1)·(n-i+1)/i.
    let pmf = Math.pow(2, -n);
    let cumulative = pmf;
    for (let i = 1; i <= k; i++) {
      pmf = (pmf * (n - i + 1)) / i;
      cumulative += pmf;
    }
    return Math.min(1, 2 * cumulative);
  }

  // Beyond that the normal approximation with a continuity correction is what
  // McNemar's test conventionally uses anyway, and it agrees with the exact
  // form to several decimals well before this boundary.
  const z = Math.max(0, Math.abs(wins - losses) - 1) / Math.sqrt(n);
  return Math.min(1, 2 * (1 - standardNormalCdf(z)));
}

/** Abramowitz & Stegun 7.1.26 — accurate to ~1.5e-7, far tighter than any p we compare against 0.05. */
function standardNormalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

export interface WinLossTable {
  wins: Array<{ queryId: string; baseline: number; candidate: number }>;
  losses: Array<{ queryId: string; baseline: number; candidate: number }>;
  ties: number;
}

/**
 * Per-query movement. Reported alongside the mean because the mean hides it:
 * a change that wins two queries and loses two reads as "no change" in
 * aggregate while having moved four results.
 */
export function winLoss(
  baseline: QueryRun[],
  candidate: QueryRun[],
  scoreOne: (run: QueryRun) => number,
): WinLossTable {
  const byId = new Map(candidate.map((r) => [r.queryId, r]));
  const table: WinLossTable = { wins: [], losses: [], ties: 0 };
  for (const b of baseline) {
    const c = byId.get(b.queryId);
    if (!c) continue;
    const before = scoreOne(b);
    const after = scoreOne(c);
    if (after > before) table.wins.push({ queryId: b.queryId, baseline: before, candidate: after });
    else if (after < before) table.losses.push({ queryId: b.queryId, baseline: before, candidate: after });
    else table.ties++;
  }
  return table;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * Seeded PRNG. The gate must be reproducible: a CI that resamples differently
 * on a re-run can pass and fail the same diff, which is worse than no gate.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
