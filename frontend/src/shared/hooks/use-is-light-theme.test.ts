import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsLightTheme } from './use-is-light-theme';
import { useThemeStore } from '../../stores/theme-store';

describe('useIsLightTheme', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'void-indigo' });
  });

  it('returns false for dark themes', () => {
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(false);
  });

  it('returns true when switched to a light theme', () => {
    const { result } = renderHook(() => useIsLightTheme());
    act(() => {
      useThemeStore.getState().setTheme('polar-slate');
    });
    expect(result.current).toBe(true);
  });

  it('returns false when switched back to dark theme', () => {
    useThemeStore.setState({ theme: 'polar-slate' });
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('obsidian-violet');
    });
    expect(result.current).toBe(false);
  });

  it('returns true for parchment-glow', () => {
    act(() => {
      useThemeStore.getState().setTheme('parchment-glow');
    });
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(true);
  });
});
