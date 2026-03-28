import type { EnterprisePlugin } from './types.js';
import { noopPlugin } from './noop.js';
import { logger } from '../utils/logger.js';

let cached: EnterprisePlugin | null = null;
let loaded = false;

/**
 * Attempts to load the enterprise plugin via dynamic import.
 *
 * - If @atlasmind/enterprise is installed and exports a valid plugin,
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
    const mod = await import('@atlasmind/enterprise');

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
 * Reset internal state. Exposed only for testing.
 * @internal
 */
export function _resetForTesting(): void {
  cached = null;
  loaded = false;
}
