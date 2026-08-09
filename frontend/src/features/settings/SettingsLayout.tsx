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
      className=""
    >
      {/* Sticky title strip, full bleed with a bottom hairline — the same shape
          as the article's context strip, and for the same reason: the settings
          column IS the pane now (AppLayout gives `<main>` the surface), so a
          rounded bordered card inside it would be a box drawn on a box.

          `-mx-4 sm:-mx-6` cancels the scroll container's padding so the rule
          runs edge to edge; `-top-5 -mt-5` pulls it flush with the top of the
          pane, because a sticky box otherwise clamps to its containing block's
          content-box top and leaves the container's `pt-5` showing above it. */}
      <div className="sticky -top-5 z-20 -mx-4 -mt-5 mb-4 border-b border-border bg-card sm:-mx-6">
        {/* Aligned with the body below, which is `mx-auto max-w-4xl` inside the
            scroll container's `px-4 sm:px-6`. The strip cancels that padding to
            run its rule edge to edge, so it adds the same amount back: 896 + 48
            = 944 at the same `px-6`, which puts both content edges on the same
            x. Measured, not eyeballed. */}
        {/* Same 48px line as the settings sidebar's nav row beside it, and as
            the article route's three rules — `calc(3rem-1px)` because the
            hairline is on the sticky parent rather than on this row, so the
            subtraction is what keeps the two rules meeting at the same y
            instead of the title strip finishing 3px high. */}
        <div className="mx-auto flex min-h-[calc(3rem-1px)] max-w-[928px] items-center px-4 py-2 sm:max-w-[944px] sm:px-6">
          <h1 className="text-lg font-semibold">Settings</h1>
        </div>
      </div>

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
