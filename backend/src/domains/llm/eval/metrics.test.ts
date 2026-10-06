import { describe, expect, it } from 'vitest';
import {
  recallAtK, meanReciprocalRank, pairedBootstrapCi, pairedSignificance, mcnemarExactTwoSided, winLoss,
  clusterBootstrapCi, nonInferiorityVerdict, safetyVerdict, pilotDiscordance, mcnemarPower,
  type QueryRun, type ClusteredDelta, type ClusterBootstrapCi,
} from './metrics.js';

// #1102 — the scoring half of the eval harness. Pure functions over recorded
// runs, so these hold whatever the retrieval stack did. Every expectation is
// hand-computed in the comment beside it: a metric whose test copies the
// implementation's arithmetic proves nothing.

function run(id: string, retrieved: number[], expected: number[]): QueryRun {
  return { queryId: id, retrieved, expected };
}

describe('recallAtK (#1102)', () => {
  it('counts a query as fully recalled when its one expected page is inside K', () => {
    const runs = [run('q1', [10, 20, 30], [20])];
    expect(recallAtK(runs, 3)).toBe(1);
    // 20 sits at rank 2, so K=1 misses it entirely.
    expect(recallAtK(runs, 1)).toBe(0);
  });

  it('is fractional per query when a fixture expects several pages', () => {
    // 2 of 3 expected pages inside K=3 → 0.667 for this single query.
    const runs = [run('q1', [10, 20, 30], [20, 30, 99])];
    expect(recallAtK(runs, 3)).toBeCloseTo(2 / 3, 10);
  });

  it('averages over queries, not over hits — one hard query cannot be masked by an easy one', () => {
    // The expected-set sizes must DIFFER or the two definitions agree and the
    // test proves nothing (review r1): q1 finds 3 of 3, q2 finds 0 of 1.
    // Per-query: (1 + 0) / 2 = 0.5. Hit-pooled: 3 hits / 4 expected = 0.75.
    const runs = [run('q1', [1, 2, 3], [1, 2, 3]), run('q2', [9], [8])];
    expect(recallAtK(runs, 3)).toBe(0.5);
  });

  it('dedups retrieved pages BEFORE the top-K cut, so a repeat cannot evict a real hit', () => {
    // Chunk-level runs repeat a page. At K=2 the naive cut is [5, 5] and the
    // genuine hit at 9 falls outside the window — scoring 0 for a run that
    // actually surfaced both expected pages in its first three slots.
    const runs = [run('q1', [5, 5, 9], [5, 9])];
    expect(recallAtK(runs, 2)).toBe(1);
  });

  it('dedups the EXPECTED set, so a fixture listing a page twice cannot halve its own score', () => {
    // A hand-edited fixture with a duplicated expectation would otherwise
    // divide one hit by a denominator of 2 and report 0.5 for a perfect run.
    const runs = [run('q1', [7, 8], [7, 7])];
    expect(recallAtK(runs, 2)).toBe(1);
  });

  it('returns 0 for an empty run set rather than NaN', () => {
    expect(recallAtK([], 5)).toBe(0);
  });
});

describe('meanReciprocalRank (#1102)', () => {
  it('scores by the FIRST expected hit', () => {
    // ranks 2 and 1 → (0.5 + 1) / 2 = 0.75
    const runs = [run('q1', [1, 2, 3], [2]), run('q2', [4, 5], [4])];
    expect(meanReciprocalRank(runs)).toBeCloseTo(0.75, 10);
  });

  it('contributes 0 for a query that never retrieves an expected page', () => {
    const runs = [run('q1', [1, 2], [3]), run('q2', [4], [4])];
    expect(meanReciprocalRank(runs)).toBe(0.5);
  });

  it('takes the best rank when several expected pages are present', () => {
    // 3 is at rank 3, 1 at rank 1 → reciprocal 1, not 1/3.
    const runs = [run('q1', [1, 2, 3], [3, 1])];
    expect(meanReciprocalRank(runs)).toBe(1);
  });
});

