import { describe, it, expect } from 'vitest';
import {
  computePrior,
  applyRankingPrior,
  RECENCY_HALF_LIFE_DAYS,
  RANKING_PRIOR_WEIGHT_DEFAULT,
} from './ranking-prior.js';

const NOW = Date.parse('2026-08-12T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

describe('computePrior (#1111)', () => {
  it('returns NULL when no signal exists — absence of a claim, not a bad score', () => {
    // The distinction this whole feature turns on: an unscored page is
    // overwhelmingly a recently synced one, so scoring it 0 would demote the
    // freshest content in a space.
    expect(computePrior({}, NOW)).toBeNull();
    expect(computePrior({ qualityScore: null, lastModifiedAt: null }, NOW)).toBeNull();
  });

  it('uses whichever signals are present, not only the pair', () => {
    expect(computePrior({ qualityScore: 100 }, NOW)).toBe(1);
    expect(computePrior({ qualityScore: 0 }, NOW)).toBe(0);
    // Fresh page, no quality score: recency alone still speaks.
    expect(computePrior({ lastModifiedAt: daysAgo(0) }, NOW)).toBeCloseTo(1, 6);
  });

  it('halves the recency term at one half-life', () => {
    expect(computePrior({ lastModifiedAt: daysAgo(RECENCY_HALF_LIFE_DAYS) }, NOW)).toBeCloseTo(0.5, 6);
    expect(computePrior({ lastModifiedAt: daysAgo(RECENCY_HALF_LIFE_DAYS * 2) }, NOW)).toBeCloseTo(0.25, 6);
  });

  it('clamps a FUTURE timestamp instead of rewarding it', () => {
    // Clock skew and bad imports both produce these; neither should outrank
    // a genuinely fresh page.
    expect(computePrior({ lastModifiedAt: new Date(NOW + 90 * 86_400_000) }, NOW)).toBe(1);
  });

  it('ignores unparseable or out-of-range values rather than producing NaN', () => {
    expect(computePrior({ lastModifiedAt: 'not a date' }, NOW)).toBeNull();
    expect(computePrior({ qualityScore: Number.NaN }, NOW)).toBeNull();
    expect(computePrior({ qualityScore: 500 }, NOW)).toBe(1);
    expect(computePrior({ qualityScore: -20 }, NOW)).toBe(0);
  });
});

describe('applyRankingPrior (#1111)', () => {
  const page = (id: number, score: number, signals = {}) => ({ id, score, ...signals });

  it('breaks a near-tie toward the better, fresher page', () => {
    const out = applyRankingPrior(
      [page(1, 0.0300, { qualityScore: 32, lastModifiedAt: daysAgo(1100) }),
       page(2, 0.0299, { qualityScore: 88, lastModifiedAt: daysAgo(30) })],
      (r) => r as never,
      { now: NOW },
    );
    expect(out.map((r) => r.id)).toEqual([2, 1]);
  });

  it('CANNOT lift a clearly worse retrieval result — the prior is a tie-break, not a ranking', () => {
    // 0.0328 vs 0.0164 is "both legs found it" against "one leg did". No
    // quality score should overturn that; if it can, the weight is wrong.
    const out = applyRankingPrior(
      [page(1, 0.0328, { qualityScore: 10, lastModifiedAt: daysAgo(2000) }),
       page(2, 0.0164, { qualityScore: 100, lastModifiedAt: daysAgo(0) })],
      (r) => r as never,
      { now: NOW },
    );
    expect(out.map((r) => r.id)).toEqual([1, 2]);
  });

  it('applies NO penalty to an unscored page — neutral means untouched', () => {
    // The owner's ruling, stated precisely. "Neutral" does not mean nothing
    // can ever pass an unscored page: a scored page may still gain and win a
    // NEAR-tie. It means the unscored page is never pushed down for lacking
    // a score, so a lead wider than the maximum prior (weight x 1) survives.
    const unscoredLeadsComfortably = applyRankingPrior(
      [page(2, 0.0340), page(1, 0.0300, { qualityScore: 100, lastModifiedAt: daysAgo(0) })],
      (r) => r as never,
      { now: NOW },
    );
    expect(unscoredLeadsComfortably.map((r) => r.id)).toEqual([2, 1]);

    // And the converse: an unscored page trailing by less than the prior is
    // overtaken by a genuinely better page, which is the feature working
    // rather than the unscored page being punished.
    const nearTie = applyRankingPrior(
      [page(1, 0.0305, { qualityScore: 100, lastModifiedAt: daysAgo(0) }), page(2, 0.0300)],
      (r) => r as never,
      { now: NOW },
    );
    expect(nearTie.map((r) => r.id)).toEqual([1, 2]);
  });

  it('is stable on ties, so repeat runs do not churn the order', () => {
    const rows = [page(1, 0.02), page(2, 0.02), page(3, 0.02)];
    expect(applyRankingPrior(rows, (r) => r as never, { now: NOW }).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('weight 0 is exactly the identity ordering — the knob really turns off', () => {
    const rows = [page(1, 0.01, { qualityScore: 1 }), page(2, 0.009, { qualityScore: 100 })];
    expect(applyRankingPrior(rows, (r) => r as never, { weight: 0, now: NOW }).map((r) => r.id)).toEqual([1, 2]);
  });

  it('never drops or duplicates a result — demote, never exclude', () => {
    const rows = [page(1, 0.03, { qualityScore: 0, lastModifiedAt: daysAgo(5000) }), page(2, 0.02), page(3, 0.01, { qualityScore: 100 })];
    const out = applyRankingPrior(rows, (r) => r as never, { now: NOW });
    expect(out).toHaveLength(3);
    expect(new Set(out.map((r) => r.id))).toEqual(new Set([1, 2, 3]));
  });

  it('uses the documented default weight', () => {
    expect(RANKING_PRIOR_WEIGHT_DEFAULT).toBe(0.003);
  });
});
