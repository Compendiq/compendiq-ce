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
} from 'lucide-react';
import { usePageTree } from '../hooks/use-pages';
import { useSpaces } from '../hooks/use-spaces';
import { useUiStore } from '../../stores/ui-store';
import { cn } from '../lib/cn';
import type { PageTreeItem } from '../hooks/use-pages';

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
}

export const SidebarTreeNode = memo(function SidebarTreeNode({
  node,
  level = 0,
  expandedSet,
  toggleExpand,
  activePageId,
}: SidebarTreeNodeProps) {
  const navigate = useNavigate();
  const isExpanded = expandedSet.has(node.page.id);
  const hasChildren = node.children.length > 0;
  const isActive = node.page.id === activePageId;

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
    <div>
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
          {node.children.map((child) => (
            <SidebarTreeNode
              key={child.page.id}
              node={child}
              level={level + 1}
              expandedSet={expandedSet}
              toggleExpand={toggleExpand}
              activePageId={activePageId}
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
    prev.expandedSet === next.expandedSet
  );
});

export function SidebarTreeView() {
  const location = useLocation();
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

  const { data: spaces } = useSpaces();
  const { data: treeData, isLoading } = usePageTree({
    spaceKey: treeSidebarSpaceKey,
  });

  const pages = useMemo(() => treeData?.items ?? [], [treeData]);
  const homepageId = useMemo(
    () => treeSidebarSpaceKey ? spaces?.find((s) => s.key === treeSidebarSpaceKey)?.homepageId : undefined,
    [treeSidebarSpaceKey, spaces],
  );
  const tree = useMemo(() => buildTree(pages, homepageId), [pages, homepageId]);

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

  const selectedSpace = spaces?.find((s) => s.key === treeSidebarSpaceKey);

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
        <button
          onClick={toggleTreeSidebar}
          className="rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          aria-label="Collapse tree sidebar"
        >
          <PanelLeftClose size={14} />
        </button>
      </div>

      {/* Space selector */}
      <div className="border-b border-border/40 p-2">
        <div className="relative">
          <button
            onClick={() => setSpaceDropdownOpen(!spaceDropdownOpen)}
            className="flex w-full items-center justify-between rounded-md bg-foreground/5 px-2.5 py-1.5 text-xs text-foreground hover:bg-foreground/10 transition-colors"
          >
            <span className="truncate">
              {selectedSpace ? `${selectedSpace.name} (${selectedSpace.key})` : 'All Spaces'}
            </span>
            <ChevronsUpDown size={12} className="shrink-0 text-muted-foreground" />
          </button>
          {spaceDropdownOpen && (
            <div className="absolute left-0 right-0 top-full z-50 mt-1 rounded-md border border-border/50 bg-card shadow-xl backdrop-blur-xl">
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
              {spaces?.map((space) => (
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
                  <span className="truncate">{space.name}</span>
                  <span className="shrink-0 text-muted-foreground ml-2">{space.pageCount}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tree content */}
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