describe('pairedBootstrapCi (#1102)', () => {
  it('excludes zero when every query improves — the gate this replaces the 0.01 threshold with', () => {
    // 40 queries, candidate strictly better on all of them.
    const baseline = Array.from({ length: 40 }, (_, i) => run(`q${i}`, [99, 1], [1]));
    const candidate = Array.from({ length: 40 }, (_, i) => run(`q${i}`, [1, 99], [1]));

    const ci = pairedBootstrapCi(baseline, candidate, (r) => recallAtK([r], 1), { seed: 42 });

    expect(ci.observedDelta).toBe(1);
    expect(ci.lower).toBeGreaterThan(0);
    expect(ci.excludesZero).toBe(true);
  });

  it('does NOT exclude zero when the wins and losses cancel', () => {
    // 20 queries improve, 20 regress by the same amount: a fixed-threshold
    // gate would fire on the noise; the CI must straddle zero.
    const baseline = [
      ...Array.from({ length: 20 }, (_, i) => run(`w${i}`, [99, 1], [1])),
      ...Array.from({ length: 20 }, (_, i) => run(`l${i}`, [1, 99], [1])),
    ];
    const candidate = [
      ...Array.from({ length: 20 }, (_, i) => run(`w${i}`, [1, 99], [1])),
      ...Array.from({ length: 20 }, (_, i) => run(`l${i}`, [99, 1], [1])),
    ];

    const ci = pairedBootstrapCi(baseline, candidate, (r) => recallAtK([r], 1), { seed: 42 });

    expect(ci.observedDelta).toBe(0);
    expect(ci.excludesZero).toBe(false);
  });

  it('is deterministic for a given seed — a gate that moves between runs is not a gate', () => {
    // Graded deltas (MRR over three rank positions) rather than binary ones:
    // with 0/1 deltas the resampled means are coarsely quantised and two
    // seeds legitimately land on the same quantile, which would make the
    // seed-is-wired assertion below flaky-by-construction rather than false.
    const baseline = Array.from({ length: 30 }, (_, i) => run(`q${i}`, [98, 99, 1], [1]));
    const candidate = Array.from({ length: 30 }, (_, i) =>
      run(`q${i}`, i % 3 === 0 ? [1, 98, 99] : i % 3 === 1 ? [98, 1, 99] : [98, 99, 1], [1]),
    );
    const score = (r: QueryRun) => meanReciprocalRank([r]);

    const a = pairedBootstrapCi(baseline, candidate, score, { seed: 7 });
    const b = pairedBootstrapCi(baseline, candidate, score, { seed: 7 });
    const different = pairedBootstrapCi(baseline, candidate, score, { seed: 8 });

    expect(a).toEqual(b);
    // A different seed must actually resample differently, or `seed` is decoration
    // and every "reproducible" claim in the runbook is untrue.
    expect(different).not.toEqual(a);
  });

  it('straddles zero for a delta too small to be credible — the case a fixed threshold gets wrong', () => {
    // 40 queries, exactly one improves: observedDelta = 0.025, non-zero and
    // above the retired "0.01 fails" line, yet a single query flipping is
    // indistinguishable from noise and the interval must say so.
    const baseline = Array.from({ length: 40 }, (_, i) => run(`q${i}`, [99, 1], [1]));
    const candidate = Array.from({ length: 40 }, (_, i) => run(`q${i}`, i === 0 ? [1, 99] : [99, 1], [1]));

    const ci = pairedBootstrapCi(baseline, candidate, (r) => recallAtK([r], 1), { seed: 42 });

    expect(ci.observedDelta).toBeCloseTo(0.025, 10);
    expect(ci.lower).toBe(0);
    expect(ci.excludesZero).toBe(false);
  });

  it('pairs by queryId, refusing run sets that are not the same queries', () => {
    const baseline = [run('q1', [1], [1])];
    const candidate = [run('q2', [1], [1])];
    expect(() => pairedBootstrapCi(baseline, candidate, (r) => recallAtK([r], 1), { seed: 1 })).toThrow(
      /same queries/i,
    );
  });
});

