import { describe, expect, it } from 'vitest';
import { AiDecisionEventSchema } from './ai-governance.js';

const refusal = {
  type: 'decision', eventId: '00000000-0000-4000-8000-000000000001',
  operationId: '00000000-0000-4000-8000-000000000002', occurredAt: '2026-10-27T00:00:00.000Z',
  actor: { kind: 'worker', id: 'embedding' }, source: 'embedding', cascadeId: null,
  usecase: 'embedding', stage: 'embedding', attempt: null,
  decision: 'blocked', reason: 'policy_unavailable', articles: [], provider: null,
};
describe('durable attempt allocation evidence', () => {
  it('preserves an explicitly unknown ordinal on unavailable refusals', () => {
    expect(AiDecisionEventSchema.parse(refusal).attempt).toBeNull();
  });
  it('never admits an unknown ordinal or fabricates one for missing input', () => {
    expect(AiDecisionEventSchema.safeParse({ ...refusal, decision: 'admitted', reason: 'allowed' }).success).toBe(false);
    expect(AiDecisionEventSchema.safeParse({ ...refusal, reason: 'policy_none' }).success).toBe(false);
    expect(AiDecisionEventSchema.safeParse({ ...refusal, attempt: undefined }).success).toBe(false);
  });
  it('requires safely representable positive known ordinals', () => {
    for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(AiDecisionEventSchema.safeParse({ ...refusal, attempt }).success).toBe(false);
    }
    expect(AiDecisionEventSchema.parse({ ...refusal, attempt: 2 }).attempt).toBe(2);
  });
});
