/**
 * Centralized keyboard shortcut registry.
 *
 * This is a **display-only** lookup table. Actual key bindings still live at
 * their respective call-sites (AppLayout, CommandPalette, etc.).  The registry
 * exists so the shortcuts modal and ShortcutHint badges can be generated from
 * a single source of truth.
 */

export type ShortcutCategory = 'navigation' | 'actions' | 'editor' | 'panels' | 'formatting';

export interface ShortcutRegistryEntry {
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
export const SHORTCUTS: ShortcutRegistryEntry[] = [
  // -- Navigation --
  { id: 'search', keys: 'ctrl+k', label: 'Search / Command Palette', category: 'navigation' },
  { id: 'ai-mode', keys: '/ai', label: 'AI mode (inside palette)', category: 'navigation' },

  { id: 'shortcuts-help', keys: '?', label: 'Keyboard Shortcuts', category: 'navigation' },
  { id: 'shortcuts-help-alt', keys: 'ctrl+/', label: 'Keyboard Shortcuts', category: 'navigation' },

  // -- Navigation sequences (G then X) --
  { id: 'go-pages', keys: 'g p', label: 'Go to Pages', category: 'navigation' },
  { id: 'go-graph', keys: 'g g', label: 'Go to Graph', category: 'navigation' },
  { id: 'go-ai', keys: 'g a', label: 'Go to AI', category: 'navigation' },
  { id: 'go-settings', keys: 'g s', label: 'Go to Settings', category: 'navigation' },
  { id: 'go-trash', keys: 'g t', label: 'Go to Trash', category: 'navigation' },

  // -- Actions --
  { id: 'new-page', keys: 'alt+n', label: 'New Page', category: 'actions' },
  { id: 'pin-page', keys: 'alt+p', label: 'Pin/Unpin page', category: 'actions' },
  { id: 'delete-page', keys: 'alt+shift+d', label: 'Delete page', category: 'actions' },
  { id: 'ai-improve', keys: 'alt+i', label: 'AI Improve', category: 'actions' },

  // -- Panels --
  { id: 'toggle-sidebar', keys: ',', label: 'Toggle Left Sidebar', category: 'panels' },
  { id: 'toggle-right-panel', keys: '.', label: 'Toggle Right Panel', category: 'panels' },
  { id: 'zen-mode', keys: '\\', label: 'Zen Mode', category: 'panels' },
  { id: 'close-modal', keys: 'esc', label: 'Close dialog / modal', category: 'panels' },

  // -- Editor --
  { id: 'save', keys: 'ctrl+s', label: 'Save article', category: 'editor' },
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
  formatting: 'Formatting (Editor)',
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
export function getShortcutsByCategory(): Map<ShortcutCategory, ShortcutRegistryEntry[]> {
  const map = new Map<ShortcutCategory, ShortcutRegistryEntry[]>();
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

  // Handle space-separated sequence keys (e.g. 'g p' → 'G then P')
  if (keys.includes(' ') && !keys.includes('+')) {
    return keys
      .split(' ')
      .map((k) => k.toUpperCase())
      .join(' then ');
  }

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

/**
 * TipTap editor formatting shortcuts (display-only).
 *
 * These are handled natively by TipTap/ProseMirror and are NOT registered
 * in our keyboard shortcut hook. They are listed here so the shortcuts
 * modal can display them for discoverability.
 */
export const TIPTAP_SHORTCUTS: ShortcutRegistryEntry[] = [
  { id: 'format-bold', keys: 'ctrl+b', label: 'Bold', category: 'formatting' },
  { id: 'format-italic', keys: 'ctrl+i', label: 'Italic', category: 'formatting' },
  { id: 'format-underline', keys: 'ctrl+u', label: 'Underline', category: 'formatting' },
  { id: 'format-undo', keys: 'ctrl+z', label: 'Undo', category: 'formatting' },
  { id: 'format-redo', keys: 'ctrl+shift+z', label: 'Redo', category: 'formatting' },
  { id: 'format-strikethrough', keys: 'ctrl+shift+x', label: 'Strikethrough', category: 'formatting' },
  { id: 'format-code', keys: 'ctrl+`', label: 'Inline code', category: 'formatting' },
  { id: 'format-indent', keys: 'tab', label: 'Indent list', category: 'formatting' },
  { id: 'format-outdent', keys: 'shift+tab', label: 'Outdent list', category: 'formatting' },
  { id: 'format-ol', keys: 'ctrl+shift+7', label: 'Ordered list', category: 'formatting' },
  { id: 'format-ul', keys: 'ctrl+shift+8', label: 'Bullet list', category: 'formatting' },
];
