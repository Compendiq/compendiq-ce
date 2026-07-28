import { useCallback } from 'react';
import { toast } from 'sonner';
import { useAiContext, nextMessageId } from '../AiContext';
import { chipUserMessage, type DockChipId } from './dock-chips';

/**
 * Submit handlers for the docked assistant: the free-text question and the four
 * seeding chips (#1126).
 *
 * Everything a chip needs — the page body, the model, the sub-page flag,
 * thinking mode, the improvement / diagram type — already lives in AiContext.
 * None of it was ever mode-local state, which is why four modes could collapse
 * into four chips without moving any data.
 */
export function useDockActions() {
  const {
    page, pageId, model, includeSubPages, thinkingMode, isStreaming, conversationId,
    improvementType, diagramType, input, setInput, setMessages, runStream,
    setShowDiffView, setImprovedContent, setOriginalMarkdown, setLayoutTokensLost,
    setDiffBaseVersion, setDiagramCode,
  } = useAiContext();

  /** Shared preflight. Returns false (having explained why) when we cannot run. */
  const canRun = useCallback((): boolean => {
    if (isStreaming) return false;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return false;
    }
    return true;
  }, [isStreaming, model]);

  const ask = useCallback(async () => {
    const question = input.trim();
    if (!question || !canRun()) return;

    setInput('');
    setMessages((prev) => [...prev, { id: nextMessageId(), role: 'user', content: question }]);

    await runStream('/llm/ask', {
      question,
      model,
      conversationId: conversationId ?? undefined,
      pageId: pageId ?? undefined,
      includeSubPages,
      ...(thinkingMode && { thinking: true }),
    });
  }, [
    input, canRun, setInput, setMessages, runStream, model, conversationId, pageId,
    includeSubPages, thinkingMode,
  ]);

  const runChip = useCallback(async (id: DockChipId) => {
    if (!page || !pageId) {
      toast.error('No page open.');
      return;
    }
    if (!canRun()) return;

    const instruction = input.trim();
    const userMessage = chipUserMessage(id, { improvementType, diagramType, instruction });
    const thinking = thinkingMode ? { thinking: true } : {};

    switch (id) {
      case 'improve': {
        // Capture the version the model is about to be shown. If the document
        // moves before the diff is applied, that mismatch is what turns Apply
        // into an offer to re-run instead of a silent overwrite.
        const baseVersion = page.version;
        // Only Improve can carry the composer's free text, so only Improve
        // consumes it. The other three leave it in place rather than swallowing
        // a prompt they cannot use.
        if (instruction) setInput('');
        setShowDiffView(false);
        setImprovedContent('');
        setOriginalMarkdown('');
        setLayoutTokensLost(undefined);
        setDiffBaseVersion(null);
        await runStream(
          '/llm/improve',
          {
            content: page.bodyHtml,
            type: improvementType,
            model,
            pageId,
            includeSubPages,
            ...(instruction && { instruction }),
            ...thinking,
          },
          {
            userMessage,
            onComplete: (accumulated, _sources, meta) => {
              setImprovedContent(accumulated);
              if (meta?.originalMarkdown !== undefined) setOriginalMarkdown(meta.originalMarkdown);
              setLayoutTokensLost(meta?.layoutTokensLost);
              setDiffBaseVersion(baseVersion);
              setShowDiffView(true);
            },
          },
        );
        return;
      }
      case 'summarize':
        await runStream(
          '/llm/summarize',
          { content: page.bodyHtml, model, pageId, includeSubPages, ...thinking },
          { userMessage },
        );
        return;
      case 'diagram':
        setDiagramCode('');
        await runStream(
          // /llm/generate-diagram takes no includeSubPages — a diagram is drawn
          // from the open document only.
          '/llm/generate-diagram',
          { content: page.bodyHtml, model, diagramType, pageId, ...thinking },
          { userMessage, onComplete: (accumulated) => setDiagramCode(accumulated) },
        );
        return;
      case 'quality':
        await runStream(
          '/llm/analyze-quality',
          { content: page.bodyHtml, model, pageId, includeSubPages, ...thinking },
          { userMessage },
        );
    }
  }, [
    page, pageId, canRun, input, improvementType, diagramType, thinkingMode, model,
    includeSubPages, runStream, setInput, setShowDiffView, setImprovedContent,
    setOriginalMarkdown, setLayoutTokensLost, setDiffBaseVersion, setDiagramCode,
  ]);

  return { ask, runChip, canRun };
}
