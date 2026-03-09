import { describe, it, expect, beforeEach } from 'vitest';
import { useThemeStore, THEMES, THEME_IDS, type ThemeId } from './theme-store';

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

  it('defines exactly 10 themes', () => {
    expect(THEMES).toHaveLength(10);
    expect(THEME_IDS).toHaveLength(10);
  });

  it('each theme has required metadata', () => {
    for (const theme of THEMES) {
      expect(theme.id).toBeTruthy();
      expect(theme.label).toBeTruthy();
      expect(theme.description).toBeTruthy();
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
});
