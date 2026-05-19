import { Suspense, useEffect } from 'react';
import {
  Outlet,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { m } from 'framer-motion';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';
import { useAuthStore } from '../../stores/auth-store';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import {
  firstVisiblePath,
  legacyTabMap,
  type AccessContext,
} from './settings-nav';

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
 * category/item panel. The section nav that used to live in an inner rail
 * here was promoted to `<SettingsSidebar>` and mounts in `AppLayout` instead
 * — that way users keep the main app nav (Pages / Graph / AI) one click away
 * while in Settings. See docs/plans/215-settings-ia-reorg.md.
 */
export function SettingsLayout() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const { isEnterprise, hasFeature, isLoading: isEnterpriseLoading } = useEnterprise();

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Backward compat: /settings?tab=<legacyId> → /settings/<category>/<item>
  // (301-style in spirit; `replace: true` removes the legacy URL from history).
  useEffect(() => {
    if (pathname !== '/settings') return;
    const tab = searchParams.get('tab');
    if (tab && legacyTabMap[tab]) {
      navigate(legacyTabMap[tab], { replace: true });
    }
  }, [pathname, searchParams, navigate]);

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <h1 className="mb-6 text-2xl font-bold tracking-[-0.01em]">Settings</h1>

      <div className="rounded-xl border border-border/40 bg-card/50 p-6 backdrop-blur-sm">
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
 * they have permission for (default: /settings/personal/confluence). Only runs
 * when the URL has no `?tab=` legacy param; otherwise SettingsLayout's effect
 * redirects first.
 */
export function SettingsIndexRedirect() {
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const { isEnterprise, hasFeature } = useEnterprise();

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    // Legacy tab redirect is handled by SettingsLayout's effect. If a legacy
    // `?tab=` is present AND valid, SettingsLayout navigates first and this
    // component unmounts before running its own navigate.
    if (searchParams.get('tab') && legacyTabMap[searchParams.get('tab')!]) {
      return;
    }
    const target = firstVisiblePath({ isAdmin, isEnterprise, hasFeature });
    navigate(target, { replace: true });
  }, [isAdmin, isEnterprise, hasFeature, navigate, searchParams]);

  return null;
}
