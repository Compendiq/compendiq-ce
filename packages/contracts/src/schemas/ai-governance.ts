import { z } from 'zod';
import { AiPolicySchema, ProviderLocalitySchema } from './ai-policy.js';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const AiOperationContextSchema = z.object({
  operationId: z.string().min(1),
  actor: z.object({ kind: z.enum(['user', 'worker', 'service', 'unknown']), id: z.string().min(1).nullable() }).strict(),
  source: z.string().min(1),
  cascadeId: z.string().min(1).nullable(),
}).strict();
export type AiOperationContext = z.infer<typeof AiOperationContextSchema>;

/** One event per stage/attempt, NOT per article. No content or usage fields. */
export const AiDecisionEventSchema = AiOperationContextSchema.extend({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  type: z.literal('decision'),
  usecase: z.string().min(1),
  stage: z.string().min(1),
  attempt: z.number().int().positive(),
  articles: z.array(z.object({
    pageId: z.number().int().positive(),
    policy: AiPolicySchema.nullable(),
    policyRevision: revision.nullable(),
    contentRevision: revision.nullable(),
  }).strict()),
  provider: z.object({
    providerId: z.string().min(1),
    configRevision: revision.nullable(),
    declaredLocality: ProviderLocalitySchema.nullable(),
    effectiveLocality: ProviderLocalitySchema.nullable(),
  }).strict().nullable(),
  decision: z.enum(['admitted', 'blocked']),
  reason: z.string().min(1),
}).strict();
export type AiDecisionEvent = z.infer<typeof AiDecisionEventSchema>;

/** Persist on the mutation's held client; rollback must roll this back too. */
export const AiPolicyChangeEventSchema = AiOperationContextSchema.extend({
  eventId: z.string().uuid(),
  occurredAt: z.string().datetime(),
  type: z.literal('policy_change'),
  changes: z.array(z.object({
    pageId: z.number().int().positive(),
    oldPolicy: AiPolicySchema,
    newPolicy: AiPolicySchema,
    oldRevision: revision,
    newRevision: revision,
  }).strict()).min(1),
}).strict();
export type AiPolicyChangeEvent = z.infer<typeof AiPolicyChangeEventSchema>;
