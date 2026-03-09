import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { m, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Edit3, Save, X, Trash2, Wand2, FileText,
  ExternalLink, Clock, User,
} from 'lucide-react';
import DOMPurify from 'dompurify';
import type { SettingsResponse } from '@kb-creator/contracts';
import { usePage, useUpdatePage, useDeletePage } from '../../shared/hooks/use-pages';
import { apiFetch } from '../../shared/lib/api';
import { Editor, getDraft, clearDraft } from '../../shared/components/Editor';
import { FreshnessBadge } from '../../shared/components/FreshnessBadge';
import { TableOfContents } from '../../shared/components/TableOfContents';
import { DuplicateDetector } from './DuplicateDetector';
import { AutoTagger } from './AutoTagger';
import { TagEditor } from './TagEditor';
import { VersionHistory } from './VersionHistory';
import { FlowchartGenerator } from './FlowchartGenerator';
import { toast } from 'sonner';

function ImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
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
        className="absolute top-4 right-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20"
        aria-label="Close preview"
      >
        <X size={20} />
      </button>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </m.div>
  );
}

export function PageViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: page, isLoading } = usePage(id);
  const updateMutation = useUpdatePage();
  const deleteMutation = useDeletePage();

  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editHtml, setEditHtml] = useState('');
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => apiFetch<SettingsResponse>('/settings'),
    staleTime: 5 * 60 * 1000,
  });

  const draftKey = id ? `page-${id}` : undefined;

  const sanitizedHtml = useMemo(
    () => (page ? DOMPurify.sanitize(page.bodyHtml, {
      ADD_ATTR: ['data-diagram-name', 'data-drawio'],
    }) : ''),
    [page],
  );

  // Attach click-to-zoom on images and update draw.io edit links
  useEffect(() => {
    const container = contentRef.current;
    if (!container || editing) return;

    // Click-to-zoom for images
    const handleImageClick = (e: Event) => {
      const img = e.currentTarget as HTMLImageElement;
      setLightboxSrc({ src: img.src, alt: img.alt || 'Image preview' });
    };

    const images = container.querySelectorAll('img');
    for (const img of images) {
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', handleImageClick);
    }

    // Update draw.io "Edit in Confluence" links with real Confluence URL
    if (settings?.confluenceUrl && id) {
      const editLinks = container.querySelectorAll('a.drawio-edit-link');
      for (const link of editLinks) {
        const anchor = link as HTMLAnchorElement;
        anchor.href = `${settings.confluenceUrl}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
      }
    }

    return () => {
      for (const img of images) {
        img.removeEventListener('click', handleImageClick);
      }
    };
  }, [sanitizedHtml, editing, settings?.confluenceUrl, id]);

  const startEditing = useCallback(() => {
    if (!page || !id) return;
    setEditTitle(page.title);
    const draft = getDraft(`page-${id}`);
    if (draft && draft !== page.bodyHtml) {
      const useDraft = window.confirm('A draft was found for this page. Restore it?');
      setEditHtml(useDraft ? draft : page.bodyHtml);
    } else {
      setEditHtml(page.bodyHtml);
    }
    setEditing(true);
  }, [page, id]);

  const cancelEditing = useCallback(() => {
    if (draftKey) clearDraft(draftKey);
    setEditing(false);
  }, [draftKey]);

  const handleSave = async () => {
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
      toast.success('Page saved successfully');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save page';
      // Handle version conflict (HTTP 409)
      if (message.includes('modified since you loaded')) {
        toast.error('Version conflict — the page was edited elsewhere.', {
          action: {
            label: 'Reload',
            onClick: () => {
              queryClient.invalidateQueries({ queryKey: ['pages', id] });
              setEditing(false);
            },
          },
          duration: 10000,
        });
      } else {
        toast.error(message);
      }
    }
  };

  const handleDelete = async () => {
    if (!id || !window.confirm('Delete this page? This cannot be undone.')) return;
    try {
      await deleteMutation.mutateAsync(id);
      navigate('/pages');
      toast.success('Page deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete page');
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="glass-card h-12 animate-pulse" />
        <div className="glass-card h-96 animate-pulse" />
      </div>
    );
  }

  if (!page) {
    return (
      <div className="glass-card flex flex-col items-center justify-center py-16">
        <FileText size={48} className="mb-4 text-muted-foreground" />
        <p className="text-lg font-medium">Page not found</p>
        <button onClick={() => navigate('/pages')} className="mt-4 text-sm text-primary hover:underline">
          Back to pages
        </button>
      </div>
    );
  }

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-4"
    >
      {/* Top bar */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => navigate('/pages')} className="rounded p-1.5 text-muted-foreground hover:bg-white/5">
            <ArrowLeft size={18} />
          </button>
          {editing ? (
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="flex-1 rounded-md bg-white/5 px-3 py-1.5 text-lg font-bold outline-none focus:ring-1 focus:ring-primary"
            />
          ) : (
            <h1 className="truncate text-xl font-bold">{page.title}</h1>
          )}
        </div>

        <div className="flex shrink-0 gap-2">
          {editing ? (
            <>
              <button
                onClick={cancelEditing}
                className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-white/5"
              >
                <X size={14} /> Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={updateMutation.isPending}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                <Save size={14} /> {updateMutation.isPending ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : (
            <>
              <AutoTagger
                pageId={id!}
                currentLabels={page.labels}
                model="qwen3:latest"
              />
              <button
                onClick={() => navigate(`/ai?pageId=${id}`)}
                className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-white/5"
              >
                <Wand2 size={14} /> AI Improve
              </button>
              <button
                onClick={startEditing}
                className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm hover:bg-white/5"
              >
                <Edit3 size={14} /> Edit
              </button>
              <button
                onClick={handleDelete}
                className="glass-card flex items-center gap-1.5 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
              >
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Metadata */}
      <div className="glass-card flex flex-wrap items-center gap-4 px-4 py-3 text-sm text-muted-foreground">
        <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">{page.spaceKey}</span>
        {page.lastModifiedAt && (
          <FreshnessBadge lastModified={page.lastModifiedAt} />
        )}
        {page.author && (
          <span className="flex items-center gap-1"><User size={12} /> {page.author}</span>
        )}
        {page.lastModifiedAt && (
          <span className="flex items-center gap-1">
            <Clock size={12} /> {new Date(page.lastModifiedAt).toLocaleString()}
          </span>
        )}
        <span className="text-xs">v{page.version}</span>
        <TagEditor pageId={id!} labels={page.labels} editing={editing} />
        {settings?.confluenceUrl && (
          <a
            href={`${settings.confluenceUrl}/pages/viewpage.action?pageId=${encodeURIComponent(id!)}`}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 text-primary hover:underline"
          >
            Open in Confluence <ExternalLink size={12} />
          </a>
        )}
      </div>

      {/* Content with optional Table of Contents */}
      {editing ? (
        <Editor content={editHtml} onChange={setEditHtml} draftKey={draftKey} />
      ) : (
        <>
          <div className="flex gap-4">
            <div
              ref={contentRef}
              className="glass-card prose prose-invert max-w-none flex-1 p-6"
              dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
            />
            <div className="hidden w-64 shrink-0 space-y-4 lg:block sticky top-4 self-start max-h-[calc(100vh-2rem)] overflow-y-auto">
              <TableOfContents htmlContent={sanitizedHtml} contentRef={contentRef} />
              <VersionHistory pageId={id!} currentBodyText={page.bodyText} model="qwen3:latest" />
              <DuplicateDetector pageId={id!} pageTitle={page.title} />
            </div>
          </div>
          <FlowchartGenerator pageId={id!} bodyHtml={page.bodyHtml} />
        </>
      )}

      {/* Image lightbox */}
      <AnimatePresence>
        {lightboxSrc && (
          <ImageLightbox
            src={lightboxSrc.src}
            alt={lightboxSrc.alt}
            onClose={() => setLightboxSrc(null)}
          />
        )}
      </AnimatePresence>
    </m.div>
  );
}
