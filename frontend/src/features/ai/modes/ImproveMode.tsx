/* eslint-disable react-refresh/only-export-components */
import { useCallback, useRef, useState } from 'react';
import { Wand2, Loader2, Globe } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
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
 * Improvement type selector rendered just under the mode segmented control.
 * Visual grammar matches the AI sub-header: a single `rounded-xl border` card
 * with h-7 outlined chips so all of the AI surfaces feel like one toolbar
 * stack rather than three different controls.
 */
export function ImproveTypeSelector() {
  const { improvementType, setImprovementType } = useAiContext();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/40 bg-card/50 px-3 py-2 backdrop-blur-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground/80">
        Improvement type
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {IMPROVEMENT_TYPES.map((type) => (
          <button
            key={type}
            onClick={() => setImprovementType(type)}
            title={IMPROVEMENT_DESCRIPTIONS[type]}
            aria-pressed={improvementType === type}
            className={cn(
              'flex h-7 items-center rounded-md border px-2.5 text-xs capitalize transition-colors',
              improvementType === type
                ? 'border-primary/45 bg-primary/15 text-primary-ink font-medium'
                : 'border-border/40 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            {type}
          </button>
        ))}
      </div>
      <p className="basis-full text-xs text-muted-foreground/80">
        {IMPROVEMENT_DESCRIPTIONS[improvementType as keyof typeof IMPROVEMENT_DESCRIPTIONS]}
      </p>
    </div>
  );
}

/**
 * Diff view shown after an improve stream completes.
 */
export function ImproveDiffView() {
  const { page, pageId, navigate, queryClient, isStreaming, showDiffView, setShowDiffView, improvedContent, originalMarkdown } = useAiContext();
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
      // #704: diff like-for-like — the original markdown the model was fed
      // (echoed by /llm/improve) vs the improved markdown it returned, so only
      // genuine wording/structure edits show. Falls back to the page body only
      // if the backend didn't supply the baseline (e.g. an aborted stream).
      original={originalMarkdown || page.bodyText || page.bodyHtml}
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
    isStreaming, page, isPageLoading, model, pageId, includeSubPages, thinkingMode, runStream,
    improvementType, setShowDiffView, setImprovedContent, setOriginalMarkdown,
  } = useAiContext();
  const [instruction, setInstruction] = useState('');
  const [searchWeb, setSearchWeb] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Check if MCP docs sidecar is available (for web search toggle)
  const { data: mcpSettings } = useQuery<{ enabled: boolean }>({
    queryKey: ['mcp-docs', 'status'],
    queryFn: () => apiFetch('/mcp-docs/status'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const mcpEnabled = mcpSettings?.enabled ?? false;

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
    setOriginalMarkdown('');

    const body: Record<string, unknown> = {
      content: page.bodyHtml, type: improvementType, model, pageId: pageId ?? undefined, includeSubPages,
      ...(thinkingMode && { thinking: true }),
    };
    if (instruction.trim()) {
      body.instruction = instruction.trim();
    }
    if (searchWeb) {
      body.searchWeb = true;
    }

    await runStream(
      '/llm/improve',
      body,
      {
        userMessage: `Improve (${improvementType}): ${page.title}`,
        onComplete: (accumulated, _sources, meta) => {
          setImprovedContent(accumulated);
          // #704: store the markdown baseline echoed by the backend so the diff
          // compares like-for-like markdown, not stripped bodyText.
          if (meta?.originalMarkdown !== undefined) {
            setOriginalMarkdown(meta.originalMarkdown);
          }
          setShowDiffView(true);
        },
      },
    );
  }, [page, model, improvementType, pageId, isStreaming, includeSubPages, thinkingMode, instruction, searchWeb, runStream, setShowDiffView, setImprovedContent, setOriginalMarkdown]);

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
        className="nm-input resize-y placeholder:text-muted-foreground/70 disabled:opacity-50"
      />
      {mcpEnabled && (
        <label className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="improve-search-web-toggle">
          <input
            type="checkbox"
            checked={searchWeb}
            onChange={(e) => setSearchWeb(e.target.checked)}
            disabled={isStreaming}
            className="rounded border-border/40"
          />
          <Globe size={14} />
          Search web for reference material
        </label>
      )}
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
