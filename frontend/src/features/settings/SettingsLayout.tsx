import { Suspense, useEffect } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { firstVisiblePath, type AccessContext } from './settings-nav';

/**
 * Extends AccessContext with the license-fetch loading flag so
 * SettingsPanelRoute can defer EE-gated redirects until the license API
 * resolves (avoids bouncing an EE admin's cold deep-link to an EE-only panel
 * during the fetch window).
 */
export interface AccessContextWithLoading extends AccessContext {
  isEnterpriseLoading: boolean;
}

/**
 * Shell for the Settings page: renders the `<Outlet/>` for the active
 * category/item panel. The section nav lives in `<SettingsSidebar>` (mounted
 * by AppLayout) so users keep the main app nav (Pages / Graph / AI) one
 * click away while in Settings.
 */
export function SettingsLayout() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const { isEnterprise, hasFeature, isLoading: isEnterpriseLoading } = useEnterprise();

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <h1 className="mb-6 text-2xl font-bold tracking-[-0.01em]">Settings</h1>

      {/* nm-card gives a proper neumorphic border + shadow recipe that holds
          up in both themes — replaces the previous border/40 wash that read
          ~1.1:1 against linen and disappeared entirely on white card backs. */}
      <div className="nm-card p-6">
        <Suspense fallback={<SkeletonFormFields />}>
          <Outlet
            context={
              {
                isAdmin,
                isEnterprise,
                hasFeature,
                isEnterpriseLoading,
              } satisfies AccessContextWithLoading
            }
          />
        </Suspense>
      </div>
    </m.div>
  );
}

/**
 * Renders at `/settings` exactly — bounces the user to the first visible panel
 * they have permission for (default: /settings/personal/confluence).
 */
export function SettingsIndexRedirect() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const { isEnterprise, hasFeature } = useEnterprise();

  const navigate = useNavigate();

  useEffect(() => {
    const target = firstVisiblePath({ isAdmin, isEnterprise, hasFeature });
    navigate(target, { replace: true });
  }, [isAdmin, isEnterprise, hasFeature, navigate]);

  return null;
}
