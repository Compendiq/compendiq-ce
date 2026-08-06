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
      // Settings is a reading-and-editing column, not a dashboard: capped at
      // 896px it stays a coherent shape instead of a pane stretched to whatever
      // the monitor happens to be, with its content stranded on the left.
      // Wide enough that the tabs carrying tables (audit, users) still breathe.
      className="max-w-4xl"
    >
      {/* Matches the route-title scale used across the app. */}
      <h1 className="mb-3 text-lg font-semibold">Settings</h1>

      {/* The pane spans the content column, but its FORM does not: `max-w-2xl`
          caps the fields at a usable measure. Without it a "Confluence URL"
          input stretched the full ~1160px of a desktop pane — a single-line
          field eleven times longer than anything anyone types into it, with
          its label stranded at the far left of its own help text.

          The cap lives here rather than in each tab so every settings surface
          inherits it; a tab needing full width (tables, audit logs) opts out
          with `max-w-none` on its own root. */}
      <div className="nm-card p-5 [&_form]:max-w-2xl">
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
