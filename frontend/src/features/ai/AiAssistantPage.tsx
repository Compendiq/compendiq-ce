import { memo } from 'react';
import { m, useReducedMotion } from 'framer-motion';
import {
  Bot, User, Loader2, MessageSquare, Brain, AlertTriangle,
  Wand2, ListCollapse, Sparkles, GitBranch, FileText, ShieldCheck, Network,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '../../shared/lib/cn';
import { ConfidenceBadge } from '../../shared/components/badges/ConfidenceBadge';
import { AIThinkingBlob } from '../../shared/components/feedback/AIThinkingBlob';
import { SourceCitations } from './SourceCitations';
import { CitationChips } from './CitationChips';
import { StreamingMessage } from './StreamingMessage';
import { AiProvider, useAiContext, type Mode, type Message } from './AiContext';
import {
  AskModeInput, AskExamplePrompts, ASK_EMPTY_TITLE, ASK_EMPTY_SUBTITLE,
  ImproveTypeSelector, ImproveDiffView, ImproveModeInput, IMPROVE_EMPTY_TITLE, improveEmptySubtitle,
  GenerateModeInput, GENERATE_EMPTY_TITLE, GENERATE_EMPTY_SUBTITLE,
  SummarizeModeInput, SUMMARIZE_EMPTY_TITLE, summarizeEmptySubtitle,
  DiagramTypeSelector, DiagramPreview, DiagramModeInput, DIAGRAM_EMPTY_TITLE, diagramEmptySubtitle,
  QualityModeInput, QUALITY_EMPTY_TITLE, qualityEmptySubtitle,
} from './modes';
import { isZeroEmbeddings } from '../../shared/hooks/use-pages';

// ---------------------------------------------------------------------------
// Typing indicator: 3 dots with staggered bounce
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1" data-testid="typing-indicator" aria-label="AI is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-primary/60"
          style={{
            animation: 'typing-bounce 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memoized message bubble: skips re-render for completed (non-streaming) messages
// ---------------------------------------------------------------------------

interface MessageBubbleProps {
  msg: Message;
  index: number;
  isLast: boolean;
  isStreaming: boolean;
  isThinking: boolean;
  thinkingElapsed: boolean;
  isLight: boolean;
  shouldReduceMotion: boolean | null;
  /**
   * rAF-batched content of the in-flight answer (#747). Only passed to the
   * last message bubble while streaming; committed messages render msg.content.
   */
  streamingContent?: string;
}

const MessageBubble = memo(function MessageBubble({
  msg, index, isLast, isStreaming, isThinking, thinkingElapsed, isLight, shouldReduceMotion, streamingContent,
}: MessageBubbleProps) {
  const isLastAssistant = msg.role === 'assistant' && isLast;
  const isStreamingThis = isStreaming && isLastAssistant;
  const effectiveContent = isStreamingThis ? (streamingContent ?? msg.content) : msg.content;
  const showThinkingBlob = isThinking && isLastAssistant && !effectiveContent && thinkingElapsed;
  const showTypingIndicator = isThinking && isLastAssistant && !effectiveContent && !thinkingElapsed;

  return (
    <m.div
      initial={shouldReduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: shouldReduceMotion ? 0 : Math.min(index * 0.05, 0.3),
        type: 'spring',
        stiffness: 300,
        damping: 25,
      }}
      className={cn('flex gap-3', msg.role === 'user' && 'justify-end')}
    >
      {msg.role === 'assistant' && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15">
          <Bot size={16} className="text-primary" />
        </div>
      )}
      <div
        className={cn(
          'max-w-[80%] rounded-2xl px-4 py-3 text-sm xl:max-w-2xl',
          msg.role === 'user'
            ? 'bg-primary/10 text-foreground'
            : msg.isError
              ? 'border border-destructive/40 bg-destructive/10'
              : 'bg-foreground/5',
        )}
        // No role="alert" here: the role and the error content would arrive
        // in the same render, which AT generally does not announce (MDN alert
        // role). The primed announcer next to the message list handles SR
        // announcement; this bubble is the visual surface only.
        data-testid={msg.isError ? 'message-error' : undefined}
      >
        {showThinkingBlob && <AIThinkingBlob active />}
        {showTypingIndicator && <TypingIndicator />}
        {isStreamingThis ? (
          // #747: the in-flight answer renders through the rAF-batched
          // StreamingMessage, so the Markdown re-parse happens at most once
          // per animation frame instead of once per SSE chunk.
          effectiveContent ? (
            <StreamingMessage content={effectiveContent} isStreaming />
          ) : (!showThinkingBlob && !showTypingIndicator ? (
            <div className={cn('prose prose-sm max-w-none', !isLight && 'prose-invert')}>
              <TypingIndicator />
            </div>
          ) : null)
        ) : msg.isError ? (
          // Error messages render as plain text (not Markdown) so the
          // destructive color isn't overridden by the prose styles.
          <p className="text-destructive">{msg.content}</p>
        ) : (
          <div className={cn('prose prose-sm max-w-none', !isLight && 'prose-invert')}>
            {msg.content ? (
              <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
            ) : null}
          </div>
        )}
        {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-2">
              {(() => {
                const scores = msg.sources!.filter((s) => s.score != null).map((s) => s.score!);
                if (scores.length === 0) return null;
                const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
                return <ConfidenceBadge score={avgScore} />;
              })()}
              <CitationChips sources={msg.sources!} />
            </div>
            <SourceCitations sources={msg.sources} />
          </div>
        )}
      </div>
      {msg.role === 'user' && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground/8">
          <User size={16} className="text-muted-foreground" />
        </div>
      )}
    </m.div>
  );
}, (prev, next) => {
  // Custom comparator: skip re-render if message content and streaming state haven't changed.
  // Completed messages (not last or not streaming) will never re-render.
  if (prev.msg.id !== next.msg.id) return false;
  if (prev.msg.content !== next.msg.content) return false;
  if (prev.msg.isError !== next.msg.isError) return false;
  if (prev.msg.sources !== next.msg.sources) return false;
  if (prev.isLast !== next.isLast) return false;
  if (prev.isStreaming !== next.isStreaming) return false;
  if (prev.streamingContent !== next.streamingContent) return false;
  if (prev.isThinking !== next.isThinking) return false;
  if (prev.thinkingElapsed !== next.thinkingElapsed) return false;
  if (prev.isLight !== next.isLight) return false;
  return true;
});

