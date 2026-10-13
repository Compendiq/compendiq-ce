import { z } from 'zod';

/**
 * Article AI policy (SPEC-CORE-001/002). Ordered from least to most strict:
 * `all` lets any authorized provider process the article, `local_only`
 * admits only providers whose locality was explicitly declared `local`, and
 * `none` admits no AI processing at all.
 *
 * `none` is the CANONICAL stored and wire value (operator waiver on #280 —
 * the frontend chips, the EE governance service and the `pages.ai_policy`
 * CHECK all carry `none`). The spec's `no_ai` spelling is accepted on INPUT
 * only, via `AiPolicyInputSchema`, and normalised to `none` before anything
 * is stored or returned.
 */
export const AI_POLICY_LABELS = ['all', 'local_only', 'none'] as const;
export const AiPolicySchema = z.enum(AI_POLICY_LABELS);
export type AiPolicy = z.infer<typeof AiPolicySchema>;

/** Input alias set: everything `AiPolicySchema` takes plus `no_ai`. */
export const AI_POLICY_INPUT_ALIASES = { no_ai: 'none' } as const satisfies Record<string, AiPolicy>;

export function normalizeAiPolicyValue(value: unknown): AiPolicy | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if ((AI_POLICY_LABELS as readonly string[]).includes(v)) return v as AiPolicy;
  const alias = (AI_POLICY_INPUT_ALIASES as Record<string, AiPolicy>)[v];
  return alias ?? null;
}

/** Accepts `all | local_only | none | no_ai` and always yields a canonical `AiPolicy`. */
export const AiPolicyInputSchema = z.enum(['all', 'local_only', 'none', 'no_ai'])
  .transform((v): AiPolicy => normalizeAiPolicyValue(v) ?? 'none');

/** Strictness rank: higher wins when two sources disagree. */
export const AI_POLICY_RANK: Record<AiPolicy, number> = { all: 0, local_only: 1, none: 2 };

export function strictestAiPolicy(...policies: ReadonlyArray<AiPolicy | null | undefined>): AiPolicy {
  let result: AiPolicy = 'all';
  for (const p of policies) {
    if (p && AI_POLICY_RANK[p] > AI_POLICY_RANK[result]) result = p;
  }
  return result;
}

/**
 * Exact label-synonym table (SPEC-CORE-002). Matching is lowercase + trim
 * only — no regex, no fuzzy forms. The SQL twin lives in migration 136
 * (`ai_policy_label_value`); keep both in step.
 */
export const AI_POLICY_LABEL_SYNONYMS: Readonly<Record<string, AiPolicy>> = {
  'all-ai': 'all',
  'ai:all': 'all',
  'local-ai-only': 'local_only',
  'local_only': 'local_only',
  'ai:local': 'local_only',
  'no-ai': 'none',
  'no_ai': 'none',
  'ai:none': 'none',
};

/** The one label written back to `pages.labels` for each canonical policy. */
export const AI_POLICY_CANONICAL_LABELS: Record<AiPolicy, string> = {
  all: 'all-ai',
  local_only: 'local-ai-only',
  none: 'no-ai',
};

export function normalizeAiPolicyLabel(label: unknown): AiPolicy | null {
  if (typeof label !== 'string') return null;
  return AI_POLICY_LABEL_SYNONYMS[label.trim().toLowerCase()] ?? null;
}

export function isReservedAiPolicyLabel(label: unknown): boolean {
  return normalizeAiPolicyLabel(label) !== null;
}

/**
 * Returns the set of distinct policies the labels spell out. More than one
 * distinct value is a label conflict an interactive caller must resolve
 * (422 `ai_policy_label_conflict`); ingestion instead takes the strictest.
 */
export function aiPolicyLabelConflict(labels: ReadonlyArray<string>): AiPolicy[] {
  const found = new Set<AiPolicy>();
  for (const l of labels) {
    const p = normalizeAiPolicyLabel(l);
    if (p) found.add(p);
  }
  return [...found];
}

