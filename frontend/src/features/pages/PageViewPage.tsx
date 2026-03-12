import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { FileText, FolderOpen, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  usePage,
  useUpdatePage,
} from '../../shared/hooks/use-pages';
import { useAuthenticatedSrc } from '../../shared/hooks/use-authenticated-src';
import { useSettings } from '../../shared/hooks/use-settings';
import { useArticleViewStore } from '../../stores/article-view-store';
import { FeatureErrorBoundary } from '../../shared/components/FeatureErrorBoundary';
import { Editor, EditorToolbar, TableContextToolbar, clearDraft, getDraft } from '../../shared/components/Editor';
import type { Editor as EditorType } from '@tiptap/core';
import { ArticleViewer } from '../../shared/components/ArticleViewer';
import type { TocHeading } from '../../shared/components/TableOfContents';
import { PageViewSkeleton } from '../../shared/components/Skeleton';

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
  });
}

export function PageViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: page, isLoading } = usePage(id);
  const { data: settings } = useSettings();
  const updateMutation = useUpdatePage();

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
      await updateMutation.mutateAsync({
        id,
        title: editTitle,
        bodyHtml: editHtml,
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
  }, [draftKey, editHtml, editTitle, id, page, queryClient, updateMutation]);

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
      {/* Sticky toolbar — rendered OUTSIDE glass-card-xl so sticky works */}
      {editing && editorInstance && (
        <div className="sticky top-0 z-20 rounded-t-xl border-b border-border/25 bg-card/95 backdrop-blur-sm glass-card-xl overflow-visible">
          <EditorToolbar editor={editorInstance} />
          <TableContextToolbar editor={editorInstance} />
        </div>
      )}

      {/* Single unified document card */}
      <div className={editing ? 'overflow-hidden glass-card-xl rounded-t-none' : 'overflow-hidden glass-card-xl'}>
        {/* Breadcrumb / action strip */}
        <div className="flex items-center justify-between gap-4 border-b border-border/25 px-5 py-2 sm:px-7">
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/60">
            {page.hasChildren
              ? <FolderOpen size={12} className="shrink-0" />
              : <FileText size={12} className="shrink-0" />}
            <span className="truncate">{page.spaceKey}</span>
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
                  className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                >
                  {updateMutation.isPending ? 'Saving…' : 'Save'}
                </button>
              </>
            ) : (
              <button
                onClick={handleStartEditing}
                className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                Edit
              </button>
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
            </div>

            {/* Editor — naked (no inner glass-card, we are already inside glass-card-xl) */}
            <FeatureErrorBoundary featureName="Editor">
              <Editor content={editHtml} onChange={setEditHtml} draftKey={draftKey} naked onEditorReady={setEditorInstance} hideToolbar />
            </FeatureErrorBoundary>
          </>
        ) : (
          /* Reading view — constrained to 720 px reading column */
          <div
            ref={contentRef}
            className="px-5 pb-16 pt-10 sm:px-10 sm:pt-12"
            data-testid="article-content-shell"
          >
            <h1 className="mb-10 text-4xl font-bold leading-[1.2] tracking-[-0.02em] text-foreground sm:text-5xl">
              {page.title}
            </h1>

            <FeatureErrorBoundary featureName="Article Viewer">
              <ArticleViewer
                content={page.bodyHtml}
                confluenceUrl={settings?.confluenceUrl}
                onImageClick={handleImageClick}
                onHeadingsReady={setHeadings}
                pageId={id}
              />
            </FeatureErrorBoundary>
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
    </m.div>
  );
}
