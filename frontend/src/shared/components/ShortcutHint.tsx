import { getShortcutHint, formatKeysForPlatform } from '../lib/shortcut-registry';

interface ShortcutHintProps {
  /** Shortcut id from the registry (e.g. "search", "new-page"). */
  shortcutId: string;
  /** Extra CSS classes applied to the outer <kbd>. */
  className?: string;
}

/**
 * Detect whether the current platform is macOS using the modern
 * `navigator.userAgentData` API with a `navigator.userAgent` fallback.
 */
function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  // Modern API (Chromium 90+)
  if ('userAgentData' in navigator && (navigator as Record<string, unknown>).userAgentData) {
    const uad = (navigator as Record<string, unknown>).userAgentData as { platform?: string };
    if (uad.platform) return uad.platform === 'macOS';
  }
  // Fallback to userAgent (works in all browsers)
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
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

  const isMac = isMacPlatform();
  const formatted = formatKeysForPlatform(keys, isMac);

  return (
    <kbd
      className={`ml-1.5 inline-flex items-center rounded border border-border/40 bg-background/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground ${className}`.trim()}
    >
      {formatted}
    </kbd>
  );
}
