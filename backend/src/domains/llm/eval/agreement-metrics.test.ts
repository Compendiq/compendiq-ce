import { describe, it, expect } from 'vitest';
import {
  jaccardOverlap,
  top1Changed,
  rankBiasedOverlap,
  summarizeAgreement,
} from './agreement-metrics.js';

/**
 * #1260 Mode 1 — agreement statistics between two ranked page-id lists.
 *
 * These are AGREEMENT measures, not quality measures: they say how much the
 * candidate model would move retrieval, never which side is right. The
 * service and the card both state that; these tests pin the arithmetic.
 */
describe('agreement-metrics (#1260)', () => {
  describe('jaccardOverlap', () => {
    it('is 1 for identical sets regardless of order', () => {
      expect(jaccardOverlap([1, 2, 3], [3, 2, 1])).toBe(1);
    });

    it('is 0 for disjoint sets', () => {
      expect(jaccardOverlap([1, 2], [3, 4])).toBe(0);
    });

    it('is intersection over union for partial overlap', () => {
      // {1,2,3} ∩ {2,3,4} = 2; union = 4.
      expect(jaccardOverlap([1, 2, 3], [2, 3, 4])).toBe(0.5);
    });

    it('treats two empty lists as full agreement, not 0/0', () => {
      // Both models returned nothing for this query — they agree. The
      // production benchmark's paired overlap uses the same convention.
      expect(jaccardOverlap([], [])).toBe(1);
    });

    it('scores one empty side as no agreement', () => {
      expect(jaccardOverlap([1], [])).toBe(0);
    });
  });

  describe('top1Changed', () => {
    it('is false when both heads agree', () => {
      expect(top1Changed([7, 8], [7, 9])).toBe(false);
    });

    it('is true when the heads differ', () => {
      expect(top1Changed([7, 8], [8, 7])).toBe(true);
    });

    it('is false when both lists are empty (no result on either side)', () => {
      expect(top1Changed([], [])).toBe(false);
    });

    it('is true when exactly one side is empty', () => {
      expect(top1Changed([1], [])).toBe(true);
      expect(top1Changed([], [1])).toBe(true);
    });
  });

  describe('rankBiasedOverlap', () => {
    it('is 1 for identical lists', () => {
      expect(rankBiasedOverlap([1, 2, 3], [1, 2, 3])).toBe(1);
    });

    it('is 0 for disjoint lists', () => {
      expect(rankBiasedOverlap([1, 2, 3], [4, 5, 6])).toBe(0);
    });

    it('is 1 for two empty lists', () => {
      expect(rankBiasedOverlap([], [])).toBe(1);
    });

    it('weights the head more than the tail (p = 0.9)', () => {
      // Same set, one swap at the head vs one at the tail: the head swap
      // must cost more agreement, or the measure is just Jaccard again.
      const base = [1, 2, 3, 4, 5];
      const headSwap = [2, 1, 3, 4, 5];
      const tailSwap = [1, 2, 3, 5, 4];
      const headScore = rankBiasedOverlap(base, headSwap);
      const tailScore = rankBiasedOverlap(base, tailSwap);
      expect(headScore).toBeLessThan(tailScore);
      // A transposition never changes the SET, so both stay below 1 only
      // through the depth-weighted prefix disagreement.
      expect(headScore).toBeLessThan(1);
      expect(tailScore).toBeLessThan(1);
    });

    it('matches the hand-computed value for a small case', () => {
      // a=[1,2], b=[2,1], p=0.9. Prefix overlaps: d=1 → 0/1, d=2 → 2/2.
      // Normalised: (p^0·0 + p^1·1) / (p^0 + p^1) = 0.9/1.9.
      expect(rankBiasedOverlap([1, 2], [2, 1])).toBeCloseTo(0.9 / 1.9, 12);
    });

    it('penalises a missing tail on one side', () => {
      expect(rankBiasedOverlap([1, 2, 3], [1])).toBeLessThan(1);
      expect(rankBiasedOverlap([1, 2, 3], [1])).toBeGreaterThan(0);
    });
  });

  describe('summarizeAgreement', () => {
    it('aggregates the per-query measures and counts disagreements', () => {
      const rows = [
        { live: [1, 2], candidate: [1, 2] }, // agrees
        { live: [1, 2], candidate: [2, 1] }, // same set, head changed
        { live: [1, 2], candidate: [3, 4] }, // disjoint
      ];
      const s = summarizeAgreement(rows);
      expect(s.queryCount).toBe(3);
      expect(s.top1ChangedQueries).toBe(2);
      expect(s.top1ChangeRate).toBeCloseTo(2 / 3, 12);
      expect(s.meanJaccard).toBeCloseTo((1 + 1 + 0) / 3, 12);
      expect(s.meanRbo).toBeCloseTo((1 + 0.9 / 1.9 + 0) / 3, 12);
      // Disagreement = the head moved OR the sets differ — the second row
      // disagrees on rank alone and must still be listed.
      expect(s.disagreementCount).toBe(2);
    });

    it('handles an empty run without dividing by zero', () => {
      const s = summarizeAgreement([]);
      expect(s.queryCount).toBe(0);
      expect(s.top1ChangeRate).toBe(0);
      expect(s.meanJaccard).toBe(0);
      expect(s.meanRbo).toBe(0);
    });
  });
});
