import { useState, useEffect, type ReactNode } from 'react';
import type { EnterpriseUI, LicenseInfo } from './types';
import { EnterpriseContext } from './enterprise-context';
import { loadEnterpriseUI } from './loader';
import { apiFetch } from '../lib/api';

/**
 * Provider that loads the enterprise UI module and fetches license info.
 *
 * In community mode (no @compendiq/enterprise installed), this resolves
 * almost instantly with ui=null, license=null, isEnterprise=false.
 * The rest of the app renders normally with no awareness of enterprise.
 */
export function EnterpriseProvider({ children }: { children: ReactNode }) {
  const [ui, setUi] = useState<EnterpriseUI | null>(null);
  const [license, setLicense] = useState<LicenseInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      // Load enterprise UI module (fast, just a dynamic import attempt)
      const enterpriseUi = await loadEnterpriseUI();
      if (cancelled) return;
      setUi(enterpriseUi);

      // Always fetch license info — CE returns edition:'community', EE returns actual tier
      try {
        const info = await apiFetch<LicenseInfo>('/admin/license');
        if (!cancelled) setLicense(info);
      } catch {
        // Not admin, or endpoint unavailable — license stays null
      }

      if (!cancelled) setIsLoading(false);
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
