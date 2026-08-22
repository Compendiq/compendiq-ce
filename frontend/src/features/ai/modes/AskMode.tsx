import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Send, Link2, X, Plus } from 'lucide-react';
import { useAiContext, nextMessageId } from '../AiContext';
import { AssistantActionSelect } from '../AssistantActionSelect';
import { DeepSearchToggle } from '../DeepSearchToggle';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../../../shared/lib/api';
import { cn } from '../../../shared/lib/cn';
import { Button, IconButton } from '../../../shared/components/Button';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { buildDocumentReferenceText } from '../../../shared/hooks/use-attachments';
import { DocumentUploadZone } from '../../../shared/components/upload/DocumentUploadZone';
import { ImageAttachZone } from '../../../shared/components/upload/ImageAttachZone';
import { PROMPT_MAX_LENGTH } from './prompt-limits';
import { buildAskPrompts } from './ask-example-prompts';
import { usePages, usePageFilterOptions, isZeroEmbeddings } from '../../../shared/hooks/use-pages';
import { useSpaces } from '../../../shared/hooks/use-spaces';
import { AssistantAttachmentsScope, useAssistantAttachments } from '../AssistantAttachments';

interface McpDocsSettings {
  enabled: boolean;
}

/**
 * Q&A mode: free-text input with RAG-powered streaming responses.
 * Supports attaching external URLs for documentation context via MCP sidecar.
 */
export function AskModeInput() {
  return (
    <AssistantAttachmentsScope>
      <AskModeInputContent />
    </AssistantAttachmentsScope>
  );
}

