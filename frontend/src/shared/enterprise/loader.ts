import type { EnterpriseUI } from './types';

let cached: EnterpriseUI | null = null;
let loaded = false;

// The EE backend serves the overlay bundle at this path.
// CE nginx already proxies /api/ → backend, so no separate EE frontend image is needed.
// In CE deployments the backend returns 404 — the script fails silently and ui stays null.
const ENTERPRISE_BUNDLE_URL = '/api/enterprise/frontend.js';

// Global name the IIFE bundle registers itself under (matches vite.lib.config.ts `name`)
const EE_UI_GLOBAL = '__COMPENDIQ_UI__';

// Global namespace the IIFE reads its externalized dependencies from
const DEPS_GLOBAL = '__COMPENDIQ_DEPS__';

// Pluggable script loader — replaced in tests
type ScriptLoader = (url: string) => Promise<void>;

const defaultScriptLoader: ScriptLoader = (url) =>
  new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((window as any)[EE_UI_GLOBAL]) {
      resolve(); // Already loaded (e.g. hot-reload)
      return;
    }
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`EE bundle not available at ${url}`));
    document.head.appendChild(script);
  });

let _scriptLoader: ScriptLoader = defaultScriptLoader;

/**
 * Attempts to load the enterprise frontend bundle.
 *
 * The EE overlay is compiled as an IIFE (not an ES module) so it can receive
 * shared module instances via window globals instead of requiring an import map.
 * This lets both CE and EE deployments use the same CE frontend image — in EE the
 * EE backend serves the bundle at /api/enterprise/frontend.js; in CE the backend
 * returns 404 and this function returns null silently.
 *
 * Shared instances (react, framer-motion, react-query) are exposed on
 * window.__COMPENDIQ_DEPS__ before the script loads so the IIFE's externals
 * resolve to the CE SPA's already-loaded module instances (same hooks, same
 * contexts, same QueryClient).
 */
export async function loadEnterpriseUI(): Promise<EnterpriseUI | null> {
  if (loaded) return cached;

  try {
    // Expose the CE SPA's module instances as a flat global namespace.
    // The IIFE's rollupOptions.output.globals maps all externals to this object.
    const [React, jsxRuntime, ReactQuery, FramerMotion] = await Promise.all([
      import('react'),
      import('react/jsx-runtime'),
      import('@tanstack/react-query'),
      import('framer-motion'),
    ]);

    /* eslint-disable @typescript-eslint/no-explicit-any */
    (window as any)[DEPS_GLOBAL] = {
      ...(React as any),
      default: (React as any).default ?? React,
      ...(jsxRuntime as any),
      ...(ReactQuery as any),
      ...(FramerMotion as any),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */

    await _scriptLoader(ENTERPRISE_BUNDLE_URL);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui = (window as any)[EE_UI_GLOBAL];
    if (ui && typeof ui.LicenseStatusCard === 'function') {
      cached = ui as EnterpriseUI;
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
  _scriptLoader = defaultScriptLoader;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any)[DEPS_GLOBAL];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any)[EE_UI_GLOBAL];
}

/**
 * Override the script loader. Exposed only for testing.
 * @internal
 */
export function _setScriptLoaderForTesting(loader: ScriptLoader): void {
  _scriptLoader = loader;
}
