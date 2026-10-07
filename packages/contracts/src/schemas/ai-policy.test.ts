import { describe, expect, it } from 'vitest';
import {
  AiPolicySchema,
  BulkUpdatePageAiPolicySchema,
  DeclareProviderLocalitySchema,
  UpdatePageAiPolicySchema,
} from './ai-policy.js';

describe('ai-policy contracts', () => {
  it('accepts only the closed label set', () => {
    expect(AiPolicySchema.parse('local_only')).toBe('local_only');
    expect(AiPolicySchema.safeParse('LOCAL').success).toBe(false);
  });

  it('requires a revision guard on single updates', () => {
    expect(UpdatePageAiPolicySchema.safeParse({ policy: 'none' }).success).toBe(false);
    expect(UpdatePageAiPolicySchema.parse({ policy: 'none', expectedRevision: 3 })).toEqual({ policy: 'none', expectedRevision: 3 });
  });

  it('refuses duplicate pages in a bulk request', () => {
    const r = BulkUpdatePageAiPolicySchema.safeParse({
      policy: 'all',
      items: [{ pageId: 1, expectedRevision: 0 }, { pageId: 1, expectedRevision: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it('never accepts an unknown locality', () => {
    expect(DeclareProviderLocalitySchema.safeParse({ locality: 'unknown', expectedConfigRevision: 1 }).success).toBe(false);
  });
});
