import { Search } from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { ShortcutHint } from '../ShortcutHint';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

const FIND_LABEL = 'Find pages & commands';

/**
 * Compact Find control. Opens the command palette — pages and commands,
 * not the Pages list filter. Icon-only below `sm` so a phone keeps the
 * shortcut hint off a surface that has no keyboard. Accessible name
 * starts with the visible "Find" (WCAG 2.5.3).
 */
export function HeaderFindButton() {
  const open = useCommandPaletteStore((s) => s.open);

  return (
    <button
      type="button"
      onClick={open}
      className="nm-icon-button app-find-trigger"
      aria-label={FIND_LABEL}
      data-testid="header-find"
    >
      <Search size={16} aria-hidden="true" />
      <span className="hidden min-w-0 flex-1 items-baseline gap-1 text-left text-sm sm:flex">
        <span className="font-medium text-foreground">Find</span>
        <span className="truncate text-muted-foreground">pages and commands</span>
      </span>
      <ShortcutHint shortcutId="search" className="ml-auto hidden sm:inline" />
    </button>
  );
}

/**
 * Find + inbox + theme + account. Lives in the header landmark so a phone
 * does not have to open the drawer to reach the session.
 */
export function HeaderSessionCluster() {
  return (
    <div
      data-testid="header-session-cluster"
      className="flex shrink-0 items-center gap-0.5"
    >
      <HeaderFindButton />
      <NotificationBell />
      <ThemeToggle />
      <UserMenu align="end" />
    </div>
  );
}
