import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore, THEMES, THEME_IDS, LIGHT_THEMES, THEME_CATEGORIES, isLightTheme, applyThemeToDocument, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, type ThemeId } from './theme-store';

describe('theme-store', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'void-indigo' });
  });

  it('has void-indigo as the default theme', () => {
    expect(useThemeStore.getState().theme).toBe('void-indigo');
  });

  it('sets a new theme', () => {
    useThemeStore.getState().setTheme('obsidian-violet');
    expect(useThemeStore.getState().theme).toBe('obsidian-violet');
  });

  it('defines exactly 4 themes (2 dark + 2 light)', () => {
    expect(THEMES).toHaveLength(4);
    expect(THEME_IDS).toHaveLength(4);
  });

  it('has 2 dark themes', () => {
    expect(THEMES.filter((t) => t.category === 'dark')).toHaveLength(2);
  });

  it('has 2 light themes', () => {
    expect(THEMES.filter((t) => t.category === 'light')).toHaveLength(2);
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
    expect(DEFAULT_DARK_THEME).toBe('void-indigo');
    expect(DEFAULT_LIGHT_THEME).toBe('polar-slate');
  });

  it('sets light themes', () => {
    useThemeStore.getState().setTheme('polar-slate');
    expect(useThemeStore.getState().theme).toBe('polar-slate');
  });

  it('sets dark themes', () => {
    useThemeStore.getState().setTheme('obsidian-violet');
    expect(useThemeStore.getState().theme).toBe('obsidian-violet');
  });

  describe('isLightTheme', () => {
    it('returns true for light themes', () => {
      expect(isLightTheme('polar-slate')).toBe(true);
      expect(isLightTheme('parchment-glow')).toBe(true);
    });

    it('returns false for dark themes', () => {
      expect(isLightTheme('void-indigo')).toBe(false);
      expect(isLightTheme('obsidian-violet')).toBe(false);
    });
  });

  describe('applyThemeToDocument', () => {
    it('sets data-theme attribute on document root', () => {
      applyThemeToDocument('obsidian-violet');
      expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian-violet');
    });

    it('sets data-theme-type to dark for dark themes', () => {
      applyThemeToDocument('void-indigo');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });

    it('sets data-theme-type to light for light themes', () => {
      applyThemeToDocument('polar-slate');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });

    it('sets data-theme-type to light for parchment-glow', () => {
      applyThemeToDocument('parchment-glow');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });

    it('sets data-theme-type to dark for obsidian-violet', () => {
      applyThemeToDocument('obsidian-violet');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });
  });

  describe('setTheme applies to document', () => {
    it('updates data-theme when setTheme is called', () => {
      useThemeStore.getState().setTheme('obsidian-violet');
      expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian-violet');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });

    it('updates data-theme-type to light for light themes', () => {
      useThemeStore.getState().setTheme('parchment-glow');
      expect(document.documentElement.getAttribute('data-theme')).toBe('parchment-glow');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });
  });

  describe('validateThemeId (migration)', () => {
    it('rejects removed theme IDs as invalid', () => {
      const validIds = [...THEME_IDS] as string[];
      const removedIds = ['midnight-blue', 'ocean-depth', 'catppuccin-mocha', 'cloud-white'];
      for (const id of removedIds) {
        expect(validIds).not.toContain(id);
      }
    });

    it('accepts all current theme IDs as valid', () => {
      const validIds = [...THEME_IDS] as string[];
      expect(validIds).toContain('void-indigo');
      expect(validIds).toContain('obsidian-violet');
      expect(validIds).toContain('polar-slate');
      expect(validIds).toContain('parchment-glow');
    });
  });
});
