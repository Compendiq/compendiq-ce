import { useState, useCallback } from 'react';
import { ExternalLink, AlertTriangle, RefreshCw, Image as ImageIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { DiagramLightbox } from './DiagramLightbox';

type LoadState = 'loading' | 'loaded' | 'error';

interface DrawioDiagramPreviewProps {
  /** Image source URL for the diagram PNG */
  src: string | null;
  /** Diagram name (used for caption and lightbox title) */
  diagramName: string | null;
  /** Alt text */
  alt: string;
  /** Link to edit the diagram in Confluence */
  editHref: string;
  /** Additional CSS classes */
  className?: string;
  /** Callback to trigger a sync/re-fetch of the diagram */
  onRequestSync?: () => void;
}

export function DrawioDiagramPreview({
  src,
  diagramName,
  alt,
  editHref,
  className,
  onRequestSync,
}: DrawioDiagramPreviewProps) {
  const [loadState, setLoadState] = useState<LoadState>(src ? 'loading' : 'error');
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const handleLoad = useCallback(() => {
    setLoadState('loaded');
  }, []);

  const handleError = useCallback(() => {
    setLoadState('error');
  }, []);

  const handleImageClick = useCallback(() => {
    if (loadState === 'loaded' && src) {
      setLightboxOpen(true);
    }
  }, [loadState, src]);

  return (
    <div
      className={cn(
        'drawio-preview-container',
        'relative rounded-lg border border-[var(--glass-border)]',
        'bg-[oklch(from_var(--color-card)_l_c_h_/_0.5)] backdrop-blur-sm',
        'overflow-hidden my-4',
        className,
      )}
      data-testid="drawio-preview"
    >
      {/* Caption bar */}
      {diagramName && (
        <div
          className="flex items-center gap-2 border-b border-[var(--glass-border)] px-3 py-1.5"
          data-testid="drawio-caption"
        >
          <ImageIcon size={14} className="text-[var(--color-muted-foreground)] shrink-0" />
          <span className="text-xs font-medium text-[var(--color-muted-foreground)] truncate">
            {diagramName}
          </span>
        </div>
      )}

      {/* Diagram content area */}
      <div className="relative">
        {/* Loading skeleton */}
        {loadState === 'loading' && (
          <div
            className="flex items-center justify-center p-8"
            data-testid="drawio-skeleton"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="skeleton h-32 w-48 rounded-md" />
              <div className="skeleton h-3 w-24 rounded" />
            </div>
          </div>
        )}

        {/* Error state */}
        {loadState === 'error' && (
          <div
            className="flex flex-col items-center justify-center gap-3 p-8 text-center"
            data-testid="drawio-error"
          >
            <div className="rounded-full bg-[oklch(from_var(--color-warning)_l_c_h_/_0.15)] p-3">
              <AlertTriangle size={24} className="text-[var(--color-warning)]" />
            </div>
            <p className="text-sm text-[var(--color-muted-foreground)]">
              {diagramName ? `Diagram "${diagramName}" could not be loaded` : 'Diagram could not be loaded'}
            </p>
            {onRequestSync && (
              <button
                onClick={onRequestSync}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium',
                  'border border-[var(--glass-border)] text-[var(--color-primary)]',
                  'transition-colors hover:bg-[oklch(from_var(--color-primary)_l_c_h_/_0.1)]',
                )}
                data-testid="drawio-sync-button"
              >
                <RefreshCw size={12} />
                Sync to load diagram
              </button>
            )}
          </div>
        )}

        {/* Diagram image -- light background panel for dark mode compatibility */}
        {src && (
          <div
            className={cn(
              'flex items-center justify-center p-4',
              'bg-white/95 dark:bg-white/90',
              loadState === 'loading' ? 'absolute inset-0 opacity-0' : '',
              loadState === 'error' ? 'hidden' : '',
            )}
            data-testid="drawio-image-panel"
          >
            <img
              src={src}
              alt={alt}
              loading="lazy"
              onLoad={handleLoad}
              onError={handleError}
              onClick={handleImageClick}
              className={cn(
                'max-w-full h-auto rounded',
                'transition-opacity duration-200',
                loadState === 'loaded' && 'cursor-zoom-in',
              )}
              draggable={false}
            />
          </div>
        )}
      </div>

      {/* Footer with edit link */}
      <div className="flex items-center justify-end border-t border-[var(--glass-border)] px-3 py-1.5">
        <a
          href={editHref}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'drawio-edit-button',
            'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
            'text-[var(--color-primary)] border border-[var(--glass-border)]',
            'transition-colors hover:bg-[oklch(from_var(--color-primary)_l_c_h_/_0.1)]',
          )}
          title="Open this diagram in Confluence to edit it"
          data-testid="drawio-edit-link"
        >
          <ExternalLink size={12} />
          Edit in Confluence
        </a>
      </div>

      {/* Lightbox for fullscreen view */}
      {src && loadState === 'loaded' && (
        <DiagramLightbox
          src={src}
          alt={alt}
          diagramName={diagramName || undefined}
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
        />
      )}
    </div>
  );
}