describe('pairedSignificance (#1102, review r1)', () => {
  function pair(wins: number, losses: number, ties: number) {
    const baseline: QueryRun[] = [];
    const candidate: QueryRun[] = [];
    for (let i = 0; i < wins; i++) { baseline.push(run(`w${i}`, [99, 1], [1])); candidate.push(run(`w${i}`, [1, 99], [1])); }
    for (let i = 0; i < losses; i++) { baseline.push(run(`l${i}`, [1, 99], [1])); candidate.push(run(`l${i}`, [99, 1], [1])); }
    for (let i = 0; i < ties; i++) { baseline.push(run(`t${i}`, [1, 99], [1])); candidate.push(run(`t${i}`, [1, 99], [1])); }
    return { baseline, candidate };
  }
  const score = (r: QueryRun) => recallAtK([r], 1);

  it('does NOT call 4 flipped queries significant — the bootstrap did, at a true p of 0.125', () => {
    // The exact defect: with unanimous deltas the percentile bootstrap fired
    // at m>=4 for ANY N, so 4 losses out of 144 (and out of 10,000) read as
    // "credible regression".
    const { baseline, candidate } = pair(0, 4, 140);
    const verdict = pairedSignificance(baseline, candidate, score);

    expect(verdict.method).toBe('mcnemar-exact');
    expect(verdict.losses).toBe(4);
    expect(verdict.pValue).toBeCloseTo(0.125, 10);
    expect(verdict.significant).toBe(false);

    // …while the interval it replaced says the opposite on the same input.
    const ci = pairedBootstrapCi(baseline, candidate, score, { seed: 1102 });
    expect(ci.excludesZero).toBe(true);
  });

  it('is independent of fixture size, as the sign test must be', () => {
    for (const ties of [96, 296, 996]) {
      const { baseline, candidate } = pair(0, 4, ties);
      expect(pairedSignificance(baseline, candidate, score).pValue).toBeCloseTo(0.125, 10);
    }
  });

  it('calls a real one-sided movement significant once the evidence supports it', () => {
    // 6 discordant, all losses → p = 2/2^6 = 0.03125.
    const { baseline, candidate } = pair(0, 6, 138);
    const verdict = pairedSignificance(baseline, candidate, score);

    expect(verdict.pValue).toBeCloseTo(0.03125, 10);
    expect(verdict.significant).toBe(true);
    expect(verdict.direction).toBe('regression');
  });

  it('reads a mixed result by its discordant pairs, not by the raw mean', () => {
    // 2 wins / 8 losses: p = 2*(C(10,0)+C(10,1)+C(10,2))/2^10 = 0.109…
    const { baseline, candidate } = pair(2, 8, 134);
    const verdict = pairedSignificance(baseline, candidate, score);

    expect(verdict.pValue).toBeCloseTo(0.109375, 6);
    expect(verdict.significant).toBe(false);
  });

  it('stays finite when the discordant count is large (review r2)', () => {
    // C(n,i) over 2**n overflowed to NaN past ~1024 pairs, and `p < 0.05` then
    // silently went false — the gate vanishing when the evidence was strongest.
    expect(mcnemarExactTwoSided(0, 2000)).toBeCloseTo(0, 10);
    expect(mcnemarExactTwoSided(1000, 1000)).toBeCloseTo(1, 6);
    expect(Number.isNaN(mcnemarExactTwoSided(3, 2000))).toBe(false);
    // …and it still agrees with the hand-checked small cases.
    expect(mcnemarExactTwoSided(0, 4)).toBeCloseTo(0.125, 12);
    expect(mcnemarExactTwoSided(0, 6)).toBeCloseTo(0.03125, 12);
    expect(mcnemarExactTwoSided(2, 8)).toBeCloseTo(0.109375, 12);
    expect(mcnemarExactTwoSided(0, 0)).toBe(1);
  });

  it('reports improvement direction symmetrically', () => {
    const { baseline, candidate } = pair(7, 0, 137);
    const verdict = pairedSignificance(baseline, candidate, score);
    expect(verdict.significant).toBe(true);
    expect(verdict.direction).toBe('improvement');
  });

  it('falls back to the interval when scores are graded rather than binary', () => {
    // Multi-page expectations make per-query recall fractional, which is
    // outside McNemar's assumptions.
    const baseline = [run('q1', [1, 2], [1, 2, 3])];
    const candidate = [run('q1', [1, 2, 3], [1, 2, 3])];
    const verdict = pairedSignificance(baseline, candidate, (r) => recallAtK([r], 5));
    expect(verdict.method).toBe('bootstrap-percentile');
  });
});

