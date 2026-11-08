import { describe, expect, it } from 'vitest';
import { BulkUpdatePageAiPolicySchema, DeclareProviderLocalitySchema, UpdatePageAiPolicySchema } from './ai-policy.js';

describe('policy mutation revision precision', () => {
  it.each([Number.MAX_SAFE_INTEGER + 1, '9007199254740993'])('rejects inexact revision %s', (revision) => {
    expect(UpdatePageAiPolicySchema.safeParse({ aiPolicy: 'all', expectedRevision: revision }).success).toBe(false);
    expect(BulkUpdatePageAiPolicySchema.safeParse({ aiPolicy: 'all', items: [{ pageId: 1, expectedRevision: revision }] }).success).toBe(false);
    expect(DeclareProviderLocalitySchema.safeParse({ locality: 'external', expectedConfigRevision: revision }).success).toBe(false);
  });
  it('accepts the exact upper bound', () => {
    expect(UpdatePageAiPolicySchema.parse({ aiPolicy: 'all', expectedRevision: String(Number.MAX_SAFE_INTEGER) }).expectedRevision).toBe(Number.MAX_SAFE_INTEGER);
  });
});
