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
    // Mock navigator.userAgent to simulate Mac (isMac() uses userAgent fallback)
    const originalUA = navigator.userAgent;
    Object.defineProperty(navigator, 'userAgent', { value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', configurable: true });

    const shortcuts: ShortcutDefinition[] = [
      { key: 'Cmd+K', keys: ['k'], mod: true, description: 'Search', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey('k', { metaKey: true });
    expect(actionFn).toHaveBeenCalledTimes(1);

    // Restore userAgent
    Object.defineProperty(navigator, 'userAgent', { value: originalUA, configurable: true });
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

  it('does not fire single-key shortcut when singleKeyEnabled is false', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts, { singleKeyEnabled: false }));
    fireKey(',');
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('still fires modifier shortcuts when singleKeyEnabled is false', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'Ctrl+K', keys: ['k'], mod: true, description: 'Search', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts, { singleKeyEnabled: false }));
    fireKey('k', { ctrlKey: true });
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it('still fires alt shortcuts when singleKeyEnabled is false', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'Alt+N', keys: ['n'], alt: true, description: 'New page', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts, { singleKeyEnabled: false }));
    fireKey('n', { altKey: true });
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it('fires single-key shortcut when singleKeyEnabled is true (explicit)', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts, { singleKeyEnabled: true }));
    fireKey(',');
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it('fires single-key shortcut when singleKeyEnabled is not provided (defaults to true)', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: ',', keys: [','], description: 'Toggle left', category: 'panels', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));
    fireKey(',');
    expect(actionFn).toHaveBeenCalledTimes(1);
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

  // -- Sequence shortcuts (g-then-x navigation) --

  it('fires action when sequence matches (g then p)', async () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'g p', keys: [], sequence: 'g p', description: 'Go to Pages', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey('g');
    expect(actionFn).not.toHaveBeenCalled();

    fireKey('p');
    expect(actionFn).toHaveBeenCalledTimes(1);
  });

  it('does not fire single-key action during sequence wait', () => {
    const singleAction = vi.fn();
    const seqAction = vi.fn();
    const shortcuts: ShortcutDefinition[] = [
      { key: 'g', keys: ['g'], description: 'Some g shortcut', category: 'navigation', action: singleAction },
      { key: 'g p', keys: [], sequence: 'g p', description: 'Go to Pages', category: 'navigation', action: seqAction },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    // Press g -- should NOT fire the single-key 'g' action because 'g' is a sequence prefix
    fireKey('g');
    expect(singleAction).not.toHaveBeenCalled();
    expect(seqAction).not.toHaveBeenCalled();

    // Press p -- should fire the sequence action
    fireKey('p');
    expect(seqAction).toHaveBeenCalledTimes(1);
    expect(singleAction).not.toHaveBeenCalled();
  });

  it('clears sequence after timeout', async () => {
    vi.useFakeTimers();
    const shortcuts: ShortcutDefinition[] = [
      { key: 'g p', keys: [], sequence: 'g p', description: 'Go to Pages', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey('g');
    // Advance past the 800ms timeout
    vi.advanceTimersByTime(900);

    // Now press p -- should NOT fire because the sequence was cleared
    fireKey('p');
    expect(actionFn).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it('does not start sequence inside editable elements', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'g p', keys: [], sequence: 'g p', description: 'Go to Pages', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts));

    const input = document.createElement('input');
    document.body.appendChild(input);

    fireKey('g', {}, input);
    fireKey('p', {}, input);
    expect(actionFn).not.toHaveBeenCalled();

    document.body.removeChild(input);
  });

  it('respects singleKeyEnabled toggle for sequences', () => {
    const shortcuts: ShortcutDefinition[] = [
      { key: 'g p', keys: [], sequence: 'g p', description: 'Go to Pages', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts, { singleKeyEnabled: false }));

    fireKey('g');
    fireKey('p');
    expect(actionFn).not.toHaveBeenCalled();
  });

  it('calls onSequenceChange callback', () => {
    const onSequenceChange = vi.fn();
    const shortcuts: ShortcutDefinition[] = [
      { key: 'g p', keys: [], sequence: 'g p', description: 'Go to Pages', category: 'navigation', action: actionFn },
    ];

    renderHook(() => useKeyboardShortcuts(shortcuts, { onSequenceChange }));

    fireKey('g');
    expect(onSequenceChange).toHaveBeenCalledWith('g');

    fireKey('p');
    // After match, pending sequence is cleared
    expect(onSequenceChange).toHaveBeenCalledWith(null);
  });
});
