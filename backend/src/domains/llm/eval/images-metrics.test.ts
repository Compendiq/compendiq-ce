import { describe, expect, it } from 'vitest';
import {
  armRuns,
  imageHitAtK,
  imageNegativeLeakAtK,
  pairedDelta,
  partitionPairs,
  queryCostMs,
  type ImageHitRecord,
  type ImageQueryPair,
} from './images-metrics.js';
import { meanReciprocalRank, recallAtK } from './metrics.js';

/**
 * #1115 P5b — the image axis's own metrics, over hand-built pairs.
 *
 * Pure functions over recorded runs, exactly as `metrics.ts` is and for the
 * same reason: the arithmetic is testable in CI without a VL model, while the
 * numbers themselves come from a run that has one.
 */

function hit(pageId: number, key: string, similarity: number): ImageHitRecord {
  return { pageId, source: 'confluence', key, similarity };
}

function pair(over: Partial<ImageQueryPair> & { queryId: string }): ImageQueryPair {
  return {
    style: 'image',
    lang: 'de',
    expected: [1],
    expectedImageKeys: [],
    off: { retrieved: [], ms: 0, imageHits: [] },
    on: { retrieved: [], ms: 0, imageHits: [] },
    ...over,
  };
}

describe('armRuns', () => {
  it('projects one arm into the QueryRun shape metrics.ts already scores', () => {
    const pairs = [
      pair({ queryId: 'a', expected: [7], off: { retrieved: [9, 7], ms: 1, imageHits: [] }, on: { retrieved: [7, 9], ms: 2, imageHits: [] } }),
    ];

    expect(armRuns(pairs, 'off')).toEqual([{ queryId: 'a', retrieved: [9, 7], expected: [7] }]);
    expect(armRuns(pairs, 'on')).toEqual([{ queryId: 'a', retrieved: [7, 9], expected: [7] }]);
    // …which is what makes the two arms scoreable by the harness's own gate.
    expect(recallAtK(armRuns(pairs, 'off'), 1)).toBe(0);
    expect(recallAtK(armRuns(pairs, 'on'), 1)).toBe(1);
    expect(meanReciprocalRank(armRuns(pairs, 'off'))).toBe(0.5);
  });
});

describe('imageHitAtK', () => {
  it('scores an expected image found among the on-arm top-K image hits', () => {
    const pairs = [
      pair({
        queryId: 'a',
        expectedImageKeys: ['antenne__2.png'],
        on: {
          retrieved: [1],
          ms: 1,
          imageHits: [hit(1, 'antenne__1.png', 0.7), hit(1, 'antenne__2.png', 0.6), hit(2, 'auge__1.png', 0.5)],
        },
      }),
    ];

    expect(imageHitAtK(pairs, 1)).toBe(0);
    expect(imageHitAtK(pairs, 2)).toBe(1);
    expect(imageHitAtK(pairs, 3)).toBe(1);
  });

  it('ranks hits by similarity across pages, not by the order the pages came back in', () => {
    // The leg is page-denominated, so a page's hits arrive grouped. A metric
    // that took them in arrival order would score the second page's best image
    // behind the first page's worst one.
    const pairs = [
      pair({
        queryId: 'a',
        expectedImageKeys: ['auge__1.png'],
        on: {
          retrieved: [1, 2],
          ms: 1,
          imageHits: [hit(1, 'antenne__1.png', 0.4), hit(1, 'antenne__2.png', 0.3), hit(2, 'auge__1.png', 0.9)],
        },
      }),
    ];

    expect(imageHitAtK(pairs, 1)).toBe(1);
  });

  it('ignores labels that name no expected image — a negative cannot contribute a hit', () => {
    const pairs = [
      pair({ queryId: 'pos', expectedImageKeys: ['a.png'], on: { retrieved: [1], ms: 1, imageHits: [hit(1, 'a.png', 0.9)] } }),
      pair({ queryId: 'neg', style: 'image-negative', expectedImageKeys: [], on: { retrieved: [1], ms: 1, imageHits: [hit(1, 'b.png', 0.9)] } }),
    ];

    // 1/1 over the labels that HAVE an expected image, not 1/2 over everything:
    // scoring a negative as a miss would blend the leg's precision into a
    // recall number and make the two unreadable.
    expect(imageHitAtK(pairs, 1)).toBe(1);
  });

  it('answers 0 when nothing in the fixture names an image, rather than dividing by zero', () => {
    expect(imageHitAtK([pair({ queryId: 'neg', style: 'image-negative' })], 5)).toBe(0);
  });

  it('credits a label naming several images when ANY of them is found', () => {
    const pairs = [
      pair({
        queryId: 'a',
        expectedImageKeys: ['x__1.png', 'x__2.png'],
        on: { retrieved: [1], ms: 1, imageHits: [hit(1, 'x__2.png', 0.9)] },
      }),
    ];
    expect(imageHitAtK(pairs, 1)).toBe(1);
  });
});

