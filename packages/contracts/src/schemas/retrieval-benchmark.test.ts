import { describe, expect, it } from 'vitest';
import { RetrievalBenchmarkRequestSchema } from './admin.js';

describe('RetrievalBenchmarkRequestSchema', () => {
  it('defaults to a bounded recent production-query run', () => {
    expect(RetrievalBenchmarkRequestSchema.parse({})).toEqual({
      source: 'recent-queries',
      days: 30,
      limit: 25,
      topK: 5,
    });
  });

  it('requires labels to be explicit custom input, never inferred from dev fixture data', () => {
    expect(() => RetrievalBenchmarkRequestSchema.parse({ source: 'custom' })).toThrow();
    expect(() => RetrievalBenchmarkRequestSchema.parse({ source: 'recent-queries', queries: [{ query: 'question' }] })).toThrow();
    expect(RetrievalBenchmarkRequestSchema.parse({
      source: 'custom',
      queries: [{ query: 'where is sync configured?', expectedPageIds: [42] }],
    }).source).toBe('custom');
  });
});
