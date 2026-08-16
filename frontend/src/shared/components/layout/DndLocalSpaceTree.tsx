import { memo, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  ChevronDown,
  GripVertical,
} from 'lucide-react';
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react';
import { useSortable, isSortable } from '@dnd-kit/react/sortable';
import { cn } from '../../lib/cn';
import type { TreeNode } from './sidebar-types';

export interface DndLocalSpaceTreeProps {
  tree: TreeNode[];
  expandedIds: Set<string>;
  toggleExpand: (id: string) => void;
  activePageId: string | undefined;
  // #960: passed down from the parent so rows don't subscribe to location.
  isAiRoute: boolean;
  reorderPage: { mutate: (args: { id: string; sortOrder: number }) => void };
  // Roving-tabindex, computed once by SidebarTreeView (#880 follow-up, epic
  // #856) and threaded through here since the two trees share one focus
  // target and are mutually exclusive in the same rail.
  rovingId: string | undefined;
  onRowFocus: (id: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent, id: string) => void;
}

interface DndSortableTreeNodeProps {
  node: TreeNode;
  level?: number;
  expandedSet: Set<string>;
  toggleExpand: (id: string) => void;
  activePageId: string | undefined;
  isAiRoute: boolean;
  sortableIndex: number;
  rovingId: string | undefined;
  onRowFocus: (id: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent, id: string) => void;
}

