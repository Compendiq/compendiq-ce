import { useCallback } from 'react';
import { toast } from 'sonner';
import { ApiError } from '../../../shared/lib/api';
import { useAiContext, nextMessageId } from '../AiContext';
import { chipUserMessage, type DockChipId } from './dock-chips';

export interface DockActionOptions {
  /**
   * Text of a document attached in the composer (#1131). Improve is the one
   * action that can use it, so it is the one action that sends it. Passed in
   * rather than read from AiContext because the attachment belongs to the dock
   * that holds it, not to the conversation.
   */
  referenceText?: string;
  /**
   * #1154: handle of an image staged by `POST /llm/prepare-image`, from the same
   * composer and for the same one action.
   */
  imageHandle?: string;
  /**
   * True while either attachment slot is still being prepared — the panel's
   * `isBusy`. Improve is the one action that reads an attachment, so it is the
   * one action that has to wait for it.
   *
   * The chip's own `disabled` is not enough. `runChip` is also reached from
   * `DockDiffCard`'s "Re-run Improve", which carries no disabled state — so the
   * guard has to live in the handler, where every caller passes through it.
   * `/ai`'s Generate and Improve already re-check their `isBusy` inside their
   * handlers for the same reason (#940).
   *
   * #1176 removed a second such caller — the effect that ran Improve the moment
   * the dock opened. The guard outlives it because the re-run button does.
   */
  isBusy?: boolean;
  /**
   * Drop the staged image because the server no longer has it (410). The handle
   * is owned by the panel's `useAttachments`, not by this hook, so the rollback
   * has to ask for it — see the 410 branch below for the rest of the undo.
   */
  onImageExpired?: () => void;
  /**
   * Clear the attached image once it has been consumed by a request (ask or improve).
   */
  onImageConsumed?: () => void;
  /**
   * #1119: run this one question through #1112's multi-query expansion.
   *
   * Passed in from the panel's own `useState` rather than read from AiContext,
   * for the same reason the attachments are: it belongs to the question being
   * typed, not to the conversation — and AiContext is where every sticky option
   * in this app lives (`thinkingMode` writes localStorage, `includeSubPages`
   * survives every ask), so putting it there is how it would become one.
   *
   * Only `ask()` sends it. The four chips are app-authored jobs over the open
   * document, not knowledge-base questions the user phrased, so there is no
   * vocabulary gap for expansion to close — and `improve` / `summarize` /
   * `diagram` do not post to `/llm/ask` at all.
   */
  deepSearch?: boolean;
  /**
   * Called once the deep-search flag has been spent, so the panel can clear its
   * toggle. Both run paths call it, for two different reasons.
   *
   * `ask()` CONSUMES it: the flag is folded into the request body first. The
   * reset lives inside `ask()`, beside `setInput('')` and after the guards,
   * rather than at the two call sites — `ask()` returns early on an empty
   * prompt (Enter on an empty composer reaches it), so a reset at the call site
   * would silently discard the user's choice without sending anything, and a
   * reset placed after the `await` would be skipped on abort and on error,
   * leaving the toggle lit for the next question.
   *
   * `runChip()` CANNOT consume it — none of the four routes it posts to takes
   * the flag — so it CLEARS it instead. Leaving it lit through a run that
   * ignores it is the one option ruled out: the control would then be showing a
   * mode the request it just started is not in. Placed after the same guards
   * for the same reason, so a chip press that only toasts "No page open." keeps
   * the choice.
   */
  onDeepSearchConsumed?: () => void;
}

/**
 * Submit handlers for the docked assistant: the free-text question and the four
 * seeding chips (#1126).
 *
 * Everything a chip needs — the page body, the model, the sub-page flag,
 * thinking mode, the improvement / diagram type — already lives in AiContext.
 * None of it was ever mode-local state, which is why four modes could collapse
 * into four chips without moving any data.
 */
