import type { EnterpriseUI } from './types';

let cached: EnterpriseUI | null = null;
let loaded = false;

// Module specifier stored in a variable so Vite's static import analysis
// does not attempt to resolve it at build time. When @atlasmind/enterprise
// is not installed (community edition), the dynamic import simply throws
// and we return null.
const ENTERPRISE_FRONTEND_MODULE = '@atlasmind/enterprise/frontend';

/**
 * Attempts to load the enterprise frontend module via dynamic import.
 *
 * - If @atlasmind/enterprise/frontend is installed and exports valid
 *   components, they are returned and cached.
 * - If the package is not installed (normal for community edition),
 *   null is returned silently. No console errors, no warnings.
 * - Result is cached after the first call.
 */
export async function loadEnterpriseUI(): Promise<EnterpriseUI | null> {
  if (loaded) return cached;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await (import(/* @vite-ignore */ ENTERPRISE_FRONTEND_MODULE) as Promise<any>);
    if (mod && typeof mod.LicenseStatusCard === 'function') {
      cached = mod as EnterpriseUI;
    }
  } catch {
    // Not installed — community mode. This is not an error.
    cached = null;
  }

  loaded = true;
  return cached;
}

/**
 * Reset internal state. Exposed only for testing.
 * @internal
 */
export function _resetForTesting(): void {
  cached = null;
  loaded = false;
}
