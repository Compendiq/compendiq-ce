import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Switch from '@radix-ui/react-switch';
import { BarChart3, Keyboard, LogOut, Settings, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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

  // Radix opens the trigger on `pointerdown`. Some input environments (software
  // KVMs like Synergy/Barrier, remote/streamed desktop sessions, certain
  // mouse/trackpad drivers) deliver a legacy `click` but never a `pointerdown`,
  // leaving the menu unreachable by mouse while every plain onClick button still
  // works. Drive `open` ourselves so a plain click can also open it, and use a
  // ref to skip the compatibility `click` that follows a real `pointerdown` so
  // normal input doesn't toggle straight back closed.
  const [open, setOpen] = useState(false);
  const pointerHandledRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Radix's outside-dismiss is also pointerdown-based (onPointerDownOutside), so
  // the same pointerdown-less input that needs the click-to-open fallback can't
  // dismiss the menu by clicking away either (Escape still works via keydown).
  // Close on a plain outside click too. The listener runs only while open and is
  // attached after the opening click has already propagated, so it never
  // self-closes; clicks on the trigger (toggle) or inside the portalled menu
  // (item selection) are ignored. Refs scope the check to this menu instead of a
  // global DOM lookup.
  useEffect(() => {
    if (!open) return;
    const onDocumentClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('click', onDocumentClick, true);
    return () => document.removeEventListener('click', onDocumentClick, true);
  }, [open]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          ref={triggerRef}
          onPointerDown={() => {
            pointerHandledRef.current = true;
          }}
          onClick={() => {
            if (pointerHandledRef.current) {
              pointerHandledRef.current = false;
              return;
            }
            setOpen((prev) => !prev);
          }}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground hover:bg-foreground/5 transition-colors outline-none"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-action text-xs font-medium text-action-foreground" data-testid="user-avatar-initial">
            {user?.username?.charAt(0).toUpperCase() ?? '?'}
          </div>
          <span className="text-sm font-medium">{user?.username}</span>
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={contentRef}
          align="end"
          sideOffset={8}
          // z-50 sits above the AI sub-header's z-20 sticky strip; without
          // it the portaled menu is clipped behind that strip when the trigger
          // is in the top-right of the header on /ai.
          className="z-50 min-w-[180px] rounded-lg border border-border/50 bg-card/90 p-1.5 shadow-xl backdrop-blur-xl"
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
          <DropdownMenu.Item
            onSelect={(e) => {
              // Prevent closing the dropdown when toggling
              e.preventDefault();
              setSingleKeyEnabled(!singleKeyEnabled);
            }}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground transition-colors"
          >
            <span className="flex-1">Single-key shortcuts</span>
            <Switch.Root
              checked={singleKeyEnabled}
              onCheckedChange={setSingleKeyEnabled}
              aria-label="Single-key shortcuts"
              className="relative h-4 w-7 shrink-0 rounded-full bg-foreground/10 transition-colors data-[state=checked]:bg-action outline-none"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
            >
              <Switch.Thumb className="block h-3 w-3 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-3" />
            </Switch.Root>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-foreground/10" />
          <DropdownMenu.Item
            onSelect={() => void logoutApi()}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground data-[highlighted]:bg-foreground/10 data-[highlighted]:text-foreground transition-colors"
          >
            <LogOut size={14} />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
