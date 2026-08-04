import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import type { Editor as EditorType } from '@tiptap/react';

import { useBlockMenuTarget } from './use-block-menu-target';
import { DRAG_HANDLE_LOCK_META, hasBlockMenuTarget, blockMenuTargetRange } from './block-menu-decoration';

/**
 * #1179 — the block menu's open/close side effects.
 *
 * These exist as a hook precisely so they can be tested: `EditorBlockHandle`
 * itself is unreachable under jsdom (the drag-handle plugin resolves its node
 * from `mousemove` coordinates), which previously left the handle lock with no
 * coverage at all. An unreleased lock is invisible in a test but permanent for
 * the user — the handle never tracks the pointer again.
 */

let editor: Editor | null = null;

/**
 * The meta key the third-party drag-handle plugin actually reads, written out
 * as a literal on purpose. Importing the constant here would make the spy move
 * with a typo in it and the contract would go untested — the plugin silently
 * ignores metas it does not recognise, so a misspelling disables the freeze
 * with no error anywhere.
 */
const LIBRARY_LOCK_META = 'lockDragHandle';

/** Records every lock meta the hook dispatches, in order. */
const lockSpyKey = new PluginKey<boolean[]>('lockSpy');

function mount(content = '<p>First</p><p>Second</p>') {
  const seen: Array<boolean | undefined> = [];
  editor = new Editor({ extensions: [StarterKit], content });
  editor.registerPlugin(new Plugin({
    key: lockSpyKey,
    state: {
      init: () => [],
      apply(tr, value) {
        const meta = tr.getMeta(LIBRARY_LOCK_META) as boolean | undefined;
        if (meta !== undefined) seen.push(meta);
        return value;
      },
    },
  }));
  const e = editor as unknown as EditorType;
  const hook = renderHook(() => useBlockMenuTarget(e));
  return { editor: e, hook, locks: seen };
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('useBlockMenuTarget', () => {
  // Pinned against the literal the library reads (see LIBRARY_LOCK_META).
  it('dispatches the meta key the drag-handle plugin actually reads', () => {
    expect(DRAG_HANDLE_LOCK_META).toBe('lockDragHandle');
  });

  it('starts closed with no marker', () => {
    const { editor: e, hook } = mount();
    expect(hook.result.current.target).toBeNull();
    expect(hasBlockMenuTarget(e)).toBe(false);
  });

  it('does nothing when nothing is hovered', () => {
    const { editor: e, hook, locks } = mount();
    act(() => { hook.result.current.open(); });

    expect(hook.result.current.target).toBeNull();
    expect(hasBlockMenuTarget(e)).toBe(false);
    expect(locks).toEqual([]);
  });

  it('opening marks the hovered block AND locks the handle', () => {
    const { editor: e, hook, locks } = mount();
    const secondPos = e.state.doc.child(0).nodeSize;

    act(() => {
      hook.result.current.setHovered({ node: e.state.doc.child(1), pos: secondPos });
      hook.result.current.open();
    });

    expect(hook.result.current.target?.pos).toBe(secondPos);
    expect(blockMenuTargetRange(e)?.from).toBe(secondPos);
    // The lock is what stops the plugin nulling the node out when the pointer
    // travels to the portalled menu.
    expect(locks).toEqual([true]);
  });

  it('closing clears the marker AND releases the handle', () => {
    const { editor: e, hook, locks } = mount();

    act(() => {
      hook.result.current.setHovered({ node: e.state.doc.child(0), pos: 0 });
      hook.result.current.open();
    });
    act(() => { hook.result.current.close(); });

    expect(hook.result.current.target).toBeNull();
    expect(hasBlockMenuTarget(e)).toBe(false);
    // Both directions, in order. Dropping the release leaves the handle frozen
    // for the rest of the editor's life.
    expect(locks).toEqual([true, false]);
  });

  // Escape closes twice for one key press: Radix dismisses in the capture phase
  // and the menu's own handler runs on the bubble. Re-dispatching the unlock and
  // the marker clear on an already-closed menu is noise that hides real
  // double-close bugs, so `close` short-circuits.
  it('closing twice does nothing the second time', () => {
    const { editor: e, hook, locks } = mount();

    act(() => {
      hook.result.current.setHovered({ node: e.state.doc.child(0), pos: 0 });
      hook.result.current.open();
    });
    act(() => {
      hook.result.current.close();
      hook.result.current.close();
    });

    expect(locks).toEqual([true, false]);
  });

  it('releases the handle when the menu unmounts still open', () => {
    const { editor: e, hook, locks } = mount();

    act(() => {
      hook.result.current.setHovered({ node: e.state.doc.child(0), pos: 0 });
      hook.result.current.open();
    });
    hook.unmount();

    expect(locks.at(-1)).toBe(false);
  });

  it('setHovered alone changes nothing — only open() commits', () => {
    const { editor: e, hook, locks } = mount();

    act(() => {
      hook.result.current.setHovered({ node: e.state.doc.child(0), pos: 0 });
    });

    expect(hook.result.current.target).toBeNull();
    expect(hasBlockMenuTarget(e)).toBe(false);
    expect(locks).toEqual([]);
  });

  it('registers the marker plugin, and unregisters it on unmount', () => {
    const { editor: e, hook } = mount();
    // Registered: the read returns a decoration set rather than undefined.
    expect(hasBlockMenuTarget(e)).toBe(false);
    act(() => {
      hook.result.current.setHovered({ node: e.state.doc.child(0), pos: 0 });
      hook.result.current.open();
    });
    expect(hasBlockMenuTarget(e)).toBe(true);

    hook.unmount();

    // Plugin gone — `selectionShouldShow` must read "no block menu", not throw.
    expect(hasBlockMenuTarget(e)).toBe(false);
  });
});
