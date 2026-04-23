import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { FileText, X, Upload, ShieldCheck, Globe, Lock, ThumbsUp, ThumbsDown, AlertCircle, GitGraph } from 'lucide-react';
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
import { useAuthenticatedSrc } from '../../shared/hooks/use-authenticated-src';
import { useSettings } from '../../shared/hooks/use-settings';
import { useKeyboardShortcuts, type ShortcutDefinition } from '../../shared/hooks/use-keyboard-shortcuts';
import { useArticleViewStore } from '../../stores/article-view-store';
import { FeatureErrorBoundary } from '../../shared/components/feedback/FeatureErrorBoundary';
import { QualityScoreBadge } from '../../shared/components/badges/QualityScoreBadge';
import { Editor, EditorToolbar, TableContextToolbar, LayoutContextToolbar, ColumnContextToolbar, clearDraft, getDraft } from '../../shared/components/article/Editor';
import type { Editor as EditorType } from '@tiptap/core';
import { drainPendingDrawioDiagrams } from '../../shared/components/article/drawio-save-drain';
import { ArticleViewer } from '../../shared/components/article/ArticleViewer';
import { DrawioEditor } from '../../shared/components/diagrams/DrawioEditor';
import { apiFetch } from '../../shared/lib/api';
import { ArticleSummary } from '../../shared/components/article/ArticleSummary';
import type { TocHeading } from '../../shared/components/article/TableOfContents';
import { PageViewSkeleton } from '../../shared/components/feedback/Skeleton';
import { TagEditor } from '../../shared/components/TagEditor';
import { ShortcutHint } from '../../shared/components/ShortcutHint';

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

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label={`Image preview: ${alt}`}
    >
      <button
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

  const isPinned = pinnedData?.items.some((item) => item.id === id) ?? false;


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

  const [editing, setEditing] = useState(false);
  const [editorInstance, setEditorInstance] = useState<EditorType | null>(null);
  const [editHtml, setEditHtml] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<{ alt: string; src: string } | null>(null);
  const [drawioEditingDiagram, setDrawioEditingDiagram] = useState<string | null>(null);
  const [drawioXml, setDrawioXml] = useState<string>('');

  // Vim mode state — lifted here so we can pass it to the external toolbar
  const [vimEnabled, setVimEnabled] = useState(() =>
    localStorage.getItem('compendiq-vim-mode') === 'true'
  );
  const toggleVim = useCallback(() => {
    setVimEnabled(prev => {
      const next = !prev;
      localStorage.setItem('compendiq-vim-mode', String(next));
      return next;
    });
  }, []);

  // Sync editing state to the shared store (consumed by ArticleRightPane)
  useEffect(() => {
    setStoreEditing(editing);
  }, [editing, setStoreEditing]);

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

  useLayoutEffect(() => {
    scrollArticleToTop();
  }, [id]);

  useEffect(() => {
    if (!page) return;
    scrollArticleToTop();
  }, [id, page?.version, page]);

  const handleImageClick = useCallback((src: string, alt: string) => {
    setLightboxSrc({ alt, src });
  }, []);

  const handleCloseLightbox = useCallback(() => {
    setLightboxSrc(null);
  }, []);

  const handleStartEditing = useCallback(() => {
    if (!page || !id) return;
    setEditTitle(page.title);
    const draft = getDraft(`page-${id}`);
    if (draft && draft !== page.bodyHtml) {
      const restoreDraft = window.confirm('A draft was found for this article. Restore it?');
      setEditHtml(restoreDraft ? draft : page.bodyHtml);
    } else {
      setEditHtml(page.bodyHtml);
    }
    setEditing(true);
  }, [id, page]);

  const handleCancelEditing = useCallback(() => {
    if (draftKey) clearDraft(draftKey);
    setEditing(false);
  }, [draftKey]);

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
      // `editor.getHTML()` reflects the newly-committed node attributes,
      // so pull the post-drain HTML rather than the pre-drain `editHtml`.
      const bodyToSave = editorInstance?.getHTML() ?? editHtml;

      await updateMutation.mutateAsync({
        id,
        title: editTitle,
        bodyHtml: bodyToSave,
        version: page.version,
      });
      if (draftKey) clearDraft(draftKey);
      setEditing(false);
      toast.success('Article saved.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save article.';
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
  }, [draftKey, editHtml, editTitle, editorInstance, id, page, queryClient, updateMutation]);

  // Draw.io inline editing handlers
  const handleEditDiagram = useCallback(async (diagramName: string) => {
    // Fetch the diagram PNG from the attachment cache — draw.io can load PNG+XML data URIs
    // Attachments are stored/served by confluence_id, not the integer PK from the route
    const attachmentPageId = page?.confluenceId ?? id;
    if (!attachmentPageId) return;
    let dataUri: string;
    try {
      const { accessToken } = (await import('../../stores/auth-store')).useAuthStore.getState();
      const res = await fetch(`/api/attachments/${encodeURIComponent(attachmentPageId)}/${encodeURIComponent(diagramName)}.png`, {
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
    try {
      // Push BOTH the PNG and the .drawio XML (#302 Gap 2). Without the
      // XML, Confluence's native draw.io viewer has no way to re-open
      // the diagram for editing — it sees only the rendered image.
      await apiFetch(`/attachments/${encodeURIComponent(attachmentPageId)}/${encodeURIComponent(filename)}`, {
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
    labelsMutation.mutate(
      { id, addLabels: [tag] },
      { onError: () => toast.error('Failed to add tag.') },
    );
  }, [id, labelsMutation]);

  const handleRemoveTag = useCallback((tag: string) => {
    if (!id) return;
    labelsMutation.mutate(
      { id, removeLabels: [tag] },
      { onError: () => toast.error('Failed to remove tag.') },
    );
  }, [id, labelsMutation]);

  const handlePinToggle = useCallback(() => {
    if (!id || !page) return;
    const mutation = isPinned ? unpinMutation : pinMutation;
    mutation.mutate(id, {
      onSuccess: () => toast.success(isPinned ? 'Unpinned.' : 'Pinned.'),
      onError: (error: unknown) => toast.error(error instanceof Error ? error.message : 'Pin update failed.'),
    });
  }, [id, isPinned, page, pinMutation, unpinMutation]);

  const handleDeletePage = useCallback(async () => {
    if (!id || !window.confirm('Delete this article? This cannot be undone.')) return;
    try {
      await deleteMutation_page.mutateAsync(id);
      navigate('/');
      toast.success('Article deleted.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete article.');
    }
  }, [deleteMutation_page, id, navigate]);

  // Page-specific keyboard shortcuts (Ctrl+S, Ctrl+E, Escape, Alt+P, Alt+Shift+D, Alt+I)
  const pageShortcuts = useMemo<ShortcutDefinition[]>(() => [
    {
      key: 'Ctrl+S',
      keys: ['s'],
      mod: true,
      description: 'Save current article',
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
      description: 'AI Improve',
      category: 'actions',
      action: () => {
        if (id) navigate(`/ai?mode=improve&pageId=${encodeURIComponent(id)}`);
      },
    },
  ], [editing, handleSave, handleCancelEditing, handleStartEditing, handlePinToggle, handleDeletePage, id, navigate]);

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
      <div className="glass-card flex min-h-[18rem] flex-col items-center justify-center gap-3 py-16 text-center">
        <FileText size={42} className="text-muted-foreground" />
        <h1 className="text-xl font-semibold text-foreground">Article not found</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The selected page is unavailable or no longer accessible in the synced space tree.
        </p>
        <button
          onClick={() => navigate('/')}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Return to pages
        </button>
      </div>
    );
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      data-testid="article-page"
    >
      {/* Sticky toolbar — ABOVE the card, sticks at top-0 with no movement */}
      {editing && editorInstance && (
        <div className="sticky top-0 z-30 border border-border/25 bg-card rounded-xl shadow-[0_8px_32px_var(--glass-shadow)] before:absolute before:-z-10 before:-top-[100px] before:bottom-0 before:-left-[14px] before:-right-[14px] sm:before:-left-[22px] sm:before:-right-[22px] before:bg-background">
          <EditorToolbar editor={editorInstance} vimEnabled={vimEnabled} onToggleVim={toggleVim} />
          <TableContextToolbar editor={editorInstance} />
          <LayoutContextToolbar editor={editorInstance} />
          <ColumnContextToolbar editor={editorInstance} />
        </div>
      )}
      {/* Single unified document card */}
      <div
        className={editing ? 'glass-card-xl rounded-t-none -mt-px' : 'glass-card-xl'}
        style={editing ? { clipPath: 'inset(0 -100px -100px -100px round 0 0 var(--radius-xl) var(--radius-xl))' } : undefined}
      >
        {/* Breadcrumb / action strip */}
        <div className="flex items-center justify-between gap-4 border-b border-border/25 px-5 py-2 sm:px-7">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/60">
            <FileText size={12} className="shrink-0" />
            {page.spaceKey !== '__local__' && <span className="truncate">{page.spaceKey}</span>}
            {/* Source badge */}
            {page.source === 'standalone' ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-500" data-testid="source-badge">
                Local
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-500" data-testid="source-badge">
                Confluence
              </span>
            )}
            {/* Visibility badge for standalone articles */}
            {page.source === 'standalone' && (
              page.visibility === 'shared' ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-medium text-sky-500" data-testid="visibility-badge">
                  <Globe size={10} /> Shared
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-500" data-testid="visibility-badge">
                  <Lock size={10} /> Private
                </span>
              )
            )}
            {/* Draft indicator */}
            {'hasDraft' in page && Boolean((page as Record<string, unknown>).hasDraft) && (
              <span className="inline-flex items-center gap-1 rounded-full bg-orange-500/15 px-2 py-0.5 text-[10px] font-medium text-orange-500" data-testid="draft-indicator">
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

          <div className="flex shrink-0 items-center gap-1.5">
            {editing ? (
              <>
                <button
                  onClick={handleCancelEditing}
                  className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                >
                  {updateMutation.isPending ? 'Saving…' : 'Save'}
                  {!updateMutation.isPending && <ShortcutHint shortcutId="save" />}
                </button>
              </>
            ) : (
              <>
                {/* Publish to Confluence for standalone articles */}
                {page.spaceKey === '__local__' && (
                  <button
                    onClick={() => toast.info('Publish to Confluence coming soon')}
                    className="rounded-md px-2.5 py-1 text-xs text-blue-500 transition-colors hover:bg-blue-500/10"
                    data-testid="publish-confluence-btn"
                  >
                    <Upload size={12} className="mr-1 inline" />
                    Publish to Confluence
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
                  Graph
                </button>
                <button
                  onClick={handleStartEditing}
                  className="flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  Edit
                  <ShortcutHint shortcutId="toggle-edit" />
                </button>
              </>
            )}
          </div>
        </div>

        {editing ? (
          <>
            {/* Editable title — reading column, same width as editor content */}
            <div className="border-b border-border/25 px-5 py-5 sm:px-10">
              <div>
                <input
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  className="w-full bg-transparent text-3xl font-bold leading-tight tracking-[-0.02em] text-foreground outline-none placeholder:text-muted-foreground/40"
                  placeholder="Article title…"
                />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <TagEditor
                  tags={page.labels}
                  onAddTag={handleAddTag}
                  onRemoveTag={handleRemoveTag}
                  suggestions={filterOptions?.labels}
                  isLoading={labelsMutation.isPending}
                />
              </div>
            </div>

            {/* Editor — naked (no inner glass-card, we are already inside glass-card-xl) */}
            <FeatureErrorBoundary featureName="Editor">
              <Editor content={editHtml} onChange={setEditHtml} draftKey={draftKey} naked onEditorReady={setEditorInstance} hideToolbar pageId={id} onSave={handleSave} vimEnabled={vimEnabled} />
            </FeatureErrorBoundary>
          </>
        ) : !page.bodyHtml?.trim() || page.bodyHtml.trim() === '<p></p>' ? (
          /* Empty page — no content yet */
          <div
            ref={contentRef}
            className="px-5 pb-16 pt-10 sm:px-10 sm:pt-12"
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
                className="rounded-xl bg-primary/15 px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/25"
                data-testid="add-content-btn"
              >
                Add content
              </button>
            </div>
          </div>
        ) : (
          /* Reading view — constrained to 720 px reading column */
          <div
            ref={contentRef}
            className="px-5 pb-16 pt-10 sm:px-10 sm:pt-12"
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
                    className="rounded-full border border-border/60 bg-background/45 px-3 py-1 text-xs font-medium text-muted-foreground"
                  >
                    {label}
                  </span>
                ))}
              </div>
            )}

            {page.summaryStatus && (
              <ArticleSummary
                pageId={page.id}
                summaryHtml={page.summaryHtml}
                summaryStatus={page.summaryStatus}
                summaryGeneratedAt={page.summaryGeneratedAt}
                summaryModel={page.summaryModel}
                summaryError={page.summaryError}
              />
            )}

            <FeatureErrorBoundary featureName="Article Viewer">
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

            {/* Feedback widget */}
            <FeedbackWidget pageId={id} />
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
      <div className="mt-12 border-t border-border/25 pt-6 text-center" data-testid="feedback-widget">
        <p className="text-sm text-muted-foreground">Thanks for your feedback!</p>
      </div>
    );
  }

  return (
    <div className="mt-12 border-t border-border/25 pt-6" data-testid="feedback-widget">
      <p className="mb-3 text-sm font-medium text-muted-foreground">Was this article helpful?</p>
      <div className="flex gap-2">
        <button
          onClick={() => handleFeedback(true)}
          disabled={submitFeedback.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 px-4 py-2 text-sm text-emerald-500 transition-colors hover:bg-emerald-500/20 disabled:opacity-50"
          data-testid="feedback-helpful"
        >
          <ThumbsUp size={14} /> Yes
        </button>
        <button
          onClick={() => handleFeedback(false)}
          disabled={submitFeedback.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-4 py-2 text-sm text-red-500 transition-colors hover:bg-red-500/20 disabled:opacity-50"
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

  const handleVerify = async () => {
    if (!pageId) return;
    try {
      await verifyMutation.mutateAsync({ pageId: Number(pageId), verified: true });
      toast.success('Page verified');
    } catch {
      toast.error('Failed to verify page');
    }
  };

  return (
    <button
      onClick={handleVerify}
      disabled={verifyMutation.isPending}
      className="rounded-md px-2.5 py-1 text-xs text-emerald-500 transition-colors hover:bg-emerald-500/10 disabled:opacity-50"
      data-testid="verify-btn"
    >
      <ShieldCheck size={12} className="mr-1 inline" />
      {verifyMutation.isPending ? 'Verifying...' : 'Verify'}
    </button>
  );
}
