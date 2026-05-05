import { z } from 'zod';

/**
 * Shared schemas for the webhook-push admin API (EE #114).
 *
 * These are consumed by the frontend for form typing + request/response
 * shaping, and will be re-used by the EE overlay routes (Phase F).
 *
 * The actual HTTP enforcement (URL scheme restriction, SSRF guard, secret
 * strength) runs server-side. The structural constraints here — URL parses
 * as http(s), secret ≥ 16 chars, known event types — give the UI immediate
 * feedback. Semantic rejection still surfaces via
 * `{ error: 'invalid_url' | 'invalid_event_type' | 'secret_too_short' }`.
 */

// ── Event-type catalogue ───────────────────────────────────────────────────

/**
 * The closed set of event types a webhook subscription can filter on.
 * New events must be added here so the admin UI multi-select picks them up.
 */
export const WEBHOOK_EVENT_TYPES = [
  'page.created',
  'page.updated',
  'page.deleted',
  'sync.completed',
  'ai.quality.complete',
  'ai.summary.complete',
] as const;

export const WebhookEventTypeSchema = z.enum(WEBHOOK_EVENT_TYPES);

export type WebhookEventType = z.infer<typeof WebhookEventTypeSchema>;

// ── URL validation ─────────────────────────────────────────────────────────

/**
 * Best-effort URL validation for the UI. Rejects non-http(s) schemes and the
 * obvious local targets (loopback, private DNS names). The authoritative
 * SSRF check runs server-side — this is purely so the Save button can fail
 * fast on obvious mistakes without a round-trip.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export const WebhookUrlSchema = z
  .string()
  .url({ message: 'Must be a valid URL' })
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'URL must use http:// or https://' },
  )
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return !LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase());
      } catch {
        return false;
      }
    },
    { message: 'Localhost targets are not allowed' },
  );

// ── Subscription record ────────────────────────────────────────────────────

/**
 * A webhook subscription as returned by `GET /api/admin/webhooks`.
 * The secret itself is never exposed — only the last-4 hint and the flag
 * indicating whether a staged secondary secret is still active.
 */
export const WebhookSubscriptionSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  url: z.string(),
  eventTypes: z.array(z.string()),
  active: z.boolean(),
  /** Last 4 chars of the primary secret; `null` only in transitional states. */
  secretHint: z.string().nullable(),
  /** True while the rotation overlap window is still open. */
  hasSecondarySecret: z.boolean(),
  /** When the secondary secret slot was populated (staged during rotation). */
  secretSecondaryAddedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type WebhookSubscription = z.infer<typeof WebhookSubscriptionSchema>;

export const WebhookSubscriptionListResponseSchema = z.object({
  subscriptions: z.array(WebhookSubscriptionSchema),
});

export type WebhookSubscriptionListResponse = z.infer<
  typeof WebhookSubscriptionListResponseSchema
>;

export const WebhookSubscriptionResponseSchema = z.object({
  subscription: WebhookSubscriptionSchema,
});

export type WebhookSubscriptionResponse = z.infer<
  typeof WebhookSubscriptionResponseSchema
>;

// ── Create / Update ────────────────────────────────────────────────────────

export const CreateWebhookSubscriptionRequestSchema = z.object({
  label: z.string().max(200).optional(),
  url: WebhookUrlSchema,
  eventTypes: z.array(WebhookEventTypeSchema).min(1, {
    message: 'Select at least one event type',
  }),
  /** Minimum length mirrors the server-side strength check. */
  secret: z.string().min(16, {
    message: 'Secret must be at least 16 characters',
  }),
});

export type CreateWebhookSubscriptionRequest = z.infer<
  typeof CreateWebhookSubscriptionRequestSchema
>;

export const UpdateWebhookSubscriptionRequestSchema = z.object({
  label: z.string().max(200).optional(),
  url: WebhookUrlSchema.optional(),
  eventTypes: z.array(WebhookEventTypeSchema).min(1).optional(),
  active: z.boolean().optional(),
});

export type UpdateWebhookSubscriptionRequest = z.infer<
  typeof UpdateWebhookSubscriptionRequestSchema
>;

// ── Secret rotation ────────────────────────────────────────────────────────

export const RotateWebhookSecretRequestSchema = z.object({
  newSecret: z.string().min(16, {
    message: 'New secret must be at least 16 characters',
  }),
});

export type RotateWebhookSecretRequest = z.infer<
  typeof RotateWebhookSecretRequestSchema
>;

export const RotateWebhookSecretResponseSchema = z.object({
  subscription: WebhookSubscriptionSchema,
  /** ISO timestamp at which the secondary (previous) secret stops being accepted. */
  secondaryActiveUntil: z.string(),
});

export type RotateWebhookSecretResponse = z.infer<
  typeof RotateWebhookSecretResponseSchema
>;

// ── Test delivery ──────────────────────────────────────────────────────────

export const TestWebhookDeliveryRequestSchema = z.object({
  eventType: WebhookEventTypeSchema,
});

export type TestWebhookDeliveryRequest = z.infer<
  typeof TestWebhookDeliveryRequestSchema
>;

export const TestWebhookDeliveryResponseSchema = z.object({
  status: z.enum(['success', 'failure']),
  httpStatus: z.number().int().optional(),
  durationMs: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
});

export type TestWebhookDeliveryResponse = z.infer<
  typeof TestWebhookDeliveryResponseSchema
>;

// ── Delivery history ───────────────────────────────────────────────────────

export const WebhookDeliveryStatusSchema = z.enum([
  'success',
  'failure',
  'timeout',
  'ssrf_blocked',
]);

export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatusSchema>;

export const WebhookDeliverySchema = z.object({
  id: z.string(),
  outboxId: z.string(),
  webhookId: z.string(),
  attemptNumber: z.number().int().positive(),
  status: WebhookDeliveryStatusSchema,
  httpStatus: z.number().int().nullable(),
  /** Truncated to 1 KB server-side. */
  responseBody: z.string().nullable(),
  errorMessage: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  attemptedAt: z.string(),
});

export type WebhookDelivery = z.infer<typeof WebhookDeliverySchema>;

export const WebhookDeliveryListResponseSchema = z.object({
  deliveries: z.array(WebhookDeliverySchema),
});

export type WebhookDeliveryListResponse = z.infer<
  typeof WebhookDeliveryListResponseSchema
>;
