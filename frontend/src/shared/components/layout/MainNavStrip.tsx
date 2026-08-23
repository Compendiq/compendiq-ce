import { Link, useLocation } from 'react-router-dom';
import { BookOpen, Bot, Share2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * The "Pages / AI / Graph" strip. It renders in two places: the chassis-level
 * `MainNavChassisRail`, which owns it at desktop widths, and — when a sidebar
 * is passed `embedMainNav` — the top of that sidebar, which is how the mobile
 * drawer gets it. The sidebars are `SidebarTreeView` on `/` and `/pages/*`,
 * `AiConversationsSidebar` on `/ai` and `/ai/c/:id` (#1361), and
 * `SettingsSidebar` on `/settings/*`. Extracted into one component so the
 * three sidebars can't drift in order or in styling. The visual order here
 * is the source of truth.
 *
 * `isActive` is plain `startsWith` for the AI pill, so `/ai` and
 * `/ai/c/<id>` both light it: a reopened conversation is still the AI tab,
 * and no code change was needed for the per-conversation route.
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
    // inspector's Outline/Details tabs and the search-mode toggle. All three
    // are "pick one of N", and they had three different treatments: this one
    // was a bare row with an accent-tinted active item, the inspector a track
    // with a raised tab, the search toggle a third thing again. One pattern
    // now: recessed track, raised neutral active segment.
    <nav
      className="flex shrink-0 grow items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
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
 * App destinations on the grey chassis, left of the workspace card.
 * Column width is `--app-nav-rail-width` (header height + 20px), flush with
 * the workspace — no gutter between this rail and the article. Labels stay
 * visible so this is not an icon-only rail (WCAG 2.5.3). Keyboard shortcuts
 * (g p / g a / g g) remain on AppLayout.
 */
export function MainNavChassisRail({ onNavigate }: MainNavStripProps) {
  const location = useLocation();
  return (
    <nav
      data-testid="main-nav-chassis"
      aria-label="Main navigation"
      className="hidden box-border w-[var(--app-nav-rail-width)] shrink-0 flex-col items-center gap-1 self-stretch px-1 pt-0 md:flex"
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
              // Strip is `--app-nav-rail-width` (64px). px-1 on the nav is 4px
              // on both sides; each 40px control remains centred with 8px of
              // breathing room on either side. No button background on select/hover;
              // marked by the left indicator line at the chassis margin (-left-2).
              'group relative box-border flex h-10 w-10 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg px-0 py-1 text-center text-xs font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              active
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span
              data-testid="nav-marker"
              aria-hidden="true"
              className={cn(
                'absolute -left-2 top-1/2 -translate-y-1/2 w-1 rounded-full transition-all duration-150',
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
              aria-hidden="true"
            />
            {label}
          </Link>
        );
      })}
    </nav>
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
