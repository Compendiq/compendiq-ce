import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { BarChart3, Keyboard, LogOut, Settings, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../../stores/auth-store';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';
import { logoutApi } from '../../lib/api';
import { ConfirmDialog } from '../ConfirmDialog';
import { ShortcutHint } from '../ShortcutHint';

export function UserMenu({ align = 'end' }: { align?: 'start' | 'end' } = {}) {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const openShortcuts = useKeyboardShortcutsStore((s) => s.open);
  const [signOutOpen, setSignOutOpen] = useState(false);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="nm-icon-button"
            aria-label={user?.username ? `${user.username} menu` : 'Account menu'}
          >
            <div
              className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground"
              data-testid="user-avatar-initial"
            >
              {user?.username?.charAt(0).toUpperCase() ?? '?'}
            </div>
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align={align}
            sideOffset={8}
            // z-50 sits above the AI sub-header's z-20 sticky strip; without
            // it the portaled menu is clipped behind that strip when the trigger
            // is in the header session cluster.
            className="z-50 min-w-[180px] nm-card-elevated p-1.5"
          >
            <DropdownMenu.Label className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
              <User size={12} />
              Signed in as <span className="font-medium text-foreground">{user?.username}</span>
            </DropdownMenu.Label>
            <DropdownMenu.Separator className="my-1 h-px bg-foreground/10" />
            <DropdownMenu.Item
              onSelect={() => navigate('/settings')}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground transition-colors"
            >
              <Settings size={14} />
              Settings
            </DropdownMenu.Item>
            {user?.role === 'admin' && (
              // /admin/analytics is mounted in App.tsx but no UI links to it.
              // Surface it here so admins can reach the search-effectiveness,
              // content-gap, AI-usage, and knowledge-health dashboards without
              // having to know the URL. Enterprise gating still happens
              // server-side on each /admin/analytics/* endpoint.
              <DropdownMenu.Item
                onSelect={() => navigate('/admin/analytics')}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground transition-colors"
              >
                <BarChart3 size={14} />
                Analytics
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              onSelect={openShortcuts}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground transition-colors"
            >
              <Keyboard size={14} />
              Keyboard Shortcuts
              <ShortcutHint shortcutId="shortcuts-help" className="ml-auto" />
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-foreground/10" />
            <DropdownMenu.Item
              onSelect={() => setSignOutOpen(true)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground transition-colors"
            >
              <LogOut size={14} />
              Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ConfirmDialog
        open={signOutOpen}
        title="Sign out?"
        description="You will need to sign in again to use Compendiq."
        confirmLabel="Sign out"
        onConfirm={() => {
          setSignOutOpen(false);
          void logoutApi();
        }}
        onCancel={() => setSignOutOpen(false)}
      />
    </>
  );
}