describe('the disposable-database rule (#1102, review r4)', () => {
  // The guard lives in scripts/run-retrieval-eval.ts, which has no test of its
  // own; round 3's verification used four names that all happened to avoid the
  // token-delimiter asymmetry, which is why it shipped refusing `test`.
  const DISPOSABLE = /eval|test|scratch|sandbox/i;
  const NEVER = /prod|live|main|staging/i;
  const admits = (name: string) => DISPOSABLE.test(name) && !NEVER.test(name);

  it('admits the names its own error message tells the operator to use', () => {
    for (const name of ['kb_eval', 'kb_creator_test', 'test', 'testdb', 'eval-db', 'scratch1', 'sandbox']) {
      expect(admits(name), name).toBe(true);
    }
  });

  it('refuses anything that looks like real data, including names that also say eval', () => {
    for (const name of ['kb_creator_prod', 'compendiq', 'production_eval', 'staging_eval', 'live_eval', 'mainline']) {
      expect(admits(name), name).toBe(false);
    }
  });
});

describe('winLoss (#1102)', () => {
  it('reports per-query movement, which the aggregate hides', () => {
    const baseline = [run('q1', [99, 1], [1]), run('q2', [2], [2]), run('q3', [3], [3])];
    const candidate = [run('q1', [1, 99], [1]), run('q2', [99], [2]), run('q3', [3], [3])];

    const table = winLoss(baseline, candidate, (r) => recallAtK([r], 1));

    expect(table.wins.map((w) => w.queryId)).toEqual(['q1']);
    expect(table.losses.map((l) => l.queryId)).toEqual(['q2']);
    expect(table.ties).toBe(1);
    // Aggregate recall is unchanged (2/3 → 2/3) while two queries moved: the
    // reason the issue asks for this table alongside the mean.
    expect(recallAtK(baseline, 1)).toBe(recallAtK(candidate, 1));
  });
});

// ---------------------------------------------------------------------------
// #1614 PR2 — ADR-027's statistics. Expectations are computed by hand or from
// the ADR's own worked figures, never by re-running the implementation.
// ---------------------------------------------------------------------------

