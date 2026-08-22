import React, { useState, useEffect, useRef, useCallback } from 'react';
import { m } from 'framer-motion';
import { X, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { useAuthenticatedSrc } from '../../hooks/use-authenticated-src';
import { cn } from '../../lib/cn';

export interface ImageLightboxProps {
  alt: string;
  onClose: () => void;
  src: string;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 5.0;
const SCALE_STEP = 0.25;
const PAN_STEP = 50;

function clampX(x: number, scale: number): number {
  if (scale <= 1) return 0;
  const limit = typeof window !== 'undefined' ? Math.max(100, (window.innerWidth * (scale - 0.5)) / 2) : 1000;
  return Math.min(Math.max(x, -limit), limit);
}

function clampY(y: number, scale: number): number {
  if (scale <= 1) return 0;
  const limit = typeof window !== 'undefined' ? Math.max(100, (window.innerHeight * (scale - 0.5)) / 2) : 1000;
  return Math.min(Math.max(y, -limit), limit);
}

export function ImageLightbox({
  alt,
  onClose,
  src,
}: ImageLightboxProps) {
  const { blobSrc, loading } = useAuthenticatedSrc(src);
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Reset zoom & pan when image source changes
  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, [src]);

  const zoomIn = useCallback(() => {
    setScale((prev) => Math.min(MAX_SCALE, Math.round((prev + SCALE_STEP) * 100) / 100));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((prev) => {
      const next = Math.max(MIN_SCALE, Math.round((prev - SCALE_STEP) * 100) / 100);
      if (next <= 1) {
        setPosition({ x: 0, y: 0 });
      }
      return next;
    });
  }, []);

  const resetZoom = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  const toggleActualSize = useCallback(() => {
    setScale((prev) => {
      if (prev === 1) {
        return 2;
      }
      setPosition({ x: 0, y: 0 });
      return 1;
    });
  }, []);

  // Keyboard navigation & shortcuts
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === '+' || event.key === '=' || event.key === 'Add') {
        event.preventDefault();
        zoomIn();
        return;
      }

      if (event.key === '-' || event.key === '_' || event.key === 'Subtract') {
        event.preventDefault();
        zoomOut();
        return;
      }

      if (event.key === '0' || event.key === 'Numpad0') {
        event.preventDefault();
        resetZoom();
        return;
      }

      if (scale > 1) {
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setPosition((p) => ({ ...p, y: clampY(p.y + PAN_STEP, scale) }));
        } else if (event.key === 'ArrowDown') {
          event.preventDefault();
          setPosition((p) => ({ ...p, y: clampY(p.y - PAN_STEP, scale) }));
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          setPosition((p) => ({ ...p, x: clampX(p.x + PAN_STEP, scale) }));
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          setPosition((p) => ({ ...p, x: clampX(p.x - PAN_STEP, scale) }));
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, zoomIn, zoomOut, resetZoom, scale]);

  // Focus management: focus close button on open, restore on close (#942)
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // Wheel zoom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = -e.deltaY;
      const factor = delta > 0 ? 1.15 : 0.85;
      setScale((prev) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(prev * factor * 100) / 100));
        if (next <= 1) {
          setPosition({ x: 0, y: 0 });
        }
        return next;
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  const handlePointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (e.button !== 0 || scale <= 1) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    isDraggingRef.current = true;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!isDraggingRef.current || scale <= 1) return;
    const newX = e.clientX - dragStartRef.current.x;
    const newY = e.clientY - dragStartRef.current.y;
    setPosition({
      x: clampX(newX, scale),
      y: clampY(newY, scale),
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    if (isDraggingRef.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // Pointer capture release safety
      }
      isDraggingRef.current = false;
      setIsDragging(false);
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLImageElement>) => {
    if (isDraggingRef.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      } catch {
        // Pointer capture release safety
      }
      isDraggingRef.current = false;
      setIsDragging(false);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setScale((prev) => {
      if (prev === 1) {
        return 2;
      }
      setPosition({ x: 0, y: 0 });
      return 1;
    });
  };

  // Focus trap inside dialog
  const handleKeyDownTrap = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab') return;
    const dialog = e.currentTarget;
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  const isAtDefault = scale === 1 && position.x === 0 && position.y === 0;

  return (
    <m.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
      onKeyDown={handleKeyDownTrap}
      role="dialog"
      aria-modal="true"
      aria-label={`Image preview: ${alt}`}
    >
      <button
        ref={closeButtonRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 z-50 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer"
        aria-label="Close preview"
        title="Close (Esc)"
      >
        <X size={18} aria-hidden="true" />
      </button>

      <div
        ref={containerRef}
        className="relative flex h-full w-full items-center justify-center overflow-hidden p-4 select-none touch-none"
      >
        {loading ? (
          <div className="text-sm text-white/70">Loading image…</div>
        ) : blobSrc ? (
          <img
            ref={imageRef}
            src={blobSrc}
            alt={alt}
            draggable={false}
            style={{
              transform: `translate3d(${position.x}px, ${position.y}px, 0px) scale(${scale})`,
              transition: isDragging ? 'none' : 'transform 0.15s ease-out',
              willChange: 'transform',
            }}
            className={cn(
              'max-h-[90vh] max-w-[90vw] rounded-2xl object-contain select-none',
              scale > 1
                ? isDragging
                  ? 'cursor-grabbing'
                  : 'cursor-grab'
                : 'cursor-zoom-in'
            )}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={handleDoubleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
          />
        ) : (
          <div className="text-sm text-white/70">Failed to load image.</div>
        )}
      </div>

      {/* Floating HUD Toolbar */}
      <div
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 nm-card-elevated flex items-center gap-1 sm:gap-1.5 rounded-2xl px-2 py-1.5 sm:px-3 sm:py-2 text-foreground select-none"
        onClick={(e) => e.stopPropagation()}
        role="toolbar"
        aria-label="Image zoom controls"
      >
        <button
          type="button"
          onClick={zoomOut}
          disabled={scale <= MIN_SCALE}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45 disabled:pointer-events-none cursor-pointer"
          aria-label="Zoom out"
          title="Zoom out (-)"
        >
          <ZoomOut size={16} aria-hidden="true" />
        </button>

        <span
          className="min-w-[3.5rem] px-1 text-center font-mono text-xs font-semibold tabular-nums text-foreground select-none"
          aria-live="polite"
          aria-label={`Current zoom: ${Math.round(scale * 100)} percent`}
        >
          {Math.round(scale * 100)}%
        </span>

        <button
          type="button"
          onClick={zoomIn}
          disabled={scale >= MAX_SCALE}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45 disabled:pointer-events-none cursor-pointer"
          aria-label="Zoom in"
          title="Zoom in (+)"
        >
          <ZoomIn size={16} aria-hidden="true" />
        </button>

        <span aria-hidden="true" className="h-4 w-px bg-border shrink-0" />

        <button
          type="button"
          onClick={resetZoom}
          disabled={isAtDefault}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-45 disabled:pointer-events-none cursor-pointer"
          aria-label="Reset zoom and pan"
          title="Reset to fit (0)"
        >
          <RotateCcw size={15} aria-hidden="true" />
        </button>

        <button
          type="button"
          onClick={toggleActualSize}
          className="inline-flex h-7 px-2 items-center justify-center rounded-[var(--radius-sm)] text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring cursor-pointer"
          aria-label="Toggle actual size"
          title="Toggle 1:1 / 2x zoom"
        >
          <span>1:1</span>
        </button>
      </div>
    </m.div>
  );
}
