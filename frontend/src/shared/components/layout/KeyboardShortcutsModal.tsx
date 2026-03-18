import * as Dialog from '@radix-ui/react-dialog';
import { Keyboard, X } from 'lucide-react';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';

function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');
}

function modLabel(): string {
  return isMac() ? '\u2318' : 'Ctrl';
}

interface ShortcutRow {
  keys: string;
  description: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: ShortcutRow[];
}

function getShortcutGroups(): ShortcutGroup[] {
  const mod = modLabel();
  return [
    {
      title: 'Panels',
      shortcuts: [
        { keys: ',', description: 'Toggle left sidebar' },
        { keys: '.', description: 'Toggle right panel (article outline)' },
        { keys: '\\', description: 'Toggle both panels (zen mode)' },
      ],
    },
    {
      title: 'Navigation',
      shortcuts: [
        { keys: `${mod}+K`, description: 'Open command palette / quick search' },
        { keys: `${mod}+N`, description: 'Create new page' },
        { keys: '?', description: 'Show keyboard shortcuts' },
        { keys: `${mod}+/`, description: 'Show keyboard shortcuts' },
      ],
    },
    {
      title: 'Editor',
      shortcuts: [
        { keys: `${mod}+S`, description: 'Save current article' },
        { keys: `${mod}+E`, description: 'Toggle edit / view mode' },
        { keys: 'Esc', description: 'Exit edit mode / close modal' },
      ],
    },
  ];
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

function ShortcutKeysDisplay({ keys }: { keys: string }) {
  const parts = keys.split('+');
  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && <span className="text-muted-foreground/50 text-[10px]">+</span>}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsModal() {
  const isOpen = useKeyboardShortcutsStore((s) => s.isOpen);
  const close = useKeyboardShortcutsStore((s) => s.close);
  const groups = getShortcutGroups();

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/60 bg-card/90 shadow-2xl backdrop-blur-xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
          aria-describedby={undefined}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Keyboard size={18} className="text-primary" />
              Keyboard Shortcuts
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                aria-label="Close shortcuts"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Content */}
          <div className="max-h-[60vh] overflow-y-auto p-5">
            <div className="space-y-5">
              {groups.map((group) => (
                <div key={group.title}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {group.title}
                  </h3>
                  <div className="space-y-1.5">
                    {group.shortcuts.map((shortcut) => (
                      <div
                        key={shortcut.keys}
                        className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-foreground/3"
                      >
                        <span className="text-foreground">{shortcut.description}</span>
                        <ShortcutKeysDisplay keys={shortcut.keys} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border/50 px-5 py-3">
            <p className="text-[11px] text-muted-foreground">
              Shortcuts are disabled when typing in an input, textarea, or the article editor.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
