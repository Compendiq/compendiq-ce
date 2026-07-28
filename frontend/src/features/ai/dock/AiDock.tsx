import { useCallback, useEffect, useRef, useState } from 'react';
import { m, AnimatePresence, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Loader2, PanelRightClose, Send, Sparkles } from 'lucide-react';
import { useAiContext, type Message } from '../AiContext';
import { StreamingMessage } from '../StreamingMessage';
import { CitationChips } from '../CitationChips';
import { DiagramPreview } from '../modes';
import { AIThinkingBlob } from '../../../shared/components/feedback/AIThinkingBlob';
import { TypingIndicator } from '../../../shared/components/feedback/TypingIndicator';
import { useAutoGrowTextarea } from '../../../shared/hooks/use-auto-grow-textarea';
import { useIsDockWideLayout } from '../../../shared/hooks/use-media-query';
import { PROMPT_MAX_LENGTH } from '../modes/prompt-limits';
import { useAiDockStore } from '../../../stores/ai-dock-store';
import { useUiStore } from '../../../stores/ui-store';
import { cn } from '../../../shared/lib/cn';
import { DOCK_CHIPS } from './dock-chips';
import { DockDiffCard } from './DockDiffCard';
import { useDockActions } from './use-dock-actions';

// Same spring the article right pane uses, so the two panels on the same edge
// of the screen move with one physics rather than two.
const dockSpring = { type: 'spring' as const, stiffness: 400, damping: 30 };

/**
 * Ceiling on the dock's width below the wide breakpoint. The stored width is a
 * preference set with room to spare; honoring a 640px dock on a 1040px viewport
 * would leave the article a measure it cannot be read at. The rail is already
 * gone by this point — this is the rest of "the assistant takes the pane, the
 * editor keeps enough to work in".
 */
const NARROW_MAX_WIDTH = 380;

/**
 * The docked AI assistant (#1126).
 *
 * Mounted as a sibling of `ArticleRightPane` in `AppLayout`, i.e. as a third
 * column in the same flex row rather than an overlay. That is deliberate: an
 * overlay reads as bolted onto the right edge, a column reads as part of the
 * app. It takes the same `bg-background` / `border-l border-border` chassis as
 * the right pane and aligns its `h-10` header with the pane's "Properties"
 * header, so rail and dock read as one continuous piece of chrome.
 *
 * Rendering is split so the AI provider is not woken on every article route:
 * only `AiDockPanel` consumes `AiContext`, and it only mounts while the dock is
 * open. `AnimatePresence` keeps it mounted for the exit animation, after which
 * the consumer count drops and the provider goes inert again.
 */
export function AiDock() {
  const open = useAiDockStore((s) => s.open);
  const closeDock = useAiDockStore((s) => s.closeDock);
  const wide = useIsDockWideLayout();
  const width = useUiStore((s) => s.aiDockWidth);
  const setWidth = useUiStore((s) => s.setAiDockWidth);
  const reduceEffects = useReducedMotion();
  const [isResizing, setIsResizing] = useState(false);
  const effectiveWidth = wide ? width : Math.min(width, NARROW_MAX_WIDTH);

  // Third instance of the resize recipe used by ArticleRightPane and
  // SidebarTreeView — dragging left widens, because the panel grows leftward.
  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);
      const startX = e.clientX;
      const startWidth = width;

      function onMouseMove(ev: MouseEvent) {
        setWidth(startWidth - (ev.clientX - startX));
      }
      function onMouseUp() {
        setIsResizing(false);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      }
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    },
    [width, setWidth],
  );

  return (
    <AnimatePresence>
      {open && (
        <m.aside
          key="ai-dock"
          initial={reduceEffects ? false : { width: 0, opacity: 0 }}
          animate={{ width: effectiveWidth, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={reduceEffects || isResizing ? { duration: 0 } : dockSpring}
          className={cn(
            'relative flex shrink-0 flex-col overflow-hidden border-l border-border bg-background',
            isResizing && 'select-none',
          )}
          aria-label="AI assistant"
          data-testid="ai-dock"
        >
          <AiDockPanel onClose={closeDock} />

          {wide && (
            <div
              role="separator"
              aria-label="Resize AI assistant"
              aria-orientation="vertical"
              onMouseDown={handleResizeStart}
              className={cn(
                'absolute left-0 top-2 bottom-2 w-1 cursor-col-resize rounded-full transition-colors hover:bg-action/40',
                isResizing && 'bg-action/60',
              )}
            />
          )}
        </m.aside>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Panel contents (consumes AiContext)
// ---------------------------------------------------------------------------

function AiDockPanel({ onClose }: { onClose: () => void }) {
  const {
    page, messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent, input, setInput, modelsError, refetchModels, model,
  } = useAiContext();
  const { ask, runChip } = useDockActions();

  const seed = useAiDockStore((s) => s.seed);
  const consumeSeed = useAiDockStore((s) => s.consumeSeed);

  const composerRef = useAutoGrowTextarea(input);

  // Opening the dock moves focus to the composer; closing it returns focus to
  // whatever opened it (the rail's Wand2 button, the pane's "AI Improve" row,
  // or wherever Alt+I was pressed). This is the minimal focus contract from
  // ImageLightbox (PageViewPage.tsx) rather than AppLayout's mobile-sidebar
  // trap: the dock is a docked panel, not a modal, so Tab must be able to leave
  // it and reach the article. Trapping Tab here would be the wrong borrowing.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    composerRef.current?.focus();
    return () => previouslyFocused?.focus?.();
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
  useEffect(() => {
    if (!seed || !model || !page) return;
    consumeSeed();
    void runChipRef.current(seed);
  }, [seed, model, page, consumeSeed]);

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
          className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-[var(--glass-pill-hover)] hover:text-foreground"
          aria-label="Close AI assistant"
          title="Close assistant (Esc)"
          data-testid="ai-dock-close"
        >
          <PanelRightClose size={14} />
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

      {/* Thread */}
      <div className="scroll-mask min-h-0 flex-1 overflow-y-auto px-3 py-3" data-testid="ai-dock-thread">
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
                disabled={isStreaming || !page || !model}
                title={hint}
                className="flex h-7 items-center gap-1.5 rounded-md border border-border-interactive px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
                data-testid={`ai-dock-chip-${id}`}
              >
                <Icon size={12} aria-hidden /> {label}
              </button>
            ))
          )}
        </div>

        <div className="nm-composer">
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
            className="min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
            data-testid="ai-dock-input"
          />
          <button
            onClick={() => void ask()}
            disabled={isStreaming || !input.trim() || !model}
            aria-label={isStreaming ? 'Sending…' : 'Send message'}
            className="flex shrink-0 self-end items-center rounded-md border border-primary bg-primary px-2.5 py-1.5 text-sm font-medium text-primary-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:opacity-50"
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
