/**
 * Shared schemas for the AI output review workflow (EE #120).
 *
 * The CE side (this PR) defines the wire shapes the UI submits and
 * renders. The EE overlay (PR #122 — already merged) implements the
 * routes themselves: `overlay/backend/src/routes/foundation/ai-reviews.ts`
 * and `overlay/backend/src/enterprise/ai-review-service.ts`. Until the
 * overlay is loaded, the routes 404 in CE-only deployments and the UI
 * surfaces a "Requires Enterprise" notice — same pattern as
 * IpAllowlistTab and WebhooksTab.
 *
 * Two reasons the schemas live in CE rather than the overlay:
 *
 *   1. The CE frontend ships in both editions (single image — see
 *      `ce/CLAUDE.md` → "Frontend (CE image, no overlay)") and needs the
 *      types to compile against, even though the runtime is gated by
 *      `useEnterprise().hasFeature('ai_output_review')`.
 *   2. Keeping the contract in `@compendiq/contracts` means the EE
 *      overlay validates inputs against the same shape the UI submits —
 *      no drift between client and server.
 *
 * Wire-shape source of truth: the actual routes in
 * `overlay/backend/src/routes/foundation/ai-reviews.ts`. Note that the
 * statuses use a hyphenated form (`edit-and-approved`) on the wire;
 * the AuditAction union uses underscores (`AI_REVIEW_EDIT_AND_APPROVED`).
 */

import { z } from 'zod';

// ── Action types ──────────────────────────────────────────────────────────
//
// Mirrors `AiReviewAction` in `ce/backend/src/core/services/ai-review-hook.ts`
// and the per-action override keys validated by the overlay route. New
// AI surfaces routed through `enqueueAiReview` must be added here so the
// admin policy UI picks them up automatically.

export const AI_REVIEW_ACTION_TYPES = [
  'improve',
  'summary',
  'generate',
  'auto_tag',
  'apply_improvement',
] as const;

export const AiReviewActionSchema = z.enum(AI_REVIEW_ACTION_TYPES);

export type AiReviewAction = z.infer<typeof AiReviewActionSchema>;

/** Human-readable labels for the policy UI / queue cards. */
export const AI_REVIEW_ACTION_LABELS: Readonly<Record<AiReviewAction, string>> =
  Object.freeze({
    improve: 'Improve',
    summary: 'Summary',
    generate: 'Generate',
    auto_tag: 'Auto-tag',
    apply_improvement: 'Apply improvement',
  });

// ── Status ────────────────────────────────────────────────────────────────
//
// Wire form (hyphenated) — matches `ListQuerySchema` in the overlay route.
// `expired` is set by the daily expire job, never by user action.

export const AI_REVIEW_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'edit-and-approved',
  'expired',
] as const;

export const AiReviewStatusSchema = z.enum(AI_REVIEW_STATUSES);

export type AiReviewStatus = z.infer<typeof AiReviewStatusSchema>;

// ── Review record ─────────────────────────────────────────────────────────
//
// Two shapes: the list endpoint returns a thin row (no body content), the
// detail endpoint returns the full record with the proposed bodies and
// the page's *current* body for diff rendering. Authoring a single
// optional-everywhere schema would compromise typing on the diff page —
// keep them separate.

/** Row shape returned by `GET /api/ai-reviews?status=…`. */
export const AiReviewListItemSchema = z.object({
  id: z.string().uuid(),
  page_id: z.number().int(),
  action_type: AiReviewActionSchema,
  authored_by: z.string().uuid(),
  authored_at: z.string(),
  status: AiReviewStatusSchema,
});

export type AiReviewListItem = z.infer<typeof AiReviewListItemSchema>;

export const AiReviewListResponseSchema = z.object({
  reviews: z.array(AiReviewListItemSchema),
});

export type AiReviewListResponse = z.infer<typeof AiReviewListResponseSchema>;

/** Full review row joined with `pages` columns, returned by `GET /:id`. */
export const AiReviewDetailSchema = z.object({
  id: z.string().uuid(),
  page_id: z.number().int(),
  action_type: AiReviewActionSchema,
  proposed_content: z.string(),
  proposed_html: z.string().nullable(),
  authored_by: z.string().uuid(),
  authored_at: z.string(),
  status: AiReviewStatusSchema,
  reviewed_by: z.string().uuid().nullable(),
  reviewed_at: z.string().nullable(),
  review_notes: z.string().nullable(),
  edited_content: z.string().nullable(),
  pii_findings_id: z.string().uuid().nullable(),
  expires_at: z.string().nullable(),
  page_title: z.string().nullable(),
  current_body_html: z.string().nullable(),
  current_body_text: z.string().nullable(),
});

export type AiReviewDetail = z.infer<typeof AiReviewDetailSchema>;

export const AiReviewDetailResponseSchema = z.object({
  review: AiReviewDetailSchema,
});

export type AiReviewDetailResponse = z.infer<typeof AiReviewDetailResponseSchema>;

// ── Action requests ───────────────────────────────────────────────────────

export const ApproveReviewRequestSchema = z.object({
  notes: z.string().max(4000).optional(),
});

export type ApproveReviewRequest = z.infer<typeof ApproveReviewRequestSchema>;

export const RejectReviewRequestSchema = z.object({
  notes: z.string().max(4000).optional(),
});

export type RejectReviewRequest = z.infer<typeof RejectReviewRequestSchema>;

export const EditAndApproveRequestSchema = z.object({
  editedContent: z.string().min(1).max(1_000_000),
  notes: z.string().max(4000).optional(),
});

export type EditAndApproveRequest = z.infer<typeof EditAndApproveRequestSchema>;

/** All three action endpoints currently return `{ ok: true }`. */
export const AiReviewActionResponseSchema = z.object({
  ok: z.literal(true),
});

export type AiReviewActionResponse = z.infer<typeof AiReviewActionResponseSchema>;

// ── Policy ────────────────────────────────────────────────────────────────
//
// Mirrors the `PolicySchema` in the overlay route file verbatim. The
// per-action overrides are a closed partial — Zod v4 record() with a
// closed-literal union requires every key, so the overlay models them
// as an explicit object with each action `.optional()`. We do the same.

export const AI_REVIEW_MODES = [
  'auto-publish',
  'review-required',
  'review-required-with-blocking-pii',
] as const;

export const AiReviewModeSchema = z.enum(AI_REVIEW_MODES);

export type AiReviewMode = z.infer<typeof AiReviewModeSchema>;

/** Human labels for the radio group in the policy UI. */
export const AI_REVIEW_MODE_LABELS: Readonly<Record<AiReviewMode, string>> =
  Object.freeze({
    'auto-publish': 'Auto-publish',
    'review-required': 'Review required',
    'review-required-with-blocking-pii': 'Review required (block on PII)',
  });

export const AiReviewPolicySchema = z.object({
  enabled: z.boolean(),
  default_mode: AiReviewModeSchema,
  per_action_overrides: z.object({
    improve: AiReviewModeSchema.optional(),
    summary: AiReviewModeSchema.optional(),
    generate: AiReviewModeSchema.optional(),
    auto_tag: AiReviewModeSchema.optional(),
    apply_improvement: AiReviewModeSchema.optional(),
  }),
  expire_after_days: z.number().int().min(1).max(365),
});

export type AiReviewPolicy = z.infer<typeof AiReviewPolicySchema>;

export const AiReviewPolicyResponseSchema = z.object({
  policy: AiReviewPolicySchema,
});

export type AiReviewPolicyResponse = z.infer<typeof AiReviewPolicyResponseSchema>;
