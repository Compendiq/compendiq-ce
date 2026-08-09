import { describe, expect, it } from 'vitest';
import { recallAtK, meanReciprocalRank, pairedBootstrapCi, pairedSignificance, mcnemarExactTwoSided, winLoss, type QueryRun } from './metrics.js';

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
