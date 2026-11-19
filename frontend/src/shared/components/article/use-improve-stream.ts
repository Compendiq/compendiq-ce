import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { streamSSE } from '../../lib/sse';
import type { ImprovementType } from '@compendiq/contracts';
import { getClientInferenceManager } from '../../lib/client-inference/client-inference-manager';
import { EditorAiContext } from '../../lib/editor-ai-context';
import { editorAiUnavailableReason } from '../../lib/article-ai-policy';

type ImproveStreamStatus = 'idle' | 'streaming' | 'done' | 'error';
interface ImproveChunk { content?: string; finalContent?: string; error?: string; done?: boolean }
export interface UseImproveStreamResult {
  status: ImproveStreamStatus;
  output: string;
  error: string | null;
  unavailableReason: string | null;
  run: (content: string, type: ImprovementType, instruction?: string) => Promise<void>;
  abort: () => void;
  reset: () => void;
}

/** Selection and block rewrites retain their article identity, including unsaved text. */
export function useImproveStream(): UseImproveStreamResult {
  const context = useContext(EditorAiContext);
  const { pageId, policy, revision, permitted } = context;
  const unavailableReason = editorAiUnavailableReason(policy)
    ?? (!pageId || permitted !== true || !Number.isSafeInteger(revision) ? 'Unavailable: article identity or AI permission could not be checked.' : null);
  const [status, setStatus] = useState<ImproveStreamStatus>('idle');
  const [output, setOutput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const abort = useCallback(() => { abortRef.current?.abort(); abortRef.current = null; }, []);
  const reset = useCallback(() => { abort(); setStatus('idle'); setOutput(''); setError(null); }, [abort]);
  useEffect(() => { reset(); return abort; }, [pageId, policy, revision, permitted, reset, abort]);
  useEffect(() => {
    window.addEventListener('offline', reset);
    return () => window.removeEventListener('offline', reset);
  }, [reset]);

  const run = useCallback(async (content: string, type: ImprovementType, instruction?: string) => {
    reset();
    if (unavailableReason) { setError(unavailableReason); setStatus('error'); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    const live = () => !controller.signal.aborted && abortRef.current === controller;
    const manager = getClientInferenceManager();
    setStatus('streaming');
    try {
      const admitted = await manager.articleRevision(Number(pageId), controller.signal);
      if (!live()) return;
      if (admitted === null || admitted !== revision) throw new Error('Article AI policy changed or could not be checked. Refresh and retry.');
      const local = await manager.decideRewrite({
        text: content, task: type === 'grammar' ? 'grammar' : type === 'completeness' ? 'completeness' : 'clarity',
        instruction, signal: controller.signal, pageId: Number(pageId),
      });
      if (!live()) return;
      let accumulated = '';
      if (local.kind === 'local') accumulated = local.text;
      else {
        let completed = false;
        for await (const chunk of streamSSE<ImproveChunk>('/llm/improve', {
          content, type, pageId, model: 'selection', ...(instruction ? { instruction } : {}),
        }, controller.signal)) {
          if (!live()) return;
          if (chunk.error) throw new Error(chunk.error);
          if (chunk.done) completed = true;
          if (chunk.finalContent !== undefined) accumulated = chunk.finalContent;
          else if (chunk.content) accumulated += chunk.content;
        }
        if (!completed) throw new Error('The response was interrupted before completion. Retry to generate a new preview.');
      }
      const current = await manager.articleRevision(Number(pageId), controller.signal);
      if (!live()) return;
      if (current !== admitted) throw new Error('Article AI policy changed. The stale preview was discarded.');
      setOutput(accumulated);
      setStatus('done');
    } catch (err) {
      if (!live()) return;
      setOutput('');
      setError(err instanceof Error ? err.message : 'Improve request failed');
      setStatus('error');
    }
  }, [reset, unavailableReason, pageId, revision]);

  // Completed previews are still reusable AI output: retire them when authorization changes.
  useEffect(() => {
    if (status !== 'done' && status !== 'streaming') return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      void getClientInferenceManager().articleRevision(Number(pageId), controller.signal).then((current) => {
        if (!controller.signal.aborted && current !== revision) reset();
      });
    }, 1000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [status, pageId, revision, reset]);
  return { status, output: unavailableReason ? '' : output, error, unavailableReason, run, abort, reset };
}
