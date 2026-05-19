import { Link, NavLink, useLocation } from 'react-router-dom';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { BookOpen, Share2, Bot, PanelLeftClose, PanelLeft } from 'lucide-react';
import { useUiStore } from '../../../stores/ui-store';
import { useAuthStore } from '../../../stores/auth-store';
import { useEnterprise } from '../../enterprise/use-enterprise';
import { ShortcutHint } from '../ShortcutHint';
import {
  SETTINGS_NAV,
  canSeeItem,
  type AccessContext,
} from '../../../features/settings/settings-nav';
import { cn } from '../../lib/cn';

/**
 * Left sidebar mounted on /settings/* routes — replaces the Pages tree there.
 * Top: the same Pages / Graph / AI main-nav strip used by SidebarTreeView so
 * users keep one-click access to the rest of the app while in Settings.
 * Body:  the Settings section nav (was the inner rail inside SettingsLayout).
 *
 * Width / collapse state are shared with SidebarTreeView via useUiStore, so
 * the `,` keyboard shortcut and the chevron toggle both work the same way on
 * Settings as anywhere else.
 */

const navItems = [
  { icon: BookOpen, label: 'Pages', path: '/', shortcut: 'G then P' },
  { icon: Share2, label: 'Graph', path: '/graph', shortcut: 'G then G' },
  { icon: Bot, label: 'AI', path: '/ai', shortcut: 'G then A' },
] as const;

const sidebarSpring = { type: 'spring' as const, stiffness: 400, damping: 30 };

export function SettingsSidebar({ onNavigate }: { onNavigate?: () => void } = {}) {
  const location = useLocation();
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
      <AnimatePresence mode="wait">
        <m.div
          key="settings-sidebar-collapsed"
          data-testid="settings-sidebar"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: 40, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects ? { duration: 0 } : sidebarSpring}
          className="flex flex-col items-center bg-background border-r border-border overflow-hidden"
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

          <nav className="flex flex-col items-center gap-1 pt-1" aria-label="Main navigation">
            {navItems.map(({ icon: Icon, label, path, shortcut }) => {
              const active = path === '/'
                ? location.pathname === '/' || location.pathname.startsWith('/pages')
                : location.pathname.startsWith(path);
              return (
                <Link
                  key={path}
                  to={path}
                  onClick={onNavigate}
                  className={cn(
                    'rounded-lg p-1.5 transition-all duration-200 active:scale-[0.95]',
                    active
                      ? 'bg-action text-action-foreground'
                      : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
                  )}
                  title={`${label} (${shortcut})`}
                  aria-label={label}
                >
                  <Icon
                    size={16}
                    className={cn(
                      active && 'drop-shadow-[0_1px_2px_oklch(0_0_0_/_0.25)]',
                      active && path === '/ai' && 'text-primary',
                    )}
                  />
                </Link>
              );
            })}
          </nav>
        </m.div>
      </AnimatePresence>
    );
  }

  return (
    <m.aside
      key="settings-sidebar-expanded"
      data-testid="settings-sidebar"
      initial={reduceEffects ? false : { width: 0, opacity: 0 }}
      animate={{ width: treeSidebarWidth, opacity: 1 }}
      transition={reduceEffects ? { duration: 0 } : sidebarSpring}
      className="relative flex flex-col bg-background border-r border-border overflow-hidden"
    >
      {/* Main nav strip — identical layout to SidebarTreeView so users see one
          consistent app-level nav across every route. */}
      <nav className="flex shrink-0 items-center gap-0.5 px-2 pt-2 pb-1" aria-label="Main navigation">
        {navItems.map(({ icon: Icon, label, path, shortcut }) => {
          const active = path === '/'
            ? location.pathname === '/' || location.pathname.startsWith('/pages')
            : location.pathname.startsWith(path);
          return (
            <Link
              key={path}
              to={path}
              onClick={onNavigate}
              title={`${label} (${shortcut})`}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-all duration-200 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                active
                  ? 'bg-action text-action-foreground font-medium'
                  : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
              )}
            >
              <Icon
                size={14}
                className={cn(
                  active && 'drop-shadow-[0_1px_2px_oklch(0_0_0_/_0.25)]',
                  active && path === '/ai' && 'text-primary',
                )}
              />
              {label}
            </Link>
          );
        })}
        <button
          onClick={toggleTreeSidebar}
          className="flex shrink-0 items-center gap-0.5 rounded-lg p-1.5 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors"
          aria-label="Collapse sidebar"
          title="Collapse sidebar (,)"
        >
          <PanelLeftClose size={14} />
          <ShortcutHint shortcutId="toggle-sidebar" />
        </button>
      </nav>

      <div className="flex h-8 shrink-0 items-center px-3">
        <span className="text-xs font-semibold text-muted-foreground">Settings</span>
      </div>

      {/* Settings section nav — duplicated from the inner rail that used to
          live in SettingsLayout. Keeps the same data-testid contract so the
          existing SettingsLayout tests still pass without changes. */}
      <nav
        aria-label="Settings"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      >
        {SETTINGS_NAV.map((group) => {
          const visible = group.items.filter((i) => canSeeItem(i, ctx));
          if (visible.length === 0) return null;
          return (
            <section
              key={group.id}
              aria-labelledby={`settings-group-${group.id}`}
              className="mb-3 last:mb-0"
            >
              <h2
                id={`settings-group-${group.id}`}
                className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
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
                        data-legacy-testid={`tab-${item.id}`}
                        className={({ isActive }) =>
                          cn(
                            'block rounded-md px-2.5 py-1.5 text-sm motion-safe:transition-colors motion-safe:duration-150',
                            isActive
                              ? 'bg-foreground/10 text-foreground'
                              : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground/80',
                          )
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
    </m.aside>
  );
}
