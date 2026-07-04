import { useCallback, useRef, useState } from 'react';
import { streamSSE } from '../../lib/sse';
import type { ImprovementType } from '@compendiq/contracts';

/**
 * #708 — Lightweight SSE consumer for the editor bubble menu's inline AI
 * improve. Deliberately separate from `AiContext.runStream`, which is scoped
 * to the `/ai` page (it owns conversation/message/thinking state and a single
 * shared abort controller). The editor only needs to stream the improved
 * fragment for the current selection into a popover preview — so this hook
 * keeps just the accumulated text, a status, and its own abort controller.
 *
 * The request sends ONLY the selected fragment as `content`, with `pageId` /
 * `includeSubPages` omitted, so the backend skips whole-page/sub-page context
 * assembly and never writes an `llm_improvements` row (selection edits are
 * ephemeral previews, not page-level improvements).
 */

type ImproveStreamStatus = 'idle' | 'streaming' | 'done' | 'error';

/** SSE chunk shapes emitted by `/llm/improve` (see `streamSSE` on the backend). */
interface ImproveChunk {
  content?: string;
  finalContent?: string;
  error?: string;
  done?: boolean;
}

export interface UseImproveStreamResult {
  status: ImproveStreamStatus;
  /** Accumulated improved Markdown streamed so far. */
  output: string;
  error: string | null;
  /** Start a stream for the given selection text + improvement type. */
  run: (content: string, type: ImprovementType, instruction?: string) => Promise<void>;
  /** Abort the in-flight stream (no-op if idle). */
  abort: () => void;
  /** Reset back to idle, clearing output/error. */
  reset: () => void;
}

// The backend resolves the `chat` use-case itself and ignores the request's
// `model` beyond logging; the schema only requires a non-empty string. We send
// a sentinel so validation passes without the editor needing model state.
const SELECTION_MODEL = 'selection';

export function useImproveStream(): UseImproveStreamResult {
  const [status, setStatus] = useState<ImproveStreamStatus>('idle');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const reset = useCallback(() => {
    abort();
    setStatus('idle');
    setOutput('');
    setError(null);
  }, [abort]);

  const run = useCallback(async (content: string, type: ImprovementType, instruction?: string) => {
    abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setStatus('streaming');
    setOutput('');
    setError(null);

    let accumulated = '';
    try {
      for await (const chunk of streamSSE<ImproveChunk>(
        '/llm/improve',
        {
          content,
          type,
          model: SELECTION_MODEL,
          // pageId / includeSubPages intentionally omitted — selection-only.
          ...(instruction ? { instruction } : {}),
        },
        controller.signal,
      )) {
        if (chunk.error) {
          setError(chunk.error);
          setStatus('error');
          return;
        }
        // Post-processing may emit a cleaned full replacement.
        if (chunk.finalContent !== undefined) {
          accumulated = chunk.finalContent;
          setOutput(accumulated);
        } else if (chunk.content) {
          accumulated += chunk.content;
          setOutput(accumulated);
        }
      }
      setStatus('done');
    } catch (err) {
      // Aborts are intentional (user discarded / retried) — stay silent.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Improve request failed');
      setStatus('error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [abort]);

  return { status, output, error, run, abort, reset };
}
