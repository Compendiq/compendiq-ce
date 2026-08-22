import { NavLink } from 'react-router-dom';
import { m, useReducedMotion } from 'framer-motion';
import { PanelLeftClose, PanelLeft } from 'lucide-react';
import { useUiStore } from '../../../stores/ui-store';
import { useAuthStore } from '../../../stores/auth-store';
import { useEnterprise } from '../../enterprise/use-enterprise';
import { ShortcutHint } from '../ShortcutHint';
import { MainNavStripExpanded, MainNavStripCollapsed } from './MainNavStrip';

import {
  SETTINGS_NAV,
  canSeeItem,
  type AccessContext,
} from '../../../features/settings/settings-nav';
import { cn } from '../../lib/cn';

/**
 * Left sidebar mounted on /settings/* routes — replaces the Pages tree there.
 * Top: the Pages / AI / Graph main-nav strip (shared with SidebarTreeView via
 * `MainNavStrip`) so users keep one-click access to the rest of the app while
 * in Settings.
 * Body: the Settings section nav (was the inner rail inside SettingsLayout).
 *
 * Width / collapse state are shared with SidebarTreeView via useUiStore, so
 * the `,` keyboard shortcut and the chevron toggle both work the same way on
 * Settings as anywhere else.
 */

const sidebarSpring = { type: 'spring' as const, stiffness: 400, damping: 30 };

export function SettingsSidebar({
  onNavigate,
  embedMainNav = true,
}: {
  onNavigate?: () => void;
  embedMainNav?: boolean;
} = {}) {
  const treeSidebarCollapsed = useUiStore((s) => s.treeSidebarCollapsed);
  const toggleTreeSidebar = useUiStore((s) => s.toggleTreeSidebar);
  const treeSidebarWidth = useUiStore((s) => s.treeSidebarWidth);
  const reduceEffects = useReducedMotion();

  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const { isEnterprise, hasFeature } = useEnterprise();
  const ctx: AccessContext = { isAdmin, isEnterprise, hasFeature };

  if (treeSidebarCollapsed) {
    return (
      <m.div
        key="settings-sidebar-collapsed"
        data-testid="settings-sidebar"
        initial={reduceEffects ? false : { width: 0, opacity: 0 }}
        animate={{ width: 40, opacity: 1 }}
        transition={reduceEffects ? { duration: 0 } : sidebarSpring}
        className="app-sidebar flex flex-col items-center border-r overflow-hidden"
      >
        <button
          onClick={toggleTreeSidebar}
          className="mt-2 flex items-center gap-0.5 rounded-lg p-1.5 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors"
          aria-label="Expand sidebar"
          title="Expand sidebar (,)"
        >
          <PanelLeft size={16} />
          <ShortcutHint shortcutId="toggle-sidebar" />
        </button>

        {embedMainNav && <MainNavStripCollapsed onNavigate={onNavigate} />}
      </m.div>
    );
  }

  return (
    <m.aside
      key="settings-sidebar-expanded"
      data-testid="settings-sidebar"
      initial={reduceEffects ? false : { width: 0, opacity: 0 }}
      animate={{ width: treeSidebarWidth, opacity: 1 }}
      transition={reduceEffects ? { duration: 0 } : sidebarSpring}
      className="app-sidebar relative flex flex-col border-r overflow-hidden"
    >
      {/* Same 48px rule height as SidebarTreeView's — the two sidebars share
          MainNavStrip precisely so this row cannot drift between routes. */}
      {embedMainNav ? (
      <div className="panel-toolbar flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <MainNavStripExpanded onNavigate={onNavigate} />
        <button
          onClick={toggleTreeSidebar}
          className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          aria-label="Collapse sidebar"
          title="Collapse sidebar (,)"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>
      ) : (
      <div className="flex h-8 shrink-0 items-center justify-end px-2 pt-1.5">
        <button
          onClick={toggleTreeSidebar}
          className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          aria-label="Collapse sidebar"
          title="Collapse sidebar (,)"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>
      )}

      {/* No standalone "Settings" header here — the page H1 inside
          SettingsLayout already carries that title. Saves vertical space and
          avoids redundant titling. */}

      {/* Settings section nav — group labels get a hairline divider on top
          (skipped for the first group) so the rail visually segments without
          relying on uppercase typography alone. */}
      <nav
        aria-label="Settings"
        className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-3"
      >
        {SETTINGS_NAV.map((group, groupIdx) => {
          const visible = group.items.filter((i) => canSeeItem(i, ctx));
          if (visible.length === 0) return null;
          return (
            <section
              key={group.id}
              aria-labelledby={`settings-group-${group.id}`}
              className={cn(
                'pb-2',
                groupIdx > 0 && 'mt-2 border-t border-border pt-2',
              )}
            >
              <h2
                id={`settings-group-${group.id}`}
                className="px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/80"
              >
                {group.label}
              </h2>
              <ul role="list" className="mt-0.5 flex flex-col gap-px">
                {visible.map((item) => {
                  const href = `/settings/${group.id}/${item.id}`;
                  return (
                    <li key={item.id}>
                      <NavLink
                        to={href}
                        onClick={onNavigate}
                        data-testid={`nav-settings-${item.id}`}
                        className={({ isActive }) =>
                          cn(
                            'group/nav relative block rounded-md px-2.5 py-1.5 text-sm motion-safe:transition-colors motion-safe:duration-150',
                            isActive
                              ? 'nav-selection font-medium'
                              : 'text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground/80',
                          )
                        }
                        end
                      >
                        {() => (
                          <>
                            {/* The 2px leading rule that used to sit here is
                                gone. `nav-selection` already marks this row as
                                active — the rule was a SECOND indicator layered
                                on the shared recipe, and the only one of its
                                kind in the app, so "selected" looked different
                                in this rail than in the page tree that occupies
                                the same slot on every other route. It was also
                                the coloured leading edge the craft floor
                                refuses on list items. */}
                            <span>{item.label}</span>
                            {item.enterpriseOnly && (
                              <span className="ml-2 rounded-sm border border-current/30 px-1.5 py-0.5 align-middle text-[12px] font-medium uppercase tracking-wider opacity-70">
                                EE
                              </span>
                            )}
                          </>
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

    </m.aside>
  );
}
