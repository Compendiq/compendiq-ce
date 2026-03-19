import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import {
  BookOpen,
  Bot,
  ChevronRight,
  ChevronDown,
  FileText,
  FolderPlus,
  ChevronsUpDown,
  GripVertical,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Globe,
  HardDrive,
  Share2,
} from 'lucide-react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { DragDropProvider } from '@dnd-kit/react';
import { useSortable, isSortable } from '@dnd-kit/react/sortable';
import { usePageTree, useCreatePage } from '../../hooks/use-pages';
import { useSpaces } from '../../hooks/use-spaces';
import { useLocalSpaces, useReorderPage } from '../../hooks/use-standalone';
import { useClickOutside } from '../../hooks/use-click-outside';
import { useUiStore } from '../../../stores/ui-store';
import { cn } from '../../lib/cn';
import type { PageTreeItem } from '../../hooks/use-pages';

const navItems = [
  { icon: BookOpen, label: 'Pages', path: '/' },
  { icon: Share2, label: 'Graph', path: '/graph' },
  { icon: Bot, label: 'AI', path: '/ai' },
] as const;

export interface TreeNode {
  page: PageTreeItem;
  children: TreeNode[];
}

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

  // Sort children alphabetically
  function sortChildren(nodes: TreeNode[]) {
    nodes.sort((a, b) => a.page.title.localeCompare(b.page.title));
    nodes.forEach((n) => sortChildren(n.children));
  }
  sortChildren(roots);

  // If homepageId is provided, keep the homepage itself as the visible root
  // so it remains clickable as a tree entry.
  if (homepageId) {
    const homepageNode = nodeMap.get(homepageId);
    if (homepageNode) {
      return [homepageNode];
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
  enableDrag?: boolean;
  sortableIndex?: number;
}

export const SidebarTreeNode = memo(function SidebarTreeNode({
  node,
  level = 0,
  expandedSet,
  toggleExpand,
  activePageId,
  enableDrag = false,
  sortableIndex,
}: SidebarTreeNodeProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const isActive = node.page.id === activePageId;
  const isAiRoute = location.pathname === '/ai';

  // Always call hook (React rules), but only use the ref when DnD is active
  const sortable = useSortable({
    id: node.page.id,
    index: sortableIndex ?? 0,
    disabled: !enableDrag,
  });

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
    <div ref={enableDrag ? sortable.ref : undefined}>
      <div
        className={cn(
          'group flex items-center gap-1.5 rounded-[10px] h-9 pr-2 text-sm cursor-pointer transition-all duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          isActive
            ? 'glass-pill-active text-primary font-medium scale-[1.01]'
            : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
        )}
        style={{ paddingLeft: `${level * 16 + 10}px` }}
        onClick={handleNavigate}
      >
        {enableDrag && (
          <span className="shrink-0 opacity-0 group-hover:opacity-50 cursor-grab active:cursor-grabbing transition-opacity" aria-label="Drag to reorder">
            <GripVertical size={12} />
          </span>
        )}
        {hasChildren ? (
          <button
            onClick={handleToggle}
            className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        ) : (
          <span className="w-[20px] shrink-0" />
        )}
        <FileText size={15} className={cn('shrink-0', isActive ? 'text-primary/80' : 'text-muted-foreground/70')} />
        <span className="truncate text-sm">{node.page.title}</span>
      </div>

      {hasChildren && isExpanded && (
        <div className="relative">
          {/* Indent guide line — click to collapse parent */}
          <button
            type="button"
            onClick={handleToggle}
            className="indent-guide"
            style={{ left: `${level * 16 + 14}px` }}
            aria-label={`Collapse ${node.page.title}`}
            tabIndex={-1}
          />
          {node.children.map((child, idx) => (
            <SidebarTreeNode
              key={child.page.id}
              node={child}
              level={level + 1}
              expandedSet={expandedSet}
              toggleExpand={toggleExpand}
              activePageId={activePageId}
              enableDrag={enableDrag}
              sortableIndex={enableDrag ? idx : undefined}
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
    prev.enableDrag === next.enableDrag &&
    prev.sortableIndex === next.sortableIndex
  );
});

interface SpaceOption {
  key: string;
  name: string;
  pageCount: number;
  source: 'confluence' | 'local';
  homepageId?: string | null;
}

export function SidebarTreeView({ onNavigate }: { onNavigate?: () => void } = {}) {
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
  const { data: treeData, isLoading } = usePageTree({
    spaceKey: treeSidebarSpaceKey,
  });
  const reorderPage = useReorderPage();

  // Merge confluence + local spaces for the selector
  const allSpaces = useMemo<SpaceOption[]>(() => {
    const result: SpaceOption[] = [];
    if (confluenceSpaces) {
      confluenceSpaces.forEach((s) => result.push({
        key: s.key,
        name: s.name,
        pageCount: s.pageCount,
        source: 'confluence',
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

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [spaceDropdownOpen, setSpaceDropdownOpen] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const closeSpaceDropdown = useCallback(() => setSpaceDropdownOpen(false), []);
  const spaceDropdownRef = useClickOutside<HTMLDivElement>(closeSpaceDropdown, spaceDropdownOpen);
  const createPage = useCreatePage();

  const handleCreateFolder = useCallback(async () => {
    const trimmed = newFolderName.trim();
    if (!trimmed) return;

    const spaceKey = treeSidebarSpaceKey || '__local__';
    try {
      await createPage.mutateAsync({
        spaceKey,
        title: trimmed,
        bodyHtml: '',
        pageType: 'page',
      });
      setNewFolderName('');
      setShowNewFolderInput(false);
    } catch {
      // error handled by mutation
    }
  }, [newFolderName, treeSidebarSpaceKey, createPage]);

  useEffect(() => {
    if (showNewFolderInput) {
      newFolderInputRef.current?.focus();
    }
  }, [showNewFolderInput]);

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

  // When a space is scoped to its homepage, keep that homepage expanded so
  // the homepage remains clickable while its immediate children stay visible.
  useEffect(() => {
    if (!homepageId) return;

    setExpandedIds((prev) => {
      if (prev.has(homepageId)) return prev;
      const next = new Set(prev);
      next.add(homepageId);
      return next;
    });
  }, [homepageId]);

  // Auto-select space based on current page
  useEffect(() => {
    if (activePageId && pages.length > 0 && !treeSidebarSpaceKey) {
      const currentPage = pages.find((p) => p.id === activePageId);
      if (currentPage) {
        setTreeSidebarSpaceKey(currentPage.spaceKey);
      }
    }
  }, [activePageId, pages, treeSidebarSpaceKey, setTreeSidebarSpaceKey]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Handle drag end for sortable reordering
  const handleDragEnd = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (event: any) => {
      if (event.canceled) return;
      const source = event.operation?.source;
      if (!source || !isSortable(source)) return;

      // isSortable narrows to SortableDraggable | SortableDroppable
      // Both have `index`; only SortableDraggable has `initialIndex`
      const currentIndex = source.index;
      const startIndex = 'initialIndex' in source ? (source as { initialIndex: number }).initialIndex : currentIndex;
      if (startIndex === currentIndex) return;

      const pageId = String(source.id);
      reorderPage.mutate({ id: pageId, sortOrder: currentIndex });
    },
    [reorderPage],
  );

  // Collapsed rail — nav icons + expand toggle
  if (treeSidebarCollapsed) {
    return (
      <AnimatePresence mode="wait">
        <m.div
          key="collapsed-rail"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: 40, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects ? { duration: 0 } : sidebarSpring}
          className="flex flex-col items-center rounded-xl glass-sidebar overflow-hidden"
        >
          {/* Expand toggle */}
          <button
            onClick={toggleTreeSidebar}
            className="mt-2 rounded-lg p-1.5 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors"
            aria-label="Expand sidebar"
            title="Expand sidebar (,)"
          >
            <PanelLeft size={16} />
          </button>

          {/* Nav icons */}
          <nav className="flex flex-col items-center gap-1 pt-1" aria-label="Main navigation">
            {navItems.map(({ icon: Icon, label, path }) => {
              const active = path === '/'
                ? location.pathname === '/' || location.pathname.startsWith('/pages')
                : location.pathname.startsWith(path);
              return (
                <Link
                  key={path}
                  to={path}
                  onClick={onNavigate}
                  className={cn(
                    'rounded-lg p-1.5 transition-all duration-200 active:scale-[0.95]',
                    active
                      ? 'glass-pill-active text-primary'
                      : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
                  )}
                  title={label}
                  aria-label={label}
                >
                  <Icon size={16} className={cn(active && 'drop-shadow-[0_1px_2px_oklch(from_var(--color-primary)_l_c_h_/_0.3)]')} />
                </Link>
              );
            })}
          </nav>
        </m.div>
      </AnimatePresence>
    );
  }

  // Combine spaces for display, grouped by source
  const confluenceOptions = allSpaces.filter((s) => s.source === 'confluence');
  const localOptions = allSpaces.filter((s) => s.source === 'local');

  return (
    <m.aside
      ref={sidebarRef}
      key="expanded-sidebar"
      initial={reduceEffects ? false : { width: 0, opacity: 0 }}
      animate={{ width: treeSidebarWidth, opacity: 1 }}
      transition={reduceEffects || isResizing ? { duration: 0 } : sidebarSpring}
      className={cn(
        'relative flex flex-col glass-sidebar overflow-hidden',
        isResizing && 'select-none',
      )}
    >
      {/* Nav tabs — main app navigation */}
      <nav className="flex shrink-0 items-center gap-0.5 px-2 pt-2 pb-1" aria-label="Main navigation">
        {navItems.map(({ icon: Icon, label, path }) => {
          const active = path === '/'
            ? location.pathname === '/' || location.pathname.startsWith('/pages')
            : location.pathname.startsWith(path);
          return (
            <Link
              key={path}
              to={path}
              onClick={onNavigate}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-all duration-200 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                active
                  ? 'glass-pill-active text-primary font-medium'
                  : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
              )}
            >
              <Icon size={14} className={cn(active && 'drop-shadow-[0_1px_2px_oklch(from_var(--color-primary)_l_c_h_/_0.3)]')} />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Sidebar header — title + actions + collapse toggle */}
      <div className="flex h-8 shrink-0 items-center justify-between px-3">
        <span className="text-xs font-semibold text-muted-foreground/60">Pages</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setShowNewFolderInput((v) => !v);
              setNewFolderName('');
            }}
            className="rounded-lg p-1 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors"
            aria-label="New Folder"
            title="Create new folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={() => navigate('/spaces/new')}
            className="rounded-lg p-1 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors"
            aria-label="New Space"
            title="Create new space"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={toggleTreeSidebar}
            className="rounded-lg p-1 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors"
            aria-label="Collapse sidebar"
            title="Collapse sidebar (,)"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* Space selector */}
      <div className="px-2 pb-2">
        <div ref={spaceDropdownRef} className="relative">
          <button
            onClick={() => setSpaceDropdownOpen(!spaceDropdownOpen)}
            className="flex w-full items-center justify-between rounded-lg bg-foreground/5 px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/8 transition-colors"
          >
            <span className="flex items-center gap-1.5 truncate">
              {selectedSpaceOption ? (
                <>
                  {selectedSpaceOption.source === 'local'
                    ? <HardDrive size={10} className="shrink-0 text-primary/70" />
                    : <Globe size={10} className="shrink-0 text-muted-foreground/70" />
                  }
                  {selectedSpaceOption.name} ({selectedSpaceOption.key})
                </>
              ) : 'All Spaces'}
            </span>
            <ChevronsUpDown size={12} className="shrink-0 text-muted-foreground" />
          </button>
          {spaceDropdownOpen && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-xl glass-sidebar p-1">
              <button
                onClick={() => {
                  setTreeSidebarSpaceKey(undefined);
                  setSpaceDropdownOpen(false);
                }}
                className={cn(
                  'flex w-full items-center rounded-lg px-2.5 py-1.5 text-xs transition-all duration-200',
                  !treeSidebarSpaceKey ? 'glass-pill-active text-primary font-medium' : 'text-foreground hover:bg-[var(--glass-pill-hover)]',
                )}
              >
                All Spaces
              </button>

              {/* Confluence spaces */}
              {confluenceOptions.length > 0 && (
                <>
                  <div className="px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground/50">
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
                          ? 'glass-pill-active text-primary font-medium'
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
                  <div className="px-2.5 py-1.5 text-[10px] font-semibold text-muted-foreground/50">
                    Local
                  </div>
                  {localOptions.map((space) => (
                    <button
                      key={space.key}
                      onClick={() => {
                        setTreeSidebarSpaceKey(space.key);
                        setSpaceDropdownOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-all duration-200',
                        treeSidebarSpaceKey === space.key
                          ? 'glass-pill-active text-primary font-medium'
                          : 'text-foreground hover:bg-[var(--glass-pill-hover)]',
                      )}
                    >
                      <span className="flex items-center gap-1.5 truncate">
                        <HardDrive size={10} className="shrink-0 text-primary/70" />
                        {space.name}
                      </span>
                      <span className="shrink-0 text-muted-foreground ml-2">{space.pageCount}</span>
                    </button>
                  ))}
                </>
              )}

              {/* Create new space link */}
              <button
                onClick={() => {
                  setSpaceDropdownOpen(false);
                  navigate('/spaces/new');
                }}
                className="flex w-full items-center gap-1.5 border-t border-[var(--glass-sidebar-divider)] mt-1 pt-1 rounded-lg px-2.5 py-1.5 text-xs text-primary hover:bg-[var(--glass-pill-hover)] transition-colors"
              >
                <Plus size={10} />
                New Space
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Divider — subtle glass edge */}
      <div className="mx-3 h-px bg-[var(--glass-sidebar-divider)]" />

      {/* New Folder inline input */}
      {showNewFolderInput && (
        <div className="px-2 py-1.5" data-testid="new-folder-input">
          <div className="flex items-center gap-1.5">
            <FolderPlus size={14} className="shrink-0 text-primary/70" />
            <input
              ref={newFolderInputRef}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFolder();
                if (e.key === 'Escape') {
                  setShowNewFolderInput(false);
                  setNewFolderName('');
                }
              }}
              placeholder="Folder name..."
              className="flex-1 rounded-md bg-foreground/5 px-2 py-1 text-xs text-foreground outline-none ring-1 ring-primary/30 focus:ring-primary/60 transition-colors"
              aria-label="New folder name"
            />
            <button
              onClick={handleCreateFolder}
              disabled={!newFolderName.trim() || createPage.isPending}
              className="rounded-md bg-primary/15 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/25 disabled:opacity-40"
            >
              {createPage.isPending ? '...' : 'Add'}
            </button>
          </div>
        </div>
      )}

      {/* Tree content with drag-and-drop + scroll mask */}
      <div className="flex-1 overflow-y-auto p-2 glass-scroll-mask">
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
                className="mt-3 flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/15 transition-colors"
              >
                <Plus size={12} />
                Sync a Space
              </button>
            )}
          </div>
        ) : isLocalSpace ? (
          <DragDropProvider onDragEnd={handleDragEnd}>
            <div className="space-y-0.5">
              {tree.map((node, idx) => (
                <SidebarTreeNode
                  key={node.page.id}
                  node={node}
                  expandedSet={expandedIds}
                  toggleExpand={toggleExpand}
                  activePageId={activePageId}
                  enableDrag
                  sortableIndex={idx}
                />
              ))}
            </div>
          </DragDropProvider>
        ) : (
          <div className="space-y-0.5">
            {tree.map((node) => (
              <SidebarTreeNode
                key={node.page.id}
                node={node}
                expandedSet={expandedIds}
                toggleExpand={toggleExpand}
                activePageId={activePageId}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer stats */}
      {treeData && (
        <div className="px-3 py-1.5">
          <span className="text-[10px] text-muted-foreground/50">
            {treeData.total} pages{treeSidebarSpaceKey ? ` in ${treeSidebarSpaceKey}` : ''}
          </span>
        </div>
      )}

      {/* Resize handle */}
      <div
        role="separator"
        aria-label="Resize tree sidebar"
        aria-orientation="vertical"
        onMouseDown={handleResizeStart}
        className={cn(
          'absolute right-0 top-2 bottom-2 w-1 cursor-col-resize rounded-full transition-colors hover:bg-primary/40',
          isResizing && 'bg-primary/60',
        )}
      />
    </m.aside>
  );
}
