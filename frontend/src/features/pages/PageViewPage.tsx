import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { FileText, X, Save, ThumbsUp, ThumbsDown, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  usePage,
  useUpdatePage,
  useUpdatePageLabels,
  usePageFilterOptions,
  usePinnedPages,
  usePinPage,
  useUnpinPage,
  useDeletePage,
} from '../../shared/hooks/use-pages';
import { useSubmitFeedback } from '../../shared/hooks/use-standalone';
import { useAuthenticatedSrc } from '../../shared/hooks/use-authenticated-src';
import { useSettings } from '../../shared/hooks/use-settings';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../shared/hooks/use-keyboard-shortcuts';
import { useArticleViewStore } from '../../stores/article-view-store';
import { useAiDockStore } from '../../stores/ai-dock-store';
import { useAuthStore } from '../../stores/auth-store';
import { cn } from '../../shared/lib/cn';
import { FeatureErrorBoundary } from '../../shared/components/feedback/FeatureErrorBoundary';
import { Editor, EditorToolbar, EditorContextToolbars, clearDraft, getDraft } from '../../shared/components/article/Editor';
import type { Editor as EditorType } from '@tiptap/core';
import { drainPendingDrawioDiagrams } from '../../shared/components/article/drawio-save-drain';
import { ArticleViewer } from '../../shared/components/article/ArticleViewer';
import { DrawioEditor } from '../../shared/components/diagrams/DrawioEditor';
import { apiFetch, ApiError } from '../../shared/lib/api';
import { ArticleSummary } from '../../shared/components/article/ArticleSummary';
import { hasSubstantialLede } from '../../shared/lib/article-lede';
import type { TocHeading } from '../../shared/components/article/TableOfContents';
import { PageViewSkeleton } from '../../shared/components/feedback/Skeleton';
import { TagPopover } from '../../shared/components/TagPopover';
import { HeaderHost } from '../../shared/components/layout/header-slot';
import { AutoGrowTextarea } from '../../shared/components/AutoGrowTextarea';
import { ShortcutHint } from '../../shared/components/ShortcutHint';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { usePresence } from './use-presence';
import { PresenceAvatarStack } from './PresenceAvatarStack';

function ImageLightbox({
  alt,
  onClose,
  src,
}: {
  alt: string;
  onClose: () => void;
  src: string;
}) {
  const { blobSrc, loading } = useAuthenticatedSrc(src);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  // Move focus into the dialog on open and restore it to the trigger on close,
  // so keyboard/screen-reader users are not stranded behind the overlay (#942).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${alt}`}
    >
      <button
        ref={closeButtonRef}
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
        aria-label="Close preview"
      >
        <X size={18} />
      </button>

      {loading ? (
        <div className="text-sm text-white/70">Loading image…</div>
      ) : blobSrc ? (
        <img
          src={blobSrc}
          alt={alt}
          className="max-h-[90vh] max-w-[90vw] rounded-2xl object-contain"
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <div className="text-sm text-white/70">Failed to load image.</div>
      )}
    </m.div>
  );
}

function scrollArticleToTop() {
  const container = document.querySelector('[data-scroll-container]') as HTMLElement | null;
  if (!container) return;
  container.scrollTop = 0;
  container.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
  requestAnimationFrame(() => {
    container.scrollTop = 0;
    container.scrollTo?.({ top: 0, left: 0, behavior: 'auto' });
    // Double-rAF ensures we run after AnimatePresence exit animation completes
    requestAnimationFrame(() => {
      container.scrollTop = 0;
    });
  });
}

