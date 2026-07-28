import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsLightTheme } from './use-is-light-theme';
import { useThemeStore } from '../../stores/theme-store';

describe('useIsLightTheme', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'slate-steel' });
  });

  it('returns false for the dark theme (slate-steel)', () => {
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(false);
  });

  it('returns true when switched to frost-steel', () => {
    const { result } = renderHook(() => useIsLightTheme());
    act(() => {
      useThemeStore.getState().setTheme('frost-steel');
    });
    expect(result.current).toBe(true);
  });

  it('returns false when switched back to slate-steel', () => {
    useThemeStore.setState({ theme: 'frost-steel' });
    const { result } = renderHook(() => useIsLightTheme());
    expect(result.current).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('slate-steel');
    });
    expect(result.current).toBe(false);
  });
});
