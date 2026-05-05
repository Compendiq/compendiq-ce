/**
 * Webhook emit hook extension point (Compendiq/compendiq-ee#114).
 *
 * Mirror of the `llm-audit-hook.ts` pattern: the CE codebase declares the
 * emit surface but ships no implementation. CE-mode deployments see
 * zero webhook traffic and zero overhead. The EE plugin
 * (`overlay/backend/src/enterprise/webhook-service.ts`) registers the real
 * hook during `registerRoutes()`, which writes to the `webhook_outbox`
 * table in the same transaction as the triggering domain mutation.
 *
 * **Emit sites** (extended incrementally — this PR wires the first batch):
 *   - sync-service: page_created, page_updated, page_deleted, sync_completed
 *   - pages-crud:   local page mutations
 *   - scheduled-workers (EE-only): ai_quality_complete, ai_summary_complete
 *
 * **Design invariants:**
 *   - Fire-and-forget from the call-site's perspective. The actual DB write
 *     inside the hook runs inside the CALLER's transaction when the caller
 *     passes a `pg.PoolClient`; otherwise on a fresh connection.
 *   - Payload size is enforced at insert time by the `webhook_outbox`
 *     service (see plan §1.7). Over-sized events are rejected synchronously
 *     so the caller can decide how to react (today: log and drop).
 *   - Event envelope shape follows the Standard Webhooks spec and is
 *     identical across emit sites.
 */

import type { PoolClient } from 'pg';

/**
 * Canonical set of webhook event types. Extend as new emitters are wired.
 * Receivers filter on this string via their subscription's `event_types`
 * array.
 */
export type WebhookEventType =
  | 'page.created'
  | 'page.updated'
  | 'page.deleted'
  | 'sync.completed'
  | 'ai.quality.complete'
  | 'ai.summary.complete';

export interface WebhookEvent<T = unknown> {
  /** Stable across delivery retries; receivers use this as the dedup key. */
  webhookId?: string;
  eventType: WebhookEventType;
  payload: T;
  /**
   * Optional caller-supplied pg client so the outbox INSERT runs inside the
   * same transaction as the domain mutation. When omitted, the hook writes
   * on a fresh connection (acceptable but gives up exactly-once semantics
   * under crash-during-commit).
   */
  tx?: PoolClient;
}

type WebhookEmitHook = (event: WebhookEvent) => Promise<void>;

let _hook: WebhookEmitHook | null = null;

/**
 * Register the webhook emit implementation. Called once by the EE plugin at
 * startup via `setWebhookEmitHook(enterpriseWebhookService.emit)`.
 */
export function setWebhookEmitHook(hook: WebhookEmitHook): void {
  _hook = hook;
}

/**
 * Emit a webhook event from a call-site. CE-mode deployments (no hook
 * registered) return immediately with zero overhead; EE deployments route
 * to the registered hook which writes to `webhook_outbox`.
 *
 * Fire-and-forget — the hook's promise rejection is caught so emit sites
 * never have error handling for webhook delivery failures (operators see
 * them via the `webhook_deliveries` admin UI instead).
 */
export function emitWebhookEvent<T>(event: WebhookEvent<T>): void {
  if (!_hook) return;
  _hook(event as WebhookEvent).catch(() => {
    /* errors are surfaced via the deliveries table, not the emit site */
  });
}

/**
 * Test seam: reset the hook between tests. Not exported for production code.
 */
export function _resetWebhookEmitHookForTests(): void {
  _hook = null;
}
