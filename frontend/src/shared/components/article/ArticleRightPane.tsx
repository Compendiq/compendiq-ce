import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  Cpu,
  ExternalLink,
  FileText,
  FolderOpen,
  Gauge,
  ListTree,
  PanelRight,
  PanelRightClose,
  Pin,
  FileDown,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  History,
} from 'lucide-react';
import { AutoTagger } from '../../../features/pages/AutoTagger';
import { DockPanel } from '../../../features/ai/dock/DockPanel';
import { VersionHistory } from '../../../features/pages/VersionHistory';
import { FreshnessBadge } from '../badges/FreshnessBadge';
import { EmbeddingStatusBadge } from '../badges/EmbeddingStatusBadge';
import { QualityScoreBadge } from '../badges/QualityScoreBadge';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { getShortcutHint, formatKeysForPlatform } from '../../lib/shortcut-registry';
import { isMac as detectMac } from '../../lib/platform';
import { toast } from 'sonner';
import { useUiStore } from '../../../stores/ui-store';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useIsDockWideLayout } from '../../hooks/use-media-query';
import {
  useDeletePage,
  usePage,
  usePinnedPages,
  usePinPage,
  useReembedPage,
  useRequalityPage,
  useResyncPage,
  useUnpinPage,
} from '../../hooks/use-pages';
import { useQuery } from '@tanstack/react-query';
import { useExportPdf } from '../../hooks/use-standalone';
import { useSettings } from '../../hooks/use-settings';
import { apiFetch } from '../../lib/api';
import { cn } from '../../lib/cn';
import { ConfirmDialog } from '../ConfirmDialog';
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
    while (stack.length > 0 && stack[stack.length - 1]!.heading.level >= heading.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1]!.children.push(node);
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

