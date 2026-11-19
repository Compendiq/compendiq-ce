import { z } from 'zod';

/**
 * Article AI policy enforcement switch (#1881). CE owns it; EE and licence
 * state never open or close it. Design and failure model:
 * `docs/architecture/article-ai-policy-activation.md`.
 *
 * `GET /api/admin/ai-policy/activation` answers the state below;
 * `PUT` with {@link AiPolicyActivationRequestSchema} answers the same state,
 * 409 {@link AiPolicyActivationRefusalSchema} while a blocker is unmet, or
 * 503 `ai_policy_activation_busy` when the state row lock times out.
 */

/**
 * The SPA sends this header (value {@link AI_POLICY_CLIENT_PROTOCOL_VERSION})
 * on every `/api` request. A browser request to a session-issuing route
 * without it is a legacy, pre-handshake bundle.
 */
export const AI_POLICY_CLIENT_PROTOCOL_HEADER = 'X-Compendiq-Client-Protocol';
export const AI_POLICY_CLIENT_PROTOCOL_VERSION = 1;

/** 409 body for a legacy client while enforcement is on: reload the page. */
export const CLIENT_RELOAD_REQUIRED = 'client_reload_required';
export const ClientReloadRequiredSchema = z.object({
  error: z.literal(CLIENT_RELOAD_REQUIRED),
  message: z.string().optional(),
});
export type ClientReloadRequired = z.infer<typeof ClientReloadRequiredSchema>;

/** 409 body from the global label rename/delete when a name is a reserved policy label. */
export const AI_POLICY_RESERVED_LABEL = 'ai_policy_reserved_label';

const RuntimeBlockerEntrySchema = z.object({
  runtimeId: z.string(),
  host: z.string().nullable(),
  pid: z.number().int().nullable(),
  startedAt: z.string().datetime(),
});

const LegacyClientUserSchema = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  lastSeenAt: z.string().datetime(),
});

export const AiPolicyActivationBlockerSchema = z.discriminatedUnion('code', [
  /** Active runtimes without AI-policy enforcement version 1. Not overridable. */
  z.object({
    code: z.literal('incompatible_ai_policy_runtime'),
    overridable: z.literal(false),
    total: z.number().int().positive(),
    runtimes: z.array(RuntimeBlockerEntrySchema).max(50),
  }),
  /** Legacy browser sessions issued within one access-token lifetime. */
  z.object({
    code: z.literal('legacy_clients_active'),
    overridable: z.literal(true),
    users: z.number().int().positive(),
    recent: z.array(LegacyClientUserSchema).max(20),
    clearsAt: z.string().datetime(),
  }),
  /** The observer cannot yet see every legacy token (after install or an old replica's drain). */
  z.object({
    code: z.literal('legacy_client_window_open'),
    overridable: z.literal(true),
    since: z.string().datetime(),
    clearsAt: z.string().datetime(),
  }),
  z.object({
    code: z.literal('ai_policy_enforcement_not_registered'),
    overridable: z.literal(false),
  }),
  z.object({
    code: z.literal('ai_policy_readiness_unavailable'),
    overridable: z.literal(false),
  }),
]);
export type AiPolicyActivationBlocker = z.infer<typeof AiPolicyActivationBlockerSchema>;
export type AiPolicyActivationBlockerCode = AiPolicyActivationBlocker['code'];

export const AiPolicyActivationStateSchema = z.object({
  enabled: z.boolean(),
  /** Last transition; null until the first change. */
  changedAt: z.string().datetime().nullable(),
  changedBy: z.string().uuid().nullable(),
  changedByName: z.string().nullable(),
  /** True only when the current enabled state was entered with the legacy-client acknowledgement. */
  legacyClientsAcknowledged: z.boolean(),
  /** No blockers at all. Enabling may still succeed when every blocker is overridable and acknowledged. */
  ready: z.boolean(),
  blockers: z.array(AiPolicyActivationBlockerSchema),
}).strict();
export type AiPolicyActivationState = z.infer<typeof AiPolicyActivationStateSchema>;

export const AiPolicyActivationRequestSchema = z.object({
  enabled: z.boolean(),
  /** Accept the bounded legacy-client residual; ignored when disabling. */
  acknowledgeLegacyClients: z.boolean().optional(),
}).strict();
export type AiPolicyActivationRequest = z.infer<typeof AiPolicyActivationRequestSchema>;

export const AiPolicyActivationRefusalSchema = z.object({
  error: z.literal('ai_policy_activation_refused'),
  message: z.string().optional(),
  blockers: z.array(AiPolicyActivationBlockerSchema).min(1),
});
export type AiPolicyActivationRefusal = z.infer<typeof AiPolicyActivationRefusalSchema>;
