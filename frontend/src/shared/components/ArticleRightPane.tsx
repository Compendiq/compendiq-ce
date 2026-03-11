import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  ExternalLink,
  FileText,
  FolderOpen,
  ListTree,
  PanelRight,
  PanelRightClose,
  Pin,
  Trash2,
  Wand2,
} from 'lucide-react';
import { FreshnessBadge } from './FreshnessBadge';
import { EmbeddingStatusBadge } from './EmbeddingStatusBadge';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { useUiStore } from '../../stores/ui-store';
import { useArticleViewStore } from '../../stores/article-view-store';
import {
  useDeletePage,
  usePage,
  usePinnedPages,
  usePinPage,
  useUnpinPage,
} from '../hooks/use-pages';
import { useSettings } from '../hooks/use-settings';
import { cn } from '../lib/cn';
import type { TocHeading } from './TableOfContents';

// ---------- Outline tree helpers ----------

interface OutlineNode {
  heading: TocHeading;
  children: OutlineNode[];
}

function buildOutlineTree(headings: TocHeading[]): OutlineNode[] {
  const root: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const heading of headings) {
    const node: OutlineNode = { heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].heading.level >= heading.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  return root;
}

function findAncestorIds(nodes: OutlineNode[], targetId: string): string[] | null {
  for (const node of nodes) {
    if (node.heading.id === targetId) return [];
    const result = findAncestorIds(node.children, targetId);
    if (result !== null) return [node.heading.id, ...result];
  }
  return null;
}

