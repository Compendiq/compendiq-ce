/**
 * Centralized keyboard shortcut registry.
 *
 * This is a **display-only** lookup table. Actual key bindings still live at
 * their respective call-sites (AppLayout, CommandPalette, etc.).  The registry
 * exists so the shortcuts modal and ShortcutHint badges can be generated from
 * a single source of truth.
 */

export type ShortcutCategory = 'navigation' | 'actions' | 'editor' | 'panels';

export interface ShortcutDefinition {
  /** Unique identifier used by ShortcutHint to look up a shortcut. */
  id: string;
  /** Human-readable key combo, e.g. "ctrl+k", "alt+n", "esc". */
  keys: string;
  /** Short label shown in the shortcuts modal. */
  label: string;
  /** Grouping category for the modal. */
  category: ShortcutCategory;
}

/**
 * Master list of keyboard shortcuts exposed to the user.
 *
 * Keep this array in sync with the actual keydown handlers throughout the app.
 * Order within each category determines display order in the modal.
 */
export const SHORTCUTS: ShortcutDefinition[] = [
  // -- Navigation --
  { id: 'search', keys: 'ctrl+k', label: 'Search / Command Palette', category: 'navigation' },
  { id: 'ai-mode', keys: '/ai', label: 'AI mode (inside palette)', category: 'navigation' },

  { id: 'shortcuts-help', keys: '?', label: 'Keyboard Shortcuts', category: 'navigation' },
  { id: 'shortcuts-help-alt', keys: 'ctrl+/', label: 'Keyboard Shortcuts', category: 'navigation' },

  // -- Actions --
  { id: 'new-page', keys: 'alt+n', label: 'New Page', category: 'actions' },

  // -- Panels --
  { id: 'toggle-sidebar', keys: ',', label: 'Toggle Left Sidebar', category: 'panels' },
  { id: 'toggle-right-panel', keys: '.', label: 'Toggle Right Panel', category: 'panels' },
  { id: 'zen-mode', keys: '\\', label: 'Zen Mode', category: 'panels' },
  { id: 'close-modal', keys: 'esc', label: 'Close dialog / modal', category: 'panels' },

  // -- Editor --
  { id: 'toggle-edit', keys: 'ctrl+e', label: 'Toggle Edit Mode', category: 'editor' },

  // -- Editor (diagram lightbox) --
  { id: 'diagram-zoom-in', keys: '+', label: 'Zoom in', category: 'editor' },
  { id: 'diagram-zoom-out', keys: '-', label: 'Zoom out', category: 'editor' },
  { id: 'diagram-reset-zoom', keys: '0', label: 'Reset zoom', category: 'editor' },
];

/** Category labels for display in the shortcuts modal. */
const CATEGORY_LABELS: Record<ShortcutCategory, string> = {
  navigation: 'Navigation',
  actions: 'Actions',
  editor: 'Editor',
  panels: 'Panels',
};

/** Return human-friendly category label. */
export function getCategoryLabel(category: ShortcutCategory): string {
  return CATEGORY_LABELS[category];
}

/**
 * Group shortcuts by category, preserving insertion order.
 *
 * Returns a `Map` so iteration order matches the first occurrence of each
 * category in `SHORTCUTS`.
 */
export function getShortcutsByCategory(): Map<ShortcutCategory, ShortcutDefinition[]> {
  const map = new Map<ShortcutCategory, ShortcutDefinition[]>();
  for (const shortcut of SHORTCUTS) {
    const list = map.get(shortcut.category);
    if (list) {
      list.push(shortcut);
    } else {
      map.set(shortcut.category, [shortcut]);
    }
  }
  return map;
}

/**
 * Look up the `keys` string for a given shortcut id.
 * Returns `undefined` when the id is not registered.
 */
export function getShortcutHint(id: string): string | undefined {
  return SHORTCUTS.find((s) => s.id === id)?.keys;
}

/**
 * Format a `keys` string for the current platform.
 *
 * - On macOS `ctrl` becomes the Command symbol and `alt` becomes Option.
 * - Keys are title-cased and joined with a separator.
 */
export function formatKeysForPlatform(keys: string, isMac: boolean): string {
  // Handle literal single-char keys that would be mangled by split('+')
  if (keys === '+') return '+';
  if (keys === '-') return '-';
  const parts = keys.split('+');
  return parts
    .map((part) => {
      const p = part.trim().toLowerCase();
      if (p === 'ctrl') return isMac ? '\u2318' : 'Ctrl';
      if (p === 'alt') return isMac ? '\u2325' : 'Alt';
      if (p === 'shift') return isMac ? '\u21E7' : 'Shift';
      if (p === 'esc') return 'Esc';
      if (p === 'enter') return '\u21B5';
      // Single character keys are uppercased
      if (p.length === 1) return p.toUpperCase();
      // Multi-char keys like "space"
      return p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join(isMac ? '' : '+');
}
