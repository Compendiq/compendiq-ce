import { describe, expect, it } from 'vitest';
import {
  IMAGE_AXIS_DELTA_K,
  IMAGE_AXIS_TOP_K,
  IMAGE_HIT_TOP_K,
  ImageAxisReportSchema,
  buildImageAxisReport,
  formatImageAxisVerdict,
} from './images-report.js';
import type { ImageQueryPair } from './images-metrics.js';
import type { ImageEvalResult } from './runner-images.js';

/**
 * #1115 P5b — the report block's SHAPE, guarded by its own schema.
 *
 * A report outlives the run that wrote it: `--baseline` reads a file from weeks
 * ago, so a field that quietly changed name is a comparison that silently drops
 * a slice. Parsing a freshly built report through the schema is what keeps the
 * builder and the contract from drifting apart.
 */

function pair(over: Partial<ImageQueryPair> & { queryId: string }): ImageQueryPair {
  return {
    style: 'image',
    lang: 'de',
    expected: [1],
    expectedImageKeys: ['a__1.png'],
    off: { retrieved: [9], ms: 100, imageHits: [] },
    on: { retrieved: [1], ms: 340, imageHits: [{ pageId: 1, source: 'confluence', key: 'a__1.png', similarity: 0.6 }] },
    ...over,
  };
}

function runOf(pairs: ImageQueryPair[]): ImageEvalResult {
  return {
    pairs,
    totalQueries: pairs.length,
    imageLegParticipatingQueries: pairs.filter((p) => p.on.imageHits.length > 0).length,
    vectorParticipatingQueries: { off: pairs.length, on: pairs.length },
    rerankParticipatingQueries: { off: 0, on: 0 },
    expansionParticipatingQueries: 0,
    expansionSkippedQueries: 0,
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

  it('records the per-arm query cost, which is what the leg is charged for', () => {
    expect(report.queryCostMs.off.p50).toBeLessThan(report.queryCostMs.on.p50);
    expect(report.queryCostMs.on).toHaveProperty('p95');
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
});
