import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { undo, redo } from '@tiptap/pm/history';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VimMode = 'normal' | 'insert' | 'visual';

export interface VimState {
  mode: VimMode;
  /** Pending operator key buffer (e.g. 'd' waiting for motion) */
  pendingKeys: string;
  /** Number prefix for repeat count (e.g. '3' in '3j') */
  countPrefix: string;
  /** Clipboard for yy/dd/p */
  register: string;
  /** Command-line buffer when ':' is active */
  commandBuffer: string | null;
}

export const VIM_PLUGIN_KEY = new PluginKey<VimState>('vim');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getVimState(state: EditorState): VimState {
  return VIM_PLUGIN_KEY.getState(state) ?? defaultVimState();
}

function defaultVimState(): VimState {
  return {
    mode: 'normal',
    pendingKeys: '',
    countPrefix: '',
    register: '',
    commandBuffer: null,
  };
}

/** Apply a partial VimState update via a transaction meta key. */
function updateVimState(view: EditorView, patch: Partial<VimState>): void {
  const tr = view.state.tr;
  tr.setMeta(VIM_PLUGIN_KEY, patch);
  view.dispatch(tr);
}

/** Move the cursor left by `n` characters, clamped to line start. */
function moveLeft(view: EditorView, n = 1): boolean {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const lineStart = from - $pos.parentOffset;
  const newPos = Math.max(lineStart, from - n);
  const tr = state.tr.setSelection(TextSelection.create(state.doc, newPos));
  view.dispatch(tr);
  return true;
}

/** Move the cursor right by `n` characters, clamped to line end. */
function moveRight(view: EditorView, n = 1): boolean {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const lineEnd = from - $pos.parentOffset + $pos.parent.content.size;
  const newPos = Math.min(lineEnd, from + n);
  const tr = state.tr.setSelection(TextSelection.create(state.doc, newPos));
  view.dispatch(tr);
  return true;
}

/**
 * Resolve a position one line down (or up) from the current cursor.
 * Returns the new absolute position in the document, or null if we
 * cannot move.
 */
function resolveVerticalPos(
  state: EditorState,
  direction: 'up' | 'down',
): number | null {
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const currentOffset = $pos.parentOffset;

  // Walk through the document to find the next/previous text block
  let targetBlockStart: number | null = null;
  let targetBlockSize = 0;

  if (direction === 'down') {
    // Find the start of the next textblock after the current one
    const currentBlockEnd = from - currentOffset + $pos.parent.content.size + 1;
    state.doc.nodesBetween(currentBlockEnd, state.doc.content.size, (node, pos) => {
      if (targetBlockStart !== null) return false;
      if (node.isTextblock) {
        targetBlockStart = pos + 1; // +1 to enter the textblock
        targetBlockSize = node.content.size;
        return false;
      }
      return true;
    });
  } else {
    // Find the start of the previous textblock before the current one
    const currentBlockStart = from - currentOffset;
    // We need to find textblocks before the current position
    let lastBlockStart: number | null = null;
    let lastBlockSize = 0;
    state.doc.nodesBetween(0, Math.max(0, currentBlockStart - 1), (node, pos) => {
      if (node.isTextblock) {
        lastBlockStart = pos + 1;
        lastBlockSize = node.content.size;
      }
      return true;
    });
    targetBlockStart = lastBlockStart;
    targetBlockSize = lastBlockSize;
  }

  if (targetBlockStart === null) return null;

  // Try to maintain the same column offset
  const newPos = targetBlockStart + Math.min(currentOffset, targetBlockSize);
  return newPos;
}

function moveDown(view: EditorView, n = 1): boolean {
  for (let i = 0; i < n; i++) {
    const newPos = resolveVerticalPos(view.state, 'down');
    if (newPos === null) break;
    const tr = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, newPos),
    );
    view.dispatch(tr);
  }
  return true;
}

function moveUp(view: EditorView, n = 1): boolean {
  for (let i = 0; i < n; i++) {
    const newPos = resolveVerticalPos(view.state, 'up');
    if (newPos === null) break;
    const tr = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, newPos),
    );
    view.dispatch(tr);
  }
  return true;
}

