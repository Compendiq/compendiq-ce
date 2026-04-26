import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsLightTheme } from './use-is-light-theme';
import { useThemeStore } from '../../stores/theme-store';

describe('useIsLightTheme', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'graphite-honey' });
  });

  it('returns false for the dark theme (graphite-honey)', () => {
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(false);
  });

  it('returns true when switched to honey-linen', () => {
    const { result } = renderHook(() => useIsLightTheme());
    act(() => {
      useThemeStore.getState().setTheme('honey-linen');
    });
    expect(result.current).toBe(true);
  });

  it('returns false when switched back to graphite-honey', () => {
    useThemeStore.setState({ theme: 'honey-linen' });
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('graphite-honey');
    });
    expect(result.current).toBe(false);
  });
});
