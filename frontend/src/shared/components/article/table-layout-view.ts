import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { TableView } from '@tiptap/extension-table';

/**
 * TipTap's TableView writes `table.style.width = <sum of colwidth>px` when
 * every column has a stored width. That is correct for a shrink-wrapped
 * table and wrong for `data-layout="full-width"`: the inline pixel width
 * wins in the editor (view mode re-stamps the attribute and `width: 100%
 * !important` covers it). Switching to Edit then shrinks the table to its
 * column sum.
 *
 * The node view also never copies `data-layout` onto the wrapper / table it
 * builds. Apply both here so edit and read share one source of truth.
 */
export class CompendiqTableView extends TableView {
  constructor(node: ProseMirrorNode, cellMinWidth: number) {
    super(node, cellMinWidth);
    applyTableLayout(node, this.dom, this.table);
  }

  update(node: ProseMirrorNode) {
    if (!super.update(node)) return false;
    applyTableLayout(node, this.dom, this.table);
    return true;
  }
}

export function applyTableLayout(
  node: ProseMirrorNode,
  wrapper: HTMLElement,
  table: HTMLTableElement,
) {
  if (node.attrs['data-layout'] === 'full-width') {
    table.setAttribute('data-layout', 'full-width');
    wrapper.setAttribute('data-layout', 'full-width');
    table.style.width = '100%';
    table.style.maxWidth = '100%';
    table.style.minWidth = '';
  } else {
    table.removeAttribute('data-layout');
    wrapper.removeAttribute('data-layout');
  }
}
