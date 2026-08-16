import { memo, useState, useMemo, useCallback, useEffect, useLayoutEffect, useRef, lazy, Suspense } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  FilePlus,
  ChevronsUpDown,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Globe,
  Pin,
  Settings,
} from 'lucide-react';
import { getSpaceIcon } from '../spaces/space-icons';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { MainNavStripExpanded, MainNavStripCollapsed } from './MainNavStrip';
import { usePageTree, useCreatePage, usePinnedPages } from '../../hooks/use-pages';
import { useSpaces } from '../../hooks/use-spaces';
import { useLocalSpaces, useReorderPage } from '../../hooks/use-standalone';
import { useClickOutside } from '../../hooks/use-click-outside';
import { useUiStore } from '../../../stores/ui-store';
import { cn } from '../../lib/cn';
import type { PageTreeItem } from '../../hooks/use-pages';
import type { TreeNode } from './sidebar-types';
import { useTreeRovingFocus } from './sidebar-tree-keyboard';

export type { TreeNode };

const DndLocalSpaceTree = lazy(() => import('./DndLocalSpaceTree'));

function buildTree(pages: PageTreeItem[], homepageId?: string | null): TreeNode[] {
  const nodeMap = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  pages.forEach((page) => {
    nodeMap.set(page.id, { page, children: [] });
  });

  pages.forEach((page) => {
    const node = nodeMap.get(page.id)!;
    if (page.parentId && nodeMap.has(page.parentId)) {
      nodeMap.get(page.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });

  // #959: order siblings by the persisted sortOrder first (set by drag-reorder
  // via PUT /pages/:id/reorder), falling back to title. Without this the tree
  // always re-sorted alphabetically, so a drop snapped straight back.
  const bySortOrderThenTitle = (a: TreeNode, b: TreeNode) =>
    a.page.sortOrder - b.page.sortOrder || a.page.title.localeCompare(b.page.title);

  function sortChildren(nodes: TreeNode[]) {
    nodes.sort(bySortOrderThenTitle);
    nodes.forEach((n) => sortChildren(n.children));
  }
  sortChildren(roots);

  // #352: when a homepage is configured for the space, hide it from the
  // sidebar tree — it's reachable via the dedicated "Home" link at the top
  // of the space view, so showing it again in the tree wastes a slot. Its
  // children are promoted to top-level roots so the rest of the tree
  // remains navigable.
  if (homepageId) {
    const homepageNode = nodeMap.get(homepageId);
    if (homepageNode) {
      const promoted = homepageNode.children;
      const withoutHomepage = roots.filter((r) => r.page.id !== homepageId);
      const withoutHome = [...promoted, ...withoutHomepage];
      // #961: hiding the homepage must not leave the sidebar empty. When the
      // space contains only its homepage (no children, no sibling roots),
      // keep the homepage visible so the tree doesn't render a false
      // "empty space" state above a "1 page in <SPACE>" footer.
      if (withoutHome.length > 0) {
        return withoutHome.sort(bySortOrderThenTitle);
      }
    }
  }

  return roots;
}

/** Find ancestor IDs for a given page ID so we can auto-expand the path */
function findAncestorIds(pages: PageTreeItem[], targetId: string): Set<string> {
  const parentMap = new Map<string, string>();
  pages.forEach((p) => {
    if (p.parentId) parentMap.set(p.id, p.parentId);
  });
  const ancestors = new Set<string>();
  let current = targetId;
  while (parentMap.has(current)) {
    const parent = parentMap.get(current)!;
    ancestors.add(parent);
    current = parent;
  }
  return ancestors;
}

const sidebarSpring = { type: 'spring' as const, stiffness: 400, damping: 30 };

export interface SidebarTreeNodeProps {
  node: TreeNode;
  level?: number;
  expandedSet: Set<string>;
  toggleExpand: (id: string) => void;
  activePageId: string | undefined;
  // #960: derived once by the parent from location.pathname and passed down as
  // a stable prop. Rows must NOT call useLocation() themselves — that subscribed
  // every memoized row to every location/searchParams change, defeating the memo
  // comparator and re-rendering the whole tree on each navigation.
  isAiRoute: boolean;
  // Roving-tabindex (#880 follow-up, epic #856): exactly one row is ever
  // tab-stoppable — the one whose id matches `rovingId`. onRowFocus keeps it
  // in sync with clicks/Tab; onRowKeyDown drives Up/Down/Left/Right/Home/End.
  rovingId: string | undefined;
  onRowFocus: (id: string) => void;
  onRowKeyDown: (event: React.KeyboardEvent, id: string) => void;
}

export const SidebarTreeNode = memo(function SidebarTreeNode({
  node,
  level = 0,
  expandedSet,
  toggleExpand,
  activePageId,
  isAiRoute,
  rovingId,
  onRowFocus,
  onRowKeyDown,
}: SidebarTreeNodeProps) {
  const navigate = useNavigate();
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const isActive = node.page.id === activePageId;

  const handleNavigate = useCallback(() => {
    if (hasChildren) toggleExpand(node.page.id);
    if (isAiRoute) {
      navigate(`/ai?pageId=${node.page.id}`, { replace: true });
    } else {
      navigate(`/pages/${node.page.id}`);
    }
  }, [navigate, node.page.id, hasChildren, toggleExpand, isAiRoute]);

  const handleToggle = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleExpand(node.page.id);
    },
    [toggleExpand, node.page.id],
  );

  return (
    <div>
      <div
        // #707: mark the active row so the scroll container can find it and
        // scroll it into view on reload (its ancestors are auto-expanded first).
        data-active={isActive ? 'true' : undefined}
        data-page-id={node.page.id}
        // #880/#856: make the row a real keyboard-operable widget. role="treeitem"
        // (not "button") because the chevron is a nested <button> — a button
        // role here would nest interactive controls. Enter/Space navigate.
        // tabIndex follows roving-tabindex: only the current row is a tab
        // stop, so reaching a page no longer costs one Tab press per row.
        role="treeitem"
        tabIndex={rovingId === node.page.id ? 0 : -1}
        aria-expanded={hasChildren ? isExpanded : undefined}
        className={cn(
          // 28px rows at 13px. The tree is the tallest thing on screen, so its
          // row height sets how much of the corpus is reachable without
          // scrolling — 36px rows cost roughly two pages per viewport.
          //
          // `relative` is load-bearing, not tidying: the chevron is positioned
          // against this row (see below), and without it the chevron would
          // resolve against the scroll container and land at the panel's edge.
          'group relative flex items-center rounded-md h-7 pr-2 text-[13px] cursor-pointer transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          isActive
            ? 'nav-selection font-medium'
            : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
        )}
        // The horizontal budget is this panel's scarcest resource, and it used
        // to be spent three ways that bought nothing. (1) A `w-[20px]`
        // placeholder held the chevron's column on every LEAF row, so pages
        // with no children paid for a control they never show; the chevron is
        // out of flow now, hanging in the indent gutter, which keeps sibling
        // titles aligned without charging leaves for it. (2) A `FileText` glyph
        // rendered on 100% of rows — identical on parents and leaves alike, so
        // it discriminated nothing while costing 21px including its gap. (3)
        // The indent step was 16px when 12 reads just as clearly at this row
        // height. Together those return ~35px per level-1 row (158 -> 216 at
        // the new 280px default), which is the difference between reading a
        // title and reading its first 26 characters.
        style={{ paddingLeft: `${level * 12 + 28}px` }}
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
        {hasChildren && (
          // Absolutely positioned in the indent gutter rather than laid out in
          // the row. Two things fall out of that. Titles stay aligned across a
          // sibling group whether or not each page has children — dropping the
          // placeholder from the flow instead would leave leaves' text 26px to
          // the left of their siblings', a ragged edge inside every group. And
          // the hit area is free: 24x24 clears WCAG 2.5.8 (the old 18x18 button
          // did not) while costing the title nothing, because out-of-flow width
          // is not width the text competes for.
          <button
            onClick={handleToggle}
            // z-10 beats `.indent-guide`'s z-index: 1. The guide is a 12px-wide
            // click target and the indent step is 12px, so a parent's guide and
            // its children's chevrons now share ~6px of column. Without this the
            // guide would sit on top and clicking a child's left edge would
            // collapse its parent instead of toggling the child.
            className="absolute top-[2px] z-10 flex size-6 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ left: `${level * 12 + 2}px` }}
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
          {/* Tracks the parent chevron's centre. The chevron sits at
              `level*12 + 2` and is 24 wide, so its axis is `level*12 + 14`;
              `.indent-guide` is a 12px click target with its 1px line centred,
              so the target's left edge is that axis minus 6. */}
          <button
            type="button"
            onClick={handleToggle}
            className="indent-guide"
            style={{ left: `${level * 12 + 8}px` }}
            aria-label={`Collapse ${node.page.title}`}
            tabIndex={-1}
          />
          {node.children.map((child) => (
            <SidebarTreeNode
              key={child.page.id}
              node={child}
              level={level + 1}
              expandedSet={expandedSet}
              toggleExpand={toggleExpand}
              activePageId={activePageId}
              isAiRoute={isAiRoute}
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
    prev.rovingId === next.rovingId &&
    prev.onRowFocus === next.onRowFocus &&
    prev.onRowKeyDown === next.onRowKeyDown
  );
});

interface SpaceOption {
  key: string;
  name: string;
  pageCount: number;
  source: 'confluence' | 'local';
  homepageId?: string | null;
  /** Local spaces only: the icon chosen at creation (see space-icons.ts). */
  icon?: string | null;
}

interface SidebarTreeViewProps {
  onNavigate?: () => void;
  /** Ephemeral shell pressure: compact the rail without overwriting the saved preference. */
  forceCollapsed?: boolean;
  /** Lets a user explicitly reopen a temporarily compacted rail. */
  onForceExpand?: () => void;
}

export function SidebarTreeView({
  onNavigate,
  forceCollapsed = false,
  onForceExpand,
}: SidebarTreeViewProps = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const treeSidebarCollapsed = useUiStore((s) => s.treeSidebarCollapsed);
  const toggleTreeSidebar = useUiStore((s) => s.toggleTreeSidebar);
  const treeSidebarSpaceKey = useUiStore((s) => s.treeSidebarSpaceKey);
  const setTreeSidebarSpaceKey = useUiStore((s) => s.setTreeSidebarSpaceKey);
  const treeSidebarWidth = useUiStore((s) => s.treeSidebarWidth);
  const setTreeSidebarWidth = useUiStore((s) => s.setTreeSidebarWidth);
  const reduceEffects = useReducedMotion();

  // Extract active page ID from pathname (useParams is unavailable here
  // because this component is rendered in AppLayout, outside the inner
  // <Routes> that defines /pages/:id).
  // On the AI route, also highlight the article selected via ?pageId query param.
  const activePageId = useMemo(() => {
    const match = location.pathname.match(/^\/pages\/([^/]+)$/);
    if (match) return match[1];
    if (location.pathname === '/ai') {
      const params = new URLSearchParams(location.search);
      return params.get('pageId') ?? undefined;
    }
    return undefined;
  }, [location.pathname, location.search]);

  const { data: confluenceSpaces } = useSpaces();
  const { data: localSpacesData } = useLocalSpaces();
  const { data: pinnedData } = usePinnedPages();
  const { data: treeData, isLoading } = usePageTree({
    spaceKey: treeSidebarSpaceKey,
  });
  const reorderPage = useReorderPage();

  // Merge confluence + local spaces for the selector
  const allSpaces = useMemo<SpaceOption[]>(() => {
    const result: SpaceOption[] = [];
    if (confluenceSpaces) {
      confluenceSpaces.filter((s) => s.source === 'confluence').forEach((s) => result.push({
        key: s.key,
        name: s.name,
        pageCount: s.pageCount,
        source: s.source ?? 'confluence',
        homepageId: s.homepageId,
      }));
    }
    // Local spaces API returns an array directly
    const localArr = Array.isArray(localSpacesData) ? localSpacesData : [];
    localArr.forEach((s) => result.push({
      key: s.key,
      name: s.name,
      pageCount: s.pageCount,
      source: 'local',
      icon: s.icon,
    }));
    return result;
  }, [confluenceSpaces, localSpacesData]);

  const pages = useMemo(() => treeData?.items ?? [], [treeData]);
  const selectedSpaceOption = useMemo(
    () => treeSidebarSpaceKey ? allSpaces.find((s) => s.key === treeSidebarSpaceKey) : undefined,
    [treeSidebarSpaceKey, allSpaces],
  );
  const homepageId = selectedSpaceOption?.homepageId;
  const tree = useMemo(() => buildTree(pages, homepageId), [pages, homepageId]);
  const isLocalSpace = selectedSpaceOption?.source === 'local';
  // #960: derive the /ai signal once here and thread it into every row as a
  // stable prop so the rows themselves don't subscribe to location.
  const isAiRoute = location.pathname === '/ai';

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [spaceDropdownOpen, setSpaceDropdownOpen] = useState(false);
  const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [newPageTitle, setNewPageTitle] = useState('');
  const [showNewPageInput, setShowNewPageInput] = useState(false);
  const newPageTitleRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const treeScrollRef = useRef<HTMLDivElement>(null);
  // Snapshot the tree's scroll position the instant a node is pressed — before
  // the browser's focus-into-view runs on the freshly-focused chevron — so a
  // user expand/collapse keeps the list where it is instead of being yanked to
  // the active row. pendingScrollRestore marks that the next expandedIds change
  // came from such a press, so the #707 scroll-into-view below leaves it alone.
  const scrollTopBeforeToggle = useRef<number | null>(null);
  const pendingScrollRestore = useRef(false);

  const snapshotTreeScroll = useCallback(() => {
    if (treeScrollRef.current) scrollTopBeforeToggle.current = treeScrollRef.current.scrollTop;
  }, []);

  const closeSpaceDropdown = useCallback(() => setSpaceDropdownOpen(false), []);
  const spaceDropdownRef = useClickOutside<HTMLDivElement>(closeSpaceDropdown, spaceDropdownOpen);
  const createPage = useCreatePage();

  const handleCreatePage = useCallback(async () => {
    const trimmed = newPageTitle.trim();
    if (!trimmed) return;

    const spaceKey = treeSidebarSpaceKey || '__local__';
    try {
      await createPage.mutateAsync({
        spaceKey,
        title: trimmed,
        bodyHtml: '',
        pageType: 'page',
      });
      setNewPageTitle('');
      setShowNewPageInput(false);
    } catch {
      // error handled by mutation
    }
  }, [newPageTitle, treeSidebarSpaceKey, createPage]);

  useEffect(() => {
    if (showNewPageInput) {
      newPageTitleRef.current?.focus();
    }
  }, [showNewPageInput]);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = treeSidebarWidth;

      function onMouseMove(ev: MouseEvent) {
        const newWidth = startWidth + (ev.clientX - startX);
        setTreeSidebarWidth(newWidth);
      }

      function onMouseUp() {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [treeSidebarWidth, setTreeSidebarWidth],
  );

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setTreeSidebarWidth(treeSidebarWidth - 16);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setTreeSidebarWidth(treeSidebarWidth + 16);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setTreeSidebarWidth(280);
      }
    },
    [treeSidebarWidth, setTreeSidebarWidth],
  );

  // Auto-expand path to the currently viewed page
  useEffect(() => {
    if (activePageId && pages.length > 0) {
      const ancestors = findAncestorIds(pages, activePageId);
      if (ancestors.size > 0) {
        setExpandedIds((prev) => {
          const next = new Set(prev);
          ancestors.forEach((id) => next.add(id));
          return next;
        });
      }
    }
  }, [activePageId, pages]);

  // Auto-select space based on current page
  useEffect(() => {
    if (activePageId && pages.length > 0 && !treeSidebarSpaceKey) {
      const currentPage = pages.find((p) => p.id === activePageId);
      if (currentPage) {
        setTreeSidebarSpaceKey(currentPage.spaceKey);
      }
    }
  }, [activePageId, pages, treeSidebarSpaceKey, setTreeSidebarSpaceKey]);

  // #707: keep the open page in view. On reload the tree mounts at the top
  // with the active node's ancestors freshly auto-expanded, so the active row
  // exists but is scrolled out of view. Re-key on expandedIds + pages so this
  // runs *after* the auto-expand effect renders the node and after tree data
  // loads. We only scroll when the row is genuinely outside the container
  // viewport, leaving mid-session scrolling and navigation to an already-visible
  // page untouched.
  //
  // Exception: when the user expands/collapses a node themselves
  // (pendingScrollRestore), do NOT scroll to the active row — that would yank
  // the list to the current article on every chevron click. Instead restore the
  // pre-press scroll position, also undoing the browser's focus-into-view jump.
  useLayoutEffect(() => {
    const container = treeScrollRef.current;
    if (!container) return;

    if (pendingScrollRestore.current) {
      pendingScrollRestore.current = false;
      if (scrollTopBeforeToggle.current != null) {
        container.scrollTop = scrollTopBeforeToggle.current;
      }
      return;
    }

    if (!activePageId) return;

    function scrollActiveIntoView(scroller: HTMLElement): boolean {
      const active = scroller.querySelector<HTMLElement>('[data-active="true"]');
      if (!active) return false;

      const containerRect = scroller.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const isVisible =
        activeRect.top >= containerRect.top && activeRect.bottom <= containerRect.bottom;
      if (!isVisible) {
        active.scrollIntoView({ block: 'center', behavior: reduceEffects ? 'auto' : 'smooth' });
      }
      return true;
    }

    if (scrollActiveIntoView(container)) return;

    // Active row not yet in the DOM — the local-space tree is lazy-loaded and
    // its Suspense boundary commits after this effect first runs. Watch the
    // container for the row to appear, scroll once, then disconnect. The
    // off-screen guard inside scrollActiveIntoView still prevents yanking a
    // row that's already visible, so this never fights manual scrolling.
    const observer = new MutationObserver(() => {
      if (scrollActiveIntoView(container)) observer.disconnect();
    });
    observer.observe(container, { childList: true, subtree: true });
    return () => observer.disconnect();
    // expandedIds is intentionally a dependency: it re-runs this effect so the
    // active node re-centers once its ancestor path expands, while the
    // off-screen visibility guard above keeps manual scrolling from being yanked.
  }, [activePageId, expandedIds, pages, reduceEffects]);

  const toggleExpand = useCallback((id: string) => {
    pendingScrollRestore.current = true;
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Shared by both tree implementations below (plain + drag-reorder) — they
  // render into the same `treeScrollRef` container and are mutually
  // exclusive, so one hook instance covers whichever is mounted.
  const { rovingId, handleRowFocus, handleRowKeyDown } = useTreeRovingFocus({
    tree,
    expandedSet: expandedIds,
    activePageId,
    toggleExpand,
    containerRef: treeScrollRef,
  });

  // Collapsed rail -- nav icons + expand toggle
  const collapsed = treeSidebarCollapsed || forceCollapsed;

  if (collapsed) {
    return (
      <AnimatePresence mode="wait">
        <m.div
          key="collapsed-rail"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: 40, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects ? { duration: 0 } : sidebarSpring}
          className="app-sidebar flex flex-col items-center border-r overflow-hidden"
        >
          {/* Expand toggle */}
          <button
            onClick={() => {
              if (forceCollapsed && !treeSidebarCollapsed) {
                onForceExpand?.();
              } else {
                toggleTreeSidebar();
              }
            }}
            className="mt-2 flex items-center rounded-lg p-1.5 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors"
            aria-label="Expand sidebar"
            title="Expand sidebar (,)"
          >
            {/* Shortcut in the tooltip, not glued to the icon — see the twin in
                ArticleRightPane. A "," rendered as a bordered chip beside a
                rail icon reads as stray punctuation, not a key. */}
            <PanelLeft size={16} />
          </button>

          {/* Nav icons */}
          <MainNavStripCollapsed onNavigate={onNavigate} />
        </m.div>
      </AnimatePresence>
    );
  }

  // Combine spaces for display, grouped by source
  const confluenceOptions = allSpaces.filter((s) => s.source === 'confluence');
  const localOptions = allSpaces.filter((s) => s.source === 'local');

  // A local space's chosen icon (spaces.icon) brands the selector chip;
  // unset falls back to the generic HardDrive local mark inside getSpaceIcon.
  // Confluence spaces and "All Spaces" keep Globe.
  const SelectedSpaceGlyph =
    selectedSpaceOption?.source === 'local'
      ? getSpaceIcon(selectedSpaceOption.icon)
      : Globe;

  return (
    <m.aside
      ref={sidebarRef}
      key="expanded-sidebar"
      initial={reduceEffects ? false : { width: 0, opacity: 0 }}
      animate={{ width: treeSidebarWidth, opacity: 1 }}
      transition={reduceEffects || isResizing ? { duration: 0 } : sidebarSpring}
      className={cn(
        'app-sidebar relative flex flex-col border-r overflow-hidden',
        isResizing && 'select-none',
      )}
    >
      {/* Global destinations remain visually separate from workspace content.
          `h-12` rather than `py-2`: this rule, the article context strip's and
          the inspector's header rule are one line running across the app, so
          all three are pinned to the same 48px border-box height instead of
          each being however tall its own content plus padding came out. */}
      <div className="panel-toolbar flex h-12 shrink-0 items-center gap-1 border-b px-2">
          <MainNavStripExpanded onNavigate={onNavigate} />
          <button
            onClick={toggleTreeSidebar}
            className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (,)"
          >
            <PanelLeftClose size={14} />
          </button>
      </div>

      {/* Workspace context — the selector is the panel's orientation anchor.
          It used to carry a "Workspace" caption and a `+` above it, together
          costing 101px of panel height to introduce one control. Both are gone,
          and neither is a loss. The caption named the section "Workspace" while
          the control selects a SPACE — the noun the API, the dropdown's own
          Confluence/Local headers and Confluence itself all use — so it was
          teaching the wrong word; and the selector states its own scope on two
          lines ("All Spaces" / "Every connected space"), which is what a
          caption would have had to say. The `+` was a second entrance to
          `/spaces/new` that the dropdown already offers by name at its foot,
          where creating a space belongs: beside the list of the ones you have. */}
      <div className="shrink-0 px-2 py-2">
        <div ref={spaceDropdownRef} className="relative">
          <button
            onClick={() => setSpaceDropdownOpen(!spaceDropdownOpen)}
            data-testid="space-selector-toggle"
            className="panel-context group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:border-primary/55"
            aria-expanded={spaceDropdownOpen}
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-ink">
              <SelectedSpaceGlyph size={14} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-foreground">
                {selectedSpaceOption?.name ?? 'All Spaces'}
              </span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {/* "Every connected space", not "Browse every connected
                    workspace": the old string did not fit its own line at any
                    sidebar width — the panel truncated its own copy — and it
                    called a space a workspace, which is the mix-up the removed
                    caption above was teaching. */}
                {selectedSpaceOption
                  ? `${selectedSpaceOption.source === 'local' ? 'Local' : 'Confluence'} · ${selectedSpaceOption.key}`
                  : 'Every connected space'}
              </span>
            </span>
            <ChevronsUpDown size={13} className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
          </button>
          {spaceDropdownOpen && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl nm-sidebar p-1">
              <button
                onClick={() => {
                  setTreeSidebarSpaceKey(undefined);
                  setSpaceDropdownOpen(false);
                }}
                className={cn(
                  'flex w-full items-center rounded-lg px-2.5 py-1.5 text-xs transition-all duration-200',
                  !treeSidebarSpaceKey ? 'nm-pill-active text-action font-medium' : 'text-foreground hover:bg-[var(--glass-pill-hover)]',
                )}
              >
                All Spaces
              </button>

              {/* Confluence spaces */}
              {confluenceOptions.length > 0 && (
                <>
                  <div className="px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">
                    Confluence
                  </div>
                  {confluenceOptions.map((space) => (
                    <button
                      key={space.key}
                      onClick={() => {
                        setTreeSidebarSpaceKey(space.key);
                        setSpaceDropdownOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-all duration-200',
                        treeSidebarSpaceKey === space.key
                          ? 'nm-pill-active text-action font-medium'
                          : 'text-foreground hover:bg-[var(--glass-pill-hover)]',
                      )}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <Globe size={10} className="shrink-0 text-muted-foreground/70" />
                        {space.name}
                      </span>
                      <span className="shrink-0 text-muted-foreground ml-2">{space.pageCount}</span>
                    </button>
                  ))}
                </>
              )}

              {/* Local spaces */}
              {localOptions.length > 0 && (
                <>
                  <div className="px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">
                    Local
                  </div>
                  {localOptions.map((space) => {
                    const SpaceGlyph = getSpaceIcon(space.icon);
                    return (
                      <button
                        key={space.key}
                        onClick={() => {
                          setTreeSidebarSpaceKey(space.key);
                          setSpaceDropdownOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-all duration-200',
                          treeSidebarSpaceKey === space.key
                            ? 'nm-pill-active text-action font-medium'
                            : 'text-foreground hover:bg-[var(--glass-pill-hover)]',
                        )}
                      >
                        <span className="flex items-center gap-1.5 truncate">
                          <SpaceGlyph size={10} className="shrink-0 text-action/70" />
                          {space.name}
                        </span>
                        <span className="shrink-0 text-muted-foreground ml-2">{space.pageCount}</span>
                      </button>
                    );
                  })}
                </>
              )}

              {/* Manage the selected local space (settings page is local-only) */}
              {isLocalSpace && treeSidebarSpaceKey && (
                <button
                  onClick={() => {
                    setSpaceDropdownOpen(false);
                    navigate(`/spaces/${treeSidebarSpaceKey}/settings`);
                  }}
                  data-testid="space-settings-link"
                  className="flex w-full items-center gap-1.5 border-t border-[var(--glass-sidebar-divider)] mt-1 pt-1 rounded-lg px-2.5 py-1.5 text-xs text-foreground hover:bg-[var(--glass-pill-hover)] transition-colors"
                >
                  <Settings size={10} />
                  Space settings
                </button>
              )}

              {/* Create new space link */}
              <button
                onClick={() => {
                  setSpaceDropdownOpen(false);
                  navigate('/spaces/new');
                }}
                className="flex w-full items-center gap-1.5 border-t border-[var(--glass-sidebar-divider)] mt-1 pt-1 rounded-lg px-2.5 py-1.5 text-xs text-action hover:bg-[var(--glass-pill-hover)] transition-colors"
              >
                <Plus size={10} />
                New Space
              </button>
            </div>
          )}
        </div>
      </div>

      {/* A compact navigation shortcut; the Pages dashboard remains the rich
          pinned overview with excerpts and management controls. */}
      {pinnedData && pinnedData.items.length > 0 && (
        <section className="shrink-0 border-t border-border px-2 py-2" aria-labelledby="sidebar-pinned-heading">
          <button
            type="button"
            onClick={() => setPinnedSectionCollapsed((value) => !value)}
            aria-expanded={!pinnedSectionCollapsed}
            aria-controls="sidebar-pinned-list"
            className="flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          >
            <Pin size={12} className="shrink-0 text-action" aria-hidden="true" />
            <span id="sidebar-pinned-heading" className="flex-1">Pinned</span>
            <span className="tabular-nums font-normal">{pinnedData.total}</span>
            <ChevronDown
              size={12}
              className={cn('transition-transform', pinnedSectionCollapsed && '-rotate-90')}
              aria-hidden="true"
            />
          </button>
          {!pinnedSectionCollapsed && (
            <div id="sidebar-pinned-list" className="mt-1 space-y-0.5">
              {pinnedData.items.slice(0, 4).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (isAiRoute) {
                      navigate(`/ai?pageId=${item.id}`, { replace: true });
                    } else {
                      navigate(`/pages/${item.id}`);
                    }
                    onNavigate?.();
                  }}
                  // Same geometry as a tree row (28px / 6px corner / 13px), not
                  // the 32px / 8px / 12px it used to have. A pinned page and a
                  // tree page are the same object listed twice in one panel, so
                  // two row shapes four pixels apart read as a rendering fault
                  // rather than as a distinction. The Pin glyph is the
                  // distinction, and it is enough.
                  className={cn(
                    'group flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    activePageId === item.id
                      ? 'nav-selection font-medium'
                      : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
                  )}
                  data-testid={`sidebar-pinned-${item.id}`}
                >
                  <Pin
                    size={12}
                    className={cn('shrink-0 opacity-65', activePageId === item.id && 'fill-current opacity-100')}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{item.title}</span>
                  <span className="max-w-14 shrink-0 truncate text-[11px] opacity-65">{item.spaceKey}</span>
                </button>
              ))}
              {pinnedData.items.length > 4 && (
                <button
                  type="button"
                  onClick={() => {
                    navigate('/');
                    onNavigate?.();
                  }}
                  className="flex h-7 w-full items-center rounded-md px-2 text-[11px] font-medium text-action transition-colors hover:bg-[var(--glass-pill-hover)]"
                >
                  View all {pinnedData.total} pinned pages
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {/* Page collection toolbar — actions are scoped to the tree below.

          The action here said "Folder" and wore a FolderPlus, and it calls
          createPage({ pageType: 'page' }).

          `folder` is a REAL page type — PageTypeEnum is z.enum(['page',
          'folder']) — and it is not cosmetic: embedding-service, quality-worker
          and summary-worker all exclude `page_type = 'folder'`, so a folder is
          precisely the thing that does NOT get indexed, scored or summarised.
          A control labelled "Folder" that creates a `page` therefore promises a
          container and hands back an indexed document, which then collects
          embeddings, a quality score and a summary — everything a container
          should not have.

          This is labelled as what it does, which is the change that cannot be
          wrong. Making it create an actual `pageType: 'folder'` instead is the
          other way to close the gap, but that is a behaviour change with
          pipeline consequences and it is the owner's call, not a copy fix. The
          test below has pinned the mismatch by NAME ("creates new folder as
          pageType 'page' (not 'folder')") since before this change — it was
          documented rather than resolved. */}
      <div className="flex h-9 shrink-0 items-center justify-between border-y border-border px-3">
        <span className="text-xs font-semibold text-foreground/85">Pages</span>
        <button
          onClick={() => {
            setShowNewPageInput((v) => !v);
            setNewPageTitle('');
          }}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          aria-expanded={showNewPageInput}
          title="Create a page in this space"
        >
          <FilePlus size={13} />
          New page
        </button>
      </div>

      {/* Inline new-page input */}
      {showNewPageInput && (
        <div className="px-2 py-1.5" data-testid="new-page-input">
          <div className="flex items-center gap-1.5">
            <FilePlus size={14} className="shrink-0 text-action/70" aria-hidden="true" />
            <input
              ref={newPageTitleRef}
              value={newPageTitle}
              onChange={(e) => setNewPageTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreatePage();
                if (e.key === 'Escape') {
                  setShowNewPageInput(false);
                  setNewPageTitle('');
                }
              }}
              // Placeholder is an example, not the label — the accessible name
              // below is what names the field.
              placeholder="Page title"
              className="flex-1 rounded-md bg-foreground/5 px-2 py-1 text-xs text-foreground outline-none ring-1 ring-primary/30 focus:ring-ring transition-colors"
              aria-label="Title of the new page"
            />
            {/* "Create", not "Add": it names the action, and "Add" alongside a
                title field reads as adding the title to something. The pending
                label is a word rather than an ellipsis so a screen reader
                announces a state instead of three dots. */}
            <button
              onClick={handleCreatePage}
              disabled={!newPageTitle.trim() || createPage.isPending}
              className="inline-flex items-center rounded-md border border-action bg-transparent px-2 py-1 text-xs font-medium text-action transition-colors hover:bg-action hover:text-action-foreground disabled:opacity-40"
            >
              {createPage.isPending ? 'Creating' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Tree content with drag-and-drop + scroll mask */}
      <div
        ref={treeScrollRef}
        data-testid="tree-scroll"
        onMouseDownCapture={snapshotTreeScroll}
        onKeyDownCapture={snapshotTreeScroll}
        className="flex-1 overflow-y-auto p-2 scroll-mask"
      >
        {isLoading ? (
          <div className="space-y-1.5 p-2">
            {[...Array(8)].map((_, i) => (
              <div
                key={i}
                className="h-7 animate-pulse rounded-lg bg-foreground/5"
                style={{ width: `${60 + Math.random() * 30}%`, marginLeft: `${(i % 3) * 16}px` }}
              />
            ))}
          </div>
        ) : tree.length === 0 ? (
          <div className="flex flex-col items-center px-3 py-8 text-center">
            <div className="mb-3 rounded-full bg-muted p-2.5">
              <FileText size={20} className="text-muted-foreground" />
            </div>
            <p className="text-xs font-medium text-foreground/70">
              {treeSidebarSpaceKey ? 'No pages in this space' : 'No pages synced yet'}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {treeSidebarSpaceKey ? 'This space has no content.' : 'Sync a Confluence space to get started.'}
            </p>
            {!treeSidebarSpaceKey && (
              <button
                onClick={() => navigate('/settings')}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-action bg-transparent px-3 py-1.5 text-xs font-medium text-action hover:bg-action hover:text-action-foreground transition-colors"
              >
                <Plus size={12} />
                Sync a Space
              </button>
            )}
          </div>
        ) : isLocalSpace ? (
          <Suspense fallback={
            <div className="space-y-1 px-2">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-9 animate-pulse rounded-[10px] bg-foreground/5" />
              ))}
            </div>
          }>
            <DndLocalSpaceTree
              tree={tree}
              expandedIds={expandedIds}
              toggleExpand={toggleExpand}
              activePageId={activePageId}
              isAiRoute={isAiRoute}
              reorderPage={reorderPage}
              rovingId={rovingId}
              onRowFocus={handleRowFocus}
              onRowKeyDown={handleRowKeyDown}
            />
          </Suspense>
        ) : (
          // #880: role="tree" + label give the role="treeitem" rows a valid
          // required-parent context and expose real tree semantics to screen
          // readers. Roving-tabindex + arrow-key nav below closes out the
          // epic #856 follow-up this comment used to defer.
          <div className="space-y-0.5" role="tree" aria-label="Pages">
            {tree.map((node) => (
              <SidebarTreeNode
                key={node.page.id}
                node={node}
                expandedSet={expandedIds}
                toggleExpand={toggleExpand}
                activePageId={activePageId}
                isAiRoute={isAiRoute}
                rovingId={rovingId}
                onRowFocus={handleRowFocus}
                onRowKeyDown={handleRowKeyDown}
              />
            ))}
          </div>
        )}
      </div>

      {/* Stable footer keeps the current scope visible beneath long trees. */}
      {treeData && (
        <div className="panel-toolbar border-t px-3 py-2">
          <span className="text-[11px] text-muted-foreground">
            {treeData.total} {treeData.total === 1 ? 'page' : 'pages'}{treeSidebarSpaceKey ? ` in ${treeSidebarSpaceKey}` : ''}
          </span>
        </div>
      )}

      {/* Resize handle */}
      <div
        role="separator"
        aria-label="Resize tree sidebar"
        aria-orientation="vertical"
        aria-valuemin={180}
        aria-valuemax={600}
        aria-valuenow={treeSidebarWidth}
        tabIndex={0}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setTreeSidebarWidth(280)}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          'group absolute bottom-0 right-0 top-0 z-10 flex w-2 cursor-col-resize items-center justify-end outline-none',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
        title="Drag to resize · Double-click to reset"
      >
        <span
          className={cn(
            'h-full w-px bg-transparent transition-colors group-hover:bg-action/45 group-focus-visible:bg-action/55',
            isResizing && 'bg-action/70',
          )}
          aria-hidden="true"
        />
      </div>
    </m.aside>
  );
}
