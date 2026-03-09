import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsLightTheme } from './use-is-light-theme';
import { useThemeStore } from '../../stores/theme-store';

describe('useIsLightTheme', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'midnight-blue' });
  });

  it('returns false for dark themes', () => {
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(false);
  });

  it('returns true when switched to a light theme', () => {
    const { result } = renderHook(() => useIsLightTheme());
    act(() => {
      useThemeStore.getState().setTheme('cloud-white');
    });
    expect(result.current).toBe(true);
  });

  it('returns false when switched back to dark theme', () => {
    useThemeStore.setState({ theme: 'cloud-white' });
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('catppuccin-mocha');
    });
    expect(result.current).toBe(false);
  });

  it('returns true for catppuccin-latte', () => {
    act(() => {
      useThemeStore.getState().setTheme('catppuccin-latte');
    });
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(true);
  });
});
