import { useState, useCallback, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X, ZoomIn, ZoomOut, Maximize2, Download } from 'lucide-react';
import { cn } from '../lib/cn';

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const DEFAULT_ZOOM = 1;

interface DiagramLightboxProps {
  /** Image source URL */
  src: string;
  /** Alt text for accessibility */
  alt: string;
  /** Diagram name displayed as title */
  diagramName?: string;
  /** Whether the lightbox is open */
  open: boolean;
  /** Callback when the lightbox should close */
  onOpenChange: (open: boolean) => void;
}

export function DiagramLightbox({
  src,
  alt,
  diagramName,
  open,
  onOpenChange,
}: DiagramLightboxProps) {
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);

  // Reset zoom when opening
  useEffect(() => {
    if (open) setZoom(DEFAULT_ZOOM);
  }, [open]);

  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(z + ZOOM_STEP, MAX_ZOOM));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(z - ZOOM_STEP, MIN_ZOOM));
  }, []);

  const handleFitToScreen = useCallback(() => {
    setZoom(DEFAULT_ZOOM);
  }, []);

  const handleDownload = useCallback(() => {
    const a = document.createElement('a');
    a.href = src;
    a.download = diagramName ? `${diagramName}.png` : 'diagram.png';
    a.click();
  }, [src, diagramName]);

  // Handle keyboard shortcuts within the dialog
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        handleFitToScreen();
      }
    },
    [handleZoomIn, handleZoomOut, handleFitToScreen],
  );

  const zoomPercent = Math.round(zoom * 100);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <Dialog.Content
          className="fixed inset-0 z-50 flex flex-col outline-none"
          onKeyDown={handleKeyDown}
          aria-label={`Diagram preview: ${diagramName || alt}`}
          aria-describedby={undefined}
        >
          {/* Top toolbar */}
          <div className="flex items-center justify-between px-4 py-3">
            <Dialog.Title className="text-sm font-medium text-white/80 truncate max-w-md">
              {diagramName || 'Diagram Preview'}
            </Dialog.Title>

            <div className="flex items-center gap-1">
              {/* Zoom controls */}
              <button
                onClick={handleZoomOut}
                disabled={zoom <= MIN_ZOOM}
                className={cn(
                  'rounded p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white',
                  zoom <= MIN_ZOOM && 'opacity-30 cursor-not-allowed',
                )}
                title="Zoom out (-)"
                aria-label="Zoom out"
              >
                <ZoomOut size={18} />
              </button>

              <span className="min-w-[3.5rem] text-center text-xs text-white/60 tabular-nums">
                {zoomPercent}%
              </span>

              <button
                onClick={handleZoomIn}
                disabled={zoom >= MAX_ZOOM}
                className={cn(
                  'rounded p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white',
                  zoom >= MAX_ZOOM && 'opacity-30 cursor-not-allowed',
                )}
                title="Zoom in (+)"
                aria-label="Zoom in"
              >
                <ZoomIn size={18} />
              </button>

              <button
                onClick={handleFitToScreen}
                className="rounded p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                title="Fit to screen (0)"
                aria-label="Fit to screen"
              >
                <Maximize2 size={18} />
              </button>

              <div className="mx-1 h-5 w-px bg-white/20" />

              <button
                onClick={handleDownload}
                className="rounded p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                title="Download diagram"
                aria-label="Download diagram"
              >
                <Download size={18} />
              </button>

              <Dialog.Close asChild>
                <button
                  className="rounded p-1.5 text-white/70 transition-colors hover:bg-white/10 hover:text-white"
                  aria-label="Close preview"
                >
                  <X size={18} />
                </button>
              </Dialog.Close>
            </div>
          </div>

          {/* Diagram viewport */}
          <div
            className="flex flex-1 items-center justify-center overflow-auto p-4"
            onClick={() => onOpenChange(false)}
          >
            <img
              src={src}
              alt={alt}
              className="rounded-lg bg-white/95 p-4 shadow-2xl transition-transform duration-200 ease-out"
              style={{ transform: `scale(${zoom})`, transformOrigin: 'center center' }}
              onClick={(e) => e.stopPropagation()}
              draggable={false}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