function readCollapsedIds(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

// ---------- OutlineNode component ----------

interface OutlineNodeItemProps {
  node: OutlineNode;
  activeId: string | null;
  collapsedIds: Set<string>;
  onNavigate: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
  level?: number;
}

const OutlineNodeItem = memo(function OutlineNodeItem({
  node,
  activeId,
  collapsedIds,
  onNavigate,
  onToggleCollapsed,
  level = 0,
}: OutlineNodeItemProps) {
  const { heading, children } = node;
  const hasChildren = children.length > 0;
  const isOpen = !collapsedIds.has(heading.id);
  const isActive = activeId === heading.id;

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
        onClick={() => onNavigate(heading.id)}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapsed(heading.id);
            }}
            className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
            aria-label={isOpen ? 'Collapse section' : 'Expand section'}
          >
            {isOpen ? (
              <ChevronRight size={14} className="rotate-90 transition-transform duration-150" />
            ) : (
              <ChevronRight size={14} className="transition-transform duration-150" />
            )}
          </button>
        ) : (
          <span className="w-[20px] shrink-0" />
        )}
        <ListTree size={15} className="shrink-0 text-muted-foreground/70" />
        <span className="truncate text-sm">{heading.text}</span>
      </div>

      {hasChildren && isOpen && (
        <div>
          {children.map((child) => (
            <OutlineNodeItem
              key={child.heading.id}
              node={child}
              activeId={activeId}
              collapsedIds={collapsedIds}
              onNavigate={onNavigate}
              onToggleCollapsed={onToggleCollapsed}
              level={level + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
});

// ---------- ArticleRightPane ----------

export function ArticleRightPane() {
  const location = useLocation();
  const navigate = useNavigate();

  // Extract page ID from pathname instead of useParams, because this component
  // is rendered in AppLayout (outer Route) where descendant route params like
  // :id from /pages/:id are not available via useParams.
  const id = useMemo(() => {
    const match = location.pathname.match(/^\/pages\/([^/]+)$/);
    return match?.[1];
  }, [location.pathname]);

  const collapsed = useUiStore((s) => s.articleSidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleArticleSidebar);
  const width = useUiStore((s) => s.articleSidebarWidth);
  const setWidth = useUiStore((s) => s.setArticleSidebarWidth);

  const headings = useArticleViewStore((s) => s.headings);
  const editing = useArticleViewStore((s) => s.editing);

  const { data: page } = usePage(id);
  const { data: pinnedData } = usePinnedPages();
  const { data: settings } = useSettings();
  const deleteMutation = useDeletePage();
  const pinMutation = usePinPage();
  const unpinMutation = useUnpinPage();

  const isPinned = pinnedData?.items.some((item) => item.id === id) ?? false;

  const storageKey = `article-outline-collapsed-${id ?? 'default'}`;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState(() => readCollapsedIds(storageKey));
  const [readingProgress, setReadingProgress] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);

  const tree = useMemo(() => buildOutlineTree(headings), [headings]);

  // Persist collapsed section IDs
  useEffect(() => {
    setCollapsedIds(readCollapsedIds(storageKey));
  }, [storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...collapsedIds]));
    } catch {
      // Ignore storage write failures.
    }
  }, [collapsedIds, storageKey]);

  // IntersectionObserver to track active heading
  useEffect(() => {
    if (headings.length === 0) return;

    const scrollRoot = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (!scrollRoot) return;

    const headingElements = headings
      .map((h) => document.getElementById(h.id))
      .filter(Boolean) as HTMLElement[];

    if (headingElements.length === 0) return;

    observerRef.current?.disconnect();
    observerRef.current = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];

        if (visible?.target?.id) {
          setActiveId(visible.target.id);
        }
      },
      {
        root: scrollRoot,
        rootMargin: '-12% 0% -72% 0%',
        threshold: [0, 1],
      },
    );

    headingElements.forEach((el) => observerRef.current?.observe(el));
    return () => observerRef.current?.disconnect();
  }, [headings]);

  // Auto-expand ancestors of active heading
  useEffect(() => {
    const ancestorIds = activeId ? findAncestorIds(tree, activeId) : null;
    if (!ancestorIds || ancestorIds.length === 0) return;

    setCollapsedIds((prev) => {
      if (!ancestorIds.some((anc) => prev.has(anc))) return prev;
      const next = new Set(prev);
      ancestorIds.forEach((anc) => next.delete(anc));
      return next;
    });
  }, [activeId, tree]);

  // Reading progress
  useEffect(() => {
    const scrollRoot = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    if (!scrollRoot) return;

    const updateProgress = () => {
      const scrollHeight = scrollRoot.scrollHeight - scrollRoot.clientHeight;
      if (scrollHeight <= 0) {
        setReadingProgress(0);
        return;
      }
      setReadingProgress(Math.min(100, (scrollRoot.scrollTop / scrollHeight) * 100));
    };

    updateProgress();
    scrollRoot.addEventListener('scroll', updateProgress, { passive: true });
    return () => scrollRoot.removeEventListener('scroll', updateProgress);
  }, []);

  const handleToggleCollapsed = useCallback((headingId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(headingId)) {
        next.delete(headingId);
      } else {
        next.add(headingId);
      }
      return next;
    });
  }, []);

  const handleNavigate = useCallback((headingId: string) => {
    const scrollRoot = document.querySelector('[data-scroll-container]') as HTMLElement | null;
    const target = document.getElementById(headingId);
    if (!scrollRoot || !target) return;

    const targetRect = target.getBoundingClientRect();
    const rootRect = scrollRoot.getBoundingClientRect();
    const top = scrollRoot.scrollTop + targetRect.top - rootRect.top - 24;

    scrollRoot.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
    setActiveId(headingId);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = width;

      function onMouseMove(ev: MouseEvent) {
        // Dragging left = increasing width (opposite of left sidebar)
        const newWidth = startWidth - (ev.clientX - startX);
        setWidth(newWidth);
      }

      function onMouseUp() {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width, setWidth],
  );

  const handlePinToggle = useCallback(() => {
    if (!id || !page) return;
    const mutation = isPinned ? unpinMutation : pinMutation;
    mutation.mutate(id, {
      onSuccess: () => toast.success(isPinned ? 'Unpinned.' : 'Pinned.'),
      onError: (error) => toast.error(error instanceof Error ? error.message : 'Pin update failed.'),
    });
  }, [id, isPinned, page, pinMutation, unpinMutation]);

  const handleDelete = useCallback(async () => {
    if (!id || !window.confirm('Delete this article? This cannot be undone.')) return;
    try {
      await deleteMutation.mutateAsync(id);
      navigate('/');
      toast.success('Article deleted.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete article.');
    }
  }, [deleteMutation, id, navigate]);

  if (!id) return null;

  if (collapsed) {
    return (
      <div
        className="flex w-10 flex-col items-center border-l border-border/40 bg-card/50 backdrop-blur-md"
        data-testid="article-right-pane-rail"
      >
        <div className="flex h-12 w-full items-center justify-center border-b border-border/40">
          <button
            onClick={toggleSidebar}
            className="rounded-md p-1.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            aria-label="Expand article sidebar"
          >
            <PanelRight size={16} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <aside
      ref={sidebarRef}
      className={cn(
        'relative flex flex-col border-l border-border/40 bg-card/50 backdrop-blur-md',
        isResizing && 'select-none',
      )}
      style={{ width: `${width}px` }}
      data-testid="article-right-pane"
    >
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/40 px-3">
        <span className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">Properties</span>
        <button
          onClick={toggleSidebar}
          className="rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          aria-label="Collapse article sidebar"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      {/* Action buttons */}
      {!editing && page && (
        <div className="border-b border-border/40 p-2 space-y-0.5" data-testid="article-actions">
          <button
            onClick={() => navigate(`/ai?mode=improve&pageId=${encodeURIComponent(id)}`)}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          >
            <Wand2 size={15} className="shrink-0" />
            <span className="truncate">AI Improve</span>
          </button>

          <button
            onClick={handlePinToggle}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              isPinned
                ? 'text-primary font-medium bg-primary/8 hover:bg-primary/12'
                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            <Pin size={15} className={cn('shrink-0', isPinned && 'fill-current')} />
            <span className="truncate">{isPinned ? 'Pinned' : 'Pin'}</span>
          </button>

          {settings?.confluenceUrl && (
            <a
              href={`${settings.confluenceUrl}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`}
              target="_blank"
              rel="noreferrer"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <ExternalLink size={15} className="shrink-0" />
              <span className="truncate">Open in Confluence</span>
            </a>
          )}

          <button
            onClick={handleDelete}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-destructive/80 transition-colors hover:bg-destructive/8 hover:text-destructive"
          >
            <Trash2 size={15} className="shrink-0" />
            <span className="truncate">Delete</span>
          </button>
        </div>
      )}

      {/* Properties section — mirrors Notion's properties panel */}
      {page && !editing && (
        <div className="border-b border-border/40 px-3 py-3">
          <div className="space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <span className="shrink-0 text-xs text-muted-foreground/70">Space</span>
              <span className="text-right text-xs text-foreground/80">{page.spaceKey}</span>
            </div>
            <div className="flex items-start justify-between gap-2">
              <span className="shrink-0 text-xs text-muted-foreground/70">Type</span>
              <span className="flex items-center gap-1 text-right text-xs text-foreground/80">
                {page.hasChildren
                  ? <><FolderOpen size={11} className="shrink-0 text-muted-foreground/60" /> Folder</>
                  : <><FileText size={11} className="shrink-0 text-muted-foreground/60" /> Article</>}
              </span>
            </div>
            {page.author && (
              <div className="flex items-start justify-between gap-2">
                <span className="shrink-0 text-xs text-muted-foreground/70">Author</span>
                <span className="max-w-[110px] truncate text-right text-xs text-foreground/80">{page.author}</span>
              </div>
            )}
            <div className="flex items-start justify-between gap-2">
              <span className="shrink-0 text-xs text-muted-foreground/70">Version</span>
              <span className="text-right text-xs text-foreground/80">v{page.version}</span>
            </div>
            {page.lastModifiedAt && (
              <div className="flex items-start justify-between gap-2">
                <span className="shrink-0 text-xs text-muted-foreground/70">Modified</span>
                <FreshnessBadge lastModified={page.lastModifiedAt} />
              </div>
            )}
            <div className="flex items-start justify-between gap-2">
              <span className="shrink-0 text-xs text-muted-foreground/70">AI Index</span>
              <EmbeddingStatusBadge
                embeddingStatus={page.embeddingStatus}
                embeddingDirty={page.embeddingDirty}
                embeddedAt={page.embeddedAt}
                embeddingError={page.embeddingError}
              />
            </div>
          </div>
          {page.labels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 pt-1">
              {page.labels.map((label) => (
                <span
                  key={label}
                  className="rounded border border-border/40 bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Outline header + progress */}
      {headings.length > 0 && (
        <div className="border-b border-border/40 px-3 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
              <ListTree size={13} />
              Outline
            </div>
            <span className="text-[10px] text-muted-foreground">
              {headings.length} section{headings.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/8">
            <m.div
              className="h-full rounded-full bg-primary"
              style={{ width: `${readingProgress}%` }}
              transition={{ duration: 0.12 }}
            />
          </div>
        </div>
      )}

      {/* Outline tree */}
      <div className="flex-1 overflow-y-auto p-1.5" data-testid="article-outline-tree">
        {headings.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted-foreground">
            No headings in this article.
          </div>
        ) : (
          <div className="space-y-0.5">
            {tree.map((node) => (
              <OutlineNodeItem
                key={node.heading.id}
                node={node}
                activeId={activeId}
                collapsedIds={collapsedIds}
                onNavigate={handleNavigate}
                onToggleCollapsed={handleToggleCollapsed}
              />
            ))}
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        role="separator"
        aria-label="Resize article sidebar"
        aria-orientation="vertical"
        onMouseDown={handleResizeStart}
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 cursor-col-resize transition-colors hover:bg-primary/40',
          isResizing && 'bg-primary/60',
        )}
      />
    </aside>
  );
}
