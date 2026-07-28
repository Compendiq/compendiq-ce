import { describe, it, expect, beforeEach } from 'vitest';
import {
  useThemeStore,
  THEMES,
  THEME_IDS,
  LIGHT_THEMES,
  THEME_CATEGORIES,
  isLightTheme,
  applyThemeToDocument,
  validateThemeId,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  type ThemeId,
} from './theme-store';

describe('theme-store', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'slate-steel' });
  });

  it('has slate-steel as the default theme', () => {
    expect(useThemeStore.getState().theme).toBe('slate-steel');
  });

  it('sets a new theme', () => {
    useThemeStore.getState().setTheme('frost-steel');
    expect(useThemeStore.getState().theme).toBe('frost-steel');
  });

  it('defines exactly 2 themes (1 dark + 1 light)', () => {
    expect(THEMES).toHaveLength(2);
    expect(THEME_IDS).toHaveLength(2);
  });

  it('has 1 dark theme', () => {
    expect(THEMES.filter((t) => t.category === 'dark')).toHaveLength(1);
  });

  it('has 1 light theme', () => {
    expect(THEMES.filter((t) => t.category === 'light')).toHaveLength(1);
  });

  it('each theme has required metadata', () => {
    for (const theme of THEMES) {
      expect(theme.id).toBeTruthy();
      expect(theme.label).toBeTruthy();
      expect(theme.description).toBeTruthy();
      expect(theme.category).toBeTruthy();
      expect(theme.preview.bg).toBeTruthy();
      expect(theme.preview.card).toBeTruthy();
      expect(theme.preview.primary).toBeTruthy();
      expect(theme.preview.accent).toBeTruthy();
    }
  });

  it('THEME_IDS and THEMES are consistent', () => {
    const idsFromThemes = THEMES.map((t) => t.id);
    expect(idsFromThemes).toEqual([...THEME_IDS]);
  });

  it('all THEME_IDS are unique', () => {
    const unique = new Set<ThemeId>(THEME_IDS);
    expect(unique.size).toBe(THEME_IDS.length);
  });

  it('LIGHT_THEMES contains only light-category themes', () => {
    const lightIds = THEMES.filter((t) => t.category === 'light').map((t) => t.id);
    for (const id of lightIds) {
      expect(LIGHT_THEMES.has(id)).toBe(true);
    }
    expect(LIGHT_THEMES.size).toBe(lightIds.length);
  });

  it('has 2 theme categories', () => {
    expect(THEME_CATEGORIES).toHaveLength(2);
    expect(THEME_CATEGORIES.map((c) => c.key)).toEqual(['dark', 'light']);
  });

  it('exports correct default theme constants', () => {
    expect(DEFAULT_DARK_THEME).toBe('slate-steel');
    expect(DEFAULT_LIGHT_THEME).toBe('frost-steel');
  });

  it('sets light theme', () => {
    useThemeStore.getState().setTheme('frost-steel');
    expect(useThemeStore.getState().theme).toBe('frost-steel');
  });

  it('sets dark theme', () => {
    useThemeStore.getState().setTheme('slate-steel');
    expect(useThemeStore.getState().theme).toBe('slate-steel');
  });

  describe('isLightTheme', () => {
    it('returns true for frost-steel', () => {
      expect(isLightTheme('frost-steel')).toBe(true);
    });

    it('returns false for slate-steel', () => {
      expect(isLightTheme('slate-steel')).toBe(false);
    });
  });

  describe('applyThemeToDocument', () => {
    it('sets data-theme attribute on document root', () => {
      applyThemeToDocument('frost-steel');
      expect(document.documentElement.getAttribute('data-theme')).toBe('frost-steel');
    });

    it('sets data-theme-type to dark for slate-steel', () => {
      applyThemeToDocument('slate-steel');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });

    it('sets data-theme-type to light for frost-steel', () => {
      applyThemeToDocument('frost-steel');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });

    it('adds the dark class when applying a dark theme', () => {
      document.documentElement.classList.remove('dark');
      applyThemeToDocument('slate-steel');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('removes the dark class when applying a light theme', () => {
      document.documentElement.classList.add('dark');
      applyThemeToDocument('frost-steel');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  describe('setTheme applies to document', () => {
    it('updates data-theme when setTheme is called (dark)', () => {
      useThemeStore.getState().setTheme('slate-steel');
      expect(document.documentElement.getAttribute('data-theme')).toBe('slate-steel');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });

    it('updates data-theme-type to light when switching to frost-steel', () => {
      useThemeStore.getState().setTheme('frost-steel');
      expect(document.documentElement.getAttribute('data-theme')).toBe('frost-steel');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });
  });

  describe('validateThemeId (retirement)', () => {
    it('rejects retired theme IDs as invalid', () => {
      const validIds = [...THEME_IDS] as string[];
      const retiredIds = [
        'void-indigo',
        'obsidian-violet',
        'polar-slate',
        'parchment-glow',
        'ember-dusk',
        'sunrise-cream',
        'midnight-blue',
        'ocean-depth',
        'catppuccin-mocha',
        'cloud-white',
      ];
      for (const id of retiredIds) {
        expect(validIds).not.toContain(id);
      }
    });

    it('accepts the two current theme IDs as valid', () => {
      const validIds = [...THEME_IDS] as string[];
      expect(validIds).toContain('slate-steel');
      expect(validIds).toContain('frost-steel');
    });

    it('passes through current theme IDs unchanged', () => {
      expect(validateThemeId('slate-steel')).toBe('slate-steel');
      expect(validateThemeId('frost-steel')).toBe('frost-steel');
    });

    it('falls back retired light themes to the light default (no silent dark flip)', () => {
      // A user who chose a *light* theme on a previous version should land on
      // the current light default after upgrade — flipping them to dark would
      // be a worse experience than picking the wrong shade of light.
      expect(validateThemeId('polar-slate')).toBe(DEFAULT_LIGHT_THEME);
      expect(validateThemeId('parchment-glow')).toBe(DEFAULT_LIGHT_THEME);
      expect(validateThemeId('sunrise-cream')).toBe(DEFAULT_LIGHT_THEME);
      expect(validateThemeId('cloud-white')).toBe(DEFAULT_LIGHT_THEME);
    });

    it('falls back retired dark/unknown themes to the dark default', () => {
      expect(validateThemeId('void-indigo')).toBe(DEFAULT_DARK_THEME);
      expect(validateThemeId('obsidian-violet')).toBe(DEFAULT_DARK_THEME);
      expect(validateThemeId('midnight-blue')).toBe(DEFAULT_DARK_THEME);
      expect(validateThemeId('catppuccin-mocha')).toBe(DEFAULT_DARK_THEME);
      expect(validateThemeId('totally-made-up-id')).toBe(DEFAULT_DARK_THEME);
      expect(validateThemeId('')).toBe(DEFAULT_DARK_THEME);
    });

    // The honey → steel rebrand retired both halves of the previous pair.
    // Users hold these in localStorage, so each must land on the replacement
    // of the SAME brightness — a light-theme user must not be flipped to dark.
    it('migrates the retired honey pair to its steel replacement', () => {
      expect(validateThemeId('honey-linen')).toBe('frost-steel');
      expect(validateThemeId('graphite-honey')).toBe('slate-steel');
    });

    it('lands a migrated honey theme on the matching brightness', () => {
      expect(isLightTheme(validateThemeId('honey-linen'))).toBe(true);
      expect(isLightTheme(validateThemeId('graphite-honey'))).toBe(false);
    });
  });
});
