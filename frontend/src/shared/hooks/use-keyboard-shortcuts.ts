import { useEffect, useCallback, useRef } from 'react';
import { isMac } from '../lib/platform';

export interface ShortcutDefinition {
  /** Human-readable key label (for display). */
  key: string;
  /** Actual KeyboardEvent.key value(s) to match. */
  keys: string[];
  /** Require Ctrl (Windows/Linux) or Cmd (Mac). */
  mod?: boolean;
  /** Require Alt (Option on Mac). */
  alt?: boolean;
  /**
   * Multi-key sequence, e.g. `'g p'`. When set, the shortcut fires only
   * after the full sequence is typed within the timeout window.
   * Sequences count as single-key shortcuts for WCAG toggle purposes.
   */
  sequence?: string;
  /** Description shown in the shortcuts modal. */
  description: string;
  /** Require Shift. */
  shift?: boolean;
  /** Category for grouping in the modal. */
  category: 'navigation' | 'panels' | 'editor' | 'actions';
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

export interface KeyboardShortcutOptions {
  /**
   * When false, shortcuts that use a single key (no Ctrl/Cmd/Alt modifier)
   * are suppressed. Modifier shortcuts always fire regardless.
   * Defaults to `true` (WCAG 2.1.4 — Character Key Shortcuts).
   */
  singleKeyEnabled?: boolean;
  /**
   * Called when the pending sequence prefix changes.
   * Receives the current prefix key (e.g. `'g'`) or `null` when cleared.
   */
  onSequenceChange?: (pending: string | null) => void;
}

/**
 * Hook that registers global keyboard shortcuts on the document.
 *
 * - Suppresses shortcuts when focus is inside an editable element
 *   (input, textarea, contentEditable, TipTap editor), **unless** the
 *   shortcut requires a modifier key (Ctrl/Cmd).
 * - Supports both `Ctrl` (Windows/Linux) and `Cmd` (Mac) via the `mod` flag.
 * - When `singleKeyEnabled` is false, single-key shortcuts are suppressed
 *   while modifier shortcuts continue to work (WCAG 2.1.4 compliance).
 */
export function useKeyboardShortcuts(
  shortcuts: ShortcutDefinition[],
  options?: KeyboardShortcutOptions,
): void {
  // Keep a stable ref so the effect does not re-register on every render.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  const optionsRef = useRef(options);
  optionsRef.current = options;

  // Sequence detection state — stored in refs to avoid re-renders.
  const pendingPrefixRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingPrefix = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (pendingPrefixRef.current !== null) {
      pendingPrefixRef.current = null;
      optionsRef.current?.onSequenceChange?.(null);
    }
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const mac = isMac();
    const singleKeyEnabled = optionsRef.current?.singleKeyEnabled ?? true;
    const currentShortcuts = shortcutsRef.current;

    // ---- Sequence handling (no-modifier, non-editable only) ----
    const hasModifier = event.metaKey || event.ctrlKey || event.altKey;
    const editable = isEditableTarget(event);

    // ESC inside a plain input/textarea/select blurs it so the user can
    // immediately use single-key shortcuts. Limited to native form fields —
    // contentEditable / TipTap have their own ESC semantics (close menu,
    // exit cell, etc.) and we leave those alone. We also bail when another
    // listener already called preventDefault() (e.g. a Radix Dialog that
    // wants to close on ESC and keep focus management intact) — checking
    // defaultPrevented is what lets dialog ESC handlers win cleanly.
    if (event.key === 'Escape' && !hasModifier && !event.defaultPrevented) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        target!.blur();
        return;
      }
    }

    if (!hasModifier && !editable) {
      const key = event.key;

      // 1) If we have a pending prefix, try to complete the sequence
      if (pendingPrefixRef.current !== null) {
        const fullSequence = pendingPrefixRef.current + ' ' + key;
        const match = currentShortcuts.find((s) => s.sequence === fullSequence);
        clearPendingPrefix();

        if (match) {
          // Sequences respect the singleKeyEnabled toggle
          if (!singleKeyEnabled) return;
          event.preventDefault();
          match.action();
          return;
        }
        // No match — fall through to normal processing for this key
      }

      // 2) Check if this key is a prefix of any sequence
      const isPrefix = currentShortcuts.some(
        (s) => s.sequence && s.sequence.startsWith(key + ' '),
      );
      if (isPrefix && singleKeyEnabled) {
        // Start a new sequence; suppress any single-key shortcut for this key
        pendingPrefixRef.current = key;
        optionsRef.current?.onSequenceChange?.(key);
        timeoutRef.current = setTimeout(() => {
          clearPendingPrefix();
        }, 800);
        event.preventDefault();
        return;
      }
    }

    // ---- Standard single/modifier shortcut processing ----
    for (const shortcut of currentShortcuts) {
      // Skip sequence-only shortcuts in the standard loop
      if (shortcut.sequence) continue;

      const modRequired = !!shortcut.mod;
      const altRequired = !!shortcut.alt;
      const shiftRequired = !!shortcut.shift;
      const modPressed = mac ? event.metaKey : event.ctrlKey;

      // If modifier is required, check it; if not required, make sure no modifier is pressed
      if (modRequired && !modPressed) continue;
      if (altRequired && !event.altKey) continue;
      if (shiftRequired && !event.shiftKey) continue;
      if (!shiftRequired && event.shiftKey && (altRequired || modRequired)) continue;
      if (!modRequired && !altRequired && (event.metaKey || event.ctrlKey || event.altKey)) continue;

      // Match against any of the defined key values
      if (!shortcut.keys.includes(event.key)) continue;

      // WCAG 2.1.4: suppress single-key shortcuts when the toggle is off
      if (!modRequired && !altRequired && !shiftRequired && !singleKeyEnabled) continue;

      // Suppress non-modifier shortcuts when inside editable elements
      if (!modRequired && !altRequired && !shiftRequired && isEditableTarget(event)) continue;

      event.preventDefault();
      shortcut.action();
      return;
    }
  }, [clearPendingPrefix]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Clean up any pending timeout on unmount
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [handleKeyDown]);
}
