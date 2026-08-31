import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertCircle,
  ChevronRight,
  Cpu,
  ExternalLink,
  FileText,
  FolderOpen,
  Gauge,
  Globe,
  ListTree,
  Lock,
  MessageSquare,
  MoreHorizontal,
  PanelRight,
  PanelRightClose,
  Pin,
  FileDown,
  GitGraph,
  Loader2,
  RefreshCw,
  Sparkles,
  Trash2,
  History,
  ShieldCheck,
} from 'lucide-react';

import { AutoTagger } from '../../../features/pages/AutoTagger';
import { RelocateDialog } from '../../../features/pages/RelocateDialog';
import { DockPanel } from '../../../features/ai/dock/DockPanel';
import { NotesInspectorPanel, usePageNotes } from './NotesInspectorPanel';
import { VersionHistory } from '../../../features/pages/VersionHistory';
import { FreshnessBadge } from '../badges/FreshnessBadge';
import { EmbeddingStatusBadge } from '../badges/EmbeddingStatusBadge';
import { QualityScoreBadge } from '../badges/QualityScoreBadge';
import { Button } from '../Button';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { getShortcutHint, formatKeysForPlatform } from '../../lib/shortcut-registry';
import { isMac as detectMac } from '../../lib/platform';
import { toast } from 'sonner';
import {
  ARTICLE_SIDEBAR_DEFAULT_WIDTH,
  ARTICLE_SIDEBAR_MAX_WIDTH,
  ARTICLE_SIDEBAR_MIN_WIDTH,
  useUiStore,
} from '../../../stores/ui-store';
import { useArticleViewStore } from '../../../stores/article-view-store';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useIsDockWideLayout, useIsInspectorWideLayout } from '../../hooks/use-media-query';
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useExportPdf, useVerifyPage } from '../../hooks/use-standalone';
import { usePermission } from '../../hooks/use-permission';
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

interface FlatOutlineEntry {
  id: string;
  parentId: string | null;
  hasChildren: boolean;
}

function flattenVisibleOutline(
  nodes: OutlineNode[],
  collapsedIds: Set<string>,
  parentId: string | null = null,
): FlatOutlineEntry[] {
  const out: FlatOutlineEntry[] = [];
  for (const node of nodes) {
    const hasChildren = node.children.length > 0;
    out.push({ id: node.heading.id, parentId, hasChildren });
    if (hasChildren && !collapsedIds.has(node.heading.id)) {
      out.push(...flattenVisibleOutline(node.children, collapsedIds, node.heading.id));
    }
  }
  return out;
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
  rovingId: string | undefined;
  collapsedIds: Set<string>;
  onNavigate: (id: string) => void;
  onToggleCollapsed: (id: string) => void;
  onKeyDown: (e: React.KeyboardEvent, id: string) => void;
  onFocus: (id: string) => void;
  level?: number;
}

