import { Search } from 'lucide-react';
import { useCommandPaletteStore } from '../../../stores/command-palette-store';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { ShortcutHint } from '../ShortcutHint';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

/**
 * Quiet find control for the 48px header. Opens the existing command palette
 * — it is not a second search. Icon-only below `sm` so a phone keeps the
 * shortcut hint off a surface that has no keyboard.
 */
export function HeaderFindButton() {
  const open = useCommandPaletteStore((s) => s.open);

  return (
    <button
      type="button"
      onClick={open}
      className="nm-icon-button sm:w-auto sm:gap-1 sm:px-2"
      aria-label="Jump to page or command"
      data-testid="header-find"
    >
      <Search size={16} aria-hidden="true" />
      <ShortcutHint shortcutId="search" className="ml-0" />
    </button>
  );
}

/**
 * Find + inbox + theme + account. Lives in the header landmark so a phone
 * does not have to open the drawer to reach the session. Hidden while the
 * article editor occupies the slot — those 15 tools need the width.
 */
export function HeaderSessionCluster() {
  const editing = useArticleViewStore((s) => s.editing);
  if (editing) return null;

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
