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
  /** Null only when durable allocation failed before admission; never invent 1. */
  attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  articles: z.array(z.object({
    pageId: z.number().int().positive(),
    policy: AiPolicySchema.nullable(),
    policyRevision: revision.nullable(),
    contentRevision: revision.nullable(),
  }).strict()),
  provider: z.object({
    providerId: z.string().min(1),
    /** Concrete receiving model when established, never inferred from an assignment later. */
    model: z.string().min(1).nullable().optional(),
    configRevision: revision.nullable(),
    declaredLocality: ProviderLocalitySchema.nullable(),
    effectiveLocality: ProviderLocalitySchema.nullable(),
  }).strict().nullable(),
  decision: z.enum(['admitted', 'blocked']),
  reason: z.string().min(1),
}).strict().refine((event) => event.attempt !== null
  || (event.decision === 'blocked' && event.reason === 'policy_unavailable'),
{ message: 'Unknown attempt is only valid for unavailable pre-admission refusals', path: ['attempt'] });
/** Historical decoder remains lossless: omitted legacy model is not rewritten.
 * New typed producers must explicitly record the model or its unknown state. */
export type AiDecisionEvent = z.infer<typeof AiDecisionEventSchema>;
export type AiDecisionObservation = Omit<AiDecisionEvent, 'provider'> & {
  provider: (NonNullable<z.infer<typeof AiDecisionEventSchema>['provider']> & { model: string | null }) | null;
};

/** New observations must not silently omit model evidence. Historical readers
 * use AiDecisionEventSchema instead, preserving original persisted payloads. */
export const AiDecisionObservationSchema = AiDecisionEventSchema.refine(
  (event) => event.provider === null || event.provider.model !== undefined,
  { message: 'New observations require a model or explicit null', path: ['provider', 'model'] },
).transform((event): AiDecisionObservation => event as AiDecisionObservation);

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
