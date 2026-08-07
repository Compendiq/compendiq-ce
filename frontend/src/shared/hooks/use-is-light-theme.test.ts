import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsLightTheme } from './use-is-light-theme';
import { useThemeStore } from '../../stores/theme-store';

describe('useIsLightTheme', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'graphite' });
  });

  it('returns false for the dark theme (graphite)', () => {
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(false);
  });

  it('returns true when switched to paper', () => {
    const { result } = renderHook(() => useIsLightTheme());
    act(() => {
      useThemeStore.getState().setTheme('paper');
    });
    expect(result.current).toBe(true);
  });

  it('returns false when switched back to graphite', () => {
    useThemeStore.setState({ theme: 'paper' });
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('graphite');
    });
    expect(result.current).toBe(false);
  });
});
