import { useMemo } from 'react';
import { useThemeStore, type ThemeId } from '../../stores/theme-store';
import { createThemeColorReader, type ReadThemeColor } from '../lib/theme-colors';

/**
 * Resolve palette tokens to concrete colours, re-resolving when the theme
 * changes.
 *
 * For consumers that cannot use `var(--color-…)` — canvas, or any colour that
 * must be alpha-adjusted or mixed in JS first. The store's `theme` is the same
 * signal `useIsLightTheme` and `useThemeEffect` observe, and it is written in
 * lockstep with the `data-theme` / `data-theme-type` attributes on `<html>`
 * (`applyThemeToDocument`), so a re-render on it is exactly a re-render after
 * the new tokens are live.
 *
 * `build` receives a reader bound to one computed-style snapshot plus the
 * active theme (needed only to pick an SSR/jsdom fallback, where no
 * stylesheet exists). Declare it at module scope: it is a memo dependency, so
 * an inline closure would re-resolve on every render.
 */
export function useThemeColors<T>(build: (read: ReadThemeColor, theme: ThemeId) => T): T {
  const theme = useThemeStore((s) => s.theme);
  return useMemo(() => build(createThemeColorReader(), theme), [build, theme]);
}
