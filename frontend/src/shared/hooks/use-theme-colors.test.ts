import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useThemeColors } from './use-theme-colors';
import { FALLBACK_INK, FALLBACK_PAPER, type ReadThemeColor } from '../lib/theme-colors';
import { useThemeStore, isLightTheme, type ThemeId } from '../../stores/theme-store';

/**
 * The point of the hook — as opposed to reading the property once — is that a
 * resolved colour stops being right the moment the user switches theme. That
 * is what these assert; the resolution itself is covered in
 * `../lib/theme-colors.test.ts`.
 */

const buildInk = (read: ReadThemeColor, theme: ThemeId) => ({
  ink: read('--color-foreground', isLightTheme(theme) ? FALLBACK_INK : FALLBACK_PAPER),
});

let sheet: HTMLStyleElement | null = null;

/** Declare the token per theme the way index.css does. */
function installTokens(graphite: string, paper: string): void {
  sheet = document.createElement('style');
  sheet.textContent =
    `:root { --color-foreground: ${graphite}; }` +
    `[data-theme="paper"] { --color-foreground: ${paper}; }`;
  document.head.appendChild(sheet);
}

beforeEach(() => {
  useThemeStore.setState({ theme: 'graphite' });
  document.documentElement.setAttribute('data-theme', 'graphite');
});

afterEach(() => {
  sheet?.remove();
  sheet = null;
});

describe('useThemeColors', () => {
  it('resolves the token declared for the active theme', () => {
    installTokens('#e7e9eb', '#191918');

    const { result } = renderHook(() => useThemeColors(buildInk));

    expect(result.current.ink).toBe('#e7e9eb');
  });

  it('re-resolves after the theme changes', () => {
    installTokens('#e7e9eb', '#191918');

    const { result } = renderHook(() => useThemeColors(buildInk));
    expect(result.current.ink).toBe('#e7e9eb');

    act(() => {
      useThemeStore.getState().setTheme('paper');
    });

    // Same builder, same property — a cached value would still read Graphite's
    // ink onto the Paper pane, which is the defect this hook exists to prevent.
    expect(result.current.ink).toBe('#191918');
  });

  it('holds the resolved value across a render that did not change the theme', () => {
    installTokens('#e7e9eb', '#191918');

    const { result, rerender } = renderHook(() => useThemeColors(buildInk));
    const first = result.current;

    rerender();

    // Identity is stable, so consumers keyed on it (a useCallback painting the
    // graph canvas) do not repaint on unrelated renders.
    expect(result.current).toBe(first);
  });

  it('falls back per theme when no stylesheet is loaded', () => {
    const { result } = renderHook(() => useThemeColors(buildInk));
    expect(result.current.ink).toBe(FALLBACK_PAPER);

    act(() => {
      useThemeStore.getState().setTheme('paper');
    });

    expect(result.current.ink).toBe(FALLBACK_INK);
  });
});
