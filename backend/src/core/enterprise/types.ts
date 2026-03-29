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
 * Contract that the @atlasmind/enterprise package must implement.
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
}
