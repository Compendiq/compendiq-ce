import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { BookOpen, Bot, Share2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * The "Pages / AI / Graph" destinations. At desktop widths they are flat tabs
 * in the top app header (`MainNavHeaderTabs`); below `md` they head the
 * mobile drawer through a sidebar's `embedMainNav` (`MainNavStripExpanded`,
 * or `MainNavStripCollapsed` for a collapsed tree). The sidebars are
 * `SidebarTreeView` on `/` and `/pages/*`, `AiConversationsSidebar` on `/ai`
 * and `/ai/c/:id` (#1361), and `SettingsSidebar` on `/settings/*`. One item
 * list so the surfaces can't drift in order or in styling; the visual order
 * here is the source of truth.
 *
 * `isActive` is plain `startsWith` for the AI item, so `/ai` and
 * `/ai/c/<id>` both light it: a reopened conversation is still the AI tab.
 *
 * Keyboard shortcuts (g p / g a / g g) are owned by `AppLayout` and stay
 * tied to the mnemonic letter, not to the display order — so reordering
 * here doesn't move keys.
 */
export const MAIN_NAV_ITEMS: readonly {
  icon: LucideIcon;
  label: string;
  path: string;
  shortcut: string;
  ariaLabel?: string;
}[] = [
  { icon: BookOpen, label: 'Pages', path: '/', shortcut: 'G then P' },
  {
    icon: Bot,
    label: 'AI',
    path: '/ai',
    shortcut: 'G then A',
    // Visible label stays "AI" (WCAG 2.5.3). The longer name tells it apart
    // from the page inspector's Assistant tab, which is a different room.
    ariaLabel: 'AI chat, full page',
  },
  { icon: Share2, label: 'Graph', path: '/graph', shortcut: 'G then G' },
] as const;

function isActive(pathname: string, path: string): boolean {
  // The Pages tab "owns" the root + every /pages/* route; everything else
  // is plain startsWith.
  return path === '/'
    ? pathname === '/' || pathname.startsWith('/pages')
    : pathname.startsWith(path);
}

interface MainNavStripProps {
  /** Optional click handler (mobile slide-over closes the drawer on nav). */
  onNavigate?: () => void;
}

/**
 * Horizontal pill nav for the expanded sidebar width. Each item flexes to
 * fill the available width so the three pills share the rail evenly.
 */
export function MainNavStripExpanded({ onNavigate }: MainNavStripProps) {
  const location = useLocation();
  return (
    // A segmented control on a recessed track — the same shape as the article
    // inspector's tabs, the settings sub-tabs and the search-mode toggle. All
    // are "pick one of N", and they had three different treatments: this one
    // was a bare row with an accent-tinted active item, the inspector a track
    // with a raised tab, the search toggle a third thing again. One pattern
    // now: recessed track, raised neutral active segment — and since 2026-08-31
    // the track carries no border, so the fill is the whole track.
    <nav
      className="flex shrink-0 grow items-center gap-0.5 rounded-md bg-muted p-0.5"
      aria-label="Main navigation"
    >
      {MAIN_NAV_ITEMS.map(({ icon: Icon, label, path, shortcut, ariaLabel }) => {
        const active = isActive(location.pathname, path);
        return (
          <Link
            key={path}
            to={path}
            onClick={onNavigate}
            title={`${ariaLabel ?? label} (${shortcut})`}
            aria-label={ariaLabel}
            className={cn(
              'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'nm-pill-active'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon
              size={13}
              className={cn(
                'transition-colors',
                active && 'text-primary-ink',
              )}
            />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * App destinations as Notion flat tabs in the top bar (app-header).
 * Sits next to the brand logo on desktop (md+).
 */
export function MainNavHeaderTabs({ onNavigate }: MainNavStripProps) {
  const location = useLocation();
  return (
    <nav
      data-testid="main-nav-header"
      aria-label="Main navigation"
      className="hidden md:flex h-full items-center gap-1 ml-2"
    >
      {MAIN_NAV_ITEMS.map(({ icon: Icon, label, path, shortcut, ariaLabel }) => {
        const active = isActive(location.pathname, path);
        return (
          <Link
            key={path}
            to={path}
            onClick={onNavigate}
            title={`${ariaLabel ?? label} (${shortcut})`}
            aria-label={ariaLabel}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-[var(--glass-pill-hover)]',
            )}
          >
            <Icon
              size={14}
              className={cn(
                'transition-colors',
                active
                  ? 'text-primary-ink'
                  : 'text-muted-foreground group-hover:text-foreground',
              )}
              aria-hidden="true"
            />
            <span>{label}</span>
            {active && (
              <span
                data-testid="nav-tab-active-indicator"
                aria-hidden="true"
                className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary-ink"
              />
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Desktop left column on the chassis, left of the workspace card. It hosts
 * the route's sidebar (tree, conversations or settings) directly on the
 * chassis; the destinations themselves live in the header.
 */
export function MainNavChassisRail({ children }: { children: ReactNode }) {
  return (
    <aside
      data-testid="main-nav-chassis"
      aria-label="Navigation sidebar"
      className="hidden md:flex shrink-0 self-stretch"
    >
      {children}
    </aside>
  );
}

/**
 * Vertical icon-only nav for the collapsed 40 px rail. Same order, same
 * active-state styling, no labels. Kept for the mobile drawer; desktop
 * destinations live on MainNavChassisRail.
 */
export function MainNavStripCollapsed({ onNavigate }: MainNavStripProps) {
  const location = useLocation();
  return (
    <nav
      className="flex flex-col items-center gap-1 pt-1"
      aria-label="Main navigation"
    >
      {MAIN_NAV_ITEMS.map(({ icon: Icon, label, path, shortcut, ariaLabel }) => {
        const active = isActive(location.pathname, path);
        return (
          <Link
            key={path}
            to={path}
            onClick={onNavigate}
            className={cn(
              'group relative rounded-lg p-1.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            title={`${ariaLabel ?? label} (${shortcut})`}
            aria-label={ariaLabel ?? label}
          >
            <span
              data-testid="nav-marker"
              aria-hidden="true"
              className={cn(
                'absolute -left-1 top-1/2 -translate-y-1/2 w-1 rounded-full transition-all duration-150',
                active
                  ? 'h-5 bg-primary-ink'
                  : 'h-0 bg-foreground/70 group-hover:h-3',
              )}
            />
            <Icon
              size={16}
              className={cn(
                'transition-colors',
                active
                  ? 'text-primary-ink'
                  : 'text-muted-foreground group-hover:text-foreground',
              )}
            />
          </Link>
        );
      })}
    </nav>
  );
}
