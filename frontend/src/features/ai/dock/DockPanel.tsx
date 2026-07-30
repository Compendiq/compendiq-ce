import { useCallback, useEffect, useRef } from 'react';
import { AlertTriangle, Loader2, PanelRightClose, Send, Sparkles, X } from 'lucide-react';
import { useAiContext, type Message } from '../AiContext';
import { StreamingMessage } from '../StreamingMessage';
import { CitationChips } from '../CitationChips';
import { DiagramPreview } from '../modes';
import { AIThinkingBlob } from '../../../shared/components/feedback/AIThinkingBlob';
import { TypingIndicator } from '../../../shared/components/feedback/TypingIndicator';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { useAttachments } from '../../../shared/hooks/use-attachments';
import { DocumentUploadZone } from '../../../shared/components/upload/DocumentUploadZone';
import { ImageAttachZone, imageDisabledReason } from '../../../shared/components/upload/ImageAttachZone';
import { PROMPT_MAX_LENGTH } from '../modes/prompt-limits';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { DOCK_CHIPS } from './dock-chips';
import { DockDiffCard } from './DockDiffCard';
import { useDockActions } from './use-dock-actions';

/**
 * The assistant's contents — everything between the header and the composer.
 *
 * Extracted from `AiDock` when the mobile bottom sheet landed (#1126): the
 * assistant has two *containers* — a column beside the article at `md` and up,
 * a sheet over it below — but only ever one set of contents. Anything that
 * differs between the two forms belongs in the shell, not here.
 *
 * This is the only part of the dock that consumes `AiContext`, which is what
 * keeps the hoisted provider inert on article routes where the assistant was
 * never opened.
 */
