import { useEffect, useCallback, useRef } from 'react';

export interface ShortcutDefinition {
  /** Human-readable key label (for display). */
  key: string;
  /** Actual KeyboardEvent.key value(s) to match. */
  keys: string[];
  /** Require Ctrl (Windows/Linux) or Cmd (Mac). */
  mod?: boolean;
  /** Description shown in the shortcuts modal. */
  description: string;
  /** Category for grouping in the modal. */
  category: 'navigation' | 'panels' | 'editor';
  /** Handler to invoke when the shortcut fires. */
  action: () => void;
}

/**
 * Returns true when the target of a keyboard event is an editable element
 * (input, textarea, contentEditable, or a TipTap ProseMirror editor).
 */
function isEditableTarget(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;

  const tagName = target.tagName;
  if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
  if (target.isContentEditable || target.contentEditable === 'true') return true;

  // TipTap wraps its editor inside a div with class "tiptap" or role "textbox"
  if (target.closest?.('.tiptap') || target.closest?.('[role="textbox"]')) return true;

  return false;
}

/**
 * Detect whether the OS is macOS (to choose Cmd vs Ctrl).
 */
function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  // navigator.platform is deprecated but still the most reliable sync check
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');
}

/**
 * Hook that registers global keyboard shortcuts on the document.
 *
 * - Suppresses shortcuts when focus is inside an editable element
 *   (input, textarea, contentEditable, TipTap editor), **unless** the
 *   shortcut requires a modifier key (Ctrl/Cmd).
 * - Supports both `Ctrl` (Windows/Linux) and `Cmd` (Mac) via the `mod` flag.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutDefinition[]): void {
  // Keep a stable ref so the effect does not re-register on every render.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const mac = isMac();

    for (const shortcut of shortcutsRef.current) {
      const modRequired = !!shortcut.mod;
      const modPressed = mac ? event.metaKey : event.ctrlKey;

      // If modifier is required, check it; if not required, make sure no modifier is pressed
      if (modRequired && !modPressed) continue;
      if (!modRequired && (event.metaKey || event.ctrlKey || event.altKey)) continue;

      // Match against any of the defined key values
      if (!shortcut.keys.includes(event.key)) continue;

      // Suppress non-modifier shortcuts when inside editable elements
      if (!modRequired && isEditableTarget(event)) continue;

      event.preventDefault();
      shortcut.action();
      return;
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
