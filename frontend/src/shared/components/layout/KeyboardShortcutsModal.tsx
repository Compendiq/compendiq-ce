import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Keyboard, Search, X } from 'lucide-react';
import { useKeyboardShortcutsStore } from '../../../stores/keyboard-shortcuts-store';
import { useOnboardingActions } from '../../hooks/use-onboarding';
import { getShortcutsByCategory, getCategoryLabel, formatKeysForPlatform, TIPTAP_SHORTCUTS } from '../../lib/shortcut-registry';
import { isMac } from '../../lib/platform';

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex min-w-[1.5rem] items-center justify-center rounded-md border border-border bg-background/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
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
          {i > 0 && !mac && <span className="text-muted-foreground/50 text-[11px]">+</span>}
          <Kbd>{part}</Kbd>
        </span>
      ))}
    </span>
  );
}

/** One label-plus-keys row. Identical in the registry and TipTap blocks. */
function ShortcutRow({ label, keys }: { label: string; keys: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors hover:bg-foreground/3">
      <span className="text-foreground">{label}</span>
      <ShortcutKeysDisplay keys={keys} />
    </div>
  );
}

export function KeyboardShortcutsModal() {
  const isOpen = useKeyboardShortcutsStore((s) => s.isOpen);
  const close = useKeyboardShortcutsStore((s) => s.close);
  const categories = getShortcutsByCategory();
  const { markComplete } = useOnboardingActions();

  // #1402, milestone 4. This modal is where every discovery path lands — `?`,
  // Ctrl+/, the User Menu item and the checklist's own CTA — so opening it is
  // the signal. No dedupe guard: `markComplete` skips the write once the
  // cached settings report the flag, and the PATCH is idempotent regardless.
  useEffect(() => {
    if (isOpen) markComplete('shortcutsModalViewed');
  }, [isOpen, markComplete]);

  /**
   * Search, over `label` only.
   *
   * 22 registry rows across four categories plus 11 TipTap ones is a 60vh
   * scroller, so the answer to "what was the zen-mode key again" was reading
   * the whole list. Matching `keys` too was tempting and wrong: a query of
   * "s" would then hit every `ctrl+shift+…` row, and the registry entries
   * carry no description to widen the match honestly.
   *
   * The query resets on open rather than on close — Radix unmounts the
   * content, so a stale query would otherwise greet the next `?` with a
   * filtered list and no memory of why.
   */
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (isOpen) setQuery('');
  }, [isOpen]);

  // `''.includes('')` is true, so an empty needle keeps every row and the
  // untouched modal renders exactly what it did before this input existed.
  const needle = query.trim().toLowerCase();
  // A category with nothing left is dropped whole: an `<h3>` over empty space
  // reads as "no shortcut here", which is a different claim from "not this one".
  const visibleCategories = [...categories.entries()]
    .map(
      ([category, shortcuts]) =>
        [category, shortcuts.filter((s) => s.label.toLowerCase().includes(needle))] as const,
    )
    .filter(([, shortcuts]) => shortcuts.length > 0);
  const visibleFormatting = TIPTAP_SHORTCUTS.filter((s) =>
    s.label.toLowerCase().includes(needle),
  );
  const nothingMatches = visibleCategories.length === 0 && visibleFormatting.length === 0;

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => { if (!open) close(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 nm-card-elevated outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // Radix would take the Close button — the first tabbable child —
            // which is the one control this dialog already has a key for.
            event.preventDefault();
            searchRef.current?.focus();
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <Dialog.Title className="flex items-center gap-2 text-base font-semibold text-foreground">
              <Keyboard size={18} className="text-action" />
              Keyboard Shortcuts
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                className="nm-icon-button"
                aria-label="Close shortcuts"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          {/* Search — outside the scroller, so it stays put while the list moves */}
          <div className="border-b border-border px-5 py-3">
            <div className="relative flex items-center">
              <Search size={14} className="pointer-events-none absolute left-2.5 text-muted-foreground" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search shortcuts…"
                aria-label="Search shortcuts"
                data-testid="shortcut-search-input"
                className="nm-input pl-8 pr-8"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    searchRef.current?.focus();
                  }}
                  aria-label="Clear shortcut search"
                  className="absolute right-2 text-muted-foreground transition-colors hover:text-foreground"
                  data-testid="shortcut-search-clear"
                >
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="max-h-[60vh] overflow-y-auto p-5">
            <div className="space-y-5">
              {visibleCategories.map(([category, shortcuts]) => (
                <div key={category}>
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {getCategoryLabel(category)}
                  </h3>
                  <div className="space-y-1.5">
                    {shortcuts.map((shortcut) => (
                      <ShortcutRow key={shortcut.id} label={shortcut.label} keys={shortcut.keys} />
                    ))}
                  </div>
                </div>
              ))}

              {/* TipTap formatting shortcuts — display only */}
              {visibleFormatting.length > 0 && (
                <div>
                  <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-widest text-muted-foreground">
                    {getCategoryLabel('formatting')}
                  </h3>
                  <p className="mb-2 text-[11px] text-muted-foreground/60">Active when editing a page</p>
                  <div className="space-y-1.5">
                    {visibleFormatting.map((shortcut) => (
                      <ShortcutRow key={shortcut.id} label={shortcut.label} keys={shortcut.keys} />
                    ))}
                  </div>
                </div>
              )}

              {nothingMatches && (
                <p
                  role="status"
                  className="py-6 text-center text-[13px] text-muted-foreground"
                  data-testid="shortcut-search-empty"
                >
                  No shortcuts match "{query.trim()}"
                </p>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="border-t border-border px-5 py-3">
            <p className="text-[11px] text-muted-foreground">
              Shortcuts are disabled when typing in an input, textarea, or the page editor.
            </p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
