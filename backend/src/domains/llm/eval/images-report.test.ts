import { describe, expect, it } from 'vitest';
import {
  IMAGE_AXIS_DELTA_K,
  IMAGE_AXIS_TOP_K,
  IMAGE_HIT_TOP_K,
  ImageAxisReportSchema,
  buildImageAxisReport,
  formatImageAxisVerdict,
} from './images-report.js';
import type { ImageArmRun, ImageQueryPair } from './images-metrics.js';
import type { ImageEvalResult } from './runner-images.js';

/**
 * #1115 P5b — the report block's SHAPE, guarded by its own schema.
 *
 * A report outlives the run that wrote it: `--baseline` reads a file from weeks
 * ago, so a field that quietly changed name is a comparison that silently drops
 * a slice. Parsing a freshly built report through the schema is what keeps the
 * builder and the contract from drifting apart.
 */

/** One arm, completed — see `images-metrics.test.ts` for why `startedAt` exists. */
function arm(spec: Partial<ImageArmRun> = {}): ImageArmRun {
  return { retrieved: [], ms: 0, startedAt: 0, imageHits: [], ...spec };
}

function pair(
  over: Partial<Omit<ImageQueryPair, 'off' | 'on'>> & {
    queryId: string;
    off?: Partial<ImageArmRun>;
    on?: Partial<ImageArmRun>;
  },
): ImageQueryPair {
  const { off, on, ...rest } = over;
  return {
    style: 'image',
    lang: 'de',
    expected: [1],
    expectedImageKeys: ['a__1.png'],
    // The runner alternates this on the label index; the default is what index 0
    // gets. Spelled rather than omitted (review r2) — a fixture that does not
    // satisfy `ImageQueryPair` cannot guard the shape of anything built from it.
    offFirst: true,
    ...rest,
    off: arm({ retrieved: [9], ms: 100, ...off }),
    on: arm({
      retrieved: [1],
      ms: 340,
      imageHits: [{ pageId: 1, source: 'confluence', key: 'a__1.png', similarity: 0.6 }],
      ...on,
    }),
  };
}

/**
 * A real `ImageEvalResult`, field for field.
 *
 * It has to be, and `tsc` will not say so: `backend/tsconfig.json` excludes
 * `**\/*.test.ts`, so this annotation is checked by nothing at all. Review r1
 * widened four of these counters to per-arm objects and added `offFirst`, and
 * this fixture kept compiling with `expansionParticipatingQueries: 0` and two
 * fields missing — passing only because `buildImageAxisReport` happens to read
 * `pairs` and `imageLegParticipatingQueries` alone. The moment it publishes one
 * of the others, the file whose stated job is that the builder and the contract
 * cannot drift would have fed it `undefined` and stayed green (review r2).
 */
function runOf(pairs: ImageQueryPair[]): ImageEvalResult {
  const both = { off: pairs.length, on: pairs.length };
  return {
    pairs,
    totalQueries: pairs.length,
    imageLegParticipatingQueries: pairs.filter((p) => p.on.imageHits.length > 0).length,
    vectorParticipatingQueries: both,
    rerankParticipatingQueries: { off: 0, on: 0 },
    assemblyParticipatingQueries: both,
    pinParticipatingQueries: { off: 0, on: 0 },
    expansionParticipatingQueries: { off: 0, on: 0 },
    expansionSkippedQueries: { off: 0, on: 0 },
  };
}

const INPUT = {
  imageModel: 'Qwen3-VL-Embedding-2B',
  imageDims: 2048,
  backend: 'mlx',
  identity: 'p:Qwen3-VL-Embedding-2B@http://127.0.0.1:8011/v1#native',
  indexed: true,
  imagesEmbedded: 187,
  imagesReused: 0,
  imageEmbedWallClockMs: 93_500,
  throughputImagesPerSec: 2,
  // The same 187 images over 65 pages once the worker's 200ms per-page valve is
  // added: 187 / (93.5 + 13) = 1.7559… (review r3).
  backfillThroughputImagesPerSec: 1.76,
  interPageDelayMs: 200,
};

