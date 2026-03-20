import { describe, it, expect } from 'vitest';
import {
  SHORTCUTS,
  getShortcutsByCategory,
  getShortcutHint,
  formatKeysForPlatform,
  getCategoryLabel,
} from './shortcut-registry';

describe('shortcut-registry', () => {
  describe('SHORTCUTS', () => {
    it('contains at least one shortcut', () => {
      expect(SHORTCUTS.length).toBeGreaterThan(0);
    });

    it('has unique ids', () => {
      const ids = SHORTCUTS.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('every shortcut has required fields', () => {
      for (const s of SHORTCUTS) {
        expect(s.id).toBeTruthy();
        expect(s.keys).toBeTruthy();
        expect(s.label).toBeTruthy();
        expect(s.category).toBeTruthy();
      }
    });

    it('includes the new-page shortcut mapped to alt+n (not ctrl+n)', () => {
      const newPage = SHORTCUTS.find((s) => s.id === 'new-page');
      expect(newPage).toBeDefined();
      expect(newPage!.keys).toBe('alt+n');
    });

    it('includes the search shortcut mapped to ctrl+k', () => {
      const search = SHORTCUTS.find((s) => s.id === 'search');
      expect(search).toBeDefined();
      expect(search!.keys).toBe('ctrl+k');
    });

    it('includes toggle-sidebar shortcut mapped to ","', () => {
      const shortcut = SHORTCUTS.find((s) => s.id === 'toggle-sidebar');
      expect(shortcut).toBeDefined();
      expect(shortcut!.keys).toBe(',');
      expect(shortcut!.category).toBe('panels');
    });

    it('includes toggle-right-panel shortcut mapped to "."', () => {
      const shortcut = SHORTCUTS.find((s) => s.id === 'toggle-right-panel');
      expect(shortcut).toBeDefined();
      expect(shortcut!.keys).toBe('.');
      expect(shortcut!.category).toBe('panels');
    });

    it('includes zen-mode shortcut mapped to "\\"', () => {
      const shortcut = SHORTCUTS.find((s) => s.id === 'zen-mode');
      expect(shortcut).toBeDefined();
      expect(shortcut!.keys).toBe('\\');
      expect(shortcut!.category).toBe('panels');
    });

    it('includes shortcuts-help shortcut mapped to "?"', () => {
      const shortcut = SHORTCUTS.find((s) => s.id === 'shortcuts-help');
      expect(shortcut).toBeDefined();
      expect(shortcut!.keys).toBe('?');
      expect(shortcut!.category).toBe('navigation');
    });

    it('includes shortcuts-help-alt shortcut mapped to "ctrl+/"', () => {
      const shortcut = SHORTCUTS.find((s) => s.id === 'shortcuts-help-alt');
      expect(shortcut).toBeDefined();
      expect(shortcut!.keys).toBe('ctrl+/');
      expect(shortcut!.category).toBe('navigation');
    });
  });

  describe('getShortcutsByCategory', () => {
    it('returns a Map with at least one category', () => {
      const grouped = getShortcutsByCategory();
      expect(grouped.size).toBeGreaterThan(0);
    });

    it('groups every shortcut into the correct category', () => {
      const grouped = getShortcutsByCategory();
      let total = 0;
      for (const [category, shortcuts] of grouped) {
        for (const s of shortcuts) {
          expect(s.category).toBe(category);
        }
        total += shortcuts.length;
      }
      expect(total).toBe(SHORTCUTS.length);
    });
  });

  describe('getShortcutHint', () => {
    it('returns the keys string for a known id', () => {
      expect(getShortcutHint('search')).toBe('ctrl+k');
    });

    it('returns undefined for an unknown id', () => {
      expect(getShortcutHint('does-not-exist')).toBeUndefined();
    });
  });

  describe('getCategoryLabel', () => {
    it('returns human-readable labels', () => {
      expect(getCategoryLabel('navigation')).toBe('Navigation');
      expect(getCategoryLabel('actions')).toBe('Actions');
      expect(getCategoryLabel('editor')).toBe('Editor');
      expect(getCategoryLabel('panels')).toBe('Panels');
    });
  });

  describe('formatKeysForPlatform', () => {
    it('formats ctrl as Ctrl on non-Mac', () => {
      expect(formatKeysForPlatform('ctrl+k', false)).toBe('Ctrl+K');
    });

    it('formats ctrl as Command symbol on Mac', () => {
      const result = formatKeysForPlatform('ctrl+k', true);
      expect(result).toBe('\u2318K');
    });

    it('formats alt as Alt on non-Mac', () => {
      expect(formatKeysForPlatform('alt+n', false)).toBe('Alt+N');
    });

    it('formats alt as Option symbol on Mac', () => {
      const result = formatKeysForPlatform('alt+n', true);
      expect(result).toBe('\u2325N');
    });

    it('formats shift as Shift on non-Mac', () => {
      expect(formatKeysForPlatform('shift+s', false)).toBe('Shift+S');
    });

    it('formats shift as arrow symbol on Mac', () => {
      expect(formatKeysForPlatform('shift+s', true)).toBe('\u21E7S');
    });

    it('formats single-char keys as uppercase', () => {
      expect(formatKeysForPlatform('k', false)).toBe('K');
    });

    it('handles literal "+" without mangling via split', () => {
      expect(formatKeysForPlatform('+', false)).toBe('+');
      expect(formatKeysForPlatform('+', true)).toBe('+');
    });

    it('handles literal "-" as a standalone key', () => {
      expect(formatKeysForPlatform('-', false)).toBe('-');
      expect(formatKeysForPlatform('-', true)).toBe('-');
    });

    it('formats esc and enter with labels', () => {
      expect(formatKeysForPlatform('esc', false)).toBe('Esc');
      expect(formatKeysForPlatform('enter', false)).toBe('\u21B5');
    });

    it('handles multi-word keys like /ai as-is', () => {
      // "/ai" splits into ["/ai"] (no + separator) so it stays as-is
      expect(formatKeysForPlatform('/ai', false)).toBe('/ai');
    });
  });
});
