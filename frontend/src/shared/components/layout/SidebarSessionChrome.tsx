import { cn } from '../../lib/cn';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

/**
 * Session chrome for the left rail — theme + account.
 *
 * Kept as a rail-foot building block. The live session cluster now sits in
 * the 48px header (`HeaderSessionCluster`) so account/theme stay in a
 * stable landmark; the sidebars no longer mount this.
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
