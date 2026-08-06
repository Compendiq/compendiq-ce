import { getShortcutHint, formatKeysForPlatform } from '../lib/shortcut-registry';
import { isMac } from '../lib/platform';

interface ShortcutHintProps {
  /** Shortcut id from the registry (e.g. "search", "new-page"). */
  shortcutId: string;
  /** Extra CSS classes applied to the outer <kbd>. */
  className?: string;
}

/**
 * Renders a small platform-aware keyboard hint badge.
 *
 * Looks up the `keys` string from the centralized shortcut registry and
 * formats it for the current OS (e.g. Ctrl on Windows/Linux, Command symbol
 * on macOS).  Returns `null` when the id is not found in the registry.
 */
export function ShortcutHint({ shortcutId, className = '' }: ShortcutHintProps) {
  const keys = getShortcutHint(shortcutId);
  if (!keys) return null;

  const mac = isMac();
  const formatted = formatKeysForPlatform(keys, mac);

  return (
    <kbd
      // `hidden sm:inline-flex`: a keyboard hint on a touch device advertises
      // an input the user does not have, and at 11px in a 390px row it read as
      // punctuation rather than a key. Hidden, not removed — the shortcut still
      // works for anyone with a keyboard at any width.
      className={`ml-1.5 hidden items-center rounded border border-border bg-background/50 px-1.5 py-0.5 text-[11px] font-mono text-muted-foreground sm:inline-flex ${className}`.trim()}
    >
      {formatted}
    </kbd>
  );
}
