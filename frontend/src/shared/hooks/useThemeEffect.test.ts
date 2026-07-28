import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useThemeStore } from '../../stores/theme-store';
import { useThemeEffect } from './useThemeEffect';

/**
 * useThemeEffect is a thin subscriber that delegates to the canonical
 * `applyThemeToDocument` writer in the store. These tests assert the
 * resulting DOM contract (data-theme always present, data-theme-type and
 * the `dark` class kept in lockstep) rather than re-testing the writer
 * itself, which has its own coverage in theme-store.test.ts.
 */
describe('useThemeEffect', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'slate-steel' });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-type');
    document.documentElement.classList.remove('dark');
  });

  it('sets data-theme to slate-steel for the default theme', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('slate-steel');
    expect(document.documentElement.dataset.themeType).toBe('dark');
  });

  it('sets data-theme attribute when frost-steel is selected', () => {
    useThemeStore.setState({ theme: 'frost-steel' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('frost-steel');
    expect(document.documentElement.dataset.themeType).toBe('light');
  });

  it('updates data-theme when the theme changes', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('slate-steel');

    act(() => {
      useThemeStore.getState().setTheme('frost-steel');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('frost-steel');
  });

  it('updates data-theme back to slate-steel when switching from frost-steel', () => {
    useThemeStore.setState({ theme: 'frost-steel' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('frost-steel');

    act(() => {
      useThemeStore.getState().setTheme('slate-steel');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('slate-steel');
    expect(document.documentElement.dataset.themeType).toBe('dark');
  });

  it('keeps dark class for slate-steel', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class for frost-steel', () => {
    useThemeStore.setState({ theme: 'frost-steel' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('frost-steel');
  });

  it('toggles dark class when switching between frost-steel and slate-steel', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('frost-steel');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      useThemeStore.getState().setTheme('slate-steel');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
