import type { EnterprisePlugin, LicenseInfo } from './types.js';
import { noopPlugin } from './noop.js';
import { logger } from '../utils/logger.js';

let cached: EnterprisePlugin | null = null;
let loaded = false;

// Module-level license reference populated by `setCurrentLicense()` from
// `app.ts` during bootstrap. Needed so non-Fastify callers (background
// workers like the Confluence sync loop, BullMQ handlers) can query feature
// gates without routing through `FastifyInstance#license`. Intentionally
// a simple module-scoped value: the license is effectively immutable for
// the process (only `/api/admin/license` updates invalidate it, and EE code
// refreshes its own caches independently).
let currentLicense: LicenseInfo | null = null;

/**
 * Attempts to load the enterprise plugin via dynamic import.
 *
 * - If @compendiq/enterprise is installed and exports a valid plugin,
 *   it is returned and cached.
 * - If the package is not installed (normal for community edition),
 *   the noop plugin is returned silently. No error, no warning.
 * - Result is cached after the first call; subsequent calls are synchronous.
 */
export async function loadEnterprisePlugin(): Promise<EnterprisePlugin> {
  if (loaded) return cached ?? noopPlugin;

  try {
    // Dynamic import — the package is never in package.json dependencies.
    // It is installed separately via .npmrc + GitHub Packages registry.
    const mod = await import('@compendiq/enterprise');

    // Validate the module exports the expected interface
    if (mod && typeof mod.validateLicense === 'function') {
      cached = mod as unknown as EnterprisePlugin;
      logger.info(
        { version: (mod as { version?: string }).version },
        'Enterprise plugin loaded',
      );
    } else {
      logger.warn('Enterprise package found but exports are invalid');
      cached = null;
    }
  } catch {
    // Package not installed — this is normal for community edition.
    // No log output: community mode is not an error condition.
    cached = null;
  }

  loaded = true;
  return cached ?? noopPlugin;
}

/**
 * Synchronous getter for the enterprise plugin.
 *
 * Only valid after loadEnterprisePlugin() has been awaited at least once
 * (done during app bootstrap in app.ts). Before that, returns noopPlugin.
 */
export function getEnterprisePlugin(): EnterprisePlugin {
  return cached ?? noopPlugin;
}

/**
 * Register the validated license for callers that run outside a Fastify
 * request context (background workers, sync loops, BullMQ jobs). `app.ts`
 * invokes this once during bootstrap immediately after `validateLicense()`
 * returns. Callers that already have `app.license` should keep using that —
 * this helper only exists to bridge module-scope callers.
 */
export function setCurrentLicense(license: LicenseInfo | null): void {
  currentLicense = license;
}

/**
 * Single-argument feature-flag check for module-scope callers that cannot
 * reach `FastifyInstance#license` (e.g. the Confluence sync worker). Thin
 * wrapper around `plugin.isFeatureEnabled(feature, currentLicense)` — the
 * noop plugin in CE always returns `false`, so CE builds are inherently
 * gated regardless of whether `setCurrentLicense()` has been called.
 */
export function isFeatureEnabled(feature: string): boolean {
  const plugin = cached ?? noopPlugin;
  return plugin.isFeatureEnabled(feature, currentLicense);
}

/**
 * Reset internal state. Exposed only for testing.
 * @internal
 */
export function _resetForTesting(): void {
  cached = null;
  loaded = false;
  currentLicense = null;
}