const sidebarSpring = { type: 'spring' as const, stiffness: 400, damping: 30 };

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
        // #880: make the outline row a real keyboard-operable widget.
        // role="treeitem" (not "button") because the collapse chevron is a
        // nested <button>. Enter/Space jump to the heading.
        role="treeitem"
        tabIndex={0}
        aria-expanded={hasChildren ? isOpen : undefined}
        className={cn(
          'group flex items-center gap-1.5 rounded-[10px] h-9 pr-2 text-sm cursor-pointer transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          isActive
            ? 'nav-selection font-medium'
            : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
        )}
        style={{ paddingLeft: `${level * 16 + 8}px` }}
        onClick={() => onNavigate(heading.id)}
        onKeyDown={(e) => {
          // Ignore keydown bubbling up from the nested chevron button so the
          // row doesn't double-activate when the chevron is focused.
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); // Space would otherwise scroll the page
            onNavigate(heading.id);
          }
        }}
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
        <ListTree size={15} className={cn('shrink-0 opacity-70', isActive && 'text-primary-ink opacity-100')} />
        <span className="truncate text-sm">{heading.text}</span>
      </div>

      {hasChildren && isOpen && (
        // #880: role="group" gives the nested treeitem rows a valid ARIA
        // required-parent (a treeitem must be owned by a tree or group).
        <div role="group">
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

/**
 * `assistant` joins the inspector's views (owner decision, 2026-08-06),
 * superseding #1126's third-column dock on desktop.
 *
 * The dock was a separate column beside this pane, opened by a trigger with its
 * own animation. It is now the FIRST tab in this control, and switching to it
 * is the same instant switch as Outline <-> Details — one pane, three views,
 * one interaction. The old arrangement asked the user to learn two different
 * things about the same right-hand edge.
 *
 * Below `md` the assistant is still `AiDockSheet` (a bottom sheet), because
 * this pane does not render at all there — see AppLayout.
 */
export type InspectorView = 'assistant' | 'outline' | 'details';

export interface InspectorViewRequest {
  view: InspectorView;
  requestId: number;
}

export function ArticleRightPane({
  inspectorViewRequest,
}: {
  inspectorViewRequest?: InspectorViewRequest | null;
} = {}) {
  const location = useLocation();
  const navigate = useNavigate();

  // Extract page ID from pathname instead of useParams, because this component
  // is rendered in AppLayout (outer Route) where descendant route params like
  // :id from /pages/:id are not available via useParams.
  const id = useMemo(() => {
    const match = location.pathname.match(/^\/pages\/([^/]+)$/);
    return match?.[1];
  }, [location.pathname]);

  const userCollapsed = useUiStore((s) => s.articleSidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleArticleSidebar);
  const width = useUiStore((s) => s.articleSidebarWidth);
  const setWidth = useUiStore((s) => s.setArticleSidebarWidth);
  const reduceEffects = useReducedMotion();

  // `collapsed` is the user's preference and nothing else now.
  //
  // #1126 ORed `dockOpen` in, because the assistant was a third column and this
  // pane had to fall back to its 40px rail to make room. The assistant is a tab
  // *inside* this pane now, so there is nothing to make room for — and leaving
  // the OR in place was actively harmful. `openDock()` is still raised by Alt+I
  // and the AI preset; `AppLayout` consumes it above `md` and re-expresses it as
  // a tab request, but effects run after commit, so `open` is true for a frame
  // and this pane starts collapsing.
  //
  // It does not cost one frame, because the width is a framer spring: sampling
  // per rAF across the keystroke, the pane ran 280 → 1 → back to 280 over ~30
  // frames, overshooting to 288 on the way. Half a second of the panel slamming
  // shut and springing open on the shortcut that exists to open it.
  //
  // Below `md` the flag still means the bottom sheet, and the guard further down
  // (`dockOpen && !dockLayoutIsWide`) unmounts the pane for it — which is also
  // why the OR is not needed for that case either.
  const dockOpen = useAiDockStore((s) => s.open);
  const dockLayoutIsWide = useIsDockWideLayout();
  const collapsed = userCollapsed;
  const handleExpandSidebar = useCallback(() => {
    toggleSidebar();
  }, [toggleSidebar]);

  const headings = useArticleViewStore((s) => s.headings);
  const editing = useArticleViewStore((s) => s.editing);

  const { data: page } = usePage(id);
  const { data: pinnedData } = usePinnedPages();
  const { data: settings } = useSettings();
  const deleteMutation = useDeletePage();
  const pinMutation = usePinPage();
  const unpinMutation = useUnpinPage();
  const resyncMutation = useResyncPage();
  const reembedMutation = useReembedPage();
  const requalityMutation = useRequalityPage();

  const isPinned = pinnedData?.items.some((item) => item.id === id) ?? false;

  // #718: gate the Auto-tag button on the NEW provider source, not the removed
  // legacy settings.llmProvider/ollamaModel/openaiModel fields (ADR-021 / migration
  // 054). The backend resolves the auto_tag use-case itself; we only hide the button
  // when we positively know no provider can serve auto-tag. Default to VISIBLE while
  // the query is in flight so the button never flickers out on load.
  const autoTagDefaultQuery = useQuery<{ model?: string | null }>({
    queryKey: ['llm', 'usecase-default', 'auto_tag'],
    queryFn: () => apiFetch('/llm/usecase-default?usecase=auto_tag'),
    retry: false,
    staleTime: 30_000,
  });
  const aiAutoTagAvailable =
    autoTagDefaultQuery.isLoading || Boolean(autoTagDefaultQuery.data?.model);

  // PDF export
  const exportPdf = useExportPdf();
  const handleExportPdf = useCallback(async () => {
    if (!id) return;
    try {
      const blob = await exportPdf.mutateAsync(parseInt(id, 10));
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${page?.title?.replace(/[^a-zA-Z0-9-_ ]/g, '').replace(/\s+/g, '-').toLowerCase() ?? 'page'}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'PDF export failed';
      toast.error(msg.includes('Chromium') ? 'PDF generation unavailable — Chromium not installed on the server' : msg);
    }
  }, [id, page?.title, exportPdf]);

  const storageKey = `article-outline-collapsed-${id ?? 'default'}`;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState(() => readCollapsedIds(storageKey));
  const [readingProgress, setReadingProgress] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const [confirmTrashOpen, setConfirmTrashOpen] = useState(false);
  const [activeInspectorView, setActiveInspectorView] = useState<InspectorView>(() =>
    headings.length > 0 ? 'outline' : 'details',
  );
  const inspectorViewTouchedRef = useRef(false);
  const previousInspectorPageIdRef = useRef(id);
  // Collapsing this pane drops the outline entirely — the rail carries actions
  // only. The flyout is what keeps the outline reachable at 40px (#1126).
  const [outlineFlyoutOpen, setOutlineFlyoutOpen] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  // Escape dismisses the flyout and returns focus to its trigger — which would
  // land on the trigger's focus-to-open handler and reopen what was just
  // dismissed. Set across that one handoff and cleared as soon as focus or the
  // pointer moves on.
  const suppressFlyoutReopenRef = useRef(false);

  const tree = useMemo(() => buildOutlineTree(headings), [headings]);

  // A page with headings opens on its reading outline; a heading-free page
  // opens on details instead of presenting a dead-end. Do not steal the view
  // back if the user already chose a tab while headings were still loading.
  useEffect(() => {
    if (previousInspectorPageIdRef.current !== id) {
      previousInspectorPageIdRef.current = id;
      inspectorViewTouchedRef.current = false;
      // `headings` still belongs to the previous page during this render.
      // Start from Details until the destination publishes its own structure.
      setActiveInspectorView('details');
      return;
    }
    if (!inspectorViewTouchedRef.current) {
      setActiveInspectorView(headings.length > 0 ? 'outline' : 'details');
    }
  }, [headings.length, id]);

  // Layout presets are explicit user commands, so they take precedence over
  // the content-derived default and mark the view as intentionally chosen.
  useEffect(() => {
    if (!inspectorViewRequest) return;
    inspectorViewTouchedRef.current = true;
    setActiveInspectorView(inspectorViewRequest.view);
  }, [inspectorViewRequest]);

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

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setWidth(width + 16);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setWidth(width - 16);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setWidth(360);
      }
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

  // Deleting soft-deletes into the 30-day trash, so the confirm copy must
  // not claim the action "cannot be undone". ConfirmDialog replaces the
  // native confirm() to match the neumorphic design system. Same flow
  // and copy as PageViewPage's Alt+Shift+D shortcut.
  const handleDelete = useCallback(() => {
    if (!id) return;
    setConfirmTrashOpen(true);
  }, [id]);

  const handleConfirmMoveToTrash = useCallback(async () => {
    if (!id) return;
    setConfirmTrashOpen(false);
    try {
      await deleteMutation.mutateAsync(id);
      navigate('/');
      toast.success('Page moved to trash.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to move page to trash.');
    }
  }, [deleteMutation, id, navigate]);

  // Re-sync this article from Confluence. Calls the /pages/bulk/sync endpoint
  // with a singleton ID; the bulk route already does the right per-page
  // validation (auth, ownership, queue gating).
  //
  // The bulk endpoint can return `{succeeded: 0, failed: 0, errors: []}` when
  // the page silently no-ops (e.g. confluenceId became null between render
  // and click, or the user lost access mid-session). Treat that case as info,
  // not an error — there's nothing wrong, just nothing to do.
  const handleResync = useCallback(() => {
    if (!id) return;
    resyncMutation.mutate(id, {
      onSuccess: (data) => {
        if (data.succeeded > 0) {
          toast.success('Re-synced from Confluence.');
        } else if (data.failed > 0 || data.errors.length > 0) {
          toast.error(data.errors[0] ?? 'Re-sync failed.');
        } else {
          toast.info('Nothing to re-sync.');
        }
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : 'Re-sync failed.'),
    });
  }, [id, resyncMutation]);

  // Re-run quality analysis for this article. Bulk-endpoint passthrough; the
  // route resets quality_status to 'pending' and kicks the worker. The trigger
  // is lock-guarded — if a batch is already running, this re-queue is picked up
  // on the next interval tick (QUALITY_CHECK_INTERVAL_MINUTES, default 60min).
  // Same silent-no-op handling as Re-sync / Re-embed.
  const handleRequality = useCallback(() => {
    if (!id) return;
    requalityMutation.mutate(id, {
      onSuccess: (data) => {
        if (data.succeeded > 0) {
          toast.success('Quality re-check queued.');
        } else if (data.failed > 0 || data.errors.length > 0) {
          toast.error(data.errors[0] ?? 'Quality re-check failed.');
        } else {
          toast.info('Nothing to re-check.');
        }
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : 'Quality re-check failed.'),
    });
  }, [id, requalityMutation]);

  // Re-embed this article for RAG. Same bulk-endpoint passthrough as resync.
  // Same silent-no-op handling as Re-sync (see comment above).
  const handleReembed = useCallback(() => {
    if (!id) return;
    reembedMutation.mutate(id, {
      onSuccess: (data) => {
        if (data.succeeded > 0) {
          toast.success('Queued for re-embedding.');
        } else if (data.failed > 0 || data.errors.length > 0) {
          toast.error(data.errors[0] ?? 'Re-embed failed.');
        } else {
          toast.info('Nothing to re-embed.');
        }
      },
      onError: (err) => {
        const message = err instanceof Error ? err.message : 'Re-embed failed.';
        if (message.includes('already in progress')) {
          toast.info('Embedding is already in progress. Please wait for it to finish.');
        } else {
          toast.error(message);
        }
      },
    });
  }, [id, reembedMutation]);

  if (!id) return null;

  // Below the wide breakpoint a 40px rail plus a ~420px dock starves the
  // article, so the rail steps aside entirely and the assistant owns the right
  // side of the pane (#1126). Above it, both fit and both stay.
  if (dockOpen && !dockLayoutIsWide) return null;

  // Shared between the collapsed-rail and expanded returns — Radix portals
  // the dialog to <body>, so its position in the tree only matters for state.
  const confirmTrashDialog = (
    <ConfirmDialog
      open={confirmTrashOpen}
      title="Move page to trash?"
      description="It can be restored from Trash for 30 days, then it is permanently deleted."
      confirmLabel="Move to trash"
      destructive
      onConfirm={handleConfirmMoveToTrash}
      onCancel={() => setConfirmTrashOpen(false)}
    />
  );

  // Collapsed rail — glass pill style
  if (collapsed) {
    const railIconBtn =
      'rounded-lg p-1.5 text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
    return (
      <>
      {/* Positioning context for the outline flyout. `mouseleave` fires on DOM
          ancestry, not geometry, so the absolutely-positioned flyout counts as
          inside this wrapper and the pointer can travel into it without the
          panel closing underneath — WCAG 1.4.13's "hoverable" requirement. */}
      <div
        className="relative flex shrink-0"
        onMouseLeave={() => {
          suppressFlyoutReopenRef.current = false;
          setOutlineFlyoutOpen(false);
        }}
        onBlur={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          suppressFlyoutReopenRef.current = false;
          setOutlineFlyoutOpen(false);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !outlineFlyoutOpen) return;
          // Dismissible (WCAG 1.4.13). Stopped here so the same Escape does not
          // also reach the document listener and exit the article's edit mode.
          e.stopPropagation();
          suppressFlyoutReopenRef.current = true;
          setOutlineFlyoutOpen(false);
          outlineTriggerRef.current?.focus();
        }}
      >
      <AnimatePresence mode="wait">
        <m.div
          key="collapsed-rail"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: 40, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects ? { duration: 0 } : sidebarSpring}
          className="app-sidebar flex flex-col items-center border-l overflow-hidden"
          data-testid="article-right-pane-rail"
        >
          {/* The shortcut lives in the tooltip (and the title below), not glued
              to the icon. A one-character hint like "." rendered as a bordered
              chip beside a rail icon reads as stray punctuation rather than a
              key — worst of all in the 40px collapsed rail, where it is the
              only other mark on screen. The `title` already carries it, so
              nothing is lost for a mouse user, and `aria-label` for everyone
              else. */}
          <div className="flex h-12 w-full flex-col items-center justify-center">
            <button
              onClick={handleExpandSidebar}
              className={railIconBtn}
              aria-label="Expand page sidebar"
              title="Expand sidebar (.)"
            >
              <PanelRight size={16} />
            </button>
          </div>

          {/* Outline flyout trigger. Hover OR focus opens it — a hover-only
              reveal would put the outline out of reach of the keyboard
              entirely (WCAG 2.4.7), and click toggles it for touch. */}
          {headings.length > 0 && (
            <>
              <div className="my-1 h-px w-6 bg-[var(--glass-sidebar-divider)]" />
              <button
                ref={outlineTriggerRef}
                onMouseEnter={() => {
                  suppressFlyoutReopenRef.current = false;
                  setOutlineFlyoutOpen(true);
                }}
                onFocus={() => {
                  if (suppressFlyoutReopenRef.current) return;
                  setOutlineFlyoutOpen(true);
                }}
                onBlur={() => {
                  suppressFlyoutReopenRef.current = false;
                }}
                onClick={() => {
                  suppressFlyoutReopenRef.current = false;
                  setOutlineFlyoutOpen((v) => !v);
                }}
                className={cn(railIconBtn, outlineFlyoutOpen && 'nm-pill-active text-action')}
                aria-label="Article outline"
                aria-expanded={outlineFlyoutOpen}
                aria-controls="article-outline-flyout"
                title={`Article outline — ${headings.length} section${headings.length === 1 ? '' : 's'}`}
                data-testid="article-outline-rail-btn"
              >
                <ListTree size={16} />
              </button>
            </>
          )}

          {!editing && page && (
            <>
              <div className="my-1 h-px w-6 bg-[var(--glass-sidebar-divider)]" />
              {/* min-h-0 + overflow-y-auto so the action stack scrolls on
                  short viewports — without this, the outer overflow-hidden on
                  the rail would clip the bottom buttons (e.g. Delete). */}
              <div
                className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto p-1"
                data-testid="article-actions-rail"
              >
                <button
                  // #1126: opens the assistant beside the document instead of
                  // navigating to /ai and losing sight of the page. This is also
                  // where the dock's focus restore lands when the trigger the
                  // user pressed was destroyed by opening the dock — this one
                  // survives every post-open state at >= 1100px.
                  // #1176: opening is all it does. It used to start a full-page
                  // rewrite on the same click, which is why it was called "AI
                  // Improve" and drew a wand.
                  // Expands the pane onto its Assistant tab. This used to call
                  // `openDock()`, which after the tab move opened a column that
                  // no longer renders — a live control that silently did
                  // nothing.
                  onClick={() => {
                    inspectorViewTouchedRef.current = true;
                    setActiveInspectorView('assistant');
                    handleExpandSidebar();
                  }}
                  className={railIconBtn}
                  aria-label="AI Assistant"
                  title={`AI Assistant (${formatKeysForPlatform(getShortcutHint('ai-assistant') ?? '', detectMac())})`}
                  data-testid="article-assistant-rail-btn"
                  data-ai-assistant-trigger
                >
                  <Sparkles size={16} />
                </button>

                {aiAutoTagAvailable && id && (
                  <AutoTagger
                    pageId={id}
                    currentLabels={page?.labels ?? []}
                    className={`${railIconBtn} [&>span]:hidden`}
                  />
                )}

                <button
                  onClick={handleExportPdf}
                  disabled={exportPdf.isPending}
                  className={railIconBtn}
                  aria-label="Export PDF"
                  title="Export as PDF"
                >
                  {exportPdf.isPending ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <FileDown size={16} />
                  )}
                </button>

                <button
                  onClick={handlePinToggle}
                  className={cn(
                    'rounded-lg p-1.5 transition-colors',
                    isPinned
                      ? 'nm-pill-active text-action'
                      : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
                  )}
                  aria-label={isPinned ? 'Unpin' : 'Pin'}
                  title={`${isPinned ? 'Unpin' : 'Pin'} (${formatKeysForPlatform(getShortcutHint('pin-page') ?? '', detectMac())})`}
                >
                  <Pin size={16} className={cn(isPinned && 'fill-current')} />
                </button>

                {settings?.confluenceUrl && page.confluenceId && (
                  <a
                    href={`${settings.confluenceUrl.replace(/\/+$/, '')}/pages/viewpage.action?pageId=${encodeURIComponent(page.confluenceId)}`}
                    target="_blank"
                    rel="noreferrer"
                    className={railIconBtn}
                    aria-label="Open in Confluence"
                    title="Open in Confluence"
                  >
                    <ExternalLink size={16} />
                  </a>
                )}

                {page.confluenceId && (
                  <button
                    onClick={handleResync}
                    disabled={resyncMutation.isPending}
                    className={railIconBtn}
                    aria-label="Re-sync from Confluence"
                    title="Re-sync from Confluence"
                    data-testid="article-resync-rail-btn"
                  >
                    <RefreshCw size={16} className={cn(resyncMutation.isPending && 'animate-spin')} />
                  </button>
                )}

                <button
                  onClick={handleReembed}
                  disabled={reembedMutation.isPending}
                  className={railIconBtn}
                  aria-label="Re-embed for RAG"
                  title="Re-embed for RAG"
                  data-testid="article-reembed-rail-btn"
                >
                  {reembedMutation.isPending ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Cpu size={16} />
                  )}
                </button>

                <button
                  onClick={handleRequality}
                  disabled={requalityMutation.isPending}
                  className={railIconBtn}
                  aria-label="Re-check quality"
                  title="Re-check quality"
                  data-testid="article-requality-rail-btn"
                >
                  {requalityMutation.isPending ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Gauge size={16} />
                  )}
                </button>

                {/* Delete is deliberately NOT on the collapsed rail. Expanded,
                    it sits behind a "Danger zone" disclosure and then a confirm
                    dialog; collapsing the pane used to PROMOTE it to a
                    top-level icon in a column of ten unlabelled glyphs, so the
                    safety around deleting a page became a function of a layout
                    preference. It stays reachable by expanding the pane, from
                    the page's own actions, and by its shortcut — none of which
                    is a stray click away in an icon rail. */}
              </div>
            </>
          )}
        </m.div>
      </AnimatePresence>

      {/* Outline flyout — opens leftward, over the article. `nm-card-elevated`
          is the sanctioned floating-panel surface and is already listed in the
          `forced-colors: active` block, so the panel keeps a real edge in high
          contrast where its shadow is dropped. */}
      <AnimatePresence>
        {outlineFlyoutOpen && headings.length > 0 && (
          <m.div
            id="article-outline-flyout"
            key="outline-flyout"
            initial={reduceEffects ? false : { opacity: 0, x: 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduceEffects ? { opacity: 0 } : { opacity: 0, x: 8 }}
            transition={reduceEffects ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 34 }}
            // The 4px gap is PADDING on this positioned box, not a margin
            // outside it. `mouseleave` fires on DOM ancestry, but a margin
            // would leave real geometry between the rail and the panel that
            // belongs to <main>: a pointer crossing it would close the panel
            // before reaching it, defeating WCAG 1.4.13's "hoverable". Padding
            // keeps the hit region continuous while looking identical.
            className="absolute right-full top-1 z-30 flex max-h-[70vh] pr-1"
            data-testid="article-outline-flyout"
          >
            <div className="nm-card-elevated flex min-h-0 w-64 flex-col overflow-hidden">
            <div className="shrink-0 px-3 pb-2 pt-2.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-xs font-semibold text-muted-foreground/60">
                  <ListTree size={13} />
                  Outline
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground/50">
                  {headings.length} section{headings.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/8">
                <div className="h-full rounded-full bg-action" style={{ width: `${readingProgress}%` }} />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5" role="tree" aria-label="Article outline">
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
            </div>
          </m.div>
        )}
      </AnimatePresence>
      </div>
      {confirmTrashDialog}
      </>
    );
  }

  return (
    <>
    <m.aside
      ref={sidebarRef}
      key="expanded-sidebar"
      initial={reduceEffects ? false : { width: 0, opacity: 0 }}
      animate={{ width, opacity: 1 }}
      transition={reduceEffects || isResizing ? { duration: 0 } : sidebarSpring}
      className={cn(
        'app-sidebar relative flex flex-col border-l overflow-hidden',
        isResizing && 'select-none',
      )}
      data-testid="article-right-pane"
    >
      {/* Pane bar — the view switcher IS the header row.
          It used to sit under a two-line label reading "Page context" over the
          page title. Both were redundant: the article's own H1 is a few pixels
          to the left and never scrolls out from under the context strip, so the
          pane was spending 48px restating it. The tabs are the only thing in
          this chrome anyone operates, so they take the row, and the rule under
          it now lands on the same y as the sidebar's and the article strip's —
          one line across the app instead of three near-misses.

          `h-12` is the shared height of that line (see SidebarTreeView and
          PageViewPage's context strip). It is not free space: the segmented
          control is 34px (28px segments + 2px track inset + 1px borders), so
          the row has ~7px of breathing room and no more. */}
      <div className="panel-toolbar flex h-12 shrink-0 items-center gap-1 border-b px-2">
        {/* Two stable views replace one long mixed-purpose column.
            Same segmented-control shape as the main nav and the search-mode
            toggle: `rounded-md` track, `border-border`, `bg-muted`, 2px inset.
            This was `rounded-xl` on `bg-foreground/[0.045]` with a 4px inset —
            a third distinct treatment for the same interaction. */}
        <div
          className="grid min-w-0 flex-1 grid-cols-3 gap-0.5 rounded-md border border-border bg-muted p-0.5"
          role="tablist"
          aria-label="Page context views"
        >
        {/* First, and deliberately: the assistant is the thing people reach for
            most on a page, and it used to be the one behind an extra step. */}
        <button
          type="button"
          role="tab"
          id="page-context-tab-assistant"
          aria-controls="page-context-panel-assistant"
          aria-selected={activeInspectorView === 'assistant'}
          onClick={() => {
            inspectorViewTouchedRef.current = true;
            setActiveInspectorView('assistant');
          }}
          className={cn(
            'flex h-7 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeInspectorView === 'assistant'
              ? 'panel-tab-active'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-ai-assistant-trigger
          data-testid="page-context-tab-assistant"
        >
          {/* Violet marks AI (ADR-010) — on the tab's glyph only, so the
              control still reads as one of three peers rather than the
              coloured one. */}
          <Sparkles size={13} className={cn(activeInspectorView === 'assistant' && 'text-status-ai')} />
          Assistant
        </button>
        <button
          type="button"
          role="tab"
          id="page-context-tab-outline"
          aria-controls="page-context-panel-outline"
          aria-selected={activeInspectorView === 'outline'}
          onClick={() => {
            inspectorViewTouchedRef.current = true;
            setActiveInspectorView('outline');
          }}
          className={cn(
            'flex h-7 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeInspectorView === 'outline'
              ? 'panel-tab-active'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <ListTree size={13} />
          Outline
          {headings.length > 0 && (
            <span className="tabular-nums text-[11px] opacity-65">{headings.length}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          id="page-context-tab-details"
          aria-controls="page-context-panel-details"
          aria-selected={activeInspectorView === 'details'}
          onClick={() => {
            inspectorViewTouchedRef.current = true;
            setActiveInspectorView('details');
          }}
          className={cn(
            'flex h-7 items-center justify-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeInspectorView === 'details'
              ? 'panel-tab-active'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <FileText size={13} />
          Details
        </button>
        </div>

        <button
          onClick={toggleSidebar}
          className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          aria-label="Collapse page sidebar"
          title="Collapse sidebar (.)"
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      {activeInspectorView === 'assistant' && (
        <div
          id="page-context-panel-assistant"
          role="tabpanel"
          aria-labelledby="page-context-tab-assistant"
          className="flex min-h-0 flex-1 flex-col"
        >
          {/* `DockPanel` keeps its own composer, chips and thread; only its
              chrome changes. `variant="tab"` drops the header and close button
              it needed as a standalone column — this pane already has both, and
              two headers stacked was the giveaway that a column had been
              stuffed into a tab.

              Mounting it here also preserves #1126's provider economy: the
              panel is the only `AiContext` consumer, and it still only mounts
              while its view is selected, so the provider stays inert on an
              article the user never asks about. */}
          <DockPanel variant="tab" onClose={() => setActiveInspectorView('outline')} />
        </div>
      )}

      {activeInspectorView === 'details' && (
      <div
        id="page-context-panel-details"
        role="tabpanel"
        aria-labelledby="page-context-tab-details"
        className="min-h-0 flex-1 overflow-y-auto scroll-mask"
      >
      {/* AI-Tagging — available in BOTH read and edit mode (#354).
          Authors want to apply labels while editing without leaving the
          editor; readers want to discover labels for re-tagging. The other
          actions (Improve, Export, Delete) stay read-mode-only because they
          act on the saved page state. */}
      {page && id && aiAutoTagAvailable && editing && (
        <div className="px-2 pb-3 pt-4" data-testid="article-actions-edit">
          <div className="mb-1.5 px-1 text-[11px] font-semibold text-muted-foreground">
            Page actions
          </div>
          <AutoTagger
            pageId={id}
            currentLabels={page?.labels ?? []}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          />
        </div>
      )}

      {/* Action buttons — glass button style */}
      {!editing && page && (
        <div className="space-y-0.5 px-2 pb-3 pt-4" data-testid="article-actions">
          <div className="mb-1.5 px-1 text-[11px] font-semibold text-muted-foreground">
            Page actions
          </div>
          {/* No "AI Assistant" action here. It was a page action when the
              assistant was a separate column — something this pane could open.
              Now the assistant is the tab immediately to the left of Details,
              so the button was a control that switched to its own sibling: it
              duplicated the tablist one row below it, and it made "Page
              actions" mean two different things (act on the page vs. change
              which panel you are looking at). The tab, the rail icon and Alt+I
              are the three ways in, and they are enough. */}
          <button
            onClick={handleExportPdf}
            disabled={exportPdf.isPending}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground disabled:opacity-50"
            title="Export as PDF"
          >
            {exportPdf.isPending ? (
              <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
            ) : (
              <FileDown size={15} className="shrink-0 opacity-70" />
            )}
            <span className="truncate">Export PDF</span>
          </button>

          <button
            onClick={handlePinToggle}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              isPinned
                ? 'nav-selection font-medium'
                : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
            )}
            title={`${isPinned ? 'Unpin' : 'Pin'} (${formatKeysForPlatform(getShortcutHint('pin-page') ?? '', detectMac())})`}
          >
            <Pin size={15} className={cn('shrink-0 opacity-70', isPinned && 'fill-current opacity-100')} />
            <span className="truncate">{isPinned ? 'Pinned' : 'Pin'}</span>
          </button>

          <details className="group mt-2 border-t border-border pt-2">
            <summary className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors marker:content-none hover:bg-[var(--glass-pill-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight
                size={13}
                className="shrink-0 transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              <span className="flex-1">More actions</span>
              <span className="text-[11px] font-normal opacity-70">Source &amp; maintenance</span>
            </summary>
            <div className="mt-1 space-y-0.5">
              {id && aiAutoTagAvailable && (
                <AutoTagger
                  pageId={id}
                  currentLabels={page?.labels ?? []}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
                />
              )}

              {id && (
                <VersionHistory
                  pageId={id}
                  renderTrigger={(historyOpen) => (
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                        historyOpen
                          ? 'nav-selection font-medium'
                          : 'text-muted-foreground hover:bg-[var(--glass-pill-hover)] hover:text-foreground',
                      )}
                      title="Version history"
                    >
                      <History size={15} className="shrink-0 opacity-70" />
                      <span className="truncate">Version history</span>
                    </button>
                  )}
                />
              )}

              {settings?.confluenceUrl && page.confluenceId && (
                <a
                  href={`${settings.confluenceUrl.replace(/\/+$/, "")}/pages/viewpage.action?pageId=${encodeURIComponent(page.confluenceId)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
                >
                  <ExternalLink size={15} className="shrink-0 opacity-70" />
                  <span className="truncate">Open in Confluence</span>
                </a>
              )}

              {/* Re-sync from Confluence — only for Confluence-sourced articles.
                  Locally-authored pages have no upstream to pull from. */}
              {page.confluenceId && (
                <button
                  onClick={handleResync}
                  disabled={resyncMutation.isPending}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground disabled:opacity-50"
                  title="Re-sync from Confluence"
                  data-testid="article-resync-btn"
                >
                  <RefreshCw
                    size={15}
                    className={cn('shrink-0 opacity-70', resyncMutation.isPending && 'animate-spin')}
                  />
                  <span className="truncate">Re-sync</span>
                </button>
              )}

              <button
                onClick={handleReembed}
                disabled={reembedMutation.isPending}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground disabled:opacity-50"
                title="Re-embed for RAG"
                data-testid="article-reembed-btn"
              >
                {reembedMutation.isPending ? (
                  <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
                ) : (
                  <Cpu size={15} className="shrink-0 opacity-70" />
                )}
                <span className="truncate">Re-embed</span>
              </button>

              <button
                onClick={handleRequality}
                disabled={requalityMutation.isPending}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background hover:bg-[var(--glass-pill-hover)] hover:text-foreground disabled:opacity-50"
                title="Re-check quality"
                data-testid="article-requality-btn"
              >
                {requalityMutation.isPending ? (
                  <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
                ) : (
                  <Gauge size={15} className="shrink-0 opacity-70" />
                )}
                <span className="truncate">Re-check Quality</span>
              </button>
            </div>
          </details>

          <details className="group mt-1">
            <summary className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors marker:content-none hover:bg-destructive/8 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight
                size={13}
                className="shrink-0 transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              Danger zone
            </summary>
            <button
              onClick={handleDelete}
              className="nm-action-destructive mt-0.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm"
              title={`Delete (${formatKeysForPlatform(getShortcutHint('delete-page') ?? '', detectMac())})`}
            >
              <Trash2 size={15} className="shrink-0 opacity-70" />
              <span className="truncate">Delete</span>
            </button>
          </details>
        </div>
      )}

      {/* Page facts are structured for scanning; health badges remain semantic. */}
      {page && !editing && (
        <div className="border-t border-border px-3 py-4">
          <div className="text-[11px] font-semibold text-muted-foreground">Page details</div>
          <dl className="mt-2 divide-y divide-border/45 text-xs">
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-muted-foreground">Space</dt>
              <dd className="truncate font-medium text-foreground/85">{page.spaceKey}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-muted-foreground">Type</dt>
              <dd className="flex items-center gap-1.5 font-medium text-foreground/85">
                {page.hasChildren
                  ? <><FolderOpen size={12} className="text-muted-foreground" /> Folder</>
                  : <><FileText size={12} className="text-muted-foreground" /> Article</>}
              </dd>
            </div>
            {page.author && (
              <div className="flex items-center justify-between gap-3 py-2">
                <dt className="text-muted-foreground">Author</dt>
                <dd className="max-w-[150px] truncate font-medium text-foreground/85">{page.author}</dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-medium tabular-nums text-foreground/85">v{page.version}</dd>
            </div>
          </dl>

          <div className="mt-4 text-[11px] font-semibold text-muted-foreground">Health &amp; labels</div>
          <div className="mt-2 flex flex-wrap gap-1.5">
              {page.lastModifiedAt && <FreshnessBadge lastModified={page.lastModifiedAt} />}
              <EmbeddingStatusBadge
                embeddingStatus={page.embeddingStatus}
                embeddingDirty={page.embeddingDirty}
                embeddedAt={page.embeddedAt}
                embeddingError={page.embeddingError}
              />
              {page.qualityScore !== undefined && page.qualityScore !== null && (
                <QualityScoreBadge
                  qualityScore={page.qualityScore}
                  qualityStatus={page.qualityStatus ?? null}
                  qualityCompleteness={page.qualityCompleteness}
                  qualityClarity={page.qualityClarity}
                  qualityStructure={page.qualityStructure}
                  qualityAccuracy={page.qualityAccuracy}
                  qualityReadability={page.qualityReadability}
                  qualitySummary={page.qualitySummary}
                  qualityAnalyzedAt={page.qualityAnalyzedAt}
                  qualityError={page.qualityError}
                />
              )}
              {page.labels.map((label) => (
                <span
                  key={label}
                  className="nm-pill-active rounded-full px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {label}
                </span>
              ))}
          </div>
        </div>
      )}
      </div>
      )}

      {activeInspectorView === 'outline' && (
      <div
        id="page-context-panel-outline"
        role="tabpanel"
        aria-labelledby="page-context-tab-outline"
        className="min-h-0 flex flex-1 flex-col"
      >
        {/* Outline header + progress */}
        {headings.length > 0 && (
          <div className="px-3 pb-2 pt-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-semibold text-foreground/85">On this page</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  Follow the document structure
                </div>
              </div>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {Math.round(readingProgress)}%
              </span>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-foreground/8">
              <m.div
                className="h-full rounded-full bg-action"
                style={{ width: `${readingProgress}%` }}
                transition={{ duration: 0.12 }}
              />
            </div>
          </div>
        )}

        {/* Outline tree — with scroll mask */}
        <div className="mt-1 flex-1 overflow-y-auto border-t border-border p-2 scroll-mask" data-testid="article-outline-tree">
        {headings.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center px-5 text-center">
            <span className="flex size-9 items-center justify-center rounded-xl bg-foreground/[0.05] text-muted-foreground">
              <ListTree size={17} />
            </span>
            <p className="mt-3 text-xs font-medium text-foreground/80">No outline yet</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              Add headings to make this page easier to scan.
            </p>
          </div>
        ) : (
          // #880: role="tree" + label give the role="treeitem" outline rows a
          // valid required-parent context and expose real tree semantics to
          // screen readers. Full roving-tabindex/arrow-key nav remains a tracked
          // follow-up (epic #856).
          <div className="space-y-0.5" role="tree" aria-label="Article outline">
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
      </div>
      )}

      {/* Resize handle */}
      <div
        role="separator"
        aria-label="Resize page sidebar"
        aria-orientation="vertical"
        aria-valuemin={200}
        aria-valuemax={1200}
        aria-valuenow={width}
        tabIndex={0}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setWidth(360)}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          'group absolute bottom-0 left-0 top-0 z-10 flex w-2 cursor-col-resize items-center justify-start outline-none',
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
    {confirmTrashDialog}
    </>
  );
}
