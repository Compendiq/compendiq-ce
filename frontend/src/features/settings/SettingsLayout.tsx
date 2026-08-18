import { Suspense, useEffect } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { m } from 'framer-motion';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import { firstVisiblePath, settingsPanelFromPath, type AccessContext } from './settings-nav';
import { HeaderHost } from '../../shared/components/layout/header-slot';

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
      // Settings is a reading-and-editing column, not a dashboard: capped at
      // 896px it stays a coherent shape instead of a pane stretched to whatever
      // the monitor happens to be, with its content stranded on the left.
      // Wide enough that the tabs carrying tables (audit, users) still breathe.
      className=""
    >
      <HeaderHost
        fallbackClassName="sticky -top-5 z-20 -mx-4 -mt-5 mb-4 border-b border-border bg-card sm:-mx-6 [&>h1]:mx-auto [&>h1]:flex [&>h1]:min-h-[calc(3rem-1px)] [&>h1]:max-w-[928px] [&>h1]:items-center [&>h1]:px-4 [&>h1]:py-2 sm:[&>h1]:max-w-[944px] sm:[&>h1]:px-6"
      >
        <h1 className="min-w-0 truncate text-[15px] font-semibold sm:text-lg">
          Settings
          {panel && (
            <span className="font-normal text-muted-foreground">
              {' · '}
              {panel.label}
            </span>
          )}
        </h1>
      </HeaderHost>

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
