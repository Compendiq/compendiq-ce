import { describe, expect, it } from 'vitest';
import { AiDecisionEventSchema, AiDecisionObservationSchema, type AiDecisionObservation } from './ai-governance.js';

const event = {
  type: 'decision', eventId: '00000000-0000-4000-8000-000000000001',
  operationId: 'operation', occurredAt: '2026-10-27T00:00:00.000Z',
  actor: { kind: 'worker', id: 'summary' }, source: 'summary', cascadeId: null,
  usecase: 'summary', stage: 'summary', attempt: 1, articles: [],
  decision: 'admitted', reason: 'allowed',
  provider: { providerId: 'provider', model: 'receiving-model', configRevision: 2,
    declaredLocality: 'local', effectiveLocality: 'local' },
};

// @ts-expect-error New typed producers must explicitly state model knowledge.
const missingModel: NonNullable<AiDecisionObservation['provider']> = { providerId: 'provider', configRevision: 2, declaredLocality: 'local', effectiveLocality: 'local' };

describe('typed receiving-model evidence', () => {
  it('preserves the concrete model through new-event validation and serialization', () => {
    const parsed = AiDecisionObservationSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed.provider?.model).toBe('receiving-model');
  });
  it.each(['admitted', 'blocked'])('rejects omitted model on new %s events without rewriting legacy evidence', (decision) => {
    const legacy = { ...event, decision, provider: missingModel };
    expect(AiDecisionObservationSchema.safeParse(legacy).success).toBe(false);
    expect(AiDecisionEventSchema.parse(legacy)).toEqual(legacy);
  });
  it('preserves explicit unknowns and rejects empty model claims', () => {
    expect(AiDecisionObservationSchema.parse({ ...event, provider: { ...event.provider, model: null } }).provider?.model).toBeNull();
    expect(AiDecisionObservationSchema.safeParse({ ...event, provider: { ...event.provider, model: '' } }).success).toBe(false);
    expect(AiDecisionObservationSchema.parse({ ...event, decision: 'blocked', provider: null }).provider).toBeNull();
  });
});
