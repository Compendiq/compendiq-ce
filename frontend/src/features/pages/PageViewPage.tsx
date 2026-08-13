import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { FileText, X, Upload, Download, ShieldCheck, Globe, Lock, ThumbsUp, ThumbsDown, AlertCircle, GitGraph } from 'lucide-react';
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
import { useSubmitFeedback, useVerifyPage } from '../../shared/hooks/use-standalone';
import { usePermission } from '../../shared/hooks/use-permission';
import { useAuthenticatedSrc } from '../../shared/hooks/use-authenticated-src';
import { useSettings } from '../../shared/hooks/use-settings';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../shared/hooks/use-keyboard-shortcuts';
import { useArticleViewStore } from '../../stores/article-view-store';
import { useAiDockStore } from '../../stores/ai-dock-store';
import { useAuthStore } from '../../stores/auth-store';
import { cn } from '../../shared/lib/cn';
import { FeatureErrorBoundary } from '../../shared/components/feedback/FeatureErrorBoundary';
import { QualityScoreBadge } from '../../shared/components/badges/QualityScoreBadge';
import { Editor, EditorToolbar, TableContextToolbar, LayoutContextToolbar, ColumnContextToolbar, clearDraft, getDraft } from '../../shared/components/article/Editor';
import type { Editor as EditorType } from '@tiptap/core';
import { drainPendingDrawioDiagrams } from '../../shared/components/article/drawio-save-drain';
import { ArticleViewer } from '../../shared/components/article/ArticleViewer';
import { DrawioEditor } from '../../shared/components/diagrams/DrawioEditor';
import { apiFetch } from '../../shared/lib/api';
import { ArticleSummary } from '../../shared/components/article/ArticleSummary';
import { hasSubstantialLede } from '../../shared/lib/article-lede';
import type { TocHeading } from '../../shared/components/article/TableOfContents';
import { PageViewSkeleton } from '../../shared/components/feedback/Skeleton';
import { TagPopover } from '../../shared/components/TagPopover';
import { neutralChipClass } from '../../shared/components/badges/neutral-chip';
import { AutoGrowTextarea } from '../../shared/components/AutoGrowTextarea';
import { ShortcutHint } from '../../shared/components/ShortcutHint';
import { ConfirmDialog } from '../../shared/components/ConfirmDialog';
import { usePresence } from './use-presence';
import { PresenceAvatarStack } from './PresenceAvatarStack';
import { RelocateDialog } from './RelocateDialog';

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

  const { data: page, isLoading } = usePage(id);
  const { data: settings } = useSettings();
  const updateMutation = useUpdatePage();
  const labelsMutation = useUpdatePageLabels();
  const { data: filterOptions } = usePageFilterOptions();
  const { data: pinnedData } = usePinnedPages();
  const pinMutation = usePinPage();
  const unpinMutation = useUnpinPage();
  const deleteMutation_page = useDeletePage();

  // #1123. A dedicated global permission, seeded onto editor / space_admin by
  // migration 086. The control is hidden rather than disabled when denied: CE
  // ships no UI for granting permissions, so a denied user has no in-product
  // path to earning it, and the preview endpoint is gated on the same
  // permission — a rendered control would 403 the moment it was used.
  const { allowed: canRelocate } = usePermission('pages:relocate');

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
  // Relocate between a local space and Confluence (#1123).
  const [relocateOpen, setRelocateOpen] = useState(false);

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
      setRelocateOpen(false);
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
      // Read the live HTML straight off the editor instance (#954) — it's the
      // single source of truth for body content, and also reflects the
      // newly-committed draw.io node attributes from the drain above. The
      // `editHtml` seed is only a fallback for the (practically unreachable)
      // case where the editor instance isn't ready.
      const bodyToSave = editorInstance?.getHTML() ?? editHtml;

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
  }, [draftKey, draftLabels, editHtml, editTitle, editing, editorInstance, id, labelsMutation, page, queryClient, updateMutation]);

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
      {/* Sticky toolbar with an UNDER-mask that sits behind the toolbar at
          a lower z-index. The mask is opaque bg-background, so article
          content scrolling under the translucent toolbar is fully occluded
          rather than showing through its rounded-corner cutouts. */}
      {editing && (
        <div className="sticky top-0 z-30 isolate">
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
              the block-end overhang that inflated /ai's page height (#769) —
              so bottom/left/right stay flush on the toolbar's box. The fill
              stays flat bg-background rather than a copy of the gradient
              --surface-backdrop: at this height the radial has all but
              resolved to --color-background (measured max delta 3/255 in
              Graphite, 2/255 in Paper, and exact at the column
              edges), while a re-declared gradient can only line up with the
              app shell's via background-attachment: fixed, which silently
              re-anchors to the framer-motion transform on this very element.
              Rounded bottom corners keep the mask in the toolbar's
              silhouette.

              It is deliberately NOT pointer-events-none. Hit-testing follows
              paint order, so over the toolbar's own box the card below still
              takes every click (measured: the Save button and the toolbar body
              keep their hits) — but the padding strip is paint with nothing
              else in it, and a mask that opts out of hit-testing there hands
              clicks to the editor content it just hid: a click 2px above the
              toolbar landed in invisible prose, jumping the caret or toggling
              an unseen task checkbox. What is occluded to the eye has to be
              occluded to the pointer. */}
          <div
            aria-hidden
            data-testid="edit-toolbar-mask"
            className="absolute inset-x-0 -top-5 bottom-0 z-[-1] bg-card"
          />
        {/* The edit toolbar is a bar across the column now, not a floating
            card: it loses the border and radius and keeps only a bottom
            hairline, matching the context strip above it. The under-mask fill
            follows the surface it hides content against — that is `bg-card`
            here, because on an article route the main column IS the pane; it
            was `bg-background`, which would now paint a chassis-coloured band
            across a white document. `-top-5` still tracks the scroll
            container's `pt-5` (scroll-padding-mask.test.ts). */}
        <div className="-mx-4 border-b border-border bg-card sm:-mx-6">
          {editorInstance && (
            <div className="border-b border-border">
              {/* Aligned to the document's text column, not to the window.
                  The arithmetic: these bars are full-bleed (`-mx-4 sm:-mx-6`),
                  so they cancel AppLayout's scroll padding and must add it
                  back — 24px (sm:px-6) + the body's own 40px (sm:px-10) = 64px,
                  and the max-width grows by the same 48px so the right edge
                  lands with it too. Below sm: 16 + 20 = 36px.
                  Edge-to-edge the controls floated free of the text they act
                  on, which is the tell that a toolbar was bolted above a
                  document rather than belonging to it. */}
              <div className="mx-auto max-w-[1248px] px-9 sm:px-16">
                <EditorToolbar editor={editorInstance} />
                <TableContextToolbar editor={editorInstance} />
                <LayoutContextToolbar editor={editorInstance} />
                <ColumnContextToolbar editor={editorInstance} />
              </div>
            </div>
          )}
          {/* Action row — one line of controls, pinned to the same 48px as the
              header, the sidebar header, the inspector header and the context
              strip directly below.

              It used to be ~92px, because `TagEditor` rendered open here and
              stacks a pill row, a 12px gap and an input row. It is a chip now
              (`TagPopover`), which also stops the row mixing three scopes at
              equal weight: the toolbar above acts on the selection, the chip on
              the page, Cancel/Save on the session.

              The 48px is DECLARED, not derived, exactly as the context strip
              below declares it — and for the same reason. Measured in Chromium,
              `nm-button-primary` and `nm-button-ghost` are 34px, not the 32px
              their comments claim: both add a 1px border outside a 6+20+6 box,
              and only `nm-icon-button` sets an explicit 2rem. Deriving the row
              from padding therefore lands on 50px, and chasing 48 by trimming
              padding would break again the moment a control's border changed.

              The `-1px` is the same arithmetic the context strip documents: the
              hairline sits on the sticky parent, not on this row, so without
              subtracting it the row measures 49 and its rule falls one pixel
              below the other three — the exact seam this alignment exists to
              remove.

              `items-center`, not `items-end` — that was there to hide the tag
              stack's ragged bottom edge, and with three equal-height controls it
              would now push them all low. */}
          <div className="mx-auto flex min-h-[calc(3rem-1px)] max-w-[1248px] items-center gap-3 px-9 py-1.5 sm:px-16">
            <div className="min-w-0 flex-1">
              <TagPopover
                tags={editing ? draftLabels : page.labels}
                onAddTag={handleAddTag}
                onRemoveTag={handleRemoveTag}
                suggestions={filterOptions?.labels}
                isLoading={labelsMutation.isPending}
              />
            </div>
            <button
              onClick={handleCancelEditing}
              // Measured to 34px, matching the chip and Save exactly: 6 + 20 + 6
              // plus a 1px transparent border, which is how `nm-button-primary`
              // reaches the same figure. It was `py-2` and 36px; `items-end`
              // used to hide the mismatch by bottom-aligning both against the
              // tall tag block, and with that block gone it would be a visible
              // step between two adjacent buttons. The border is load-bearing
              // arithmetic, not decoration — dropping it leaves this 2px short.
              className="shrink-0 rounded-md border border-transparent px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={updateMutation.isPending}
              // Filled: Save is the primary action of edit mode, and Cancel
              // sits directly beside it. An outlined pair made the destructive
              // choice and the committing one look identical.
              className="nm-button-primary shrink-0"
            >
              {updateMutation.isPending ? 'Saving…' : 'Save'}
              {/* Ink that belongs to the fill. The default chip is
                  `text-muted-foreground` on `bg-background/50`, tuned for a
                  neutral surface — on the filled primary it is the
                  lowest-contrast text in the frame. */}
              {!updateMutation.isPending && (
                <ShortcutHint
                  shortcutId="save"
                  className="border-primary-foreground/30 bg-transparent text-primary-foreground"
                />
              )}
            </button>
          </div>
        </div>
        </div>
      )}
      {/* No card. The document sits directly on the main column, which carries
          the pane surface for this route (see AppLayout). A rounded, bordered
          panel floating on the chassis framed the page as an object on a desk;
          full-bleed, it reads as the surface you are working on.

          `overflow-hidden` went with it — it was there to clip content to the
          rounded corners, and an overflow-hidden ancestor also breaks the
          sticky positioning the strip below now relies on. */}
      <div className={cn(editing && 'mt-4')}>
        {/* Breadcrumb / action strip */}
        {/* `flex-wrap`: the badge cluster and the action cluster are both
            unshrinkable, so at 390px they overlapped — "Local / Shared /
            Skipped" rendered on top of "Move to Confluence / Verify / Graph".
            Wrapping drops the actions onto their own line instead of hiding
            either group; on this surface both are worth their vertical space,
            unlike the list row where the same badges are one tap from here. */}
        {/* Sticky context strip. Without the card's border to sit inside, it
            needs its own hairline and its own surface to stay legible over
            scrolling prose — and it pins to the top of the reading column
            rather than scrolling away, because the page identity and Edit are
            wanted at any scroll depth.

            Its contents take the document's own `max-w-[1200px] px-5 sm:px-10`
            measure, so the space key and the Edit button line up with the
            body text instead of hugging the window edges. */}
        {/* Hidden while editing. Its action half is already suppressed there
            (Cancel/Save take over in the bar above), leaving only badges — so
            it wedged a strip of read-only status between the save controls and
            the title you are typing into. The badges return on save. */}
        <div className={cn('sticky -top-5 z-20 -mx-4 -mt-5 border-b border-border bg-card sm:-mx-6', editing && 'hidden')}>
        {/* A fixed minimum rather than "whatever the content plus padding came
            out to": this rule, the left sidebar's and the inspector's are one
            line running across the app, so all three are pinned to the same
            48px. `min-h` not `h`, because this row wraps at narrow widths (the
            badge cluster and the action cluster each take a line) and a fixed
            height would clip the second one.

            The `-1px` is not a fudge. The sidebar and inspector rows put their
            `border-b` on the same element as their `h-12`, so under border-box
            the hairline is *inside* the 48. Here the border is on the sticky
            parent and the height is on this inner row, so without subtracting
            it the strip measures 49 and its rule sits one pixel below the other
            two — which is exactly the seam this alignment exists to remove. */}
        <div className="mx-auto flex min-h-[calc(3rem-1px)] max-w-[1248px] flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-9 py-2 sm:px-16">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground/60">
            <FileText size={12} className="shrink-0" />
            {page.spaceKey !== '__local__' && <span className="truncate">{page.spaceKey}</span>}
            {/* Source badge. Neutral, like Private below: a source is a
                category, not a state — the label differentiates. Same recipe
                as the PagesPage rows, so the same badge cannot drift between
                the two surfaces; the measured rationale lives in
                neutral-chip.ts. */}
            {page.source === 'standalone' ? (
              <span className={neutralChipClass} data-testid="badge-local">
                Local
              </span>
            ) : (
              <span className={neutralChipClass} data-testid="badge-confluence">
                Confluence
              </span>
            )}
            {/* Visibility badge for standalone articles */}
            {page.source === 'standalone' && (
              page.visibility === 'shared' ? (
                <span className={neutralChipClass} data-testid="badge-shared">
                  <Globe size={10} /> Shared
                </span>
              ) : (
                // Private = neutral gray. Was amber, but privacy carries no AI semantic.
                <span className={neutralChipClass} data-testid="badge-private">
                  <Lock size={10} /> Private
                </span>
              )
            )}
            {/* Draft indicator — neutral private-tier palette (drafts read as personal/private state, not AI). */}
            {'hasDraft' in page && Boolean((page as Record<string, unknown>).hasDraft) && (
              <span className={neutralChipClass} data-testid="badge-draft">
                <AlertCircle size={10} /> Draft
              </span>
            )}
            <QualityScoreBadge
              qualityScore={page.qualityScore ?? null}
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
          </span>

          {/* Two tiers. The secondaries wrap among themselves; Edit is a
              sibling of that group and `shrink-0`, so it stays pinned at the
              end of the row instead of being the thing that wraps away. */}
          <div className="flex items-center gap-1.5">
            <PresenceAvatarStack viewers={presenceViewers} className="mr-1" />
            {editing ? null : (
              <>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                {/* Relocate between a local space and Confluence (#1123).
                    Replaces the "Publish to Confluence coming soon" stub,
                    which also gated on the retired `__local__` sentinel —
                    standalone pages carry a real local space key (or null)
                    now, so `source` is the only correct discriminator. */}
                {canRelocate && (
                  <button
                    onClick={() => setRelocateOpen(true)}
                    className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                    data-testid="relocate-btn"
                    title={
                      page.source === 'standalone'
                        ? 'Publish this article into a Confluence space'
                        : 'Pull this page out of Confluence into a local space'
                    }
                  >
                    {page.source === 'standalone' ? (
                      <>
                        <Upload size={12} className="mr-1 inline" />
                        <span className="max-lg:hidden">Move to Confluence</span>
                        <span className="lg:hidden">Move</span>
                      </>
                    ) : (
                      <>
                        <Download size={12} className="mr-1 inline" />
                        <span className="max-lg:hidden">Move to local space</span>
                        <span className="lg:hidden">Move</span>
                      </>
                    )}
                  </button>
                )}
                {/* Verify button */}
                <VerifyButton pageId={id} />
                <button
                  onClick={() => navigate(`/graph?focus=${encodeURIComponent(id ?? '')}`)}
                  className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                  data-testid="show-in-graph-btn"
                  title="Show in knowledge graph"
                >
                  <GitGraph size={12} className="mr-1 inline" />
                  <span className="max-sm:hidden">Graph</span>
                </button>
                </div>

                {/* Edit is the primary action on this route and used to be its
                    quietest control: 12px ghost text in a ~24px box, identical
                    in weight to Relocate/Verify/Graph beside it, and last in a
                    wrapping row — so at 834px and 390px it landed alone on a
                    second line, below the 44px thumb minimum, on the half of
                    the route the authoring audience exists for. The comment
                    above already called it "the most used control on the page";
                    `flex-wrap` fixed the clipping it described, not the
                    hierarchy.

                    A bordered secondary button, deliberately NOT the filled
                    primary: ADR-010 keeps the accent for actions and the only
                    filled teal on this route belongs to the setup banner, so a
                    second one would just move the competition rather than end
                    it. `shrink-0` and outside the wrapping group, so the
                    secondaries wrap among themselves and Edit stays pinned. */}
                <button
                  onClick={handleStartEditing}
                  className="nm-button-ghost shrink-0 max-sm:min-h-11"
                  data-testid="edit-page-btn"
                >
                  Edit
                  <ShortcutHint shortcutId="toggle-edit" />
                </button>
              </>
            )}
          </div>
        </div>
        </div>

        {editing ? (
          <>
            <div className="border-b border-border py-5">
              <div className="mx-auto max-w-[1200px] px-5 sm:px-10">
                {/* Type ramp is copied from the read-mode <h1> verbatim
                    (`text-3xl sm:text-4xl leading-[1.2] tracking-[-0.02em]`) so
                    the title does not resize or re-wrap when you toggle Edit. */}
                <AutoGrowTextarea
                  value={editTitle}
                  onValueChange={setEditTitle}
                  className="text-3xl font-bold leading-[1.2] tracking-[-0.02em] text-foreground placeholder:text-muted-foreground/40 sm:text-4xl"
                  placeholder="Page title…"
                  aria-label="Page title"
                  data-testid="edit-title-input"
                />
              </div>
            </div>

            {/* Editor body — same 1200px reading column so the editing
                experience matches the reader's line length exactly. */}
            <div className="mx-auto max-w-[1200px]">
              <FeatureErrorBoundary featureName="Editor">
                <Editor content={editHtml} onChange={() => setIsDirty(true)} draftKey={draftKey} naked onEditorReady={setEditorInstance} hideToolbar pageId={id} onSave={handleSave} />
              </FeatureErrorBoundary>
            </div>
          </>
        ) : !page.bodyHtml?.trim() || page.bodyHtml.trim() === '<p></p>' ? (
          /* Empty page — no content yet */
          <div
            ref={contentRef}
            className="mx-auto max-w-[1200px] px-5 pb-16 pt-10 sm:px-10 sm:pt-12"
            data-testid="article-content-shell"
          >
            <h1 className="mb-6 text-3xl font-bold leading-[1.2] tracking-[-0.02em] text-foreground sm:text-4xl">
              {page.title}
            </h1>
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <FileText size={48} className="text-muted-foreground/30" />
              <p className="text-muted-foreground">This page has no content yet.</p>
              <button
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
            className="mx-auto max-w-[1200px] px-5 pb-16 pt-10 sm:px-10 sm:pt-12"
            data-testid="article-content-shell"
          >
            <h1 className="mb-4 text-3xl font-bold leading-[1.2] tracking-[-0.02em] text-foreground sm:text-4xl">
              {page.title}
            </h1>

            {page.labels.length > 0 && (
              <div className="mb-10 flex flex-wrap items-center gap-2" data-testid="article-tags-readonly">
                {page.labels.map((label) => (
                  <span
                    key={label}
                    className="rounded-full border border-border bg-background/45 px-3 py-1 text-xs font-medium text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}

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

      {/* #1123. Mounted only while open so the preview query — which is a
          live projection of page state, not a cacheable read — never runs in
          the background behind a closed dialog. */}
      {relocateOpen && id && (
        <RelocateDialog
          open
          pageId={id}
          pageTitle={page.title}
          source={page.source}
          onClose={() => setRelocateOpen(false)}
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
          VerifyButton comment below makes the same argument, twenty lines
          down). The glyphs differentiate; press feedback comes from the
          shared quiet-button recipe. */}
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

function VerifyButton({ pageId }: { pageId: string | undefined }) {
  const verifyMutation = useVerifyPage();
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const handleVerify = async () => {
    if (!pageId) return;
    try {
      await verifyMutation.mutateAsync({ pageId: Number(pageId) });
      toast.success('Page verified — next review reminder rescheduled');
      setStatusMsg('Page verified');
      setTimeout(() => setStatusMsg(null), 3000);
    } catch (err) {
      // #357: surface the server's specific message instead of a generic
      // toast. ApiError.message already carries the backend reply.
      const msg = err instanceof Error && err.message ? err.message : 'Failed to verify page';
      toast.error(msg);
      setStatusMsg(msg);
      setTimeout(() => setStatusMsg(null), 3000);
    }
  };

  return (
    <>
      <button
        onClick={handleVerify}
        disabled={verifyMutation.isPending}
        title="Mark this page as up-to-date. Resets the next review reminder based on the configured review interval."
        aria-label="Mark page as verified"
        aria-busy={verifyMutation.isPending}
        className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
        data-testid="verify-btn"
      >
        <ShieldCheck size={12} className="mr-1 inline" />
        {verifyMutation.isPending ? 'Verifying...' : 'Verify'}
      </button>
      {statusMsg && (
        <span className="sr-only" role="status" aria-live="polite">
          {statusMsg}
        </span>
      )}
    </>
  );
}
