import { describe, expect, it } from 'vitest';
import { AiDecisionEventSchema, AiPolicyChangeEventSchema } from './ai-governance.js';

const context = { eventId: '8d7cbb16-d6ac-4ba9-b81d-e0c1e439958e', occurredAt: '2026-10-17T00:00:00.000Z', operationId: 'operation-1', actor: { kind: 'worker', id: 'worker-1' }, source: 'embedding', cascadeId: null };
describe('typed governance contract', () => {
  it('preserves every association and explicit unknown destination', () => {
    const event = { ...context, type: 'decision', usecase: 'embedding', stage: 'shadow_embedding', attempt: 2, articles: [{ pageId: 1, policy: 'all', policyRevision: 4, contentRevision: 5 }, { pageId: 2, policy: null, policyRevision: null, contentRevision: null }], provider: null, decision: 'blocked', reason: 'policy_unavailable' };
    expect(AiDecisionEventSchema.parse(event)).toEqual(event);
    expect(AiDecisionEventSchema.safeParse({ ...event, prompt: 'private' }).success).toBe(false);
    expect(AiDecisionEventSchema.safeParse({ ...event, attempt: 0 }).success).toBe(false);
  });
  it('requires precise change revisions and forbids content fields', () => {
    const event = { ...context, type: 'policy_change', changes: [{ pageId: 1, oldPolicy: 'none', newPolicy: 'all', oldRevision: 4, newRevision: 5 }] };
    expect(AiPolicyChangeEventSchema.parse(event)).toEqual(event);
    expect(AiPolicyChangeEventSchema.safeParse({ ...event, changes: [{ ...event.changes[0], title: 'private' }] }).success).toBe(false);
    expect(AiPolicyChangeEventSchema.safeParse({ ...event, changes: [] }).success).toBe(false);
  });
});
