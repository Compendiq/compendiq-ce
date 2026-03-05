import { describe, it, expect } from 'vitest';
import { tokenJaccardSimilarity } from './duplicate-detector.js';

describe('DuplicateDetector', () => {
  describe('tokenJaccardSimilarity', () => {
    it('should return 1 for identical strings', () => {
      expect(tokenJaccardSimilarity('hello world', 'hello world')).toBe(1);
    });

    it('should return 0 for completely different strings', () => {
      expect(tokenJaccardSimilarity('foo bar', 'baz qux')).toBe(0);
    });

    it('should return a value between 0 and 1 for partially similar strings', () => {
      const sim = tokenJaccardSimilarity('getting started guide', 'getting started tutorial');
      expect(sim).toBeGreaterThan(0);
      expect(sim).toBeLessThan(1);
      // "getting" and "started" overlap out of 4 unique tokens
      // intersection=2, union=4, so 2/4=0.5
      expect(sim).toBeCloseTo(0.5, 1);
    });

    it('should be case-insensitive', () => {
      expect(tokenJaccardSimilarity('Hello World', 'hello world')).toBe(1);
    });

    it('should ignore punctuation', () => {
      expect(tokenJaccardSimilarity("hello, world!", "hello world")).toBe(1);
    });

    it('should return 1 for two empty strings', () => {
      expect(tokenJaccardSimilarity('', '')).toBe(1);
    });

    it('should return 0 when one string is empty', () => {
      expect(tokenJaccardSimilarity('hello', '')).toBe(0);
    });

    it('should handle multi-word overlapping titles', () => {
      const sim = tokenJaccardSimilarity(
        'How to Deploy to Production',
        'Deploy to Production Guide',
      );
      // Overlap: deploy, to, production (3), union: deploy, to, production, how, guide (5) => 3/5 = 0.6
      expect(sim).toBeCloseTo(0.6, 1);
    });
  });
});