const DndSortableTreeNode = memo(function DndSortableTreeNode({
  node,
  level = 0,
  expandedSet,
  toggleExpand,
  activePageId,
  isAiRoute,
  sortableIndex,
  rovingId,
  onRowFocus,
  onRowKeyDown,
}: DndSortableTreeNodeProps) {
  const navigate = useNavigate();
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const isActive = node.page.id === activePageId;

  // Without an explicit `handle`, dnd-kit's built-in accessibility plugin
  // (@dnd-kit/dom's Accessibility) makes the DRAGGABLE ELEMENT ITSELF the
  // keyboard activator — here, the whole row, via `sortable.ref` below. That
  // silently overwrote the row's own role="treeitem"/roving-tabindex wiring
  // with role="button" tabindex="0" on every rendered row (confirmed against
  // the installed @dnd-kit/dom source: `draggable.handle ?? draggable.element`
  // is the activator it instruments), so Tab landed on an unlabelled drag
  // wrapper instead of a page link, Enter and the arrow keys did nothing, and
  // a 13-page tree cost 21 tab stops instead of the roving tree's 1. Scoping
  // `handle` to the grip moves that instrumentation onto a dedicated control
  // instead of the row — which is also what finally wires up real keyboard
  // reordering (Space to pick up, arrows to move), since KeyboardSensor is
  // already in this app's default sensor set; it just had nowhere correct to
  // attach.
  const handleRef = useRef<HTMLSpanElement>(null);
  const sortable = useSortable({
    id: node.page.id,
    index: sortableIndex,
    disabled: false,
    handle: handleRef,
  });

  // A parent row does two jobs — open the page, and (via its own chevron,
  // indent guide, and ArrowRight/Left) expand its children — and used to
  // conflate them: clicking the title toggled expansion unconditionally
  // before navigating, so opening an already-expanded section closed the very
  // children you clicked through to reach, non-idempotently (the same click
  // expanded or collapsed depending on what was already open). Now the click
  // only ever opens a collapsed parent; an already-open one just navigates,
  // matching the other three expand/collapse paths and SidebarTreeNode's twin.
  const handleNavigate = useCallback(() => {
    if (hasChildren && !isExpanded) toggleExpand(node.page.id);
    if (isAiRoute) {
      navigate(`/ai?pageId=${node.page.id}`, { replace: true });
    } else {
      navigate(`/pages/${node.page.id}`);
    }
  }, [navigate, node.page.id, hasChildren, isExpanded, toggleExpand, isAiRoute]);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleExpand(node.page.id);
    },
    [toggleExpand, node.page.id],
  );

  return (
    <div ref={sortable.ref}>
      <div
        // #707: mark the active row so the scroll container can find it and
        // scroll it into view on reload (its ancestors are auto-expanded first).
        data-active={isActive ? 'true' : undefined}
        data-page-id={node.page.id}
        // #880: make the row a real keyboard-operable widget. role="treeitem"
        // (not "button") because the chevron is a nested <button> — a button
        // role here would nest interactive controls. Enter/Space navigate.
        role="treeitem"
        tabIndex={rovingId === node.page.id ? 0 : -1}
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isActive}
        className={cn(
          // Must stay in step with SidebarTreeView's row: the two trees render
          // in the same rail — the same panel, swapped by space source — so any
          // difference reads as a rendering bug rather than a distinction.
          //
          // It had drifted on the one state that matters most. The active row
          // here was `nm-pill-active text-action font-medium scale-[1.01]`
          // against the plain tree's `nav-selection font-medium`: a different
          // field, teal text where the other has none, and a `scale` — which
          // ADR-010 retired outright ("no lift, no scale, no glass"; hover and
          // press are background and border changes). Selecting a page in a
          // local space nudged the row 1% larger and lit it teal; selecting one
          // in a Confluence space did neither. Same panel, same gesture.
          'group relative flex items-center rounded-md h-7 pr-2 text-[13px] cursor-pointer transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          isActive
            ? 'nav-selection font-medium'
            : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
        )}
        // See SidebarTreeNode for why the gutter is built this way. This tree
        // carries one control the other does not — the drag grip — so its
        // gutter is 44px rather than 28, hosting grip then chevron, and it
        // still returns ~24px per row against the old layout by dropping the
        // leaf placeholder and the uniform FileText.
        style={{ paddingLeft: `${level * 12 + 44}px` }}
        title={node.page.title}
        onClick={handleNavigate}
        onFocus={() => onRowFocus(node.page.id)}
        onKeyDown={(e) => {
          // Ignore keydown bubbling up from the nested chevron button so the
          // row doesn't double-activate when the chevron is focused.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); // Space would otherwise scroll the page
            handleNavigate();
            return;
          }
          onRowKeyDown(e, node.page.id);
        }}
      >
        {/* Grip and chevron both hang in the indent gutter, out of flow, so the
            title's width pays for neither. The grip stays hover-revealed at
            rest but is no longer charged 18px of every row for the privilege —
            it was `opacity-0` and still occupying layout width on all of them.

            The CHEVRON, not the grip, takes the leftmost slot, matching
            SidebarTreeNode exactly. Drag handles conventionally sit outermost,
            but these two trees swap into the same rail when you change space,
            and the chevron is the control that persists on every row while the
            grip appears only on hover/focus. Aligning the persistent one means
            the tree does not shift sideways when the space source changes, and
            it lets both trees share one indent-guide formula.

            This is now a real, keyboard-operable control — `handle: handleRef`
            above scopes dnd-kit's activator instrumentation here instead of to
            the whole row, so the library adds role="button", tabindex="0" (it
            is a <span>, not natively focusable), aria-roledescription, and
            aria-pressed/aria-grabbed on this element at runtime. It therefore
            needs a real accessible name (dnd-kit supplies a description via
            aria-describedby, not a name) and a visible focus treatment, since
            it can no longer be aria-hidden — an aria-hidden element must never
            be keyboard-focusable. `focus-visible:opacity-100` is what makes a
            Tab stop that lands here actually visible; without it a keyboard
            user would focus an element with no visual indication of where
            focus is, since it is invisible until hover or focus. */}
        <span
          ref={handleRef}
          className="absolute top-[2px] flex h-6 w-[18px] items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity cursor-grab active:cursor-grabbing group-hover:opacity-60 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          style={{ left: `${level * 12 + 26}px` }}
          aria-label={`Reorder ${node.page.title}`}
        >
          <GripVertical size={12} />
        </span>
        {hasChildren && (
          <button
            onClick={handleToggle}
            // z-10: see the twin in SidebarTreeNode — the guide's click target
            // and a child chevron share ~6px of column at a 12px indent.
            className="absolute top-[2px] z-10 flex size-6 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground"
            style={{ left: `${level * 12 + 2}px` }}
            // Mouse-only, out of the tab order and the a11y tree — see the twin
            // in SidebarTreeNode for why (it was defeating the roving tabindex
            // and announcing a bare "Expand" with no object).
            tabIndex={-1}
            aria-hidden="true"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        {/* #767: pin the weight explicitly (conditional, never both classes)
            so titles can't inherit or synthesize a heavier weight while the
            variable font loads or the row sits on a composited layer. */}
        <span className={cn('truncate text-[13px]', isActive ? 'font-medium' : 'font-normal')}>
          {node.page.title}
        </span>
      </div>

      {hasChildren && isExpanded && (
        // #880: role="group" gives the nested treeitem rows a valid ARIA
        // required-parent (a treeitem must be owned by a tree or group).
        <div className="relative" role="group">
          {/* Indent guide line -- click to collapse parent */}
          <button
            type="button"
            onClick={handleToggle}
            className="indent-guide"
            style={{ left: `${level * 12 + 8}px` }}
            aria-label={`Collapse ${node.page.title}`}
            aria-hidden="true"
            tabIndex={-1}
          />
          {node.children.map((child, idx) => (
            <DndSortableTreeNode
              key={child.page.id}
              node={child}
              level={level + 1}
              expandedSet={expandedSet}
              toggleExpand={toggleExpand}
              activePageId={activePageId}
              isAiRoute={isAiRoute}
              sortableIndex={idx}
              rovingId={rovingId}
              onRowFocus={onRowFocus}
              onRowKeyDown={onRowKeyDown}
            />
          ))}
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  return (
    prev.node === next.node &&
    prev.level === next.level &&
    prev.activePageId === next.activePageId &&
    prev.expandedSet === next.expandedSet &&
    prev.isAiRoute === next.isAiRoute &&
    prev.sortableIndex === next.sortableIndex &&
    prev.rovingId === next.rovingId &&
    prev.onRowFocus === next.onRowFocus &&
    prev.onRowKeyDown === next.onRowKeyDown
  );
});

export default function DndLocalSpaceTree({
  tree,
  expandedIds,
  toggleExpand,
  activePageId,
  isAiRoute,
  reorderPage,
  rovingId,
  onRowFocus,
  onRowKeyDown,
}: DndLocalSpaceTreeProps) {
  const handleDragEnd = useCallback(
    (event: Parameters<DragEndEvent>[0]) => {
      if (event.canceled) return;
      const source = event.operation?.source;
      if (!source || !isSortable(source)) return;

      const currentIndex = source.index;
      const startIndex = 'initialIndex' in source ? (source as { initialIndex: number }).initialIndex : currentIndex;
      if (startIndex === currentIndex) return;

      const pageId = String(source.id);
      reorderPage.mutate({ id: pageId, sortOrder: currentIndex });
    },
    [reorderPage],
  );

  return (
    <DragDropProvider onDragEnd={handleDragEnd}>
      {/* #880: role="tree" + label give the role="treeitem" rows a valid
          required-parent context and expose real tree semantics to screen
          readers. Roving-tabindex + arrow-key nav (rovingId/onRowFocus/
          onRowKeyDown, computed once by SidebarTreeView) closes out the
          epic #856 follow-up this comment used to defer. Keyboard *reorder*
          (moving a page via the keyboard, not just navigating to it) now
          works too, via each row's grip handle — see the `handle: handleRef`
          note in DndSortableTreeNode for why that was the actual blocker on
          BOTH keyboard navigation and keyboard reorder at once. */}
      <div className="space-y-0.5" role="tree" aria-label="Pages">
        {tree.map((node, idx) => (
          <DndSortableTreeNode
            key={node.page.id}
            node={node}
            expandedSet={expandedIds}
            toggleExpand={toggleExpand}
            activePageId={activePageId}
            isAiRoute={isAiRoute}
            sortableIndex={idx}
            rovingId={rovingId}
            onRowFocus={onRowFocus}
            onRowKeyDown={onRowKeyDown}
          />
        ))}
      </div>
    </DragDropProvider>
  );
}
