import { useCallback } from 'react';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { toast } from 'sonner';

/**
 * Quality analysis mode: one-click multi-dimensional quality analysis of the selected page.
 */
export function QualityModeInput() {
  const { isStreaming, page, model, pageId, includeSubPages, runStream } = useAiContext();

  const handleQuality = useCallback(async () => {
    if (isStreaming) return;
    if (!page) {
      toast.error('No page selected. Open a page first, then click "Analyze Quality".');
      return;
    }
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    await runStream(
      '/llm/analyze-quality',
      { content: page.bodyHtml, model, pageId, includeSubPages },
      { userMessage: `Analyze Quality: ${page.title}` },
    );
  }, [page, model, pageId, isStreaming, includeSubPages, runStream]);

  return (
    <div className="mt-3 flex items-center gap-3 border-t border-border/40 pt-3">
      <button
        onClick={handleQuality}
        disabled={isStreaming || !page || !model}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {isStreaming ? (
          <><Loader2 size={14} className="animate-spin" /> Processing...</>
        ) : !model ? (
          <><Loader2 size={14} className="animate-spin" /> Loading models...</>
        ) : (
          <><ShieldCheck size={14} /> Analyze Quality</>
        )}
      </button>
    </div>
  );
}

export const QUALITY_EMPTY_TITLE = 'Analyze article quality across multiple dimensions';
export function qualityEmptySubtitle(page: { title: string } | undefined): string {
  return page
    ? `Ready to analyze: ${page.title}`
    : 'Navigate to a page to analyze its quality';
}
