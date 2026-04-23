/**
 * Extension point for the AI output review queue (EE #120).
 *
 * CE builds install no hook — enqueueAiReview returns `{ mode: 'auto-publish' }`
 * so inference routes persist AI output directly, unchanged from pre-v0.4.
 * The EE plugin registers a sync review-queue service at `registerRoutes()`
 * time; when registered, inference routes read the decision and branch:
 *   - 'auto-publish' → existing fast-path, persist directly
 *   - 'pending'      → return reviewId and DO NOT persist; the admin
 *                      review UI consumes from the `ai_output_reviews`
 *                      table later.
 *
 * Mirrors the llm-audit-hook pattern, but synchronously (must decide
 * before persistence branch).
 */

export type AiReviewAction =
  | 'improve'
  | 'summary'
  | 'generate'
  | 'auto_tag'
  | 'apply_improvement';

export type AiReviewDecision =
  | { mode: 'auto-publish' }
  | { mode: 'pending'; reviewId: string };

export interface EnqueueParams {
  pageId: number;
  actionType: AiReviewAction;
  proposedContent: string;
  proposedHtml?: string;
  proposedStorage?: string;
  authoredBy: string;
  llmAuditId: number;
  piiFindingsId?: string;
}

type EnqueueHook = (params: EnqueueParams) => Promise<AiReviewDecision>;
type PendingCheckHook = (pageId: number) => Promise<{ id: string } | null>;

let enqueueHook: EnqueueHook | null = null;
let pendingCheckHook: PendingCheckHook | null = null;

/**
 * Install the EE-side review-queue hook. Call from the enterprise
 * plugin's `registerRoutes()` during startup. Pass `null` to uninstall.
 */
export function setAiReviewHook(fn: EnqueueHook | null): void {
  enqueueHook = fn;
}

/**
 * Install the publish-path gate checker. Called from the CE publish
 * route (`POST /api/pages/:id/draft/publish`) before the upstream
 * Confluence push. EE returns the pending review row if one exists so
 * the CE route can 409 with a clear error.
 */
export function setPendingAiReviewCheckHook(fn: PendingCheckHook | null): void {
  pendingCheckHook = fn;
}

/**
 * Decide whether AI output should be auto-published or queued. In CE
 * mode (no hook installed) always returns 'auto-publish'.
 */
export async function enqueueAiReview(params: EnqueueParams): Promise<AiReviewDecision> {
  if (!enqueueHook) return { mode: 'auto-publish' };
  try {
    return await enqueueHook(params);
  } catch {
    // Fail-open on review-service errors — never block the user's
    // generation because the queue misbehaved. EE service logs internally.
    return { mode: 'auto-publish' };
  }
}

/**
 * Check for a pending review against this page. In CE mode returns null.
 */
export async function checkPendingAiReview(pageId: number): Promise<{ id: string } | null> {
  if (!pendingCheckHook) return null;
  try {
    return await pendingCheckHook(pageId);
  } catch {
    return null;
  }
}

/** Test helpers — reset hooks between test cases. */
export function _resetAiReviewHooksForTests(): void {
  enqueueHook = null;
  pendingCheckHook = null;
}