describe('clusterBootstrapCi (#1614 PR2, ADR-027 O3)', () => {
  it('is pairedBootstrapCi exactly when every cluster holds one query', () => {
    // Same PRNG, same draw order, same quantile — so a fixture with one label
    // per page must produce the identical interval, or the two are different
    // arithmetic for the same data.
    const baseline = [run('q1', [9], [1]), run('q2', [2], [2]), run('q3', [9], [3]), run('q4', [4], [4]), run('q5', [9], [5])];
    const candidate = [run('q1', [1], [1]), run('q2', [2], [2]), run('q3', [9], [3]), run('q4', [9], [4]), run('q5', [5], [5])];
    const score = (r: QueryRun) => recallAtK([r], 1);
    const plain = pairedBootstrapCi(baseline, candidate, score, { seed: 7, iterations: 500 });
    const clustered = clusterBootstrapCi(
      baseline.map((b, i) => ({ queryId: b.queryId, cluster: `page-${i}`, delta: score(candidate[i]!) - score(b) })),
      { seed: 7, iterations: 500 },
    );
    expect(clustered.observedDelta).toBe(plain.observedDelta);
    expect(clustered.lower).toBe(plain.lower);
    expect(clustered.upper).toBe(plain.upper);
    expect(clustered.clusters).toBe(5);
  });

  it('is deterministic under a seed and different under another', () => {
    const deltas: ClusteredDelta[] = Array.from({ length: 20 }, (_, i) => ({
      queryId: `q${i}`, cluster: `p${i % 6}`, delta: i % 3 === 0 ? 1 : i % 3 === 1 ? 0 : -1,
    }));
    const a = clusterBootstrapCi(deltas, { seed: 1, iterations: 300 });
    const b = clusterBootstrapCi(deltas, { seed: 1, iterations: 300 });
    const c = clusterBootstrapCi(deltas, { seed: 2, iterations: 300 });
    expect(a).toEqual(b);
    expect([a.lower, a.upper]).not.toEqual([c.lower, c.upper]);
  });

  it('collapses to a point interval on one page — a page-level effect is one observation, not five', () => {
    // Five queries on ONE page: every resample draws that page, so every
    // resampled mean is the observed mean and the interval has no width.
    // Query-level resampling would print a confident interval around it.
    const deltas: ClusteredDelta[] = [1, 0, 1, 1, 0].map((d, i) => ({ queryId: `q${i}`, cluster: 'only-page', delta: d }));
    const ci = clusterBootstrapCi(deltas, { seed: 3, iterations: 200 });
    expect(ci.observedDelta).toBeCloseTo(0.6, 10);
    expect(ci.lower).toBeCloseTo(0.6, 10);
    expect(ci.upper).toBeCloseTo(0.6, 10);
    expect(ci.clusters).toBe(1);
    expect(ci.queries).toBe(5);
  });

  it('refuses a query id that appears twice — a pair is one row per query', () => {
    expect(() => clusterBootstrapCi(
      [{ queryId: 'q', cluster: 'a', delta: 1 }, { queryId: 'q', cluster: 'b', delta: 0 }],
      { seed: 1, iterations: 10 },
    )).toThrow(/twice/);
  });

  it('reports the one-sided bounds off the same resample as the two-sided interval', () => {
    const deltas: ClusteredDelta[] = Array.from({ length: 30 }, (_, i) => ({ queryId: `q${i}`, cluster: `p${i % 10}`, delta: i % 4 === 0 ? -1 : i % 4 === 1 ? 1 : 0 }));
    const ci = clusterBootstrapCi(deltas, { seed: 5, iterations: 400, confidence: 0.95 });
    // The 5% quantile sits at or above the 2.5% one, and the 95% at or below the 97.5%.
    expect(ci.oneSidedLower).toBeGreaterThanOrEqual(ci.lower);
    expect(ci.oneSidedUpper).toBeLessThanOrEqual(ci.upper);
  });
});

function ciOf(over: Partial<ClusterBootstrapCi>): ClusterBootstrapCi {
  return {
    observedDelta: 0, lower: -0.1, upper: 0.1, excludesZero: false, iterations: 1, confidence: 0.95,
    clusters: 1, queries: 1, oneSidedLower: -0.05, oneSidedUpper: 0.05, ...over,
  };
}

