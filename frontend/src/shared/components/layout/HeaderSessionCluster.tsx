import { Search } from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { ShortcutHint } from '../ShortcutHint';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

/**
 * Find control for the header. Opens the existing command palette — it is
 * not the Pages corpus search. Styled as a centred well so the header has
 * a clear middle, the way a search field does. The accessible name stays
 * "Find". The shortcut hint hides on touch on purpose.
 */
export function HeaderFindButton() {
  const open = useCommandPaletteStore((s) => s.open);

  return (
    <button
      type="button"
      onClick={open}
      className="flex h-8 w-8 shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-80 sm:justify-start sm:px-3"
      aria-label="Find"
      data-testid="header-find"
    >
      <Search size={16} aria-hidden="true" className="shrink-0" />
      <span className="hidden min-w-0 truncate text-sm sm:inline">Find</span>
      <ShortcutHint shortcutId="search" className="ml-auto hidden sm:inline" />
    </button>
  );
}

/**
 * Inbox + theme + account. Find sits in the header centre, not here, so
 * the session cluster can stay a right-aligned utility group. Lives in
 * the header landmark so a phone does not have to open the drawer.
 */
export function HeaderSessionCluster() {
  return (
    <div
      data-testid="header-session-cluster"
      className="flex shrink-0 items-center gap-0.5"
    >
      <NotificationBell />
      <ThemeToggle />
      <UserMenu align="end" />
    </div>
  );
}
