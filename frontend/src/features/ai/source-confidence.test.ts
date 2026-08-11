import { describe, it, expect } from 'vitest';
import { averageSourceSimilarity } from './source-confidence';
import type { Source } from './SourceCitations';

/**
 * The confidence badge reads a cosine similarity, but until #1117 it was handed
 * `score` — which after RRF fusion is the fusion value, capped near 1/61 + 1/61
 * ≈ 0.0328 for the common two-leg case (an exact bound since #1106's
 * best-chunk-only rule; pre-#1106 per-chunk summing could push it higher,
 * but never near 1). ConfidenceBadge thresholds at >= 0.7 high and
 * >= 0.4 medium, so every hybrid knowledge-base answer rendered a red
 * "Low confidence", while web sources — handed a hardcoded `score: 1` — were the
 * only ones that could pull an average up.
 */

const kb = (similarity: number | null): Source => ({
  pageTitle: 'A page',
  pageId: 7,
  similarity,
  score: 0.0161,   // the RRF artefact, always present, never a similarity
});

const web = (): Source => ({
  pageTitle: 'A web result',
  pageId: 0,
  url: 'https://example.com',
  similarity: null,
  score: 1,        // a sort key, not a measurement
});

describe('averageSourceSimilarity', () => {
  it('returns null when there are no sources', () => {
    expect(averageSourceSimilarity([])).toBeNull();
  });

  it('averages the knowledge-base similarities', () => {
    expect(averageSourceSimilarity([kb(0.8), kb(0.6)])).toBeCloseTo(0.7, 10);
  });

  it('ignores web and external sources rather than counting them as 1.0', () => {
    // Regression: with `score: 1` these dominated the mean, so an answer
    // grounded in the web outranked one grounded in the knowledge base.
    expect(averageSourceSimilarity([kb(0.5), web(), web()])).toBeCloseTo(0.5, 10);
  });

  it('returns null when no source carries a similarity', () => {
    // Keyword-only retrieval measures no similarity. Rendering 0 here is what
    // painted the badge red; the honest answer is to render no badge at all.
    expect(averageSourceSimilarity([kb(null), kb(null)])).toBeNull();
  });

  it('returns null for a web-only answer', () => {
    expect(averageSourceSimilarity([web()])).toBeNull();
  });

  it('never reads `score`, even when `similarity` is absent entirely', () => {
    // Conversations persisted before #1117 have `score` but no `similarity`.
    // They must render no badge rather than replaying the old false verdict.
    const legacy: Source[] = [
      { pageTitle: 'Old', pageId: 1, score: 0.0161 },
      { pageTitle: 'Older', pageId: 2, score: 0.0328 },
    ];
    expect(averageSourceSimilarity(legacy)).toBeNull();
  });

  it('averages only the sources that have a similarity', () => {
    expect(averageSourceSimilarity([kb(0.9), kb(null), web()])).toBeCloseTo(0.9, 10);
  });

  it('keeps a genuine zero similarity distinct from an absent one', () => {
    // 0 is a measurement (orthogonal to the query) and must still render a
    // badge; null is the absence of one and must not.
    expect(averageSourceSimilarity([kb(0)])).toBe(0);
  });
});