describe('margin verdicts (#1614 PR2, ADR-027 O4–O7)', () => {
  it('non-inferiority passes only when the one-sided lower bound clears −margin', () => {
    // Margin 2 pp: a lower bound of −1.9 pp passes, −2.0 pp does not (the
    // bound must be ABOVE the margin), and non-significance is not
    // non-inferiority — an interval straddling the margin is inconclusive.
    expect(nonInferiorityVerdict(ciOf({ oneSidedLower: -0.019 }), 0.02)).toBe('pass');
    expect(nonInferiorityVerdict(ciOf({ oneSidedLower: -0.02, oneSidedUpper: 0.03 }), 0.02)).toBe('inconclusive');
    expect(nonInferiorityVerdict(ciOf({ oneSidedLower: -0.08, oneSidedUpper: -0.03 }), 0.02)).toBe('fail');
  });

  it('safety passes only when the one-sided upper bound of the excess is at or under the margin', () => {
    // O6: B's unsupported-claim rate may exceed A's by at most 3 pp.
    expect(safetyVerdict(ciOf({ oneSidedUpper: 0.03 }), 0.03)).toBe('pass');
    expect(safetyVerdict(ciOf({ oneSidedLower: -0.01, oneSidedUpper: 0.031 }), 0.03)).toBe('inconclusive');
    expect(safetyVerdict(ciOf({ oneSidedLower: 0.04, oneSidedUpper: 0.09 }), 0.03)).toBe('fail');
  });
});

describe('pilotDiscordance (#1614 PR2, ADR-027 "Sample size")', () => {
  const pair = (b: 0 | 1, c: 0 | 1) => ({ baseline: b, candidate: c });

  it('stops the run when the first 30 pairs are below the 0.20 discordance floor', () => {
    // 5 discordant of 30 = 0.167 < 0.20 → stop; a 31st pair is not read.
    const outcomes = [...Array.from({ length: 5 }, () => pair(0, 1)), ...Array.from({ length: 25 }, () => pair(1, 1)), pair(0, 1)];
    const check = pilotDiscordance(outcomes, { pilotPairs: 30, floor: 0.2 });
    expect(check).toEqual({ pairs: 30, discordant: 5, psi: 5 / 30, evaluated: true, stop: true });
  });

  it('does not stop at exactly the floor, and does not evaluate before the pilot is complete', () => {
    const atFloor = [...Array.from({ length: 6 }, () => pair(1, 0)), ...Array.from({ length: 24 }, () => pair(0, 0))];
    expect(pilotDiscordance(atFloor, { pilotPairs: 30, floor: 0.2 }).stop).toBe(false);
    const short = pilotDiscordance(atFloor.slice(0, 10), { pilotPairs: 30, floor: 0.2 });
    expect(short.evaluated).toBe(false);
    expect(short.stop).toBe(false);
  });
});

describe('mcnemarPower (#1614 PR2, ADR-027 "Sample size")', () => {
  it('reproduces the ADR\'s worked figures', () => {
    // Primary endpoint: ψ = 0.30, δ = 0.15, DE = 1.4, two-sided α = 0.05 → ≈ 0.90 at N = 190, ≈ 0.80 at N = 144.
    expect(mcnemarPower({ n: 190, psi: 0.3, delta: 0.15, designEffect: 1.4, zAlpha: 1.96 })).toBeCloseTo(0.9, 1);
    expect(mcnemarPower({ n: 144, psi: 0.3, delta: 0.15, designEffect: 1.4, zAlpha: 1.96 })).toBeCloseTo(0.8, 1);
    // O5: image-evidence R@5, ψ ≈ 0.15, a 5-point margin, DE 1.4, one-sided → ≈ 0.44 at δ = 0.
    expect(mcnemarPower({ n: 190, psi: 0.15, delta: 0.05, designEffect: 1.4, zAlpha: 1.645 })).toBeCloseTo(0.44, 1);
    // …and a 1-point margin there is ≈ 0.09 — "undecidable at any plausible N".
    expect(mcnemarPower({ n: 190, psi: 0.15, delta: 0.01, designEffect: 1.4, zAlpha: 1.645 })).toBeCloseTo(0.09, 1);
  });

  it('is 0 when the assumptions are degenerate rather than NaN', () => {
    expect(mcnemarPower({ n: 0, psi: 0.3, delta: 0.15, designEffect: 1.4, zAlpha: 1.96 })).toBe(0);
    expect(mcnemarPower({ n: 100, psi: 0.02, delta: 0.15, designEffect: 1, zAlpha: 1.96 })).toBe(0);
  });
});