describe('buildImageAxisReport', () => {
  const pairs = [
    ...Array.from({ length: 6 }, (_, i) => pair({ queryId: `de-${i}` })),
    pair({ queryId: 'en-0', lang: 'en' }),
    pair({
      queryId: 'neg-0',
      style: 'image-negative',
      expectedImageKeys: [],
      off: { retrieved: [1], ms: 90, imageHits: [] },
      on: { retrieved: [1, 5], ms: 300, imageHits: [{ pageId: 5, source: 'confluence', key: 'b__1.png', similarity: 0.4 }] },
    }),
  ];
  const report = buildImageAxisReport({ ...INPUT, run: runOf(pairs) });

  it('parses through its own schema', () => {
    expect(() => ImageAxisReportSchema.parse(report)).not.toThrow();
  });

  it('carries both arms at every K the text gate reports at', () => {
    for (const k of IMAGE_AXIS_TOP_K) {
      expect(report.legOff.recallAtK[`@${k}`]).toBeTypeOf('number');
      expect(report.legOn.recallAtK[`@${k}`]).toBeTypeOf('number');
      expect(report.delta.recallAtK[`@${k}`]!.k).toBe(k);
    }
    expect(report.legOff.recallAtK['@5']).toBe(0.125);
    expect(report.legOn.recallAtK['@5']).toBe(1);
    // MRR by VALUE, per arm (review r3). Checking it for existence alone let
    // `scoresFor` read both arms' MRR off the SAME arm — verified by mutation,
    // 60 of 60 green — which publishes `legOff.mrr === legOn.mrr` on every run:
    // an MRR delta of exactly zero, reading as "the leg does not help". The off
    // arm here retrieves [9] against an expected [1] and the on arm [1], except
    // for the negative, whose off arm already had its page at rank 1.
    expect(report.legOff.mrr).toBe(0.125);
    expect(report.legOn.mrr).toBe(1);
  });

  it('slices the paired verdict by style and by language', () => {
    expect(Object.keys(report.delta.perStyle).sort()).toEqual(['image', 'image-negative']);
    expect(Object.keys(report.delta.perLang).sort()).toEqual(['de', 'en']);
    // n travels with every slice — a verdict over 1 query is not a result.
    expect(report.delta.perLang['en']!.n).toBe(1);
    expect(report.delta.perStyle['image']!.n).toBe(7);
    expect(report.delta.perStyle['image']!.k).toBe(IMAGE_AXIS_DELTA_K);
  });

  it('scores imageHit@K over the positives and the leak over the negatives', () => {
    for (const k of IMAGE_HIT_TOP_K) {
      expect(report.imageHitAtK[`@${k}`]).toBe(1);
      expect(report.imageNegativeLeakAtK[`@${k}`]).toBe(k >= 3 ? 1 : 0);
    }
  });

  it('keeps both arms\' per-query runs, so a same-axis baseline can compare each', () => {
    expect(report.runsOff.map((r) => r.queryId)).toEqual(pairs.map((p) => p.queryId));
    expect(report.runsOn[0]!.retrieved).toEqual([1]);
    expect(report.runsOff[0]!.retrieved).toEqual([9]);
  });

  it('records the endpoint provenance the operator declared, and omits it when they did not', () => {
    expect(report.imageEndpointBackend).toBe('mlx');
    expect(buildImageAxisReport({ ...INPUT, backend: undefined, run: runOf(pairs) }))
      .not.toHaveProperty('imageEndpointBackend');
  });

  it('records throughput and the wall clock it was computed from', () => {
    expect(report.imagesEmbedded).toBe(187);
    expect(report.throughputImagesPerSec).toBe(2);
    expect(report.imageEmbedWallClockMs).toBe(93_500);
  });

  it('publishes the backfill rate BESIDE the raw one, never in place of it', () => {
    // The raw figure is the endpoint's and the seeder pays no inter-page valve;
    // a backfill does, so labelling one number as both overstated the operator's
    // by 200ms per page (review r3). Both are here, and the valve with them, so
    // the derived one is self-describing rather than a constant in a comment.
    expect(report.backfillThroughputImagesPerSec).toBe(1.76);
    expect(report.interPageDelayMs).toBe(200);
    expect(report.backfillThroughputImagesPerSec).toBeLessThan(report.throughputImagesPerSec);
  });

  it('records the per-arm query cost AND the paired delta, which is the leg\'s cost', () => {
    expect(report.queryCostMs.off.p50).toBeLessThan(report.queryCostMs.on.p50);
    expect(report.queryCostMs.on).toHaveProperty('p95');
    // The pairing the runner is built around, kept as far as the report
    // (review r3): every pair here costs the leg 240ms except the negative's
    // 210, so the paired p50 is 240 — a number the marginals cannot produce.
    expect(report.queryCostMs.deltaPaired).toEqual({ p50: 240, p95: 240 });
  });
});

describe('formatImageAxisVerdict', () => {
  const report = buildImageAxisReport({
    ...INPUT,
    run: runOf([
      ...Array.from({ length: 8 }, (_, i) => pair({ queryId: `q${i}` })),
      pair({ queryId: 'neg', style: 'image-negative', expectedImageKeys: [] }),
    ]),
  });
  const text = formatImageAxisVerdict(report).join('\n');

  it('prints a paired row per K, with n, the delta, the win/loss split and the p value', () => {
    expect(text).toMatch(/Recall@5\s+n=\s*9\s+0\.0000 → 1\.0000\s+\+1\.0000\s+9W\/0L\s+p=0\.0039/);
    expect(text).toContain('credible improvement');
  });

  it('prints the MRR row by value, both arms — the one row nothing else pins', () => {
    // Every other assertion in this file matched a Recall row or a counter, so
    // the formatter could have printed one arm's MRR twice (review r3).
    expect(text).toMatch(/MRR\s+0\.0000 → 1\.0000/);
  });

  it('prints the two slices the axis exists to separate', () => {
    expect(text).toContain('by style');
    expect(text).toContain('image-negative');
    expect(text).toContain('by language');
  });

  it('names a sequential scan rather than leaving it to be inferred from the latency', () => {
    const unindexed = formatImageAxisVerdict(
      buildImageAxisReport({ ...INPUT, indexed: false, imageDims: 4096, run: runOf([pair({ queryId: 'q' })]) }),
    ).join('\n');
    expect(unindexed).toContain('SEQUENTIAL SCAN');
    expect(text).toContain('HNSW');
  });

  it('prints imageHit@K, the negative leak and both arms\' query cost', () => {
    expect(text).toContain('imageHit@K');
    expect(text).toContain('imageNegLeak@K');
    expect(text).toMatch(/query cost ms\s+off p50 100 \/ p95 100\s+on p50 340 \/ p95 340/);
  });

  it('prints the paired leg cost on its own line, signed and per query', () => {
    expect(text).toMatch(/leg cost ms\s+paired per query: p50 \+240 \/ p95 \+240/);
  });

  it('names both throughput figures and the valve that separates them', () => {
    expect(text).toContain('2.00 images/s sequential, no inter-page pause');
    expect(text).toContain('1.76 images/s for a backfill, which adds 200ms per page');
  });
});
