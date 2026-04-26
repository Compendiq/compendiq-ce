import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { useThemeStore } from '../../stores/theme-store';
import { useThemeEffect } from './useThemeEffect';

describe('useThemeEffect', () => {
  beforeEach(() => {
    useThemeStore.setState({ theme: 'graphite-honey' });
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.classList.add('dark');
  });

  it('does not set data-theme for the default graphite-honey theme', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
  });

  it('sets data-theme attribute when honey-linen is selected', () => {
    useThemeStore.setState({ theme: 'honey-linen' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('honey-linen');
  });

  it('updates data-theme when the theme changes', () => {
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();

    act(() => {
      useThemeStore.getState().setTheme('honey-linen');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('honey-linen');
  });

  it('removes data-theme when switching back to graphite-honey', () => {
    useThemeStore.setState({ theme: 'honey-linen' });
    renderHook(() => useThemeEffect());
    expect(document.documentElement.getAttribute('data-theme')).toBe('honey-linen');

    act(() => {
      useThemeStore.getState().setTheme('graphite-honey');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
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
