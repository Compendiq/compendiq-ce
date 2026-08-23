import { describe, it, expect, beforeEach } from 'vitest';
import { useUiStore } from './ui-store';

describe('ui-store', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset to default state
    useUiStore.setState({
      sidebarCollapsed: false,
      treeSidebarCollapsed: false,
      treeSidebarSpaceKey: undefined,
      treeSidebarWidth: 256,
      articleSidebarCollapsed: false,
      articleSidebarLaptopExpanded: false,
      articleSidebarWidth: 360,
      vimModeEnabled: false,
    });
  });

  // Vim mode moved here from a permanent editor-toolbar slot: a personal
  // preference belongs in one persisted place, read by every open editor,
  // not a per-instance toggle each Editor mount used to own independently.
  it('sets vimModeEnabled on and off', () => {
    expect(useUiStore.getState().vimModeEnabled).toBe(false);
    useUiStore.getState().setVimModeEnabled(true);
    expect(useUiStore.getState().vimModeEnabled).toBe(true);
    useUiStore.getState().setVimModeEnabled(false);
    expect(useUiStore.getState().vimModeEnabled).toBe(false);
  });

  it('clamps setArticleSidebarWidth between 300 and 1200', () => {
    useUiStore.getState().setArticleSidebarWidth(800);
    expect(useUiStore.getState().articleSidebarWidth).toBe(800);

    useUiStore.getState().setArticleSidebarWidth(1200);
    expect(useUiStore.getState().articleSidebarWidth).toBe(1200);

    useUiStore.getState().setArticleSidebarWidth(1500);
    expect(useUiStore.getState().articleSidebarWidth).toBe(1200);

    useUiStore.getState().setArticleSidebarWidth(100);
    expect(useUiStore.getState().articleSidebarWidth).toBe(300);
  });
});
