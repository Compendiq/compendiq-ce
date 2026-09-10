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
    useThemeStore.setState({ theme: 'graphite' });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-type');
    document.documentElement.classList.remove('dark');
  });

  it('sets data-theme to graphite for the default theme', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('graphite');
    expect(document.documentElement.dataset.themeType).toBe('dark');
  });

  it('sets data-theme attribute when paper is selected', () => {
    useThemeStore.setState({ theme: 'paper' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
    expect(document.documentElement.dataset.themeType).toBe('light');
  });

  it('updates data-theme when the theme changes', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('graphite');

    act(() => {
      useThemeStore.getState().setTheme('paper');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
  });

  it('updates data-theme back to graphite when switching from paper', () => {
    useThemeStore.setState({ theme: 'paper' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');

    act(() => {
      useThemeStore.getState().setTheme('graphite');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('graphite');
    expect(document.documentElement.dataset.themeType).toBe('dark');
  });

  it('keeps dark class for graphite', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('removes dark class for paper', () => {
    useThemeStore.setState({ theme: 'paper' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.getAttribute('data-theme')).toBe('paper');
  });

  it('toggles dark class when switching between paper and graphite', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    act(() => {
      useThemeStore.getState().setTheme('paper');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    act(() => {
      useThemeStore.getState().setTheme('graphite');
    });
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
