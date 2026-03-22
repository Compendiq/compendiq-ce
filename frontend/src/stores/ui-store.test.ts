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
      articleSidebarWidth: 280,
      singleKeyShortcutsEnabled: true,
    });
  });

  it('has singleKeyShortcutsEnabled defaulting to true', () => {
    expect(useUiStore.getState().singleKeyShortcutsEnabled).toBe(true);
  });

  it('sets singleKeyShortcutsEnabled to false', () => {
    useUiStore.getState().setSingleKeyShortcutsEnabled(false);
    expect(useUiStore.getState().singleKeyShortcutsEnabled).toBe(false);
  });

  it('sets singleKeyShortcutsEnabled back to true', () => {
    useUiStore.getState().setSingleKeyShortcutsEnabled(false);
    useUiStore.getState().setSingleKeyShortcutsEnabled(true);
    expect(useUiStore.getState().singleKeyShortcutsEnabled).toBe(true);
  });
});
