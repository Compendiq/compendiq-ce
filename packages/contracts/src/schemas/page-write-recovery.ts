import { z } from 'zod';

const RuntimeIdSchema = z.string().min(1).max(200);
const RuntimeIdentitySchema = z.object({
  host: z.string().min(1).max(255),
  pid: z.number().int().positive(),
  startedAt: z.string().datetime(),
});
const RecoveryReasonSchema = z.string().trim().min(10).max(1000);
const PageIdSchema = z.number().int().positive().max(2147483647);

export const PageWriteRecoveryQuerySchema = z.object({
  pageId: z.coerce.number().int().positive().max(2147483647).optional(),
}).strict();
export const PageWriterQuiesceSchema = z.object({
  expectedRuntimeId: RuntimeIdSchema,
  reason: RecoveryReasonSchema,
}).strict();
export const PageWriterRuntimeParamSchema = z.object({ runtimeId: RuntimeIdSchema }).strict();
export const PageWriterFenceSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('owner_ack'),
    acknowledgmentId: z.string().uuid(),
    reason: RecoveryReasonSchema,
  }).strict(),
  z.object({
    mode: z.literal('durable_no_started_effects'),
    reason: RecoveryReasonSchema,
  }).strict(),
  z.object({
    mode: z.literal('verified_local_termination'),
    reason: RecoveryReasonSchema,
  }).strict(),
]);
export const PageWriteIntentParamSchema = z.object({ intentId: z.string().uuid() }).strict();
export const PageWriteReconcileSchema = z.object({ reason: RecoveryReasonSchema }).strict();

/** Admin diagnostics expose identity and state, never effect descriptors or payloads. */
export const PageWriteRecoveryStateSchema = z.object({
  limitPerCollection: z.literal(500),
  truncated: z.object({ intents: z.boolean(), admissions: z.boolean(), runtimes: z.boolean() }),
  intents: z.array(z.object({
    id: z.string().uuid(),
    runtimeId: RuntimeIdSchema,
    pageIds: z.array(PageIdSchema),
    kind: z.string().max(100),
    createdAt: z.string().datetime(),
    effectStartedAt: z.string().datetime().nullable(),
    effectFinishedAt: z.string().datetime().nullable(),
    remoteEffectStartedAt: z.string().datetime().nullable(),
    remoteEffectsCompletedAt: z.string().datetime().nullable(),
    recoveryStartedAt: z.string().datetime().nullable(),
    recoveryMode: z.enum(['local_verified', 'remote_conditional', 'remote_terminal_only']),
  })).max(500),
  admissions: z.array(z.object({
    id: z.string().uuid(),
    runtimeId: RuntimeIdSchema,
    pageId: PageIdSchema,
    lifecycleRevision: z.string().regex(/^\d+$/),
    admittedAt: z.string().datetime(),
  })).max(500),
  runtimes: z.array(z.object({
    runtimeId: RuntimeIdSchema,
    deploymentIdentity: RuntimeIdentitySchema,
    startedAt: z.string().datetime(),
    quiescedAt: z.string().datetime().nullable(),
    acknowledgmentId: z.string().uuid().nullable(),
    fencedAt: z.string().datetime().nullable(),
    fenceReason: z.string().max(1000).nullable(),
  })).max(500),
});
export type PageWriteRecoveryState = z.infer<typeof PageWriteRecoveryStateSchema>;

export const PageWriterQuiesceResultSchema = z.object({
  runtimeId: RuntimeIdSchema,
  acknowledgmentId: z.string().uuid(),
  deploymentIdentity: RuntimeIdentitySchema,
});
export const PageWriterFenceResultSchema = z.object({ unresolvedIntents: z.number().int().nonnegative() });
export const PageWriteReconcileResultSchema = z.object({
  intentId: z.string().uuid(),
  status: z.enum(['reconciled_applied', 'reconciled_not_applied']),
});