/** Drops every reserved policy label and appends the canonical one for `policy`. */
export function applyCanonicalAiPolicyLabel(labels: ReadonlyArray<string>, policy: AiPolicy): string[] {
  const kept = labels.filter((l) => !isReservedAiPolicyLabel(l));
  if (policy === 'all') return kept;
  return [...kept, AI_POLICY_CANONICAL_LABELS[policy]];
}

/** Provider locality. Unknown is never `local`: the column defaults `external`. */
export const PROVIDER_LOCALITIES = ['local', 'external'] as const;
export const ProviderLocalitySchema = z.enum(PROVIDER_LOCALITIES);
export type ProviderLocality = z.infer<typeof ProviderLocalitySchema>;

/** Reason persisted beside a worker status of `policy_blocked`. */
export const AI_POLICY_BLOCK_REASONS = ['policy_none', 'provider_not_local', 'policy_changed'] as const;
export const AiPolicyBlockReasonSchema = z.enum(AI_POLICY_BLOCK_REASONS);
export type AiPolicyBlockReason = z.infer<typeof AiPolicyBlockReasonSchema>;

/**
 * Reasons an interactive admission can refuse. The first two are the policy
 * decisions proper; the rest are fail-closed outcomes — a missing page, a
 * stage with no assignment, or an unreadable policy/provider never admits.
 */
export const AI_POLICY_ADMISSION_BLOCK_REASONS = [
  'policy_none', 'provider_not_local', 'not_found', 'stage_disabled', 'policy_unavailable',
] as const;
export type AiPolicyAdmissionBlockReason = (typeof AI_POLICY_ADMISSION_BLOCK_REASONS)[number];

/** Current provenance schema version written with exchanges and caches. */
export const AI_POLICY_PROVENANCE_VERSION = 1;

const PageIdSchema = z.coerce.number().int().positive();
const RevisionSchema = z.coerce.number().int().nonnegative();

/** PUT /api/pages/:id/ai-policy */
export const UpdatePageAiPolicySchema = z.object({
  aiPolicy: AiPolicyInputSchema,
  expectedRevision: RevisionSchema,
}).strict();
export type UpdatePageAiPolicyInput = z.infer<typeof UpdatePageAiPolicySchema>;

/** POST /api/pages/bulk/ai-policy — all-or-nothing. */
export const BulkUpdatePageAiPolicySchema = z.object({
  aiPolicy: AiPolicyInputSchema,
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
  aiPolicy: AiPolicySchema,
  aiPolicyRevision: z.number().int().nonnegative(),
});
export type PageAiPolicyResponse = z.infer<typeof PageAiPolicyResponseSchema>;

/**
 * Policy fields carried by `GET /api/pages/:id`. All optional: a reader that
 * cannot establish the value (policy column unreadable) omits them rather
 * than inventing `all`. `aiPolicyActivation` reports whether the enforcing
 * worker/provider path is live (`active`) or only the schema and writers
 * exist (`foundation_only`).
 */
export const AI_POLICY_ACTIVATIONS = ['active', 'foundation_only'] as const;
export const AiPolicyActivationSchema = z.enum(AI_POLICY_ACTIVATIONS);
export type AiPolicyActivation = z.infer<typeof AiPolicyActivationSchema>;

export const PageAiPolicyDetailFieldsSchema = z.object({
  aiPolicy: AiPolicySchema.optional(),
  aiPolicyRevision: z.number().int().nonnegative().optional(),
  canChangeAiPolicy: z.boolean().optional(),
  aiPolicyActivation: AiPolicyActivationSchema.optional(),
});
export type PageAiPolicyDetailFields = z.infer<typeof PageAiPolicyDetailFieldsSchema>;

/** Error codes the policy routes answer with. */
export const AI_POLICY_ERROR_CODES = {
  denied: 'ai_policy_denied',                                  // 403
  conflict: 'ai_policy_conflict',                              // 409 stale revision
  labelConflict: 'ai_policy_label_conflict',                   // 422
  enforcementUnavailable: 'ai_policy_enforcement_unavailable', // 409 foundation-only
  unavailable: 'ai_policy_unavailable',                        // 503
} as const;

