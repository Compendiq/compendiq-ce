import { z } from 'zod';

/**
 * Article AI policy (SPEC-CORE-001/002). Ordered from least to most strict:
 * `all` lets any authorized provider process the article, `local_only`
 * admits only providers whose locality was explicitly declared `local`, and
 * `none` admits no AI processing at all.
 */
export const AI_POLICY_LABELS = ['all', 'local_only', 'none'] as const;
export const AiPolicySchema = z.enum(AI_POLICY_LABELS);
export type AiPolicy = z.infer<typeof AiPolicySchema>;

/** Provider locality. Unknown is never `local`: the column defaults `external`. */
export const PROVIDER_LOCALITIES = ['local', 'external'] as const;
export const ProviderLocalitySchema = z.enum(PROVIDER_LOCALITIES);
export type ProviderLocality = z.infer<typeof ProviderLocalitySchema>;

/** Reason persisted beside a worker status of `policy_blocked`. */
export const AI_POLICY_BLOCK_REASONS = ['policy_none', 'provider_not_local', 'policy_changed'] as const;
export const AiPolicyBlockReasonSchema = z.enum(AI_POLICY_BLOCK_REASONS);
export type AiPolicyBlockReason = z.infer<typeof AiPolicyBlockReasonSchema>;

/** Current provenance schema version written with exchanges and caches. */
export const AI_POLICY_PROVENANCE_VERSION = 1;

const PageIdSchema = z.coerce.number().int().positive();
const RevisionSchema = z.coerce.number().int().nonnegative();

/** PUT /api/pages/:id/ai-policy */
export const UpdatePageAiPolicySchema = z.object({
  policy: AiPolicySchema,
  expectedRevision: RevisionSchema,
}).strict();
export type UpdatePageAiPolicyInput = z.infer<typeof UpdatePageAiPolicySchema>;

/** POST /api/pages/bulk/ai-policy — all-or-nothing. */
export const BulkUpdatePageAiPolicySchema = z.object({
  policy: AiPolicySchema,
  items: z.array(z.object({
    pageId: PageIdSchema,
    expectedRevision: RevisionSchema,
  }).strict()).min(1).max(1000),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<number>();
  for (const [index, item] of value.items.entries()) {
    if (seen.has(item.pageId)) {
      ctx.addIssue({ code: 'custom', path: ['items', index, 'pageId'], message: 'duplicate pageId' });
    }
    seen.add(item.pageId);
  }
});
export type BulkUpdatePageAiPolicyInput = z.infer<typeof BulkUpdatePageAiPolicySchema>;

export const PageAiPolicyResponseSchema = z.object({
  pageId: z.number().int().positive(),
  policy: AiPolicySchema,
  revision: z.number().int().nonnegative(),
});
export type PageAiPolicyResponse = z.infer<typeof PageAiPolicyResponseSchema>;

/** 409 body for a stale or mixed-unauthorized mutation; no row changed. */
export const AiPolicyConflictSchema = z.object({
  error: z.literal('ai_policy_conflict'),
  reason: z.enum(['stale_revision', 'not_authorized', 'not_found']),
  pageIds: z.array(z.number().int().positive()),
});
export type AiPolicyConflict = z.infer<typeof AiPolicyConflictSchema>;

/**
 * Receiving stages that each apply article AI policy independently
 * (SPEC-RAG-001). Locality is evaluated per stage, never inherited.
 */
export const AI_POLICY_STAGES = [
  'embedding', 'shadow_embedding', 'rerank', 'vision', 'chat', 'summary', 'quality', 'auto_tagging',
] as const;
export const AiPolicyStageSchema = z.enum(AI_POLICY_STAGES);
export type AiPolicyStage = z.infer<typeof AiPolicyStageSchema>;

/** Refusal error codes for continuation / cache reuse (SPEC-RAG-002). */
export const AI_POLICY_REFUSAL_CODES = ['ai_history_not_replayable', 'ai_policy_unavailable'] as const;
export const AiPolicyRefusalCodeSchema = z.enum(AI_POLICY_REFUSAL_CODES);
export type AiPolicyRefusalCode = z.infer<typeof AiPolicyRefusalCodeSchema>;

export const AiPolicyRefusalSchema = z.object({
  error: AiPolicyRefusalCodeSchema,
  stage: AiPolicyStageSchema.optional(),
}).strict();
export type AiPolicyRefusal = z.infer<typeof AiPolicyRefusalSchema>;

/** Authenticated browser policy handshake response. */
export const AiPolicyHandshakeSchema = z.object({
  pageId: z.number().int().positive(),
  policy: AiPolicySchema,
  revision: z.number().int().nonnegative(),
  provenanceVersion: z.literal(AI_POLICY_PROVENANCE_VERSION),
}).strict();
export type AiPolicyHandshake = z.infer<typeof AiPolicyHandshakeSchema>;

/** PUT /api/admin/llm-providers/:id/locality */
export const DeclareProviderLocalitySchema = z.object({
  locality: ProviderLocalitySchema,
  expectedConfigRevision: RevisionSchema,
}).strict();
export type DeclareProviderLocalityInput = z.infer<typeof DeclareProviderLocalitySchema>;