export function PageViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: page, isLoading, isError, error: pageError, refetch: refetchPage, isFetching: isRefetchingPage } = usePage(id);
  const { data: settings } = useSettings();
  const updateMutation = useUpdatePage();
  const labelsMutation = useUpdatePageLabels();
  const { data: filterOptions } = usePageFilterOptions();
  const { data: pinnedData } = usePinnedPages();
  const pinMutation = usePinPage();
  const unpinMutation = useUnpinPage();
  const deleteMutation_page = useDeletePage();

  const isPinned = pinnedData?.items.some((item) => item.id === id) ?? false;

  // Hide the helpfulness widget on standalone pages the current user authored
  // — rating your own page is noise. Confluence-synced pages (createdByUserId
  // is null) and other users' pages keep the widget.
  const currentUserId = useAuthStore((s) => s.user?.id);
  const isOwnStandalonePage =
    page?.source === 'standalone' &&
    page.createdByUserId != null &&
    currentUserId != null &&
    String(page.createdByUserId) === String(currentUserId);


  // Fetch the configured draw.io embed URL (falls back to default inside DrawioEditor if undefined)
  const { data: drawioSettings } = useQuery({
    queryKey: ['settings', 'drawio-url'],
    queryFn: () => apiFetch<{ drawioEmbedUrl: string }>('/settings/drawio-url'),
    staleTime: 10 * 60 * 1000,
  });

  const contentRef = useRef<HTMLDivElement>(null);
  const draftKey = id ? `page-${id}` : undefined;

  const setStoreHeadings = useArticleViewStore((s) => s.setHeadings);
  const setStoreEditing = useArticleViewStore((s) => s.setEditing);
  const openDock = useAiDockStore((s) => s.openDock);

  const [editing, setEditing] = useState(false);
  const [editorInstance, setEditorInstance] = useState<EditorType | null>(null);

  // `editHtml` seeds the editor's initial content when entering edit mode
  // (published body or a restored draft). It is NOT updated per keystroke —
  // the live HTML is read from `editorInstance.getHTML()` on save (#954).
  const [editHtml, setEditHtml] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [draftLabels, setDraftLabels] = useState<string[]>([]);
  // Dirty flag flipped by the editor's onChange (#954). A cheap boolean avoids
  // storing/serializing the whole document on every keystroke: after the first
  // change setIsDirty(true) is a no-op re-render, so typing no longer re-renders
  // this page.
  const [isDirty, setIsDirty] = useState(false);
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const previousPageIdRef = useRef(id);
  const [lightboxSrc, setLightboxSrc] = useState<{ alt: string; src: string } | null>(null);
  const [drawioEditingDiagram, setDrawioEditingDiagram] = useState<string | null>(null);
  const [drawioXml, setDrawioXml] = useState<string>('');
  const [confirmTrashOpen, setConfirmTrashOpen] = useState(false);
  // Discard-changes guard (#944): while true, the Cancel flow shows a
  // confirmation instead of dropping the in-progress edit.
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);
  // Draft awaiting a restore decision (ConfirmDialog replaces native confirm()).
  // While non-null, edit mode is deferred until the user picks a side.
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);

  const [headerNumbering, setHeaderNumbering] = useState(() =>
    localStorage.getItem('editor-header-numbering') === 'true',
  );

  const toggleHeaderNumbering = useCallback(() => {
    setHeaderNumbering((prev) => {
      localStorage.setItem('editor-header-numbering', String(!prev));
      return !prev;
    });
  }, []);

  // Sync editing state to the shared store (consumed by ArticleRightPane)
  useEffect(() => {
    setStoreEditing(editing);
  }, [editing, setStoreEditing]);

  // Real-time co-presence (#301). Propagates our editing flag to other viewers
  // via a 10s heartbeat so the pencil badge toggles for them within one tick.
  const { viewers: presenceViewers, setEditing: setPresenceEditing } = usePresence(id);
  useEffect(() => {
    setPresenceEditing(editing);
  }, [editing, setPresenceEditing]);

  // Sync headings to the shared store (consumed by ArticleRightPane)
  useEffect(() => {
    setStoreHeadings(headings);
  }, [headings, setStoreHeadings]);

  // Clean up store when unmounting
  useEffect(() => {
    return () => {
      useArticleViewStore.getState().setHeadings([]);
      useArticleViewStore.getState().setEditing(false);
    };
  }, []);

  // Reset page-local state whenever the :id route param changes (#872). The
  // /pages/:id route is not keyed, so React Router keeps this single
  // PageViewPage instance mounted across id changes — only useParams().id
  // and the react-query page object update. Without this reset, navigating
  // to page B mid-edit leaves page A's editing/editTitle/editHtml loaded,
  // so a subsequent Save (or Ctrl+S) would overwrite page B with page A's
  // title + body. Any open confirmation dialog is dismissed too: the
  // Discard/Trash dialogs live outside the `editing` branch, and a dialog
  // left open across navigation (e.g. Cancel then browser-Back) would run
  // its confirm action against page B's draftKey/id — clearing page B's
  // draft or trashing page B. Draft state is intentionally NOT cleared
  // here: the per-page localStorage draft is keyed by id and its
  // restore-on-edit feature must survive navigation.
  useEffect(() => {
    if (previousPageIdRef.current !== id) {
      previousPageIdRef.current = id;
      // ArticleViewer publishes the destination headings asynchronously.
      // Clear page A's structure immediately so the app-level inspector cannot
      // expose a stale Outline while page B is loading or has no headings.
      setHeadings([]);
      setStoreHeadings([]);
      setEditing(false);
      setEditHtml('');
      setEditTitle('');
      setDraftLabels([]);
      setIsDirty(false);
      setPendingDraft(null);
      setEditorInstance(null);
      setConfirmDiscardOpen(false);
      setConfirmTrashOpen(false);
    }
  }, [id, setStoreHeadings]);

  useLayoutEffect(() => {
    scrollArticleToTop();
  }, [id]);

  // Reset scroll to the top only on navigation-like transitions: a new page
  // id, or a genuine new revision (version bump). Keying off `page` object
  // identity — as this once did — reran on every in-place refetch (label
  // add/remove, resync, requality, drawio save all invalidate ['pages', id]
  // and hand React a fresh object with the same version), yanking the reader
  // back to the top mid-article (#943). The `if (!page) return` guard covers
  // the initial loading render.
  useEffect(() => {
    if (!page) return;
    scrollArticleToTop();
    // `page` is referenced only by the null guard; depending on its object
    // identity is exactly the bug (#943). Navigation is captured by id +
    // page?.version, so those are the only deps we want.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, page?.version]);

  const handleImageClick = useCallback((src: string, alt: string) => {
    setLightboxSrc({ alt, src });
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setLightboxSrc(null);
  }, []);

  const handleStartEditing = useCallback(() => {
    if (!page || !id) return;
    setEditTitle(page.title);
    setDraftLabels(page.labels ?? []);
    const draft = getDraft(`page-${id}`);
    if (draft && draft !== page.bodyHtml) {
      // Defer edit mode until the user decides in the ConfirmDialog below:
      // confirm restores the draft, the labeled cancel action edits the
      // published copy, and Escape/overlay dismissal stays in view mode.
      setPendingDraft(draft);
      return;
    }
    setEditHtml(page.bodyHtml);
    setIsDirty(false);
    setEditing(true);
  }, [id, page]);

  const handleRestoreDraft = useCallback(() => {
    if (pendingDraft === null) return;
    setEditHtml(pendingDraft);
    if (page?.labels) setDraftLabels(page.labels);
    // A restored draft diverges from the published page, so the editor is
    // dirty from the outset — Cancel must guard it and Save must persist it.
    setIsDirty(true);
    setPendingDraft(null);
    setEditing(true);
  }, [pendingDraft, page]);

  const handleDeclineDraft = useCallback(() => {
    setPendingDraft(null);
    if (!page) return;
    setEditHtml(page.bodyHtml);
    setDraftLabels(page.labels ?? []);
    setIsDirty(false);
    setEditing(true);
  }, [page]);

  // The editor is dirty when the title diverges from the persisted page, the
  // body was touched, or draft tag changes exist.
  const isEditorDirty = useCallback(() => {
    if (!page) return false;
    const currentLabels = page.labels ?? [];
    const labelsDiverged =
      draftLabels.length !== currentLabels.length ||
      draftLabels.some((l) => !currentLabels.includes(l));
    return editTitle !== page.title || isDirty || labelsDiverged;
  }, [page, editTitle, isDirty, draftLabels]);

  const discardAndExit = useCallback(() => {
    if (draftKey) clearDraft(draftKey);
    setIsDirty(false);
    setDraftLabels([]);
    setEditing(false);
  }, [draftKey]);

  // Cancel guards against silently throwing away unsaved work: when dirty it
  // opens the discard confirmation, otherwise it exits immediately. Backs the
  // Cancel button plus the Ctrl+E / Escape shortcuts (#944).
  const handleCancelEditing = useCallback(() => {
    if (isEditorDirty()) {
      setConfirmDiscardOpen(true);
      return;
    }
    discardAndExit();
  }, [isEditorDirty, discardAndExit]);

  const handleConfirmDiscard = useCallback(() => {
    setConfirmDiscardOpen(false);
    discardAndExit();
  }, [discardAndExit]);

  const handleSave = useCallback(async () => {
    if (!id || !page) return;
    try {
      // Flush any pending draw.io diagrams edited inside the TipTap
      // editor before we serialise + save (#302 Gap 3). Without this
      // the edited PNG ships as a huge base64 data URI inside body_html;
      // with it, the PNG is uploaded to the attachment store and the
      // body_html references the small server URL instead.
      const drain = await drainPendingDrawioDiagrams(editorInstance, {
        attachmentPageId: page.confluenceId ?? id,
        pageSource: page.confluenceId ? 'confluence' : 'standalone',
      });
      for (const msg of drain.errors) {
        toast.warning(msg);
      }
      if (!editorInstance) {
        toast.error('Editor instance is not ready. Please try again.');
        return;
      }
      // Read the live HTML straight off the editor instance (#954) — it's the
      // single source of truth for body content, and also reflects the
      // newly-committed draw.io node attributes from the drain above.
      const bodyToSave = editorInstance.getHTML();

      await updateMutation.mutateAsync({
        id,
        title: editTitle,
        bodyHtml: bodyToSave,
        version: page.version,
      });
      if (editing) {
        const currentLabels = page.labels ?? [];
        const addLabels = draftLabels.filter((l) => !currentLabels.includes(l));
        const removeLabels = currentLabels.filter((l) => !draftLabels.includes(l));
        if (addLabels.length > 0 || removeLabels.length > 0) {
          await labelsMutation.mutateAsync({ id, addLabels, removeLabels });
        }
      }
      if (draftKey) clearDraft(draftKey);
      setIsDirty(false);
      setDraftLabels([]);
      setEditing(false);
      const isConfluence = page.source === 'confluence' || Boolean(page.confluenceId);
      toast.success(isConfluence ? 'Page saved & synced to Confluence DC.' : 'Page saved.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save page.';
      if (message.includes('modified since you loaded')) {
        toast.error('Version conflict detected.', {
          action: {
            label: 'Reload',
            onClick: () => {
              queryClient.invalidateQueries({ queryKey: ['pages', id] });
              setEditing(false);
            },
          },
          duration: 10_000,
        });
      } else {
        toast.error(message);
      }
    }
  }, [draftKey, draftLabels, editTitle, editing, editorInstance, id, labelsMutation, page, queryClient, updateMutation]);

  // Draw.io inline editing handlers
  const handleEditDiagram = useCallback(async (diagramName: string) => {
    // Fetch the diagram PNG from the attachment cache — draw.io can load PNG+XML data URIs.
    // Confluence pages key attachments by confluence_id against /api/attachments; standalone
    // pages key by the numeric DB id against /api/local-attachments (#302 Gap 4). Without
    // this branch, standalone pages would 404 against the Confluence route.
    const attachmentPageId = page?.confluenceId ?? id;
    if (!attachmentPageId) return;
    const basePath = page?.confluenceId ? '/api/attachments' : '/api/local-attachments';
    let dataUri: string;
    try {
      const { accessToken } = (await import('../../stores/auth-store')).useAuthStore.getState();
      const res = await fetch(`${basePath}/${encodeURIComponent(attachmentPageId)}/${encodeURIComponent(diagramName)}.png`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        throw new Error(`Failed to load diagram: ${res.status}`);
      }
      const blob = await res.blob();
      dataUri = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      toast.error(`Failed to open draw.io editor: ${error instanceof Error ? error.message : 'Unknown error'}`, { duration: 8000 });
      return;
    }
    setDrawioXml(dataUri);
    setDrawioEditingDiagram(diagramName);
  }, [id, page?.confluenceId]);

  const handleDrawioClose = useCallback(() => {
    setDrawioEditingDiagram(null);
  }, []);

  const handleDrawioSave = useCallback(async (dataUri: string, xml: string) => {
    const attachmentPageId = page?.confluenceId ?? id;
    if (!attachmentPageId || !drawioEditingDiagram) return;
    const filename = `${drawioEditingDiagram}.png`;
    // Mirror the routing used by handleEditDiagram + drawio-save-drain so
    // standalone pages hit /api/local-attachments instead of 404-ing against
    // the Confluence route (#302 Gap 4).
    const basePath = page?.confluenceId ? '/attachments' : '/local-attachments';
    try {
      // Push BOTH the PNG and the .drawio XML (#302 Gap 2). Without the
      // XML, Confluence's native draw.io viewer has no way to re-open
      // the diagram for editing — it sees only the rendered image.
      // Routing branches on page.confluenceId so standalone pages hit
      // /api/local-attachments instead of 404-ing against the Confluence
      // route (#302 Gap 4).
      await apiFetch(`${basePath}/${encodeURIComponent(attachmentPageId)}/${encodeURIComponent(filename)}`, {
        method: 'PUT',
        body: JSON.stringify({ dataUri, xml }),
      });
      toast.success('Diagram saved.');
      // Refresh the page data so the updated diagram image is shown
      queryClient.invalidateQueries({ queryKey: ['pages', id] });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save diagram.';
      toast.error(message);
    }
  }, [id, page?.confluenceId, drawioEditingDiagram, queryClient]);

  const handleAddTag = useCallback((tag: string) => {
    if (!id) return;
    if (editing) {
      if (!draftLabels.includes(tag)) {
        setDraftLabels((prev) => [...prev, tag]);
        setIsDirty(true);
      }
      return;
    }
    labelsMutation.mutate(
      { id, addLabels: [tag] },
      { onError: () => toast.error('Failed to add tag.') },
    );
  }, [editing, draftLabels, id, labelsMutation]);

  const handleRemoveTag = useCallback((tag: string) => {
    if (!id) return;
    if (editing) {
      setDraftLabels((prev) => prev.filter((t) => t !== tag));
      setIsDirty(true);
      return;
    }
    labelsMutation.mutate(
      { id, removeLabels: [tag] },
      { onError: () => toast.error('Failed to remove tag.') },
    );
  }, [editing, id, labelsMutation]);

  const handlePinToggle = useCallback(() => {
    if (!id || !page) return;
    const mutation = isPinned ? unpinMutation : pinMutation;
    mutation.mutate(id, {
      onSuccess: () => toast.success(isPinned ? 'Unpinned.' : 'Pinned.'),
      onError: (error: unknown) => toast.error(error instanceof Error ? error.message : 'Pin update failed.'),
    });
  }, [id, isPinned, page, pinMutation, unpinMutation]);

  // Deleting soft-deletes into the 30-day trash, so the confirm copy must
  // not claim the action "cannot be undone". ConfirmDialog replaces the
  // native confirm() to match the neumorphic design system.
  const handleDeletePage = useCallback(() => {
    if (!id) return;
    setConfirmTrashOpen(true);
  }, [id]);

  const handleConfirmMoveToTrash = useCallback(async () => {
    if (!id) return;
    setConfirmTrashOpen(false);
    try {
      await deleteMutation_page.mutateAsync(id);
      navigate('/');
      toast.success('Page moved to trash.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to move page to trash.');
    }
  }, [deleteMutation_page, id, navigate]);

  // Page-specific keyboard shortcuts (Ctrl+S, Ctrl+E, Escape, Alt+P, Alt+Shift+D, Alt+I)
  const pageShortcuts = useMemo<ShortcutDefinition[]>(() => [
    {
      key: 'Ctrl+S',
      keys: ['s'],
      mod: true,
      description: 'Save current page',
      category: 'editor',
      action: () => {
        if (editing) handleSave();
      },
    },
    {
      key: 'Ctrl+E',
      keys: ['e'],
      mod: true,
      description: 'Toggle edit / view mode',
      category: 'editor',
      action: () => {
        if (editing) {
          handleCancelEditing();
        } else {
          handleStartEditing();
        }
      },
    },
    {
      key: 'Escape',
      keys: ['Escape'],
      description: 'Exit edit mode',
      category: 'editor',
      action: () => {
        // Kept as defence in depth now that the hook bails on
        // `defaultPrevented`: the two catch different things. The flag catches
        // any layer that dismisses on ESC (every Radix one does); this probe
        // catches the hand-rolled overlays that never call preventDefault —
        // AiDockSheet, ProviderEditModal, the mobile sidebar. On its own it is
        // unreliable, because a layer unmounted during the capture phase is
        // already gone from the DOM by the time this runs.
        if (document.querySelector('[role="dialog"]')) return;
        if (editing) handleCancelEditing();
      },
    },
    {
      key: 'Alt+P',
      keys: ['p'],
      alt: true,
      description: 'Pin/Unpin page',
      category: 'actions',
      action: handlePinToggle,
    },
    {
      key: 'Alt+Shift+D',
      keys: ['D', 'd'],
      alt: true,
      shift: true,
      description: 'Delete page',
      category: 'actions',
      action: handleDeletePage,
    },
    {
      key: 'Alt+I',
      keys: ['i'],
      alt: true,
      description: 'AI Assistant',
      category: 'actions',
      // #1126: opens the assistant beside the document instead of navigating to
      // /ai and leaving it. One of three call sites that used the same URL — the
      // other two are in ArticleRightPane's rail and expanded pane.
      // #1176: and opening is all it does — it no longer starts an improvement
      // the user did not ask for, which is why it is no longer called Improve.
      action: openDock,
    },
  ], [editing, handleSave, handleCancelEditing, handleStartEditing, handlePinToggle, handleDeletePage, openDock]);

  useKeyboardShortcuts(pageShortcuts);

  if (isLoading) {
    return (
      <m.div initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}>
        <PageViewSkeleton />
      </m.div>
    );
  }

  // GET /pages/:id deliberately returns a real 404 for BOTH "no such page" and
  // "you can't access this page's space" (pages-crud.ts) — collapsing them on
  // purpose so a permission check can't be used to probe which pages exist.
  // So "Page not found" is only the honest copy for an actual 404; a 500, a
  // dropped network, or any other failure is a different situation and used
  // to be misreported as this same screen with no retry (CLAUDE.md already
  // forbids exactly this pattern for usePageTree — this route never got the
  // fix). Only a confirmed non-404 failure gets the distinct "couldn't load"
  // treatment below; a 404, or any other case where the query settled with
  // no page, keeps the existing not-found copy.
  const loadFailed = isError && !(pageError instanceof ApiError && pageError.statusCode === 404);

  if (loadFailed) {
    return (
      <div className="nm-card flex min-h-[18rem] flex-col items-center justify-center gap-3 py-16 text-center" role="alert" data-testid="page-load-error">
        <div className="rounded-full bg-muted p-2.5">
          <AlertTriangle size={20} className="text-destructive" aria-hidden="true" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Couldn&rsquo;t load this page</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {pageError instanceof ApiError
            ? pageError.message
            : 'The request did not complete. This page is still there — try again.'}
        </p>
        <button
          onClick={() => refetchPage()}
          disabled={isRefetchingPage}
          className="inline-flex items-center gap-1.5 rounded-xl border border-action bg-transparent px-4 py-2 text-sm font-medium text-action transition-colors hover:bg-action hover:text-action-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          <RefreshCw size={14} className={cn(isRefetchingPage && 'animate-spin')} aria-hidden="true" />
          {isRefetchingPage ? 'Retrying' : 'Try again'}
        </button>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="nm-card flex min-h-[18rem] flex-col items-center justify-center gap-3 py-16 text-center">
        <FileText size={42} className="text-muted-foreground" />
        <h1 className="text-lg font-semibold text-foreground">Page not found</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The selected page is unavailable or no longer accessible in the synced space tree.
        </p>
        <button
          onClick={() => navigate('/')}
          className="rounded-xl border border-action bg-transparent px-4 py-2 text-sm font-medium text-action transition-colors hover:bg-action hover:text-action-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Return to pages
        </button>
      </div>
    );
  }

  const tagChip = (
    <TagPopover
      tags={editing ? draftLabels : (page.labels ?? [])}
      onAddTag={handleAddTag}
      onRemoveTag={handleRemoveTag}
      suggestions={filterOptions?.labels}
      isLoading={labelsMutation.isPending}
      iconOnly={editing}
    />
  );
  const sessionActions = (
    <>
      <button
        type="button"
        onClick={handleCancelEditing}
        title="Cancel editing (Esc)"
        aria-label="Cancel"
        className="nm-icon-button nm-action-destructive shrink-0"
        data-testid="cancel-edit-btn"
      >
        <X size={15} aria-hidden="true" />
      </button>
      <button
        onClick={handleSave}
        disabled={updateMutation.isPending}
        title="Save changes (Ctrl+S)"
        className="nm-button-primary shrink-0"
        data-testid="save-page-btn"
      >
        {updateMutation.isPending ? (
          <span className="animate-spin text-xs" aria-hidden="true">…</span>
        ) : (
          <Save size={15} aria-hidden="true" />
        )}
        {updateMutation.isPending ? 'Saving…' : 'Save'}
      </button>
    </>
  );

  return (
    <m.div
      // Enter at opacity:1 for the same reason as PageTransition: an interrupted
      // opacity tween could leave the article invisible ("black page"). Slide-up
      // alone carries the arrival feel.
      initial={{ opacity: 1, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      data-testid="article-page"
    >
      {/* Sticky article chassis — same 48px bar in both modes. Write fills
          it with format tools + the tag chip + Cancel/Save. Read keeps the
          bar: labels as pills (not a count button) on the left, Edit on the
          right at the toolbar's 32px control size. Operate verbs stay in
          the inspector. The 48px app header keeps the title for wayfinding. */}
      <div className="sticky -top-5 z-30 isolate -mt-5">
        {/* Under-mask: behind the toolbar (z-[-1]), covering the toolbar's
            box AND the strip of scroll-container padding above it.

            A sticky box does NOT pin at the scrollport's top edge when the
            scroll container has top padding: it is clamped to its
            containing block, which begins *after* that padding. Measured in
            Chromium, the stuck toolbar's top is AppLayout's scroll-container
            content-box top — 20px (its pt-5) below the scrollport edge — so
            article content scrolls up through that strip in full view before
            the scrollport clips it (#1186). `-top-5` must therefore track
            that `pt-5`; scroll-padding-mask.test.ts fails if they diverge.

            Only the block-start edge overhangs. Block-start overflow is
            clipped by the scrollport and adds no scrollable height, unlike
            the block-end overhang that inflated /ai's page height (#769).
            It is deliberately NOT pointer-events-none: the padding strip is
            paint with nothing else in it, and a mask that opts out of
            hit-testing there hands clicks to the editor content it just hid. */}
        <div
          aria-hidden
          data-testid="edit-toolbar-mask"
          className="absolute inset-x-0 -top-5 bottom-0 z-[-1] bg-card"
        />
        <div className="-mx-4 border-b border-border bg-card sm:-mx-6 relative">
          {editing && editorInstance ? (
            <div className="mx-auto max-w-[1200px] px-5 sm:px-10">
              <EditorToolbar
                editor={editorInstance}
                headerNumbering={headerNumbering}
                onToggleHeaderNumbering={toggleHeaderNumbering}
                pageProperty={tagChip}
                actions={sessionActions}
              />
            </div>
          ) : (
            <div
              className={cn(
                'mx-auto flex min-h-[calc(3rem-1px)] max-w-[1200px] items-center gap-1.5 px-5 sm:px-10',
                editing && 'justify-end',
              )}
              {...(!editing
                ? {
                    'data-testid': 'article-read-toolbar',
                    role: 'toolbar',
                    'aria-label': 'Article actions',
                  }
                : {})}
            >
              {editing ? (
                <>
                  {tagChip}
                  {sessionActions}
                </>
              ) : (
                <>
                  {(page.labels ?? []).length > 0 && (
                    <div
                      className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden"
                      data-testid="article-tags-readonly"
                    >
                      {(page.labels ?? []).map((label) => (
                        <span
                          key={label}
                          className="inline-flex h-8 shrink-0 items-center rounded-full border border-border bg-background/45 px-2.5 text-xs font-medium text-muted-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    <PresenceAvatarStack viewers={presenceViewers} />
                    <button
                      type="button"
                      onClick={handleStartEditing}
                      className="nm-button-ghost h-8 shrink-0 px-2.5 text-xs"
                      data-testid="edit-page-btn"
                    >
                      Edit
                      <ShortcutHint shortcutId="toggle-edit" />
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {editing && editorInstance && (
            <EditorContextToolbars
              editor={editorInstance}
              innerClassName="mx-auto max-w-[1200px] px-5 sm:px-10"
            />
          )}
        </div>
      </div>
      <div>
        {!editing && (
          <HeaderHost fallbackClassName="mb-1 min-w-0 truncate text-[15px] font-semibold sm:text-lg">
            <span className="min-w-0 truncate text-[15px] font-semibold text-foreground sm:text-lg">
              {page.title}
            </span>
          </HeaderHost>
        )}

        {editing ? (
          <>
            <div className="mx-auto max-w-[1200px] px-5 pt-4 sm:px-10">
                {/* Same column and top inset as the read-mode <h1>. Type ramp
                    is copied verbatim so the title does not resize or re-wrap
                    when you toggle Edit. `p-0` kills the UA textarea padding
                    so the first line sits on the same baseline as the h1. */}
                <AutoGrowTextarea
                  value={editTitle}
                  onValueChange={setEditTitle}
                  className="mb-4 p-0 text-3xl font-bold leading-[1.2] tracking-[-0.02em] text-foreground placeholder:text-muted-foreground/40 sm:text-4xl"
                  placeholder="Page title…"
                  aria-label="Page title"
                  data-testid="edit-title-input"
                />
            </div>

            {/* Editor body — same 1200px reading column so the editing
                experience matches the reader's line length exactly. */}
            <div className={cn('mx-auto max-w-[1200px] px-5 sm:px-10', headerNumbering && 'header-numbering')}>
              <FeatureErrorBoundary featureName="Editor">
                <Editor content={editHtml} onChange={() => setIsDirty(true)} draftKey={draftKey} naked onEditorReady={setEditorInstance} hideToolbar pageId={id} onSave={handleSave} />
              </FeatureErrorBoundary>
            </div>
          </>
        ) : !page.bodyHtml?.trim() || page.bodyHtml.trim() === '<p></p>' ? (
          /* Empty page — no content yet */
          <div
            ref={contentRef}
            className="mx-auto max-w-[1200px] px-5 pb-16 pt-4 sm:px-10"
            data-testid="article-content-shell"
          >
            <h1 className="mb-6 text-3xl font-bold leading-[1.2] tracking-[-0.02em] text-foreground sm:text-4xl">
              {page.title}
            </h1>
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <FileText size={48} className="text-muted-foreground/30" />
              <p className="text-muted-foreground">This page has no content yet.</p>
              <button
                type="button"
                onClick={handleStartEditing}
                className="rounded-xl border border-action bg-transparent px-4 py-2 text-sm font-medium text-action transition-colors hover:bg-action hover:text-action-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="add-content-btn"
              >
                Add content
              </button>
            </div>
          </div>
        ) : (
          /* Reading view — constrained to 1200px reading column */
          <div
            ref={contentRef}
            className="mx-auto max-w-[1200px] px-5 pb-16 pt-4 sm:px-10"
            data-testid="article-content-shell"
          >
            <h1 className="mb-4 text-3xl font-bold leading-[1.2] tracking-[-0.02em] text-foreground sm:text-4xl">
              {page.title}
            </h1>

            {page.summaryStatus && (
              <ArticleSummary
                // Keyed on the page so navigating between articles remounts the
                // block; without it React reconciles by position and one page's
                // collapse state would carry onto the next.
                key={page.id}
                pageId={page.id}
                summaryHtml={page.summaryHtml}
                summaryStatus={page.summaryStatus}
                summaryGeneratedAt={page.summaryGeneratedAt}
                summaryModel={page.summaryModel}
                summaryError={page.summaryError}
                lastModifiedAt={page.lastModifiedAt}
                // When the article opens with a lede of its own, that lede is
                // the author's summary and should win the first screen.
                deferToLede={hasSubstantialLede(page.bodyHtml)}
              />
            )}

            <FeatureErrorBoundary featureName="Page Viewer">
              <ArticleViewer
                content={page.bodyHtml}
                confluenceUrl={settings?.confluenceUrl}
                onImageClick={handleImageClick}
                onEditDiagram={handleEditDiagram}
                onHeadingsReady={setHeadings}
                pageId={id}
                confluencePageId={page.confluenceId}
              />
            </FeatureErrorBoundary>

            {/* Feedback widget — hidden on the author's own standalone pages */}
            {!isOwnStandalonePage && <FeedbackWidget pageId={id} />}
          </div>
        )}
      </div>

      <AnimatePresence>
        {lightboxSrc ? (
          <ImageLightbox
            alt={lightboxSrc.alt}
            onClose={handleCloseLightbox}
            src={lightboxSrc.src}
          />
        ) : null}
      </AnimatePresence>

      {drawioEditingDiagram && (
        <DrawioEditor
          xml={drawioXml}
          onSave={handleDrawioSave}
          onClose={handleDrawioClose}
          drawioUrl={drawioSettings?.drawioEmbedUrl}
        />
      )}

      <ConfirmDialog
        open={confirmTrashOpen}
        title="Move page to trash?"
        description="It can be restored from Trash for 30 days, then it is permanently deleted."
        confirmLabel="Move to trash"
        destructive
        onConfirm={handleConfirmMoveToTrash}
        onCancel={() => setConfirmTrashOpen(false)}
      />

      {/* Discard changes — guards the Cancel path when the editor is dirty
          (#944). Confirming runs the original clearDraft + exit; Cancel /
          Escape / overlay just close the dialog and stay in edit mode so the
          in-progress work (e.g. a full AI rewrite) is not lost. */}
      <ConfirmDialog
        open={confirmDiscardOpen}
        title="Discard changes?"
        description="This page has unsaved changes. Discarding them cannot be undone."
        confirmLabel="Discard changes"
        cancelLabel="Keep editing"
        destructive
        onConfirm={handleConfirmDiscard}
        onCancel={() => setConfirmDiscardOpen(false)}
        onDismiss={() => setConfirmDiscardOpen(false)}
      />

      {/* Draft restore — drafts are autosaved to localStorage on this device
          while editing. Restoring is non-destructive; the labeled cancel
          action opens the editor on the published content. Escape/overlay
          stay neutral (onDismiss): entering edit mode would let autosave
          start overwriting the stored draft, a side effect nobody chose.
          No destructive styling: the draft is only overwritten by continued
          editing, never deleted here. */}
      <ConfirmDialog
        open={pendingDraft !== null}
        title="Restore draft?"
        description="An unsaved draft of this page was found in this browser. Restore it to continue where you left off, or edit the published version instead (the draft is overwritten as you edit)."
        confirmLabel="Restore draft"
        cancelLabel="Edit published version"
        onConfirm={handleRestoreDraft}
        onCancel={handleDeclineDraft}
        onDismiss={() => setPendingDraft(null)}
      />
    </m.div>
  );
}

function FeedbackWidget({ pageId }: { pageId: string | undefined }) {
  const [submitted, setSubmitted] = useState(false);
  const numericId = pageId ? Number(pageId) : 0;
  const submitFeedback = useSubmitFeedback(numericId);

  const handleFeedback = async (isHelpful: boolean) => {
    if (!pageId) return;
    try {
      await submitFeedback.mutateAsync({ isHelpful });
      setSubmitted(true);
      toast.success('Thank you for your feedback!');
    } catch {
      toast.error('Failed to submit feedback');
    }
  };

  if (submitted) {
    return (
      <div className="mt-12 border-t border-border pt-6 text-center" data-testid="feedback-widget">
        <p className="text-sm text-muted-foreground">Thanks for your feedback!</p>
      </div>
    );
  }

  return (
    <div className="mt-12 border-t border-border pt-6" data-testid="feedback-widget">
      <p className="mb-3 text-sm font-medium text-muted-foreground">Was this page helpful?</p>
      {/* Neutral controls, deliberately. Yes/No is a survey answer, not a
          state readout — green/red here borrowed the connected/disconnected
          vocabulary for the least consequential control on the page (the
          measurement badges). The glyphs differentiate; press feedback comes
          from the shared quiet-button recipe. */}
      <div className="flex gap-2">
        <button
          onClick={() => handleFeedback(true)}
          disabled={submitFeedback.isPending}
          className="nm-button-ghost disabled:opacity-50"
          data-testid="feedback-helpful"
        >
          <ThumbsUp size={14} /> Yes
        </button>
        <button
          onClick={() => handleFeedback(false)}
          disabled={submitFeedback.isPending}
          className="nm-button-ghost disabled:opacity-50"
          data-testid="feedback-not-helpful"
        >
          <ThumbsDown size={14} /> No
        </button>
      </div>
    </div>
  );
}


