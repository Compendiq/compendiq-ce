import { describe, expect, it } from 'vitest';
import { ShadowCompareRequestSchema, ShadowCompareJudgementRequestSchema } from './admin.js';

// #1260 — the shadow-migration comparison request and the Mode 2 judgement.

describe('ShadowCompareRequestSchema', () => {
  it('defaults to a bounded frequency-sampled run', () => {
    expect(ShadowCompareRequestSchema.parse({})).toEqual({ days: 30, limit: 50, topK: 10 });
  });

  it('bounds every knob (days ≤ 90, limit ≤ 100, topK ≤ 20)', () => {
    expect(() => ShadowCompareRequestSchema.parse({ days: 0 })).toThrow();
    expect(() => ShadowCompareRequestSchema.parse({ days: 91 })).toThrow();
    expect(() => ShadowCompareRequestSchema.parse({ limit: 0 })).toThrow();
    expect(() => ShadowCompareRequestSchema.parse({ limit: 101 })).toThrow();
    expect(() => ShadowCompareRequestSchema.parse({ topK: 0 })).toThrow();
    expect(() => ShadowCompareRequestSchema.parse({ topK: 21 })).toThrow();
    expect(ShadowCompareRequestSchema.parse({ days: 90, limit: 100, topK: 20 })).toEqual({
      days: 90,
      limit: 100,
      topK: 20,
    });
  });

  it('refuses non-integers', () => {
    expect(() => ShadowCompareRequestSchema.parse({ topK: 2.5 })).toThrow();
  });
});

describe('ShadowCompareJudgementRequestSchema', () => {
  it('accepts the four sides and a query id', () => {
    for (const side of ['live', 'candidate', 'neither', 'both'] as const) {
      expect(ShadowCompareJudgementRequestSchema.parse({ queryId: 'q-1', side })).toEqual({
        queryId: 'q-1',
        side,
      });
    }
  });

  it('refuses an unknown side or an empty query id', () => {
    expect(() => ShadowCompareJudgementRequestSchema.parse({ queryId: 'q-1', side: 'draw' })).toThrow();
    expect(() => ShadowCompareJudgementRequestSchema.parse({ queryId: '', side: 'live' })).toThrow();
  });
});