// ---------------------------------------------------------------------------
// Mode button definitions
// ---------------------------------------------------------------------------

const MODE_BUTTONS: Array<{ key: Mode; icon: typeof MessageSquare; label: string }> = [
  { key: 'ask', icon: MessageSquare, label: 'Q&A' },
  { key: 'improve', icon: Wand2, label: 'Improve' },
  { key: 'generate', icon: Sparkles, label: 'Generate' },
  { key: 'summarize', icon: ListCollapse, label: 'Summarize' },
  { key: 'diagram', icon: GitBranch, label: 'Diagram' },
  { key: 'quality', icon: ShieldCheck, label: 'Quality' },
];

// ---------------------------------------------------------------------------
// Empty state text per mode
// ---------------------------------------------------------------------------

function getEmptyTitle(mode: Mode): string {
  switch (mode) {
    case 'ask': return ASK_EMPTY_TITLE;
    case 'improve': return IMPROVE_EMPTY_TITLE;
    case 'generate': return GENERATE_EMPTY_TITLE;
    case 'summarize': return SUMMARIZE_EMPTY_TITLE;
    case 'diagram': return DIAGRAM_EMPTY_TITLE;
    case 'quality': return QUALITY_EMPTY_TITLE;
  }
}

function getEmptySubtitle(mode: Mode, page: { title: string } | undefined): string {
  switch (mode) {
    case 'ask': return ASK_EMPTY_SUBTITLE;
    case 'improve': return improveEmptySubtitle(page);
    case 'generate': return GENERATE_EMPTY_SUBTITLE;
    case 'summarize': return summarizeEmptySubtitle(page);
    case 'diagram': return diagramEmptySubtitle(page);
    case 'quality': return qualityEmptySubtitle(page);
  }
}

