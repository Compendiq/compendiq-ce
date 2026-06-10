import type { EnterpriseUI } from './types';

let cached: EnterpriseUI | null = null;
let loaded = false;

// The EE backend serves the overlay bundle at this path.
// CE nginx already proxies /api/ → backend, so no separate EE frontend image is needed.
// On CE backends this URL is never requested at all: EnterpriseProvider only calls
// loadEnterpriseUI() when the license response marks the backend EE (canUpdate: true).
const ENTERPRISE_BUNDLE_URL = '/api/enterprise/frontend.js';

// Global name the IIFE bundle registers itself under (matches vite.lib.config.ts `name`)
const EE_UI_GLOBAL = '__COMPENDIQ_UI__';

// Global namespace the IIFE reads its externalized dependencies from
const DEPS_GLOBAL = '__COMPENDIQ_DEPS__';

// Pluggable script loader — replaced in tests
type ScriptLoader = (url: string) => Promise<void>;

// Script-element injection, separated from the probe so tests can stub
// injection (which jsdom can't complete) without bypassing the probe.
type ScriptInjector = (url: string) => Promise<void>;

const defaultScriptInjector: ScriptInjector = (url) =>
  new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`EE bundle not available at ${url}`));
    document.head.appendChild(script);
  });

let _scriptInjector: ScriptInjector = defaultScriptInjector;

// The probe lives here (inside the default loader) rather than in
// loadEnterpriseUI so the _setScriptLoaderForTesting seam keeps replacing
// probe + injection together — tests that stub the loader never touch the
// network, preserving the existing seam semantics.
const defaultScriptLoader: ScriptLoader = async (url) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any)[EE_UI_GLOBAL]) {
    return; // Already loaded (e.g. hot-reload)
  }

  // Defense-in-depth probe for EE backends that lack the bundle route:
  // a failed <script src> logs a 404 plus a MIME-type refusal to the console,
  // whereas a fetched 404 logs only a single network-level 404 line (browsers
  // still log that — there is no fully silent way to request a missing URL).
  // CE never reaches this code: the load is license-gated in context.tsx.
  const res = await fetch(url, { method: 'HEAD' });
  const type = res.headers.get('content-type') ?? '';
  if (!res.ok || !/javascript|ecmascript/.test(type)) {
    throw new Error(`EE bundle not available at ${url}`);
  }

  await _scriptInjector(url);
};

let _scriptLoader: ScriptLoader = defaultScriptLoader;

/**
 * Attempts to load the enterprise frontend bundle.
 *
 * The EE overlay is compiled as an IIFE (not an ES module) so it can receive
 * shared module instances via window globals instead of requiring an import map.
 * This lets both CE and EE deployments use the same CE frontend image — the EE
 * backend serves the bundle at /api/enterprise/frontend.js. On CE backends this
 * function is never called (EnterpriseProvider gates it on the license response's
 * canUpdate flag), so CE produces no bundle traffic and no console noise. If an
 * EE backend lacks the bundle route, the HEAD probe fails and this resolves null
 * at the cost of a single network 404 log line.
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
  _scriptInjector = defaultScriptInjector;
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

/**
 * Override the script injector used by the default loader, so the probe can
 * be tested without jsdom needing to execute a real <script>. Exposed only
 * for testing.
 * @internal
 */
export function _setScriptInjectorForTesting(injector: ScriptInjector): void {
  _scriptInjector = injector;
}
