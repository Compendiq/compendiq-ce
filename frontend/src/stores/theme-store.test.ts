import { describe, it, expect, beforeEach } from 'vitest';
import {
  useThemeStore,
  THEMES,
  THEME_IDS,
  LIGHT_THEMES,
  THEME_CATEGORIES,
  isLightTheme,
  applyThemeToDocument,
  applyTypographyToDocument,
  FONT_FAMILY_IDS,
  FONT_FAMILY_OPTIONS,
  FONT_SCOPES,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SCOPE,
  validateFontFamily,
  validateFontScope,
  validateThemeId,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  type ThemeId,
} from './theme-store';

describe('theme-store', () => {
  beforeEach(() => {
    useThemeStore.setState({
      theme: 'graphite',
      preference: 'system',
      fontFamily: DEFAULT_FONT_FAMILY,
      fontScope: DEFAULT_FONT_SCOPE,
      dyslexiaSpacing: false,
    });
    localStorage.removeItem('compendiq-theme');
  });

  it('has graphite as the default theme', () => {
    expect(useThemeStore.getState().theme).toBe('graphite');
  });

  it('sets a new theme', () => {
    useThemeStore.getState().setTheme('paper');
    expect(useThemeStore.getState().theme).toBe('paper');
  });

  it('defines the supported typography options and scopes', () => {
    expect(FONT_FAMILY_IDS).toEqual(['inter', 'opendyslexic-alta', 'atkinson', 'system', 'serif']);
    expect(FONT_FAMILY_OPTIONS.map((option) => option.id)).toEqual([...FONT_FAMILY_IDS]);
    expect(FONT_SCOPES).toEqual(['application', 'reading-pane']);
  });

  it('falls back to safe typography defaults for unknown persisted values', () => {
    expect(validateFontFamily('not-a-font')).toBe(DEFAULT_FONT_FAMILY);
    expect(validateFontScope('not-a-scope')).toBe(DEFAULT_FONT_SCOPE);
    expect(validateFontFamily('atkinson')).toBe('atkinson');
    expect(validateFontScope('reading-pane')).toBe('reading-pane');
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
    expect(DEFAULT_DARK_THEME).toBe('graphite');
    expect(DEFAULT_LIGHT_THEME).toBe('paper');
  });

  it('sets light theme', () => {
    useThemeStore.getState().setTheme('paper');
    expect(useThemeStore.getState().theme).toBe('paper');
  });

  it('sets dark theme', () => {
    useThemeStore.getState().setTheme('graphite');
    expect(useThemeStore.getState().theme).toBe('graphite');
  });

  describe('isLightTheme', () => {
    it('returns true for paper', () => {
      expect(isLightTheme('paper')).toBe(true);
    });

    it('returns false for graphite', () => {
      expect(isLightTheme('graphite')).toBe(false);
    });
  });

  describe('applyThemeToDocument', () => {
    it('sets data-theme attribute on document root', () => {
      applyThemeToDocument('paper');
      expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
    });

    it('sets data-theme-type to dark for graphite', () => {
      applyThemeToDocument('graphite');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });

    it('sets data-theme-type to light for paper', () => {
      applyThemeToDocument('paper');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });

    it('adds the dark class when applying a dark theme', () => {
      document.documentElement.classList.remove('dark');
      applyThemeToDocument('graphite');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    });

    it('removes the dark class when applying a light theme', () => {
      document.documentElement.classList.add('dark');
      applyThemeToDocument('paper');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    });
  });

  describe('setTheme applies to document', () => {
    it('updates data-theme when setTheme is called (dark)', () => {
      useThemeStore.getState().setTheme('graphite');
      expect(document.documentElement.getAttribute('data-theme')).toBe('graphite');
      expect(document.documentElement.dataset.themeType).toBe('dark');
    });

    it('updates data-theme-type to light when switching to paper', () => {
      useThemeStore.getState().setTheme('paper');
      expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
      expect(document.documentElement.dataset.themeType).toBe('light');
    });
  });

  describe('typography preferences apply to document', () => {
    it('sets the root attributes used by CSS', () => {
      applyTypographyToDocument('opendyslexic-alta', 'reading-pane', true);

      expect(document.documentElement.dataset.font).toBe('opendyslexic-alta');
      expect(document.documentElement.dataset.fontScope).toBe('reading-pane');
      expect(document.documentElement.dataset.dyslexiaSpacing).toBe('true');
    });

    it('updates typography immediately when preferences change', () => {
      useThemeStore.getState().setFontFamily('serif');
      useThemeStore.getState().setFontScope('reading-pane');
      useThemeStore.getState().setDyslexiaSpacing(true);

      expect(useThemeStore.getState().fontFamily).toBe('serif');
      expect(useThemeStore.getState().fontScope).toBe('reading-pane');
      expect(useThemeStore.getState().dyslexiaSpacing).toBe(true);
      expect(document.documentElement.dataset.font).toBe('serif');
      expect(document.documentElement.dataset.fontScope).toBe('reading-pane');
      expect(document.documentElement.dataset.dyslexiaSpacing).toBe('true');
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
      expect(validIds).toContain('graphite');
      expect(validIds).toContain('paper');
    });

    it('passes through current theme IDs unchanged', () => {
      expect(validateThemeId('graphite')).toBe('graphite');
      expect(validateThemeId('paper')).toBe('paper');
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
      expect(validateThemeId('honey-linen')).toBe('paper');
      expect(validateThemeId('graphite-honey')).toBe('graphite');
    });

    it('lands a migrated honey theme on the matching brightness', () => {
      expect(isLightTheme(validateThemeId('honey-linen'))).toBe(true);
      expect(isLightTheme(validateThemeId('graphite-honey'))).toBe(false);
    });
  });
});

