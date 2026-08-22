import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DRAG_HANDLE_INSET_PX, DRAG_HANDLE_GUTTER, isListItemName, dragHandleReferenceRect } from './drag-handle-anchor';

describe('drag-handle-anchor', () => {
  it('treats list items as the nodes that need the list-left remount', () => {
    expect(isListItemName('listItem')).toBe(true);
    expect(isListItemName('taskItem')).toBe(true);
    expect(isListItemName('paragraph')).toBe(false);
    expect(isListItemName('horizontalRule')).toBe(false);
  });

  it('returns null without a hovered block', () => {
    expect(dragHandleReferenceRect({ view: { nodeDOM: () => null } } as never, null)).toBeNull();
  });

  it('insets a paragraph left of its box', () => {
    const el = document.createElement('p');
    el.getBoundingClientRect = () => new DOMRect(40, 10, 160, 20);
    const editor = { view: { nodeDOM: () => el } };
    const rect = dragHandleReferenceRect(
      editor as never,
      { node: { type: { name: 'paragraph' } } as never, pos: 1 },
    );
    expect(rect).not.toBeNull();
    expect(rect!.getBoundingClientRect().left).toBe(40 - DRAG_HANDLE_INSET_PX);
  });

  it('uses the list left edge for a list item, then insets', () => {
    const list = document.createElement('ul');
    list.getBoundingClientRect = () => new DOMRect(24, 10, 176, 80);
    const el = document.createElement('li');
    el.getBoundingClientRect = () => new DOMRect(44, 30, 156, 20);
    list.appendChild(el);
    const editor = { view: { nodeDOM: () => el } };
    const rect = dragHandleReferenceRect(
      editor as never,
      { node: { type: { name: 'listItem' } } as never, pos: 4 },
    );
    expect(rect!.getBoundingClientRect().left).toBe(24 - DRAG_HANDLE_INSET_PX);
  });

  it('pulls the editable surface left so the grip stays inside .tiptap', () => {
    const css = readFileSync(resolve(__dirname, '../../../index.css'), 'utf-8');
    const start = css.indexOf(".tiptap[contenteditable='true']");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf('}', start));
    expect(block).toContain(`padding-left: ${DRAG_HANDLE_GUTTER}`);
    expect(block).toContain(`margin-left: -${DRAG_HANDLE_GUTTER}`);
  });
});
