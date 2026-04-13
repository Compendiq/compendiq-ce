/**
 * Tests verifying that Zustand stores work correctly with individual selectors.
 * Using selectors (e.g. `useStore((s) => s.field)`) instead of bare destructuring
 * (`const { field } = useStore()`) prevents unnecessary re-renders when unrelated
 * state changes occur.
 *
 * These tests validate that each store's selector API returns correct values
 * and that unrelated state changes do not affect selector output references.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from './ui-store';
import { useThemeStore } from './theme-store';
import { useCommandPaletteStore } from './command-palette-store';

describe('Zustand selector patterns', () => {
  describe('useUiStore selectors', () => {
    beforeEach(() => {
      useUiStore.setState({
        sidebarCollapsed: false,
        treeSidebarCollapsed: false,
        treeSidebarSpaceKey: undefined,
        treeSidebarWidth: 256,
      });
    });

    it('returns individual state values via selectors', () => {
      expect(useUiStore.getState().sidebarCollapsed).toBe(false);
      expect(useUiStore.getState().treeSidebarCollapsed).toBe(false);
      expect(useUiStore.getState().treeSidebarSpaceKey).toBeUndefined();
      expect(useUiStore.getState().treeSidebarWidth).toBe(256);
    });

    it('selector returns updated value after state change', () => {
      const selector = (s: ReturnType<typeof useUiStore.getState>) => s.sidebarCollapsed;
      expect(selector(useUiStore.getState())).toBe(false);

      useUiStore.getState().toggleSidebar();
      expect(selector(useUiStore.getState())).toBe(true);
    });

    it('unrelated state change does not affect other selectors output', () => {
      const treeSidebarWidthBefore = useUiStore.getState().treeSidebarWidth;

      // Change an unrelated property
      useUiStore.getState().toggleSidebar();

      // treeSidebarWidth should remain unchanged
      expect(useUiStore.getState().treeSidebarWidth).toBe(treeSidebarWidthBefore);
    });

    it('treeSidebarSpaceKey selector reflects setTreeSidebarSpaceKey', () => {
      useUiStore.getState().setTreeSidebarSpaceKey('DEV');
      expect(useUiStore.getState().treeSidebarSpaceKey).toBe('DEV');

      useUiStore.getState().setTreeSidebarSpaceKey(undefined);
      expect(useUiStore.getState().treeSidebarSpaceKey).toBeUndefined();
    });

    it('treeSidebarWidth selector reflects clamped setTreeSidebarWidth', () => {
      useUiStore.getState().setTreeSidebarWidth(400);
      expect(useUiStore.getState().treeSidebarWidth).toBe(400);

      // Below minimum
      useUiStore.getState().setTreeSidebarWidth(50);
      expect(useUiStore.getState().treeSidebarWidth).toBe(180);

      // Above maximum
      useUiStore.getState().setTreeSidebarWidth(900);
      expect(useUiStore.getState().treeSidebarWidth).toBe(600);
    });

  });

  describe('useThemeStore selectors', () => {
    beforeEach(() => {
      useThemeStore.setState({ theme: 'void-indigo' });
    });

    it('theme selector returns current theme', () => {
      const selector = (s: ReturnType<typeof useThemeStore.getState>) => s.theme;
      expect(selector(useThemeStore.getState())).toBe('void-indigo');
    });

    it('setTheme selector is a stable function', () => {
      const setTheme = useThemeStore.getState().setTheme;
      expect(typeof setTheme).toBe('function');

      setTheme('obsidian-violet');
      expect(useThemeStore.getState().theme).toBe('obsidian-violet');
    });

    it('theme selector reflects setTheme changes', () => {
      const selector = (s: ReturnType<typeof useThemeStore.getState>) => s.theme;

      useThemeStore.getState().setTheme('polar-slate');
      expect(selector(useThemeStore.getState())).toBe('polar-slate');

      useThemeStore.getState().setTheme('parchment-glow');
      expect(selector(useThemeStore.getState())).toBe('parchment-glow');
    });
  });

  describe('useCommandPaletteStore selectors', () => {
    beforeEach(() => {
      useCommandPaletteStore.getState().close();
    });

    it('isOpen selector returns false by default', () => {
      const selector = (s: ReturnType<typeof useCommandPaletteStore.getState>) => s.isOpen;
      expect(selector(useCommandPaletteStore.getState())).toBe(false);
    });

    it('isOpen selector reflects open/close', () => {
      const selector = (s: ReturnType<typeof useCommandPaletteStore.getState>) => s.isOpen;

      useCommandPaletteStore.getState().open();
      expect(selector(useCommandPaletteStore.getState())).toBe(true);

      useCommandPaletteStore.getState().close();
      expect(selector(useCommandPaletteStore.getState())).toBe(false);
    });

    it('close selector is a stable function reference', () => {
      const close = useCommandPaletteStore.getState().close;
      expect(typeof close).toBe('function');

      useCommandPaletteStore.getState().open();
      expect(useCommandPaletteStore.getState().isOpen).toBe(true);

      close();
      expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    });

    it('toggle selector toggles isOpen', () => {
      useCommandPaletteStore.getState().toggle();
      expect(useCommandPaletteStore.getState().isOpen).toBe(true);

      useCommandPaletteStore.getState().toggle();
      expect(useCommandPaletteStore.getState().isOpen).toBe(false);
    });
  });

  describe('selector isolation across stores', () => {
    beforeEach(() => {
      useUiStore.setState({
        sidebarCollapsed: false,
        treeSidebarCollapsed: false,
      });
      useThemeStore.setState({ theme: 'void-indigo' });
      useCommandPaletteStore.getState().close();
    });

    it('changing ui store does not affect theme store', () => {
      const themeBefore = useThemeStore.getState().theme;
      useUiStore.getState().toggleSidebar();
      expect(useThemeStore.getState().theme).toBe(themeBefore);
    });

    it('changing theme store does not affect ui store', () => {
      const sidebarBefore = useUiStore.getState().sidebarCollapsed;
      useThemeStore.getState().setTheme('obsidian-violet');
      expect(useUiStore.getState().sidebarCollapsed).toBe(sidebarBefore);
    });

    it('changing command palette does not affect other stores', () => {
      const themeBefore = useThemeStore.getState().theme;
      const sidebarBefore = useUiStore.getState().sidebarCollapsed;

      useCommandPaletteStore.getState().open();

      expect(useThemeStore.getState().theme).toBe(themeBefore);
      expect(useUiStore.getState().sidebarCollapsed).toBe(sidebarBefore);
    });
  });
});
