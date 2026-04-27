import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Switch from '@radix-ui/react-switch';
import { Keyboard, LogOut, Settings, User } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../../stores/auth-store';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';
import { useUiStore } from '../../../stores/ui-store';
import { logoutApi } from '../../lib/api';
import { ShortcutHint } from '../ShortcutHint';

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const openShortcuts = useKeyboardShortcutsStore((s) => s.open);
  const singleKeyEnabled = useUiStore((s) => s.singleKeyShortcutsEnabled);
  const setSingleKeyEnabled = useUiStore((s) => s.setSingleKeyShortcutsEnabled);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-foreground/5 transition-colors outline-none">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/20 text-xs font-medium text-primary">
            {user?.username?.charAt(0).toUpperCase() ?? '?'}
          </div>
          <span className="text-sm font-medium">{user?.username}</span>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="min-w-[180px] rounded-lg border border-border/50 bg-card/90 p-1.5 shadow-xl backdrop-blur-xl"
        >
          <DropdownMenu.Label className="flex items-center gap-2 px-2.5 py-2 text-xs text-muted-foreground">
            <User size={12} />
            Signed in as <span className="font-medium text-foreground">{user?.username}</span>
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="my-1 h-px bg-foreground/10" />
          <DropdownMenu.Item
            onSelect={() => navigate('/settings')}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground transition-colors"
          >
            <Settings size={14} />
            Settings
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={openShortcuts}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground transition-colors"
          >
            <Keyboard size={14} />
            Keyboard Shortcuts
            <ShortcutHint shortcutId="shortcuts-help" className="ml-auto" />
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={(e) => {
              // Prevent closing the dropdown when toggling
              e.preventDefault();
              setSingleKeyEnabled(!singleKeyEnabled);
            }}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground transition-colors"
          >
            <span className="flex-1">Single-key shortcuts</span>
            <Switch.Root
              checked={singleKeyEnabled}
              onCheckedChange={setSingleKeyEnabled}
              aria-label="Single-key shortcuts"
              className="relative h-4 w-7 shrink-0 rounded-full bg-foreground/10 transition-colors data-[state=checked]:bg-primary outline-none"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
            >
              <Switch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-3" />
            </Switch.Root>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-foreground/10" />
          <DropdownMenu.Item
            onSelect={() => void logoutApi()}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground transition-colors"
          >
            <LogOut size={14} />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
