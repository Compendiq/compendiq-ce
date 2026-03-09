import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore, THEMES, THEME_IDS, LIGHT_THEMES, THEME_CATEGORIES, isLightTheme, applyThemeToDocument, type ThemeId } from './theme-store';

describe('theme-store', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'midnight-blue' });
  });

  it('has midnight-blue as the default theme', () => {
    expect(useThemeStore.getState().theme).toBe('midnight-blue');
  });

  it('sets a new theme', () => {
    useThemeStore.getState().setTheme('ocean-depth');
    expect(useThemeStore.getState().theme).toBe('ocean-depth');
  });

  it('defines exactly 24 themes (10 dark + 10 bright + 4 catppuccin)', () => {
    expect(THEMES).toHaveLength(24);
    expect(THEME_IDS).toHaveLength(24);
  });

  it('has 10 dark themes', () => {
    expect(THEMES.filter((t) => t.category === 'dark')).toHaveLength(10);
  });

  it('has 10 bright themes', () => {
    expect(THEMES.filter((t) => t.category === 'bright')).toHaveLength(10);
  });

  it('has 4 catppuccin themes', () => {
    expect(THEMES.filter((t) => t.category === 'catppuccin')).toHaveLength(4);
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

  it('LIGHT_THEMES contains only bright themes and catppuccin-latte', () => {
    const brightIds = THEMES.filter((t) => t.category === 'bright').map((t) => t.id);
    for (const id of brightIds) {
      expect(LIGHT_THEMES.has(id)).toBe(true);
    }
    expect(LIGHT_THEMES.has('catppuccin-latte')).toBe(true);
    // Dark catppuccin themes should not be in LIGHT_THEMES
    expect(LIGHT_THEMES.has('catppuccin-mocha')).toBe(false);
    expect(LIGHT_THEMES.has('catppuccin-macchiato')).toBe(false);
    expect(LIGHT_THEMES.has('catppuccin-frappe')).toBe(false);
  });

  it('has 3 theme categories', () => {
    expect(THEME_CATEGORIES).toHaveLength(3);
    expect(THEME_CATEGORIES.map((c) => c.key)).toEqual(['dark', 'bright', 'catppuccin']);
  });

  it('sets catppuccin themes', () => {
    useThemeStore.getState().setTheme('catppuccin-mocha');
    expect(useThemeStore.getState().theme).toBe('catppuccin-mocha');
  });

  it('sets bright themes', () => {
    useThemeStore.getState().setTheme('cloud-white');
    expect(useThemeStore.getState().theme).toBe('cloud-white');
  });

  describe('isLightTheme', () => {
    it('returns true for light themes', () => {
      expect(isLightTheme('cloud-white')).toBe(true);
      expect(isLightTheme('lavender-bloom')).toBe(true);
      expect(isLightTheme('catppuccin-latte')).toBe(true);
      expect(isLightTheme('ice-crystal')).toBe(true);
    });

    it('returns false for dark themes', () => {
      expect(isLightTheme('midnight-blue')).toBe(false);
      expect(isLightTheme('ocean-depth')).toBe(false);
      expect(isLightTheme('catppuccin-mocha')).toBe(false);
      expect(isLightTheme('violet-storm')).toBe(false);
    });
  });

  describe('applyThemeToDocument', () => {
    it('sets data-theme attribute on document root', () => {
      applyThemeToDocument('ocean-depth');
      expect(document.documentElement.getAttribute('data-theme')).toBe('ocean-depth');
    });

    it('sets data-theme-type to dark for dark themes', () => {
      applyThemeToDocument('midnight-blue');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });

    it('sets data-theme-type to light for light themes', () => {
      applyThemeToDocument('cloud-white');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });

    it('sets data-theme-type to light for catppuccin-latte', () => {
      applyThemeToDocument('catppuccin-latte');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });

    it('sets data-theme-type to dark for catppuccin-mocha', () => {
      applyThemeToDocument('catppuccin-mocha');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });
  });

  describe('setTheme applies to document', () => {
    it('updates data-theme when setTheme is called', () => {
      useThemeStore.getState().setTheme('emerald-dark');
      expect(document.documentElement.getAttribute('data-theme')).toBe('emerald-dark');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });

    it('updates data-theme-type to light for bright themes', () => {
      useThemeStore.getState().setTheme('mint-fresh');
      expect(document.documentElement.getAttribute('data-theme')).toBe('mint-fresh');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });
  });
});
