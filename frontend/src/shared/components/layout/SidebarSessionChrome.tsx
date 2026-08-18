import { cn } from '../../lib/cn';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

/**
 * Session chrome for the left rail — theme + account.
 *
 * Lives at the foot of both sidebars (Pages tree and Settings) so it stays
 * reachable when the header is only logo + mobile hamburger. Compact mode
 * stacks the same two controls for the 40px rail.
 */
export function SidebarSessionChrome({ compact = false }: { compact?: boolean }) {
  return (
    <div
      data-testid="sidebar-session-chrome"
      className={cn(
        'flex shrink-0 items-center',
        compact ? 'flex-col gap-1 py-2' : 'justify-end gap-0.5',
      )}
    >
      <ThemeToggle />
      <UserMenu align="start" />
    </div>
  );
}
