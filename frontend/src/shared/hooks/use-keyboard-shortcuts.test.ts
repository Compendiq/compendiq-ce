import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useKeyboardShortcuts, type ShortcutDefinition } from './use-keyboard-shortcuts';

function fireKey(
  key: string,
  options: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
  target?: HTMLElement,
) {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  (target ?? document).dispatchEvent(event);
  return event;
}

describe('useKeyboardShortcuts', () => {
  let actionFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    actionFn = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires action when the correct key is pressed', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));
    fireKey(',');
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it('does not fire action for non-matching keys', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));
    fireKey('.');
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('requires modifier key when mod is true', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'Ctrl+K', keys: ['k'], mod: true, description: 'Search', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // Without modifier — should not fire
    fireKey('k');
    expect(actionFn).not.toHaveBeenCalled();

    // With Ctrl — should fire
    fireKey('k', { ctrlKey: true });
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it('accepts metaKey as modifier on Mac-like environments', () => {
    // Mock navigator.platform to simulate Mac
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel', configurable: true });

    const shortcuts: ShortcutDefinition[] = [
      { key: 'Cmd+K', keys: ['k'], mod: true, description: 'Search', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey('k', { metaKey: true });
    expect(actionFn).toHaveBeenCalledTimes(1);

    // Restore platform
    Object.defineProperty(navigator, 'platform', { value: 'Linux x86_64', configurable: true });
  });

  it('suppresses non-modifier shortcuts when target is an input element', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // Create an input and dispatch keydown on it
    const input = document.createElement('input');
    document.body.appendChild(input);

    fireKey(',', {}, input);
    expect(actionFn).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it('suppresses non-modifier shortcuts when target is a textarea', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: '?', keys: ['?'], description: 'Help', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);

    fireKey('?', {}, textarea);
    expect(actionFn).not.toHaveBeenCalled();

    document.body.removeChild(textarea);
  });

  it('suppresses non-modifier shortcuts when target is contentEditable', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const div = document.createElement('div');
    div.contentEditable = 'true';
    document.body.appendChild(div);

    fireKey(',', {}, div);
    expect(actionFn).not.toHaveBeenCalled();

    document.body.removeChild(div);
  });

  it('does not suppress modifier shortcuts inside editable elements', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'Ctrl+S', keys: ['s'], mod: true, description: 'Save', category: 'editor', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const input = document.createElement('input');
    document.body.appendChild(input);

    fireKey('s', { ctrlKey: true }, input);
    expect(actionFn).toHaveBeenCalledTimes(1);

    document.body.removeChild(input);
  });

  it('does not fire non-modifier shortcut when Ctrl is held', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey(',', { ctrlKey: true });
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('does not fire non-modifier shortcut when Alt is held', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey(',', { altKey: true });
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('supports multiple keys in a single shortcut definition', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'Escape', keys: ['Escape', 'Esc'], description: 'Close', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey('Escape');
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it('cleans up event listener on unmount', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    const { unmount } = renderHook(() => useKeyboardShortcuts(shortcuts));
    unmount();

    fireKey(',');
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('skips Escape shortcut action when a dialog element is present in the DOM', () => {
    const escapeAction = vi.fn();
    const shortcuts: ShortcutDefinition[] = [
      {
        key: 'Escape',
        keys: ['Escape'],
        description: 'Exit edit mode',
        category: 'editor',
        action: () => {
          // Simulate the pattern used in PageViewPage: check for open dialogs
          if (document.querySelector('[role="dialog"]')) return;
          escapeAction();
        },
      },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // Without a dialog — should fire
    fireKey('Escape');
    expect(escapeAction).toHaveBeenCalledTimes(1);

    // With a dialog present — should NOT fire the inner action
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);

    fireKey('Escape');
    expect(escapeAction).toHaveBeenCalledTimes(1); // Still 1, not 2

    document.body.removeChild(dialog);
  });

  it('does not fire when an empty shortcuts array is passed', () => {
    renderHook(() => useKeyboardShortcuts([]));
    fireKey(',');
    fireKey('k', { ctrlKey: true });
    // No error should be thrown, no action called
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('prevents default on matching shortcut', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'Ctrl+S', keys: ['s'], mod: true, description: 'Save', category: 'editor', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventSpy = vi.spyOn(event, 'preventDefault');
    document.dispatchEvent(event);

    expect(preventSpy).toHaveBeenCalled();
    expect(actionFn).toHaveBeenCalledTimes(1);
  });
});