export function DockPanel({ onClose, variant = 'column' }: { onClose: () => void; variant?: 'column' | 'sheet' }) {
  const {
    page, pageId, messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, input, setInput, modelsError, refetchModels, model, chatVision,
  } = useAiContext();

  // Source material attached in the composer (#1131, #1154). Dock-local rather
  // than AiContext state: it is material for the *next* action, not part of the
  // conversation, and nothing outside this panel reads it.
  //
  // `useAttachments` owns the composer as a shared drop target, so a file can be
  // let go anywhere on the prompt box rather than onto a 28px paperclip, and one
  // router decides document-vs-image rather than each zone guessing. The image
  // half opens only once the resolved chat model has probed as vision-capable:
  // `chatVision` is tri-state, and anything other than a confirmed `true` keeps
  // intake shut — with the reason the user is shown coming from the same
  // function the trigger's tooltip uses.
  const composerBoxRef = useRef<HTMLDivElement>(null);
  const attachments = useAttachments({
    dropTargetRef: composerBoxRef,
    imageEnabled: chatVision === true,
    imageDisabledReason: imageDisabledReason(chatVision, model),
    disabled: isStreaming,
  });
  const {
    document: reference, image, pickFile, removeDocument, removeImage, clearAll, isDragOver,
    isExtracting, isPreparing, isBusy,
  } = attachments;

  const { ask, runChip } = useDockActions({
    referenceText: reference?.result.text,
    imageHandle: image?.handle,
    onImageExpired: removeImage,
  });

  // A document or image attached while reading one page is not background for
  // the next one. Threads are retained per page; an attachment silently
  // following the user to a different document is exactly the kind of surprise
  // #1126 set out to remove, so both slots are dropped at the boundary instead.
  useEffect(() => {
    clearAll();
  }, [pageId, clearAll]);

  const handlePick = useCallback((file: File) => {
    void pickFile(file);
  }, [pickFile]);

  const seed = useAiDockStore((s) => s.seed);
  const seedPageId = useAiDockStore((s) => s.seedPageId);
  const consumeSeed = useAiDockStore((s) => s.consumeSeed);

  const composerRef = useAutoGrowTextarea(input);

  // Opening the assistant moves focus to the composer; closing it returns focus
  // to whatever opened it. The column form is a docked panel rather than a
  // modal, so it deliberately does not trap Tab — the article beside it must
  // stay reachable. The sheet form *is* modal and adds a trap around this, but
  // it leaves focus-in and focus-restore here: there is one composer to focus
  // and one opener to return to either way.
  //
  // Restoring is not simply "focus whatever was focused before", because
  // opening the assistant destroys its trigger in most layouts: the expanded
  // pane's "AI Improve" row unmounts when the pane is forced to its rail, and
  // below 1100px — which includes every phone — the entire pane unmounts. For
  // those, by the time this effect's cleanup runs the opener is already
  // detached and focus has fallen to <body>, so restoring it would strand the
  // keyboard at the top of the document. Fall back to the equivalent control
  // that does survive, and only then to the article itself.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    composerRef.current?.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) {
        opener.focus();
        return;
      }
      // Whichever form of the article pane is on screen once the assistant has
      // gone — expanded row or 40px rail — carries this marker. Closing it
      // re-renders the pane in the same commit, so which one it is depends on
      // the user's own collapse preference and the viewport; the marker is on
      // both so the hand-off does not have to care.
      const improveTrigger = document.querySelector<HTMLElement>('[data-ai-improve-trigger]');
      if (improveTrigger) {
        improveTrigger.focus();
        return;
      }
      const main = document.querySelector<HTMLElement>('main');
      if (!main) return;
      // <main> is not focusable by default; making it programmatically
      // focusable is the skip-link idiom for exactly this kind of hand-off.
      main.tabIndex = -1;
      main.focus();
    };
  }, [composerRef]);

  // `runChip` changes identity whenever any of its many context inputs change.
  // Holding it in a ref keeps the seed effect below keyed on what actually
  // gates the seed — the seed itself, and whether a model and page exist yet.
  const runChipRef = useRef(runChip);
  useEffect(() => {
    runChipRef.current = runChip;
  }, [runChip]);

  // Run the seeded action once a model is resolved. Firing on mount would hit
  // `runChip`'s "No model available" guard, because the models query starts in
  // the same tick the dock opens.
  //
  // The wait is unbounded, so the document can change underneath it — a slow or
  // failed page query leaves the user free to navigate away with the dock still
  // open. A seed that no longer matches the page in view is dropped rather than
  // fired at whatever loaded next.
  useEffect(() => {
    if (!seed) return;
    if (seedPageId !== null && seedPageId !== pageId) {
      consumeSeed();
      return;
    }
    if (!model || !page) return;
    consumeSeed();
    void runChipRef.current(seed);
  }, [seed, seedPageId, pageId, model, page, consumeSeed]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits, Shift+Enter inserts a newline — the contract #1120
    // established for the Ask composer, in the surface where it matters most.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask();
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        // Stop the native event before it reaches the document-level shortcut
        // listener, which would otherwise also exit the article's edit mode.
        e.stopPropagation();
        onClose();
      }}
    >
      {/* Header — h-10 and px-3 exactly matching ArticleRightPane's
          "Properties" header, so the two panels share a baseline. Violet marks
          the surface as the AI one (ADR-010 v0.5); it never fills a control. */}
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 px-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <Sparkles size={13} className="shrink-0 text-status-ai" aria-hidden />
          <span className="truncate text-xs font-semibold text-foreground">Assistant</span>
        </span>
        <button
          onClick={onClose}
          className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label="Close AI assistant"
          title="Close assistant (Esc)"
          data-testid="ai-dock-close"
        >
          {/* The glyph names where the thing goes. `PanelRightClose` draws a
              right-hand column folding away, which is exactly what happens at
              md and up and exactly what does not happen to a sheet at the
              bottom of a phone — that one just closes. */}
          {variant === 'sheet' ? <X size={15} /> : <PanelRightClose size={14} />}
        </button>
      </div>

      {/* Streaming indicator: a violet hairline under the header, visible even
          when the thread is scrolled away from the in-flight answer. */}
      <div className="h-px shrink-0 bg-[var(--glass-sidebar-divider)]">
        {isStreaming && (
          <div className="h-px w-full animate-pulse bg-status-ai" role="status" aria-label="Assistant is responding" data-testid="ai-dock-streaming" />
        )}
      </div>

      {/* Primed live regions — same contract as /ai: the role must exist before
          the content arrives or assistive tech will not announce it. */}
      <div role="alert" data-testid="ai-dock-error-announcer" className="sr-only">
        {(() => {
          const lastError = [...messages].reverse().find((msg) => msg.isError);
          return lastError ? <span key={lastError.id}>{lastError.content}</span> : null;
        })()}
      </div>
      <div role="status" aria-live="polite" data-testid="ai-dock-answer-announcer" className="sr-only">
        {(() => {
          if (isStreaming) return null;
          const lastAnswer = [...messages].reverse().find((m2) => m2.role === 'assistant' && !m2.isError && m2.content);
          return lastAnswer ? <span key={lastAnswer.id}>Answer ready</span> : null;
        })()}
      </div>

      {/* Thread. `overscroll-contain` so reaching the end of the conversation
          does not chain the scroll into the article underneath — the sheet sits
          over the document, and scroll leaking through it would move the page
          the user is asking about out from under them. */}
      <div className="scroll-mask min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3" data-testid="ai-dock-thread">
        {messages.length === 0 && !isStreaming ? (
          <DockEmptyState pageTitle={page?.title} />
        ) : (
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <DockMessage
                key={msg.id}
                msg={msg}
                isLast={i === messages.length - 1}
                isStreaming={isStreaming}
                isThinking={isThinking}
                thinkingElapsed={thinkingElapsed}
                streamingContent={i === messages.length - 1 ? streamingContent : undefined}
              />
            ))}
            <div ref={messagesEndRef} />
            {/* Artifacts belong to the assistant's turn, so they line up with
                its prose rather than the column edge: ml-7 is the avatar's
                20px plus the 8px gap. */}
            <div className="ml-7">
              <DockDiffCard onRerun={runChip} />
              <DiagramPreview />
            </div>
          </div>
        )}
      </div>

      {/* Composer block: chips, then the prompt. Chips are steel-outlined —
          steel is what "you can operate this" means under ADR-010 v0.5 — and
          take --color-border-interactive rather than the quiet hairline, which
          separators and pane edges use (WCAG 1.4.11). */}
      <div className="shrink-0 border-t border-border px-3 pb-3 pt-2.5">
        <div className="mb-2 flex flex-wrap gap-1.5">
          {modelsError ? (
            <button
              type="button"
              onClick={() => refetchModels()}
              title="Failed to load models from the LLM provider — click to retry"
              className="flex h-7 items-center gap-1.5 rounded-md border border-destructive/60 px-2.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              <AlertTriangle size={12} aria-hidden /> Models unavailable — retry
            </button>
          ) : (
            DOCK_CHIPS.map(({ id, label, Icon, hint }) => (
              <button
                key={id}
                type="button"
                onClick={() => void runChip(id)}
                // Improve alone waits out an in-flight attachment: firing it now
                // would send the request without the reference text still being
                // extracted or the image still being staged (#940's lesson,
                // widened to both slots by #1154). The other three read no
                // attachment, so they stay live.
                disabled={isStreaming || !page || !model || (id === 'improve' && isBusy)}
                title={hint}
                className="flex h-7 items-center gap-1.5 rounded-md border border-border-interactive px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
                data-testid={`ai-dock-chip-${id}`}
              >
                <Icon size={12} aria-hidden /> {label}
              </button>
            ))
          )}
        </div>

        {/* An advisory, not a refusal: the backend accepts both, and only the
            resolved model knows whether they fit. Amber is the attention colour
            under ADR-010 v0.5 and this is exactly that. It sits above the
            composer, not inside it, because a paragraph among the composer's
            flex children would need an order of its own and would default to
            `order: 0` — ahead of the very cards it is describing. */}
        {reference && image && (
          <p
            className="mb-2 flex items-center gap-1.5 text-xs text-warning"
            data-testid="ai-dock-attachment-context-warning"
          >
            <AlertTriangle size={12} className="shrink-0" aria-hidden />
            Both attachments will be sent — a small model may not fit them.
          </p>
        )}

        {/* flex-wrap so the zones' full-width rows — the attachment cards, the
            drop hint — stack above the prompt inside the same box. An
            attachment belongs to what you are about to send, so it lives in the
            thing you send from, not in a band above it.
            Each zone brings its own `order-1` card and `order-2` trigger, so
            the two children this box owns take the slots after them. Anything
            added here needs an explicit order as well: no class means
            `order: 0`, which renders it ahead of the cards. */}
        <div className="nm-composer flex-wrap" ref={composerBoxRef}>
          <DocumentUploadZone
            variant="composer"
            onPick={handlePick}
            isExtracting={isExtracting}
            extracted={reference?.result ?? null}
            filename={reference?.filename ?? null}
            onRemove={removeDocument}
            disabled={isStreaming}
            triggerLabel="Attach a document as reference for Improve"
            usageHint="reference for Improve"
            isDragOver={isDragOver}
            testIdPrefix="ai-dock-doc"
          />
          <ImageAttachZone
            vision={chatVision}
            model={model}
            image={image}
            onPick={handlePick}
            onRemove={removeImage}
            isPreparing={isPreparing}
            disabled={isStreaming}
          />
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={page ? 'Ask about this page…' : 'Ask a question…'}
            maxLength={PROMPT_MAX_LENGTH}
            rows={1}
            disabled={isStreaming}
            aria-label="Ask the assistant about this page"
            // The composer wrapper owns the inset surface, border and focus
            // ring; resize-none because the auto-grow hook owns the height.
            className="order-3 min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
            data-testid="ai-dock-input"
          />
          <button
            onClick={() => void ask()}
            disabled={isStreaming || !input.trim() || !model}
            aria-label={isStreaming ? 'Sending…' : 'Send message'}
            className="order-4 flex shrink-0 self-end items-center rounded-md border border-primary bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50"
            data-testid="ai-dock-send"
          >
            {isStreaming ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function DockEmptyState({ pageTitle }: { pageTitle: string | undefined }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-2 text-center" data-testid="ai-dock-empty">
      <div className="relative mb-4 flex h-14 w-14 items-center justify-center">
        <div className="absolute inset-0 rounded-full bg-status-ai/10 blur-2xl" aria-hidden />
        <div className="relative flex h-11 w-11 items-center justify-center rounded-full bg-status-ai/12 ring-1 ring-status-ai/25">
          <Sparkles size={22} className="text-status-ai" aria-hidden />
        </div>
      </div>
      {/* The headline names the scope rather than repeating the composer's
          own placeholder back at the reader. On a 420px column the page title
          is the one piece of orientation worth spending two lines on: it is
          the answer to "what is this assistant attached to?". */}
      <p className="line-clamp-2 max-w-[24ch] text-sm font-medium text-foreground">
        {pageTitle ?? 'No page open'}
      </p>
      <p className="mt-1.5 max-w-[32ch] text-balance text-xs leading-relaxed text-muted-foreground">
        {pageTitle
          ? 'Ask about it, or pick an action.'
          : 'The assistant works on the article you are reading.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

interface DockMessageProps {
  msg: Message;
  isLast: boolean;
  isStreaming: boolean;
  isThinking: boolean;
  thinkingElapsed: boolean;
  streamingContent?: string;
}

/**
 * A single turn, sized for a 420px column.
 *
 * `/ai`'s MessageBubble gives every turn a 32px avatar and caps bubbles at 80%
 * width; here that would spend a tenth of the column on repeated ornament. The
 * user's turn is a right-aligned steel-tinted bubble, the assistant's is
 * flush-left prose behind one small violet mark — the asymmetry alone says who
 * is speaking, which is what a narrow column needs.
 */
function DockMessage({ msg, isLast, isStreaming, isThinking, thinkingElapsed, streamingContent }: DockMessageProps) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary/12 px-3 py-2 text-sm text-foreground">
          {msg.content}
        </div>
      </div>
    );
  }

  const isLastAssistant = isLast;
  const isStreamingThis = isStreaming && isLastAssistant;
  const content = isStreamingThis ? (streamingContent ?? msg.content) : msg.content;
  const showThinkingBlob = isThinking && isLastAssistant && !content && thinkingElapsed;
  const showTypingIndicator = isThinking && isLastAssistant && !content && !thinkingElapsed;

  return (
    <div className="flex gap-2">
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-status-ai/12 ring-1 ring-status-ai/25"
        aria-hidden
      >
        <Sparkles size={11} className="text-status-ai" />
      </span>
      <div className="min-w-0 flex-1">
        {showThinkingBlob && <AIThinkingBlob active />}
        {showTypingIndicator && (
          <TypingIndicator
            dotClassName="bg-status-ai/60"
            testId="ai-dock-typing"
            label="Assistant is typing"
          />
        )}
        {msg.isError ? (
          <p
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-sm text-destructive"
            data-testid="message-error"
          >
            {msg.content}
          </p>
        ) : (
          content && <StreamingMessage content={content} isStreaming={isStreamingThis} />
        )}
        {msg.sources && msg.sources.length > 0 && (
          <div className="mt-2">
            <CitationChips sources={msg.sources} />
          </div>
        )}
      </div>
    </div>
  );
}
