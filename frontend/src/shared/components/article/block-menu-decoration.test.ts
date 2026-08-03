import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import type { Editor as EditorType } from '@tiptap/react';
import {
  BLOCK_MENU_TARGET_CLASS,
  blockMenuTargetKey,
  blockMenuTargetRange,
  clearBlockMenuTarget,
  createBlockMenuTargetPlugin,
  hasBlockMenuTarget,
  setBlockMenuTarget,
} from './block-menu-decoration';

/**
 * #1179 — the block menu's target marker. These run against a real ProseMirror
 * document so the remapping behaviour is exercised for real rather than mocked.
 */

let editor: Editor | null = null;

function mount(content: string, { withPlugin = true } = {}): EditorType {
  editor = new Editor({ extensions: [StarterKit], content });
  if (withPlugin) editor.registerPlugin(createBlockMenuTargetPlugin());
  return editor as unknown as EditorType;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('block-menu target decoration', () => {
  it('starts with no target', () => {
    const e = mount('<p>First</p><p>Second</p>');
    expect(blockMenuTargetRange(e)).toBeNull();
    expect(hasBlockMenuTarget(e)).toBe(false);
  });

  it('reports no target when the plugin was never registered', () => {
    // Read-only editors never mount the drag handle, so nothing registers the
    // plugin — `selectionShouldShow` must not throw on those.
    const e = mount('<p>First</p>', { withPlugin: false });
    expect(blockMenuTargetRange(e)).toBeNull();
    expect(hasBlockMenuTarget(e)).toBe(false);
  });

  it('marks the whole block node, not just its text', () => {
    const e = mount('<p>First</p><p>Second</p>');
    const secondPos = e.state.doc.child(0).nodeSize; // start of the 2nd paragraph

    setBlockMenuTarget(e, secondPos);

    const range = blockMenuTargetRange(e);
    expect(range).toEqual({
      from: secondPos,
      to: secondPos + e.state.doc.child(1).nodeSize,
    });
    expect(hasBlockMenuTarget(e)).toBe(true);
  });

  it('decorates the node with the styling class', () => {
    const e = mount('<p>First</p>');
    setBlockMenuTarget(e, 0);
    const deco = blockMenuTargetKey.getState(e.state)!.find()[0]!;
    // `Decoration.node` stores its attrs on the spec's internal type; the class
    // is what index.css keys off, so assert it survived.
    expect(JSON.stringify(deco)).toContain(BLOCK_MENU_TARGET_CLASS);
  });

  it('remaps the range when text is inserted before the target', () => {
    const e = mount('<p>First</p><p>Second</p>');
    const secondPos = e.state.doc.child(0).nodeSize;
    setBlockMenuTarget(e, secondPos);

    e.commands.insertContentAt(1, 'XXX');

    const range = blockMenuTargetRange(e)!;
    expect(range.from).toBe(secondPos + 3);
    expect(e.state.doc.nodeAt(range.from)!.textContent).toBe('Second');
  });

  it('grows the range when the target block itself gains text', () => {
    const e = mount('<p>Only</p>');
    setBlockMenuTarget(e, 0);
    const before = blockMenuTargetRange(e)!;

    e.commands.insertContentAt(1, 'XX');

    const after = blockMenuTargetRange(e)!;
    expect(after.from).toBe(before.from);
    expect(after.to).toBe(before.to + 2);
  });

  it('drops the marker when the target block is deleted', () => {
    const e = mount('<p>First</p><p>Second</p>');
    const secondPos = e.state.doc.child(0).nodeSize;
    setBlockMenuTarget(e, secondPos);

    e.commands.deleteRange({ from: secondPos, to: e.state.doc.content.size });

    expect(blockMenuTargetRange(e)).toBeNull();
    expect(hasBlockMenuTarget(e)).toBe(false);
  });

  it('clears on request', () => {
    const e = mount('<p>First</p>');
    setBlockMenuTarget(e, 0);
    expect(hasBlockMenuTarget(e)).toBe(true);

    clearBlockMenuTarget(e);
    expect(hasBlockMenuTarget(e)).toBe(false);
  });

  it('replaces an existing marker rather than stacking a second one', () => {
    const e = mount('<p>First</p><p>Second</p>');
    const secondPos = e.state.doc.child(0).nodeSize;

    setBlockMenuTarget(e, 0);
    setBlockMenuTarget(e, secondPos);

    expect(blockMenuTargetKey.getState(e.state)!.find()).toHaveLength(1);
    expect(blockMenuTargetRange(e)!.from).toBe(secondPos);
  });

  it('ignores a position that holds no node', () => {
    const e = mount('<p>First</p>');
    setBlockMenuTarget(e, 999);
    expect(hasBlockMenuTarget(e)).toBe(false);
  });
});