/**
 * Rehydration is the entire point of persisting a preference: a user who picks
 * dark must still be in dark after a reload.
 *
 * These drive the real persist middleware against real localStorage rather than
 * the in-memory store, because the failure mode is specifically that the store
 * comes up with its initial state and writes that over the stored one — which
 * an in-memory `setState` test cannot see.
 */
describe('theme preference survives a reload', () => {
  it('rehydrates an explicitly stored dark preference', async () => {
    localStorage.setItem(
      'compendiq-theme',
      JSON.stringify({ state: { preference: 'dark' }, version: 0 }),
    );

    await useThemeStore.persist.rehydrate();

    expect(useThemeStore.getState().preference).toBe('dark');
    expect(useThemeStore.getState().theme).toBe(DEFAULT_DARK_THEME);
    expect(JSON.parse(localStorage.getItem('compendiq-theme')!).state.preference).toBe('dark');
  });

  it('rehydrates an explicitly stored light preference', async () => {
    localStorage.setItem(
      'compendiq-theme',
      JSON.stringify({ state: { preference: 'light' }, version: 0 }),
    );

    await useThemeStore.persist.rehydrate();

    expect(useThemeStore.getState().preference).toBe('light');
    expect(useThemeStore.getState().theme).toBe(DEFAULT_LIGHT_THEME);
  });

  it('never freezes the resolved palette into storage', async () => {
    localStorage.setItem(
      'compendiq-theme',
      JSON.stringify({ state: { preference: 'system' }, version: 0 }),
    );

    await useThemeStore.persist.rehydrate();

    expect(useThemeStore.getState().preference).toBe('system');
    // A stored palette would win over the live OS reading on the next boot,
    // which is how "follow the OS" silently stops following.
    expect(JSON.parse(localStorage.getItem('compendiq-theme')!).state.theme).toBeUndefined();
  });

  it('rehydrates and persists typography preferences', async () => {
    localStorage.setItem(
      'compendiq-theme',
      JSON.stringify({
        state: { fontFamily: 'opendyslexic-alta', fontScope: 'reading-pane', dyslexiaSpacing: true },
        version: 0,
      }),
    );

    await useThemeStore.persist.rehydrate();

    expect(useThemeStore.getState().fontFamily).toBe('opendyslexic-alta');
    expect(useThemeStore.getState().fontScope).toBe('reading-pane');
    expect(useThemeStore.getState().dyslexiaSpacing).toBe(true);
    expect(document.documentElement.dataset.font).toBe('opendyslexic-alta');
    expect(document.documentElement.dataset.fontScope).toBe('reading-pane');
    expect(document.documentElement.dataset.dyslexiaSpacing).toBe('true');

    const stored = JSON.parse(localStorage.getItem('compendiq-theme')!);
    expect(stored.state).toMatchObject({
      fontFamily: 'opendyslexic-alta',
      fontScope: 'reading-pane',
      dyslexiaSpacing: true,
    });
  });
});
