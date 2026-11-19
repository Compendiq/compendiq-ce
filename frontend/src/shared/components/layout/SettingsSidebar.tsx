import { NavLink } from 'react-router-dom';
import { m, useReducedMotion } from 'framer-motion';
import { PanelLeft, PanelLeftClose } from 'lucide-react';
import { PANEL_COLLAPSE_TRANSITION, usePanelCollapseInitial } from '../../hooks/use-panel-collapse-motion';
import { COLLAPSED_TREE_SIDEBAR_WIDTH, useUiStore } from '../../../stores/ui-store';
import { useAuthStore } from '../../../stores/auth-store';
import { useEnterprise } from '../../enterprise/use-enterprise';
import { MainNavStripExpanded } from './MainNavStrip';

import {
  SETTINGS_NAV,
  SETTINGS_TITLE,
  canSeeItem,
  type AccessContext,
} from '../../../features/settings/settings-nav';
import { cn } from '../../lib/cn';

/**
 * Left sidebar mounted on /settings/* routes — replaces the Pages tree there
 * inside `app-workspace`.
 * On desktop, Pages / AI / Graph live in the outer chassis icon rail
 * (`MainNavChassisRail`) so `embedMainNav={false}` is passed; in the mobile
 * drawer (`embedMainNav={true}`) this renders `MainNavStripExpanded` at top.
 * Body: the Settings section nav (was the inner rail inside SettingsLayout).
 *
 * Since 2026-11-19 it carries the same 36px panel band as the Pages tree and
 * the `/ai` conversations rail: open/close toggle plus the page title
 * ("Settings"), then the toolbar-style hairline. Collapsing follows the shared
 * `treeSidebarCollapsed` state (and the `,` shortcut) like the other rails; the
 * 40px rail repeats that band at the same inset, so the toggle does not move.
 * The band's title is desktop-only — the mobile drawer's pill strip already
 * names its destinations.
 */
export function SettingsSidebar({
  onNavigate,
  embedMainNav = true,
}: {
  onNavigate?: () => void;
  embedMainNav?: boolean;
} = {}) {
  const treeSidebarWidth = useUiStore((s) => s.treeSidebarWidth);
  const treeSidebarCollapsed = useUiStore((s) => s.treeSidebarCollapsed);
  const toggleTreeSidebar = useUiStore((s) => s.toggleTreeSidebar);
  const reduceEffects = useReducedMotion();

  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const { isEnterprise, hasFeature } = useEnterprise();
  const ctx: AccessContext = { isAdmin, isEnterprise, hasFeature };

  const { collapsedInitial, expandedInitial } = usePanelCollapseInitial(
    treeSidebarCollapsed,
    treeSidebarWidth,
    COLLAPSED_TREE_SIDEBAR_WIDTH,
    reduceEffects,
  );

  if (treeSidebarCollapsed) {
    return (
      <m.aside
        data-testid="settings-sidebar"
        initial={collapsedInitial}
        animate={{ width: COLLAPSED_TREE_SIDEBAR_WIDTH, opacity: 1 }}
        transition={reduceEffects ? { duration: 0 } : PANEL_COLLAPSE_TRANSITION}
        className="app-sidebar relative flex flex-col items-center overflow-hidden"
      >
        {/* The same 48px band as the expanded rail: same height, inset,
            control and hairline, so the toggle never moves and the hairline
            aligns with the workspace top chrome. */}
        <div className="flex h-12 w-full shrink-0 items-center border-b border-border px-2">
          <button
            type="button"
            onClick={toggleTreeSidebar}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Expand sidebar"
            title="Expand sidebar (,)"
          >
            <PanelLeft size={15} aria-hidden="true" />
          </button>
        </div>

        <span
          data-rail-hairline
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 -right-px top-0 z-10 flex w-[3px] flex-col items-center"
        >
          <span className="w-px flex-1 bg-[var(--rail-divider)]" />
          <span className="my-1.5 flex flex-col items-center gap-1 opacity-70">
            <span className="size-[3px] rounded-full bg-muted-foreground" />
            <span className="size-[3px] rounded-full bg-muted-foreground" />
            <span className="size-[3px] rounded-full bg-muted-foreground" />
          </span>
          <span className="w-px flex-1 bg-[var(--rail-divider)]" />
        </span>
      </m.aside>
    );
  }

  return (
    <m.aside
      data-testid="settings-sidebar"
      initial={expandedInitial}
      animate={{ width: treeSidebarWidth, opacity: 1 }}
      transition={reduceEffects ? { duration: 0 } : PANEL_COLLAPSE_TRANSITION}
      className="app-sidebar relative flex flex-col overflow-hidden"
    >
      {/* Same 48px chrome height as SidebarTreeView's — the two sidebars share
          MainNavStrip precisely so this row cannot drift between routes. The
          hairline came off with the rest of the 48px rule (2026-08-31); the
          height is what keeps the panes aligned. */}
      {embedMainNav && (
        <div className="panel-toolbar flex h-12 shrink-0 items-center gap-1 px-2">
          <MainNavStripExpanded onNavigate={onNavigate} />
        </div>
      )}

      {/* Panel toggle band + page title — the Pages tree's band. The page H1
          inside SettingsLayout adds the active panel ("Settings · Retrieval");
          this is the room's name, the same way the other rails carry Library /
          AI / Graph. */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-2">
        <button
          type="button"
          onClick={toggleTreeSidebar}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Collapse sidebar"
          title="Collapse sidebar (,)"
        >
          <PanelLeftClose size={15} aria-hidden="true" />
        </button>
        {!embedMainNav && (
          <span
            className="min-w-0 truncate text-xs font-semibold text-foreground"
            data-testid="sidebar-destination-title"
          >
            {SETTINGS_TITLE}
          </span>
        )}
      </div>

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
                className="px-2 py-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
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
                            'group/nav relative block rounded-md px-2.5 py-1.5 text-sm motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isActive
                              ? 'nav-selection font-medium'
                              : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
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

      <span
        data-rail-hairline
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 -right-px top-0 z-10 flex w-[3px] flex-col items-center"
      >
        <span className="w-px flex-1 bg-[var(--rail-divider)]" />
        <span className="my-1.5 flex flex-col items-center gap-1 opacity-70">
          <span className="size-[3px] rounded-full bg-muted-foreground" />
          <span className="size-[3px] rounded-full bg-muted-foreground" />
          <span className="size-[3px] rounded-full bg-muted-foreground" />
        </span>
        <span className="w-px flex-1 bg-[var(--rail-divider)]" />
      </span>

    </m.aside>
  );
}
