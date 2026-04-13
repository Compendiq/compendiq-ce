import { useRef, useState, useCallback, useEffect } from 'react';

/**
 * Minimum interval (ms) between React state flushes during streaming.
 * Chunks arriving faster than this are batched together, reducing re-renders
 * from potentially hundreds (one per SSE token) to ~20 per second.
 */
const FLUSH_INTERVAL_MS = 50;

export interface StreamingContentHandle {
  /** The content string that React renders. Updated at most every FLUSH_INTERVAL_MS. */
  displayContent: string;
  /** Whether a stream is currently active. */
  isActive: boolean;
  /** Append a chunk of text. Batches updates via requestAnimationFrame + throttle. */
  append: (chunk: string) => void;
  /** Get the current full accumulated content (reads from the ref, not state). */
  getContent: () => string;
  /** Reset the buffer and display content for a new stream. */
  start: () => void;
  /** Flush any remaining buffered content and mark stream as complete. */
  finish: () => void;
}

/**
 * Hook that batches SSE streaming text updates to avoid per-token re-renders.
 *
 * Instead of calling `setMessages` on every SSE chunk (which triggers a full
 * React reconciliation + Markdown re-render each time), this hook accumulates
 * text in a ref and flushes to React state at most every ~50ms using
 * requestAnimationFrame.
 *
 * Usage:
 * ```ts
 * const streaming = useStreamingContent();
 * // When stream starts:
 * streaming.start();
 * // On each SSE chunk:
 * streaming.append(chunk.content);
 * // When stream ends:
 * streaming.finish();
 * // In JSX, use streaming.displayContent for rendering
 * ```
 */
export function useStreamingContent(): StreamingContentHandle {
  const [displayContent, setDisplayContent] = useState('');
  const [isActive, setIsActive] = useState(false);

  // Accumulated content (source of truth during streaming)
  const bufferRef = useRef('');
  // Tracks whether a flush is already scheduled
  const flushScheduledRef = useRef(false);
  // Separate handles for rAF and setTimeout to avoid cross-cancellation issues
  const rafRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timestamp of last flush
  const lastFlushRef = useRef(0);

  const cancelPending = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    flushScheduledRef.current = false;
    lastFlushRef.current = performance.now();
    setDisplayContent(bufferRef.current);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;

    const elapsed = performance.now() - lastFlushRef.current;
    if (elapsed >= FLUSH_INTERVAL_MS) {
      // Enough time has passed, flush on next animation frame
      rafRef.current = requestAnimationFrame(flush);
    } else {
      // Throttle: wait for the remaining interval, then flush
      const delay = FLUSH_INTERVAL_MS - elapsed;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        rafRef.current = requestAnimationFrame(flush);
      }, delay);
    }
  }, [flush]);

  const append = useCallback((chunk: string) => {
    bufferRef.current += chunk;
    scheduleFlush();
  }, [scheduleFlush]);

  const getContent = useCallback(() => bufferRef.current, []);

  const start = useCallback(() => {
    bufferRef.current = '';
    lastFlushRef.current = 0;
    flushScheduledRef.current = false;
    setDisplayContent('');
    setIsActive(true);
  }, []);

  const finish = useCallback(() => {
    // Cancel any pending flush
    cancelPending();
    flushScheduledRef.current = false;
    // Final synchronous flush to ensure nothing is lost
    setDisplayContent(bufferRef.current);
    setIsActive(false);
  }, [cancelPending]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelPending();
    };
  }, [cancelPending]);

  return { displayContent, isActive, append, getContent, start, finish };
}