/** Move to the start of the current line (0 in vim). */
function moveLineStart(view: EditorView): boolean {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const lineStart = from - $pos.parentOffset;
  const tr = state.tr.setSelection(TextSelection.create(state.doc, lineStart));
  view.dispatch(tr);
  return true;
}

/** Move to the end of the current line ($ in vim). */
function moveLineEnd(view: EditorView): boolean {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const lineEnd = from - $pos.parentOffset + $pos.parent.content.size;
  const tr = state.tr.setSelection(TextSelection.create(state.doc, lineEnd));
  view.dispatch(tr);
  return true;
}

/** Move to the start of the document (gg). */
function moveDocStart(view: EditorView): boolean {
  const { state } = view;
  // Find first valid text position
  let pos = 0;
  state.doc.nodesBetween(0, state.doc.content.size, (node, nodePos) => {
    if (pos > 0) return false;
    if (node.isTextblock) {
      pos = nodePos + 1;
      return false;
    }
    return true;
  });
  if (pos > 0) {
    const tr = state.tr.setSelection(TextSelection.create(state.doc, pos));
    view.dispatch(tr);
  }
  return true;
}

/** Move to the end of the document (G). */
function moveDocEnd(view: EditorView): boolean {
  const { state } = view;
  const endPos = state.doc.content.size;
  // Find the last text block and position at its end
  let lastPos = endPos;
  state.doc.nodesBetween(0, endPos, (node, nodePos) => {
    if (node.isTextblock) {
      lastPos = nodePos + 1 + node.content.size;
    }
    return true;
  });
  const tr = state.tr.setSelection(
    TextSelection.create(state.doc, Math.min(lastPos, endPos)),
  );
  view.dispatch(tr);
  return true;
}

/** Move forward by word (w). */
function moveWordForward(view: EditorView, n = 1): boolean {
  const { state } = view;
  let { from } = state.selection;
  const text = state.doc.textBetween(from, state.doc.content.size, '\n');

  for (let i = 0; i < n; i++) {
    // Skip current word characters
    const match = text.slice(from - state.selection.from).match(/^(\S*\s+|\s+)/);
    if (match) {
      from += match[0].length;
    } else {
      from = state.selection.from + text.length;
      break;
    }
  }

  const newPos = Math.min(state.selection.from + text.length, from);
  try {
    const tr = state.tr.setSelection(
      TextSelection.create(state.doc, Math.min(newPos, state.doc.content.size)),
    );
    view.dispatch(tr);
  } catch {
    // Position may be invalid, ignore
  }
  return true;
}

/** Move backward by word (b). */
function moveWordBackward(view: EditorView, n = 1): boolean {
  const { state } = view;
  let { from } = state.selection;
  const text = state.doc.textBetween(0, from, '\n');

  for (let i = 0; i < n; i++) {
    // From end of text, find previous word boundary
    const reversed = text.slice(0, from).split('').reverse().join('');
    const match = reversed.match(/^(\s*\S+)/);
    if (match) {
      from -= match[0].length;
    } else {
      from = 0;
      break;
    }
  }

  const newPos = Math.max(0, from);
  try {
    const tr = state.tr.setSelection(TextSelection.create(state.doc, newPos));
    view.dispatch(tr);
  } catch {
    // Position may be invalid, ignore
  }
  return true;
}

/** Delete the current line (dd). */
function deleteLine(view: EditorView): string {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);

  // Get the parent block node
  const blockStart = $pos.before($pos.depth);
  const blockEnd = $pos.after($pos.depth);
  const lineText = state.doc.textBetween(blockStart, blockEnd, '\n');

  const tr = state.tr.delete(blockStart, blockEnd);
  view.dispatch(tr);
  return lineText;
}

/** Delete a word forward (dw). */
function deleteWord(view: EditorView): void {
  const { state } = view;
  const { from } = state.selection;
  const text = state.doc.textBetween(from, state.doc.content.size, '\n');
  const match = text.match(/^(\S+\s*|\s+)/);
  if (match) {
    const to = from + match[0].length;
    const tr = state.tr.delete(from, to);
    view.dispatch(tr);
  }
}