// ---------------------------------------------------------------------------
// Inner component (consumes AiContext)
// ---------------------------------------------------------------------------

function AiAssistantInner() {
  const ctx = useAiContext();
  const {
    mode, setMode, page, pageHasChildren,
    messages, messagesEndRef, isStreaming, isThinking, thinkingElapsed,
    streamingContent,
    model, models, setModel, modelsError, refetchModels, isLight,
    includeSubPages, setIncludeSubPages,
    thinkingMode, setThinkingMode,
    embeddingStatus,
  } = ctx;

  const shouldReduceMotion = useReducedMotion();

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      // flex-1 walks up through the wrapper chain (AppLayout +
      // PageTransition both opt into a flex column) so this page fills the
      // available scroll height without depending on a `calc(100vh - chrome)`
      // magic number that would drift if the header / service-status banner
      // height changes.
      className="flex flex-1 flex-col gap-3"
    >
      {/* Sticky sub-header: mode selector | context + options.
          Sits at top-0 of the scroll container so it stays visible as
          messages grow. backdrop-blur on the inner card keeps the surface
          legible against the live content scrolling under it. An opaque
          UNDER-mask (bg-background, z-[-1]) sits behind the translucent bar
          so chat content scrolling up is fully occluded above the tab row
          (#703). The mask covers exactly the bar's box (inset-0): the bar
          pins flush at the scrollport top, so there is no gap above it to
          mask, and extending past the bar's box adds absolute overflow that
          inflates the page's scrollable height (#769).

          Visual grammar: two clear groups separated by a thin divider.
          Group A (left): which mode are we in. Inset segmented control.
          Group B (right): what's the model + what's the context window +
            what options are on. Outlined chips of uniform 28 px height. */}
      <div className="sticky top-0 z-20 isolate -mx-1 space-y-3 bg-background/85 px-1 py-1 backdrop-blur">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[-1] bg-background"
      />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2 rounded-xl border border-border/40 bg-card/50 px-3 py-2 backdrop-blur-sm">
        {/* Group A — mode segmented control */}
        <div
          role="tablist"
          aria-label="AI mode"
          className="flex items-center gap-0.5 rounded-lg bg-foreground/[0.04] p-1"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault();
              const keys = MODE_BUTTONS.map((b) => b.key);
              const idx = keys.indexOf(mode);
              const next = e.key === 'ArrowRight'
                ? (idx + 1) % keys.length
                : (idx - 1 + keys.length) % keys.length;
              const nextKey = keys[next];
              if (nextKey) setMode(nextKey);
            }
          }}
        >
          {MODE_BUTTONS.map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={mode === key}
              tabIndex={mode === key ? 0 : -1}
              onClick={() => setMode(key)}
              className={cn(
                'flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors',
                mode === key
                  // Inset honey-tinted surface (not filled) so the active tab
                  // doesn't compete with the honey-filled primary CTA in the
                  // mode's input bar.
                  ? 'bg-card text-primary-ink shadow-sm ring-1 ring-primary/35 font-medium'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Group B — context + options. Each chip is 28 px tall (h-7),
            border-border/40 at rest, tinted on active. The divider between
            the model dropdown and the toggles separates "infrastructure" the
            user sets once from "context flags" they flip per question. */}
        <div className="flex flex-wrap items-center gap-1.5">
          {modelsError ? (
            // Models fetch failed (LLM provider down / unreachable): surface
            // the failure with a retry affordance instead of spinning forever.
            <button
              type="button"
              onClick={() => refetchModels()}
              title="Failed to load models from the LLM provider — click to retry"
              className="flex h-7 items-center gap-1.5 rounded-md border border-destructive/40 px-2.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              <AlertTriangle size={12} /> Models unavailable — retry
            </button>
          ) : models.length === 0 ? (
            <span className="flex h-7 items-center gap-1.5 rounded-md border border-border/40 px-2.5 text-xs text-muted-foreground">
              <Loader2 size={12} className="animate-spin" /> Loading models...
            </span>
          ) : (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="LLM model"
              title="LLM model"
              className="nm-select"
            >
              {models
                .filter((m) => !m.name.includes('embed'))
                .map((m) => (
                  <option key={m.name} value={m.name}>{m.name}</option>
                ))}
            </select>
          )}

          {page && (
            <span
              className="flex h-7 items-center gap-1.5 rounded-md border border-border/40 bg-foreground/[0.03] px-2.5 text-xs text-muted-foreground"
              title={`AI context is scoped to "${page.title}"`}
            >
              <FileText size={12} />
              <span className="max-w-[180px] truncate">{page.title}</span>
            </span>
          )}

          {page && pageHasChildren && (
            <label
              className={cn(
                'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
                includeSubPages
                  ? 'border-primary/45 bg-primary/12 text-primary-ink'
                  : 'border-border/40 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
              )}
              title="Include sub-pages in the AI context"
            >
              <input
                type="checkbox"
                checked={includeSubPages}
                onChange={(e) => setIncludeSubPages(e.target.checked)}
                className="sr-only"
                aria-label="Include sub-pages"
              />
              <Network size={12} />
              <span>+ Sub-pages</span>
            </label>
          )}

          {/* Divider between "what model + what context" and "what options". */}
          <span aria-hidden className="mx-0.5 h-5 w-px bg-border/50" />

          {/* Thinking mode toggle (#20). Always render the resting surface so
              the affordance reads as a toggle rather than collapsing into a
              label-with-icon when off. */}
          <label
            className={cn(
              'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors',
              thinkingMode
                ? 'border-purple-500/45 bg-purple-500/15 text-purple-300'
                : 'border-border/40 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
            title={thinkingMode
              ? 'Extended thinking is on — responses take longer but reason more carefully'
              : 'Enable extended thinking for more thorough responses'}
          >
            <input
              type="checkbox"
              checked={thinkingMode}
              onChange={(e) => setThinkingMode(e.target.checked)}
              className="sr-only"
              aria-label="Thinking mode"
            />
            <Brain size={12} />
            <span>Think</span>
          </label>
        </div>
      </div>

      {/* Mode-specific type selectors — included in the sticky header so
          they stay alongside the tabs while scrolling. */}
      {mode === 'improve' && <ImproveTypeSelector />}
      {mode === 'diagram' && <DiagramTypeSelector />}
      </div>

      {/* Primed live region for error announcements. It must exist (empty)
          BEFORE any error so assistive tech watches it for content changes —
          adding role="alert" together with the message in one render is
          generally not announced (MDN alert role). The visible error bubble
          below carries no alert role. For the toast-suppressed 403 path this
          region is the only announcement; other errors keep their toast, so
          they may announce twice — over-announcing beats silence.
          The child span is keyed by message id: Ask mode appends on retry, so
          a repeated identical failure derives byte-identical text — only a
          freshly inserted node makes AT announce it again. */}
      <div role="alert" data-testid="ai-error-announcer" className="sr-only">
        {(() => {
          const lastError = [...messages].reverse().find((msg) => msg.isError);
          return lastError ? <span key={lastError.id}>{lastError.content}</span> : null;
        })()}
      </div>

      {/* Primed polite live region for completed answers (#937). The error
          announcer above only speaks failures; without this, a screen-reader
          user hears nothing when an answer finishes and the streamed text is
          silently painted into the bubble. Gated on !isStreaming so we announce
          the finished answer once, not mid-stream (which would interrupt the
          visible streaming). Keyed by the completed message id so a fresh node
          is inserted per answer — that insertion is what AT re-announces. */}
      <div role="status" aria-live="polite" data-testid="ai-answer-announcer" className="sr-only">
        {(() => {
          if (isStreaming) return null;
          const lastAnswer = [...messages].reverse().find(
            (msg) => msg.role === 'assistant' && !msg.isError && msg.content,
          );
          return lastAnswer ? <span key={lastAnswer.id}>Answer ready</span> : null;
        })()}
      </div>

      {/* Messages — clean document-like surface, no heavy glass.
          flex-1 so the messages area grows to fill the column, pushing
          the sticky input bar to the bottom of the page. */}
      <div className="flex-1 overflow-hidden rounded-xl border border-border/40 bg-card/40 backdrop-blur-sm">
        <div className="min-h-[360px] space-y-4 p-5">
          {/* Zero-embeddings notice (#938). Q&A answers via RAG over embedded
              pages; with none embedded, buildRagContext returns "No relevant
              context found", so the LLM answers as if the query matched
              nothing. Surface the real cause here — scoped to ask mode (other
              modes operate on the current page's text, not RAG) and shown in
              both the empty and answered states so it never gets hidden behind
              a misleading answer. */}
          {mode === 'ask' && isZeroEmbeddings(embeddingStatus) && (
            <div
              data-testid="ai-no-embeddings-notice"
              className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
            >
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>
                Pages not embedded yet — configure an embedding provider in
                Settings → LLM and run an embedding pass. Until then, Q&amp;A has
                no knowledge-base context to draw on.
              </span>
            </div>
          )}
          {messages.length === 0 && (
            <div className="flex min-h-[300px] flex-col items-center justify-center text-center">
              {/* Robot wrapped in a honey-tinted aura so the empty state reads
                  as "ready to help", not "page failed to load" (a complaint
                  in the May-2026 audit). 64 px icon + soft glow vs. the prior
                  44 px muted-grey glyph. */}
              <div className="relative mb-5 flex h-20 w-20 items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-primary/10 blur-2xl" aria-hidden />
                <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-primary/12 ring-1 ring-primary/25">
                  <Bot size={32} className="text-primary" />
                </div>
              </div>
              <p className="text-lg font-medium">{getEmptyTitle(mode)}</p>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">{getEmptySubtitle(mode, page)}</p>
              {mode === 'ask' && <AskExamplePrompts />}
            </div>
          )}

          {messages.map((msg, i) => (
            <MessageBubble
              key={msg.id}
              msg={msg}
              index={i}
              isLast={i === messages.length - 1}
              isStreaming={isStreaming}
              isThinking={isThinking}
              thinkingElapsed={thinkingElapsed}
              isLight={isLight}
              shouldReduceMotion={shouldReduceMotion}
              // #747: only the last bubble receives the batched in-flight
              // content; earlier (committed) bubbles keep a stable prop so
              // the memo comparator skips re-rendering them per flush.
              streamingContent={i === messages.length - 1 ? streamingContent : undefined}
            />
          ))}
          <div ref={messagesEndRef} />

          {/* Mode-specific post-message content */}
          {mode === 'improve' && <ImproveDiffView />}
          {mode === 'diagram' && <DiagramPreview />}
        </div>
      </div>

      {/* Mode-specific input bar — sticky at the bottom of the scroll
          container, with a translucent backdrop so chat content scrolls
          legibly behind it. An opaque UNDER-mask (bg-background, z-[-1]) sits
          behind the translucent bar so chat content scrolling down is fully
          occluded below the input field + submit button (#703). The mask
          covers exactly the bar's box (inset-0): the bar pins flush at the
          scrollport bottom, so nothing can show below it, and an absolutely
          positioned mask overflowing the block-end edge grows the scroll
          container's scrollable overflow region — the former -bottom-[100px]
          extension added ~100px of phantom scroll on every mode (#769). */}
      <div className="sticky bottom-0 z-20 isolate -mx-1 bg-background/85 px-1 py-1 backdrop-blur">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[-1] bg-background"
        />
        {mode === 'ask' && <AskModeInput />}
        {mode === 'improve' && <ImproveModeInput />}
        {mode === 'generate' && <GenerateModeInput />}
        {mode === 'summarize' && <SummarizeModeInput />}
        {mode === 'diagram' && <DiagramModeInput />}
        {mode === 'quality' && <QualityModeInput />}
      </div>
    </m.div>
  );
}

// ---------------------------------------------------------------------------
// Public export: wraps inner in AiProvider
// ---------------------------------------------------------------------------

export function AiAssistantPage() {
  return (
    <AiProvider>
      <AiAssistantInner />
    </AiProvider>
  );
}
