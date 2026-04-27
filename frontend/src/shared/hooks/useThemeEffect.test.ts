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
    useThemeStore.setState({ theme: 'graphite-honey' });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-type');
    document.documentElement.classList.remove('dark');
  });

  it('sets data-theme to graphite-honey for the default theme', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('graphite-honey');
    expect(document.documentElement.dataset.themeType).toBe('dark');
  });

  it('sets data-theme attribute when honey-linen is selected', () => {
    useThemeStore.setState({ theme: 'honey-linen' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('honey-linen');
    expect(document.documentElement.dataset.themeType).toBe('light');
  });

  it('updates data-theme when the theme changes', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('graphite-honey');

    act(() => {
      useThemeStore.getState().setTheme('honey-linen');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('honey-linen');
  });

  it('updates data-theme back to graphite-honey when switching from honey-linen', () => {
    useThemeStore.setState({ theme: 'honey-linen' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('honey-linen');

    act(() => {
      useThemeStore.getState().setTheme('graphite-honey');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('graphite-honey');
    expect(document.documentElement.dataset.themeType).toBe('dark');
  });

  it('keeps dark class for graphite-honey', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class for honey-linen', () => {
    useThemeStore.setState({ theme: 'honey-linen' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('honey-linen');
  });

  it('toggles dark class when switching between honey-linen and graphite-honey', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('honey-linen');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      useThemeStore.getState().setTheme('graphite-honey');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
