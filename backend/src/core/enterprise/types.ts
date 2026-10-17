import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ─── Fastify Module Augmentation ───────────────────────────────────
// Adds .license and .enterprise decorators to the Fastify instance.
// These are populated during bootstrap in app.ts.
declare module 'fastify' {
  interface FastifyInstance {
    /** Parsed license info, or null if no valid license is present. */
    license: LicenseInfo | null;
    /** The loaded enterprise plugin (noop in community mode). */
    enterprise: EnterprisePlugin;
  }
}

// ─── License Types ─────────────────────────────────────────────────

export type LicenseTier = 'community' | 'team' | 'business' | 'enterprise';

export interface LicenseInfo {
  tier: LicenseTier;
  seats: number;
  expiresAt: Date;
  isValid: boolean;
  /** Displayable key (payload only, no signature). */
  displayKey: string;
  /** Short license ID (e.g. CPQ1a2b3c4d) for support lookups, or null for legacy keys. */
  licenseId?: string | null;
  /** List of enabled feature flag strings. */
  features?: string[];
}

// ─── Plugin Contract ───────────────────────────────────────────────

export type FastifyPreHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void>;

/**
 * Contract that the @compendiq/enterprise package must implement.
 * The open-source repo defines this interface; the enterprise package
 * provides the real implementation. Community mode uses the noop stub.
 */
export interface EnterprisePlugin {
  /** Validate a license key string and return parsed info, or null if invalid/missing. */
  validateLicense(key: string | undefined): LicenseInfo | null;

  /** Check if a specific feature is available under the given license. */
  isFeatureEnabled(feature: string, license: LicenseInfo | null): boolean;

  /** Return a Fastify preHandler that rejects with 403 if the feature is not licensed. */
  requireFeature(feature: string): FastifyPreHandler;

  /** Register enterprise-specific routes (e.g., GET /api/admin/license). */
  registerRoutes(fastify: FastifyInstance, license: LicenseInfo | null): Promise<void>;

  /** Version identifier: semver for enterprise, 'community' for noop. */
  version: string;

  /**
   * Optional runtime override hook consulted by `resolveUsecase` in the
   * LLM provider resolver. When EE's org LLM policy is enabled, this
   * returns the policy's provider id and model; otherwise null. CE noop
   * always returns null.
   */
  resolveUsecaseOverride?(usecase: import('@compendiq/contracts').LlmUsecase): Promise<{ providerId: string; model: string } | null>;

  /**
   * Article AI policy creation default (SPEC-CORE-001). The CE noop returns
   * `'all'`; creation still applies the stricter of this value and labels.
   * An unrecognised value is treated as `'none'` (fail closed).
   */
  resolveAiPolicyCreationDefault?(ctx: { userId: string; spaceKey: string | null }): Promise<'all' | 'local_only' | 'none'>;

  /**
   * True only when EE workers enforce `local_only`/`none`. Absent or false
   * (foundation-only deployment) means restrictive policies cannot be
   * activated.
   */
  aiPolicyEnforcementAvailable?(): boolean;

  /** Awaited on the mutation's transaction. Must use ONLY this client, never commit,
   * perform network I/O, or swallow persistence failures. CE is a no-op. */
  persistAiPolicyChange?(client: import('pg').PoolClient, event: import('@compendiq/contracts').AiPolicyChangeEvent): Promise<void>;

  /** Complete stage decision captured at admission; never reconstruct from current settings. */
  onAiDecision?(event: import('@compendiq/contracts').AiDecisionEvent): void | Promise<void>;

  /** Legacy observation only, not a durable committed-change persistence seam. */
  onAiPolicyEvent?(event: import('./ai-policy-hooks.js').AiPolicyEvent): void;
}
