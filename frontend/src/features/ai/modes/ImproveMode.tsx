/* eslint-disable react-refresh/only-export-components */
import { useCallback, useRef, useState } from 'react';
import { Wand2, Loader2 } from 'lucide-react';
import { useAiContext } from '../AiContext';
import { DiffView } from '../../../shared/components/article/DiffView';
import { cn } from '../../../shared/lib/cn';
import { apiFetch } from '../../../shared/lib/api';
import { toast } from 'sonner';

const IMPROVEMENT_TYPES = ['grammar', 'structure', 'clarity', 'technical', 'completeness'] as const;

const IMPROVEMENT_DESCRIPTIONS: Record<(typeof IMPROVEMENT_TYPES)[number], string> = {
  grammar: 'Fix spelling, grammar, and punctuation without changing meaning',
  structure: 'Reorganize headings, paragraph flow, and logical order',
  clarity: 'Simplify complex sentences and remove unnecessary jargon',
  technical: 'Fix technical errors and add missing technical details',
  completeness: 'Fill gaps, add missing sections, and include examples',
};

/**
 * Improvement type selector rendered above the message area.
 */
export function ImproveTypeSelector() {
  const { improvementType, setImprovementType } = useAiContext();
  return (
    <div className="glass-toolbar mb-4 space-y-2 p-3">
      <span className="text-sm text-muted-foreground">Improvement type:</span>
      <div className="flex flex-wrap items-center gap-2">
        {IMPROVEMENT_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => setImprovementType(type)}
            title={IMPROVEMENT_DESCRIPTIONS[type]}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs capitalize',
              improvementType === type ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-foreground/5',
            )}
          >
            {type}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground/70">
        {IMPROVEMENT_DESCRIPTIONS[improvementType as keyof typeof IMPROVEMENT_DESCRIPTIONS]}
      </p>
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
 * Input bar for improve mode: an optional instruction textarea and an action button.
 */
export function ImproveModeInput() {
  const {
    isStreaming, page, isPageLoading, model, pageId, includeSubPages, runStream,
    improvementType, setShowDiffView, setImprovedContent,
  } = useAiContext();
  const [instruction, setInstruction] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

    const body: Record<string, unknown> = {
      content: page.bodyHtml, type: improvementType, model, pageId: pageId ?? undefined, includeSubPages,
    };
    if (instruction.trim()) {
      body.instruction = instruction.trim();
    }

    await runStream(
      '/llm/improve',
      body,
      {
        userMessage: `Improve (${improvementType}): ${page.title}`,
        onComplete: (accumulated) => {
          setImprovedContent(accumulated);
          setShowDiffView(true);
        },
      },
    );
  }, [page, model, improvementType, pageId, isStreaming, includeSubPages, instruction, runStream, setShowDiffView, setImprovedContent]);

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-border/40 pt-3">
      <textarea
        ref={textareaRef}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="Additional instructions (optional) — e.g. 'Focus on the intro' or paste draft notes to merge"
        maxLength={10000}
        rows={2}
        disabled={isStreaming}
        className="w-full resize-y rounded-lg border border-border/40 bg-background/50 px-3 py-2 text-sm placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none disabled:opacity-50"
      />
      <button
        onClick={handleImprove}
        disabled={isStreaming || !page || isPageLoading || !model}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
      >
        {isStreaming ? (
          <><Loader2 size={14} className="animate-spin" /> Processing...</>
        ) : isPageLoading ? (
          <><Loader2 size={14} className="animate-spin" /> Loading page...</>
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
