import { Suspense, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { firstVisiblePath, settingsPanelFromPath, SETTINGS_TITLE, type AccessContext } from './settings-nav';

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
  const { pathname } = useLocation();
  const panel = settingsPanelFromPath(pathname);

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      {/* The page title moved to the rail's panel band ("Settings") on
          2026-11-19, so the sticky strip that carried "Settings · <Panel>" is
          gone. The heading stays in the document for screen readers. Nothing
          scrolls under a chrome band any more, so the strip's border and
          under-mask went with it. */}
      <h1 className="sr-only">
        {SETTINGS_TITLE}
        {panel && <span> · {panel.label}</span>}
      </h1>

      {/* No card. The FORM still caps at `max-w-2xl`: without it a "Confluence
          URL" input stretched the full width of the pane — a single-line field
          many times longer than anything anyone types into it, with its label
          stranded from its own help text.

          The cap lives here rather than in each tab so every settings surface
          inherits it; a tab needing full width (tables, audit logs) opts out
          with `max-w-none` on its own root. The column itself caps at 896px so
          settings stays a coherent shape rather than tracking the monitor. */}
      <div className="mx-auto max-w-4xl [&_form]:max-w-2xl">
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
