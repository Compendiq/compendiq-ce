import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { Keyboard, X } from 'lucide-react';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';
import { useUiStore } from '../../../stores/ui-store';
import { getShortcutsByCategory, getCategoryLabel, formatKeysForPlatform, TIPTAP_SHORTCUTS } from '../../lib/shortcut-registry';
import { isMac } from '../../lib/platform';

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded-md border border-border/60 bg-background/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

function ShortcutKeysDisplay({ keys }: { keys: string }) {
  const mac = isMac();
  const formatted = formatKeysForPlatform(keys, mac);

  // Split formatted string into individual key tokens for styled display.
  // On Mac, modifier symbols are single characters without separators.
  // On non-Mac, keys are separated by "+".
  const parts = mac
    ? formatted.split(/(?<=.)(?=[A-Z0-9/\\,.<>?;:'"[\]{}|`~!@#$%^&*()\-_=+])/u).filter(Boolean)
    : formatted.split('+');

  return (
    <span className="inline-flex items-center gap-0.5">
      {parts.map((part, i) => (
        <span key={i} className="inline-flex items-center gap-0.5">
          {i > 0 && !mac && <span className="text-muted-foreground/50 text-[10px]">+</span>}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}

export function KeyboardShortcutsModal() {
  const isOpen = useKeyboardShortcutsStore((s) => s.isOpen);
  const close = useKeyboardShortcutsStore((s) => s.close);
  const singleKeyEnabled = useUiStore((s) => s.singleKeyShortcutsEnabled);
  const setSingleKeyEnabled = useUiStore((s) => s.setSingleKeyShortcutsEnabled);
  const categories = getShortcutsByCategory();

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
              {[...categories.entries()].map(([category, shortcuts]) => (
                <div key={category}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {getCategoryLabel(category)}
                  </h3>
                  <div className="space-y-1.5">
                    {shortcuts.map((shortcut) => (
                      <div
                        key={shortcut.id}
                        className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-foreground/3"
                      >
                        <span className="text-foreground">{shortcut.label}</span>
                        <ShortcutKeysDisplay keys={shortcut.keys} />
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* TipTap formatting shortcuts — display only */}
              <div>
                <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {getCategoryLabel('formatting')}
                </h3>
                <p className="mb-2 text-[10px] text-muted-foreground/60">Active when editing an article</p>
                <div className="space-y-1.5">
                  {TIPTAP_SHORTCUTS.map((shortcut) => (
                    <div
                      key={shortcut.id}
                      className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-foreground/3"
                    >
                      <span className="text-foreground">{shortcut.label}</span>
                      <ShortcutKeysDisplay keys={shortcut.keys} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border/50 px-5 py-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <label htmlFor="single-key-toggle" className="text-sm font-medium text-foreground cursor-pointer">
                  Single-key shortcuts
                </label>
                <p className="text-[11px] text-muted-foreground">
                  Enable shortcuts like <Kbd>,</Kbd> <Kbd>.</Kbd> <Kbd>\</Kbd> and <Kbd>?</Kbd> that use a single key without Ctrl/Alt
                </p>
              </div>
              <Switch.Root
                id="single-key-toggle"
                checked={singleKeyEnabled}
                onCheckedChange={setSingleKeyEnabled}
                aria-label="Single-key shortcuts"
                className="relative h-5 w-9 shrink-0 rounded-full bg-foreground/10 transition-colors data-[state=checked]:bg-primary outline-none"
              >
                <Switch.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
              </Switch.Root>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Shortcuts are disabled when typing in an input, textarea, or the article editor.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
