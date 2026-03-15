import { memo, useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  PanelLeftClose,
  PanelLeft,
  ChevronsUpDown,
  GripVertical,
  Plus,
  Globe,
  HardDrive,
} from 'lucide-react';
import { DragDropProvider } from '@dnd-kit/react';
import { useSortable, isSortable } from '@dnd-kit/react/sortable';
import { usePageTree } from '../../hooks/use-pages';
import { useSpaces } from '../../hooks/use-spaces';
import { useLocalSpaces, useReorderPage } from '../../hooks/use-standalone';
import { useUiStore } from '../../../stores/ui-store';
import { cn } from '../../lib/cn';
import type { PageTreeItem } from '../../hooks/use-pages';

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
  // so it remains clickable as a folder/article entry.
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
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const isActive = node.page.id === activePageId;

  // Always call hook (React rules), but only use the ref when DnD is active
  const sortable = useSortable({
    id: node.page.id,
    index: sortableIndex ?? 0,
    disabled: !enableDrag,
  });

  const handleNavigate = useCallback(() => {
    if (hasChildren) toggleExpand(node.page.id);
    navigate(`/pages/${node.page.id}`);
  }, [navigate, node.page.id, hasChildren, toggleExpand]);

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
          'group flex items-center gap-1.5 rounded-md py-1.5 pr-2 text-sm transition-colors cursor-pointer',
          isActive
            ? 'bg-primary/15 text-primary font-medium'
            : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        )}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
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
        {hasChildren
          ? (
            isExpanded || isActive
              ? <FolderOpen size={15} className="shrink-0 text-primary/80" />
              : <Folder size={15} className="shrink-0 text-primary/70" />
            )
          : (
            <FileText size={15} className="shrink-0 text-muted-foreground/70" />
            )}
        <span className="truncate text-sm">{node.page.title}</span>
      </div>

      {hasChildren && isExpanded && (
        <div>
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

export function SidebarTreeView() {
  const location = useLocation();
  const navigate = useNavigate();
  const treeSidebarCollapsed = useUiStore((s) => s.treeSidebarCollapsed);
  const toggleTreeSidebar = useUiStore((s) => s.toggleTreeSidebar);
  const treeSidebarSpaceKey = useUiStore((s) => s.treeSidebarSpaceKey);
  const setTreeSidebarSpaceKey = useUiStore((s) => s.setTreeSidebarSpaceKey);
  const treeSidebarWidth = useUiStore((s) => s.treeSidebarWidth);
  const setTreeSidebarWidth = useUiStore((s) => s.setTreeSidebarWidth);

  // Extract active page ID from pathname (useParams is unavailable here
  // because this component is rendered in AppLayout, outside the inner
  // <Routes> that defines /pages/:id).
  const activePageId = useMemo(() => {
    const match = location.pathname.match(/^\/pages\/([^/]+)$/);
    return match?.[1];
  }, [location.pathname]);

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
  const sidebarRef = useRef<HTMLElement>(null);

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

  if (treeSidebarCollapsed) {
    return (
      <div className="flex w-10 flex-col items-center border-r border-border/40 bg-card/50 backdrop-blur-md">
        <div className="flex h-10 items-center justify-center w-full">
          <button
            onClick={toggleTreeSidebar}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            aria-label="Expand tree sidebar"
          >
            <PanelLeft size={16} />
          </button>
        </div>
      </div>
    );
  }

  // Combine spaces for display, grouped by source
  const confluenceOptions = allSpaces.filter((s) => s.source === 'confluence');
  const localOptions = allSpaces.filter((s) => s.source === 'local');

  return (
    <aside
      ref={sidebarRef}
      className={cn(
        'relative flex flex-col border-r border-border/40 bg-card/50 backdrop-blur-md',
        isResizing && 'select-none',
      )}
      style={{ width: `${treeSidebarWidth}px` }}
    >
      {/* Sidebar header with collapse toggle */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border/40 px-3">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">Pages</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => navigate('/spaces/new')}
            className="rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            aria-label="New Space"
            title="Create new space"
          >
            <Plus size={14} />
          </button>
          <button
            onClick={toggleTreeSidebar}
            className="rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            aria-label="Collapse tree sidebar"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
      </div>

      {/* Space selector */}
      <div className="border-b border-border/40 p-2">
        <div className="relative">
          <button
            onClick={() => setSpaceDropdownOpen(!spaceDropdownOpen)}
            className="flex w-full items-center justify-between rounded-md bg-foreground/5 px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/10 transition-colors"
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
            <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-64 overflow-y-auto rounded-md border border-border/50 bg-card shadow-xl backdrop-blur-xl">
              <button
                onClick={() => {
                  setTreeSidebarSpaceKey(undefined);
                  setSpaceDropdownOpen(false);
                }}
                className={cn(
                  'flex w-full items-center px-2.5 py-1.5 text-xs hover:bg-foreground/5 transition-colors',
                  !treeSidebarSpaceKey ? 'text-primary font-medium' : 'text-foreground',
                )}
              >
                All Spaces
              </button>

              {/* Confluence spaces */}
              {confluenceOptions.length > 0 && (
                <>
                  <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
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
                        'flex w-full items-center justify-between px-2.5 py-1.5 text-xs hover:bg-foreground/5 transition-colors',
                        treeSidebarSpaceKey === space.key
                          ? 'text-primary font-medium'
                          : 'text-foreground',
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
                  <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
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
                        'flex w-full items-center justify-between px-2.5 py-1.5 text-xs hover:bg-foreground/5 transition-colors',
                        treeSidebarSpaceKey === space.key
                          ? 'text-primary font-medium'
                          : 'text-foreground',
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
                className="flex w-full items-center gap-1.5 border-t border-border/30 px-2.5 py-1.5 text-xs text-primary hover:bg-foreground/5 transition-colors"
              >
                <Plus size={10} />
                New Space
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Tree content with drag-and-drop */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {isLoading ? (
          <div className="space-y-1.5 p-2">
            {[...Array(8)].map((_, i) => (
              <div
                key={i}
                className="h-6 animate-pulse rounded bg-foreground/5"
                style={{ width: `${60 + Math.random() * 30}%`, marginLeft: `${(i % 3) * 16}px` }}
              />
            ))}
          </div>
        ) : tree.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            {treeSidebarSpaceKey ? 'No pages in this space.' : 'No pages synced yet.'}
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
        <div className="border-t border-border/40 px-3 py-1.5">
          <span className="text-[10px] text-muted-foreground">
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
          'absolute right-0 top-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-primary/40',
          isResizing && 'bg-primary/60',
        )}
      />
    </aside>
  );
}
