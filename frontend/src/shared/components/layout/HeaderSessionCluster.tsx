import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';
import { UserMenu } from './UserMenu';

/**
 * Inbox + theme + account. Lives in the header landmark so a phone
 * does not have to open the drawer to reach the session.
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
