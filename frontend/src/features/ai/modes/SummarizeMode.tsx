import { useCallback } from 'react';
import { ListCollapse, Loader2 } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { toast } from 'sonner';

/**
 * Summarize mode: one-click summarization of the selected page.
 */
export function SummarizeModeInput() {
  const { isStreaming, page, model, pageId, includeSubPages, runStream } = useAiContext();

  const handleSummarize = useCallback(async () => {
    if (isStreaming) return;
    if (!page) {
      toast.error('No page selected. Open a page first, then click "Summarize".');
      return;
    }
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    await runStream(
      '/llm/summarize',
      { content: page.bodyHtml, model, pageId, includeSubPages },
      { userMessage: `Summarize: ${page.title}` },
    );
  }, [page, model, isStreaming, pageId, includeSubPages, runStream]);

  return (
    <div className="glass-card mt-4 flex items-center gap-3 p-3">
      <button
        onClick={handleSummarize}
        disabled={isStreaming || !page || !model}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {isStreaming ? (
          <><Loader2 size={14} className="animate-spin" /> Processing...</>
        ) : !model ? (
          <><Loader2 size={14} className="animate-spin" /> Loading models...</>
        ) : (
          <><ListCollapse size={14} /> Summarize Page</>
        )}
      </button>
    </div>
  );
}

export const SUMMARIZE_EMPTY_TITLE = 'Select a page to summarize';
export function summarizeEmptySubtitle(page: { title: string } | undefined): string {
  return page
    ? `Ready to summarize: ${page.title}`
    : 'Navigate to a page and click "Summarize" to get started';
}
