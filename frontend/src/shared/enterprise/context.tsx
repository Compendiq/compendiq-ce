import { useState, useEffect, type ReactNode } from 'react';
import type { EnterpriseUI, LicenseInfo } from './types';
import { EnterpriseContext } from './enterprise-context';
import { loadEnterpriseUI } from './loader';
import { apiFetch } from '../lib/api';

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

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // License first — CE returns edition:'community', EE returns actual
      // tier. The response tells us whether the backend is EE at all.
      let info: LicenseInfo | null = null;
      try {
        info = await apiFetch<LicenseInfo>('/admin/license');
      } catch {
        // Not admin, or endpoint unavailable — license stays null
      }
      if (cancelled) return;
      if (info) setLicense(info);

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
      }

      setIsLoading(false);
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

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