const OutlineNodeItem = memo(function OutlineNodeItem({
  node,
  activeId,
  rovingId,
  collapsedIds,
  onNavigate,
  onToggleCollapsed,
  onKeyDown,
  onFocus,
  level = 0,
}: OutlineNodeItemProps) {
  const { heading, children } = node;
  const hasChildren = children.length > 0;
  const isOpen = !collapsedIds.has(heading.id);
  const isActive = activeId === heading.id;
  const isRovingTarget = heading.id === rovingId;

  return (
    <div role="none">
      <div
        // WAI-ARIA Treeview: role="treeitem", roving tabindex, aria-selected, aria-level.
        // Enter/Space jump to the heading; arrow keys navigate the tree.
        role="treeitem"
        tabIndex={isRovingTarget ? 0 : -1}
        aria-level={level + 1}
        aria-selected={isActive}
        aria-expanded={hasChildren ? isOpen : undefined}
        data-heading-id={heading.id}
        className={cn(
          'group relative flex items-center gap-1.5 rounded-md h-7 pr-2 text-[13px] cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          isActive
            ? 'nav-selection font-medium'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
        style={{ paddingLeft: `${level * 12 + 28}px` }}
        onClick={() => onNavigate(heading.id)}
        onFocus={() => onFocus(heading.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          onKeyDown(e, heading.id);
        }}
      >
        {hasChildren && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            aria-label={isOpen ? 'Collapse section' : 'Expand section'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapsed(heading.id);
            }}
            className="absolute top-[2px] z-10 flex size-6 items-center justify-center rounded-md text-muted-foreground/80 transition-colors hover:bg-foreground/10 hover:text-foreground"
            style={{ left: `${level * 12 + 2}px` }}
          >
            <ChevronRight
              size={14}
              className={cn('transition-transform duration-150', isOpen && 'rotate-90')}
            />
          </button>
        )}
        <span className="truncate" title={heading.text}>
          {heading.text}
        </span>
      </div>

      {hasChildren && isOpen && (
        <div role="group">
          {children.map((child) => (
            <OutlineNodeItem
              key={child.heading.id}
              node={child}
              activeId={activeId}
              rovingId={rovingId}
              collapsedIds={collapsedIds}
              onNavigate={onNavigate}
              onToggleCollapsed={onToggleCollapsed}
              onKeyDown={onKeyDown}
              onFocus={onFocus}
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
 * Below `md` AppLayout hosts this pane in a right-hand sheet so Outline,
 * Details and Assistant stay one inspector, rather than leaving the first
 * two unreachable while Assistant had its own bottom sheet.
 */
export type InspectorView = 'assistant' | 'outline' | 'notes' | 'details';

export type InspectorPresentation = 'rail' | 'sheet';

export interface InspectorViewRequest {
  view: InspectorView;
  requestId: number;
}

export function ArticleRightPane({
  inspectorViewRequest,
  presentation = 'rail',
  onRequestClose,
}: {
  inspectorViewRequest?: InspectorViewRequest | null;
  presentation?: InspectorPresentation;
  onRequestClose?: () => void;
} = {}) {
  const location = useLocation();
  const navigate = useNavigate();

  // Extract page ID from pathname instead of useParams, because this component
  // is rendered in AppLayout (outer Route) where descendant route params like
  // :id from /pages/:id are not available via useParams.
  const isNewPage = location.pathname === '/pages/new';
  const id = useMemo(() => {
    if (isNewPage) return undefined;
    const match = location.pathname.match(/^\/pages\/([^/]+)$/);
    return match?.[1];
  }, [location.pathname, isNewPage]);

  const userCollapsed = useUiStore((s) => s.articleSidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleArticleSidebar);
  const laptopExpanded = useUiStore((s) => s.articleSidebarLaptopExpanded);
  const setLaptopExpanded = useUiStore((s) => s.setArticleSidebarLaptopExpanded);
  const storedWidth = useUiStore((s) => s.articleSidebarWidth);
  const width = Math.max(ARTICLE_SIDEBAR_MIN_WIDTH, storedWidth);
  const setWidth = useUiStore((s) => s.setArticleSidebarWidth);
  const reduceEffects = useReducedMotion();

  // `collapsed` is the user's preference and nothing else now.
  //
  // #1126 ORed `dockOpen` in, because the assistant was a third column and this
  // pane had to fall back to its 40px rail to make room. The assistant is a tab
  // *inside* this pane now, so there is nothing to make room for — and leaving
  // the OR in place was actively harmful. `openDock()` is still raised by Alt+I;
  // `AppLayout` consumes it above `md` and re-expresses it as
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
  const inspectorWide = useIsInspectorWideLayout();
  const isSheet = presentation === 'sheet';
  // Below xl the inspector starts as the 40px rail so the article keeps
  // the workspace. Expand (and Alt+I) sets laptopExpanded.
  const collapsed = isSheet ? false : inspectorWide ? userCollapsed : !laptopExpanded;
  const handleExpandSidebar = useCallback(() => {
    if (!inspectorWide) setLaptopExpanded(true);
    else if (userCollapsed) toggleSidebar();
  }, [inspectorWide, setLaptopExpanded, toggleSidebar, userCollapsed]);
  const handleCollapseSidebar = useCallback(() => {
    if (!inspectorWide) setLaptopExpanded(false);
    else if (!userCollapsed) toggleSidebar();
  }, [inspectorWide, setLaptopExpanded, toggleSidebar, userCollapsed]);

  const headings = useArticleViewStore((s) => s.headings);
  const editing = useArticleViewStore((s) => s.editing);

  const queryClient = useQueryClient();
  const { data: page } = usePage(id);
  const { data: pinnedData } = usePinnedPages();
  const { data: settings } = useSettings();
  const deleteMutation = useDeletePage();
  const pinMutation = usePinPage();
  const unpinMutation = useUnpinPage();
  const resyncMutation = useResyncPage();
  const reembedMutation = useReembedPage();
  const requalityMutation = useRequalityPage();
  const { allowed: canRelocate } = usePermission('pages:relocate');
  const verifyMutation = useVerifyPage();
  const [relocateOpen, setRelocateOpen] = useState(false);
  const [verifyStatusMsg, setVerifyStatusMsg] = useState<string | null>(null);

  const isPinned = pinnedData?.items.some((item) => item.id === id) ?? false;
  const verifiedAt = page?.verifiedAt ?? null;
  const verifiedDateStr = verifiedAt
    ? new Date(verifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;

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
    isNewPage ? (headings.length > 0 ? 'outline' : 'assistant') : headings.length > 0 ? 'outline' : 'details',
  );
  const [assistantMounted, setAssistantMounted] = useState(() => activeInspectorView === 'assistant' || isNewPage);

  useEffect(() => {
    if (activeInspectorView === 'assistant') {
      setAssistantMounted(true);
    }
  }, [activeInspectorView]);

  const inspectorViewTouchedRef = useRef(false);
  const previousInspectorPageIdRef = useRef(isNewPage ? 'new' : id);
  // Collapsing this pane keeps Outline as a first-class rail control. The
  // flyout is what makes the map usable at 40px (#1126).
  const [outlineFlyoutOpen, setOutlineFlyoutOpen] = useState(false);
  const [railOverflowOpen, setRailOverflowOpen] = useState(false);
  const [railOverflowTop, setRailOverflowTop] = useState(0);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const outlineTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const railOverflowRef = useRef<HTMLDivElement>(null);
  const railClusterRef = useRef<HTMLDivElement>(null);
  // Escape dismisses the flyout and returns focus to its trigger — which would
  // land on the trigger's focus-to-open handler and reopen what was just
  // dismissed. Set across that one handoff and cleared as soon as focus or the
  // pointer moves on.
  const suppressFlyoutReopenRef = useRef(false);

  useEffect(() => {
    if (!railOverflowOpen) return;

    const dismissOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const targetElement = target instanceof Element ? target : target.parentElement;
      if (targetElement?.closest('[role="dialog"]')) return;
      if (railOverflowRef.current?.contains(target) || overflowTriggerRef.current?.contains(target)) return;
      setRailOverflowOpen(false);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const target = event.target;
      if (target instanceof Element && target.closest('[role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setRailOverflowOpen(false);
      overflowTriggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', dismissOnOutsidePointer, true);
    document.addEventListener('keydown', dismissOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', dismissOnOutsidePointer, true);
      document.removeEventListener('keydown', dismissOnEscape, true);
    };
  }, [railOverflowOpen]);

  const tree = useMemo(() => buildOutlineTree(headings), [headings]);

  // A page with headings opens on its reading outline; a heading-free page
  // opens on details instead of presenting a dead-end. Do not steal the view
  // back if the user already chose a tab while headings were still loading.
  useEffect(() => {
    const currentKey = isNewPage ? 'new' : id;
    if (previousInspectorPageIdRef.current !== currentKey) {
      previousInspectorPageIdRef.current = currentKey;
      inspectorViewTouchedRef.current = false;
      // `headings` still belongs to the previous page during this render.
      // Start from Details until the destination publishes its own structure.
      // On new page, default to Assistant.
      setActiveInspectorView(isNewPage ? (headings.length > 0 ? 'outline' : 'assistant') : 'details');
      setAssistantMounted(isNewPage || activeInspectorView === 'assistant');
      return;
    }
    if (!inspectorViewTouchedRef.current) {
      setActiveInspectorView(isNewPage ? (headings.length > 0 ? 'outline' : 'assistant') : (headings.length > 0 ? 'outline' : 'details'));
    }
  }, [headings.length, id, isNewPage, activeInspectorView]);

  // Explicit inspector view requests take precedence over
  // the content-derived default and mark the view as intentionally chosen.
  useEffect(() => {
    if (!inspectorViewRequest) return;
    inspectorViewTouchedRef.current = true;
    setActiveInspectorView(inspectorViewRequest.view);
  }, [inspectorViewRequest]);

  const { data: pageNotes } = usePageNotes(id);
  const openNotesCount = useMemo(
    () => pageNotes?.filter((n) => !n.parentId && !n.resolved && !n.isResolved).length ?? 0,
    [pageNotes],
  );

  // Global hotkeys for tab switching: Alt+O (Outline), Alt+N (Notes) and Alt+D (Details)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        const target = e.target as HTMLElement | null;
        const isEditable =
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable ||
            Boolean(target.closest?.('[contenteditable="true"]')));
        if (isEditable) return;

        const key = e.key.toLowerCase();
        if (key === 'o') {
          e.preventDefault();
          inspectorViewTouchedRef.current = true;
          setActiveInspectorView('outline');
          handleExpandSidebar();
        } else if (key === 'd') {
          e.preventDefault();
          inspectorViewTouchedRef.current = true;
          setActiveInspectorView('details');
          handleExpandSidebar();
        } else if (key === 'n') {
          e.preventDefault();
          inspectorViewTouchedRef.current = true;
          setActiveInspectorView('notes');
          handleExpandSidebar();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleExpandSidebar]);

  // Listen to open-sidebar requests from inline comment popovers
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOpenNotes = () => {
      inspectorViewTouchedRef.current = true;
      setActiveInspectorView('notes');
      handleExpandSidebar();
    };
    window.addEventListener('compendiq:comment-open-sidebar', handleOpenNotes);
    return () => window.removeEventListener('compendiq:comment-open-sidebar', handleOpenNotes);
  }, [handleExpandSidebar]);

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
    onRequestClose?.();
  }, [onRequestClose]);

  const expandedTreeRef = useRef<HTMLDivElement>(null);
  const flyoutTreeRef = useRef<HTMLDivElement>(null);

  const flatOutline = useMemo(
    () => flattenVisibleOutline(tree, collapsedIds),
    [tree, collapsedIds],
  );
  const [explicitRovingId, setExplicitRovingId] = useState<string | undefined>(undefined);
  const rovingId = useMemo(() => {
    if (explicitRovingId && flatOutline.some((e) => e.id === explicitRovingId)) {
      return explicitRovingId;
    }
    if (activeId && flatOutline.some((e) => e.id === activeId)) {
      return activeId;
    }
    return flatOutline[0]?.id;
  }, [explicitRovingId, flatOutline, activeId]);

  const moveFocusTo = useCallback(
    (targetId: string | undefined, containerRef: React.RefObject<HTMLElement | null>) => {
      if (!targetId) return;
      setExplicitRovingId(targetId);
      requestAnimationFrame(() => {
        const container = containerRef.current;
        if (!container) return;
        const row = container.querySelector<HTMLElement>(`[data-heading-id="${CSS.escape(targetId)}"]`);
        row?.focus();
      });
    },
    [],
  );

  const handleOutlineKeyDown = useCallback(
    (
      e: React.KeyboardEvent,
      headingId: string,
      containerRef: React.RefObject<HTMLElement | null>,
    ) => {
      const index = flatOutline.findIndex((item) => item.id === headingId);
      if (index === -1) return;
      const entry = flatOutline[index];
      if (!entry) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveFocusTo(flatOutline[index + 1]?.id, containerRef);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveFocusTo(flatOutline[index - 1]?.id, containerRef);
          break;
        case 'ArrowRight':
          if (entry.hasChildren) {
            e.preventDefault();
            if (collapsedIds.has(headingId)) {
              handleToggleCollapsed(headingId);
            } else {
              moveFocusTo(flatOutline[index + 1]?.id, containerRef);
            }
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (entry.hasChildren && !collapsedIds.has(headingId)) {
            handleToggleCollapsed(headingId);
          } else if (entry.parentId) {
            moveFocusTo(entry.parentId, containerRef);
          }
          break;
        case 'Home':
          e.preventDefault();
          moveFocusTo(flatOutline[0]?.id, containerRef);
          break;
        case 'End':
          e.preventDefault();
          moveFocusTo(flatOutline[flatOutline.length - 1]?.id, containerRef);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          handleNavigate(headingId);
          break;
        default:
          break;
      }
    },
    [flatOutline, collapsedIds, handleToggleCollapsed, handleNavigate, moveFocusTo],
  );

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
        setWidth(ARTICLE_SIDEBAR_DEFAULT_WIDTH);
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

  const handleVerify = useCallback(async () => {
    if (!id) return;
    try {
      await verifyMutation.mutateAsync({ pageId: Number(id) });
      toast.success('Page verified — next review reminder rescheduled');
      setVerifyStatusMsg('Page verified');
      await queryClient.invalidateQueries({ queryKey: ['pages', id] });
      setTimeout(() => setVerifyStatusMsg(null), 3000);
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : 'Failed to verify page';
      toast.error(msg);
      setVerifyStatusMsg(msg);
      setTimeout(() => setVerifyStatusMsg(null), 3000);
    }
  }, [id, queryClient, verifyMutation]);

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

  if (!id && !isNewPage) return null;

  // Below the wide breakpoint a 40px rail plus a ~420px dock starves the
  // article, so the rail steps aside entirely and the assistant owns the right
  // side of the pane (#1126). Above it, both fit and both stay.
  if (!isSheet && dockOpen && !dockLayoutIsWide) return null;

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
  const relocateDialog = relocateOpen && id && page ? (
    <RelocateDialog
      open
      pageId={id}
      pageTitle={page.title}
      source={page.source}
      onClose={() => setRelocateOpen(false)}
    />
  ) : null;

  // Collapsed rail — reading gutter + one overflow. Expand, Outline,
  // Assistant and Pin stay first-class; everything that lives behind
  // "More actions" on the expanded Details tab stays behind one More
  // control here too. Delete is still absent: collapse must not promote it.
  if (collapsed) {
    const railIconBtn =
      'rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
    const railMenuItem =
      'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
    const assistantHint = formatKeysForPlatform(getShortcutHint('ai-assistant') ?? '', detectMac());
    const pinHint = formatKeysForPlatform(getShortcutHint('pin-page') ?? '', detectMac());
    const closeOutlineUnlessMovingInside = (next: Node | null) => {
      if (outlineTriggerRef.current?.contains(next)) return;
      if (document.getElementById('article-outline-flyout')?.contains(next)) return;
      suppressFlyoutReopenRef.current = false;
      setOutlineFlyoutOpen(false);
    };
    return (
      <>
      {/* Positioning context for the outline flyout. `mouseleave` fires on DOM
          ancestry, not geometry, so the absolutely-positioned flyout counts as
          inside this wrapper and the pointer can travel into it without the
          panel closing underneath — WCAG 1.4.13's "hoverable" requirement. */}
      <div
        ref={railClusterRef}
        className="relative flex h-full shrink-0"
        onPointerMove={(event) => {
          const target = event.target;
          if (!(target instanceof Node)) return;
          const rail = railClusterRef.current?.querySelector('[data-testid="article-right-pane-rail"]');
          if (!rail?.contains(target) || outlineTriggerRef.current?.contains(target)) return;
          suppressFlyoutReopenRef.current = false;
          setOutlineFlyoutOpen(false);
        }}
        onMouseLeave={() => {
          suppressFlyoutReopenRef.current = false;
          setOutlineFlyoutOpen(false);
        }}
        onBlur={(e) => {
          closeOutlineUnlessMovingInside(e.relatedTarget as Node | null);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          if (railOverflowOpen) {
            e.stopPropagation();
            setRailOverflowOpen(false);
            return;
          }
          if (!outlineFlyoutOpen) return;
          // Dismissible (WCAG 1.4.13). Stopped here so the same Escape does not
          // also reach the document listener and exit the article's edit mode.
          e.stopPropagation();
          suppressFlyoutReopenRef.current = true;
          setOutlineFlyoutOpen(false);
          outlineTriggerRef.current?.focus();
        }}
      >
      <AnimatePresence mode="wait">
        <m.aside
          key="collapsed-rail"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: 40, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects ? { duration: 0 } : sidebarSpring}
          className="app-context-rail flex h-full flex-col items-center overflow-hidden"
          aria-label="Page inspector"
          data-testid="article-right-pane-rail"
        >
          {/* The shortcut lives in the tooltip (and the title below), not glued
              to the icon. A one-character hint like "." rendered as a bordered
              chip beside a rail icon reads as stray punctuation rather than a
              key — worst of all in the 40px collapsed rail, where it is the
              only other mark on screen. The `title` already carries it, so
              nothing is lost for a mouse user, and `aria-label` for everyone
              else. The left-opening flyout is what a sighted keyboard user
              gets — native `title` is hover-only. */}
          <div className="group relative flex h-12 w-full flex-col items-center justify-center">
            <button
              onClick={handleExpandSidebar}
              className={railIconBtn}
              aria-label="Expand inspector"
              title="Expand inspector (.)"
            >
              <PanelRight size={16} />
            </button>
            <span
              role="tooltip"
              className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md nm-card-elevated px-2 py-1 text-[11px] text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              Expand inspector · .
            </span>
          </div>

          <div className="my-1 h-px w-6 bg-border" />
          <div className="group relative flex w-full justify-center">
            <button
              type="button"
              onClick={() => {
                inspectorViewTouchedRef.current = true;
                setOutlineFlyoutOpen(false);
                setActiveInspectorView('assistant');
                handleExpandSidebar();
              }}
              className={cn(
                railIconBtn,
                activeInspectorView === 'assistant' && 'nm-pill-active',
              )}
              aria-label="AI Assistant"
              title={`AI Assistant (${assistantHint})`}
              data-testid="article-assistant-rail-btn"
              data-ai-assistant-trigger
            >
              <Sparkles size={16} className="text-status-ai" />
            </button>
            <span
              role="tooltip"
              className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md nm-card-elevated px-2 py-1 text-[11px] text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            >
              AI Assistant · {assistantHint}
            </span>
          </div>

          {/* Outline flyout = the Outline tab while collapsed. Hover OR focus
              opens it (WCAG 2.4.7); click toggles for touch. Stays mounted
              in edit mode: collapsing to write must not hide the map. */}
          {headings.length > 0 && (
            <>
              <div className="group relative mt-1 flex w-full justify-center">
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
                  className={cn(
                    railIconBtn,
                    (outlineFlyoutOpen || activeInspectorView === 'outline') && 'nm-pill-active',
                  )}
                  aria-label="Outline"
                  aria-expanded={outlineFlyoutOpen}
                  aria-controls="article-outline-flyout"
                  title={`Outline — ${headings.length} section${headings.length === 1 ? '' : 's'}. Same as the Outline tab.`}
                  data-testid="article-outline-rail-btn"
                >
                  <ListTree size={16} />
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md nm-card-elevated px-2 py-1 text-[11px] text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  Outline · {headings.length} · same as the Outline tab
                </span>
              </div>
            </>
          )}

          {id && (
            <>
              <div className="my-1 h-px w-6 bg-border" />
              <div className="group relative flex w-full justify-center">
                <button
                  type="button"
                  onClick={() => {
                    inspectorViewTouchedRef.current = true;
                    setActiveInspectorView('notes');
                    handleExpandSidebar();
                  }}
                  className={cn(
                    railIconBtn,
                    activeInspectorView === 'notes' && 'nm-pill-active',
                  )}
                  aria-label={`Notes (${openNotesCount} open)`}
                  title={`Notes — ${openNotesCount} open note${openNotesCount === 1 ? '' : 's'}. (Alt+N)`}
                  data-testid="article-notes-rail-btn"
                >
                  <MessageSquare size={16} />
                  {openNotesCount > 0 && (
                    <span className="absolute top-0 right-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-action px-0.5 text-[11px] font-semibold text-action-foreground">
                      {openNotesCount}
                    </span>
                  )}
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md nm-card-elevated px-2 py-1 text-[11px] text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  Notes · {openNotesCount} open · Alt+N
                </span>
              </div>
            </>
          )}

          <div className="my-1 h-px w-6 bg-border" />
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto p-1">
            {headings.length === 0 && (
            <div className="group relative flex w-full justify-center">
              <button
                type="button"
                onClick={() => {
                  inspectorViewTouchedRef.current = true;
                  setActiveInspectorView('details');
                  handleExpandSidebar();
                }}
                className={cn(
                  railIconBtn,
                  activeInspectorView === 'details' && 'nm-pill-active',
                )}
                aria-label="Page details"
                title="Page details"
                data-testid="article-details-rail-btn"
              >
                <FileText size={16} />
              </button>
              <span
                role="tooltip"
                className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md nm-card-elevated px-2 py-1 text-[11px] text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
              >
                Page details
              </span>
            </div>
            )}

            {/* Overflow: pin, other views, page actions, maintenance.
                Hidden while editing. Delete stays off this rail. */}
            {!editing && page && (
              <div className="group relative flex w-full justify-center">
                <button
                  ref={overflowTriggerRef}
                  type="button"
                  className={cn(railIconBtn, railOverflowOpen && 'nm-pill-active')}
                  aria-label="More page actions"
                  aria-expanded={railOverflowOpen}
                  aria-controls="article-rail-overflow"
                  title="More page actions"
                  data-testid="article-actions-rail"
                  onClick={() => {
                    setRailOverflowOpen((open) => {
                      const next = !open;
                      if (next && overflowTriggerRef.current && railClusterRef.current) {
                        const clusterTop = railClusterRef.current.getBoundingClientRect().top;
                        setRailOverflowTop(
                          overflowTriggerRef.current.getBoundingClientRect().top - clusterTop,
                        );
                      }
                      return next;
                    });
                  }}
                >
                  <MoreHorizontal size={16} />
                </button>
                <span
                  role="tooltip"
                  className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md nm-card-elevated px-2 py-1 text-[11px] text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  More page actions
                </span>
              </div>
            )}
          </div>
        </m.aside>
      </AnimatePresence>

      {!editing && page && railOverflowOpen && (
        <div
          ref={railOverflowRef}
          id="article-rail-overflow"
          aria-label="More page actions"
          data-testid="article-rail-overflow"
          className="absolute right-full z-30 mr-1 w-56 nm-card-elevated p-1.5"
          style={{ top: railOverflowTop }}
        >
                    <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
                      Inspector
                    </div>
                    {activeInspectorView !== 'details' && (
                      <button
                        type="button"
                        className={railMenuItem}
                        aria-label="Page details"
                        data-testid="article-details-rail-btn"
                        onClick={() => {
                          inspectorViewTouchedRef.current = true;
                          setActiveInspectorView('details');
                          setRailOverflowOpen(false);
                          handleExpandSidebar();
                        }}
                      >
                        <FileText size={15} className="shrink-0 opacity-70" />
                        <span className="truncate">Details</span>
                      </button>
                    )}
                    <button
                      type="button"
                      className={railMenuItem}
                      aria-label={isPinned ? 'Unpin page' : 'Pin page'}
                      aria-pressed={isPinned}
                      onClick={handlePinToggle}
                    >
                      <Pin size={15} className={cn('shrink-0 opacity-70', isPinned && 'fill-current')} />
                      <span className="truncate">{isPinned ? 'Unpin page' : 'Pin page'} · {pinHint}</span>
                    </button>
                    <div className="mt-1 border-t border-border px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
                      Page actions
                    </div>
                    {id && (
                      <VersionHistory
                        pageId={id}
                        renderTrigger={() => (
                          <button
                            type="button"
                            className={railMenuItem}
                            aria-label="Version history"
                            title="Version history"
                            data-testid="article-history-rail-btn"
                          >
                            <History size={15} className="shrink-0 opacity-70" />
                            <span className="truncate">Version history</span>
                          </button>
                        )}
                      />
                    )}
                    <button
                      onClick={handleExportPdf}
                      disabled={exportPdf.isPending}
                      className={railMenuItem}
                      aria-label="Export PDF"
                      title="Export as PDF"
                    >
                      {exportPdf.isPending ? (
                        <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
                      ) : (
                        <FileDown size={15} className="shrink-0 opacity-70" />
                      )}
                      <span className="truncate">Export PDF</span>
                    </button>
                    {settings?.confluenceUrl && page.confluenceId && (
                      <a
                        href={`${settings.confluenceUrl.replace(/\/+$/, '')}/pages/viewpage.action?pageId=${encodeURIComponent(page.confluenceId)}`}
                        target="_blank"
                        rel="noreferrer"
                        className={railMenuItem}
                        aria-label="Open in Confluence"
                        title="Open in Confluence"
                      >
                        <ExternalLink size={15} className="shrink-0 opacity-70" />
                        <span className="truncate">Open in Confluence</span>
                      </a>
                    )}

                    <div className="mt-1 border-t border-border px-2.5 pb-1 pt-2 text-[11px] font-semibold text-muted-foreground">
                      Maintenance &amp; AI
                    </div>
                    {aiAutoTagAvailable && id && (
                      <AutoTagger
                        pageId={id}
                        currentLabels={page?.labels ?? []}
                        aria-label="Auto-tag"
                        className={railMenuItem}
                      />
                    )}
                    {page.confluenceId && (
                      <button
                        onClick={handleResync}
                        disabled={resyncMutation.isPending}
                        className={railMenuItem}
                        aria-label="Re-sync from Confluence"
                        title="Re-sync from Confluence"
                        data-testid="article-resync-rail-btn"
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
                      className={railMenuItem}
                      aria-label="Re-embed for search"
                      title="Re-embed for search"
                      data-testid="article-reembed-rail-btn"
                    >
                      {reembedMutation.isPending ? (
                        <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
                      ) : (
                        <Cpu size={15} className="shrink-0 opacity-70" />
                      )}
                      <span className="truncate">Re-embed for search</span>
                    </button>
                    <button
                      onClick={handleRequality}
                      disabled={requalityMutation.isPending}
                      className={railMenuItem}
                      aria-label="Re-check quality"
                      title="Re-check quality"
                      data-testid="article-requality-rail-btn"
                    >
                      {requalityMutation.isPending ? (
                        <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
                      ) : (
                        <Gauge size={15} className="shrink-0 opacity-70" />
                      )}
                      <span className="truncate">Re-check quality</span>
                    </button>
        </div>
      )}

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
                <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground/85">
                  <ListTree size={13} className="text-muted-foreground" />
                  Outline
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Same as the Outline tab
              </p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/8">
                <div className="h-full rounded-full bg-action" style={{ width: `${readingProgress}%` }} />
              </div>
            </div>
            <div
              ref={flyoutTreeRef}
              className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5"
              role="tree"
              aria-label="Outline"
            >
              {tree.map((node) => (
                <OutlineNodeItem
                  key={node.heading.id}
                  node={node}
                  activeId={activeId}
                  rovingId={rovingId}
                  collapsedIds={collapsedIds}
                  onNavigate={handleNavigate}
                  onToggleCollapsed={handleToggleCollapsed}
                  onKeyDown={(e, hid) => handleOutlineKeyDown(e, hid, flyoutTreeRef)}
                  onFocus={setExplicitRovingId}
                />
              ))}
            </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
      </div>
      {confirmTrashDialog}
      {relocateDialog}
      </>
    );
  }

  return (
    <>
    <m.aside
      ref={sidebarRef}
      key="expanded-sidebar"
      initial={reduceEffects ? false : isSheet ? { opacity: 0 } : { width: 0, opacity: 0 }}
      animate={isSheet ? { opacity: 1 } : { width, opacity: 1 }}
      transition={reduceEffects || isResizing || isSheet ? { duration: 0 } : sidebarSpring}
      className={cn(
        'app-context-rail relative flex flex-col overflow-hidden',
        isResizing && 'select-none',
        'h-full',
        isSheet && 'w-full',
      )}
      data-testid="article-right-pane"
    >
      {/* Pane bar — the view switcher IS the header row.
          It used to sit under a two-line label reading "Page context" over the
          page title. Both were redundant: the article's own H1 is a few pixels
          to the left and never scrolls out from under the context strip, so the
          pane was spending 48px restating it. The tabs are the only thing in
          this chrome anyone operates, so they take the row.

          No hairline under it since 2026-08-31: the owner took the 48px rule
          off every pane. The segmented control below carries its own track and
          border, so the row still reads as chrome without one, and the height
          survives because the panes' content must still start on one y.

          `h-12` is that shared height (see SidebarTreeView and PageViewPage's
          context strip). It is not free space: the segmented control is 34px
          (28px segments + 2px track inset + 1px borders), so the row has ~7px
          of breathing room and no more. */}
      <div className="panel-toolbar flex h-12 shrink-0 items-center gap-1 px-2">
        {/* Two stable views replace one long mixed-purpose column.
            Same segmented-control shape as the main nav, the settings sub-tabs
            and the search-mode toggle: `rounded-md` track on `bg-muted`, 2px
            inset, one raised active segment. The track's own `border-border`
            came off on 2026-08-31 with the rest of the panel's lines — the fill
            is 1.19:1 on Pane in Paper and carries the boundary alone, which is
            what the Notes filter track beside it was already doing. The active
            chip's edge is now the only line in the control, and it moved to
            --color-border-interactive so the selected state still clears
            1.4.11 (see `panel-tab-active`). */}
        <div
          className="grid min-w-0 flex-1 grid-cols-4 gap-0.5 rounded-md bg-muted p-0.5"
          role="tablist"
          aria-label="Page context views"
          onKeyDown={(e) => {
            const tabs: InspectorView[] = ['assistant', 'outline', 'notes', 'details'];
            const currentIndex = tabs.indexOf(activeInspectorView);
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
              e.preventDefault();
              const nextView = tabs[(currentIndex + 1) % tabs.length]!;
              inspectorViewTouchedRef.current = true;
              setActiveInspectorView(nextView);
              document.getElementById(`page-context-tab-${nextView}`)?.focus();
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
              e.preventDefault();
              const prevView = tabs[(currentIndex - 1 + tabs.length) % tabs.length]!;
              inspectorViewTouchedRef.current = true;
              setActiveInspectorView(prevView);
              document.getElementById(`page-context-tab-${prevView}`)?.focus();
            }
          }}
        >
        {/* First, and deliberately: the assistant is the thing people reach for
            most on a page, and it used to be the one behind an extra step. */}
        <button
          type="button"
          role="tab"
          id="page-context-tab-assistant"
          aria-controls="page-context-panel-assistant"
          aria-selected={activeInspectorView === 'assistant'}
          tabIndex={activeInspectorView === 'assistant' ? 0 : -1}
          title="Assistant (Alt+I)"
          onClick={() => {
            inspectorViewTouchedRef.current = true;
            setActiveInspectorView('assistant');
          }}
          className={cn(
            'flex h-7 items-center justify-center gap-1 rounded-sm px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
          tabIndex={activeInspectorView === 'outline' ? 0 : -1}
          title="Outline (Alt+O)"
          onClick={() => {
            inspectorViewTouchedRef.current = true;
            setActiveInspectorView('outline');
          }}
          className={cn(
            'flex h-7 items-center justify-center gap-1 rounded-sm px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeInspectorView === 'outline'
              ? 'panel-tab-active'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid="page-context-tab-outline"
        >
          <ListTree size={13} />
          Outline
        </button>
        <button
          type="button"
          role="tab"
          id="page-context-tab-notes"
          aria-controls="page-context-panel-notes"
          aria-selected={activeInspectorView === 'notes'}
          tabIndex={activeInspectorView === 'notes' ? 0 : -1}
          title="Notes (Alt+N)"
          onClick={() => {
            inspectorViewTouchedRef.current = true;
            setActiveInspectorView('notes');
          }}
          className={cn(
            'flex h-7 items-center justify-center gap-1 rounded-sm px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeInspectorView === 'notes'
              ? 'panel-tab-active'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid="page-context-tab-notes"
        >
          <MessageSquare size={13} />
          Notes
          {openNotesCount > 0 && (
            <span className="tabular-nums text-[11px] opacity-65">{openNotesCount}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          id="page-context-tab-details"
          aria-controls="page-context-panel-details"
          aria-selected={activeInspectorView === 'details'}
          tabIndex={activeInspectorView === 'details' ? 0 : -1}
          title="Details (Alt+D)"
          onClick={() => {
            inspectorViewTouchedRef.current = true;
            setActiveInspectorView('details');
          }}
          className={cn(
            'flex h-7 items-center justify-center gap-1 rounded-sm px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeInspectorView === 'details'
              ? 'panel-tab-active'
              : 'text-muted-foreground hover:text-foreground',
          )}
          data-testid="page-context-tab-details"
        >
          <FileText size={13} />
          Details
        </button>
        </div>

        <button
          onClick={isSheet ? onRequestClose : handleCollapseSidebar}
          className="flex shrink-0 items-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={isSheet ? 'Close page inspector' : 'Collapse page sidebar'}
          title={isSheet ? 'Close inspector' : 'Collapse sidebar (.)'}
        >
          <PanelRightClose size={14} />
        </button>
      </div>

      {assistantMounted && (
        <div
          id="page-context-panel-assistant"
          role="tabpanel"
          aria-labelledby="page-context-tab-assistant"
          className={cn(
            'flex min-h-0 flex-1 flex-col',
            activeInspectorView !== 'assistant' && 'hidden',
          )}
        >
          {/* `DockPanel` keeps its own composer, chips and thread; only its
              chrome changes. `variant="tab"` drops the header and close button
              it needed as a standalone column — this pane already has both, and
              two headers stacked was the giveaway that a column had been
              stuffed into a tab.

              Mounting it lazily on first open preserves #1126's provider economy: the
              panel is the only `AiContext` consumer, and it stays inert on an
              article the user never asks about. Once opened, it remains mounted
              (hidden via CSS when viewing Outline/Details) to preserve staged
              attachments and deep-search state during tab switching. */}
          <DockPanel variant="tab" onClose={() => setActiveInspectorView('outline')} />
        </div>
      )}

      {activeInspectorView === 'notes' && (
        <div
          id="page-context-panel-notes"
          role="tabpanel"
          aria-labelledby="page-context-tab-notes"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
        >
          <NotesInspectorPanel pageId={id} />
        </div>
      )}

      {activeInspectorView === 'details' && (
      <div
        id="page-context-panel-details"
        role="tabpanel"
        aria-labelledby="page-context-tab-details"
        className="min-h-0 flex-1 overflow-y-auto scroll-mask"
      >
      {isNewPage ? (
        <div className="px-3 py-4">
          <div className="text-[11px] font-semibold text-muted-foreground">New page draft</div>
          <p className="mt-2 text-xs text-muted-foreground">
            Configure space, title, and content, then click Create Page to publish.
          </p>
        </div>
      ) : page ? (
        <div className="px-3 py-4">
          <div className="text-[11px] font-semibold text-muted-foreground">Page details</div>
          {/* Label/value pairs, no rules. The dividers here drew six lines in a
              320px pane to separate rows that a 32px rhythm and the
              muted-label/ink-value contrast already separate — and the sections
              below ("Document health", "Labels") never had them. */}
          <dl className="mt-2 text-xs">
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-muted-foreground">Space</dt>
              <dd className="truncate font-medium text-foreground/85">{page.spaceKey}</dd>
            </div>
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="flex min-w-0 items-center gap-2 font-medium text-foreground/85">
                <span className="truncate">{page.source === 'standalone' ? 'Local' : 'Confluence'}</span>
                {canRelocate && !editing && (
                  <button
                    type="button"
                    onClick={() => setRelocateOpen(true)}
                    data-testid="relocate-btn"
                    title={
                      page.source === 'standalone'
                        ? 'Publish this article into a Confluence space'
                        : 'Pull this page out of Confluence into a local space'
                    }
                    className="shrink-0 text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    {page.source === 'standalone' ? 'Move to Confluence' : 'Move to a local space'}
                  </button>
                )}
              </dd>
            </div>
            {page.source === 'standalone' && (
              <div className="flex items-center justify-between gap-3 py-2">
                <dt className="text-muted-foreground">Visibility</dt>
                <dd className="flex items-center gap-1.5 font-medium text-foreground/85">
                  {page.visibility === 'shared' ? (
                    <><Globe size={13} className="text-muted-foreground" /> Shared</>
                  ) : (
                    <><Lock size={13} className="text-muted-foreground" /> Private</>
                  )}
                </dd>
              </div>
            )}
            {'hasDraft' in page && Boolean((page as Record<string, unknown>).hasDraft) && (
              <div className="flex items-center justify-between gap-3 py-2">
                <dt className="text-muted-foreground">Draft</dt>
                <dd className="flex items-center gap-1.5 font-medium text-foreground/85">
                  <AlertCircle size={13} className="text-muted-foreground" /> Unpublished draft
                </dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-muted-foreground">Type</dt>
              <dd className="flex items-center gap-1.5 font-medium text-foreground/85">
                {page.pageType === 'folder'
                  ? <><FolderOpen size={13} className="text-muted-foreground" /> Folder</>
                  : <><FileText size={13} className="text-muted-foreground" /> Article</>}
              </dd>
            </div>
            {page.author && (
              <div className="flex items-center justify-between gap-3 py-2">
                <dt className="text-muted-foreground">Author</dt>
                <dd className="truncate font-medium text-foreground/85">{page.author}</dd>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 py-2">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-medium tabular-nums text-foreground/85">v{page.version}</dd>
            </div>
          </dl>

          <div className="mt-4">
            <div className="text-[11px] font-semibold text-muted-foreground">Document health</div>
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid="document-health-badges">
              <span
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background/45 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                data-testid="verification-chip"
              >
                <ShieldCheck size={11} aria-hidden="true" />
                {verifiedDateStr ? `Verified ${verifiedDateStr}` : 'Not verified'}
              </span>
              <button
                type="button"
                onClick={() => { void handleVerify(); }}
                disabled={verifyMutation.isPending}
                data-testid="verify-btn"
                aria-busy={verifyMutation.isPending}
                className="text-[11px] font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
              >
                {verifyMutation.isPending ? 'Recording…' : 'Record verification'}
              </button>
              {verifyStatusMsg && (
                <span className="sr-only" role="status" aria-live="polite">
                  {verifyStatusMsg}
                </span>
              )}
              {page.lastModifiedAt && <FreshnessBadge lastModified={page.lastModifiedAt} />}
              <EmbeddingStatusBadge
                embeddingStatus={page.embeddingStatus}
                embeddingDirty={page.embeddingDirty}
                embeddedAt={page.embeddedAt}
                embeddingError={page.embeddingError}
                onRetry={handleReembed}
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
            </div>
          </div>

          {page.labels.length > 0 && (
            <div className="mt-4">
              <div className="text-[11px] font-semibold text-muted-foreground">Labels</div>
              <div className="mt-2 flex flex-wrap gap-1.5" data-testid="document-labels">
                {page.labels.map((label) => (
                  <span
                    key={label}
                    className="inline-flex items-center rounded-full border border-border bg-background/45 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}


      {page && id && aiAutoTagAvailable && editing && (
        <div className="px-2 pb-3 pt-5" data-testid="article-actions-edit">
          <div className="mb-1.5 px-1 text-[11px] font-semibold text-muted-foreground">
            Page actions
          </div>
          <AutoTagger
            pageId={id}
            currentLabels={page?.labels ?? []}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
          />
        </div>
      )}

      {!editing && page && (
        <div className="space-y-0.5 px-2 pb-3 pt-5" data-testid="article-actions">
          <div className="mb-1.5 px-1 text-[11px] font-semibold text-muted-foreground">
            Page actions
          </div>

          {id && (
            <VersionHistory
              pageId={id}
              renderTrigger={(historyOpen) => (
                <button
                  type="button"
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                    historyOpen
                      ? 'nav-selection font-medium'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                  title="Version history"
                >
                  <History size={15} className="shrink-0 opacity-70" />
                  <span className="truncate">Version history</span>
                </button>
              )}
            />
          )}

          <button
            onClick={handlePinToggle}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              isPinned
                ? 'nav-selection font-medium'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
            title={`${isPinned ? 'Unpin' : 'Pin'} (${formatKeysForPlatform(getShortcutHint('pin-page') ?? '', detectMac())})`}
          >
            <Pin size={15} className={cn('shrink-0 opacity-70', isPinned && 'fill-current opacity-100')} />
            <span className="truncate">{isPinned ? 'Pinned' : 'Pin'}</span>
          </button>

          <details className="group mt-3">
            <summary className="flex h-8 cursor-pointer list-none items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors marker:content-none hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight
                size={13}
                className="shrink-0 transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              <span className="flex-1">More actions</span>
              <span className="text-[11px] font-normal opacity-70">Maintenance &amp; AI</span>
            </summary>
            <div className="mt-1 space-y-0.5">
              {id && (
                <button
                  type="button"
                  onClick={() => navigate(`/graph?focus=${encodeURIComponent(id)}`)}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                  title="Show this page in the graph"
                  data-testid="show-in-graph-btn"
                >
                  <GitGraph size={15} className="shrink-0 opacity-70" />
                  <span className="truncate">Show in Graph</span>
                </button>
              )}

              {settings?.confluenceUrl && page.confluenceId && (
                <a
                  href={`${settings.confluenceUrl.replace(/\/+$/, '')}/pages/viewpage.action?pageId=${encodeURIComponent(page.confluenceId)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                >
                  <ExternalLink size={15} className="shrink-0 opacity-70" />
                  <span className="truncate">Open in Confluence</span>
                </a>
              )}

              <button
                onClick={handleExportPdf}
                disabled={exportPdf.isPending}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
                title="Export as PDF"
              >
                {exportPdf.isPending ? (
                  <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
                ) : (
                  <FileDown size={15} className="shrink-0 opacity-70" />
                )}
                <span className="truncate">Export PDF</span>
              </button>

              {id && aiAutoTagAvailable && (
                <AutoTagger
                  pageId={id}
                  currentLabels={page?.labels ?? []}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                />
              )}

              {/* Re-sync from Confluence — only for Confluence-sourced articles.
                  Locally-authored pages have no upstream to pull from. */}
              {page?.confluenceId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResync}
                  disabled={resyncMutation.isPending}
                  className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                  title="Re-sync from Confluence"
                  data-testid="article-resync-btn"
                  leftIcon={
                    <RefreshCw
                      size={15}
                      className={cn('shrink-0 opacity-70', resyncMutation.isPending && 'animate-spin')}
                    />
                  }
                >
                  <span className="truncate">Re-sync</span>
                </Button>
              )}

              <Button
                variant="ghost"
                size="sm"
                onClick={handleReembed}
                disabled={reembedMutation.isPending}
                className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                title="Re-embed for search"
                data-testid="article-reembed-btn"
                leftIcon={
                  reembedMutation.isPending ? (
                    <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
                  ) : (
                    <Cpu size={15} className="shrink-0 opacity-70" />
                  )
                }
              >
                <span className="truncate">Re-embed</span>
              </Button>

              <Button
                variant="ghost"
                size="sm"
                onClick={handleRequality}
                disabled={requalityMutation.isPending}
                className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
                title="Re-check quality"
                data-testid="article-requality-btn"
                leftIcon={
                  requalityMutation.isPending ? (
                    <Loader2 size={15} className="shrink-0 animate-spin opacity-70" />
                  ) : (
                    <Gauge size={15} className="shrink-0 opacity-70" />
                  )
                }
              >
                <span className="truncate">Re-check Quality</span>
              </Button>
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
            <Button
              variant="destructive-ghost"
              size="sm"
              onClick={handleDelete}
              className="nm-action-destructive mt-0.5 w-full justify-start gap-2"
              title={`Move to trash (${formatKeysForPlatform(getShortcutHint('delete-page') ?? '', detectMac())})`}
              leftIcon={<Trash2 size={15} className="shrink-0 opacity-70" />}
            >
              <span className="truncate">Move to trash</span>
            </Button>
          </details>
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
          <div className="px-3 pb-2 pt-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-foreground/85">On this page</div>
              <span className="text-[11px] tabular-nums text-muted-foreground">{Math.round(readingProgress)}%</span>
            </div>
            <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-foreground/8">
              <m.div
                className="h-full rounded-full bg-action"
                style={{ width: `${readingProgress}%` }}
                transition={{ duration: 0.12 }}
              />
            </div>
          </div>
        )}

        {/* Outline tree — with scroll mask */}
        <div
          ref={expandedTreeRef}
          className="mt-1 flex-1 overflow-y-auto p-2 scroll-mask"
          data-testid="article-outline-tree"
        >
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
          <div className="space-y-0.5" role="tree" aria-label="Article outline">
            {tree.map((node) => (
              <OutlineNodeItem
                key={node.heading.id}
                node={node}
                activeId={activeId}
                rovingId={rovingId}
                collapsedIds={collapsedIds}
                onNavigate={handleNavigate}
                onToggleCollapsed={handleToggleCollapsed}
                onKeyDown={(e, hid) => handleOutlineKeyDown(e, hid, expandedTreeRef)}
                onFocus={setExplicitRovingId}
              />
            ))}
          </div>
        )}
      </div>
      </div>
      )}

    </m.aside>
    {!isSheet && (
      <div
        role="separator"
        aria-label="Resize page sidebar"
        aria-orientation="vertical"
        aria-valuemin={ARTICLE_SIDEBAR_MIN_WIDTH}
        aria-valuemax={ARTICLE_SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onMouseDown={handleResizeStart}
        onDoubleClick={() => setWidth(ARTICLE_SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={handleResizeKeyDown}
        className={cn(
          'group absolute inset-y-0 left-0 z-10 cursor-col-resize outline-none',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
        style={{ width: 'var(--app-rail-gap)' }}
        title="Drag to resize · Double-click to reset"
      >
        <span
          data-testid="article-right-pane-resize-grip"
          className={cn(
            'pointer-events-none absolute top-1/2 -mt-[5px] flex flex-col gap-0.5 opacity-70 transition-opacity',
            'group-hover:opacity-100 group-focus-visible:opacity-100',
            isResizing && 'opacity-100',
          )}
          style={{ left: 'calc((var(--app-rail-gap) - 2px) / 2)' }}
          aria-hidden="true"
        >
          <span className="size-0.5 rounded-full bg-muted-foreground" />
          <span className="size-0.5 rounded-full bg-muted-foreground" />
          <span className="size-0.5 rounded-full bg-muted-foreground" />
        </span>
      </div>
    )}
    {confirmTrashDialog}
    {relocateDialog}
    </>
  );
}
