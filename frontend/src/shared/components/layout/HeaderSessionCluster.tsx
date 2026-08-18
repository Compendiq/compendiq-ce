import { Search } from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { ShortcutHint } from '../ShortcutHint';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

/**
 * Quiet find control for the 48px header. Opens the existing command palette
 * — it is not the Pages corpus search. The word "Find" is the visible name
 * from `sm` up; below that the control is icon-only and the accessible name
 * stays "Find". The shortcut hint hides on touch on purpose.
 */
export function HeaderFindButton() {
  const open = useCommandPaletteStore((s) => s.open);

  return (
    <button
      type="button"
      onClick={open}
      className="nm-icon-button sm:w-auto sm:gap-1 sm:px-2"
      aria-label="Find"
      data-testid="header-find"
    >
      <Search size={16} aria-hidden="true" />
      <span className="hidden text-xs font-medium sm:inline">Find</span>
      <ShortcutHint shortcutId="search" className="ml-0" />
    </button>
  );
}

/**
 * Find + inbox + theme + account. Lives in the header landmark so a phone
 * does not have to open the drawer to reach the session. Stays mounted while
 * the article is being edited — the format tools live in the article column,
 * not this bar.
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
