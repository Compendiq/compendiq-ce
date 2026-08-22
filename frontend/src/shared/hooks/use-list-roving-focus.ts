import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';

interface UseListRovingFocusOptions {
  /** The visible rows, in render order — across every group, after filtering. */
  ids: readonly string[];
  /** The row the route currently shows, if it is in `ids`. */
  activeId: string | null;
  /** Scopes both the post-navigation `.focus()` and the replay guard to this list. */
  containerRef: RefObject<HTMLElement | null>;
  /** The attribute the rows carry their id in — `data-row-id` for the pane. */
  itemAttr: string;
}

/**
 * ARIA APG roving tabindex for a FLAT vertical list (#1361 PR 2), the
 * conversations pane's counterpart to `useTreeRovingFocus`.
 *
 * The list is one tab stop: Up/Down/Home/End move it, Tab leaves the list
 * entirely, so a fifty-row history costs a keyboard user one stop rather than
 * fifty. It is a separate hook rather than a widened tree hook because the tree
 * one is over-fit — expand/collapse, `parentId`, a hardcoded `data-page-id` —
 * and none of that has a meaning here.
 *
 * Two details are load-bearing:
 *
 * 1. **The `contains` guard.** Each row hosts a Radix `DropdownMenu`, and
 *    portalled Radix content is a React child of the row even though it is not
 *    a DOM descendant of the list. React replays events up the *React* tree, so
 *    an ArrowDown pressed inside an open row menu arrives here. Without the
 *    guard it would move the list's tab stop out from under an open menu.
 *    `container.contains(event.target)` is false for portalled content, which
 *    is exactly the discrimination needed (`useToolbarRovingFocus` guards the
 *    editor toolbar the same way, for the same reason).
 *
 * 2. **Horizontal arrows are not claimed.** `ArrowRight` moves focus to the
 *    row's kebab and `ArrowLeft` brings it back; both belong to the row, which
 *    handles them before delegating everything else here.
 *
 * Arrows CLAMP rather than wrap, matching `useTreeRovingFocus` — the two rails
 * must not disagree about what ArrowDown at the bottom does.
 */
export function useListRovingFocus({
  ids,
  activeId,
  containerRef,
  itemAttr,
}: UseListRovingFocusOptions): {
  rovingId: string | undefined;
  handleRowFocus: (id: string) => void;
  handleRowKeyDown: (event: React.KeyboardEvent, id: string) => void;
} {
  const [explicitRovingId, setExplicitRovingId] = useState<string | undefined>(undefined);
  const pendingFocusRef = useRef(false);

  // The tab-stoppable row: the user's last explicit choice if it survived the
  // last list change, else the open conversation, else the first row — never
  // "nothing" while there are rows, or Tab would skip the list entirely.
  const rovingId = useMemo(() => {
    if (explicitRovingId && ids.includes(explicitRovingId)) return explicitRovingId;
    if (activeId && ids.includes(activeId)) return activeId;
    return ids[0];
  }, [explicitRovingId, ids, activeId]);

  // Arrow moves set `explicitRovingId` and mark a DOM focus() pending — React
  // re-renders the new row's tabIndex to 0 first, then this effect moves real
  // focus onto it. A click already carries native focus (routed through
  // `handleRowFocus`), so it never sets the flag.
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    const container = containerRef.current;
    if (!container || !rovingId) return;
    const row = container.querySelector<HTMLElement>(`[${itemAttr}="${CSS.escape(rovingId)}"]`);
    row?.focus();
  }, [rovingId, containerRef, itemAttr]);

  const moveTo = useCallback((id: string | undefined) => {
    if (!id) return;
    pendingFocusRef.current = true;
    setExplicitRovingId(id);
  }, []);

  const handleRowFocus = useCallback((id: string) => {
    setExplicitRovingId(id);
  }, []);

  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent, id: string) => {
      const container = containerRef.current;
      if (!container || !container.contains(event.target as Node)) return;

      const index = ids.indexOf(id);
      if (index === -1) return;

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          moveTo(ids[index + 1]);
          break;
        case 'ArrowUp':
          event.preventDefault();
          moveTo(ids[index - 1]);
          break;
        case 'Home':
          event.preventDefault();
          moveTo(ids[0]);
          break;
        case 'End':
          event.preventDefault();
          moveTo(ids[ids.length - 1]);
          break;
        default:
          break;
      }
    },
    [ids, containerRef, moveTo],
  );

  return { rovingId, handleRowFocus, handleRowKeyDown };
}