/** Delete character at cursor (x). */
function deleteChar(view: EditorView): void {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const lineEnd = from - $pos.parentOffset + $pos.parent.content.size;
  if (from < lineEnd) {
    const tr = state.tr.delete(from, from + 1);
    view.dispatch(tr);
  }
}

/** Yank (copy) the current line (yy). */
function yankLine(view: EditorView): string {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const blockStart = $pos.before($pos.depth);
  const blockEnd = $pos.after($pos.depth);
  return state.doc.textBetween(blockStart, blockEnd, '\n');
}

/** Insert a new line below and enter insert mode (o). */
function openLineBelow(view: EditorView): boolean {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const blockEnd = $pos.after($pos.depth);

  // Insert a new paragraph after the current block
  const tr = state.tr.insert(blockEnd, state.schema.nodes.paragraph.create());
  // Position cursor inside the new paragraph
  const newPos = blockEnd + 1;
  tr.setSelection(TextSelection.create(tr.doc, newPos));
  view.dispatch(tr);
  return true;
}

/** Insert a new line above and enter insert mode (O). */
function openLineAbove(view: EditorView): boolean {
  const { state } = view;
  const { from } = state.selection;
  const $pos = state.doc.resolve(from);
  const blockStart = $pos.before($pos.depth);

  const tr = state.tr.insert(blockStart, state.schema.nodes.paragraph.create());
  const newPos = blockStart + 1;
  tr.setSelection(TextSelection.create(tr.doc, newPos));
  view.dispatch(tr);
  return true;
}

// ---------------------------------------------------------------------------
// Visual mode selection helpers
// ---------------------------------------------------------------------------

function extendSelection(view: EditorView, anchor: number, head: number): void {
  const tr = view.state.tr.setSelection(
    TextSelection.create(view.state.doc, anchor, head),
  );
  view.dispatch(tr);
}

// ---------------------------------------------------------------------------
// Normal mode key handler
// ---------------------------------------------------------------------------

