import { describe, it, expect } from 'vitest';
import { EmbeddingStatusSchema } from './llm.js';
import { PageListQuerySchema } from './pages.js';

describe('worker policy status contracts', () => {
  it('preserves blocked counts and reasons without implying provider errors', () => {
    const parsed = EmbeddingStatusSchema.parse({ totalPages: 5, dirtyPages: 3, totalEmbeddings: 2,
      isProcessing: false, policyBlockedPages: 3,
      policyBlockedReasons: { policy_none: 1, provider_not_local: 2, unknown: 0 } });
    expect(parsed.policyBlockedPages).toBe(3);
    expect(parsed.policyBlockedReasons?.provider_not_local).toBe(2);
  });
  it('accepts the stored policy-blocked quality status as a list filter', () => {
    expect(PageListQuerySchema.parse({ qualityStatus: 'policy_blocked' }).qualityStatus).toBe('policy_blocked');
  });
});
