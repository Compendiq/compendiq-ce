import { describe, expect, it } from 'vitest';
import { recallAtK, meanReciprocalRank, pairedBootstrapCi, winLoss, type QueryRun } from './metrics.js';

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
    // q1 = 1.0, q2 = 0.0 → 0.5. A hit-pooled metric would report 1/2 here too,
    // but diverges as soon as the fixtures have different expected-set sizes.
    const runs = [run('q1', [7], [7]), run('q2', [8], [9])];
    expect(recallAtK(runs, 1)).toBe(0.5);
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
