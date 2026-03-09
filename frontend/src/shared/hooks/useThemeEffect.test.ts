import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useThemeStore } from '../../stores/theme-store';
import { useThemeEffect } from './useThemeEffect';

describe('useThemeEffect', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'midnight-blue' });
    document.documentElement.removeAttribute('data-theme');
  });

  it('does not set data-theme for the default midnight-blue theme', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('sets data-theme attribute when a non-default theme is selected', () => {
    useThemeStore.setState({ theme: 'ocean-depth' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('ocean-depth');
  });

  it('updates data-theme when the theme changes', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();

    act(() => {
      useThemeStore.getState().setTheme('rose-noir');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('rose-noir');
  });

  it('removes data-theme when switching back to midnight-blue', () => {
    useThemeStore.setState({ theme: 'emerald-dark' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('emerald-dark');

    act(() => {
      useThemeStore.getState().setTheme('midnight-blue');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });
});
