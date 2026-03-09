import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useThemeStore } from '../../stores/theme-store';
import { useThemeEffect } from './useThemeEffect';

describe('useThemeEffect', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'midnight-blue' });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.add('dark');
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

  it('adds dark class for dark themes', () => {
    document.documentElement.classList.remove('dark');
    useThemeStore.setState({ theme: 'ocean-depth' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class for bright themes', () => {
    useThemeStore.setState({ theme: 'cloud-white' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('cloud-white');
  });

  it('removes dark class for catppuccin-latte (light catppuccin)', () => {
    useThemeStore.setState({ theme: 'catppuccin-latte' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('keeps dark class for catppuccin-mocha (dark catppuccin)', () => {
    useThemeStore.setState({ theme: 'catppuccin-mocha' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggles dark class when switching between light and dark themes', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('lavender-bloom');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      useThemeStore.getState().setTheme('catppuccin-frappe');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
