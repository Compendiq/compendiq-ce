import { useCallback, useState } from 'react';
import { Wand2, Loader2 } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { DiffView } from '../../../shared/components/DiffView';
import { cn } from '../../../shared/lib/cn';
import { apiFetch } from '../../../shared/lib/api';
import { toast } from 'sonner';

const IMPROVEMENT_TYPES = ['grammar', 'structure', 'clarity', 'technical', 'completeness'] as const;

/**
 * Improvement type selector rendered above the message area.
 */
export function ImproveTypeSelector() {
  const { improvementType, setImprovementType } = useAiContext();
  return (
    <div className="glass-toolbar mb-4 flex items-center gap-2 p-3">
      <span className="text-sm text-muted-foreground">Type:</span>
      {IMPROVEMENT_TYPES.map((type) => (
        <button
          key={type}
          onClick={() => setImprovementType(type)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs capitalize',
            improvementType === type ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
          )}
        >
          {type}
        </button>
      ))}
    </div>
  );
}

/**
 * Diff view shown after an improve stream completes.
 */
export function ImproveDiffView() {
  const { page, pageId, navigate, queryClient, isStreaming, showDiffView, setShowDiffView, improvedContent } = useAiContext();
  const [isApplying, setIsApplying] = useState(false);

  const handleAccept = useCallback(async () => {
    if (!page || !pageId || !improvedContent || isApplying) return;
    setIsApplying(true);
    try {
      await apiFetch(`/llm/improvements/apply`, {
        method: 'POST',
        body: JSON.stringify({
          pageId,
          improvedMarkdown: improvedContent,
          version: page.version,
          title: page.title,
        }),
      });
      toast.success('Article updated and synced to Confluence');
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
      navigate(`/pages/${pageId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply improvement');
    } finally {
      setIsApplying(false);
    }
  }, [page, pageId, improvedContent, isApplying, queryClient, navigate]);

  if (!showDiffView || !page || !improvedContent || isStreaming) return null;

  return (
    <DiffView
      original={page.bodyText || page.bodyHtml}
      improved={improvedContent}
      onAccept={handleAccept}
      onReject={() => setShowDiffView(false)}
      isAccepting={isApplying}
    />
  );
}

/**
 * Input bar for improve mode: a single action button.
 */
export function ImproveModeInput() {
  const {
    isStreaming, page, model, pageId, includeSubPages, runStream,
    improvementType, setShowDiffView, setImprovedContent,
  } = useAiContext();

  const handleImprove = useCallback(async () => {
    if (isStreaming) return;
    if (!page) {
      toast.error('No page selected. Open a page first, then click "AI Improve".');
      return;
    }
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    setShowDiffView(false);
    setImprovedContent('');

    await runStream(
      '/llm/improve',
      { content: page.bodyHtml, type: improvementType, model, pageId, includeSubPages },
      {
        userMessage: `Improve (${improvementType}): ${page.title}`,
        onComplete: (accumulated) => {
          setImprovedContent(accumulated);
          setShowDiffView(true);
        },
      },
    );
  }, [page, model, improvementType, pageId, isStreaming, includeSubPages, runStream, setShowDiffView, setImprovedContent]);

  return (
    <div className="mt-3 flex items-center gap-3 border-t border-border/40 pt-3">
      <button
        onClick={handleImprove}
        disabled={isStreaming || !page || !model}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {isStreaming ? (
          <><Loader2 size={14} className="animate-spin" /> Processing...</>
        ) : !model ? (
          <><Loader2 size={14} className="animate-spin" /> Loading models...</>
        ) : (
          <><Wand2 size={14} /> Improve Page</>
        )}
      </button>
    </div>
  );
}

export const IMPROVE_EMPTY_TITLE = 'Select a page and improvement type';
export function improveEmptySubtitle(page: { title: string } | undefined): string {
  return page
    ? `Ready to improve: ${page.title}`
    : 'Navigate to a page and click "AI Improve" to get started';
}