/** 403 body: the caller may not change policy on these pages; no row changed. */
export const AiPolicyDeniedSchema = z.object({
  error: z.literal('ai_policy_denied'),
  pageIds: z.array(z.number().int().positive()),
});
export type AiPolicyDenied = z.infer<typeof AiPolicyDeniedSchema>;

/** 409 body for a stale mutation; no row changed. */
export const AiPolicyConflictSchema = z.object({
  error: z.literal('ai_policy_conflict'),
  reason: z.literal('stale_revision'),
  pageIds: z.array(z.number().int().positive()),
});
export type AiPolicyConflict = z.infer<typeof AiPolicyConflictSchema>;

/** 422 body: explicit policy and labels disagree, or labels disagree among themselves. */
export const AiPolicyLabelConflictSchema = z.object({
  error: z.literal('ai_policy_label_conflict'),
  policies: z.array(AiPolicySchema),
});
export type AiPolicyLabelConflict = z.infer<typeof AiPolicyLabelConflictSchema>;

/**
 * Receiving stages that each apply article AI policy independently
 * (SPEC-RAG-001). Locality is evaluated per stage, never inherited.
 */
export const AI_POLICY_STAGES = [
  'embedding', 'shadow_embedding', 'rerank', 'vision', 'chat', 'summary', 'quality', 'auto_tagging',
] as const;
export const AiPolicyStageSchema = z.enum(AI_POLICY_STAGES);
export type AiPolicyStage = z.infer<typeof AiPolicyStageSchema>;

/**
 * Refusal error codes for continuation / cache reuse (SPEC-RAG-002).
 * `ai_history_not_replayable` (409): a prior turn's grounding is no longer
 * admissible for the provider that would answer now, or was never recorded.
 * `ai_policy_unavailable` (503): the policy or provider state could not be
 * read — retryable, never a statement about the article.
 * `ai_policy_provider_revision_mismatch` (409): the bound chat provider's
 * `config_revision` moved between admission and dispatch (or during a
 * sub-page traversal).
 * `ai_policy_provider_locality_mismatch` (409): the provider's effective
 * locality moved at the SAME configuration revision (a declaration was
 * made or withdrawn underneath the request).
 */
export const AI_POLICY_REFUSAL_CODES = [
  'ai_history_not_replayable',
  'ai_policy_unavailable',
  'ai_policy_provider_revision_mismatch',
  'ai_policy_provider_locality_mismatch',
] as const;
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

/**
 * Per-assistant-turn provenance persisted inside `llm_conversations.messages`
 * (#282): WHICH provider, at WHICH configuration revision and effective
 * locality, saw WHICH pages at WHICH policy revision. A continuation
 * replays a turn only after every page here is re-admitted against the
 * provider answering now; a turn without this record is never replayed.
 * `contentRevision` is `pages.content_revision` as the model saw it: a body
 * edit moves it, so a cached answer or a replayed turn grounded on the old
 * text is recognised as stale.
 */
export const ConversationTurnAiProvenancePageSchema = z.object({
  pageId: z.number().int().positive(),
  policy: AiPolicySchema,
  policyRevision: z.number().int().nonnegative(),
  contentRevision: z.number().int().nonnegative(),
}).strict();
export type ConversationTurnAiProvenancePage = z.infer<typeof ConversationTurnAiProvenancePageSchema>;

export const ConversationTurnAiProvenanceSchema = z.object({
  version: z.literal(AI_POLICY_PROVENANCE_VERSION),
  providerId: z.string().min(1),
  configRevision: z.number().int().nonnegative(),
  locality: ProviderLocalitySchema,
  pages: z.array(ConversationTurnAiProvenancePageSchema),
}).strict();
export type ConversationTurnAiProvenance = z.infer<typeof ConversationTurnAiProvenanceSchema>;

/** PUT /api/admin/llm-providers/:id/locality */
export const DeclareProviderLocalitySchema = z.object({
  locality: ProviderLocalitySchema,
  expectedConfigRevision: RevisionSchema,
}).strict();
export type DeclareProviderLocalityInput = z.infer<typeof DeclareProviderLocalitySchema>;
