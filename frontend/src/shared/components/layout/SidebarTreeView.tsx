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
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { ApiError } from '../../lib/api';
import { getSpaceIcon } from '../spaces/space-icons';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { MainNavStripExpanded, MainNavStripCollapsed } from './MainNavStrip';

import { usePageTree, useCreatePage, usePinnedPages } from '../../hooks/use-pages';
import { useSpaces } from '../../hooks/use-spaces';
import { useLocalSpaces, useReorderPage } from '../../hooks/use-standalone';
import { useClickOutside } from '../../hooks/use-click-outside';
import { useUiStore } from '../../../stores/ui-store';
import { cn } from '../../lib/cn';
import { PageIcon } from '../page-icon/PageIcon';
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

/**
 * Compact fallback for the row-suffix disambiguator when a page has no
 * spaceKey (an unfiled standalone page). A static "Local" label would tell
 * an unfiled page apart from a Confluence one, but real duplicate-titled
 * corpora are dominated by same-titled *unfiled* pages — a static label
 * doesn't distinguish those from each other, which is the actual failure
 * the disambiguator exists to prevent. A short relative date does, and the
 * existing `formatRelativeTime` helper is built for a full-width context
 * ("3d ago", or a locale date string past a week) — too wide for this
 * suffix's 56px (`max-w-14`) budget, hence a purpose-built short form here.
 */
function formatCompactDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const diffDays = Math.floor((Date.now() - new Date(dateStr).getTime()) / 86_400_000);
  if (diffDays < 1) return 'today';
  if (diffDays < 30) return `${diffDays}d`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo`;
  return `${Math.floor(diffMonths / 12)}y`;
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

/**
 * One treatment for every section label in this panel. There were four:
 * "Pages" at 12px sentence case in `text-foreground/85`, "Pinned" at 11px
 * sentence case in `text-muted-foreground`, and the dropdown's "Confluence" /
 * "Local" headings at 11px again — four weights and two colours for one role,
 * inside one 280px column.
 *
 * Uppercase at 12px is the settled convention: `SettingsSidebar` uses it for
 * its group headings, and ADR-010 pins the editor's menu section labels at
 * "uppercase at 12px, not 11" because `ui-text-legibility.test.ts` holds
 * capitals to a higher floor than body text. 11px uppercase would fail it.
 *
 * Full-strength `text-muted-foreground` (no opacity dilution) measures
 * 7.46:1 on Graphite and 5.56:1 on Paper — both comfortably clear WCAG
 * 1.4.3's 4.5:1 floor, since 12px semibold does not qualify as "large text."
 * The previous `/80` opacity modifier composited down to 3.63:1 on Paper,
 * failing — Graphite's darker ground happened to still clear it at 5.14:1,
 * which is exactly the kind of theme-asymmetric failure that hides until
 * someone measures the specific composited value instead of the token.
 */
const SECTION_LABEL = 'text-[12px] font-semibold uppercase tracking-[0.08em] text-muted-foreground';

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
  // True only in "All Spaces" scope, where sibling rows can come from
  // different spaces (and, in a real corpus, can share a title outright —
  // see the spaceKey suffix below). Scoped to one space, the tree already
  // carries that context via the panel chrome above it, so the suffix would
  // be redundant on every row.
  showSpaceKey: boolean;
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
  showSpaceKey,
  rovingId,
  onRowFocus,
  onRowKeyDown,
}: SidebarTreeNodeProps) {
  const navigate = useNavigate();
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const isActive = node.page.id === activePageId;

  // A parent row does two jobs — open the page, and (via its own chevron,
  // indent guide, and ArrowRight/Left) expand its children — and used to
  // conflate them: clicking the title toggled expansion unconditionally
  // before navigating, so opening an already-expanded section closed the
  // very children you clicked through to reach, non-idempotently (the same
  // click expanded or collapsed depending on what was already open). Now the
  // click only ever opens a collapsed parent; an already-open one just
  // navigates, matching the other three expand/collapse paths.
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
        // Hierarchy and "where am I" are the two things a tree exists to
        // communicate, and neither reached assistive tech: the open page was
        // conveyed by fill colour and font-weight alone. aria-selected is the
        // ARIA APG's own signal for "the current item in this tree."
        aria-selected={isActive}
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
        // The row has no other way to recover a title clipped by `truncate`
        // below — no hover card, nothing keyboard- or touch-reachable — so a
        // long or duplicate title (both routine in a real Confluence corpus)
        // was unrecoverable without navigating away to check. A native title
        // tooltip is a small answer, but it's the whole gap in one attribute.
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
            className="absolute top-[2px] z-10 flex size-6 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground"
            style={{ left: `${level * 12 + 2}px` }}
            // A MOUSE affordance, and only that — hence out of the tab order and
            // out of the accessibility tree.
            //
            // As a plain <button> it was natively focusable, so the tree's
            // roving tabindex ("exactly one row is ever tab-stoppable") was
            // defeated by every parent: a 20-parent tree was 21 tab stops, not
            // one. And each announced the same bare "Expand" with no object, so
            // in a list of twenty identical "Expand" buttons none of them could
            // be told apart anyway.
            //
            // Nothing is lost. The row IS the control per ARIA APG: it carries
            // aria-expanded, and sidebar-tree-keyboard handles ArrowRight to
            // expand-then-descend and ArrowLeft to collapse, both covered by
            // its own tests. aria-hidden is safe on a tabindex="-1" element —
            // axe's aria-hidden-focus rule tests tab-order focusability.
            //
            // The aria-label stays as a test hook and an intent marker; it is
            // not announced.
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
        {node.page.icon && (
          <PageIcon icon={node.page.icon} pageId={node.page.id} size="row" className="mr-1.5" />
        )}
        <span className={cn('min-w-0 flex-1 truncate text-[13px]', isActive ? 'font-medium' : 'font-normal')}>
          {node.page.title}
        </span>
        {/* All-Spaces scope merges every space's pages into one flat, sorted
            run with nothing else distinguishing them — a corpus with any
            amount of templated content (runbooks, meeting notes) reliably
            produces same-titled rows next to each other. Same geometry as the
            Pinned section's spaceKey suffix 80px above, which already solved
            this for the same object listed a second time in this panel.
            An unfiled standalone page has no spaceKey to show — and in a real
            corpus, duplicate titles cluster among exactly those pages, so a
            static "Local" label wouldn't tell one apart from another. The
            last-modified date does.
            No opacity dilution: the inherited `text-muted-foreground` already
            clears WCAG 1.4.3 on its own (7.46:1 Graphite / 5.56:1 Paper) —
            the previous `opacity-65` composited that down to 3.76:1 / 2.72:1,
            failing on the one row whose whole job is disambiguation. */}
        {showSpaceKey && (
          <span className="ml-2 max-w-14 shrink-0 truncate text-[11px]">
            {node.page.spaceKey ?? formatCompactDate(node.page.lastModifiedAt)}
          </span>
        )}
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
            // Same story as the chevron above: a mouse shortcut duplicating a
            // control the row already exposes, so it is hidden rather than
            // announced as a second way to do the same thing.
            aria-label={`Collapse ${node.page.title}`}
            aria-hidden="true"
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
              showSpaceKey={showSpaceKey}
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
    prev.showSpaceKey === next.showSpaceKey &&
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
  /** Pages / AI / Graph live on the chassis on desktop. The mobile drawer
   *  and isolated tests pass true; AppLayout desktop passes false. */
  embedMainNav?: boolean;
}

export function SidebarTreeView({
  onNavigate,
  forceCollapsed = false,
  onForceExpand,
  embedMainNav = true,
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
  const {
    data: treeData,
    isLoading,
    isError: treeIsError,
    error: treeError,
    refetch: refetchTree,
    isFetching: isFetchingTree,
  } = usePageTree({
    spaceKey: treeSidebarSpaceKey,
  });

  // Two different failures, two different treatments. With nothing cached the
  // panel has no pages to offer and the error IS the content. With a cached
  // tree still in hand — a background refetch that failed, the common case —
  // replacing a working tree with an error screen would take away the
  // navigation the user is mid-task in, to report a problem that has not yet
  // cost them anything. That one gets a strip above the tree instead.
  const treeFailedWithNothingToShow = treeIsError && !treeData;
  const treeIsStale = treeIsError && !!treeData;
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
  const [spaceFilter, setSpaceFilter] = useState('');
  const spaceFilterRef = useRef<HTMLInputElement>(null);
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

  // The filter is a scale affordance, so it appears only at scale: below this
  // the whole list fits and a search box would be a row of chrome above six
  // items. It also resets whenever the dropdown closes — a remembered filter
  // would silently hide spaces from the next person to open it.
  const SPACE_FILTER_THRESHOLD = 8;
  const showSpaceFilter = allSpaces.length > SPACE_FILTER_THRESHOLD;

  const closeSpaceDropdown = useCallback(() => {
    setSpaceDropdownOpen(false);
    setSpaceFilter('');
  }, []);
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
      // Deliberately swallowed HERE and reported from `createPage.error`
      // below. The comment this replaces said "error handled by mutation" and
      // that was not true of anything: useCreatePage has no onError, so a
      // failed create closed nothing, said nothing, and left the user staring
      // at their own typed title wondering whether it had worked.
      //
      // The input stays open and the title stays in it, so retrying is one
      // keystroke rather than a retype.
    }
  }, [newPageTitle, treeSidebarSpaceKey, createPage]);

  // Clear a previous failure the moment the user edits the title or reopens
  // the field, so a stale message can't sit under a fresh attempt.
  const handleNewPageTitleChange = useCallback((value: string) => {
    setNewPageTitle(value);
    if (createPage.isError) createPage.reset();
  }, [createPage]);

  useEffect(() => {
    if (showNewPageInput) {
      newPageTitleRef.current?.focus();
    }
  }, [showNewPageInput]);

  // Opening the list puts the caret in the filter when there is one, so a
  // keyboard user can start narrowing immediately instead of tabbing past the
  // whole list to reach it.
  useEffect(() => {
    if (spaceDropdownOpen && showSpaceFilter) {
      spaceFilterRef.current?.focus();
    }
  }, [spaceDropdownOpen, showSpaceFilter]);

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

  // Auto-select space based on current page — but only ever once per mount,
  // and never again after the user has explicitly touched the scope control.
  // `treeSidebarSpaceKey === undefined` cannot tell "never chosen" apart from
  // "explicitly chose All Spaces" — both look identical to this effect — so
  // without the ref below, picking "All Spaces" while any page is open got
  // silently reverted to that page's own space on the very next render: the
  // effect saw the same falsy key and fired again, with no error and no
  // visible change. `hasAutoSelectedSpaceRef` is set here on the one
  // legitimate auto-fire AND in every explicit dropdown selection below, so
  // any user choice — a specific space or "All Spaces" — permanently retires
  // this convenience default for the rest of the mount.
  const hasAutoSelectedSpaceRef = useRef(false);
  useEffect(() => {
    if (hasAutoSelectedSpaceRef.current) return;
    if (activePageId && pages.length > 0 && !treeSidebarSpaceKey) {
      const currentPage = pages.find((p) => p.id === activePageId);
      // An unfiled standalone page (spaceKey null) has no space to scope
      // into at all — there is nothing this convenience could narrow to.
      if (currentPage && currentPage.spaceKey) {
        // Narrowing scope to the open page's own space is pointless — and
        // actively harmful — when that page IS the space's configured
        // homepage: buildTree's #352 rule hides the homepage from its own
        // space's tree (it's reachable via the space's dedicated Home link
        // instead), so auto-scoping here would remove the very row the user
        // just opened, leaving the panel with no selected row at all. All
        // Spaces never applies homepage-hiding (buildTree only receives a
        // homepageId once a single space is selected), so leaving scope
        // alone keeps the open page visible and correctly selected. Don't
        // retire the auto-select convenience for the rest of the mount here
        // — a later navigation to an ordinary sub-page should still get it.
        const currentSpace = allSpaces.find((s) => s.key === currentPage.spaceKey);
        if (currentSpace?.homepageId !== currentPage.id) {
          hasAutoSelectedSpaceRef.current = true;
          setTreeSidebarSpaceKey(currentPage.spaceKey);
        }
      }
    }
  }, [activePageId, pages, treeSidebarSpaceKey, setTreeSidebarSpaceKey, allSpaces]);

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

  // A local space's chosen icon (spaces.icon) brands the selector chip;
  // unset falls back to the generic HardDrive local mark inside getSpaceIcon.
  // Confluence spaces and "All Spaces" keep Globe. Computed above the collapsed
  // branch because the rail shows it too.
  const SelectedSpaceGlyph =
    selectedSpaceOption?.source === 'local'
      ? getSpaceIcon(selectedSpaceOption.icon)
      : Globe;
  const selectedSpaceLabel = selectedSpaceOption?.name ?? 'All Spaces';

  // Collapsed rail -- nav icons + expand toggle
  const collapsed = treeSidebarCollapsed || forceCollapsed;

  if (collapsed) {
    return (
      <AnimatePresence mode="wait">
        {/* <aside>, not <div>. The expanded panel below is an <aside>, so
            collapsing the rail used to DELETE the complementary landmark from
            the page — a screen-reader user who collapsed the tree lost the
            region, not just its contents. Both branches are the same region in
            two sizes, and both are named: the app renders two unlabelled
            <aside>s otherwise (this and the article inspector), which announce
            as two indistinguishable "complementary" regions. */}
        <m.aside
          key="collapsed-rail"
          aria-label="Page tree"
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

          {embedMainNav && <MainNavStripCollapsed onNavigate={onNavigate} />}

          {/* Current scope. Collapsing used to drop every trace of it — not the
              space, not the open page, not the count — so the one question the
              rail could not answer was "which space am I looking at?", and the
              only way to find out was to expand. It is the selector's own glyph,
              and it expands the panel, so it reads as scope AND acts as a way
              back to changing it.

              The explanation used to live only in `title` — invisible to a
              sighted keyboard user, who gets neither the mouse-hover tooltip
              nor a screen reader's aria-label announcement. `group` +
              `group-focus-visible` shows the same text as a flyout on Tab
              focus too, no new dependency, matching the flat/no-glass surface
              rules (nm-card-elevated, the one real shadow) rather than
              inventing a second tooltip system. */}
          <div className="group relative mt-2 flex w-full flex-col items-center border-t border-border pt-2">
            <button
              onClick={() => {
                if (forceCollapsed && !treeSidebarCollapsed) onForceExpand?.();
                else toggleTreeSidebar();
              }}
              data-testid="rail-space-scope"
              className="flex size-7 items-center justify-center rounded-lg bg-primary/10 text-primary-ink transition-colors hover:bg-primary/20"
              aria-label={`Scope: ${selectedSpaceLabel}. Expand sidebar to change.`}
              title={selectedSpaceLabel}
            >
              <SelectedSpaceGlyph size={14} aria-hidden="true" />
            </button>
            <span
              role="tooltip"
              data-testid="rail-space-scope-flyout"
              className="pointer-events-none absolute left-full top-0 z-50 ml-2 whitespace-nowrap rounded-md nm-card-elevated px-2 py-1 text-[11px] text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              {selectedSpaceLabel} · Expand to change
            </span>
          </div>

        </m.aside>
      </AnimatePresence>
    );
  }

  // Combine spaces for display, grouped by source. Filtering matches name OR
  // key, because an operator who knows a space as "OPS" should not have to
  // remember that it is called "Operations Handbook".
  const spaceFilterQuery = spaceFilter.trim().toLowerCase();
  const matchesSpaceFilter = (s: SpaceOption) =>
    !spaceFilterQuery ||
    s.name.toLowerCase().includes(spaceFilterQuery) ||
    s.key.toLowerCase().includes(spaceFilterQuery);
  const confluenceOptions = allSpaces.filter((s) => s.source === 'confluence' && matchesSpaceFilter(s));
  const localOptions = allSpaces.filter((s) => s.source === 'local' && matchesSpaceFilter(s));

  return (
    <m.aside
      ref={sidebarRef}
      key="expanded-sidebar"
      aria-label="Page tree"
      initial={reduceEffects ? false : { width: 0, opacity: 0 }}
      animate={{ width: treeSidebarWidth, opacity: 1 }}
      transition={reduceEffects || isResizing ? { duration: 0 } : sidebarSpring}
      className={cn(
        'app-sidebar relative flex max-w-full flex-col border-r overflow-hidden',
        isResizing && 'select-none',
      )}
    >
      {embedMainNav && (
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
      )}

      {/* Space selector + collapse share the 48px chrome line that the
          article toolbar and inspector tab row also draw (`h-12` + `border-b`).
          Scope lives on the chip; source/key stay in the title. New Space
          stays at the foot of the dropdown. */}
      <div className="panel-toolbar flex h-12 shrink-0 items-center gap-1 border-b px-2">
        <div ref={spaceDropdownRef} className="relative min-w-0 flex-1">
          <button
            // Routed through closeSpaceDropdown on the way shut so the filter
            // clears here too — wiring only useClickOutside to it left a
            // filtered list behind whenever you closed with the toggle.
            onClick={() => (spaceDropdownOpen ? closeSpaceDropdown() : setSpaceDropdownOpen(true))}
            data-testid="space-selector-toggle"
            className="panel-context group flex h-8 w-full min-w-0 items-center gap-1.5 rounded-lg px-2 text-left transition-colors hover:bg-[var(--glass-pill-hover)]"
            aria-expanded={spaceDropdownOpen}
            title={
              selectedSpaceOption
                ? `${selectedSpaceOption.source === 'local' ? 'Local' : 'Confluence'} · ${selectedSpaceOption.key}`
                : 'Every connected space'
            }
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary-ink">
              <SelectedSpaceGlyph size={13} />
            </span>
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
              {selectedSpaceOption?.name ?? 'All Spaces'}
            </span>
            <ChevronsUpDown size={13} className="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
          </button>
          {spaceDropdownOpen && (
            // `nm-card-elevated`, not `nm-sidebar`. nm-sidebar is the PANEL
            // CHASSIS utility — `background: var(--color-background)` plus a
            // border-RIGHT — so this floating layer was painting the same
            // colour as the panel it covers and edging it on one side only.
            // Measured in Graphite: box-shadow none, background rgb(13,14,17),
            // identical to the sidebar beneath, and you genuinely could not see
            // where the dropdown ended and the tree resumed.
            //
            // ADR-010 keeps exactly one real shadow, --shadow-overlay, for
            // "content that genuinely floats above the page: popovers,
            // dropdowns, dialogs". This is the canonical case and it was the
            // one thing not using it. nm-card-elevated carries that shadow, a
            // full 1px border and the elevated card surface.
            <div className="absolute left-0 right-0 top-full z-50 mt-1 flex max-h-72 flex-col nm-card-elevated p-1">
              {/* A filter, once the list stops fitting. The dropdown was a
                  capped scroller with no search and no scroll affordance: six
                  spaces plus two headings already filled it here, and a real
                  Confluence instance with thirty spaces got a blind 256px
                  scroller. It appears only when it earns its row, so small
                  instances keep the list they had.

                  Safe as a text input because this is a plain div of buttons,
                  not a Radix menu — there is no role="menu" typeahead to
                  swallow the keystrokes (the trap documented on the editor's
                  block menu and Insert menu). */}
              {showSpaceFilter && (
                <div className="shrink-0 px-1 pb-1 pt-0.5">
                  <input
                    ref={spaceFilterRef}
                    value={spaceFilter}
                    onChange={(e) => setSpaceFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        if (spaceFilter) setSpaceFilter('');
                        else setSpaceDropdownOpen(false);
                      }
                    }}
                    placeholder="Filter spaces"
                    aria-label="Filter spaces by name"
                    className="w-full rounded-md bg-foreground/5 px-2 py-1 text-xs text-foreground outline-none ring-1 ring-border transition-colors focus:ring-ring"
                  />
                </div>
              )}

              <div className="min-h-0 flex-1 overflow-y-auto">
              <button
                onClick={() => {
                  hasAutoSelectedSpaceRef.current = true;
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
                  <div className={cn('px-2.5 py-1.5', SECTION_LABEL)}>
                    Confluence
                  </div>
                  {confluenceOptions.map((space) => (
                    <button
                      key={space.key}
                      onClick={() => {
                        hasAutoSelectedSpaceRef.current = true;
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
                      {/* Only the name truncates — the key stays visible so two
                          identically-named spaces (a real occurrence, not just
                          seed noise) are still distinguishable. The space
                          filter above already matches on this key; it just
                          used to never be shown. */}
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Globe size={10} className="shrink-0 text-muted-foreground/70" />
                        <span className="truncate">{space.name}</span>
                        <span className="shrink-0 text-muted-foreground/60">{space.key}</span>
                      </span>
                      <span className="shrink-0 text-muted-foreground ml-2">{space.pageCount}</span>
                    </button>
                  ))}
                </>
              )}

              {/* Local spaces */}
              {localOptions.length > 0 && (
                <>
                  <div className={cn('px-2.5 py-1.5', SECTION_LABEL)}>
                    Local
                  </div>
                  {localOptions.map((space) => {
                    const SpaceGlyph = getSpaceIcon(space.icon);
                    return (
                      <button
                        key={space.key}
                        onClick={() => {
                          hasAutoSelectedSpaceRef.current = true;
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
                        <span className="flex min-w-0 items-center gap-1.5">
                          <SpaceGlyph size={10} className="shrink-0 text-action/70" />
                          <span className="truncate">{space.name}</span>
                          <span className="shrink-0 text-muted-foreground/60">{space.key}</span>
                        </span>
                        <span className="shrink-0 text-muted-foreground ml-2">{space.pageCount}</span>
                      </button>
                    );
                  })}
                </>
              )}

              {/* Nothing matched the filter. Without this the dropdown just
                  emptied out and looked broken. */}
              {showSpaceFilter && confluenceOptions.length === 0 && localOptions.length === 0 && (
                <p className="px-2.5 py-3 text-center text-[11px] text-muted-foreground">
                  No spaces match &ldquo;{spaceFilter}&rdquo;
                </p>
              )}
              </div>

              {/* Footer actions stay pinned below the scroller — they are how
                  you leave this list, so they must not scroll out of it. */}
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
        {!embedMainNav && (
          <button
            onClick={toggleTreeSidebar}
            className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (,)"
          >
            <PanelLeftClose size={14} />
          </button>
        )}
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
            className={cn('flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground', SECTION_LABEL)}
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
                  {/* No opacity dilution — see the matching suffix in the main
                      tree above; the inherited text-muted-foreground clears
                      WCAG 1.4.3 on its own. */}
                  <span className="max-w-14 shrink-0 truncate text-[11px]">
                    {item.spaceKey ?? formatCompactDate(item.lastModifiedAt)}
                  </span>
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
        <span className={SECTION_LABEL}>Pages</span>
        <button
          onClick={() => {
            setShowNewPageInput((v) => !v);
            setNewPageTitle('');
          }}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          aria-expanded={showNewPageInput}
          // Used to read "Create a page in this space" unconditionally — a lie
          // in All Spaces scope, where `handleCreatePage` below falls back to
          // the `__local__` sentinel and the backend stores the page with NO
          // space at all (pages-crud.ts: spaceSource stays null for the
          // sentinel, so the final spaceKey is null, not "this space" or even
          // a nameable default). Naming the real target in both branches closes
          // that gap without changing behavior.
          title={
            selectedSpaceOption
              ? `Create a page in ${selectedSpaceOption.name}`
              : 'Create an unfiled page — no space is selected'
          }
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
              onChange={(e) => handleNewPageTitleChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreatePage();
                if (e.key === 'Escape') {
                  setShowNewPageInput(false);
                  setNewPageTitle('');
                  createPage.reset();
                }
              }}
              // Placeholder is an example, not the label — the accessible name
              // below is what names the field.
              placeholder="Page title"
              className={cn(
                'flex-1 rounded-md bg-foreground/5 px-2 py-1 text-xs text-foreground outline-none ring-1 focus:ring-ring transition-colors',
                createPage.isError ? 'ring-destructive' : 'ring-primary/30',
              )}
              aria-label="Title of the new page"
              aria-invalid={createPage.isError || undefined}
              aria-describedby={createPage.isError ? 'new-page-error' : undefined}
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
          {/* Visible, not hover-only — a title tooltip alone is unreachable by
              touch or keyboard, and this is exactly the case the toolbar
              button's own title attribute above cannot cover for those users.
              Only shown in All Spaces scope, where there's a real destination
              mismatch to disclose; a page created against a selected space
              needs no such notice. */}
          {!treeSidebarSpaceKey && (
            <p className="mt-1.5 pl-[22px] text-[11px] text-muted-foreground">
              Creates an unfiled page — pick a space above to file it there instead.
            </p>
          )}
          {/* Sits under the field it describes, wired by aria-describedby, and
              in a live region so it is announced rather than only drawn. The
              typed title is still in the input above it. */}
          {createPage.isError && (
            <p
              id="new-page-error"
              role="alert"
              data-testid="new-page-error"
              className="mt-1.5 break-words line-clamp-3 pl-[22px] text-[11px] text-destructive"
            >
              {createPage.error instanceof ApiError
                ? createPage.error.message
                : 'The page could not be created. Try again.'}
            </p>
          )}
        </div>
      )}

      {/* A refresh failed but the cached tree is still usable. Say so without
          taking it away — the pages below are real, just possibly behind. */}
      {treeIsStale && (
        <div
          role="status"
          data-testid="tree-stale-notice"
          className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5"
        >
          <AlertTriangle size={12} className="shrink-0 text-warning" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
            Showing the last loaded pages
          </span>
          <button
            onClick={() => refetchTree()}
            disabled={isFetchingTree}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-action transition-colors hover:bg-[var(--glass-pill-hover)] disabled:opacity-40"
          >
            {isFetchingTree ? 'Retrying' : 'Retry'}
          </button>
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
        ) : treeFailedWithNothingToShow ? (
          // The tree used to consume only { data, isLoading }, so a failed
          // request left `treeData` undefined, `tree` empty, and the EMPTY
          // state on screen: "No pages synced yet — Sync a Confluence space to
          // get started", with a button into Settings. The panel diagnosed a
          // network failure as an unconfigured integration and pointed the user
          // at the most expensive wrong action available to them.
          //
          // role="alert" because this replaces content the user is waiting on
          // and it arrives after their navigation, not before it.
          <div className="flex flex-col items-center px-3 py-8 text-center" role="alert" data-testid="tree-error">
            {/* Destructive, not warning. ADR-010 reserves amber for
                warning/attention and red (status-disconnected) for failure, and
                this request FAILED — the same call `Message.isError` makes. The
                amber one is the stale strip above the tree, where the pages are
                real and only possibly behind: that is attention, not failure. */}
            <div className="mb-3 rounded-full bg-muted p-2.5">
              <AlertTriangle size={20} className="text-destructive" aria-hidden="true" />
            </div>
            <p className="text-xs font-medium text-foreground/70">Couldn&rsquo;t load pages</p>
            {/* ApiError's message is already curated prose carrying the status
                code (see api.ts failureMessage) — not a raw server body — so it
                is safe to show and it is the only place the user learns WHY.
                Clamped because this pane is 280px and a gateway message is not. */}
            <p className="mt-1 break-words line-clamp-3 text-[11px] text-muted-foreground">
              {treeError instanceof ApiError
                ? treeError.message
                : 'The request did not complete. Your pages are still there.'}
            </p>
            <button
              onClick={() => refetchTree()}
              disabled={isFetchingTree}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-action bg-transparent px-3 py-1.5 text-xs font-medium text-action transition-colors hover:bg-action hover:text-action-foreground disabled:opacity-40"
            >
              <RefreshCw size={12} className={cn(isFetchingTree && 'animate-spin')} aria-hidden="true" />
              {isFetchingTree ? 'Retrying' : 'Try again'}
            </button>
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
                <div key={i} className="h-9 animate-pulse rounded-xl bg-foreground/5" />
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
                showSpaceKey={!treeSidebarSpaceKey}
                rovingId={rovingId}
                onRowFocus={handleRowFocus}
                onRowKeyDown={handleRowKeyDown}
              />
            ))}
          </div>
        )}
      </div>

      {/* Scope count. Out of the scroller so it stays visible under a long tree. */}
      <div className="panel-toolbar flex shrink-0 items-center gap-2 border-t px-2 py-1.5">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {treeData
            ? `${treeData.total} ${treeData.total === 1 ? 'page' : 'pages'}${treeSidebarSpaceKey ? ` in ${treeSidebarSpaceKey}` : ''}`
            : ''}
        </span>
      </div>

      {/* Resize handle */}
      <div
        role="separator"
        aria-label="Resize tree sidebar"
        aria-orientation="vertical"
        aria-valuemin={180}
        aria-valuemax={600}
        aria-valuenow={treeSidebarWidth}
        // Without this a screen reader announces a bare "256" — a number with
        // no unit, on a control whose whole job is a measurement.
        aria-valuetext={`${treeSidebarWidth} pixels`}
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
