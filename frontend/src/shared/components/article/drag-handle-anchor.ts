import type { Editor as EditorType } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';

/** Extra gutter so the grip sits left of the paragraph, not on the first glyph. */
export const DRAG_HANDLE_INSET_PX = 12;

export function isListItemName(name: string): boolean {
  return name === 'listItem' || name === 'taskItem';
}

/**
 * Anchor the drag handle to the list's left edge (same column as a sibling
 * paragraph) rather than the `<li>` content box, which starts after the marker.
 */
export function dragHandleReferenceRect(
  editor: EditorType,
  hovered: { node: PMNode; pos: number } | null,
): { getBoundingClientRect: () => DOMRect } | null {
  if (!hovered) return null;
  const el = editor.view.nodeDOM(hovered.pos);
  if (!(el instanceof HTMLElement)) return null;

  const itemRect = el.getBoundingClientRect();
  let left = itemRect.left;
  if (isListItemName(hovered.node.type.name)) {
    const list = el.closest('ul, ol');
    if (list) left = list.getBoundingClientRect().left;
  }
  left -= DRAG_HANDLE_INSET_PX;
  return {
    getBoundingClientRect: () =>
      new DOMRect(left, itemRect.top, Math.max(itemRect.right - left, 1), itemRect.height),
  };
}