export function useDockActions({
  referenceText, imageHandle, isBusy = false, onImageExpired, onImageConsumed,
  deepSearch = false, onDeepSearchConsumed,
}: DockActionOptions = {}) {
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

    if (isBusy) {
      toast.error('Still attaching — try again in a moment.');
      return;
    }

    // Captured before the reset and before the await, exactly as `/ai`'s
    // AskMode does it — see `onDeepSearchConsumed` for why neither the call
    // site nor a post-await reset is a safe home for this.
    const useDeepSearch = deepSearch;
    setInput('');
    onDeepSearchConsumed?.();
    if (imageHandle) onImageConsumed?.();
    setMessages((prev) => [...prev, { id: nextMessageId(), role: 'user', content: question }]);

    await runStream(
      '/llm/ask',
      {
        question,
        model,
        conversationId: conversationId ?? undefined,
        pageId: pageId ?? undefined,
        includeSubPages,
        ...(imageHandle && { imageHandle }),
        ...(thinkingMode && { thinking: true }),
        // Omitted when off, like `thinking` — an untouched toggle sends the body
        // this composer has always sent.
        ...(useDeepSearch && { deepSearch: true }),
      },
      {
        onError: (err) => {
          if (!imageHandle) return false;
          if (!(err instanceof ApiError) || err.statusCode !== 410) return false;
          onImageExpired?.();
          setInput(question);
          toast.error('The image expired — attach it again.');
          return true;
        },
      },
    );
  }, [
    input, canRun, isBusy, setInput, onDeepSearchConsumed, imageHandle, onImageConsumed, setMessages, runStream,
    model, conversationId, pageId, includeSubPages, thinkingMode, deepSearch, onImageExpired,
  ]);

  const runChip = useCallback(async (id: DockChipId) => {
    if (!page || !pageId) {
      toast.error('No page open.');
      return;
    }
    if (!canRun()) return;

    // A chip run is a run: the toggle describes the next request, and this is
    // it. None of the four routes below accepts `deepSearch`, so the flag is
    // dropped here rather than carried silently past a request that ignores it
    // — see `onDeepSearchConsumed`. Past the guards above, so a chip that
    // refuses to run keeps the user's choice intact.
    onDeepSearchConsumed?.();

    const instruction = input.trim();
    const userMessage = chipUserMessage(id, { improvementType, diagramType, instruction });
    const thinking = thinkingMode ? { thinking: true } : {};

    switch (id) {
      case 'improve': {
        // Wait out an in-flight attachment. The chip is disabled for this, but
        // "Re-run Improve" on a stale diff card is not, and it lands here — so
        // without this the request would go with `imageHandle` undefined while
        // the image card is still on screen, which is #940's exact shape. Said
        // rather than silently dropped: nothing else on screen explains it.
        if (isBusy) {
          toast.error('Still attaching — try again in a moment.');
          return;
        }
        // Capture the version the model is about to be shown. If the document
        // moves before the diff is applied, that mismatch is what turns Apply
        // into an offer to re-run instead of a silent overwrite.
        const baseVersion = page.version;
        // Only Improve can carry the composer's free text, so only Improve
        // consumes it. The other three leave it in place rather than swallowing
        // a prompt they cannot use.
        if (instruction) setInput('');
        if (imageHandle) onImageConsumed?.();
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
            // A dedicated field, never folded into `instruction`: that one is
            // capped at 10K and lands in the system prompt, so a real document
            // would both overflow it and arrive with a directive's authority.
            ...(referenceText && { referenceText }),
            ...(imageHandle && { imageHandle }),
            ...thinking,
          },
          {
            userMessage,
            // A 410 means the staged image is gone: either the 15-minute TTL
            // lapsed (`routes/llm/_helpers.ts` → `httpErrors.gone`) or another
            // surface staged an image and pruned this one —
            // `pruneOlderStagedImages` keeps only the newest per user, so an
            // open `/ai` tab is enough. That makes expiry ordinary here rather
            // than exotic, so the send is rolled back instead of left as a dead
            // turn with an error under it.
            //
            // What this owns: the image slot (via the panel, which holds it)
            // and the instruction cleared a few lines above. runStream owns the
            // two rows it seeded — `userMessage` and the placeholder — and
            // removes both itself; neither id is visible from here. The diff
            // state reset above needs no undo: it is already the "no diff" state.
            //
            // Guarded on `imageHandle` because only the image path can produce
            // a 410 today. A 410 from anywhere else is somebody else's error and
            // keeps its normal inline treatment rather than being explained away
            // with an image message that would not be true.
            onError: (err) => {
              if (!imageHandle) return false;
              if (!(err instanceof ApiError) || err.statusCode !== 410) return false;
              onImageExpired?.();
              if (instruction) setInput(instruction);
              toast.error('The image expired — attach it again.');
              return true;
            },
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
    includeSubPages, referenceText, imageHandle, isBusy, onImageExpired, onDeepSearchConsumed,
    runStream, setInput,
    setShowDiffView, setImprovedContent, setOriginalMarkdown, setLayoutTokensLost,
    setDiffBaseVersion, setDiagramCode,
  ]);

  return { ask, runChip, canRun };
}
