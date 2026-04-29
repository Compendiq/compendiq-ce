import { Suspense, useEffect } from 'react';
import {
  NavLink,
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
  SETTINGS_NAV,
  canSeeItem,
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
 * Shell for the Settings page: renders the left-rail nav landmark + <Outlet/>
 * for the active category/item panel. See docs/plans/215-settings-ia-reorg.md.
 *
 * Accessibility:
 *   - `<nav aria-label="Settings">` landmark (not `role="tablist"` — this is
 *     URL-driven navigation, not in-page view switching). Per W3C APG.
 *   - Group headers are real `<h2>` elements for screen-reader heading shortcuts.
 *   - NavLink sets `aria-current="page"` on the active route.
 *   - Keyboard nav is browser-native Tab/Shift-Tab — no roving tabindex needed.
 *   - `motion-safe:` Tailwind variants respect `prefers-reduced-motion` (ADR-010).
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

  const ctx: AccessContext = { isAdmin, isEnterprise, hasFeature };

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <h1 className="mb-6 text-2xl font-bold tracking-[-0.01em]">Settings</h1>

      <div className="grid grid-cols-1 rounded-xl border border-border/40 bg-card/50 backdrop-blur-sm md:grid-cols-[240px_1fr]">
        <nav
          aria-label="Settings"
          className="border-b border-white/10 p-3 md:border-b-0 md:border-r"
        >
          {SETTINGS_NAV.map((group) => {
            const visible = group.items.filter((i) => canSeeItem(i, ctx));
            if (visible.length === 0) return null;
            return (
              <section
                key={group.id}
                aria-labelledby={`settings-group-${group.id}`}
                className="mb-4 last:mb-0"
              >
                <h2
                  id={`settings-group-${group.id}`}
                  className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {group.label}
                </h2>
                <ul role="list" className="mt-1 flex flex-col gap-px">
                  {visible.map((item) => {
                    const href = `/settings/${group.id}/${item.id}`;
                    return (
                      <li key={item.id}>
                        <NavLink
                          to={href}
                          // Dual data-testid: legacy `tab-<id>` kept for one release
                          // so existing tests don't break in this PR. New canonical
                          // testid is `nav-settings-<id>`. Remove the legacy one
                          // in a follow-up (see plan §15.1).
                          data-testid={`nav-settings-${item.id}`}
                          data-legacy-testid={`tab-${item.id}`}
                          className={({ isActive }) =>
                            `block rounded-md px-3 py-2 text-sm motion-safe:transition-colors motion-safe:duration-150 ${
                              isActive
                                ? 'bg-foreground/10 text-foreground'
                                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground/80'
                            }`
                          }
                          end
                        >
                          {item.label}
                          {item.enterpriseOnly && (
                            <span className="ml-2 rounded-sm border border-white/10 px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              EE
                            </span>
                          )}
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>

        <div className="p-6">
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
