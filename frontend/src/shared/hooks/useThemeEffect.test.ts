import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useThemeStore } from '../../stores/theme-store';
import { useThemeEffect } from './useThemeEffect';

describe('useThemeEffect', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'void-indigo' });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.add('dark');
  });

  it('does not set data-theme for the default void-indigo theme', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('sets data-theme attribute when a non-default theme is selected', () => {
    useThemeStore.setState({ theme: 'obsidian-violet' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian-violet');
  });

  it('updates data-theme when the theme changes', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();

    act(() => {
      useThemeStore.getState().setTheme('parchment-glow');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('parchment-glow');
  });

  it('removes data-theme when switching back to void-indigo', () => {
    useThemeStore.setState({ theme: 'obsidian-violet' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('obsidian-violet');

    act(() => {
      useThemeStore.getState().setTheme('void-indigo');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('adds dark class for dark themes', () => {
    document.documentElement.classList.remove('dark');
    useThemeStore.setState({ theme: 'obsidian-violet' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class for light themes', () => {
    useThemeStore.setState({ theme: 'polar-slate' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('polar-slate');
  });

  it('removes dark class for parchment-glow (light theme)', () => {
    useThemeStore.setState({ theme: 'parchment-glow' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('toggles dark class when switching between light and dark themes', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('polar-slate');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      useThemeStore.getState().setTheme('obsidian-violet');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
