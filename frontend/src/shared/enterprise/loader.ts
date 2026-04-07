import type { EnterpriseUI } from './types';

let cached: EnterpriseUI | null = null;
let loaded = false;

// URL stored in a variable so Vite's static import analysis does not attempt
// to resolve /enterprise/frontend.js as a local file at build time.
// In EE, nginx serves this path → import succeeds → components are cached.
// In CE, no such file exists → 404 → import throws → null returned silently.
const ENTERPRISE_BUNDLE_URL = '/enterprise/frontend.js';

/**
 * Attempts to load the enterprise frontend module via dynamic import.
 *
 * - In EE: nginx serves /enterprise/frontend.js → import succeeds → components cached.
 * - In CE: no /enterprise/frontend.js → 404 → import throws → null returned silently.
 * - Result is cached after the first call.
 */
export async function loadEnterpriseUI(): Promise<EnterpriseUI | null> {
  if (loaded) return cached;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await (import(/* @vite-ignore */ ENTERPRISE_BUNDLE_URL) as Promise<any>);
    if (mod && typeof mod.LicenseStatusCard === 'function') {
      cached = mod as EnterpriseUI;
    }
  } catch {
    // Not available — community mode. This is not an error.
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