describe('imageNegativeLeakAtK', () => {
  it('counts a page the image leg pushed into the top-K that the text legs never had', () => {
    const pairs = [
      pair({
        queryId: 'neg',
        style: 'image-negative',
        expected: [1],
        off: { retrieved: [1, 5], ms: 1, imageHits: [] },
        on: { retrieved: [1, 9], ms: 2, imageHits: [hit(9, 'wrong__1.png', 0.8)] },
      }),
    ];

    expect(imageNegativeLeakAtK(pairs, 2)).toBe(1);
  });

  it('does not count a page the OFF arm already had — that one is not the leg\'s doing', () => {
    const pairs = [
      pair({
        queryId: 'neg',
        style: 'image-negative',
        expected: [1],
        off: { retrieved: [1, 9], ms: 1, imageHits: [] },
        on: { retrieved: [1, 9], ms: 2, imageHits: [hit(9, 'wrong__1.png', 0.8)] },
      }),
    ];

    expect(imageNegativeLeakAtK(pairs, 2)).toBe(0);
  });

  it('does not count a new page that carries no image hit — that is text-leg churn', () => {
    // Fusion re-ranks when a third leg joins, so a page can move into the
    // window without the leg having reached it. Blaming the leg for that would
    // make the metric measure RRF's tie-breaking.
    const pairs = [
      pair({
        queryId: 'neg',
        style: 'image-negative',
        expected: [1],
        off: { retrieved: [1, 5], ms: 1, imageHits: [] },
        on: { retrieved: [1, 8], ms: 2, imageHits: [hit(1, 'right__1.png', 0.8)] },
      }),
    ];

    expect(imageNegativeLeakAtK(pairs, 2)).toBe(0);
  });

  it('does not count the label\'s OWN expected page, which is the correct answer', () => {
    const pairs = [
      pair({
        queryId: 'neg',
        style: 'image-negative',
        expected: [1],
        off: { retrieved: [5], ms: 1, imageHits: [] },
        on: { retrieved: [1], ms: 2, imageHits: [hit(1, 'own__1.png', 0.8)] },
      }),
    ];

    expect(imageNegativeLeakAtK(pairs, 1)).toBe(0);
  });

  it('is scored over the negatives alone, and answers 0 when there are none', () => {
    const positives = [
      pair({
        queryId: 'pos',
        expected: [1],
        off: { retrieved: [1], ms: 1, imageHits: [] },
        on: { retrieved: [1, 9], ms: 2, imageHits: [hit(9, 'x.png', 0.8)] },
      }),
    ];
    expect(imageNegativeLeakAtK(positives, 2)).toBe(0);
  });

  it('respects K — a leak below the cut is not in the top-K', () => {
    const pairs = [
      pair({
        queryId: 'neg',
        style: 'image-negative',
        expected: [1],
        off: { retrieved: [1, 2], ms: 1, imageHits: [] },
        on: { retrieved: [1, 2, 9], ms: 2, imageHits: [hit(9, 'wrong__1.png', 0.8)] },
      }),
    ];

    expect(imageNegativeLeakAtK(pairs, 2)).toBe(0);
    expect(imageNegativeLeakAtK(pairs, 3)).toBe(1);
  });
});