function handleNormalKey(
  view: EditorView,
  event: KeyboardEvent,
  vim: VimState,
  onSave?: () => void,
): boolean {
  const key = event.key;

  // Command mode (:)
  if (vim.commandBuffer !== null) {
    if (key === 'Escape') {
      updateVimState(view, { commandBuffer: null });
      return true;
    }
    if (key === 'Enter') {
      const cmd = vim.commandBuffer;
      updateVimState(view, { commandBuffer: null });
      if (cmd === 'w' || cmd === 'wq') {
        onSave?.();
      }
      return true;
    }
    if (key === 'Backspace') {
      const newBuf = vim.commandBuffer.slice(0, -1);
      if (newBuf.length === 0) {
        updateVimState(view, { commandBuffer: null });
      } else {
        updateVimState(view, { commandBuffer: newBuf });
      }
      return true;
    }
    if (key.length === 1) {
      updateVimState(view, { commandBuffer: vim.commandBuffer + key });
      return true;
    }
    return true;
  }

  // Count prefix
  if (/^[1-9]$/.test(key) && !vim.pendingKeys) {
    updateVimState(view, { countPrefix: vim.countPrefix + key });
    return true;
  }
  if (/^[0-9]$/.test(key) && vim.countPrefix && !vim.pendingKeys) {
    // '0' is valid as second digit of count, but also line-start
    if (key === '0' && vim.countPrefix === '') {
      // line start
    } else {
      updateVimState(view, { countPrefix: vim.countPrefix + key });
      return true;
    }
  }

  const count = parseInt(vim.countPrefix || '1', 10);
  const pending = vim.pendingKeys;

  // Pending operator (d, y, g) — count was preserved when operator key was pressed
  if (pending === 'd') {
    updateVimState(view, { pendingKeys: '', countPrefix: '' });
    if (key === 'd') {
      // dd — delete line(s)
      const lines: string[] = [];
      for (let i = 0; i < count; i++) {
        lines.push(deleteLine(view));
      }
      updateVimState(view, { register: lines.join('\n') });
      return true;
    }
    if (key === 'w') {
      // dw — delete word(s)
      for (let i = 0; i < count; i++) deleteWord(view);
      return true;
    }
    // Unknown second key — cancel
    return true;
  }

  if (pending === 'y') {
    updateVimState(view, { pendingKeys: '', countPrefix: '' });
    if (key === 'y') {
      // yy — yank line
      const text = yankLine(view);
      updateVimState(view, { register: text });
      return true;
    }
    return true;
  }

  if (pending === 'g') {
    updateVimState(view, { pendingKeys: '', countPrefix: '' });
    if (key === 'g') {
      // gg — go to start
      moveDocStart(view);
      return true;
    }
    return true;
  }

  // Movement keys — clear count prefix after use (but NOT before operators that need it)
  switch (key) {
    case 'h':
      moveLeft(view, count);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'j':
      moveDown(view, count);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'k':
      moveUp(view, count);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'l':
      moveRight(view, count);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'w':
      moveWordForward(view, count);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'b':
      moveWordBackward(view, count);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case '0':
      moveLineStart(view);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case '$':
      moveLineEnd(view);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'G':
      moveDocEnd(view);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'x':
      for (let i = 0; i < count; i++) deleteChar(view);
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'u':
      // Undo
      for (let i = 0; i < count; i++) {
        undo(view.state, view.dispatch);
      }
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    case 'p': {
      // Paste from register
      if (vim.register) {
        const { state } = view;
        const { from } = state.selection;
        const $pos = state.doc.resolve(from);
        const blockEnd = $pos.after($pos.depth);
        const tr = state.tr.insert(
          blockEnd,
          state.schema.nodes.paragraph.create(
            null,
            state.schema.text(vim.register),
          ),
        );
        view.dispatch(tr);
      }
      if (vim.countPrefix) updateVimState(view, { countPrefix: '' });
      return true;
    }

    // Enter insert mode
    case 'i':
      updateVimState(view, { mode: 'insert', pendingKeys: '', countPrefix: '' });
      return true;
    case 'a': {
      // Insert after cursor
      moveRight(view, 1);
      updateVimState(view, { mode: 'insert', pendingKeys: '', countPrefix: '' });
      return true;
    }
    case 'A':
      moveLineEnd(view);
      updateVimState(view, { mode: 'insert', pendingKeys: '', countPrefix: '' });
      return true;
    case 'I':
      moveLineStart(view);
      updateVimState(view, { mode: 'insert', pendingKeys: '', countPrefix: '' });
      return true;
    case 'o':
      openLineBelow(view);
      updateVimState(view, { mode: 'insert', pendingKeys: '', countPrefix: '' });
      return true;
    case 'O':
      openLineAbove(view);
      updateVimState(view, { mode: 'insert', pendingKeys: '', countPrefix: '' });
      return true;

    // Visual mode
    case 'v':
      updateVimState(view, { mode: 'visual', pendingKeys: '', countPrefix: '' });
      return true;

    // Operators (wait for second key — preserve countPrefix so it propagates)
    case 'd':
      updateVimState(view, { pendingKeys: 'd' });
      return true;
    case 'y':
      updateVimState(view, { pendingKeys: 'y' });
      return true;
    case 'g':
      updateVimState(view, { pendingKeys: 'g' });
      return true;

    // Command mode
    case ':':
      updateVimState(view, { commandBuffer: '' });
      return true;

    // Ctrl+r for redo
    default:
      if (event.ctrlKey && key === 'r') {
        // Redo
        redo(view.state, view.dispatch);
        return true;
      }
      break;
  }

  // Prevent all other keypresses from reaching the editor in normal mode
  // (except Ctrl/Meta combos that may be browser shortcuts)
  if (!event.ctrlKey && !event.metaKey && key.length === 1) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Visual mode key handler
// ---------------------------------------------------------------------------

function handleVisualKey(
  view: EditorView,
  event: KeyboardEvent,
  vim: VimState,
): boolean {
  const key = event.key;
  const { anchor } = view.state.selection;

  if (key === 'Escape' || key === 'v') {
    // Exit visual mode
    const { from } = view.state.selection;
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, from));
    view.dispatch(tr);
    updateVimState(view, { mode: 'normal', pendingKeys: '', countPrefix: '' });
    return true;
  }

  // Movement extends selection
  const count = parseInt(vim.countPrefix || '1', 10);
  let { head } = view.state.selection;

  switch (key) {
    case 'h':
      head = Math.max(0, head - count);
      extendSelection(view, anchor, head);
      return true;
    case 'l':
      head = Math.min(view.state.doc.content.size, head + count);
      extendSelection(view, anchor, head);
      return true;
    case 'j': {
      const newPos = resolveVerticalPos(view.state, 'down');
      if (newPos !== null) extendSelection(view, anchor, newPos);
      return true;
    }
    case 'k': {
      const newPos = resolveVerticalPos(view.state, 'up');
      if (newPos !== null) extendSelection(view, anchor, newPos);
      return true;
    }
    case 'd':
    case 'x': {
      // Delete selection
      const { from: selFrom, to: selTo } = view.state.selection;
      if (selFrom !== selTo) {
        const text = view.state.doc.textBetween(selFrom, selTo);
        const tr = view.state.tr.delete(selFrom, selTo);
        view.dispatch(tr);
        updateVimState(view, { mode: 'normal', register: text, pendingKeys: '', countPrefix: '' });
      }
      return true;
    }
    case 'y': {
      // Yank selection
      const { from: selFrom, to: selTo } = view.state.selection;
      if (selFrom !== selTo) {
        const text = view.state.doc.textBetween(selFrom, selTo);
        const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, selFrom));
        view.dispatch(tr);
        updateVimState(view, { mode: 'normal', register: text, pendingKeys: '', countPrefix: '' });
      }
      return true;
    }
    default:
      break;
  }

  // Block other keys
  if (!event.ctrlKey && !event.metaKey && key.length === 1) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Change callback type for mode notifications
