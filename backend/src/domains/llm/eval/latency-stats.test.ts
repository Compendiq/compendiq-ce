import { describe, expect, it } from 'vitest';
import { percentile, round } from './latency-stats.js';

/**
 * #1114 review r2 — `percentile` and `round` were byte-identical copies in
 * `production-benchmark.ts` and `query-latency.ts`, sitting in the same
 * directory, under a comment claiming the copy is what makes "two latency
 * figures in this repo mean the same thing". A duplicate is precisely what
 * cannot guarantee that: a retune of the definition moves one report and not
 * the other. One definition, two importers.
 */

describe('percentile (nearest rank)', () => {
  it('matches hand-computed nearest-rank values', () => {
    const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(oneToHundred, 0.5)).toBe(50);
    expect(percentile(oneToHundred, 0.95)).toBe(95);
    // 20 samples: ceil(20 * 0.95) = 19th of the sorted values.
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
  });

  it('sorts a copy — the caller keeps its samples in completion order', () => {
    const samples = [9, 1, 5];
    expect(percentile(samples, 0.5)).toBe(5);
    expect(samples).toEqual([9, 1, 5]);
  });

  it('answers 0 for no samples rather than undefined', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it('never runs off the end of the array at fraction 1', () => {
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
});

describe('round', () => {
  it('keeps two decimals, so a report diffs cleanly', () => {
    expect(round(1.239)).toBe(1.24);
    expect(round(2.004)).toBe(2);
    expect(round(10.5)).toBe(10.5);
  });
});
