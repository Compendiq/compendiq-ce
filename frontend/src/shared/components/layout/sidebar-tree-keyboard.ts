import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { TreeNode } from './sidebar-types';

export interface FlatTreeEntry {
  id: string;
  parentId: string | null;
  hasChildren: boolean;
}

/**
 * Depth-first list of the rows a tree actually renders, honoring collapsed
 * state. Arrow-key navigation moves through this list, not through `tree`
 * itself, since a collapsed node's children are not on screen to land on.
 */
export function flattenVisibleTree(
  tree: TreeNode[],
  expandedSet: Set<string>,
  parentId: string | null = null,
): FlatTreeEntry[] {
  const out: FlatTreeEntry[] = [];
  for (const node of tree) {
    const hasChildren = node.children.length > 0;
    out.push({ id: node.page.id, parentId, hasChildren });
    if (hasChildren && expandedSet.has(node.page.id)) {
      out.push(...flattenVisibleTree(node.children, expandedSet, node.page.id));
    }
  }
  return out;
}

interface UseTreeRovingFocusOptions {
  tree: TreeNode[];
  expandedSet: Set<string>;
  activePageId: string | undefined;
  toggleExpand: (id: string) => void;
  /** Scopes the post-navigation `.focus()` call to this tree's own rows. */
  containerRef: RefObject<HTMLElement | null>;
}

/**
 * ARIA APG roving-tabindex + arrow-key navigation for a `role="tree"` of
 * `role="treeitem"` rows (#880 follow-up, epic #856). Exactly one row is
 * ever tab-stoppable; Up/Down/Left/Right/Home/End move that row without
 * touching the rest of the page's tab order — collapsing what was ~1 tab
 * stop per visible page into 1 stop for the whole tree.
 */
export function useTreeRovingFocus({
  tree,
  expandedSet,
  activePageId,
  toggleExpand,
  containerRef,
}: UseTreeRovingFocusOptions) {
  const flat = useMemo(() => flattenVisibleTree(tree, expandedSet), [tree, expandedSet]);
  const [explicitRovingId, setExplicitRovingId] = useState<string | undefined>(undefined);
  const pendingFocusRef = useRef(false);

  // The tab-stoppable row: the user's last explicit choice if it is still
  // visible, else the open page, else the first row — never "nothing", or
  // Tab would skip the tree entirely.
  const rovingId = useMemo(() => {
    if (explicitRovingId && flat.some((e) => e.id === explicitRovingId)) return explicitRovingId;
    if (activePageId && flat.some((e) => e.id === activePageId)) return activePageId;
    return flat[0]?.id;
  }, [explicitRovingId, flat, activePageId]);

  // Arrow-key moves set `explicitRovingId` and mark a DOM focus() pending —
  // React re-renders the new row's tabIndex to 0 first, then this effect
  // moves real focus onto it. A click already carries native focus (routed
  // through onRowFocus below instead), so it never sets this flag.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    const container = containerRef.current;
    if (!container || !rovingId) return;
    const row = container.querySelector<HTMLElement>(`[data-page-id="${CSS.escape(rovingId)}"]`);
    row?.focus();
  }, [rovingId, containerRef]);

  const moveTo = useCallback((id: string | undefined) => {
    if (!id) return;
    pendingFocusRef.current = true;
    setExplicitRovingId(id);
  }, []);

  const handleRowFocus = useCallback((id: string) => {
    setExplicitRovingId(id);
  }, []);

  const handleRowKeyDown = useCallback((event: React.KeyboardEvent, id: string) => {
    const index = flat.findIndex((e) => e.id === id);
    if (index === -1) return;
    const entry = flat[index];
    if (!entry) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveTo(flat[index + 1]?.id);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveTo(flat[index - 1]?.id);
        break;
      case 'ArrowRight':
        if (entry.hasChildren) {
          event.preventDefault();
          if (!expandedSet.has(id)) {
            toggleExpand(id);
          } else {
            // Already expanded: APG moves into the first child, which is
            // exactly the next flattened entry.
            moveTo(flat[index + 1]?.id);
          }
        }
        break;
      case 'ArrowLeft':
        event.preventDefault();
        if (entry.hasChildren && expandedSet.has(id)) {
          toggleExpand(id);
        } else if (entry.parentId) {
          moveTo(entry.parentId);
        }
        break;
      case 'Home':
        event.preventDefault();
        moveTo(flat[0]?.id);
        break;
      case 'End':
        event.preventDefault();
        moveTo(flat[flat.length - 1]?.id);
        break;
      default:
        break;
    }
  }, [flat, expandedSet, toggleExpand, moveTo]);

  return { rovingId, handleRowFocus, handleRowKeyDown };
}
