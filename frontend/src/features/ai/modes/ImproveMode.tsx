/* eslint-disable react-refresh/only-export-components */
import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, Wand2, Loader2, Globe } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAiContext } from '../AiContext';
import { DiffView } from '../../../shared/components/article/DiffView';
import { useAttachments } from '../../../shared/hooks/use-attachments';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { DocumentUploadZone } from '../../../shared/components/upload/DocumentUploadZone';
import { ImageAttachZone, imageDisabledReason } from '../../../shared/components/upload/ImageAttachZone';
import { cn } from '../../../shared/lib/cn';
import { apiFetch, ApiError } from '../../../shared/lib/api';
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
  const {
    page, pageId, navigate, queryClient, isStreaming, showDiffView, setShowDiffView,
    improvedContent, originalMarkdown, layoutTokensLost: backendLayoutTokensLost,
  } = useAiContext();
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
      toast.success('Page updated and synced to Confluence');
      queryClient.invalidateQueries({ queryKey: ['pages', pageId] });
      navigate(`/pages/${pageId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to apply improvement');
    } finally {
      setIsApplying(false);
    }
  }, [page, pageId, improvedContent, isApplying, queryClient, navigate]);

  if (!showDiffView || !page || !improvedContent || isStreaming) return null;

  // The page's markdown carried [[[…]]] layout boundary tokens but the AI
  // output lost every one of them: applying will most likely be rejected by
  // the backend's layout guard (422). Surface that BEFORE the user accepts.
  // The backend's final-event verdict is authoritative (it runs the real
  // recoverability scan, which also recognizes mangled token spellings); the
  // `[[[` heuristic only covers streams that ended without a final event.
  const layoutTokensLost =
    backendLayoutTokensLost ??
    (/\[\[\[/.test(originalMarkdown) && !/\[\[\[/.test(improvedContent));

  return (
    <div className="flex flex-col gap-3">
      {layoutTokensLost && (
        <div
          data-testid="layout-token-loss-warning"
          role="alert"
          className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
        >
          The AI response dropped this page's column-layout markers. Applying may fail or
          lose the layout — run Improve again to retry.
        </div>
      )}
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
    </div>
  );
}

/**
 * Input bar for improve mode: an optional instruction textarea, optional source
 * material — a document as reference (#1131's gap: this screen never had the
 * affordance the dock has had since #1131) and/or an image (#1154) — and an
 * action button.
 */
export function ImproveModeInput() {
  const {
    isStreaming, page, isPageLoading, model, pageId, includeSubPages, thinkingMode, runStream,
    improvementType, setShowDiffView, setImprovedContent, setOriginalMarkdown, setLayoutTokensLost,
    chatVision,
    chatVisionModel,
  } = useAiContext();
  const [instruction, setInstruction] = useState('');
  const [searchWeb, setSearchWeb] = useState(false);
  const textareaRef = useAutoGrowTextarea(instruction);

  // Both attachment slots, all intake routing, the shared drop target and paste
  // live in `useAttachments` (#1154) — including the format and 20 MB gates the
  // upload component used to apply.
  //
  // The ref goes on the whole Improve block rather than the composer box alone:
  // the block is short, and a file dropped on the gap beside the Improve button
  // would otherwise reach no handler at all, letting the browser navigate the
  // tab to the dropped file and take the typed instruction with it.
  const surfaceRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments({
    dropTargetRef: surfaceRef,
    imageEnabled: chatVision === true,
    imageDisabledReason: imageDisabledReason(chatVision, chatVisionModel),
    disabled: isStreaming,
  });
  // Destructured for the improve callback's dependency array: `useAttachments`
  // returns a fresh object literal every render, so a `useCallback` depending
  // on `attachments` itself was rebuilt on every render and memoized nothing.
  const {
    document: attachedDocument, image: attachedImage, isBusy, removeImage,
  } = attachments;

  // Check if MCP docs sidecar is available (for web search toggle)
  const { data: mcpSettings } = useQuery<{ enabled: boolean }>({
    queryKey: ['mcp-docs', 'status'],
    queryFn: () => apiFetch('/mcp-docs/status'),
    staleTime: 5 * 60_000,
    retry: false,
  });
  const mcpEnabled = mcpSettings?.enabled ?? false;

  const handleImprove = useCallback(async () => {
    // `isBusy` blocks the send while an extraction or an image staging
    // round-trip is still in flight — otherwise the request would go without
    // the attachment that is being prepared for it (#940, widened to both
    // slots by #1154).
    if (isStreaming || isBusy) return;
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
    setLayoutTokensLost(undefined);

    const body: Record<string, unknown> = {
      content: page.bodyHtml, type: improvementType, model, pageId: pageId ?? undefined, includeSubPages,
      ...(thinkingMode && { thinking: true }),
      // Both stay their own fields rather than being folded into `instruction`:
      // the backend sanitizes and bounds them separately, and a document folded
      // into the instruction would speak with a directive's authority.
      ...(attachedDocument && { referenceText: attachedDocument.result.text }),
      ...(attachedImage && { imageHandle: attachedImage.handle }),
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
        // A 410 means the staged image is gone: either the 15-minute TTL
        // lapsed (`routes/llm/_helpers.ts` → `httpErrors.gone`) or another
        // surface staged an image and pruned this one — `pruneOlderStagedImages`
        // keeps only the newest per user, so two open tabs are enough. Nothing
        // was improved, so the send is rolled back rather than left as a dead
        // turn with an error under it. Only the image slot is cleared here:
        // this mode seeds no turn of its own (it passes `userMessage`, so
        // runStream owns and withdraws both rows it added) and it never clears
        // the instruction, so there is nothing else of ours to put back.
        // Guarded on the image the way the dock's handler is: only the image
        // path can produce a 410 today, and a 410 from anywhere else is
        // somebody else's error, which keeps its normal inline treatment.
        onError: (err) => {
          if (!attachedImage) return false;
          if (!(err instanceof ApiError) || err.statusCode !== 410) return false;
          removeImage();
          toast.error('The image expired — attach it again.');
          return true;
        },
        onComplete: (accumulated, _sources, meta) => {
          setImprovedContent(accumulated);
          // #704: store the markdown baseline echoed by the backend so the diff
          // compares like-for-like markdown, not stripped bodyText.
          if (meta?.originalMarkdown !== undefined) {
            setOriginalMarkdown(meta.originalMarkdown);
          }
          setLayoutTokensLost(meta?.layoutTokensLost);
          setShowDiffView(true);
        },
      },
    );
  }, [
    page, model, improvementType, pageId, isStreaming, includeSubPages, thinkingMode, instruction,
    searchWeb, runStream, setShowDiffView, setImprovedContent, setOriginalMarkdown,
    setLayoutTokensLost,
    isBusy, attachedDocument, attachedImage, removeImage,
  ]);

  return (
    <div ref={surfaceRef} className="mt-3 flex flex-col gap-3 border-t border-border/40 pt-3">
      {/* An advisory, not a refusal: the backend accepts both, and only the
          resolved model knows whether they fit. Amber is the attention colour
          under ADR-010 v0.5 and this is exactly that. */}
      {attachments.document && attachments.image && (
        <p
          className="flex items-center gap-1.5 text-xs text-warning"
          data-testid="attachment-context-warning"
        >
          <AlertTriangle size={12} className="shrink-0" aria-hidden />
          Both attachments will be sent — a small model may not fit them.
        </p>
      )}

      {/* The instruction field and both attach triggers share one box, so an
          attachment reads as part of what the Improve button is about to send.

          `flex-wrap` lets each zone's row — its card or drop hint plus its own
          trigger — stack above the instruction field. Document order is the
          only order here: no `order-*` on any child, because that is what keeps
          the tab sequence matching what the eye reads (WCAG 2.4.3 — see
          `composerRowClass`). Anything added below lands where its markup sits,
          so put it where it should be read. */}
      <div className="nm-composer flex-wrap">
        <DocumentUploadZone
          variant="composer"
          onPick={attachments.pickFile}
          extracted={attachments.document?.result ?? null}
          filename={attachments.document?.filename ?? null}
          onRemove={attachments.removeDocument}
          isExtracting={attachments.isExtracting}
          isDragOver={attachments.isDragOver}
          disabled={isStreaming}
          triggerLabel="Attach a document as reference for Improve"
          usageHint="reference for Improve"
        />
        <ImageAttachZone
          vision={chatVision}
          visionModel={chatVisionModel}
          image={attachments.image}
          onPick={attachments.pickFile}
          onRemove={attachments.removeImage}
          isPreparing={attachments.isPreparing}
          disabled={isStreaming}
        />
        <textarea
          ref={textareaRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Additional instructions (optional) — e.g. 'Focus on the intro' or paste draft notes to merge"
          maxLength={10000}
          rows={2}
          disabled={isStreaming}
          // The composer wrapper owns the inset surface, border and focus ring,
          // so the field stays transparent. resize-none because the auto-grow
          // hook owns the height — a drag handle would fight it. min-w-0 so the
          // textarea's intrinsic `cols` width can't push the box wider than a
          // narrow viewport.
          className="min-w-0 grow basis-40 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
        />
      </div>
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
        disabled={isStreaming || !page || isPageLoading || !model || attachments.isBusy}
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