function AskModeInputContent() {
  const {
    input, setInput, isStreaming, model, conversationId, pageId,
    includeSubPages, thinkingMode, setMessages, runStream,
    chatVision, chatVisionModel,
  } = useAiContext();

  const [externalUrls, setExternalUrls] = useState<string[]>([]);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  /**
   * #1112's multi-query expansion, opted into for ONE question (#1119).
   *
   * Plain `useState` in the composer that submits it, and that is the whole
   * enforcement: there is no store to persist it into, no `AiThread` field to
   * make it per-conversation sticky, and no localStorage read to seed it. A
   * remount — a route change, a mode switch — is a fresh `false`. See
   * `DeepSearchToggle` for why the sticky version would be a measured
   * regression rather than a taste question.
   */
  const [deepSearch, setDeepSearch] = useState(false);
  const attachments = useAssistantAttachments();
  const {
    documents, image, pickFiles, removeDocument, removeImage,
    isDragOver, isExtracting, isPreparing, isBusy,
  } = attachments;

  const handlePickFiles = useCallback((files: readonly File[]) => {
    void pickFiles(files);
  }, [pickFiles]);

  // The one boundary a remount does not cover. Switching threads from the
  // conversation sidebar — or starting a new one — swaps the conversation under
  // a composer that stays mounted, so an unconsumed toggle would carry a choice
  // made about one conversation into the first question of another. That is the
  // per-conversation stickiness this state's placement exists to prevent,
  // arrived at from the other side; the dock clears its own slots at its pageId
  // boundary for the same reason.
  //
  // Harmless on the id the server assigns mid-answer: `handleAsk` has already
  // cleared the flag by then, and the toggle is disabled while streaming.
  useEffect(() => {
    setDeepSearch(false);
  }, [conversationId]);

  // Check if MCP docs is enabled via public status endpoint (cache for 5 min)
  const { data: mcpSettings } = useQuery<McpDocsSettings>({
    queryKey: ['mcp-docs', 'status'],
    queryFn: () => apiFetch('/mcp-docs/status'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const mcpEnabled = mcpSettings?.enabled ?? false;

  const addUrl = () => {
    const url = urlInput.trim();
    if (!url) return;
    try {
      new URL(url); // Validate
    } catch {
      toast.error('Invalid URL');
      return;
    }
    if (externalUrls.length >= 5) {
      toast.error('Maximum 5 external URLs');
      return;
    }
    if (!externalUrls.includes(url)) {
      setExternalUrls((prev) => [...prev, url]);
    }
    setUrlInput('');
  };

  const removeUrl = (url: string) => {
    setExternalUrls((prev) => prev.filter((u) => u !== url));
  };

  // Doubles as the auto-grow handle and the mount-focus target.
  const inputRef = useAutoGrowTextarea(input);

  // #350: focus input on mount so the user can type immediately. Use a ref +
  // useEffect rather than autoFocus so it survives StrictMode double-mount and
  // route transitions reliably.
  useEffect(() => {
    inputRef.current?.focus();
  }, [inputRef]);

  // The composer is deliberately NOT gated on embedding status, unlike the
  // example chips below (#1257 post-review, decided on backend evidence):
  // POST /llm/ask never refuses over zero embeddings — including under the
  // #1105 confidence gate, which exempts degraded retrieval (an unembedded
  // corpus scores null, and null never refuses) — and it is not reduced
  // to ungrounded chat either: hybridSearch always runs its keyword FTS leg
  // (rag-service.ts `keywordSearch`, over synced page text, no embeddings
  // required), so a typed question can still come back grounded and cited;
  // the route also injects page-tree context (`includeSubPages` + pageId)
  // and MCP `externalUrls` docs, both embedding-free. Gating send here would
  // turn a degraded-retrieval state into a total outage of those working
  // paths. The chips differ: they are app-authored invitations to semantic
  // jobs ("find duplicates") that specifically need the vector leg, so they
  // stay inert until it verifiably exists. The amber banner above the thread
  // keeps naming the degradation in both empty and answered states.
  const handleAsk = useCallback(async () => {
    if (!input.trim() || isStreaming || isBusy) return;
    if (!model) {
      toast.error('No model available. Check your LLM provider settings.');
      return;
    }

    const question = input.trim();
    // Read-and-clear at SUBMIT time, beside the input clear and before the
    // await — not in `onComplete`, and not after `runStream` the way
    // `externalUrls` is cleared below. runStream never rethrows and swallows
    // aborts, so a reset placed after it is skipped on exactly the paths where
    // a still-lit toggle would silently apply the measured regression to the
    // user's next, ordinary question (#1119).
    const useDeepSearch = deepSearch;
    const referenceText = buildDocumentReferenceText(documents);
    const imageHandle = image?.handle;
    setInput('');
    setDeepSearch(false);
    if (imageHandle) removeImage();
    setMessages((prev) => [...prev, { id: nextMessageId(), role: 'user', content: question }]);

    const body: Record<string, unknown> = {
      question,
      model,
      conversationId: conversationId ?? undefined,
      pageId: pageId ?? undefined,
      includeSubPages,
      ...(thinkingMode && { thinking: true }),
      // Same shape as `thinking` above: omitted entirely when off, so an
      // untouched toggle sends the wire body it always sent.
      ...(useDeepSearch && { deepSearch: true }),
      ...(referenceText && { referenceText }),
      ...(imageHandle && { imageHandle }),
    };

    if (externalUrls.length > 0) {
      body.externalUrls = externalUrls;
    }

    await runStream('/llm/ask', body, {
      onError: (err) => {
        if (!imageHandle || !(err instanceof ApiError) || err.statusCode !== 410) return false;
        setInput(question);
        toast.error('The image expired — attach it again.');
        return true;
      },
      onComplete: () => {
        // Sources are attached by runStream automatically
      },
    });

    // Clear external URLs after sending
    setExternalUrls([]);
    setShowUrlInput(false);
  }, [
    input, model, isStreaming, isBusy, conversationId, pageId, includeSubPages, thinkingMode,
    deepSearch, documents, image, externalUrls, setInput, setMessages, removeImage, runStream,
  ]);

  const handleSubmit = () => handleAsk();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Unchanged contract: Enter submits, Shift+Enter inserts a newline. On a
    // textarea the bare Enter has to be prevented explicitly, otherwise it
    // submits *and* leaves the browser's own newline behind in the field.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="mt-3 border-t border-border pt-3">
      {documents.length > 0 && image && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-warning" data-testid="ask-attachment-context-warning">
          <AlertTriangle size={12} className="shrink-0" aria-hidden />
          Both attachments will be sent — a small model may not fit them.
        </p>
      )}
      {/* External URLs chips */}
      {externalUrls.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {externalUrls.map((url) => (
            <span
              key={url}
              className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2 py-0.5 text-xs text-primary-ink"
            >
              <Link2 size={10} />
              {new URL(url).hostname}
              <button
                onClick={() => removeUrl(url)}
                aria-label={`Remove ${new URL(url).hostname}`}
                className="hover:text-destructive"
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* URL input row */}
      {showUrlInput && mcpEnabled && (
        <div className="nm-composer mb-2">
          <Link2 size={14} className="shrink-0 text-muted-foreground" />
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addUrl()}
            placeholder="Paste documentation URL..."
            className="flex-1 bg-transparent px-1 py-1 text-xs outline-none placeholder:text-muted-foreground/70"
            data-testid="external-url-input"
          />
          <button
            onClick={addUrl}
            aria-label="Add URL"
            className="shrink-0 rounded-md px-2 py-1 text-xs text-primary-ink hover:bg-primary/10"
          >
            <Plus size={12} />
          </button>
          <button
            onClick={() => { setShowUrlInput(false); setUrlInput(''); }}
            aria-label="Close URL input"
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Per-question retrieval options. Deliberately here rather than in the
          header chip row beside `Think`: that row holds settings that outlive
          the question (thinking mode is in localStorage, sub-pages is session
          state), and a control that resets itself on send would read as broken
          among them. Here it sits with the external URLs above, the composer's
          other per-send state. */}
      <DeepSearchToggle
        checked={deepSearch}
        onChange={setDeepSearch}
        disabled={isStreaming}
        testId="ask-deep-search"
        className="mb-2"
        variant="inline"
      />

      {/* Main input row */}
      <div className="nm-composer flex-wrap">
        <DocumentUploadZone
          variant="composer"
          onPick={(file) => handlePickFiles([file])}
          onPickFiles={handlePickFiles}
          isExtracting={isExtracting}
          extracted={documents[0]?.result ?? null}
          filename={documents[0]?.filename ?? null}
          documents={documents}
          onRemove={removeDocument}
          disabled={isStreaming}
          triggerLabel="Attach a document to this Q&A request"
          usageHint="context for Q&A"
          isDragOver={isDragOver}
          testIdPrefix="ask-doc"
        />
        <ImageAttachZone
          vision={chatVision}
          visionModel={chatVisionModel}
          image={image}
          onPick={(file) => handlePickFiles([file])}
          onRemove={removeImage}
          isPreparing={isPreparing}
          disabled={isStreaming}
          testIdPrefix="ask-image"
        />
        {mcpEnabled && (
          <IconButton
            variant={showUrlInput || externalUrls.length > 0 ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setShowUrlInput(!showUrlInput)}
            title="Attach external documentation URL"
            label="Attach external documentation URL"
            className={cn('shrink-0 self-end h-8 w-8', (showUrlInput || externalUrls.length > 0) && 'bg-primary/15 text-primary')}
            testid="attach-url-button"
            icon={<Link2 size={16} />}
          />
        )}
        <AssistantActionSelect includeGenerate disabled={isStreaming} className="self-end" />
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question..."
          maxLength={PROMPT_MAX_LENGTH}
          rows={1}
          disabled={isStreaming}
          // The composer wrapper owns the inset surface, border and focus ring,
          // so the field stays transparent. resize-none because the auto-grow
          // hook owns the height — a drag handle would fight it.
          // min-w-0 so a textarea's intrinsic `cols` width can't push the
          // composer wider than a narrow viewport.
          className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
          data-testid="ask-input"
        />
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={isStreaming || isBusy || !input.trim() || !model}
          isLoading={isStreaming}
          aria-label={isStreaming ? 'Sending...' : 'Send message'}
          className="shrink-0 self-end h-8 px-3"
          leftIcon={<Send size={14} />}
        />
      </div>
    </div>
  );
}

export const ASK_EMPTY_TITLE = 'Ask questions about your knowledge base';
// "RAG" is implementation vocabulary; it told the reader how the feature is
// built, not what it will do for them. The rewrite states the behaviour that
// actually distinguishes this from a plain chat box: answers cite pages.
export const ASK_EMPTY_SUBTITLE = 'Answers are drawn from your synced pages, with links to the ones they came from';

/**
 * DOM id of the zero-embeddings notice in AiAssistantPage. The example-prompt
 * chips below reference it via `aria-describedby` while they are inert, so
 * the banner's explanation is programmatically the chips' disabled reason —
 * not just text that happens to sit 12px above them.
 */
export const NO_EMBEDDINGS_NOTICE_ID = 'ai-no-embeddings-notice';

export function AskExamplePrompts() {
  const { setInput, embeddingStatus } = useAiContext();

  // The chips invite exactly the retrieval the zero-embeddings banner above
  // them says is absent — with nothing embedded, "Find pages that look like
  // duplicates" can only produce a confident answer over no context. They
  // re-enable the moment embeddings exist (the status query already polls
  // while a pass is processing).
  //
  // #1257 post-review: the banner's own predicate is NOT the chips' gate.
  // `isZeroEmbeddings` is false while the status is still undefined — the
  // first-paint window, and permanently when /embeddings/status errors —
  // which left the chips live in exactly the windows where nothing is known
  // to be retrievable. The chips are invitations this app authors, so they
  // enable only on a RESOLVED status showing at least one embedded page;
  // brief first-paint inertness on a healthy instance is honest. (A fresh
  // install, totalPages === 0, is inert too: the banner hides there because
  // "not embedded yet" would misname the gap, but a retrieval demo over an
  // empty corpus is no more answerable.) `notEmbedded` still keys the
  // aria-describedby: the banner only renders on its own verdict, and a
  // reference to an absent node is a dangling id.
  const notEmbedded = isZeroEmbeddings(embeddingStatus);
  const chipsInert = !embeddingStatus || embeddingStatus.embeddedPages === 0;

  // Suggestions are built from this instance's real content. The previous
  // hardcoded list named a tag and a space that do not exist in a fresh
  // install, so the AI surface opened by inventing facts about the user's
  // own knowledge base — the exact failure the AI Safety panel forbids.
  const { data: pageList } = usePages({ sort: 'modified', limit: 5 });
  const { data: filterOptions } = usePageFilterOptions();
  const { data: spaces } = useSpaces();

  const prompts = buildAskPrompts({
    recentPages: (pageList?.items ?? []).map((p) => ({
      title: p.title,
      spaceKey: p.spaceKey,
      labels: p.labels ?? [],
    })),
    labels: filterOptions?.labels ?? [],
    spaceKeys: (spaces ?? []).map((s) => s.key),
  });

  const pick = (prompt: string) => {
    // aria-disabled (unlike native disabled) does not block events, so both
    // the click and the keydown path funnel through this guard.
    if (chipsInert) return;
    setInput(prompt);
    // Defer focus to next tick so the input mounts before we focus it.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-testid="ask-input"]');
      el?.focus();
    });
  };

  // Use real <ul>/<li> elements so each <button> keeps its implicit "button"
  // role for assistive tech. Previously we set role="listitem" on the buttons,
  // which stripped the button role and made screen readers announce
  // "listitem" instead of "button".
  return (
    <ul
      aria-label="Example prompts"
      className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2 sm:grid-cols-2 list-none p-0"
    >
      {prompts.map((prompt) => (
        <li key={prompt}>
          {/* Lighter card than nm-card-interactive — the heavy neumorphic
              extrusion fights the flat composer that sits 80 px below it
              (May-2026 audit). A 1 px border + faint inset surface keeps the
              prompts skim-readable as a row of suggestions, not buttons that
              look more important than the composer. */}
          <button
            type="button"
            // aria-disabled, not native disabled: a disabled button leaves the
            // tab order, so a keyboard or screen-reader user would never land
            // on a chip to hear WHY the suggestions are inert. This keeps them
            // focusable, announces the disabled state, and aria-describedby
            // hands AT the banner's explanation as the reason.
            aria-disabled={chipsInert || undefined}
            aria-describedby={notEmbedded ? NO_EMBEDDINGS_NOTICE_ID : undefined}
            onClick={() => pick(prompt)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                pick(prompt);
              }
            }}
            className={cn(
              'group flex w-full items-start gap-2.5 rounded-lg border border-border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              chipsInert
                // Explicit muted token, NOT opacity: compositing half-alpha
                // over the card surface lands differently per theme (measured
                // 3.64:1 Graphite vs 2.66:1 Paper for opacity-50), while
                // text-muted-foreground is tuned per palette so both themes
                // read the same register (6.9:1 / 5.8:1 on the card). The
                // dropped background tint and hover treatments carry the rest
                // of the inert reading.
                ? 'cursor-not-allowed text-muted-foreground'
                : 'bg-foreground/[0.03] text-foreground/85 hover:border-primary/40 hover:bg-foreground/[0.06] hover:text-foreground focus-visible:border-primary/60',
            )}
            data-testid="ask-example-prompt"
          >
            {/* No leading icon: the same Sparkles glyph on all four cards
                differentiated nothing and read as decoration. The prompt text
                is the content. */}
            <span>{prompt}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
