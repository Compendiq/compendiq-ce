import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import {
  ChevronDown,
  ChevronUp,
  FileText,
  FolderOpen,
  Save,
  User,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '../../shared/lib/cn';
import {
  usePage,
  useUpdatePage,
} from '../../shared/hooks/use-pages';
import { useAuthenticatedSrc } from '../../shared/hooks/use-authenticated-src';
import { useArticleViewStore } from '../../stores/article-view-store';
import { FeatureErrorBoundary } from '../../shared/components/FeatureErrorBoundary';
import { FreshnessBadge } from '../../shared/components/FreshnessBadge';
import { EmbeddingStatusBadge } from '../../shared/components/EmbeddingStatusBadge';
import { Editor, clearDraft, getDraft } from '../../shared/components/Editor';
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

function readHeaderCollapsedState() {
  try {
    return localStorage.getItem('article-header-collapsed') === 'true';
  } catch {
    return false;
  }
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

  const updateMutation = useUpdatePage();

  const contentRef = useRef<HTMLDivElement>(null);
  const draftKey = id ? `page-${id}` : undefined;

  const setStoreHeadings = useArticleViewStore((s) => s.setHeadings);
  const setStoreEditing = useArticleViewStore((s) => s.setEditing);

  const [editing, setEditing] = useState(false);
  const [editHtml, setEditHtml] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [headings, setHeadings] = useState<TocHeading[]>([]);
  const [lightboxSrc, setLightboxSrc] = useState<{ alt: string; src: string } | null>(null);
  const [headerCollapsed, setHeaderCollapsed] = useState(readHeaderCollapsedState);

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

  useEffect(() => {
    try {
      localStorage.setItem('article-header-collapsed', String(headerCollapsed));
    } catch {
      // Ignore storage write failures.
    }
  }, [headerCollapsed]);

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

  const pageKindLabel = page.hasChildren ? 'Folder Article' : 'Article';
  // Header stays expanded while editing so the title input and action buttons remain accessible.
  const isHeaderCollapsed = headerCollapsed && !editing;

  return (
    <m.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className="space-y-5"
      data-testid="article-page"
    >
      <section className="overflow-hidden glass-card-xl">
        <div
          className={cn(
            'relative overflow-hidden px-5 sm:px-7',
            isHeaderCollapsed ? 'py-3 sm:py-4' : 'py-6 sm:py-7',
          )}
        >
          <div className="relative flex flex-col gap-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1 space-y-3">
                {editing ? (
                  <input
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    className="w-full rounded-2xl border border-border/60 bg-background/60 px-4 py-3 text-2xl font-semibold text-foreground outline-none ring-offset-0 transition-colors focus:border-primary"
                  />
                ) : (
                  <h1
                    className={cn(
                      'font-semibold tracking-tight text-foreground',
                      isHeaderCollapsed
                        ? 'truncate text-lg'
                        : 'text-balance text-2xl sm:text-3xl',
                    )}
                  >
                    {page.title}
                  </h1>
                )}

                <AnimatePresence initial={false}>
                  {!isHeaderCollapsed && (
                    <m.div
                      key="header-metadata"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.18 }}
                      className="overflow-hidden"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/55 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em]">
                          {page.hasChildren ? <FolderOpen size={12} /> : <FileText size={12} />}
                          {pageKindLabel}
                        </span>
                        <span className="text-[11px] font-semibold uppercase tracking-[0.24em]">{page.spaceKey}</span>
                        {page.lastModifiedAt ? <FreshnessBadge lastModified={page.lastModifiedAt} /> : null}
                        <EmbeddingStatusBadge
                          embeddingStatus={page.embeddingStatus}
                          embeddingDirty={page.embeddingDirty}
                          embeddedAt={page.embeddedAt}
                          embeddingError={page.embeddingError}
                        />
                        {page.author ? (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/45 px-3 py-1">
                            <User size={12} />
                            {page.author}
                          </span>
                        ) : null}
                        <span className="rounded-full border border-border/60 bg-background/45 px-3 py-1">
                          v{page.version}
                        </span>
                      </div>
                    </m.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                <AnimatePresence initial={false}>
                  {!isHeaderCollapsed && (
                    <m.div
                      key="header-actions"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12 }}
                      className="flex flex-wrap items-center gap-2"
                    >
                      {editing ? (
                        <>
                          <button
                            onClick={handleCancelEditing}
                            className="rounded-xl border border-border/60 bg-background/55 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                          >
                            <span className="inline-flex items-center gap-2">
                              <X size={14} />
                              Cancel
                            </span>
                          </button>
                          <button
                            onClick={handleSave}
                            disabled={updateMutation.isPending}
                            className="rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            <span className="inline-flex items-center gap-2">
                              <Save size={14} />
                              {updateMutation.isPending ? 'Saving...' : 'Save'}
                            </span>
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={handleStartEditing}
                          className="rounded-xl border border-border/60 bg-background/55 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                        >
                          Edit
                        </button>
                      )}
                    </m.div>
                  )}
                </AnimatePresence>

                {!editing && (
                  <button
                    onClick={() => setHeaderCollapsed((v) => !v)}
                    className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                    aria-label={isHeaderCollapsed ? 'Expand article header' : 'Collapse article header'}
                  >
                    {isHeaderCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
                  </button>
                )}
              </div>
            </div>

            <AnimatePresence initial={false}>
              {!isHeaderCollapsed && page.labels.length > 0 && (
                <m.div
                  key="header-labels"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="flex flex-wrap gap-2">
                    {page.labels.map((label) => (
                      <span
                        key={label}
                        className="rounded-full border border-border/60 bg-background/45 px-3 py-1 text-xs font-medium text-muted-foreground"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                </m.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </section>

      {editing ? (
        <section className="overflow-hidden glass-card-xl">
          <FeatureErrorBoundary featureName="Editor">
            <Editor content={editHtml} onChange={setEditHtml} draftKey={draftKey} />
          </FeatureErrorBoundary>
        </section>
      ) : (
        <section
          ref={contentRef}
          className="overflow-hidden glass-card-xl"
          data-testid="article-content-shell"
        >
          <FeatureErrorBoundary featureName="Article Viewer">
            <ArticleViewer
              content={page.bodyHtml}
              onImageClick={handleImageClick}
              onHeadingsReady={setHeadings}
              pageId={id}
              className="px-5 py-6 sm:px-7 sm:py-8"
            />
          </FeatureErrorBoundary>
        </section>
      )}

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
