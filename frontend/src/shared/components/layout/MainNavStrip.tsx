import { Link, useLocation } from 'react-router-dom';
import { BookOpen, Bot, Share2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * The "Pages / AI / Graph" strip that appears at the top of every left
 * sidebar — `SidebarTreeView` on `/`, `/pages/*`, `/ai`, and
 * `SettingsSidebar` on `/settings/*`. Extracted into one component so the
 * two sidebars can't drift in order or in styling. The visual order here
 * is the source of truth.
 *
 * Keyboard shortcuts (g p / g a / g g) are owned by `AppLayout` and stay
 * tied to the mnemonic letter, not to the display order — so reordering
 * here doesn't move keys.
 */
const MAIN_NAV_ITEMS: readonly {
  icon: LucideIcon;
  label: string;
  path: string;
  shortcut: string;
}[] = [
  { icon: BookOpen, label: 'Pages', path: '/', shortcut: 'G then P' },
  { icon: Bot, label: 'AI', path: '/ai', shortcut: 'G then A' },
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
    <nav
      className="flex shrink-0 grow items-center gap-0.5"
      aria-label="Main navigation"
    >
      {MAIN_NAV_ITEMS.map(({ icon: Icon, label, path, shortcut }) => {
        const active = isActive(location.pathname, path);
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
                // AI tab keeps amber on its icon as the AI signal when
                // active (pill is ink, ~7:1+ contrast). When inactive the
                // icon must inherit muted-foreground — amber on light glass
                // is 1.47:1, a WCAG failure.
                active && path === '/ai' && 'text-primary',
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
 * Vertical icon-only nav for the collapsed 40 px rail. Same order, same
 * active-state styling, no labels.
 */
export function MainNavStripCollapsed({ onNavigate }: MainNavStripProps) {
  const location = useLocation();
  return (
    <nav
      className="flex flex-col items-center gap-1 pt-1"
      aria-label="Main navigation"
    >
      {MAIN_NAV_ITEMS.map(({ icon: Icon, label, path, shortcut }) => {
        const active = isActive(location.pathname, path);
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
  );
}