describe('pairedDelta', () => {
  it('pairs the two arms of the same query and reports McNemar exact', () => {
    // Six queries the leg fixed, none it broke: the harness's own gate, and the
    // only test that can decide an image axis at all.
    const pairs = Array.from({ length: 6 }, (_, i) =>
      pair({
        queryId: `w${i}`,
        expected: [1],
        off: { retrieved: [9], ms: 1, imageHits: [] },
        on: { retrieved: [1], ms: 2, imageHits: [] },
      }),
    );

    const delta = pairedDelta(pairs, 5);

    expect(delta.off).toBe(0);
    expect(delta.on).toBe(1);
    expect(delta.observedDelta).toBe(1);
    expect(delta.wins).toBe(6);
    expect(delta.losses).toBe(0);
    expect(delta.method).toBe('mcnemar-exact');
    // 2 * 2^-6 = 0.03125 — the exact two-sided sign test, not a bootstrap.
    expect(delta.pValue).toBeCloseTo(0.03125, 6);
    expect(delta.significant).toBe(true);
    expect(delta.direction).toBe('improvement');
  });

  it('calls four discordant pairs UNCREDIBLE, which is the whole reason McNemar replaced the bootstrap', () => {
    const pairs = Array.from({ length: 4 }, (_, i) =>
      pair({
        queryId: `w${i}`,
        expected: [1],
        off: { retrieved: [9], ms: 1, imageHits: [] },
        on: { retrieved: [1], ms: 2, imageHits: [] },
      }),
    );

    const delta = pairedDelta(pairs, 5);
    expect(delta.pValue).toBeCloseTo(0.125, 6);
    expect(delta.significant).toBe(false);
  });

  it('names a regression when the leg loses more than it wins', () => {
    const pairs = [
      ...Array.from({ length: 6 }, (_, i) =>
        pair({ queryId: `l${i}`, expected: [1], off: { retrieved: [1], ms: 1, imageHits: [] }, on: { retrieved: [9], ms: 2, imageHits: [] } })),
    ];

    const delta = pairedDelta(pairs, 5);
    expect(delta.losses).toBe(6);
    expect(delta.direction).toBe('regression');
    expect(delta.significant).toBe(true);
  });

  it('carries n, so a per-slice verdict cannot be read without its sample size', () => {
    expect(pairedDelta([pair({ queryId: 'a' })], 5).n).toBe(1);
    expect(pairedDelta([], 5).n).toBe(0);
  });

  it('is reproducible — the bootstrap interval is seeded', () => {
    const pairs = Array.from({ length: 12 }, (_, i) =>
      pair({
        queryId: `q${i}`,
        expected: [1],
        off: { retrieved: i % 3 === 0 ? [1] : [9], ms: 1, imageHits: [] },
        on: { retrieved: i % 2 === 0 ? [1] : [9], ms: 2, imageHits: [] },
      }),
    );

    expect(pairedDelta(pairs, 5)).toEqual(pairedDelta(pairs, 5));
  });
});

describe('partitionPairs', () => {
  it('slices by style and by lang, which is what the per-class verdicts are computed over', () => {
    const pairs = [
      pair({ queryId: 'a', style: 'image', lang: 'de' }),
      pair({ queryId: 'b', style: 'image', lang: 'en' }),
      pair({ queryId: 'c', style: 'image-negative', lang: 'de' }),
    ];

    expect(Object.keys(partitionPairs(pairs, (p) => p.style)).sort()).toEqual(['image', 'image-negative']);
    expect(partitionPairs(pairs, (p) => p.lang)['en']!.map((p) => p.queryId)).toEqual(['b']);
    expect(partitionPairs(pairs, (p) => p.style)['image']!).toHaveLength(2);
  });
});

describe('queryCostMs', () => {
  it('reports nearest-rank percentiles per arm, through the shared latency arithmetic', () => {
    const pairs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((ms) =>
      pair({ queryId: `q${ms}`, off: { retrieved: [], ms, imageHits: [] }, on: { retrieved: [], ms: ms * 2, imageHits: [] } }));

    expect(queryCostMs(pairs, 'off')).toEqual({ p50: 5, p95: 10 });
    expect(queryCostMs(pairs, 'on')).toEqual({ p50: 10, p95: 20 });
  });

  it('answers zeroes for an empty run rather than NaN', () => {
    expect(queryCostMs([], 'on')).toEqual({ p50: 0, p95: 0 });
  });
});
