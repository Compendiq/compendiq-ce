import { useState, useEffect, type ReactNode } from 'react';
import type { EnterpriseUI, LicenseInfo } from './types';
import { EnterpriseContext } from './enterprise-context';
import { loadEnterpriseUI } from './loader';
import { apiFetch, ApiError } from '../lib/api';
import { useAuthStore } from '../../stores/auth-store';

/**
 * Provider that fetches license info and, only on EE backends, loads the
 * enterprise UI module.
 *
 * Always fetches /admin/license so isEnterprise is derived from the backend
 * response (edition + valid), not from whether the overlay bundle loaded.
 * In CE deployments the endpoint returns edition:'community'; in EE it returns
 * the actual tier. The fetch is silently swallowed for unauthenticated users.
 *
 * The license response also gates the bundle load: only the EE backend marks
 * itself with `canUpdate: true` (the CE noop omits it), so on CE backends the
 * bundle URL is never requested at all — zero extra requests, zero console
 * noise. Waiting for the license response before deciding is fine because the
 * UI is non-blocking: every consumer already handles `ui === null`.
 */
export function EnterpriseProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<EnterpriseUI | null>(null);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Re-fetch whenever the access token changes. A login performed after mount
  // is a pure SPA transition (LoginPage/OidcCallbackPage do setAuth + navigate,
  // no reload), so without this dependency an EE admin who logs in from a fresh
  // tab would stay in the community fallback all session. The same dependency
  // clears the previous admin's license/ui from memory on logout.
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    let cancelled = false;
    // isLoading starts true and is only ever set back to false, so skeletons
    // show on the initial load only — a token-change refetch (routine refresh)
    // keeps the current UI up while the license is re-checked, no flicker.

    async function init() {
      // License first — CE returns edition:'community', EE returns actual
      // tier. The response tells us whether the backend is EE at all.
      let info: LicenseInfo | null = null;
      let transientFailure = false;
      try {
        info = await apiFetch<LicenseInfo>('/admin/license');
      } catch (err) {
        // Only a genuine auth signal (401 logged out / 403 not admin) clears
        // the license. Anything else — network error, 5xx — is transient and
        // must NOT flip an EE admin to community mid-session.
        const isAuthError =
          err instanceof ApiError && (err.statusCode === 401 || err.statusCode === 403);
        transientFailure = !isAuthError;
      }
      if (cancelled) return;
      if (transientFailure) {
        // Preserve the previously loaded license/ui; just settle loading.
        setIsLoading(false);
        return;
      }
      // Set unconditionally so a logout (fetch now 401s → info null) drops the
      // previous session's license instead of leaving it stale in memory.
      setLicense(info);

      // Only an EE backend (which marks itself with canUpdate: true) can
      // serve the overlay bundle, so don't even attempt the load otherwise.
      //
      // CAVEAT: /admin/license is admin-gated, so non-admins get a 403 above
      // and `ui` stays null for them even on EE — the bundle loads only in
      // admin sessions. Fine today (every `ui` consumer is an admin surface);
      // if a non-admin enterprise UI surface is ever added, the gate needs an
      // unauthenticated/user-visible EE marker instead of `canUpdate`.
      if (info?.canUpdate === true) {
        const enterpriseUi = await loadEnterpriseUI();
        if (cancelled) return;
        setUi(enterpriseUi);
      } else {
        // Not EE (or logged out) — drop any bundle loaded for a prior session.
        setUi(null);
      }

      setIsLoading(false);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const hasFeature = (feature: string): boolean => {
    if (!license || !license.valid) return false;
    return (license.features ?? []).includes(feature);
  };

  return (
    <EnterpriseContext.Provider
      value={{
        ui,
        license,
        isEnterprise: license?.edition !== 'community' && license?.valid === true,
        hasFeature,
        isLoading,
      }}
    >
      {children}
    </EnterpriseContext.Provider>
  );
}