// ---------------------------------------------------------------------------

export type VimModeChangeCallback = (mode: VimMode) => void;
export type VimStateChangeCallback = (state: VimState) => void;

// ---------------------------------------------------------------------------
// TipTap Extension
// ---------------------------------------------------------------------------

export interface VimExtensionOptions {
  /** Callback when the vim mode changes (used to update React state). */
  onModeChange?: VimModeChangeCallback;
  /** Callback when full vim state changes (mode, pending keys, command buffer). */
  onStateChange?: VimStateChangeCallback;
  /** Callback when :w is executed. */
  onSave?: () => void;
}

export const VimExtension = Extension.create<VimExtensionOptions>({
  name: 'vim',

  addOptions() {
    return {
      onModeChange: undefined,
      onSave: undefined,
      onStateChange: undefined,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;

    return [
      new Plugin<VimState>({
        key: VIM_PLUGIN_KEY,

        state: {
          init(): VimState {
            return defaultVimState();
          },
          apply(tr, value): VimState {
            const meta = tr.getMeta(VIM_PLUGIN_KEY) as Partial<VimState> | undefined;
            if (meta) {
              const next = { ...value, ...meta };
              // Fire callbacks
              if (meta.mode !== undefined && meta.mode !== value.mode) {
                options.onModeChange?.(meta.mode);
              }
              options.onStateChange?.(next);
              return next;
            }
            return value;
          },
        },

        props: {
          handleKeyDown(view, event): boolean {
            const vim = getVimState(view.state);

            // Escape always returns to normal mode
            if (event.key === 'Escape') {
              if (vim.mode !== 'normal' || vim.commandBuffer !== null) {
                // Collapse selection if in visual mode
                if (vim.mode === 'visual') {
                  const { from } = view.state.selection;
                  const tr = view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, from),
                  );
                  view.dispatch(tr);
                }
                updateVimState(view, {
                  mode: 'normal',
                  pendingKeys: '',
                  countPrefix: '',
                  commandBuffer: null,
                });
                return true;
              }
              return false;
            }

            if (vim.mode === 'normal') {
              return handleNormalKey(view, event, vim, options.onSave);
            }

            if (vim.mode === 'visual') {
              return handleVisualKey(view, event, vim);
            }

            // Insert mode — let everything through (TipTap handles it)
            return false;
          },
        },
      }),
    ];
  },
});
